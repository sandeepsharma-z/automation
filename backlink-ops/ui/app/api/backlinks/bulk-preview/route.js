import { NextResponse } from "next/server";
import { bulkPreviewRows } from "../../../../lib/backend";

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const preview = bulkPreviewRows(payload);
    return NextResponse.json({ ok: true, ...preview });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

