// All requests to the Relay server go through the agent's local API on 127.0.0.1. The device token
// never reaches the pages.
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
    // The agent stopped or restarted on another port; re-read its info next time.
    forgetConnection();
    throw new AgentError("The agent isn't running.");
  }
  if (!response.ok) {
    const reply = await response.json().catch(() => ({}));
    throw new AgentError(reply.error || `The agent answered ${response.status}.`, response.status);
  }
  return as === "blob" ? response.blob() : response.json();
}

// Short description of a project's job for the island.
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
