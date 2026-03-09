import { NextResponse } from "next/server";
import { readRunDetail } from "../../../../../lib/backend";

export async function GET(_request, { params }) {
  try {
    const run = readRunDetail(params.runId);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

