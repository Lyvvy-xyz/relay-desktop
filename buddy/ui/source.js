// Where sessions come from: Relay (server projects, through the agent) or Claude Code on this
// computer (from its transcripts). One at a time, shared across windows.
import { agent } from "./agent.js";
import { eventsInLine, summary } from "./transcript.js";

const { invoke } = window.__TAURI__.core;
const { emit } = window.__TAURI__.event;
const SOURCE_KEY = "relay.source";
export const RELAY = "relay";
export const CLAUDE = "claude";

export function source() {
  try {
    return localStorage.getItem(SOURCE_KEY) === CLAUDE ? CLAUDE : RELAY;
  } catch {
    return RELAY;
  }
}

export function setSource(value) {
  try {
    localStorage.setItem(SOURCE_KEY, value);
  } catch {
    // No storage: the choice lasts until restart.
  }
}

// Claude mode: sessions by display name ({ name, id, cwd, transcript }; id and transcript are null
// until Claude Code writes its first line), and the Claude Code process started for each.
const claudeSessions = new Map();
const runs = new Map();

export async function listSessions() {
  if (source() === RELAY) return (await agent("/projects")).projects;
  const found = await invoke("claude_sessions");
  const unwritten = [...claudeSessions.values()].filter((session) => !session.transcript);
  claudeSessions.clear();
  // If two folders share a name, the most recent one wins.
  for (const session of found.sort((a, b) => a.modified - b.modified)) claudeSessions.set(session.name, session);
  for (const session of unwritten) if (!claudeSessions.has(session.name)) claudeSessions.set(session.name, session);
  return [...claudeSessions.keys()].map((name) => ({ name, is_session_live: true }));
}

// Folders of recent sessions, offered when starting a new one.
export function claudeFolders() {
  return [...new Set([...claudeSessions.values()].map((session) => session.cwd))];
}

export function newClaudeSession(cwd) {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  const running = runs.get(name);
  if (running) invoke("claude_stop", { run: running });
  runs.delete(name);
  claudeSessions.set(name, { name, id: null, cwd, transcript: null });
  return name;
}

// The first message starts Claude Code (resuming if there's history); later ones go to the same
// process.
export async function sendToClaude(name, text) {
  const session = claudeSessions.get(name);
  if (!session) throw new Error("Pick a session, or start a new one.");
  let run = runs.get(name);
  if (!run) {
    run = await invoke("claude_start", { cwd: session.cwd, resume: session.id });
    runs.set(name, run);
  }
  await invoke("claude_send", { run, message: { type: "user", message: { role: "user", content: text } } });
}

export function sessionForRun(run) {
  for (const [name, id] of runs) if (id === run) return name;
  return null;
}

export function forgetRun(run) {
  const name = sessionForRun(run);
  if (name) runs.delete(name);
  return name;
}

// Parses a claude:line permission request, or returns null.
export function askIn({ run, line }) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record?.type !== "control_request" || record.request?.subtype !== "can_use_tool") return null;
  const tool = String(record.request.tool_name ?? "tool");
  const input = record.request.input ?? {};
  return { run, requestId: record.request_id, tool, input, summary: summary(tool, input) };
}

// Tells the other window the request was answered.
export async function answerClaude(ask, allow) {
  const response = allow
    ? { behavior: "allow", updatedInput: ask.input }
    : { behavior: "deny", message: "The person said no in Relay." };
  await invoke("claude_send", {
    run: ask.run,
    message: { type: "control_response", response: { subtype: "success", request_id: ask.requestId, response } },
  });
  await emit("claude:answered", ask.requestId);
}

// Claude cursors are "<transcript>\n<byte offset>". Paths can contain colons but not newlines.
export async function readEvents(name, cursor) {
  if (source() === RELAY) return agent(`/projects/${encodeURIComponent(name)}/events?cursor=${encodeURIComponent(cursor)}`);
  const transcript = claudeSessions.get(name)?.transcript;
  if (!transcript) return { events: [], cursor };
  const split = cursor.lastIndexOf("\n");
  const from = split > 0 && cursor.slice(0, split) === transcript ? Number(cursor.slice(split + 1)) : null;
  const page = await invoke("claude_lines", { transcript, from });
  return { events: page.lines.flatMap(eventsInLine), cursor: `${transcript}\n${page.next}` };
}
