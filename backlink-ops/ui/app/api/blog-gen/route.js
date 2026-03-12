import { NextResponse } from "next/server";
import crypto from "node:crypto";

// Allow up to 5 minutes for blog generation (local dev only)
export const maxDuration = 300;
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

function parseTagList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(request) {
  try {
    const body = await request.json();

    const primaryKeyword = String(body.primary_keyword || body.topic || "").trim();
    const secondaryKws = [
      ...parseTagList(body.secondary_keywords),
      ...parseTagList(body.nlp_terms),
    ].filter((k) => k.toLowerCase() !== primaryKeyword.toLowerCase());

    const payload = {
      project_id: Number(body.project_id) || 1,
      platform: "none",
      primary_keyword: primaryKeyword,
      secondary_keywords: secondaryKws,
      topic: String(body.topic || "").trim() || primaryKeyword,
      tone: body.tone || "professional",
      country: body.country || "in",
      language: "en",
      desired_word_count: Number(body.word_count) || 1500,
      image_mode: "featured_only",
      inline_images_count: 0,
      autopublish: false,
      publish_status: "draft",
      force_new: true,
    };

    // Append note to topic if provided (FastAPI uses topic as context)
    if (body.note && String(body.note).trim()) {
      payload.topic = `${payload.topic}\n\nExtra instructions: ${String(body.note).trim()}`;
    }

    const apiUrl = (process.env.FASTAPI_URL || "http://localhost:8010").replace(/\/+$/, "");
    const res = await fetch(`${apiUrl}/api/blog-agent/generate?async_job=false`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${makeJWT()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(280000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.detail || `Generation failed (${res.status})` },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("TimeoutError") || msg.includes("abort")) {
      return NextResponse.json(
        { error: "Generation timed out after 4.5 minutes. Try a lower word count or simpler topic." },
        { status: 504 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
