// Relay desktop buddy. The pages talk to the Relay server through the agent's local API; this side
// manages windows, runs the bundled agent for setup and reads dropped files.
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
// Limits for a dropped folder, which is sent file by file.
const MAX_FOLDER_FILES: usize = 2000;
const MAX_FOLDER_BYTES: u64 = 100 * 1024 * 1024;
const AGENT: &str = "homelab-agent";
// Island size before the page has measured itself (the idle handle).
const IDLE_ISLAND: (f64, f64) = (360.0, 6.0);
const FIRST_RUN_MARKER: &str = "first-run-done";
const AGENT_VERSION_MARKER: &str = "agent-version";
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
// Claude transcripts modified this recently count as live sessions. A session's first read loads
// this much of the end as history.
const CLAUDE_SESSION_AGE: Duration = Duration::from_secs(6 * 60 * 60);
const CLAUDE_HISTORY_BYTES: u64 = 256 * 1024;
const CLAUDE_CWD_SCAN_BYTES: u64 = 64 * 1024;

#[derive(Default)]
struct BuddyState {
    // Pages can only read files that were dropped on the buddy.
    dropped: Mutex<HashSet<PathBuf>>,
    setup: Mutex<Option<CommandChild>>,
    // Update found by the last check, kept until the user installs it.
    update: Mutex<Option<Update>>,
    // Running Claude Code processes, by run id.
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

/// Port and secret of the running agent's local API.
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

/// True if path was dropped, or is inside a dropped folder after resolving links, so a link can't
/// escape the folder.
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

/// Which paths are folders, so the frog can draw them.
#[tauri::command]
fn folder_flags(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|path| Path::new(path).is_dir()).collect()
}

#[derive(Serialize)]
struct FolderFile {
    path: PathBuf,
    // Path inside the folder, starting with the folder's name, with forward slashes.
    relative: String,
}

/// Every file in a dropped folder, recursively. Links are skipped.
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

/// Puts a window at the top centre of the main screen, below the menu bar if there is one.
fn place_top_centre(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let screen = main_screen(app)?;
    let area = screen.work_area();
    let width = window.outer_size().map_err(|e| e.to_string())?.width as i32;
    let x = area.position.x + (area.size.width as i32 - width) / 2;
    window
        .set_position(PhysicalPosition::new(x, area.position.y))
        .map_err(|e| e.to_string())
}

/// Resizes the island (logical pixels) and re-centres it.
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

/// Hides the panel and shows the island again.
fn collapse(app: &AppHandle) -> Result<(), String> {
    window(app, "panel")?.hide().map_err(|e| e.to_string())?;
    window(app, "buddy")?.show().map_err(|e| e.to_string())?;
    let _ = app.emit_to("buddy", "buddy:shown", ());
    Ok(())
}

/// Lets clicks outside the island pass through its window.
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
    // The island is hidden while the panel is open.
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

/// Mouse position relative to the island window's top-left corner, in physical pixels. The page
/// uses it for the frog's eyes.
#[tauri::command]
fn cursor_from_buddy(app: AppHandle) -> Result<(f64, f64), String> {
    let buddy = window(&app, "buddy")?;
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let at = buddy.inner_position().map_err(|e| e.to_string())?;
    Ok((cursor.x - at.x as f64, cursor.y - at.y as f64))
}

/// Show me what's wrong: hides the buddy and panel and opens a hidden full-screen window. The page
/// takes the screenshot before showing itself, so neither ends up in it.
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

/// Opens the agent's setup page in a window. The bundled agent serves it and prints the address;
/// when the agent exits the window closes and every page is told.
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

/// Opens a link from a chat reply in the browser. Only http(s), since the text comes from a
/// project.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened.".into());
    }
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

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

/// Working folder of a Claude session, from the cwd in its transcript.
fn claude_session_cwd(transcript: &Path) -> Option<String> {
    let mut head = Vec::new();
    fs::File::open(transcript).ok()?.take(CLAUDE_CWD_SCAN_BYTES).read_to_end(&mut head).ok()?;
    String::from_utf8_lossy(&head).lines().find_map(|line| {
        let record: serde_json::Value = serde_json::from_str(line).ok()?;
        record.get("cwd")?.as_str().map(str::to_string)
    })
}

/// The newest transcript in each Claude Code project folder, if it was modified recently.
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
        // Can't resume a session without its folder.
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

/// Complete lines of a Claude transcript from byte `from`. Without `from`, or if the file shrank,
/// the tail as history. Only reads under Claude's projects folder.
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
    // Leave a partly written last line for the next read.
    let end = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
    let mut lines: Vec<String> = String::from_utf8_lossy(&bytes[..end]).lines().map(str::to_string).collect();
    // Drop the partial first line when starting mid-file.
    if start > 0 && from != Some(start) && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(TranscriptLines { lines, next: start + end as u64 })
}

// Places Claude Code may be installed. Apps launched from the macOS Dock don't get the shell PATH,
// so the usual install locations are checked too.
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
            // Edits inside the folder are allowed; other permission requests come over the stream
            // and show in the island.
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
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
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

/// Starts Claude Code in `cwd`, resuming `resume` if given. Each output line is emitted as
/// claude:line, then claude:exit when it ends.
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

/// Writes one message or permission answer to Claude Code.
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

/// Reinstalls and restarts the agent (it copies itself, registers for login and runs).
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
    // Otherwise Claude Code would outlive the app.
    stop_claude(&app, None);
    app.exit(0);
}

/// Checks the buddy-latest GitHub release for a newer version. The updater rejects anything not
/// signed with this build's key.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
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

/// Installs the update found by the last check. On Windows the installer closes the app.
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

/// Checks for updates 30 seconds after start, then every few hours.
fn watch_for_updates(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(30));
        if let Ok(Some(version)) = tauri::async_runtime::block_on(check_update(app.clone())) {
            let _ = app.emit_to("panel", "panel:update", &version);
            let text = format!("Version {version} is out. Click me to update.");
            let _ = app.emit_to("buddy", "buddy:say", serde_json::json!({ "text": text, "attention": true }));
        }
        thread::sleep(UPDATE_CHECK_EVERY);
    });
}

/// True on the first run of this install. Settings left by an older agent may be stale, so setup is
/// offered once anyway.
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

/// The agent runs from its own copy, which only setup replaces. After the buddy updates, reinstall
/// the bundled agent once so it's updated too.
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

// Length of the frog's eating animation (MEAL_SECONDS in buddy.js).
const MEAL: Duration = Duration::from_millis(1900);

// Drops on the island wait for the frog to finish eating before the panel opens. Drops on the panel
// go straight in.
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
        // Depending on the platform a drop arrives as a webview or a window event, so both are
        // handled. Duplicates are ignored later on.
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
            // Setup window closed early: stop the agent serving it.
            if window.label() == "setup" && matches!(event, WindowEvent::Destroyed) {
                if let Some(child) = window.state::<BuddyState>().setup.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // The page shows the window after its first draw, so it doesn't flash.
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
