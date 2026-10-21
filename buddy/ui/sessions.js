// Incremental feed reducer. The caller supplies observation time; events have no timestamps, so
// a turn already under way in the first read of history has an unknown start (now = null).
export function deriveSession(previous, events, now) {
  const next = { state: "idle", startedAt: null, endedAt: null, text: "", steps: [], ...previous };
  next.steps = next.steps.map((step) => ({ ...step }));
  for (const event of events) {
    if (event.kind === "user" || (event.kind === "tool_start" && ["idle", "done"].includes(next.state))) {
      next.startedAt = now;
      next.endedAt = null;
      next.text = "";
      next.steps = [];
      next.state = "working";
    }
    if (event.kind === "tool_start") {
      next.steps.push({ id: event.id, tool: event.tool, summary: event.summary || "", state: "running" });
      next.steps = next.steps.slice(-30);
      if (next.state !== "failed") next.state = "working";
    } else if (event.kind === "tool_end") {
      const step = next.steps.findLast((item) => item.id === event.id);
      if (step) step.state = event.ok === false ? "failed" : "ok";
      next.state = event.ok === false ? "failed" : "working";
    } else if (event.kind === "text") {
      next.text = (event.text || "").split(/\r?\n/, 1)[0].slice(0, 160);
    } else if (event.kind === "done") {
      next.state = "done";
      next.endedAt = next.startedAt === null ? null : now;
      for (const step of next.steps) if (step.state === "running") step.state = "ok";
    }
  }
  return next;
}
