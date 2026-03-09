import { NextResponse } from "next/server";
import { attachRowsToActiveSession, createQueueRowsBulk, startRunSession } from "../../../../../lib/backend";

export async function POST(request) {
  try {
    const payload = await request.json();
    const result = createQueueRowsBulk(payload);
    const autoRun = Boolean(payload?.auto_run);
    let run = null;
    if (autoRun && Number(result?.added || 0) > 0) {
      const createdKeys = Array.isArray(result?.rows)
        ? result.rows.map((row) => String(row?.row_key || "")).filter(Boolean)
        : [];
      const attached = attachRowsToActiveSession(createdKeys);
      if (attached?.running && attached?.mode === "explicit_row_keys") {
        run = { attached_to_running: true, session_id: attached.session_id || "" };
      } else if (attached?.running) {
        run = { attached_to_running: true, session_id: attached.session_id || "", mode: attached.mode || "" };
      } else {
        const started = startRunSession({
          headless: Boolean(payload?.headless),
          rowKeys: [],
          forceRetry: false,
          force: false,
        });
        run = {
          started: Boolean(started?.running),
          session_id: String(started?.session_id || ""),
          already_running: Boolean(started?.already_running),
        };
      }
    }
    return NextResponse.json({ ...result, run });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
