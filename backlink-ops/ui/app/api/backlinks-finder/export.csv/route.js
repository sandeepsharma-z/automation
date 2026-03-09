import { NextResponse } from "next/server";
import { exportBacklinksFinderCsv } from "../../../../lib/backlinks_finder";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const runId = String(searchParams.get("run_id") || "");
    if (!runId) return NextResponse.json({ error: "run_id is required." }, { status: 400 });
    const csv = exportBacklinksFinderCsv(runId);
    if (!csv) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"backlinks-finder-${runId}.csv\"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
