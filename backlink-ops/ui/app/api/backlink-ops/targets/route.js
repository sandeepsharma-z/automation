import { NextResponse } from "next/server";
import { listTargets } from "../../../../lib/targets_store";

export async function GET() {
  try {
    const rows = await listTargets();
    return NextResponse.json({
      ok: true,
      targets: rows,
      allowlisted: rows.filter((item) => item.allowed),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
