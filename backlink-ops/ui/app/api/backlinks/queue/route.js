import { NextResponse } from "next/server";
import { createQueueRow, createQueueRowsBulk, readQueueRows, removeQueueRow } from "../../../../lib/backend";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit") || 250), 500);
    const workflowType = searchParams.get("workflow_type") || searchParams.get("type") || "";
    let rows = await readQueueRows(limit);
    if (workflowType) {
      const normalizeType = (v) => String(v || "").toLowerCase().replace(/[-\s]+/g, "_");
      const filterType = normalizeType(workflowType);
      rows = rows.filter((r) => normalizeType(r.workflow_type) === filterType);
    }
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
