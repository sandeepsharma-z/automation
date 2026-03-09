import { NextResponse } from "next/server";
import { startBacklinksFinderRun } from "../../../../lib/backlinks_finder";

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const result = startBacklinksFinderRun(payload || {});
    return NextResponse.json({ ok: true, run_id: result.run_id });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
