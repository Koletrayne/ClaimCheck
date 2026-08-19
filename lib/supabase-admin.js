'use strict';

/* Server-side Supabase access for Classroom Mode.
 *
 * Deliberately implemented with plain fetch against the PostgREST and GoTrue
 * HTTP APIs rather than @supabase/supabase-js. Node 18+ has global fetch, so
 * this adds no dependency — which matters here, because a previous heavy
 * dependency (jsdom) shipped ESM-only transitive code that crashed every
 * request on Vercel's bundled runtime. Fewer moving parts, same behaviour.
 *
 * The service role key bypasses Row Level Security, so it lives ONLY in this
 * process and is never sent to a browser. Every function in this module is
 * called from backend route handlers that have already authorized the caller.
 */

// Falls back to NEXT_PUBLIC_SUPABASE_URL because the deployed environment already
// defines the project URL under that name. The URL is not a secret — it is shipped
// to browsers in public/lib/supabase-config.js — so reusing it avoids adding a
// redundant variable. The service role key has no such fallback: it must be set
// explicitly and must never share a name with anything client-visible.
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function isConfigured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

class SupabaseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
  }
}

/* ── PostgREST (service role) ─────────────────────────────────────────── */

async function rest(path, { method = 'GET', body, prefer, signal } = {}) {
  if (!isConfigured()) {
    throw new SupabaseError('Classroom Mode is not configured on this server.', 503);
  }

  const headers = {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    'content-type': 'application/json',
  };
  if (prefer) headers.prefer = prefer;

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Node's fetch reports every transport failure as a bare "fetch failed" and
    // hides the real reason (DNS, TLS, refused connection) on err.cause. Without
    // unwrapping it, a misconfigured host and an expired certificate look
    // identical in the logs.
    const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
    console.error(`[supabase] ${method} ${path} transport error: ${err.message}${cause}`);
    throw new SupabaseError('Could not reach the database.', 502);
  }

  const text = await res.text();
  if (!res.ok) {
    // Supabase error payloads describe schema/constraint problems, not user
    // content — but they are still internal detail, so they are logged rather
    // than returned to the caller.
    console.error(`[supabase] ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    throw new SupabaseError('Database request failed.', 502);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Calls a Postgres function exposed over PostgREST. */
function rpc(fn, args = {}) {
  return rest(`rpc/${fn}`, { method: 'POST', body: args });
}

/* ── GoTrue: verify a teacher's access token ──────────────────────────── */

/**
 * Resolves the Supabase user for a browser-supplied access token, or null if
 * the token is missing, expired, or invalid.
 *
 * Verification is delegated to Supabase's own /auth/v1/user endpoint instead of
 * validating the JWT locally. That avoids shipping a JWT library and a copy of
 * the signing secret, and it honours server-side revocation (a signed-out or
 * deleted user is rejected immediately rather than staying valid until expiry).
 */
async function getUserFromToken(accessToken) {
  if (!isConfigured() || typeof accessToken !== 'string' || !accessToken) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (err) {
    console.error('[supabase] token verification failed:', err.message);
    return null;
  }
}

/** Reads the bearer token out of an Authorization header. */
function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

module.exports = {
  isConfigured,
  rest,
  rpc,
  getUserFromToken,
  bearerToken,
  SupabaseError,
};
