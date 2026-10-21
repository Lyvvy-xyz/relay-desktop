// Where sessions come from: Relay (projects on the server, through the agent) or Claude Code running on
// this computer, read from its own transcripts. Only one at a time; every window shares the choice.
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
    // Without storage the choice lasts until Relay restarts.
  }
}

// Claude only: each session by the name shown for it ({ name, id, cwd, transcript }; a new one
// has no id or transcript until Claude Code has written its first line), and the Claude Code
// process this window started for it, if any.
const claudeSessions = new Map();
const runs = new Map();

export async function listSessions() {
  if (source() === RELAY) return (await agent("/projects")).projects;
  const found = await invoke("claude_sessions");
  const unwritten = [...claudeSessions.values()].filter((session) => !session.transcript);
  claudeSessions.clear();
  // Two folders with the same name: the more recently active one keeps it.
  for (const session of found.sort((a, b) => a.modified - b.modified)) claudeSessions.set(session.name, session);
  for (const session of unwritten) if (!claudeSessions.has(session.name)) claudeSessions.set(session.name, session);
  return [...claudeSessions.keys()].map((name) => ({ name, is_session_live: true }));
}

// The folders recent sessions ran in, to offer when starting a new one.
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

// The first message to a session starts Claude Code for it (continuing it, if it has history);
// later ones go to the same process, so it keeps the conversation.
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

// A "claude:line" that asks the person's OK for a tool call, or null.
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

// Whichever window answers first (the panel's card or the island's peek), the other one is told.
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

// A Claude cursor is "<transcript>\n<byte offset>"; a path can hold a colon, never a newline.
export async function readEvents(name, cursor) {
  if (source() === RELAY) return agent(`/projects/${encodeURIComponent(name)}/events?cursor=${encodeURIComponent(cursor)}`);
  const transcript = claudeSessions.get(name)?.transcript;
  if (!transcript) return { events: [], cursor };
  const split = cursor.lastIndexOf("\n");
  const from = split > 0 && cursor.slice(0, split) === transcript ? Number(cursor.slice(split + 1)) : null;
  const page = await invoke("claude_lines", { transcript, from });
  return { events: page.lines.flatMap(eventsInLine), cursor: `${transcript}\n${page.next}` };
}
