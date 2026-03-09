import { NextResponse } from "next/server";
import { readRowDetail } from "../../../../../lib/backend";

export async function GET(_request, { params }) {
  try {
    const row = await readRowDetail(params.rowKey);
    if (!row) {
      return NextResponse.json({ error: "Row not found in runs." }, { status: 404 });
    }
    return NextResponse.json({ row });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
