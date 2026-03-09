import { NextResponse } from "next/server";
import { getRunSessionStatus } from "../../../../../lib/backend";

export async function GET() {
  try {
    const status = getRunSessionStatus();
    return NextResponse.json({ ok: true, ...status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
