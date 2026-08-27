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
const limits = require('./limits');

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

/**
 * The token ceiling in force for a classroom.
 *
 * A stored value wins. NULL means the row predates migration 003, in which case
 * its old token_budget continues to gate it — the same fallback the database
 * function applies, restated here so the two cannot disagree. Only a row with
 * neither is unceilinged, and the API never creates one.
 */
function effectiveTokenSafetyLimit(classroom) {
  const stored = Number(classroom && classroom.token_safety_limit);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const legacy = Number(classroom && classroom.token_budget);
  if (Number.isFinite(legacy) && legacy > 0) return legacy;
  // Neither is usable. Fall back to the configured floor rather than to "no
  // ceiling" — an unceilinged classroom is the one outcome this must not have,
  // and migration 003 makes the column NOT NULL so this should be unreachable.
  return limits.minTokenSafetyLimit();
}

/** Tokens left before the safety ceiling. Always a finite number. */
function remainingTokens(classroom) {
  const cap = effectiveTokenSafetyLimit(classroom);
  return Math.max(0, cap - Number(classroom.tokens_used));
}

/** True when the classroom has consumed its internal token ceiling. */
function tokensExhausted(classroom) {
  return remainingTokens(classroom) <= 0;
}

/** ClaimChecks left in the classroom's allowance. Always a finite number. */
function remainingClaims(classroom) {
  const limit = effectiveClaimLimit(classroom);
  return Math.max(0, limit - (Number(classroom.claims_used) || 0));
}

/**
 * True when a classroom can currently accept student work.
 *
 * The ClaimCheck allowance is the ordinary reason a classroom stops; the token
 * ceiling is here so a runaway room also stops accepting joins, not because it
 * is expected to be reached.
 */
function isUsable(classroom) {
  return Boolean(classroom)
    && classroom.active
    && !isExpired(classroom)
    && remainingClaims(classroom) > 0
    && !tokensExhausted(classroom);
}

/**
 * The classroom view a student is allowed to see. Deliberately excludes the
 * owner id, the access code, and the session secret.
 *
 * Reports ClaimChecks, not tokens. A student cannot act on a token count, and
 * publishing one only invites them to interpret a number that no longer means
 * what their allowance is.
 */
function publicView(classroom) {
  return {
    // The classroom id is included so the browser can scope its anonymous
    // student id to this classroom and no other. It is not a secret from a
    // student — the session token they already hold names it — and RLS still
    // stops anyone reading the classroom row with it.
    id: classroom.id,
    displayName: classroom.display_name || null,
    expiresAt: classroom.expires_at,
    // Both are always real numbers: every classroom has a finite ClaimCheck
    // allowance, so the student's meter always has something to be a fraction of.
    claimsTotal: effectiveClaimLimit(classroom),
    claimsRemaining: remainingClaims(classroom),
  };
}

/** The full view a classroom's owner may see. Never includes session_secret. */
function ownerView(classroom) {
  const claimLimit = effectiveClaimLimit(classroom);
  const claimsUsed = Number(classroom.claims_used) || 0;
  const tokensRemaining = remainingTokens(classroom);

  return {
    id: classroom.id,
    displayName: classroom.display_name || null,
    accessCode: formatCode(classroom.access_code),
    createdAt: classroom.created_at,
    expiresAt: classroom.expires_at,
    active: classroom.active,
    expired: isExpired(classroom),
    usable: isUsable(classroom),

    /* The allowance, in the unit a teacher was promised it in. Every figure
     * here is a real number — there is no unlimited classroom to represent. */
    claimsUsed,
    claimsRemaining: remainingClaims(classroom),
    claimLimit: classroom.claim_limit === null || classroom.claim_limit === undefined
      ? null : Number(classroom.claim_limit),
    claimLimitPerStudent: classroom.claim_limit_per_student === null || classroom.claim_limit_per_student === undefined
      ? null : Number(classroom.claim_limit_per_student),
    expectedStudents: classroom.expected_students === null || classroom.expected_students === undefined
      ? null : Number(classroom.expected_students),
    effectiveClaimLimit: claimLimit,
    effectiveClaimLimitPerStudent: effectiveClaimLimitPerStudent(classroom),
    allowanceMode: allowanceMode(classroom),

    /* True when the classroom has already completed more ClaimChecks than its
     * allowance now permits — which happens when a teacher lowers the
     * allowance mid-session. It is not an error state and no usage was lost;
     * the class simply cannot start anything further. The dashboard needs to
     * say that, because "3 of 3 used" and "37 of 30 used" look alike at a
     * glance and mean different things. */
    overCapacity: claimsUsed > claimLimit,

    /* Internal cost accounting. Secondary on the dashboard, and never the thing
     * a classroom is expected to run out of. `analysesRun` is retained because
     * it is the post-hoc count the database has always kept, but it and
     * claimsUsed now mean the same thing — a reservation is released whenever
     * an analysis fails to complete — so the dashboard shows one of them. A
     * divergence between the two is a bug worth seeing, which is why both are
     * still reported here. */
    tokensUsed: Number(classroom.tokens_used),
    tokenSafetyLimit: effectiveTokenSafetyLimit(classroom),
    tokensRemaining,
    tokensExhausted: tokensExhausted(classroom),
    analysesRun: Number(classroom.analyses_run),
    searchesUsed: Number(classroom.searches_used),

    // The original token budget the classroom was created with. Retained for
    // rooms created before the allowance model changed; nothing gates on it.
    legacyTokenBudget: Number(classroom.token_budget) || null,
  };
}

/* ── Claim quotas ─────────────────────────────────────────────────────
 * Precedence, applied identically here and in claimcheck_reserve_claim:
 * an explicit per-classroom value wins, then a value derived from the expected
 * roster size, then the server's configured default.
 */

/* ── Allowance mode ───────────────────────────────────────────────────
 * There is no `allowance_mode` column, and deliberately so: `claim_limit`
 * already carries the distinction, and a second field describing the first is
 * a field that can disagree with it.
 *
 *   claim_limit IS NULL  ->  automatic. Sized from the roster, and re-sized
 *                            whenever the roster or the per-student allowance
 *                            changes.
 *   claim_limit IS SET   ->  custom. Exactly this many ClaimChecks for the
 *                            whole class, whatever the roster says.
 */
const ALLOWANCE_MODES = { AUTOMATIC: 'automatic', CUSTOM: 'custom' };

function allowanceMode(classroom) {
  const explicit = Number(classroom && classroom.claim_limit);
  return Number.isFinite(explicit) && explicit > 0 ? ALLOWANCE_MODES.CUSTOM : ALLOWANCE_MODES.AUTOMATIC;
}

/* A stored 0 is read as "not set", never as "no limit". 0 can no longer be
 * written — every route rejects it — but a row that predates that validation,
 * or one written by hand, must not turn into an unmetered classroom just by
 * being read. Mirrored by `nullif(…, 0)` in claimcheck_reserve_claim, so the
 * application and the database agree on what a 0 means. */

function effectiveClaimLimit(classroom) {
  const explicit = Number(classroom.claim_limit);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return limits.defaultClassroomClaimLimit(classroom);
}

function effectiveClaimLimitPerStudent(classroom) {
  const explicit = Number(classroom.claim_limit_per_student);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return limits.studentSessionLimit();
}

/** True when the classroom has run out of its total claim allowance. */
function claimsExhausted(classroom) {
  const limit = effectiveClaimLimit(classroom);
  return limit > 0 && (Number(classroom.claims_used) || 0) >= limit;
}

const COLUMNS = 'id,owner_id,display_name,access_code,session_secret,created_at,expires_at,active,token_budget,tokens_used,token_safety_limit,analyses_run,searches_used,claims_used,claim_limit,claim_limit_per_student,expected_students';

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
async function createClassroom({ ownerId, displayName, expiresAt, tokenBudget, tokenSafetyLimit, claimQuota = {} }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = {
      owner_id: ownerId,
      display_name: displayName || null,
      access_code: generateAccessCode(),
      session_secret: crypto.randomBytes(32).toString('hex'),
      expires_at: new Date(expiresAt).toISOString(),
      // token_budget is legacy and no longer gates anything; it is written
      // alongside the ceiling only so the column stays populated for a row
      // created after 003 and read by anything that predates it.
      token_budget: tokenBudget,
      token_safety_limit: tokenSafetyLimit,
      // Optional claim-quota overrides. Omitted keys leave the column NULL,
      // which is how a classroom says "use whatever the server is configured
      // for" rather than freezing today's default into the row.
      ...claimQuota,
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
 *
 * `countAnalysis` separates money from allowance. Tokens spent are always
 * recorded, because they were always spent; the completed-analysis counter only
 * moves when a student actually received a result. Pass false for a failure
 * that reached a paid provider before it broke.
 */
async function recordUsage(classroomId, { tokens, searches, countAnalysis = true }) {
  const rows = await rpc('classroom_record_usage', {
    p_classroom_id: classroomId,
    p_tokens: Math.max(0, Math.round(tokens || 0)),
    p_searches: Math.max(0, Math.round(searches || 0)),
    p_count_analysis: countAnalysis !== false,
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
  ALLOWANCE_MODES,
  allowanceMode,
  isExpired,
  isUsable,
  remainingTokens,
  remainingClaims,
  tokensExhausted,
  effectiveTokenSafetyLimit,
  effectiveClaimLimit,
  effectiveClaimLimitPerStudent,
  claimsExhausted,
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
