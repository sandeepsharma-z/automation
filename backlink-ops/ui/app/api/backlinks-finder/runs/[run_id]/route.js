import { NextResponse } from "next/server";
import { getBacklinksFinderRun } from "../../../../../lib/backlinks_finder";

export async function GET(_request, { params }) {
  try {
    const runId = String(params?.run_id || "");
    const run = getBacklinksFinderRun(runId);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    return NextResponse.json({ ok: true, run });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
