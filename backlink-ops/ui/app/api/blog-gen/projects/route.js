import { NextResponse } from "next/server";
import crypto from "node:crypto";

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

export async function GET() {
  try {
    const apiUrl = (process.env.FASTAPI_URL || "http://localhost:8010").replace(/\/+$/, "");
    const res = await fetch(`${apiUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${makeJWT()}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: err?.detail || `API error: ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(Array.isArray(data) ? data : []);
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
