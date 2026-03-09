import { NextResponse } from "next/server";
import { listBacklinksFinderRuns } from "../../../../lib/backlinks_finder";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || 25);
    const runs = listBacklinksFinderRuns(limit);
    return NextResponse.json({ ok: true, runs });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
