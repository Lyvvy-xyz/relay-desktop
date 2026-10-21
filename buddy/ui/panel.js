import { agent, AgentError, forgetConnection } from "./agent.js";
import { renderMarkdown } from "./markdown.js";
import { deriveSession } from "./sessions.js";
import {
  CLAUDE, RELAY, answerClaude, askIn, claudeFolders, forgetRun, listSessions, newClaudeSession,
  readEvents as readSessionEvents, sendToClaude, sessionForRun, setSource, source,
} from "./source.js";

const { invoke } = window.__TAURI__.core;
const { listen, emit, emitTo } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const QUICK_POLL_MILLISECONDS = 1500;
const SLOW_POLL_MILLISECONDS = 6000;
const byId = (id) => document.getElementById(id);
const me = getCurrentWindow();

// ---- Shared bits ---------------------------------------------------------------------------

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showNotice(message) {
  byId("notice").textContent = message;
  byId("notice").hidden = !message;
}

function showAgentProblem(error) {
  if (source() === CLAUDE) {
    showNotice(String(error?.message || error));
  } else if (error instanceof AgentError && error.status === 0) {
    byId("notice").replaceChildren(
      element("h2", "", "Agent not running"),
      element("p", "", "Start the agent to chat and send files."),
      Object.assign(element("button", "primary", "Start agent"), { onclick: repair }),
      Object.assign(element("button", "quiet", "Open setup"), { onclick: () => invoke("open_setup") }),
    );
    byId("notice").hidden = false;
    byId("message").disabled = byId("send-message").disabled = true;
    if (!byId("messages").children.length) byId("messages").append(element("div", "empty-chat", "No active session."));
  } else {
    showNotice(error.message);
  }
}

async function repair() {
  showNotice("Starting the agent…");
  try {
    await invoke("repair_agent");
    forgetConnection();
    await refresh();
  } catch (error) {
    showNotice(`It didn't start: ${error}`);
  }
}

// ---- Tabs ----------------------------------------------------------------------------------

// Sessions are always on the left, so a "sessions" request means the chat beside them.
// Watching Claude, there is no activity or file sending: those are Relay's.
function selectTab(name) {
  if (name === "sessions" || (source() === CLAUDE && name !== "chat")) name = "chat";
  for (const tab of document.querySelectorAll(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== `view-${name}`;
  if (name === "activity") loadActivity();
  if (name === "chat") byId("message").focus();
}
for (const tab of document.querySelectorAll(".tab")) tab.onclick = () => selectTab(tab.dataset.tab);
listen("panel:tab", (event) => selectTab(event.payload));

// ---- Header --------------------------------------------------------------------------------

byId("session-settings").onclick = () => invoke("open_setup");
byId("dock").onclick = () => collapsePanel();

// The panel drops down from the island and folds back up into it.
const PANEL_MOTION_MILLISECONDS = 180;
function collapsePanel() {
  if (document.body.classList.contains("panel-leaving")) return;
  document.body.classList.add("panel-leaving");
  setTimeout(() => {
    document.body.classList.replace("panel-leaving", "panel-gone");
    invoke("collapse_panel");
  }, PANEL_MOTION_MILLISECONDS);
}
listen("panel:shown", () => {
  document.body.classList.remove("panel-gone", "panel-leaving");
  document.body.classList.add("panel-entering");
  setTimeout(() => document.body.classList.remove("panel-entering"), PANEL_MOTION_MILLISECONDS + 40);
});
byId("menu-button").onclick = () => { byId("menu").hidden = !byId("menu").hidden; };
byId("open-setup").onclick = () => { byId("menu").hidden = true; invoke("open_setup"); };
byId("quit").onclick = () => invoke("quit");

// ---- Source: Relay or Claude on this computer, never both -----------------------------------

function composerHint(project) {
  if (source() === CLAUDE) return project ? `Message Claude in ${project}…` : "Pick a session, or start a new one";
  return project ? `Message ${project}…` : "Message the project…";
}

function applySource() {
  const claude = source() === CLAUDE;
  document.body.dataset.source = source();
  byId("switch-source").textContent = claude ? "Use Relay instead" : "Use Claude Code on this computer instead";
  byId("new-session-form").hidden = true;
  byId("message").placeholder = composerHint(chat.project);
  selectTab(document.querySelector('.tab[aria-selected="true"]')?.dataset.tab || "chat");
}
byId("switch-source").onclick = () => {
  byId("menu").hidden = true;
  setSource(source() === CLAUDE ? RELAY : CLAUDE);
  emit("source:changed");
};
// ---- Claude Code on this computer: new sessions and permission asks ------------------------

byId("new-claude-session").onclick = () => {
  const form = byId("new-session-form");
  form.hidden = !form.hidden;
  byId("claude-folders").replaceChildren(...claudeFolders().map((folder) => Object.assign(element("option"), { value: folder })));
  if (!form.hidden) byId("claude-folder").focus();
};
byId("new-session-form").onsubmit = async (event) => {
  event.preventDefault();
  const folder = byId("claude-folder").value.trim();
  if (!folder) return;
  byId("new-session-form").hidden = true;
  byId("claude-folder").value = "";
  const name = newClaudeSession(folder);
  await loadProjects();
  selectTab("chat");
  await switchProject(name);
  byId("message").focus();
};

// Claude Code wants an OK: a card in the chat, and the island asks too (it shows while this
// panel is folded away). Whichever is answered first, the other goes away.
const askCards = new Map();
function showAsk(ask) {
  emitTo("buddy", "buddy:ask", ask);
  if (ask.project !== chat.project) return;
  const card = element("div", "ask");
  const answer = (allow) => answerClaude(ask, allow).catch((error) => showNotice(String(error)));
  card.append(
    element("strong", "", `${ask.tool} needs your OK`),
    element("code", "", ask.summary),
    Object.assign(element("button", "quiet", "Deny"), { type: "button", onclick: () => answer(false) }),
    Object.assign(element("button", "primary", "Allow once"), { type: "button", onclick: () => answer(true) }),
  );
  askCards.set(ask.requestId, card);
  byId("messages").append(card);
  scrollToEnd();
}
listen("claude:answered", ({ payload }) => {
  askCards.get(payload)?.remove();
  askCards.delete(payload);
});
listen("claude:line", async ({ payload }) => {
  const ask = askIn(payload);
  if (ask) {
    showAsk({ ...ask, project: sessionForRun(ask.run) || "Claude" });
    return;
  }
  let record;
  try {
    record = JSON.parse(payload.line);
  } catch {
    return;
  }
  // A new session's transcript exists once Claude Code has started: pick it up.
  if (record.type === "system" && record.subtype === "init") await loadProjects();
  if (record.type === "result" && record.is_error) showNotice(String(record.result || "Claude Code stopped with an error."));
});
listen("claude:exit", ({ payload }) => {
  if (forgetRun(payload) !== chat.project || !chat.awaiting) return;
  chat.awaiting = false;
  byId("typing").hidden = true;
  showNotice("Claude Code stopped. Send another message to start it again.");
});

listen("source:changed", async () => {
  for (const entry of sessions.values()) entry.row?.row.remove();
  sessions.clear();
  islandStatus = "";
  showNotice("");
  byId("notice").hidden = true;
  applySource();
  await refresh();
  await switchProject(byId("chat-project").value || "");
});
window.__TAURI__.app.getVersion().then((version) => { byId("version").textContent = `Version ${version}`; });

// ---- Updates -------------------------------------------------------------------------------

// Its own notice: the project poll clears the shared one every few seconds.
function showUpdate(...content) {
  if (content.length && !content.some(node => node.tagName === "BUTTON" || node.querySelector("button"))) {
    content.push(Object.assign(element("button", "quiet", "Back"), { onclick: () => showUpdate() }));
  }
  byId("update-notice").replaceChildren(...content);
  byId("update-notice").hidden = content.length === 0;
  if (!content.length) selectTab(document.querySelector('.tab[aria-selected="true"]').dataset.tab);
}

function offerUpdate(version) {
  const later = Object.assign(element("button", "button button--quiet", "Later"), { onclick: () => showUpdate() });
  const now = Object.assign(element("button", "button button--primary", "Update now"), {
    onclick: async () => {
      showUpdate(element("span", "", "Downloading the update… Relay restarts by itself when it's done."));
      try {
        await invoke("install_update");
      } catch (error) {
        showUpdate(element("span", "", `The update didn't install: ${error}`));
      }
    },
  });
  const actions = element("div", "row");
  actions.append(now, later);
  showUpdate(element("h2", "", `Version ${version} available`), element("p", "", "Relay will restart after updating."), actions, element("div", "installed tiny muted", `Installed version · ${byId("version").textContent.replace("Version ", "")}`));
}
listen("panel:update", (event) => offerUpdate(event.payload));

byId("check-update").onclick = async () => {
  byId("menu").hidden = true;
  showUpdate(element("span", "", "Checking for updates…"));
  try {
    const version = await invoke("check_update");
    if (version) offerUpdate(version);
    else showUpdate(element("span", "", "You have the latest version."));
  } catch (error) {
    showUpdate(element("span", "", `Couldn't check for updates: ${error}`));
  }
};
byId("show-wrong").onclick = () => invoke("start_snip");
document.addEventListener("keydown", (event) => { if (event.key === "Escape") collapsePanel(); });

async function loadStatus() {
  if (source() === CLAUDE) {
    byId("machine").textContent = "This computer";
    return;
  }
  const status = await agent("/status");
  byId("machine").textContent = status.machine || "";
}

// ---- Projects ------------------------------------------------------------------------------

let projects = [];
async function loadProjects() {
  try {
    projects = await listSessions();
    showNotice("");
    byId("message").disabled = byId("send-message").disabled = false;
  } catch (error) {
    projects = [];
    if (error.status === 403) showNotice(error.message);
    else showAgentProblem(error);
  }
  for (const select of [byId("chat-project"), byId("send-project")]) {
    const chosen = select.value || localStorage.getItem("relay.project") || "";
    select.replaceChildren(...projects.map((project) => {
      const option = element("option", "", project.is_session_live ? project.name : `${project.name} (not running)`);
      option.value = project.name;
      return option;
    }));
    if (projects.some((project) => project.name === chosen)) select.value = chosen;
  }
  renderFileCount();
  renderSessions();
}

// ---- Chat ----------------------------------------------------------------------------------

const chat = { project: "", cursor: "", awaiting: false, steps: new Map(), group: null, pending: null };

function scrollToEnd() {
  const messages = byId("messages");
  messages.scrollTop = messages.scrollHeight;
}

function newStepGroup(parent = byId("turn-ticker")) {
  if (parent.id === "turn-ticker") { parent.replaceChildren(); parent.hidden = false; }
  const details = element("details", "step-ticker");
  const summary = element("summary");
  const list = element("ol", "steps");
  details.append(summary, list);
  parent.append(details);
  return { details, summary, list, steps: [] };
}

function updateStepGroup(group) {
  const running = group.steps.filter((step) => step.state === "running");
  const failed = group.steps.some((step) => step.state === "failed");
  const state = running.length ? "running" : failed ? "failed" : "ok";
  const current = running.at(-1) || group.steps.at(-1);
  group.details.className = `step-ticker step--${state}`;
  group.summary.replaceChildren(
    element("span", "step__state"),
    element("span", "step__text", `${current.tool} · ${current.summary || "Step"}`),
  );
}

function addEvent(event) {
  const messages = byId("messages");
  messages.querySelector(".empty-chat")?.remove();
  if (event.kind === "user" || event.kind === "text") chat.group = null;
  if (event.kind === "user") {
    chat.pending?.remove();
    chat.pending = null;
    messages.append(element("div", "message message--user", event.text));
  } else if (event.kind === "text") {
    const message = element("div", "message message--assistant");
    const meta = element("div", "message-meta");
    const chip = element("span", "chip");
    chip.style.backgroundColor = projectColour(chat.project);
    meta.append(chip, element("strong", "", chat.project));
    message.append(meta, renderMarkdown(event.text));
    messages.append(message);
  } else if (event.kind === "tool_start") {
    const group = chat.group ||= newStepGroup();
    const row = element("li", "step step--running");
    row.append(element("span", "step__state"), element("span", "", `${event.tool} · ${event.summary || "Step"}`));
    const step = { row, group, tool: event.tool, summary: event.summary, state: "running" };
    group.steps.push(step);
    group.list.append(row);
    chat.steps.set(event.id, step);
    updateStepGroup(group);
  } else if (event.kind === "tool_end") {
    const step = chat.steps.get(event.id);
    if (step) {
      step.state = event.ok ? "ok" : "failed";
      step.row.className = `step step--${step.state}`;
      step.row.setAttribute("aria-label", `${step.tool} · ${step.summary || "Step"} · ${event.ok ? "Done" : "Failed"}`);
      updateStepGroup(step.group);
    }
  } else if (event.kind === "done") {
    chat.group = null;
  }
}

async function readEvents() {
  if (!chat.project) return;
  const project = chat.project;
  const page = await readSessionEvents(project, chat.cursor);
  if (project !== chat.project) return; // switched projects while reading
  chat.cursor = page.cursor;
  for (const event of page.events) {
    addEvent(event);
    if (event.kind === "done" && chat.awaiting) finishedTurn();
  }
  if (page.events.length) scrollToEnd();
}

async function finishedTurn() {
  const project = chat.project;
  if (chat.turnNotice) chat.turnNotice.announced = true;
  chat.awaiting = false;
  byId("typing").hidden = true;
  // Closed panel: let the buddy tell you.
  if (!(await me.isVisible())) {
    emitTo("buddy", "buddy:say", { project, state: "done", text: "New reply ready", attention: true });
  }
}

async function switchProject(name) {
  chat.project = name;
  byId("chat-project").value = name;
  byId("chat-chip").style.backgroundColor = projectColour(name);
  byId("message").placeholder = composerHint(name);
  byId("turn-ticker").replaceChildren();
  byId("turn-ticker").hidden = true;
  chat.cursor = "";
  chat.steps.clear();
  chat.group = null;
  chat.pending = null;
  chat.awaiting = false;
  chat.turnNotice = null;
  byId("typing").hidden = true;
  byId("messages").replaceChildren();
  localStorage.setItem("relay.project", name);
  renderSessions();
  if (name) await readEvents().catch(showAgentProblem);
}
listen("panel:project", async ({ payload }) => {
  if (!projects.some((project) => project.name === payload)) await loadProjects();
  selectTab("chat");
  await switchProject(payload);
});
byId("chat-project").onchange = (event) => switchProject(event.target.value);
// Links in replies open in the browser; followed here they would replace the panel.
byId("messages").addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) return;
  event.preventDefault();
  invoke("open_link", { url: link.href }).catch(showNotice);
});

byId("composer").onsubmit = async (event) => {
  event.preventDefault();
  const text = byId("message").value.trim();
  if (!text || !chat.project) return;
  byId("send-message").disabled = true;
  try {
    if (source() === CLAUDE) await sendToClaude(chat.project, text);
    else await agent(`/projects/${chat.project}/messages`, { method: "POST", form: { text } });
    byId("message").value = "";
    chat.group = null;
    chat.pending = element("div", "message message--user message--pending", text);
    byId("messages").append(chat.pending);
    scrollToEnd();
    chat.awaiting = true;
    chat.turnNotice = { announced: false };
    sessionFor(chat.project).chatTurn = chat.turnNotice;
    byId("typing").hidden = false;
  } catch (error) {
    showAgentProblem(error);
  } finally {
    byId("send-message").disabled = false;
  }
};
byId("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    byId("composer").requestSubmit();
  }
});

async function pollChat() {
  try {
    if (chat.awaiting || (await me.isVisible())) await readEvents();
  } catch {
    // The notice already says what is wrong; keep polling.
  }
  setTimeout(pollChat, chat.awaiting ? QUICK_POLL_MILLISECONDS : SLOW_POLL_MILLISECONDS);
}

// ---- Sessions ------------------------------------------------------------------------------

const sessions = new Map();
const PROJECT_COLOURS = ["#c7a9ed", "#dbbf8f", "#a5c6c7", "#c3b8ac"];

function sessionFor(name) {
  if (!sessions.has(name)) sessions.set(name, { cursor: "", state: undefined, row: null });
  return sessions.get(name);
}

function projectColour(name) {
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  return PROJECT_COLOURS[hash % PROJECT_COLOURS.length];
}

function makeSessionRow(name) {
  const row = element("li", "session");
  const title = element("button", "session__title");
  title.type = "button";
  title.setAttribute("aria-label", `Open ${name} in Chat`);
  const chip = element("span", "session__chip");
  chip.style.backgroundColor = projectColour(name);
  chip.setAttribute("aria-hidden", "true");
  const status = element("span", "session__state");
  const elapsed = element("span", "session__elapsed");
  title.append(chip, element("span", "session__name", name), status, elapsed);
  row.append(title);
  const group = newStepGroup(row);
  row.onclick = (event) => {
    if (event.target.closest("details")) return;
    byId("chat-project").value = name;
    selectTab("chat");
    switchProject(name);
  };
  return { row, status, elapsed, group };
}

function formatElapsed(start, end) {
  const seconds = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function renderSessions() {
  const live = projects.filter((project) => project.is_session_live);
  const names = new Set(live.map((project) => project.name));
  for (const [name, entry] of sessions) {
    if (!names.has(name)) {
      entry.row?.row.remove();
      sessions.delete(name);
    }
  }
  for (const { name } of live) {
    const entry = sessionFor(name);
    const state = entry.state || deriveSession(undefined, [], Date.now());
    const view = entry.row ||= makeSessionRow(name);
    if (!view.row.isConnected) byId("sessions").append(view.row);
    view.row.className = `session session--${state.state}${name === chat.project ? " session--selected" : ""}`;
    view.status.textContent = state.state[0].toUpperCase() + state.state.slice(1);
    view.elapsed.textContent = state.startedAt === null ? "" :
      formatElapsed(state.startedAt, state.endedAt);
    const step = state.steps.at(-1);
    const line = step ? `${step.tool} · ${step.summary || "Step"}` : state.text;
    view.group.summary.replaceChildren(element("span", "step__state"), element("span", "step__text", line || view.status.textContent));
    view.group.list.replaceChildren(...state.steps.map((step) => {
      const row = element("li", `step step--${step.state}`);
      row.append(element("span", "", step.tool), element("span", "", step.summary || "Step"));
      row.setAttribute("aria-label", `${step.tool} · ${step.summary} · ${step.state}`);
      return row;
    }));
  }
  const current = sessions.get(chat.project)?.state;
  const summary = byId("turn-ticker").querySelector("summary");
  if (summary && current?.startedAt != null) {
    let time = summary.querySelector("time");
    if (!time) { time = element("time"); summary.append(time); }
    time.textContent = formatElapsed(current.startedAt, current.endedAt);
  }
  byId("sessions-empty").hidden = live.length !== 0;
  byId("session-count").textContent = `${live.length} session${live.length === 1 ? "" : "s"}`;
}

async function readSession(name) {
  const entry = sessionFor(name);
  try {
    const page = await readSessionEvents(name, entry.cursor);
    if (sessions.get(name) !== entry) return;
    const previous = entry.state;
    entry.state = deriveSession(previous, page.events, previous ? Date.now() : null);
    entry.cursor = page.cursor;
    if (entry.state.state === "done" && page.events.some((event) => event.kind === "done")) {
      // The token survives either poll finishing first, and a switch away from Chat.
      const chatTurn = entry.chatTurn;
      entry.chatTurn = null;
      const chatOwnsNotice = chatTurn && (chatTurn.announced || (chat.turnNotice === chatTurn && chat.awaiting));
      if (previous?.state === "working" && entry.state.state === "done" && !chatOwnsNotice && !(await me.isVisible())) {
        await emitTo("buddy", "buddy:say", { project: name, state: "done", text: entry.state.text || "Session finished", attention: true });
      }
    }
  } catch (error) {
    showAgentProblem(error);
  }
}

// The island at the top of the screen shows the one session worth a glance: working, else failed.
let islandStatus = "";
function tellIsland() {
  const live = [...sessions].filter(([, entry]) => entry.state);
  const pick = live.find(([, entry]) => entry.state.state === "working") || live.find(([, entry]) => entry.state.state === "failed");
  const step = pick?.[1].state.steps.at(-1);
  const status = pick
    ? { project: pick[0], state: pick[1].state.state, line: step ? `${step.tool} · ${step.summary || "Step"}` : "Working" }
    : null;
  const key = JSON.stringify(status);
  if (key === islandStatus) return;
  islandStatus = key;
  emitTo("buddy", "buddy:status", status);
}

async function pollSessions() {
  let visible = false;
  try {
    visible = await me.isVisible();
    await Promise.all(projects.filter((project) => project.is_session_live).map(({ name }) => readSession(name)));
    renderSessions();
    tellIsland();
  } catch (error) {
    showAgentProblem(error);
  } finally {
    setTimeout(pollSessions, visible ? 5000 : 10000);
  }
}

// ---- Activity ------------------------------------------------------------------------------

const VERB_ICONS = { screenshot: "shot", list: "icon-folder", read: "read", write: "save" };
let activityJobs = [];
function renderActivity() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const project = byId("activity-project").value;
  const type = byId("activity-type").value;
  const groups = new Map();
  for (const job of [...activityJobs].sort((a, b) => b.created_at - a.created_at)) {
    if (project && job.project !== project) continue;
    if (type === "failed" && job.status !== "failed") continue;
    if (type === "screenshot" && job.verb !== "screenshot") continue;
    if (type === "files" && !["read", "write", "list"].includes(job.verb)) continue;
    const date = new Date(job.created_at * 1000);
    const day = new Date(date); day.setHours(0, 0, 0, 0);
    const label = (day.getTime() === today.getTime() ? "Today, " : day.getTime() === yesterday.getTime() ? "Yesterday, " : "") + date.toLocaleDateString("en-GB", { day: "numeric", month: "long", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
    if (!groups.has(label)) groups.set(label, []);
    const failed = job.status === "failed";
    const row = element("li", failed ? "activity--failed" : "");
    const time = element("time", "", date.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", hour12:false}));
    time.dateTime = date.toISOString();
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#art-${failed ? "close" : VERB_ICONS[job.verb] || "read"}`); icon.append(use);
    const verb = {read:"Read", write:"Saved", list:"Listed", screenshot:"Captured screenshot"}[job.verb] || job.verb;
    const text = failed ? `${job.verb === "write" ? "Write" : job.verb === "screenshot" ? "Screenshot" : verb} refused` : `${verb}${job.argument ? " " + baseName(job.argument) : ""}`;
    const parts = String(job.argument || "").split(/[\\/]/).filter(Boolean); parts.pop();
    const folder = parts.slice(-2).join(" / ");
    const detail = element("div"); detail.append(element("span", "", text), element("small", "", `${job.project}${folder ? " · " + folder : ""}`));
    row.append(time, icon, detail); groups.get(label).push(row);
  }
  byId("activity").replaceChildren(...[...groups].map(([label, rows]) => {
    const group = element("li", "activity__group"); const list = element("ol", "log"); list.append(...rows);
    group.append(element("h2", "", label), list); return group;
  }));
}
async function loadActivity() {
  try {
    ({jobs: activityJobs} = await agent("/activity"));
    const select = byId("activity-project"), chosen = select.value;
    select.replaceChildren(Object.assign(element("option", "", "All projects"), {value:""}), ...[...new Set(activityJobs.map(job => job.project))].map(name => Object.assign(element("option", "", name), {value:name})));
    select.value = chosen; renderActivity();
  } catch (error) { showAgentProblem(error); }
}
byId("activity-project").onchange = renderActivity;
byId("activity-type").onchange = renderActivity;

// ---- Send files ----------------------------------------------------------------------------

// path -> { item, files }: files is null for a file, or every file in a dropped folder.
const dropped = new Map();
let sending = false;
let sentCount = 0;
const deliveries = [];
const knownSizes = new Map();
const baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;

function renderFileCount() {
  byId("file-count").textContent = String(dropped.size);
  byId("file-count").hidden = dropped.size === 0;
  byId("item-count").textContent = `${dropped.size} item${dropped.size === 1 ? "" : "s"}`;
  byId("drop-empty").hidden = dropped.size !== 0;
  byId("send-content").hidden = dropped.size === 0;
  const sizes = [...dropped].flatMap(([path, entry]) => entry.files === null ? [knownSizes.get(path)] : entry.files.map(file => file.size ?? knownSizes.get(file.path)));
  const total = sizes.reduce((sum, size) => sum + (size || 0), 0);
  byId("total-size").textContent = sizes.length && sizes.every(Number.isFinite) ? (total < 1024 ? `${total} B` : total < 1048576 ? `${(total / 1024).toFixed(1)} KB` : `${(total / 1048576).toFixed(1)} MB`) : "";
  const project = byId("send-project").value;
  byId("send-files").textContent = `Send ${dropped.size} item${dropped.size === 1 ? "" : "s"}`;
  byId("send-files").disabled = sending || dropped.size === 0 || !project;
  byId("clear-files").disabled = sending;
  for (const button of byId("files").querySelectorAll("button")) button.disabled = sending;
}

function setResult(entry, className, text) {
  const result = entry.item.querySelector(".result");
  result.className = `result ${className}`;
  result.textContent = text;
}

async function addDropped(path, isFolder) {
  knownSizes.delete(path);
  const item = element("li", "file-chip");
  item.append(element("span", "files__icon", isFolder ? "▱" : "▤"), element("span", "filename", baseName(path)), element("span", "result muted tiny", ""));
  item.title = path;
  const remove = element("button", "button button--quiet button--icon", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${baseName(path)}`);
  remove.disabled = sending;
  remove.onclick = () => { dropped.delete(path); item.remove(); renderFileCount(); };
  item.append(remove);
  const entry = { item, files: null };
  dropped.set(path, entry);
  byId("files").append(item);
  if (!isFolder) return;
  setResult(entry, "muted", "reading…");
  try {
    entry.files = await invoke("dropped_folder_files", { path });
    for (const file of entry.files) knownSizes.delete(file.path);
    setResult(entry, "muted", `${entry.files.length} file${entry.files.length === 1 ? "" : "s"}`);
  } catch (error) {
    entry.files = [];
    setResult(entry, "result--failed", String(error));
  }
}

listen("panel:files", async (event) => {
  if (source() === CLAUDE) {
    showNotice("Sending files needs Relay. Switch to Relay in the menu under the computer's name.");
    return;
  }
  const paths = event.payload.filter((path) => !dropped.has(path));
  const folders = await invoke("folder_flags", { paths });
  selectTab("send");
  await Promise.all(paths.map((path, index) => addDropped(path, folders[index])));
  renderFileCount();
});

byId("send-project").onchange = renderFileCount;

byId("clear-files").onclick = () => {
  dropped.clear();
  byId("files").replaceChildren();
  renderFileCount();
};

// One upload per file; a folder's files share a batch so they land together, in their folders.
function uploadsFor(path, entry) {
  if (entry.files === null) return [{ path, name: baseName(path) }];
  const batch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return entry.files.map((file) => ({ path: file.path, name: baseName(file.relative), relative: file.relative, batch }));
}

async function upload(project, original, file, note) {
  const bytes = await invoke("read_dropped_file", { path: file.path });
  knownSizes.set(file.path, bytes.byteLength ?? bytes.length);
  renderFileCount();
  const form = new FormData();
  form.append("file", new Blob([bytes]), file.name);
  form.append("original", original);
  if (file.relative) {
    form.append("relative", file.relative);
    form.append("batch", file.batch);
  }
  if (note) form.append("note", note);
  await agent(`/projects/${project}/inbox`, { method: "POST", body: form });
}

// Sends one dropped file or folder. The note goes with the very last upload of the whole send,
// so the session is told once, after everything has arrived.
async function sendEntry(project, path, entry, note) {
  const files = uploadsFor(path, entry);
  if (files.length === 0) return false;
  try {
    // Before the files go, so a project told about them can already save its changes back.
    await agent("/dropped", { method: "POST", body: JSON.stringify({ paths: [path] }) });
    for (const [index, file] of files.entries()) {
      setResult(entry, "muted", files.length === 1 ? "sending…" : `sending ${index + 1} of ${files.length}…`);
      await upload(project, path, file, index === files.length - 1 ? note : "");
    }
    setResult(entry, "result--ok", "sent");
    return true;
  } catch (error) {
    setResult(entry, "result--failed", String(error.message || error));
    return false;
  }
}

byId("send-files").onclick = async () => {
  const project = byId("send-project").value;
  const note = byId("send-note").value.trim();
  if (!project || sending) return;
  sending = true;
  renderFileCount();
  const entries = [...dropped];
  let sent = 0;
  for (const [index, [path, entry]] of entries.entries()) {
    if (await sendEntry(project, path, entry, index === entries.length - 1 ? note : "")) {
      sent += 1;
      dropped.delete(path);
      entry.item.remove();
    }
  }
  sending = false;
  renderFileCount();
  if (sent) {
    sentCount += 1;
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    byId("sent-history").hidden = false;
    byId("sent-summary").textContent = `Sent history · ${sentCount} ${sentCount === 1 ? "delivery" : "deliveries"} · Last sent ${time}`;
    deliveries.unshift(`${time} · ${sent} item${sent === 1 ? "" : "s"} to ${project}`);
    deliveries.splice(5);
    byId("sent-detail").replaceChildren(...deliveries.map(text => element("p", "", text)));
    byId("send-note").value = "";
    emitTo("buddy", "buddy:say", { text: `Sent ${sent} thing${sent === 1 ? "" : "s"} to ${project}. It can save changes straight back.` });
  }
};

// ---- Start ---------------------------------------------------------------------------------

async function refresh() {
  try {
    await loadStatus();
  } catch (error) {
    showAgentProblem(error);
    return;
  }
  await loadProjects();
  if (!chat.project && byId("chat-project").value) await switchProject(byId("chat-project").value);
}

listen("agent:changed", () => { forgetConnection(); refresh(); });
me.onFocusChanged(({ payload: focused }) => {
  if (!focused) return;
  // In case the window was shown before this page could hear about it.
  if (!document.body.classList.contains("panel-leaving")) document.body.classList.remove("panel-gone");
  refresh();
});
applySource();
refresh().then(pollSessions);
pollChat();
