// Turns Claude Code JSONL transcript lines into chat events: user message, assistant text, tool
// start and end, end of turn.
const MAX_TEXT_LENGTH = 2000;
const SUMMARY_INPUT_KEYS = ["command", "file_path", "notebook_path", "pattern", "url", "query", "path"];

export function summary(tool, input) {
  if (input && typeof input === "object") {
    for (const key of SUMMARY_INPUT_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value) return value.trim().split("\n")[0].slice(0, MAX_TEXT_LENGTH);
    }
  }
  return tool;
}

function blockEvent(role, block) {
  if (!block || typeof block !== "object") return null;
  const text = String(block.text ?? "").slice(0, MAX_TEXT_LENGTH);
  if (role === "user" && block.type === "tool_result") return { kind: "tool_end", id: block.tool_use_id, ok: !block.is_error };
  if (role === "user" && block.type === "text") return { kind: "user", text };
  if (role === "assistant" && block.type === "text" && text.trim()) return { kind: "text", text };
  if (role === "assistant" && block.type === "tool_use") {
    const tool = String(block.name ?? "tool");
    return { kind: "tool_start", id: block.id, tool, summary: summary(tool, block.input) };
  }
  return null;
}

export function eventsInLine(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  const message = record?.message;
  if (!message || typeof message !== "object") return [];
  const { content } = message;
  const role = record.type;
  if (role === "user" && typeof content === "string") return [{ kind: "user", text: content.slice(0, MAX_TEXT_LENGTH) }];
  const events = (Array.isArray(content) ? content : []).map((block) => blockEvent(role, block)).filter(Boolean);
  if (role === "assistant" && message.stop_reason === "end_turn") events.push({ kind: "done" });
  return events;
}
