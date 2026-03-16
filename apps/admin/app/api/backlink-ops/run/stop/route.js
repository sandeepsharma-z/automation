import { NextResponse } from "next/server";

const TARGET = "http://localhost:3015/api/backlink-ops/run/stop";

export async function POST() {
  try {
    const upstream = await fetch(TARGET, { method: "POST", cache: "no-store" });
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
}

