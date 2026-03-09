import path from "node:path";
import { appendJsonl, nowIso } from "./utils.js";

export function createRunLogger(runId, runsRoot) {
  const eventsPath = path.join(runsRoot, runId, "events.jsonl");
  return {
    runId,
    eventsPath,
    log(event) {
      appendJsonl(eventsPath, { timestamp: nowIso(), run_id: runId, ...event });
    },
  };
}

