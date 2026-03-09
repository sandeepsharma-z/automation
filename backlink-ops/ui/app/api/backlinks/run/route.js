import { NextResponse } from "next/server";
import { startRunSession } from "../../../../lib/backend";

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const started = startRunSession({
      headless: Boolean(payload.headless),
    });
    return NextResponse.json(started);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
