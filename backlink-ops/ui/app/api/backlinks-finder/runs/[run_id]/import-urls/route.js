import { NextResponse } from "next/server";
import { importBacklinksFinderUrls } from "../../../../../../lib/backlinks_finder";

export async function POST(request, { params }) {
  try {
    const runId = String(params?.run_id || "").trim();
    if (!runId) return NextResponse.json({ error: "run_id is required." }, { status: 400 });

    const payload = await request.json().catch(() => ({}));
    const urls = Array.isArray(payload?.urls) ? payload.urls : [];
    const keyword = String(payload?.keyword || "");
    const queryUsed = String(payload?.query_used || payload?.queryUsed || "");
    const engine = String(payload?.engine || "manual") || "manual";

    const result = importBacklinksFinderUrls({
      runId,
      urls,
      keyword,
      queryUsed,
      engine,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error || "Unable to import URLs." }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
