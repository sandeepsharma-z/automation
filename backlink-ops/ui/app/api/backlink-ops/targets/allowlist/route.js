import { NextResponse } from "next/server";
import { upsertAllowlistedTarget } from "../../../../../lib/targets_store";

export async function POST(request) {
  try {
    const body = await request.json();
    const directoryUrl = String(body?.directory_url || "").trim();
    const type = String(body?.type || "business_directory").trim();
    const result = await upsertAllowlistedTarget({
      directory_url: directoryUrl,
      type,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 400 });
  }
}
