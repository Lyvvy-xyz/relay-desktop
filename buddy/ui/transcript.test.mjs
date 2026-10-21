import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./transcript.js", import.meta.url), "utf8");
const { eventsInLine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const line = (record) => JSON.stringify(record);
assert.deepEqual(eventsInLine("not json"), []);
assert.deepEqual(eventsInLine(line({ type: "summary" })), []);
assert.deepEqual(eventsInLine(line({ type: "user", message: { content: "fix the panel" } })), [{ kind: "user", text: "fix the panel" }]);
assert.deepEqual(
  eventsInLine(line({ type: "assistant", message: { content: [
    { type: "text", text: "Looking." },
    { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "buddy/ui/panel.css\nmore" } },
  ] } })),
  [{ kind: "text", text: "Looking." }, { kind: "tool_start", id: "t1", tool: "Edit", summary: "buddy/ui/panel.css" }],
);
assert.deepEqual(
  eventsInLine(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } })),
  [{ kind: "tool_end", id: "t1", ok: false }],
);
assert.deepEqual(
  eventsInLine(line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } })),
  [{ kind: "text", text: "Done." }, { kind: "done" }],
);
assert.equal(eventsInLine(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Task", input: {} }] } }))[0].summary, "Task");
assert.equal(eventsInLine(line({ type: "user", message: { content: "x".repeat(3000) } }))[0].text.length, 2000);
console.log("Transcript event tests passed.");
