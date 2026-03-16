import { NextResponse } from "next/server";

const TARGET = "http://localhost:3015/api/backlink-ops/run/start";

export async function POST(request) {
  let body = "";
  try {
    body = await request.text();
  } catch (_) {
    body = "";
  }

  try {
    const upstream = await fetch(TARGET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body || "{}",
      cache: "no-store",
    });
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
}

