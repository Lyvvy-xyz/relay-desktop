// The Relay desktop buddy: a small animated character that sits on the desktop and is the face of
// the Relay agent on this machine. All talking to the Relay server goes through the agent's local API
// (from the pages, with its secret); this Rust side only manages windows, runs the bundled agent
// for setup, and reads files that were dropped on the buddy.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::Response, AppHandle, DragDropEvent, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize,
    WebviewEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_updater::{Update, UpdaterExt};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
// A dropped folder is sent file by file; these keep one drop from being a whole disk.
const MAX_FOLDER_FILES: usize = 2000;
const MAX_FOLDER_BYTES: u64 = 100 * 1024 * 1024;
const AGENT: &str = "homelab-agent";
// The island's size before its page has measured itself: the idle handle.
const IDLE_ISLAND: (f64, f64) = (360.0, 6.0);
const FIRST_RUN_MARKER: &str = "first-run-done";
const AGENT_VERSION_MARKER: &str = "agent-version";
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
// Watching Claude on this computer: transcripts touched this recently count as sessions, and a
// session's first read takes this much of the end of its transcript as history.
const CLAUDE_SESSION_AGE: Duration = Duration::from_secs(6 * 60 * 60);
const CLAUDE_HISTORY_BYTES: u64 = 256 * 1024;
const CLAUDE_CWD_SCAN_BYTES: u64 = 64 * 1024;

#[derive(Default)]
struct BuddyState {
    // Only files dropped on the buddy may be read: the pages cannot name any other path.
    dropped: Mutex<HashSet<PathBuf>>,
    setup: Mutex<Option<CommandChild>>,
    // The newer version found by the last check, held until the person says to install it.
    update: Mutex<Option<Update>>,
    // Claude Code processes the buddy is talking to, by run id.
    claude: Mutex<HashMap<String, ClaudeRun>>,
}

struct ClaudeRun {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Serialize, Deserialize)]
struct LocalApi {
    port: u16,
    token: String,
}

fn agent_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|dir| dir.join(AGENT))
        .ok_or_else(|| "This computer has no settings folder.".to_string())
}

const AGENT_DOWN: &str = "The agent is not running yet.";

/// Where the running agent's local API listens, and its secret.
#[tauri::command]
fn local_api() -> Result<LocalApi, String> {
    let raw = fs::read_to_string(agent_dir()?.join("local-api.json"))
        .map_err(|_| AGENT_DOWN.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn is_paired() -> bool {
    agent_dir()
        .and_then(|dir| fs::read_to_string(dir.join("config.json")).map_err(|e| e.to_string()))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|config| config.get("token").and_then(|t| t.as_str()).map(|t| !t.is_empty()))
        .unwrap_or(false)
}

/// True when path is a dropped file, or a file inside a dropped folder once links are followed,
/// so a link inside a dropped folder cannot reach anywhere else.
fn was_dropped(path: &Path, state: &BuddyState) -> bool {
    let dropped = state.dropped.lock().unwrap();
    if dropped.contains(path) {
        return true;
    }
    let Ok(real) = fs::canonicalize(path) else {
        return false;
    };
    dropped
        .iter()
        .filter(|item| item.is_dir())
        .filter_map(|item| fs::canonicalize(item).ok())
        .any(|folder| real.starts_with(folder))
}

#[tauri::command]
fn read_dropped_file(path: String, state: tauri::State<BuddyState>) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !was_dropped(&path, &state) {
        return Err("Only files dropped on the buddy can be sent.".into());
    }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("That is a folder, not a file.".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("Files over 100 MB can't be sent.".into());
    }
    fs::read(&path).map(Response::new).map_err(|error| error.to_string())
}

/// Which of these paths are folders, for the frog to draw what is being dragged over him.
#[tauri::command]
fn folder_flags(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|path| Path::new(path).is_dir()).collect()
}

#[derive(Serialize)]
struct FolderFile {
    path: PathBuf,
    // Inside the folder, starting with the folder's own name, always with forward slashes.
    relative: String,
}

/// Every file in a dropped folder, sub-folders included. Links are skipped, not followed.
#[tauri::command]
fn dropped_folder_files(
    path: String,
    state: tauri::State<BuddyState>,
) -> Result<Vec<FolderFile>, String> {
    let root = PathBuf::from(path);
    if !state.dropped.lock().unwrap().contains(&root) || !root.is_dir() {
        return Err("Only folders dropped on the buddy can be sent.".into());
    }
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (mut files, mut total, mut pending) = (Vec::new(), 0u64, vec![(root, name)]);
    while let Some((folder, relative)) = pending.pop() {
        for entry in fs::read_dir(&folder).map_err(|e| e.to_string())?.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let inner = format!("{relative}/{}", entry.file_name().to_string_lossy());
            if kind.is_dir() {
                pending.push((entry.path(), inner));
            } else if kind.is_file() {
                total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                files.push(FolderFile {
                    path: entry.path(),
                    relative: inner,
                });
                if files.len() > MAX_FOLDER_FILES || total > MAX_FOLDER_BYTES {
                    return Err(
                        "That folder is too big to send: the most is 2,000 files and 100 MB."
                            .into(),
                    );
                }
            }
        }
    }
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(files)
}

fn window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("The {label} window is missing."))
}

fn main_screen(app: &AppHandle) -> Result<Monitor, String> {
    app.primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No screen found.".to_string())
}

/// Puts a window at the top centre of the main screen, below a menu bar if there is one: the buddy
/// lives there as an island, and the panel drops down from the same spot.
fn place_top_centre(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let screen = main_screen(app)?;
    let area = screen.work_area();
    let width = window.outer_size().map_err(|e| e.to_string())?.width as i32;
    let x = area.position.x + (area.size.width as i32 - width) / 2;
    window
        .set_position(PhysicalPosition::new(x, area.position.y))
        .map_err(|e| e.to_string())
}

/// Sizes the buddy's island (logical pixels, as its page measures them) and docks it again.
fn dock(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
    let buddy = window(app, "buddy")?;
    let scale = main_screen(app)?.scale_factor();
    buddy
        .set_size(PhysicalSize::new((width * scale).ceil() as u32, (height * scale).ceil() as u32))
        .map_err(|e| e.to_string())?;
    place_top_centre(app, &buddy)
}

#[tauri::command]
fn dock_island(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    dock(&app, width.clamp(40.0, 600.0), height.clamp(4.0, 400.0))
}

/// The panel folds back up into the island.
fn collapse(app: &AppHandle) -> Result<(), String> {
    window(app, "panel")?.hide().map_err(|e| e.to_string())?;
    window(app, "buddy")?.show().map_err(|e| e.to_string())?;
    let _ = app.emit_to("buddy", "buddy:shown", ());
    Ok(())
}

/// The island's window is wider than the island; outside it, clicks go through to what's beneath.
#[tauri::command]
fn island_click_through(app: AppHandle, through: bool) -> Result<(), String> {
    window(&app, "buddy")?
        .set_ignore_cursor_events(through)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn collapse_panel(app: AppHandle) -> Result<(), String> {
    collapse(&app)
}

fn show_panel_window(app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
    let panel = window(app, "panel")?;
    place_top_centre(app, &panel)?;
    panel.show().map_err(|e| e.to_string())?;
    panel.set_focus().map_err(|e| e.to_string())?;
    // While it is open, the panel's own tab is the island.
    window(app, "buddy")?.hide().map_err(|e| e.to_string())?;
    app.emit_to("panel", "panel:shown", ()).map_err(|e| e.to_string())?;
    if let Some(tab) = tab {
        app.emit_to("panel", "panel:tab", tab).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn toggle_panel(app: AppHandle) -> Result<(), String> {
    let panel = window(&app, "panel")?;
    if panel.is_visible().unwrap_or(false) {
        collapse(&app)
    } else {
        show_panel_window(&app, None)
    }
}

#[tauri::command]
fn show_panel(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    show_panel_window(&app, tab.as_deref())
}

/// Where the mouse is relative to the island's top-left corner (physical pixels); the page knows
/// where the face is inside it, so its eyes can follow the mouse anywhere on screen.
#[tauri::command]
fn cursor_from_buddy(app: AppHandle) -> Result<(f64, f64), String> {
    let buddy = window(&app, "buddy")?;
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let at = buddy.inner_position().map_err(|e| e.to_string())?;
    Ok((cursor.x - at.x as f64, cursor.y - at.y as f64))
}

/// "Show me what's wrong": hide the buddy and panel, then open a hidden full-screen window on the
/// buddy's screen. That page captures the screen first and only then shows itself, so neither
/// the buddy nor the overlay ends up in the picture.
#[tauri::command]
fn start_snip(app: AppHandle) -> Result<(), String> {
    let buddy = window(&app, "buddy")?;
    let monitor = buddy
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No screen found.")?;
    buddy.hide().map_err(|e| e.to_string())?;
    window(&app, "panel")?.hide().map_err(|e| e.to_string())?;
    if let Some(old) = app.get_webview_window("snip") {
        let _ = old.close();
    }
    let scale = monitor.scale_factor();
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    WebviewWindowBuilder::new(&app, "snip", WebviewUrl::App("snip.html".into()))
        .title("Show me what's wrong")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .position(position.x, position.y)
        .inner_size(size.width, size.height)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn end_snip(app: AppHandle, reopen_panel: bool) -> Result<(), String> {
    if let Some(snip) = app.get_webview_window("snip") {
        let _ = snip.close();
    }
    window(&app, "buddy")?.show().map_err(|e| e.to_string())?;
    if reopen_panel {
        show_panel_window(&app, None)?;
    }
    Ok(())
}

/// Opens the agent's own setup page in an app window. The bundled agent serves it and prints its
/// address; when setup finishes the agent exits, the window closes, and every page is told.
#[tauri::command]
fn open_setup(app: AppHandle, state: tauri::State<BuddyState>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("setup") {
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let (mut events, child) = app
        .shell()
        .sidecar(AGENT)
        .map_err(|e| e.to_string())?
        .args(["setup-serve"])
        .spawn()
        .map_err(|e| e.to_string())?;
    *state.setup.lock().unwrap() = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if let Some(address) = line.trim().strip_prefix("SETUP_URL ") {
                        if let Ok(url) = address.parse() {
                            let _ = WebviewWindowBuilder::new(&handle, "setup", WebviewUrl::External(url))
                                .title("Relay setup")
                                .inner_size(640.0, 780.0)
                                .center()
                                .build();
                        }
                    }
                }
                CommandEvent::Terminated(_) => {
                    if let Some(setup) = handle.get_webview_window("setup") {
                        let _ = setup.close();
                    }
                    handle.state::<BuddyState>().setup.lock().unwrap().take();
                    let _ = handle.emit("agent:changed", ());
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Opens a link from a chat reply in the default browser; a plain link would navigate the panel
/// itself away. Only web links: the text came from a project, so nothing that runs a program.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened.".into());
    }
    #[allow(deprecated)] // the opener plugin replaces this; shell is already a dependency
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// Starts the installed agent again (it copies itself, registers to start at login, and runs).
fn claude_projects_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or("No home folder found.")?.join(".claude").join("projects"))
}

#[derive(Serialize)]
struct ClaudeSession {
    name: String,
    id: String,
    cwd: String,
    transcript: String,
    modified: u64,
}

/// The folder a Claude session runs in, from the "cwd" its transcript records.
fn claude_session_cwd(transcript: &Path) -> Option<String> {
    let mut head = Vec::new();
    fs::File::open(transcript).ok()?.take(CLAUDE_CWD_SCAN_BYTES).read_to_end(&mut head).ok()?;
    String::from_utf8_lossy(&head).lines().find_map(|line| {
        let record: serde_json::Value = serde_json::from_str(line).ok()?;
        record.get("cwd")?.as_str().map(str::to_string)
    })
}

/// For watching Claude on this computer instead of Relay: the newest transcript in each of
/// Claude Code's project folders, if it was touched recently.
#[tauri::command]
fn claude_sessions() -> Result<Vec<ClaudeSession>, String> {
    let Ok(folders) = fs::read_dir(claude_projects_dir()?) else {
        return Ok(Vec::new());
    };
    let now = SystemTime::now();
    let mut sessions = Vec::new();
    for folder in folders.flatten() {
        let Ok(files) = fs::read_dir(folder.path()) else { continue };
        let newest = files
            .flatten()
            .filter(|file| file.path().extension().is_some_and(|extension| extension == "jsonl"))
            .filter_map(|file| Some((file.metadata().ok()?.modified().ok()?, file.path())))
            .max_by_key(|(modified, _)| *modified);
        let Some((modified, path)) = newest else { continue };
        if now.duration_since(modified).unwrap_or_default() > CLAUDE_SESSION_AGE {
            continue;
        }
        // Without a folder there is nowhere to continue the session from.
        let Some(cwd) = claude_session_cwd(&path) else { continue };
        let name = cwd.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or(cwd.as_str()).to_string();
        let id = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        sessions.push(ClaudeSession {
            name,
            id,
            cwd,
            transcript: path.to_string_lossy().into_owned(),
            modified: modified.duration_since(UNIX_EPOCH).map(|age| age.as_secs()).unwrap_or(0),
        });
    }
    Ok(sessions)
}

#[derive(Serialize)]
struct TranscriptLines {
    lines: Vec<String>,
    next: u64,
}

/// Whole lines of a Claude transcript from byte `from` on; without `from`, or when the file
/// has shrunk since, the last stretch of it as history. Only files under Claude's own projects
/// folder can be read.
#[tauri::command]
fn claude_lines(transcript: String, from: Option<u64>) -> Result<TranscriptLines, String> {
    let root = claude_projects_dir()?.canonicalize().map_err(|e| e.to_string())?;
    let path = Path::new(&transcript).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err("That is not a Claude transcript.".into());
    }
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let start = match from {
        Some(at) if at <= size => at,
        _ => size.saturating_sub(CLAUDE_HISTORY_BYTES),
    };
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Only whole lines: one Claude is still writing is left for the next read.
    let end = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
    let mut lines: Vec<String> = String::from_utf8_lossy(&bytes[..end]).lines().map(str::to_string).collect();
    // History that starts mid-file starts mid-line.
    if start > 0 && from != Some(start) && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(TranscriptLines { lines, next: start + end as u64 })
}

// Where Claude Code may be: on the PATH (as claude.cmd too, for an npm install on Windows), or
// where its installers put it, since apps started from a macOS Dock don't see a shell's PATH.
fn claude_programs() -> Vec<PathBuf> {
    let mut programs = vec![PathBuf::from("claude")];
    if cfg!(windows) {
        programs.push(PathBuf::from("claude.cmd"));
    }
    if let Some(home) = dirs::home_dir() {
        programs.push(home.join(".local").join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" }));
    }
    programs.extend(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
    programs
}

fn spawn_claude(cwd: &Path, resume: Option<&str>) -> Result<Child, String> {
    for program in claude_programs() {
        let mut command = Command::new(&program);
        command
            .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
            // Edits inside the folder go ahead; anything else that needs an OK is asked over
            // the stream, and the island shows Allow once / Deny.
            .args(["--permission-mode", "acceptEdits", "--permission-prompt-tool", "stdio"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(id) = resume {
            command.args(["--resume", id]);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
        }
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Couldn't start Claude Code: {error}")),
        }
    }
    Err("Claude Code isn't installed on this computer, or isn't on the PATH.".into())
}

#[derive(Clone, Serialize)]
struct ClaudeLine {
    run: String,
    line: String,
}

/// Starts Claude Code in `cwd` for the buddy to talk to, continuing session `resume` if given.
/// Every line it prints goes to the pages as a "claude:line" event; "claude:exit" when it ends.
#[tauri::command]
fn claude_start(
    app: AppHandle,
    state: tauri::State<BuddyState>,
    cwd: String,
    resume: Option<String>,
) -> Result<String, String> {
    let folder = Path::new(&cwd);
    if !folder.is_dir() {
        return Err(format!("{cwd} is not a folder on this computer."));
    }
    if let Some(id) = &resume {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err("That is not a Claude session.".into());
        }
    }
    let mut child = spawn_claude(folder, resume.as_deref())?;
    let stdin = child.stdin.take().ok_or("Claude Code has no input.")?;
    let stdout = child.stdout.take().ok_or("Claude Code has no output.")?;
    let run = child.id().to_string();
    state.claude.lock().unwrap().insert(run.clone(), ClaudeRun { child, stdin });
    let handle = app.clone();
    let id = run.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = handle.emit("claude:line", ClaudeLine { run: id.clone(), line });
        }
        if let Some(mut ended) = handle.state::<BuddyState>().claude.lock().unwrap().remove(&id) {
            let _ = ended.child.wait();
        }
        let _ = handle.emit("claude:exit", id);
    });
    Ok(run)
}

/// Sends Claude Code one line: a message from the person, or their answer to a permission ask.
#[tauri::command]
fn claude_send(state: tauri::State<BuddyState>, run: String, message: serde_json::Value) -> Result<(), String> {
    let kind = message.get("type").and_then(|kind| kind.as_str()).unwrap_or("");
    if !matches!(kind, "user" | "control_response") {
        return Err("Only messages and answers go to Claude Code.".into());
    }
    let mut runs = state.claude.lock().unwrap();
    let target = runs.get_mut(&run).ok_or("That Claude Code session has ended.")?;
    writeln!(target.stdin, "{message}")
        .and_then(|_| target.stdin.flush())
        .map_err(|e| e.to_string())
}

fn stop_claude(app: &AppHandle, run: Option<&str>) {
    let state = app.state::<BuddyState>();
    let mut runs = state.claude.lock().unwrap();
    let ids: Vec<String> = runs.keys().filter(|id| run.map_or(true, |one| one == id.as_str())).cloned().collect();
    for id in ids {
        if let Some(mut ended) = runs.remove(&id) {
            let _ = ended.child.kill();
            let _ = ended.child.wait();
        }
    }
}

#[tauri::command]
fn claude_stop(app: AppHandle, run: String) {
    stop_claude(&app, Some(&run));
}

#[tauri::command]
async fn repair_agent(app: AppHandle) -> Result<(), String> {
    let output = app
        .shell()
        .sidecar(AGENT)
        .map_err(|e| e.to_string())?
        .args(["install"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        let _ = app.emit("agent:changed", ());
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    // Claude Code started from the buddy would otherwise outlive it.
    stop_claude(&app, None);
    app.exit(0);
}

/// Asks this repository's buddy-latest GitHub release (the endpoint in tauri.conf.json) whether a
/// newer buddy is out. Every installer it offers must carry this build's signing key, or the
/// updater refuses it.
async fn find_update(app: &AppHandle) -> Result<Option<String>, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| {
            let text = e.to_string();
            if text.contains("error sending request") {
                "Couldn't reach GitHub to check for updates.".to_string()
            } else {
                text
            }
        })?;
    let version = update.as_ref().map(|update| update.version.clone());
    *app.state::<BuddyState>().update.lock().unwrap() = update;
    Ok(version)
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    find_update(&app).await
}

/// Installs the update the last check found; on Windows the installer closes the app itself.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app.state::<BuddyState>().update.lock().unwrap().take();
    let update = update.ok_or("There is no update waiting. Check again.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// Checks for a newer buddy soon after start and then every few hours, and asks the person.
fn watch_for_updates(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(30));
        if let Ok(Some(version)) = tauri::async_runtime::block_on(find_update(&app)) {
            let _ = app.emit_to("panel", "panel:update", &version);
            let text = format!("Version {version} is out. Click me to update.");
            let _ = app.emit_to("buddy", "buddy:say", serde_json::json!({ "text": text, "attention": true }));
        }
        thread::sleep(UPDATE_CHECK_EVERY);
    });
}

/// True the first time this install of the buddy runs, even if an older agent left settings
/// behind: those settings may be stale, so setup is offered once regardless.
fn first_run(app: &AppHandle) -> bool {
    let Ok(directory) = app.path().app_data_dir() else {
        return false;
    };
    let marker = directory.join(FIRST_RUN_MARKER);
    if marker.exists() {
        return false;
    }
    let _ = fs::create_dir_all(&directory).and_then(|_| fs::write(&marker, b""));
    true
}

/// The agent runs from its own copy, which only setup refreshes; after the buddy updates itself,
/// put the agent bundled with this version in its place once, so agent fixes arrive too.
fn refresh_agent_after_update(app: &AppHandle) {
    let Ok(directory) = app.path().app_data_dir() else {
        return;
    };
    let marker = directory.join(AGENT_VERSION_MARKER);
    let version = app.package_info().version.to_string();
    if fs::read_to_string(&marker).ok().as_deref() == Some(version.as_str()) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if repair_agent(handle).await.is_ok() {
            let _ = fs::create_dir_all(&directory).and_then(|_| fs::write(&marker, version));
        }
    });
}

// How long the frog's eating animation runs (MEAL_SECONDS in buddy.js).
const MEAL: Duration = Duration::from_millis(1900);

// A drop on the island opens the panel once the frog has eaten; a drop on the open panel goes
// straight in.
fn files_dropped(app: &AppHandle, label: &str, paths: &[PathBuf]) {
    app.state::<BuddyState>()
        .dropped
        .lock()
        .unwrap()
        .extend(paths.iter().cloned());
    let (app, paths) = (app.clone(), paths.to_vec());
    let wait = if label == "buddy" { MEAL } else { Duration::ZERO };
    thread::spawn(move || {
        thread::sleep(wait);
        let _ = show_panel_window(&app, Some("send"));
        let _ = app.emit_to("panel", "panel:files", paths);
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["buddy", "panel", "snip", "setup"])
                .build(),
        )
        .manage(BuddyState::default())
        // Which of the two a drop arrives as depends on the Tauri version and platform, so both are
        // taken; a repeat is harmless because the dropped set and the panel's list ignore duplicates.
        .on_webview_event(|webview, event| {
            if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                if matches!(webview.label(), "buddy" | "panel") {
                    files_dropped(webview.app_handle(), webview.label(), paths);
                }
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                if matches!(window.label(), "buddy" | "panel") {
                    files_dropped(window.app_handle(), window.label(), paths);
                }
            }
            // A closed setup window means setup was abandoned: stop the agent serving it.
            if window.label() == "setup" && matches!(event, WindowEvent::Destroyed) {
                if let Some(child) = window.state::<BuddyState>().setup.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // The island's page shows its window once it has drawn itself, so it never flashes.
            dock(&handle, IDLE_ISLAND.0, IDLE_ISLAND.1)?;
            watch_for_updates(handle.clone());
            if first_run(&handle) || !is_paired() {
                open_setup(handle.clone(), handle.state::<BuddyState>())?;
            } else {
                refresh_agent_after_update(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_api,
            open_link,
            read_dropped_file,
            folder_flags,
            dropped_folder_files,
            toggle_panel,
            dock_island,
            island_click_through,
            claude_sessions,
            claude_lines,
            claude_start,
            claude_send,
            claude_stop,
            collapse_panel,
            show_panel,
            cursor_from_buddy,
            start_snip,
            end_snip,
            open_setup,
            repair_agent,
            check_update,
            install_update,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("the buddy could not start");
}
