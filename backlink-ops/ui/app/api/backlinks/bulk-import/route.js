import { NextResponse } from "next/server";
import { bulkImportRows } from "../../../../lib/backend";

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const result = bulkImportRows(payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

