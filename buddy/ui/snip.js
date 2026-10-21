import { agent } from "./agent.js";

const { invoke } = window.__TAURI__.core;
const { emitTo } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

// The buddy and panel were just hidden; give the screen a moment to repaint without them.
const SETTLE_MILLISECONDS = 350;
const MIN_BOX = 8;
const CARD_WIDTH = 320;
const CARD_HEIGHT = 220;

const byId = (id) => document.getElementById(id);
const shot = byId("shot");
const selection = byId("selection");
const card = byId("card");
let box = null; // in screen pixels of this window

function finish(reopenPanel) {
  invoke("end_snip", { reopenPanel });
}

// Where the screenshot is actually drawn inside the window (object-fit: contain).
function imageArea() {
  const scale = Math.min(innerWidth / shot.naturalWidth, innerHeight / shot.naturalHeight);
  const width = shot.naturalWidth * scale;
  const height = shot.naturalHeight * scale;
  return { scale, left: (innerWidth - width) / 2, top: (innerHeight - height) / 2 };
}

function drawBox(from, to) {
  const left = Math.min(from.x, to.x);
  const top = Math.min(from.y, to.y);
  box = { left, top, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
  Object.assign(selection.style, { left: `${left}px`, top: `${top}px`, width: `${box.width}px`, height: `${box.height}px` });
  selection.hidden = false;
}

function placeCard() {
  const below = box.top + box.height + 12;
  const top = below + CARD_HEIGHT < innerHeight ? below : Math.max(12, box.top - CARD_HEIGHT - 12);
  const left = Math.min(Math.max(12, box.left), innerWidth - CARD_WIDTH - 12);
  Object.assign(card.style, { top: `${top}px`, left: `${left}px` });
  card.hidden = false;
  byId("note").focus();
}

let start = null;
document.addEventListener("pointerdown", (event) => {
  if (card.contains(event.target) || !shot.naturalWidth) return;
  start = { x: event.clientX, y: event.clientY };
  card.hidden = true;
  document.body.classList.add("selecting");
  document.body.classList.remove("has-selection");
});
document.addEventListener("pointermove", (event) => {
  if (start) drawBox(start, { x: event.clientX, y: event.clientY });
});
document.addEventListener("pointerup", () => {
  if (!start) return;
  start = null;
  document.body.classList.remove("selecting");
  if (!box || box.width < MIN_BOX || box.height < MIN_BOX) {
    selection.hidden = true;
    return;
  }
  document.body.classList.add("has-selection");
  placeCard();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") finish(false);
});
byId("cancel").onclick = () => finish(false);
byId("failed-close").onclick = () => finish(false);
byId("redo").onclick = () => {
  card.hidden = true;
  selection.hidden = true;
  document.body.classList.remove("has-selection");
};

function cropped() {
  const area = imageArea();
  const sx = Math.max(0, (box.left - area.left) / area.scale);
  const sy = Math.max(0, (box.top - area.top) / area.scale);
  const sw = Math.min(shot.naturalWidth - sx, box.width / area.scale);
  const sh = Math.min(shot.naturalHeight - sy, box.height / area.scale);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  canvas.getContext("2d").drawImage(shot, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

card.onsubmit = async (event) => {
  event.preventDefault();
  const project = byId("project").value;
  if (!project) {
    byId("error").textContent = "Pick a project.";
    return;
  }
  byId("send").disabled = true;
  byId("error").textContent = "";
  try {
    const form = new FormData();
    form.append("file", await cropped(), "screenshot.png");
    form.append("note", byId("note").value.trim() || "Look at this screenshot.");
    await agent(`/projects/${project}/inbox`, { method: "POST", body: form });
    localStorage.setItem("relay.project", project);
    await emitTo("buddy", "buddy:say", { text: `Sent to ${project}. It's been told what's wrong.` });
    finish(false);
  } catch (error) {
    byId("error").textContent = error.message;
    byId("send").disabled = false;
  }
};

async function loadProjects() {
  try {
    const { projects } = await agent("/projects");
    const remembered = localStorage.getItem("relay.project");
    byId("project").replaceChildren(...projects.map((project) => {
      const option = document.createElement("option");
      option.value = project.name;
      option.textContent = project.is_session_live ? project.name : `${project.name} (not running)`;
      return option;
    }));
    if (projects.some((project) => project.name === remembered)) byId("project").value = remembered;
  } catch (error) {
    byId("error").textContent = error.message;
  }
}

async function capture() {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));
  const me = getCurrentWindow();
  try {
    const image = await agent("/capture", { method: "POST", as: "blob" });
    shot.src = URL.createObjectURL(image);
    await shot.decode();
  } catch (error) {
    byId("failed-reason").textContent = `${error.message} On a Mac, allow Relay Buddy under System Settings → Privacy & Security → Screen Recording.`;
    byId("failed").hidden = false;
    document.body.style.cursor = "default";
  }
  await me.show();
  await me.setFocus();
  loadProjects();
}

capture();
