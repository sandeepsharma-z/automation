import { NextResponse } from "next/server";
import { deleteBacklinksFinderLinks } from "../../../../lib/backlinks_finder";

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const runId = String(payload?.run_id || "");
    const linkIds = Array.isArray(payload?.link_ids) ? payload.link_ids : [];
    if (!runId) return NextResponse.json({ error: "run_id is required." }, { status: 400 });
    const result = deleteBacklinksFinderLinks({ runId, linkIds });
    if (!result.ok) return NextResponse.json({ error: result.error || "Unable to delete links." }, { status: 400 });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
