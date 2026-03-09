import { NextResponse } from "next/server";
import { listWorkflows } from "../../../../lib/workflows.js";

export async function GET() {
  try {
    return NextResponse.json({ workflows: listWorkflows() });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
