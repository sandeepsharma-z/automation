import { NextResponse } from "next/server";
import { createQueueRow, createQueueRowsBulk, readQueueRows, removeQueueRow } from "../../../../lib/backend";

export async function GET() {
  try {
    const rows = await readQueueRows(250);
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const payload = await request.json();
    if (Array.isArray(payload?.rows)) {
      const result = createQueueRowsBulk(payload);
      return NextResponse.json(result);
    }
    const row = createQueueRow(payload);
    return NextResponse.json({ ok: true, row });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const rowKey = String(searchParams.get("row_key") || "");
    if (!rowKey) {
      return NextResponse.json({ error: "row_key is required." }, { status: 400 });
    }
    const result = removeQueueRow(rowKey);
    if (!result.ok) {
      return NextResponse.json({ error: "Row not found." }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
