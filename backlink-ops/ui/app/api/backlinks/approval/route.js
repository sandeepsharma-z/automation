import { NextResponse } from "next/server";
import { writeApprovalDecision } from "../../../../lib/backend";

export async function POST(request) {
  try {
    const payload = await request.json();
    const runId = String(payload.run_id || "");
    const siteSlug = String(payload.site_slug || "");
    if (!runId || !siteSlug) {
      return NextResponse.json({ error: "run_id and site_slug are required." }, { status: 400 });
    }
    writeApprovalDecision({
      runId,
      siteSlug,
      approved: Boolean(payload.approved),
      reason: String(payload.reason || ""),
      edited_draft: String(payload.edited_draft || ""),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
