import { NextResponse } from "next/server";

const TARGET = "http://localhost:3015/api/backlink-ops/run/status";

export async function GET() {
  try {
    const upstream = await fetch(TARGET, { cache: "no-store" });
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
}

