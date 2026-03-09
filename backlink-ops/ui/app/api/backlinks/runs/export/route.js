import { NextResponse } from "next/server";
import { exportRunCsv } from "../../../../../lib/backend";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const runId = String(searchParams.get("run_id") || "");
    if (!runId) return NextResponse.json({ error: "run_id is required." }, { status: 400 });
    const csv = exportRunCsv(runId);
    if (!csv) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"backlink-run-${runId}.csv\"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

