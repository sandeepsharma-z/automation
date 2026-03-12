import { NextResponse } from 'next/server';

export const maxDuration = 60;

const SIZES = ['1024x1024', '1792x1024', '1024x1792'];

export async function POST(req) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const prompt = String(body.prompt || '').trim();
  const size = SIZES.includes(body.size) ? body.size : '1024x1024';
  const model = String(body.model || 'dall-e-3');

  if (!prompt) {
    return NextResponse.json({ error: 'prompt required' }, { status: 400 });
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.error?.message || 'OpenAI API error' },
        { status: resp.status }
      );
    }

    const b64 = data?.data?.[0]?.b64_json;
    const revised = data?.data?.[0]?.revised_prompt || prompt;

    if (!b64) {
      return NextResponse.json({ error: 'No image returned' }, { status: 500 });
    }

    return NextResponse.json({ b64, revised_prompt: revised, size });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
