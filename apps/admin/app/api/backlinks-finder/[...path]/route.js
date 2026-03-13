import { NextResponse } from 'next/server';

const BASE = 'http://localhost:3015';

async function proxy(request, { params }) {
  const pathParts = (await params).path || [];
  const pathStr = pathParts.join('/');
  const { search } = new URL(request.url);
  const target = `${BASE}/api/backlinks-finder/${pathStr}${search}`;

  const headers = { 'Content-Type': 'application/json' };
  const method = request.method;

  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    try { body = await request.text(); } catch (_) {}
  }

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: body || undefined,
      cache: 'no-store',
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': upstream.headers.get('content-disposition') || '',
        },
      });
    }

    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
