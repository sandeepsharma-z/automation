import { NextResponse } from "next/server";
import { startRowRetrySession } from "../../../../lib/backend";

export async function POST(request) {
  try {
    const payload = await request.json();
    const rowKey = String(payload.row_key || "");
    if (!rowKey) {
      return NextResponse.json({ error: "row_key is required." }, { status: 400 });
    }
    const result = startRowRetrySession({
      rowKey,
      headless: Boolean(payload.headless),
    });
    if (!result?.ok) {
      return NextResponse.json({ error: String(result?.error || "Unable to start retry.") }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      run_id: String(result.session_id || ""),
      session_id: String(result.session_id || ""),
      already_running: Boolean(result.already_running),
      running: Boolean(result.running),
      message: String(result.message || ""),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
