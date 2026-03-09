import { NextResponse } from "next/server";
import { readRuns } from "../../../../lib/backend";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeRows = String(searchParams.get("include_rows") || "") === "1";
    const runs = readRuns({ includeRows });
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
