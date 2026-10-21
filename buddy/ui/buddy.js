import { agent, describeJob, forgetConnection } from "./agent.js";
import { startFrog } from "./frog.js";
import { CLAUDE, answerClaude, source } from "./source.js";

const { invoke } = window.__TAURI__.core;
const { listen, emitTo } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;

const LOOK_MILLISECONDS = 110;
const STATUS_MILLISECONDS = 5000;
const ACTIVITY_MILLISECONDS = 4000;
const WORKING_MILLISECONDS = 4500;
const BUBBLE_MILLISECONDS = 6000;
// Idle, it tucks away to a thin handle; the pointer at the top edge brings it out for this long.
const WAKE_MILLISECONDS = 3000;
// The window keeps one width, wide enough for every state, so it never has to move sideways:
// a resize and a move can't happen at once. Only its height changes.
const ISLAND_WINDOW_WIDTH = 360;
// Matches the island's size transition in buddy.css.
const ISLAND_MOTION_MILLISECONDS = 220;
// Click him this many times this quickly and he puts on a wizard hat, for a while.
const HAT_CLICKS = 5;
const HAT_WINDOW_MILLISECONDS = 2000;
const HAT_MILLISECONDS = 120_000;

const body = document.body;
const island = document.getElementById("island");
const buddy = document.getElementById("buddy");
const bubble = document.getElementById("bubble");
const pillText = document.getElementById("pill-text");
const dropHint = document.querySelector(".isle-hint");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// What it is showing, by priority: a dragover beats a request for attention beats work beats sleep.
const mood = { excited: false, attention: false, workingUntil: 0, asleep: false, hatUntil: 0, meal: null, carrying: null };
// Relay can't work: "agent" (not running) or "homelab" (running, but can't reach the server).
// This beats every other state. Watching Claude needs no agent, so then it never shows.
let offline = "";
// The island's line: a passing message beats the busiest session's status (from the panel).
const line = { message: "", status: null };
let awakeUntil = 0;
let shownMode = "";
const clicks = [];
const look = { x: 0, y: 0 };
const MEAL_SECONDS = 1.9; // frog.js plays the eating animation for this long

function currentMeal() {
  return mood.meal && performance.now() / 1000 - mood.meal.at < MEAL_SECONDS ? mood.meal : null;
}

function currentState() {
  return currentMeal() ? "eating"
    : mood.excited ? "excited"
    : mood.attention ? "attention"
    : Date.now() < mood.workingUntil ? "working"
    : mood.asleep ? "sleepy"
    : "idle";
}

const OFFLINE_TEXT = { agent: "Agent not running", homelab: "Can't reach the homelab" };

function islandMode() {
  if (offline && source() !== CLAUDE) return "offline";
  if (mood.carrying || currentMeal()) return "drop";
  if (!bubble.hidden) return "peek";
  if (line.message) return "message";
  if (line.status) return `status isle--${line.status.state}`;
  return Date.now() < awakeUntil || mood.attention ? "idle" : "hidden";
}

function islandText(mode) {
  if (mode === "offline") return OFFLINE_TEXT[offline];
  return line.message || (line.status ? `${line.status.project} · ${line.status.line}` : "");
}

// Every change of state eases the island from its old size to its new one. Growing, the window
// grows first and the island fills it; shrinking, the island shrinks first and the window follows.
let settleTimer = 0;
function render() {
  body.className = `state-${currentState()}`;
  const from = island.getBoundingClientRect();
  shownMode = islandMode();
  island.className = `isle isle--${shownMode}`;
  pillText.textContent = islandText(shownMode);
  dropHint.textContent = source() === CLAUDE ? "Sending files needs Relay" : "Drop to send";
  island.style.width = island.style.height = "";
  const to = island.getBoundingClientRect();
  clearTimeout(settleTimer);
  if (!windowShown || reducedMotion.matches || (from.width === to.width && from.height === to.height)) {
    dockTo(to.height);
    return;
  }
  dockTo(Math.max(from.height, to.height));
  island.style.width = `${from.width}px`;
  island.style.height = `${from.height}px`;
  island.getBoundingClientRect(); // start the transition from the old size
  island.style.width = `${to.width}px`;
  island.style.height = `${to.height}px`;
  settleTimer = setTimeout(() => {
    island.style.width = island.style.height = "";
    dockTo(island.getBoundingClientRect().height);
  }, ISLAND_MOTION_MILLISECONDS + 30);
}

// Window sizes go to the app one at a time, latest wins, so they can't land out of order. The
// window is shown only once it has its first size, so it never flashes at the wrong one.
let wantedHeight = null;
let docking = false;
let windowShown = false;
async function dockTo(height) {
  wantedHeight = Math.ceil(height);
  if (docking) return;
  docking = true;
  while (wantedHeight !== null) {
    const next = wantedHeight;
    wantedHeight = null;
    await invoke("dock_island", { width: ISLAND_WINDOW_WIDTH, height: next }).catch(() => {});
  }
  docking = false;
  if (!windowShown) {
    windowShown = true;
    getCurrentWindow().show();
  }
}

let messageTimer = 0;
function say(text, { sticky = false } = {}) {
  bubble.hidden = true;
  line.message = text;
  clearTimeout(messageTimer);
  if (!sticky) messageTimer = setTimeout(() => { line.message = ""; render(); }, BUBBLE_MILLISECONDS);
  render();
}

let peekTimer = 0;
function hidePeek() {
  bubble.hidden = true;
  mood.attention = false;
  render();
}

function showPeek({ project, state = "done", text, attention = false }) {
  line.message = "";
  bubble.hidden = false;
  clearTimeout(peekTimer);
  if (!attention) peekTimer = setTimeout(hidePeek, BUBBLE_MILLISECONDS);
  const make = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const head = make("div", "peek-head");
  const avatar = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  avatar.setAttribute("class", "peek-avatar"); avatar.setAttribute("viewBox", "0 0 40 40");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#frog-avatar"); avatar.append(use);
  const info = make("div", "grow");
  const name = make("strong", ""); name.append(make("span", "chip"), document.createTextNode(` ${project}`));
  info.append(name, make("small", "peek-detail", text));
  const badge = { failed: ["red", "Failed"], working: ["blue", "Working"], needs: ["orange", "Needs you"] }[state] || ["green", "Done"];
  const label = make("span", `state ${badge[0]}`);
  label.append(make("span", "dot"), document.createTextNode(badge[1]));
  head.append(avatar);
  if (state === "done") head.append(make("span", "done-mark", "✓"));
  head.append(info, label);
  const actions = make("div", "peek-actions");
  const open = make("button", "primary", "Open chat");
  open.onclick = async () => {
    await emitTo("panel", "panel:tab", "chat");
    await emitTo("panel", "panel:project", project);
    hidePeek();
    await invoke("show_panel");
  };
  const dismiss = make("button", "quiet", "Dismiss");
  dismiss.onclick = hidePeek;
  actions.append(open, dismiss); bubble.replaceChildren(head, actions);
  render();
}


// Where the mouse is, for the frog's occasional lazy glance. He blinks and yawns on his own.
async function followMouse() {
  try {
    const [x, y] = await invoke("cursor_from_buddy");
    const face = document.getElementById("frog").getBoundingClientRect();
    look.x = x - (face.left + face.width / 2) * devicePixelRatio;
    look.y = y - (face.top + face.height * 0.62) * devicePixelRatio;
    if (pointerWakes(x, y)) awakeUntil = Date.now() + WAKE_MILLISECONDS;
    if (islandMode() !== shownMode) render();
    letClicksThrough(!onIsland(x, y));
  } catch {
    // The window is mid-move; try again next tick.
  }
}

// The pointer (physical pixels from the window's corner) is on the island, or at the top edge of
// the screen in its middle third. Polling the position instead of waiting for a hover means it
// wakes mid-drag too, and an invisible hover strip never steals clicks from the window beneath.
function onIsland(x, y) {
  const scale = devicePixelRatio;
  const box = island.getBoundingClientRect();
  return x >= box.left * scale && y >= 0 && x <= box.right * scale && y <= box.bottom * scale;
}

function pointerWakes(x, y) {
  const scale = devicePixelRatio;
  // Above zero is a macOS menu bar, which the island sits just below.
  const atTop = y <= 3 * scale && y > -48 * scale;
  return onIsland(x, y) || (atTop && Math.abs(x - (innerWidth * scale) / 2) <= (screen.width * scale) / 6);
}

// The window is wider than the island: around it, clicks pass through to whatever is beneath.
let clicksThrough = null;
function letClicksThrough(through) {
  if (through === clicksThrough) return;
  clicksThrough = through;
  invoke("island_click_through", { through }).catch(() => {});
}

// Click opens the panel.
buddy.addEventListener("click", clicked);

function clicked() {
  const now = Date.now();
  clicks.push(now);
  while (clicks[0] < now - HAT_WINDOW_MILLISECONDS) clicks.shift();
  if (clicks.length >= HAT_CLICKS) {
    clicks.length = 0;
    mood.hatUntil = now + HAT_MILLISECONDS;
    say("Fine. You've made me a wizard. Happy now?");
    return;
  }
  openPanel();
}
buddy.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") openPanel();
});

function openPanel() {
  line.message = "";
  hidePeek();
  invoke("toggle_panel");
}

// Is the agent there? Only a change re-renders, so a steady outage stays still.
async function checkStatus() {
  let now = "";
  if (source() !== CLAUDE) {
    try {
      now = (await agent("/status")).online ? "" : "homelab";
    } catch {
      now = "agent";
    }
  }
  mood.asleep = now !== "";
  if (now !== offline) {
    offline = now;
    render();
  }
}

// What are projects doing on this machine? The first look only sets the baseline.
let newestSeen = null;
async function checkActivity() {
  if (mood.asleep || source() === CLAUDE) return;
  try {
    const { jobs } = await agent("/activity");
    const fresh = jobs.filter((job) => newestSeen !== null && job.created_at > newestSeen);
    if (jobs.length > 0) newestSeen = Math.max(newestSeen ?? 0, ...jobs.map((job) => job.created_at));
    else newestSeen ??= 0;
    const latest = fresh[0];
    if (latest) {
      mood.workingUntil = Date.now() + WORKING_MILLISECONDS;
      if (latest.status === "failed") showPeek({ project: latest.project, state: "failed", text: `Refused: ${describeJob(latest)}` });
      else say(`${latest.project} ${describeJob(latest)}`);
      setTimeout(render, WORKING_MILLISECONDS + 50);
    }
  } catch {
    // Status reports the outage; nothing to add here.
  }
}

// Files dragged over it: they hang under the cursor and he gets excited. He eats what was
// carried, from where it was let go, and then the app opens the panel.
getCurrentWebview().onDragDropEvent(async (event) => {
  const { type, position } = event.payload;
  if (type === "enter") {
    const paths = event.payload.paths;
    mood.excited = true;
    mood.carrying = { count: paths.length, folder: false, at: dropPoint(position) };
    const folders = await invoke("folder_flags", { paths }).catch(() => []);
    if (mood.carrying) mood.carrying.folder = folders.some(Boolean);
  } else if (type === "over" && mood.carrying) {
    mood.carrying.at = dropPoint(position);
  } else if (type === "leave" || type === "drop") {
    const carried = mood.carrying;
    mood.excited = false;
    mood.carrying = null;
    if (type === "drop") {
      mood.meal = {
        at: performance.now() / 1000, count: event.payload.paths.length,
        folder: carried?.folder ?? false, from: dropPoint(position),
      };
      setTimeout(() => {
        say("Got them. Pick a project.");
        render();
      }, MEAL_SECONDS * 1000);
    }
  }
  render();
  frog.redraw();
});

// The drop position (physical window pixels) in the frog's canvas pixels, kept on the canvas.
function dropPoint(position) {
  const canvas = document.getElementById("frog");
  const box = canvas.getBoundingClientRect();
  const scale = canvas.width / box.width;
  const clamp = (value) => Math.max(0, Math.min(canvas.width - 6, Math.round(value)));
  return {
    x: clamp((position.x / devicePixelRatio - box.left) * scale),
    y: clamp((position.y / devicePixelRatio - box.top) * scale),
  };
}

// The panel asks it to speak, e.g. when a project replies while the panel is closed.
listen("buddy:say", (event) => {
  const { text, attention = false } = event.payload;
  mood.attention = attention;
  if (event.payload.project) showPeek(event.payload);
  else say(text, { attention, sticky: attention });
  render();
});
listen("buddy:status", (event) => {
  line.status = event.payload;
  render();
});
listen("agent:changed", () => {
  forgetConnection();
  checkStatus();
});
// Claude Code on this computer wants an OK. It stays until answered, here or in the panel.
let askShown = null;
listen("buddy:ask", ({ payload: ask }) => {
  showPeek({ project: ask.project, state: "needs", text: `${ask.tool} · ${ask.summary}`, attention: true });
  askShown = ask.requestId;
  const answer = (allow) => {
    answerClaude(ask, allow).catch((error) => say(String(error)));
    hidePeek();
  };
  const make = (label, className, allow) =>
    Object.assign(document.createElement("button"), { className, textContent: label, type: "button", onclick: () => answer(allow) });
  bubble.querySelector(".peek-actions").replaceChildren(make("Deny", "quiet", false), make("Allow once", "primary", true));
  mood.attention = true;
  render();
});
listen("claude:answered", ({ payload }) => {
  if (payload === askShown) {
    askShown = null;
    hidePeek();
  }
});
listen("source:changed", () => {
  line.status = null;
  checkStatus();
  render();
});
// The panel folded back up: the island eases back in where its tab was.
listen("buddy:shown", () => {
  if (!reducedMotion.matches) {
    island.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
      duration: ISLAND_MOTION_MILLISECONDS, easing: "cubic-bezier(0.2, 0.9, 0.25, 1)",
    });
  }
});

const frog = startFrog(document.getElementById("frog"), {
  state: currentState, look, hat: () => Date.now() < mood.hatUntil, meal: currentMeal,
  carrying: () => mood.carrying,
});
// Learn whether the agent is there before the first draw.
checkStatus().finally(() => {
  render();
  setInterval(followMouse, LOOK_MILLISECONDS);
  setInterval(checkStatus, STATUS_MILLISECONDS);
});
setInterval(checkActivity, ACTIVITY_MILLISECONDS);
