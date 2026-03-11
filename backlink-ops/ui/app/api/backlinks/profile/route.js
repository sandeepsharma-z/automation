import { NextResponse } from "next/server";
import { loadProfileDefaults, saveProfileDefaults } from "../../../../lib/backend";

export async function GET() {
  try {
    const profile = loadProfileDefaults();
    return NextResponse.json({ ok: true, profile: profile || null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const stored = saveProfileDefaults(payload || {});
    return NextResponse.json({ ok: true, profile: stored });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
