import { NextResponse } from "next/server";
import { readRowsByStatus } from "../../../../lib/backend";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = String(searchParams.get("status") || "");
    const statuses = status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const rows = readRowsByStatus(statuses);
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

