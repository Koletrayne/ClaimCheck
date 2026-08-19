'use strict';

/* Classroom Mode domain logic: access codes, anonymous student sessions,
 * classroom records, and classroom-level usage accounting.
 *
 * Privacy invariant for this module: nothing derived from a student — no claim
 * text, no results, no identifiers, no IP addresses in the clear — is written
 * to the database. The only student-related state that exists anywhere is a
 * stateless signed token held in the student's own tab.
 */

const crypto = require('crypto');
const { rest, rpc } = require('./supabase-admin');

/* ── Access codes ─────────────────────────────────────────────────────── */

// Ambiguous glyphs (0/O, 1/I/L) are excluded so a code read off a projector or
// copied off a whiteboard cannot be mistyped into a different valid code.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 symbols
const CODE_LENGTH = 8;                                   // 31^8 ~= 8.5e11 ~= 39.6 bits

/**
 * Generates a classroom access code using a CSPRNG with rejection sampling, so
 * every symbol is uniformly distributed. Taking the raw byte modulo 31 would
 * bias the first few letters of the alphabet and shave real entropy off the
 * code, which is the one thing standing between a guesser and a classroom.
 */
function generateAccessCode() {
  const max = 256 - (256 % CODE_ALPHABET.length); // largest unbiased byte value
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH)) {
      if (byte >= max) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Canonical form for comparison: uppercase, no spaces or dashes. */
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Display form, dash-grouped so it is easier to read aloud and retype. */
function formatCode(code) {
  const c = normalizeCode(code);
  return c.length === CODE_LENGTH ? c.slice(0, 4) + '-' + c.slice(4) : c;
}

function isValidCodeShape(input) {
  const c = normalizeCode(input);
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

/* ── Anonymous student session tokens ─────────────────────────────────── */

// Sessions never outlive their classroom, and are additionally capped so a
// long-running classroom cannot mint an effectively permanent token.
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
}

/**
 * Mints a session token for an anonymous student.
 *
 * The payload carries only the classroom id, an expiry, and a random nonce.
 * There is no student identifier of any kind, nothing is written to the
 * database, and two students in the same classroom produce unlinkable tokens.
 * The nonce exists purely so tokens are distinct; it is never recorded
 * anywhere, so it cannot be used to correlate requests back to a person.
 */
function mintSessionToken(classroom) {
  const classroomEnd = Date.parse(classroom.expires_at);
  const expiresAt = Math.min(classroomEnd, Date.now() + SESSION_MAX_MS);

  const payload = b64u(JSON.stringify({
    c: classroom.id,
    e: expiresAt,
    n: crypto.randomBytes(9).toString('base64url'),
  }));
  return payload + '.' + sign(payload, classroom.session_secret);
}

/**
 * Decodes a session token WITHOUT verifying its signature, to learn which
 * classroom's secret to check it against. The result is untrusted until
 * verifySessionToken has confirmed the signature.
 */
function peekSessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!claims || typeof claims.c !== 'string' || typeof claims.e !== 'number') return null;
    return { payload: parts[0], sig: parts[1], claims };
  } catch {
    return null;
  }
}

/**
 * Verifies a token against its classroom's secret. Rotating that secret (see
 * regenerateAccess) invalidates every outstanding token for the classroom at
 * once, which is how expiry and manual deactivation cut off students who are
 * already inside rather than merely blocking new joins.
 */
function verifySessionToken(parsed, classroom) {
  if (!parsed || !classroom) return false;
  if (parsed.claims.c !== classroom.id) return false;
  if (!Number.isFinite(parsed.claims.e) || parsed.claims.e <= Date.now()) return false;

  const expected = sign(parsed.payload, classroom.session_secret);
  const a = Buffer.from(parsed.sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── Classroom state helpers ──────────────────────────────────────────── */

function isExpired(classroom) {
  return !classroom || Date.parse(classroom.expires_at) <= Date.now();
}

function remainingTokens(classroom) {
  return Math.max(0, Number(classroom.token_budget) - Number(classroom.tokens_used));
}

/** True when a classroom can currently accept student work. */
function isUsable(classroom) {
  return Boolean(classroom) && classroom.active && !isExpired(classroom) && remainingTokens(classroom) > 0;
}

/**
 * The classroom view a student is allowed to see. Deliberately excludes the
 * owner id, the access code, and the session secret.
 */
function publicView(classroom) {
  return {
    displayName: classroom.display_name || null,
    expiresAt: classroom.expires_at,
    budgetRemaining: remainingTokens(classroom),
    budgetTotal: Number(classroom.token_budget),
  };
}

/** The full view a classroom's owner may see. Never includes session_secret. */
function ownerView(classroom) {
  return {
    id: classroom.id,
    displayName: classroom.display_name || null,
    accessCode: formatCode(classroom.access_code),
    createdAt: classroom.created_at,
    expiresAt: classroom.expires_at,
    active: classroom.active,
    expired: isExpired(classroom),
    usable: isUsable(classroom),
    tokenBudget: Number(classroom.token_budget),
    tokensUsed: Number(classroom.tokens_used),
    tokensRemaining: remainingTokens(classroom),
    analysesRun: Number(classroom.analyses_run),
    searchesUsed: Number(classroom.searches_used),
  };
}

const COLUMNS = 'id,owner_id,display_name,access_code,session_secret,created_at,expires_at,active,token_budget,tokens_used,analyses_run,searches_used';

/* ── Data access ──────────────────────────────────────────────────────── */

async function findByCode(code) {
  const normalized = normalizeCode(code);
  if (!isValidCodeShape(normalized)) return null;
  const rows = await rest(
    'classrooms?access_code=eq.' + encodeURIComponent(normalized) + '&select=' + COLUMNS + '&limit=1'
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function findById(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const rows = await rest(
    'classrooms?id=eq.' + encodeURIComponent(id) + '&select=' + COLUMNS + '&limit=1'
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function listForOwner(ownerId) {
  const rows = await rest(
    'classrooms?owner_id=eq.' + encodeURIComponent(ownerId) +
    '&select=' + COLUMNS + '&order=created_at.desc&limit=200'
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Creates a classroom, retrying on the (astronomically unlikely) event that a
 * generated code collides with one already in use.
 */
async function createClassroom({ ownerId, displayName, expiresAt, tokenBudget }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = {
      owner_id: ownerId,
      display_name: displayName || null,
      access_code: generateAccessCode(),
      session_secret: crypto.randomBytes(32).toString('hex'),
      expires_at: new Date(expiresAt).toISOString(),
      token_budget: tokenBudget,
    };
    try {
      const created = await rest('classrooms', {
        method: 'POST',
        body: row,
        prefer: 'return=representation',
      });
      if (Array.isArray(created) && created.length) return created[0];
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  throw new Error('Could not allocate a unique classroom code.');
}

async function updateClassroom(id, patch) {
  const rows = await rest('classrooms?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation',
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function deleteClassroom(id) {
  await rest('classrooms?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
}

/**
 * Issues a fresh access code and session secret. This both revokes the old code
 * and removes every currently-joined student from the classroom, since their
 * tokens were signed with the previous secret.
 */
async function regenerateAccess(id) {
  return updateClassroom(id, {
    access_code: generateAccessCode(),
    session_secret: crypto.randomBytes(32).toString('hex'),
  });
}

/**
 * Adds usage to a classroom's running totals.
 *
 * Uses a Postgres function so the increment is a single atomic statement —
 * several students in one classroom routinely submit at the same moment, and a
 * read-modify-write from Node would lose debits under that concurrency and let
 * a class quietly overrun its budget.
 */
async function recordUsage(classroomId, { tokens, searches }) {
  const rows = await rpc('classroom_record_usage', {
    p_classroom_id: classroomId,
    p_tokens: Math.max(0, Math.round(tokens || 0)),
    p_searches: Math.max(0, Math.round(searches || 0)),
  });
  if (Array.isArray(rows) && rows.length) return rows[0];
  return rows || null;
}

module.exports = {
  CODE_LENGTH,
  CODE_ALPHABET,
  SESSION_MAX_MS,
  generateAccessCode,
  normalizeCode,
  formatCode,
  isValidCodeShape,
  mintSessionToken,
  peekSessionToken,
  verifySessionToken,
  isExpired,
  isUsable,
  remainingTokens,
  publicView,
  ownerView,
  findByCode,
  findById,
  listForOwner,
  createClassroom,
  updateClassroom,
  deleteClassroom,
  regenerateAccess,
  recordUsage,
};
