import { NextResponse } from 'next/server';

async function canReach(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    return res.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  const envBase = String(process.env.NEXT_PUBLIC_BACKLINK_OPS_UI_URL || '').trim();
  const candidates = [
    envBase,
    'http://localhost:3015',
    'http://127.0.0.1:3015',
  ].filter(Boolean);

  for (const base of candidates) {
    const probeUrl = `${base.replace(/\/+$/, '')}/api/backlinks/workflows`;
    // eslint-disable-next-line no-await-in-loop
    const ok = await canReach(probeUrl);
    if (ok) {
      return NextResponse.json({ ok: true, base, tried: candidates });
    }
  }

  return NextResponse.json(
    {
      ok: false,
      error: 'Backlink Ops UI is not reachable on port 3015.',
      tried: candidates,
      hint: 'Start UI with: cd backlink-ops/ui && npm run dev (or npm run start after build).',
    },
    { status: 503 }
  );
}

