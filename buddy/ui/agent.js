// The one way the buddy's pages reach the Relay server: the agent's local API on 127.0.0.1, with the
// secret the app reads from the agent's owner-only file. The device token never reaches a page.
const { invoke } = window.__TAURI__.core;

let connection = null;

export class AgentError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function forgetConnection() {
  connection = null;
}

async function connect() {
  if (connection === null) {
    try {
      connection = await invoke("local_api");
    } catch (error) {
      throw new AgentError(String(error));
    }
  }
  return connection;
}

export async function agent(path, { method = "GET", body, form, as = "json" } = {}) {
  const { port, token } = await connect();
  const headers = { "X-Buddy-Token": token };
  let payload = body;
  if (form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: payload });
  } catch {
    // The agent restarted on a new port, or stopped: read its file again next time.
    forgetConnection();
    throw new AgentError("The agent isn't running.");
  }
  if (!response.ok) {
    const reply = await response.json().catch(() => ({}));
    throw new AgentError(reply.error || `The agent answered ${response.status}.`, response.status);
  }
  return as === "blob" ? response.blob() : response.json();
}

export function timeAgo(unixSeconds) {
  const seconds = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// How the buddy says what a project did on this machine.
export function describeJob(job) {
  const name = String(job.argument || "").split(/[\\/]/).filter(Boolean).pop() || job.argument;
  switch (job.verb) {
    case "screenshot": return "took a screenshot";
    case "list": return `looked in ${name}`;
    case "read": return `read ${name}`;
    case "write": return `saved ${name}`;
    default: return job.verb;
  }
}
