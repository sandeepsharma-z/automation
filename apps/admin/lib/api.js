'use client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8010';
const FALLBACK_API_URL = process.env.NEXT_PUBLIC_API_FALLBACK_URL || 'http://127.0.0.1:8000';
const LOCALHOST_8010 = 'http://localhost:8010';
const LOOPBACK_8010 = 'http://127.0.0.1:8010';

function buildApiCandidates() {
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim().replace(/\/+$/, '');
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  // Prefer IPv4 loopback first to avoid localhost IPv6 (::1) resolution issues on Windows.
  push(LOOPBACK_8010);
  push(API_URL);
  push(FALLBACK_API_URL);
  push(LOCALHOST_8010);

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host) {
      push(`http://${host}:8010`);
    }
  }

  return out;
}

export function getToken() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('contentops_token');
  } catch (_) {
    return null;
  }
}

export function setToken(token) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('contentops_token', token);
  } catch (_) {
    // no-op
  }
}

export function clearToken() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem('contentops_token');
  } catch (_) {
    // no-op
  }
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const requestOptions = {
    ...options,
    headers,
  };

  const method = String(options.method || 'GET').toUpperCase();
  const canRetrySafely = ['GET', 'HEAD', 'OPTIONS'].includes(method);
  const candidates = canRetrySafely ? buildApiCandidates() : [String(API_URL || '').trim().replace(/\/+$/, '')];

  let response;
  let lastNetworkError = null;
  for (const base of candidates) {
    let timeoutId = null;
    try {
      const controller = new AbortController();
      const timeoutMs = Number(options.timeoutMs || (method === 'GET' ? 6000 : 120000));
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      // Allow caller to cancel via external signal
      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      const res = await fetch(`${base}${path}`, { ...requestOptions, signal: controller.signal });
      clearTimeout(timeoutId);
      response = res;
      if (res.ok) break;
      // Stop early on auth failures and non-api routes; don't mask server errors.
      if (res.status === 401 || !canRetrySafely || !path.startsWith('/api/')) break;
      // For API route 404, continue trying next candidate (old port / mismatched host).
      if (res.status !== 404) break;
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      lastNetworkError = err;
      if (!canRetrySafely) {
        throw err;
      }
    }
  }

  if (!response && lastNetworkError) {
    throw new Error(`Unable to connect to API. Tried: ${candidates.join(', ')}`);
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 && typeof window !== 'undefined') {
      clearToken();
    }
    throw new Error(text || `Request failed with ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}
