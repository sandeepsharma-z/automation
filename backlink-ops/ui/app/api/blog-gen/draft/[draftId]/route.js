import { NextResponse } from "next/server";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

function makeJWT() {
  const secret = process.env.INTERNAL_JWT_SECRET || "change-me";
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export async function GET(request, { params }) {
  try {
    const { draftId } = params;
    const apiUrl = (process.env.FASTAPI_URL || "http://localhost:8010").replace(/\/+$/, "");
    const res = await fetch(`${apiUrl}/api/blog-agent/${draftId}`, {
      headers: { Authorization: `Bearer ${makeJWT()}` },
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ error: data?.detail || "Not found" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
