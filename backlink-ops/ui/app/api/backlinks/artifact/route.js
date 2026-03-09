import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { projectRoot } from "../../../../lib/backend";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const runId = String(searchParams.get("run_id") || "");
    const siteSlug = String(searchParams.get("site_slug") || "");
    const fileName = String(searchParams.get("file") || "");
    if (!runId || !siteSlug || !fileName) {
      return NextResponse.json({ error: "run_id, site_slug and file are required." }, { status: 400 });
    }

    const safeName = path.basename(fileName);
    const filePath = path.join(projectRoot(), "runs", runId, siteSlug, safeName);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }

    const body = fs.readFileSync(filePath);
    const contentType = safeName.endsWith(".png") ? "image/png" : "text/html; charset=utf-8";
    return new NextResponse(body, {
      headers: { "Content-Type": contentType },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

