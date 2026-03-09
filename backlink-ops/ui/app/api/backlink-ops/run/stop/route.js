import { NextResponse } from "next/server";
import { stopRunSession } from "../../../../../lib/backend";

export async function POST() {
  try {
    const result = stopRunSession();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
