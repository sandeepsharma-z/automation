import { NextResponse } from "next/server";
import { startRunSession } from "../../../../../lib/backend";

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const result = startRunSession({
      headless: Boolean(payload.headless),
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
