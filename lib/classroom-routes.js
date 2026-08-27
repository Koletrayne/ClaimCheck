'use strict';

/* Classroom Mode HTTP routes.
 *
 * Mounted under /api/classroom by server.js. Every route here is additive —
 * nothing in this file is reachable from the existing public ClaimCheck flow,
 * and the whole router disables itself when Classroom Mode is not configured.
 *
 * Two audiences, two authorization models:
 *
 *   Teachers  — authenticated with their existing ClaimCheck Supabase account,
 *               verified server-side, and additionally required to appear in
 *               the classroom_educators allowlist.
 *   Students  — anonymous. They present a short-lived signed session token that
 *               names a classroom and nothing else. No account, no profile, no
 *               database row.
 *
 * Logging rule for this file: never log claim text, analysis results, access
 * codes, or session tokens. Classroom ids, status codes, and token counts only.
 */

const express = require('express');
const crypto = require('crypto');

const { analyzeClaim, normalizeLanguage, totalTokens } = require('./analyze');
const { extractArticle, ExtractError } = require('./extract-article');
const { detectPii } = require('./pii');
const classroom = require('./classroom');
const limits = require('./limits');
const usage = require('./usage-guard');
const { isConfigured, rest, getUserFromToken, bearerToken } = require('./supabase-admin');

const router = express.Router();

/* ── Limits ───────────────────────────────────────────────────────────── */

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_DURATION_MS = 5 * 60 * 1000;            // 5 minutes
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;   // 2 hours
const MAX_CLASSROOMS_PER_OWNER = 50;
const MAX_NAME_LENGTH = 80;

/* Bounds for the per-classroom allowance a teacher can set.
 *
 * Sourced from lib/limits.js rather than restated here, so the range the API
 * enforces, the range the environment defaults are validated against, and the
 * range the create form advertises are one range. None of them includes 0:
 * every classroom must end up with a finite ClaimCheck allowance, and a limit
 * of 0 is read by every gate downstream as "no limit".
 */
const MIN_CLAIM_LIMIT = limits.DEFAULTS.MIN_CLASSROOM_CLAIM_LIMIT;

/* An explicitly chosen classroom total is capped at 150, wherever it comes
 * from — the create form, the edit panel, or a direct API call.
 *
 * MAX_CLASSROOM_CLAIM_LIMIT (100,000) remains the policy ceiling for a limit
 * the system DERIVES from a roster; 50 students x 4 is 200 ClaimChecks and is
 * a considered number. This is the ceiling for a number a person types, which
 * is a different thing and wants a much tighter bound.
 */
const MAX_CLAIM_LIMIT = limits.DEFAULTS.MAX_CUSTOM_CLAIM_LIMIT;
const MIN_CLAIM_LIMIT_PER_STUDENT = limits.DEFAULTS.MIN_CLAIMS_PER_STUDENT;
const MAX_CLAIM_LIMIT_PER_STUDENT = limits.DEFAULTS.MAX_CLAIMS_PER_STUDENT;
const MIN_EXPECTED_STUDENTS = limits.DEFAULTS.MIN_EXPECTED_STUDENTS;
const MAX_EXPECTED_STUDENTS = limits.DEFAULTS.MAX_EXPECTED_STUDENTS;

/* Bounds for the internal token ceiling.
 *
 * Not a teacher-facing control — it is derived from the ClaimCheck allowance on
 * every create, and only an explicitly supplied `tokenSafetyLimit` (an admin
 * escape hatch, absent from the UI) lands outside that derivation. The minimum
 * is the same floor lib/limits.js applies, so an override cannot produce a
 * ceiling the derivation would never have produced — and 0, which used to mean
 * "no ceiling at all", is no longer accepted from anywhere.
 */
const MIN_TOKEN_SAFETY_LIMIT = limits.DEFAULTS.MIN_TOKEN_SAFETY_PER_ANALYSIS;
const MAX_TOKEN_SAFETY_LIMIT = limits.DEFAULTS.MAX_TOKEN_SAFETY_LIMIT;

// Retained so a classroom row created after migration 003 still populates the
// legacy token_budget column with something plausible. Nothing gates on it.
const LEGACY_TOKEN_BUDGET = 100000;

// Failed access-code attempts allowed per client per window.
const JOIN_ATTEMPT_LIMIT = 12;
const JOIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/* ── Client identification for rate limiting ──────────────────────────── */

const IP_HASH_SECRET = process.env.CLASSROOM_IP_HASH_SECRET || '';

/**
 * Derives the client address used for throttling.
 *
 * Prefers the left-most X-Forwarded-For entry, which is correct when deployed
 * behind a proxy that overwrites the header (Vercel does). Direct-to-Node
 * deployments must sit behind such a proxy or the header is caller-controlled
 * and the throttle can be evaded.
 */
function clientAddress(req) {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Keyed hash of the client address. Raw IPs are never written to the database —
 * only this digest, which is enough to count attempts but is not a stored
 * network identifier for a student.
 */
function addressHash(req) {
  const key = IP_HASH_SECRET || 'classroom-fallback-key';
  return crypto.createHmac('sha256', key).update(clientAddress(req)).digest('hex').slice(0, 32);
}

/* ── Access-code guess throttling ─────────────────────────────────────── */

// In-memory first pass. On serverless each instance has its own memory, so this
// alone is not sufficient; it exists to reject repeat offenders without a
// database round trip. The durable count lives in classroom_code_attempts.
const recentAttempts = new Map();

function localAttemptCount(hash) {
  const now = Date.now();
  const hits = (recentAttempts.get(hash) || []).filter((t) => now - t < JOIN_ATTEMPT_WINDOW_MS);
  recentAttempts.set(hash, hits);
  if (recentAttempts.size > 5000) recentAttempts.clear(); // crude bound; counts are best-effort
  return hits.length;
}

async function recordFailedAttempt(hash) {
  recentAttempts.set(hash, [...(recentAttempts.get(hash) || []), Date.now()]);
  try {
    await rest('classroom_code_attempts', { method: 'POST', body: { ip_hash: hash } });
  } catch {
    // Throttling is best-effort; a logging failure must not block a legitimate join.
  }
}

async function isThrottled(hash) {
  if (localAttemptCount(hash) >= JOIN_ATTEMPT_LIMIT) return true;
  try {
    const since = new Date(Date.now() - JOIN_ATTEMPT_WINDOW_MS).toISOString();
    const rows = await rest(
      `classroom_code_attempts?ip_hash=eq.${encodeURIComponent(hash)}` +
      `&attempted_at=gte.${encodeURIComponent(since)}&select=id&limit=${JOIN_ATTEMPT_LIMIT}`
    );
    return Array.isArray(rows) && rows.length >= JOIN_ATTEMPT_LIMIT;
  } catch {
    return false;
  }
}

/* ── Middleware ───────────────────────────────────────────────────────── */

/** Rejects every classroom route when the feature is not configured. */
function requireConfigured(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Classroom Mode is not configured on this server.',
      code: 'NOT_CONFIGURED',
    });
  }
  next();
}

/**
 * Verifies the teacher's Supabase access token and their place on the educator
 * allowlist. Both checks happen server-side on every request — the browser's
 * claim to be an educator is never trusted.
 */
async function requireEducator(req, res, next) {
  const user = await getUserFromToken(bearerToken(req));
  if (!user) {
    return res.status(401).json({ error: 'Sign in to manage classrooms.', code: 'UNAUTHENTICATED' });
  }

  let allowed = false;
  try {
    const email = (user.email || '').toLowerCase();
    const filters = [`user_id.eq.${user.id}`];
    if (email) filters.push(`email.eq.${email}`);
    const rows = await rest(
      `classroom_educators?or=(${filters.join(',')})&select=id&limit=1`
    );
    allowed = Array.isArray(rows) && rows.length > 0;
  } catch {
    return res.status(502).json({ error: 'Could not verify classroom access.' });
  }

  if (!allowed) {
    return res.status(403).json({
      error: 'This account is not approved to create classrooms. Contact your administrator.',
      code: 'NOT_AN_EDUCATOR',
    });
  }

  req.educator = user;
  next();
}

/**
 * Resolves an anonymous student's session token to a live classroom.
 *
 * Every gate is re-checked here on every request rather than trusted from the
 * token: signature, expiry, active flag, and remaining budget. A classroom that
 * expires or is deactivated mid-lesson therefore cuts off students who are
 * already inside, not just new joins.
 */
async function requireClassroomSession(req, res, next) {
  const token = req.get('x-classroom-session') || (req.body && req.body.sessionToken) || '';
  const parsed = classroom.peekSessionToken(token);
  if (!parsed) {
    return res.status(401).json({ error: 'Your classroom session is not valid.', code: 'NO_SESSION' });
  }

  let room;
  try {
    room = await classroom.findById(parsed.claims.c);
  } catch {
    return res.status(502).json({ error: 'Could not verify your classroom session.' });
  }

  if (!room || !classroom.verifySessionToken(parsed, room)) {
    return res.status(401).json({ error: 'Your classroom session has ended.', code: 'SESSION_ENDED' });
  }
  if (!room.active) {
    return res.status(403).json({ error: 'This classroom has been closed by your teacher.', code: 'CLASSROOM_CLOSED' });
  }
  if (classroom.isExpired(room)) {
    return res.status(403).json({ error: 'This classroom session has expired.', code: 'CLASSROOM_EXPIRED' });
  }

  // Deliberately no allowance check here. Both the ClaimCheck allowance and the
  // token ceiling are evaluated atomically inside the reservation on the
  // analyze routes, which is the only place they can be evaluated correctly.
  // Repeating a non-atomic version of them here would add a second, weaker
  // source of truth — and would stop a class that has finished its ClaimChecks
  // from loading the page that tells them so.
  req.classroom = room;
  next();
}

/* ── Usage guardrails ─────────────────────────────────────────────────── */

/**
 * User-facing copy for each refusal.
 *
 * The student-level and classroom-level messages name the number the student
 * was measured against, because that is actionable — they can see how far they
 * got and who to ask. The account-level message names nothing: it says the
 * service is unavailable and stops, because API budgets, provider identities,
 * and account spending are not a student's business.
 *
 * The website re-renders these from its own translation dictionary using the
 * `code` field, so a Spanish-language student sees Spanish. This English copy
 * is the fallback for any client that does not (the extension, a direct API
 * call), which is why it is written to stand on its own.
 */
function limitMessage(reason, detail) {
  switch (reason) {
    case 'STUDENT_LIMIT':
      return `You've reached the ${detail.studentLimit}-claim limit for this classroom session. ` +
             'Ask your instructor if you need additional ClaimChecks.';
    case 'CLASSROOM_LIMIT':
      return detail.classroomLimit
        ? `This classroom has used all ${detail.classroomLimit} of its ClaimChecks. ` +
          'Please ask your instructor for assistance.'
        : 'This classroom has used all of its ClaimChecks. Please ask your instructor for assistance.';
    case 'TOKEN_SAFETY_LIMIT':
      // Says something true and different. The class has NOT run out of
      // ClaimChecks — telling them it had would send the teacher looking at the
      // wrong number and, worse, would make the allowance they were promised
      // look like a lie. This is an internal ceiling, so the student is told to
      // fetch the person who can act on it, and the diagnostic detail goes to
      // the log rather than the screen.
      return 'ClaimCheck has paused this classroom because it is using far more resources than expected. ' +
             'This is not your ClaimCheck allowance running out — please tell your instructor, ' +
             'who can check the classroom dashboard.';
    case 'USAGE_UNVERIFIED':
      // Nothing is known to be exhausted — the usage service could not be
      // reached. Says nothing about a database, and advises retrying because
      // this condition is expected to clear on its own.
      return 'ClaimCheck is temporarily unable to verify usage limits. Please try again shortly.';
    default:
      return 'ClaimCheck is temporarily unavailable because the usage limit has been reached. ' +
             'Please try again later or contact your instructor.';
  }
}

/**
 * Reads and validates the anonymous student id, then reserves one claim across
 * all three layers.
 *
 * Returns `{ ok: true, reservation, studentId }` when the request may proceed,
 * or `{ ok: false }` after having already sent the response.
 *
 * The id is required. A classroom request without one cannot be counted against
 * any student, so accepting it would be a per-student limit that any client
 * could opt out of by leaving a header off.
 */
async function reserveOrRefuse(req, res) {
  const studentId = usage.studentIdFromRequest(req);
  if (!studentId) {
    res.status(400).json({
      error: 'This classroom session is missing its anonymous ID. Refresh the page and try again.',
      code: 'NO_STUDENT_ID',
    });
    return { ok: false };
  }

  const reservation = await usage.reserveClaim({ classroom: req.classroom, studentId });

  if (!reservation.allowed) {
    const detail = {
      studentLimit: (reservation.student && reservation.student.limit) || limits.studentSessionLimit(),
      classroomLimit: (reservation.classroom && reservation.classroom.limit) || null,
    };
    res.status(reservation.status).json({
      error: limitMessage(reservation.reason, detail),
      code: reservation.reason,
      // Counts come from the database, never from the request. The student's
      // own figures and the whole-class ClaimCheck total are both already on
      // their screen, so repeating them here tells them nothing new — it just
      // lets the browser render the refusal in their own language.
      //
      // The token figures and the account totals are NOT included. Neither is
      // something a student can act on, and the ceiling in particular is an
      // operational number that belongs on the teacher's dashboard and in the
      // server log.
      _usage: (reservation.student || reservation.classroom)
        ? {
            ...(reservation.student ? { student: reservation.student } : {}),
            ...(reservation.classroom ? { classroom: reservation.classroom } : {}),
          }
        : null,
    });
    return { ok: false };
  }

  return { ok: true, reservation, studentId };
}

/* ── Validation helpers ───────────────────────────────────────────────── */

/**
 * Parses the admin-only token ceiling override.
 *
 * Absent means "derive it from the ClaimCheck allowance", which is what every
 * request from the dashboard does. A number here is an operator deliberately
 * overriding that derivation, and 0 removes the ceiling entirely — leaving the
 * ClaimCheck count as the only classroom gate, which is a supported
 * configuration but not a default one.
 */
function parseTokenSafetyLimit(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  // 0 used to mean "remove the ceiling". It is now rejected like any other
  // out-of-range value: a classroom with no token ceiling is a classroom that
  // can spend without bound, and no input may produce one.
  if (!Number.isFinite(n)) return 'invalid';
  const rounded = Math.round(n);
  if (rounded < MIN_TOKEN_SAFETY_LIMIT || rounded > MAX_TOKEN_SAFETY_LIMIT) return 'invalid';
  return rounded;
}

function parseExpiry(value) {
  if (value === undefined || value === null || value === '') {
    return new Date(Date.now() + DEFAULT_DURATION_MS);
  }
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  const delta = when.getTime() - Date.now();
  if (delta < MIN_DURATION_MS || delta > MAX_DURATION_MS) return null;
  return when;
}

function parseName(value) {
  if (value === undefined || value === null) return null;
  const name = String(value).trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

/**
 * Parses an optional whole-number quota override.
 *
 * Distinguishes three states, which is why it does not simply return a number:
 *   `undefined` — the field was not sent; leave whatever is stored alone.
 *   `null`      — the teacher cleared it; fall back to the server default.
 *   a number    — an explicit override.
 * Returns the string 'invalid' for anything out of range, so a caller can tell
 * a rejected value from a deliberately cleared one.
 *
 * `min` is 1 for every quota this parses, and that is the point. A blank field
 * is a request for the default and arrives as null; a literal 0 is a request
 * for an unlimited classroom and is refused. Those are different intentions and
 * they must not collapse into the same value — which is exactly what happened
 * when a blank field reached Number('') and became 0.
 *
 * Non-numeric strings, NaN, Infinity, booleans, arrays and objects all fail the
 * isFinite check, so a direct API call cannot smuggle one past this.
 */
function parseOptionalCount(value, { min, max }) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  // Number([]) is 0 and Number(true) is 1; neither is a count a client meant to
  // send, and both would otherwise pass silently.
  if (typeof value !== 'number' && typeof value !== 'string') return 'invalid';
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return 'invalid';
  // A fraction is refused rather than floored. These are counts of students and
  // of ClaimChecks, so 3.5 is not a value with a sensible reading — and
  // silently turning it into 3 gives back a classroom the teacher did not ask
  // for, with no indication that anything was changed.
  if (!Number.isInteger(n)) return 'invalid';
  return n;
}

/**
 * Reads the three optional claim-quota fields off a request body into a
 * database patch. Returns an error string instead when one is out of range.
 *
 * Shared by create and update so the two paths cannot drift into accepting
 * different values.
 */
function claimQuotaPatch(body) {
  const patch = {};

  const perStudent = parseOptionalCount(body.claimLimitPerStudent, {
    min: MIN_CLAIM_LIMIT_PER_STUDENT, max: MAX_CLAIM_LIMIT_PER_STUDENT,
  });
  if (perStudent === 'invalid') {
    return {
      error: `ClaimChecks per student must be a whole number between ` +
             `${MIN_CLAIM_LIMIT_PER_STUDENT} and ${MAX_CLAIM_LIMIT_PER_STUDENT}. ` +
             `Leave it blank to use the default of ${limits.studentSessionLimit()}.`,
    };
  }
  if (perStudent !== undefined) patch.claim_limit_per_student = perStudent;

  /* The allowance mode, and the total that goes with it.
   *
   * Two spellings are accepted for the same thing. `allowanceMode` +
   * `customClaimLimit` is what the edit panel sends and is the clearer one to
   * read; a bare `claimLimit` (a number, or null for "derive it") is what the
   * create form has always sent. Both land on the same column, and both are
   * bounded by the same 1–150, so there is no spelling that reaches a limit the
   * other cannot.
   */
  const modeResult = parseAllowanceMode(body);
  if (modeResult.error) return { error: modeResult.error };
  if (modeResult.claimLimit !== undefined) patch.claim_limit = modeResult.claimLimit;

  const expected = parseOptionalCount(body.expectedStudents, {
    min: MIN_EXPECTED_STUDENTS, max: MAX_EXPECTED_STUDENTS,
  });
  if (expected === 'invalid') {
    return {
      error: `Expected class size must be a whole number between ${MIN_EXPECTED_STUDENTS} and ` +
             `${MAX_EXPECTED_STUDENTS.toLocaleString()}. Leave it blank to use the default of ` +
             `${limits.defaultExpectedStudents()}.`,
    };
  }
  if (expected !== undefined) patch.expected_students = expected;

  return { patch };
}

/**
 * Resolves the allowance mode and the classroom total that follows from it.
 *
 * @returns {{error?: string, claimLimit?: number|null}} `claimLimit` is
 *   `undefined` when nothing about the allowance was sent (leave it alone),
 *   `null` for automatic (derive it from the roster), or a number 1–150.
 */
function parseAllowanceMode(body) {
  const { allowanceMode, customClaimLimit, claimLimit } = body;

  const capacityError =
    `A custom classroom allowance must be a whole number between ${MIN_CLAIM_LIMIT} and ` +
    `${MAX_CLAIM_LIMIT}. For a larger class, use the automatic allowance, which is sized ` +
    `from the roster and is not capped at ${MAX_CLAIM_LIMIT}.`;

  if (allowanceMode !== undefined) {
    // An unrecognised mode is refused rather than defaulting to anything.
    // "unlimited" is the specific string worth never quietly accepting, but the
    // rule is an allow-list precisely so no future spelling slips through.
    if (allowanceMode !== classroom.ALLOWANCE_MODES.AUTOMATIC
      && allowanceMode !== classroom.ALLOWANCE_MODES.CUSTOM) {
      return {
        error: 'Allowance mode must be "automatic" or "custom". ' +
               'There is no unlimited classroom setting.',
      };
    }

    if (allowanceMode === classroom.ALLOWANCE_MODES.AUTOMATIC) {
      // Clearing the stored total is what makes it derived again, and keeps it
      // following the roster from here on.
      return { claimLimit: null };
    }

    // Custom mode needs a number. Blank is a half-filled form, not a request
    // for the default — in this mode there is no default to fall back to.
    const custom = parseOptionalCount(customClaimLimit, { min: MIN_CLAIM_LIMIT, max: MAX_CLAIM_LIMIT });
    if (custom === 'invalid' || custom === null || custom === undefined) return { error: capacityError };
    return { claimLimit: custom };
  }

  // No mode given: fall back to the bare field the create form sends.
  const direct = parseOptionalCount(claimLimit, { min: MIN_CLAIM_LIMIT, max: MAX_CLAIM_LIMIT });
  if (direct === 'invalid') return { error: capacityError };
  return { claimLimit: direct };
}

/**
 * The ClaimCheck allowance a quota patch resolves to.
 *
 * A patch is already row-shaped, so this is the same precedence the stored row
 * and the database function apply — explicit limit, then class size × per
 * student, then the server default — rather than a fourth implementation of it.
 */
function resolveClaimLimit(patch) {
  return classroom.effectiveClaimLimit(patch || {});
}

/* ── Teacher routes ───────────────────────────────────────────────────── */

/** Lets the dashboard decide whether to show classroom controls. */
router.get('/me', requireConfigured, async (req, res) => {
  const user = await getUserFromToken(bearerToken(req));
  if (!user) return res.json({ signedIn: false, educator: false });

  try {
    const email = (user.email || '').toLowerCase();
    const filters = [`user_id.eq.${user.id}`];
    if (email) filters.push(`email.eq.${email}`);
    const rows = await rest(`classroom_educators?or=(${filters.join(',')})&select=id&limit=1`);
    return res.json({
      signedIn: true,
      educator: Array.isArray(rows) && rows.length > 0,
      // The defaults and bounds the create form should show. Published rather
      // than duplicated in the page, because the last time a number lived in two
      // places one of them drifted and a teacher was shown a capacity the server
      // did not agree with. The browser renders these; the server still
      // re-validates everything it is sent.
      limits: classroomFormLimits(),
    });
  } catch {
    return res.status(502).json({ error: 'Could not verify classroom access.' });
  }
});

/**
 * The numbers the create form needs to show a teacher the same capacity the
 * server will compute, and to reject an out-of-range value before sending it.
 */
function classroomFormLimits() {
  return {
    defaultExpectedStudents: limits.defaultExpectedStudents(),
    defaultClaimsPerStudent: limits.studentSessionLimit(),
    minExpectedStudents: MIN_EXPECTED_STUDENTS,
    maxExpectedStudents: MAX_EXPECTED_STUDENTS,
    minClaimsPerStudent: MIN_CLAIM_LIMIT_PER_STUDENT,
    maxClaimsPerStudent: MAX_CLAIM_LIMIT_PER_STUDENT,
    minClaimLimit: MIN_CLAIM_LIMIT,
    maxClaimLimit: MAX_CLAIM_LIMIT,
    headroomPercent: limits.classroomHeadroomPercent(),
  };
}

router.get('/rooms', requireConfigured, requireEducator, async (req, res) => {
  try {
    const rooms = await classroom.listForOwner(req.educator.id);
    res.json({ classrooms: rooms.map(classroom.ownerView) });
  } catch (err) {
    console.error('[classroom] list failed:', err.message);
    res.status(502).json({ error: 'Could not load your classrooms.' });
  }
});

router.post('/rooms', requireConfigured, requireEducator, async (req, res) => {
  const { displayName, expiresAt, tokenSafetyLimit } = req.body || {};

  const ceilingOverride = parseTokenSafetyLimit(tokenSafetyLimit);
  if (ceilingOverride === 'invalid') {
    return res.status(400).json({
      error: `A token safety limit must be between ${MIN_TOKEN_SAFETY_LIMIT.toLocaleString()} ` +
             `and ${MAX_TOKEN_SAFETY_LIMIT.toLocaleString()}. It cannot be removed.`,
    });
  }

  const expiry = parseExpiry(expiresAt);
  if (expiry === null) {
    return res.status(400).json({
      error: 'Choose an end time between 5 minutes and 30 days from now.',
    });
  }

  try {
    const existing = await classroom.listForOwner(req.educator.id);
    const live = existing.filter((r) => r.active && !classroom.isExpired(r));
    if (live.length >= MAX_CLASSROOMS_PER_OWNER) {
      return res.status(429).json({
        error: `You already have ${MAX_CLASSROOMS_PER_OWNER} active classrooms. Close one before creating another.`,
      });
    }

    const quota = claimQuotaPatch(req.body || {});
    if (quota.error) return res.status(400).json({ error: quota.error });

    // The allowance the classroom will actually enforce, resolved here so the
    // token ceiling can be sized from it. A teacher who picked a capacity gets
    // that number; one who only gave a roster gets class size × per student;
    // one who gave neither gets the server default.
    const capacity = resolveClaimLimit(quota.patch);
    const ceiling = ceilingOverride !== undefined
      ? ceilingOverride
      : limits.tokenSafetyLimitFor(capacity);

    // The last gate before a row is written. Every path above is supposed to
    // guarantee both of these are finite and positive, and this asserts it
    // rather than trusting it — a classroom that reached the database without a
    // real allowance would be an unmetered classroom, and no combination of
    // request body, stored state, and environment variables may produce one.
    if (!Number.isFinite(capacity) || capacity < MIN_CLAIM_LIMIT
        || !Number.isFinite(ceiling) || ceiling < MIN_TOKEN_SAFETY_LIMIT) {
      console.error(
        `[classroom] refusing to create an unbounded classroom for ${req.educator.id}: ` +
        `capacity=${capacity} ceiling=${ceiling}`
      );
      return res.status(400).json({
        error: 'Those settings do not produce a usable classroom allowance. ' +
               'Check the class size and ClaimChecks per student, or leave them blank.',
      });
    }

    const created = await classroom.createClassroom({
      ownerId: req.educator.id,
      displayName: parseName(displayName),
      expiresAt: expiry,
      tokenBudget: LEGACY_TOKEN_BUDGET,
      tokenSafetyLimit: ceiling,
      claimQuota: quota.patch,
    });
    console.log(
      `[classroom] created ${created.id} claimChecks=${capacity} ` +
      `tokenCeiling=${ceiling} perStudent=${classroom.effectiveClaimLimitPerStudent(created)}`
    );
    res.status(201).json({ classroom: classroom.ownerView(created) });
  } catch (err) {
    console.error('[classroom] create failed:', err.message);
    res.status(502).json({ error: 'Could not create the classroom. Please try again.' });
  }
});

/**
 * Loads a classroom and confirms the caller owns it. Ownership is checked
 * against the verified token's user id, never against anything the client sent.
 */
async function loadOwnedClassroom(req, res) {
  const room = await classroom.findById(req.params.id);
  if (!room || room.owner_id !== req.educator.id) {
    // Same response whether the classroom is missing or belongs to someone
    // else, so this cannot be used to probe for valid classroom ids.
    res.status(404).json({ error: 'Classroom not found.' });
    return null;
  }
  return room;
}

router.patch('/rooms/:id', requireConfigured, requireEducator, async (req, res) => {
  try {
    const room = await loadOwnedClassroom(req, res);
    if (!room) return;

    /* An expired classroom cannot be edited.
     *
     * Without this, extending `expires_at` on a finished session silently
     * reopens it — students whose tokens were minted before it ended would find
     * it working again, and a room a teacher believes is closed would be
     * accepting work. Reopening may be worth supporting one day, but it should
     * be a deliberate control that says so, not a side effect of the edit form.
     * Closing and deleting stay available: neither reopens anything.
     */
    if (classroom.isExpired(room)) {
      return res.status(403).json({
        error: 'This classroom has ended and can no longer be edited. Create a new one for the next session.',
        code: 'CLASSROOM_EXPIRED',
      });
    }

    const patch = {};
    const { displayName, active, expiresAt, tokenSafetyLimit } = req.body || {};

    if (displayName !== undefined) patch.display_name = parseName(displayName);
    if (active !== undefined) patch.active = Boolean(active);

    if (expiresAt !== undefined) {
      const expiry = parseExpiry(expiresAt);
      if (expiry === null) {
        return res.status(400).json({ error: 'Choose an end time between 5 minutes and 30 days from now.' });
      }
      patch.expires_at = expiry.toISOString();
    }

    const ceilingOverride = parseTokenSafetyLimit(tokenSafetyLimit);
    if (ceilingOverride === 'invalid') {
      return res.status(400).json({
        error: `A token safety limit must be between ${MIN_TOKEN_SAFETY_LIMIT.toLocaleString()} ` +
               `and ${MAX_TOKEN_SAFETY_LIMIT.toLocaleString()}. It cannot be removed.`,
      });
    }

    const quota = claimQuotaPatch(req.body || {});
    if (quota.error) return res.status(400).json({ error: quota.error });
    Object.assign(patch, quota.patch);

    if (Object.keys(quota.patch).length) {
      const nextLimit = resolveClaimLimit({ ...room, ...quota.patch });

      if (!Number.isFinite(nextLimit) || nextLimit < MIN_CLAIM_LIMIT) {
        return res.status(400).json({
          error: 'Those settings do not produce a usable classroom allowance.',
        });
      }

      /* A new allowance BELOW what the class has already used is allowed.
       *
       * This used to be refused, which was the wrong instinct: a teacher who
       * needs to stop a class cannot be told the numbers forbid it. The work
       * already done is history and stays exactly as recorded — `claims_used`
       * is never touched — and the classroom simply has nothing left. Every
       * gate downstream already reads that correctly: `remainingClaims` floors
       * at 0, `isUsable` goes false, and the reservation refuses with
       * CLASSROOM_LIMIT. Nothing goes negative anywhere.
       *
       * The dashboard says so in words (see `overCapacity`), because "37 of 30
       * used" is a sentence a teacher should not have to decode.
       */
    }

    // Re-size the ceiling whenever the allowance it was derived from changes,
    // unless the caller supplied one. Leaving a stale ceiling behind is how a
    // classroom raised from 15 ClaimChecks to 150 would stop at 15 again —
    // for a reason nothing on the dashboard would explain.
    if (ceilingOverride !== undefined) {
      patch.token_safety_limit = ceilingOverride;
    } else if (Object.keys(quota.patch).length) {
      patch.token_safety_limit = limits.tokenSafetyLimitFor(resolveClaimLimit({ ...room, ...quota.patch }));
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    // Deactivating rotates the signing secret so students already inside are
    // removed immediately, rather than merely being unable to rejoin.
    if (patch.active === false) {
      patch.session_secret = crypto.randomBytes(32).toString('hex');
    }

    const updated = await classroom.updateClassroom(room.id, patch);
    logClassroomEdit(room, updated, Object.keys(patch));
    res.json({ classroom: classroom.ownerView(updated) });
  } catch (err) {
    console.error('[classroom] update failed:', err.message);
    res.status(502).json({ error: 'Could not update the classroom.' });
  }
});

/**
 * Records a live administrative change to a running classroom.
 *
 * A teacher changing a limit while students are working is exactly the kind of
 * event that has to be explainable afterwards — "the class stopped and nobody
 * knows why" is otherwise unanswerable. Before and after are both recorded, so
 * the line stands on its own without needing a previous one to compare against.
 *
 * Privacy: classroom id, numbers, and timestamps. No student id, no claim text,
 * no access code, no session secret. Same rule as every other log in this file.
 */
function logClassroomEdit(before, after, fields) {
  const view = (row) => ({
    mode: classroom.allowanceMode(row),
    claimLimit: classroom.effectiveClaimLimit(row),
    perStudent: classroom.effectiveClaimLimitPerStudent(row),
    expectedStudents: row.expected_students === null || row.expected_students === undefined
      ? null : Number(row.expected_students),
    tokenSafetyLimit: classroom.effectiveTokenSafetyLimit(row),
    expiresAt: row.expires_at,
    active: row.active,
  });

  const from = view(before);
  const to = view(after);
  const claimsUsed = Number(after.claims_used) || 0;

  console.log('[classroom:audit] ' + JSON.stringify({
    event: 'classroom_updated',
    classroomId: after.id,
    fields,
    from,
    to,
    // Carried so the line explains its own consequences: an allowance now below
    // what has been used is the case most likely to be investigated later.
    claimsUsed,
    overCapacity: claimsUsed > to.claimLimit,
    tokensUsed: Number(after.tokens_used) || 0,
    at: new Date().toISOString(),
  }));
}

router.post('/rooms/:id/regenerate', requireConfigured, requireEducator, async (req, res) => {
  try {
    const room = await loadOwnedClassroom(req, res);
    if (!room) return;
    const updated = await classroom.regenerateAccess(room.id);
    console.log(`[classroom] regenerated access for ${room.id}`);
    res.json({ classroom: classroom.ownerView(updated) });
  } catch (err) {
    console.error('[classroom] regenerate failed:', err.message);
    res.status(502).json({ error: 'Could not issue a new code.' });
  }
});

router.delete('/rooms/:id', requireConfigured, requireEducator, async (req, res) => {
  try {
    const room = await loadOwnedClassroom(req, res);
    if (!room) return;
    await classroom.deleteClassroom(room.id);
    console.log(`[classroom] deleted ${room.id}`);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[classroom] delete failed:', err.message);
    res.status(502).json({ error: 'Could not delete the classroom.' });
  }
});

/* ── Student routes ───────────────────────────────────────────────────── */

router.post('/join', requireConfigured, async (req, res) => {
  const hash = addressHash(req);

  if (await isThrottled(hash)) {
    return res.status(429).json({
      error: 'Too many incorrect codes. Wait a few minutes and try again.',
      code: 'TOO_MANY_ATTEMPTS',
    });
  }

  const code = (req.body && req.body.code) || '';

  // Reject malformed codes before touching the database, so guesses that could
  // never be valid cost nothing to refuse.
  if (!classroom.isValidCodeShape(code)) {
    await recordFailedAttempt(hash);
    return res.status(400).json({ error: 'That classroom code is not valid.', code: 'BAD_CODE' });
  }

  let room;
  try {
    room = await classroom.findByCode(code);
  } catch (err) {
    console.error('[classroom] join lookup failed:', err.message);
    return res.status(502).json({ error: 'Could not check that code. Please try again.' });
  }

  // One message for every unusable state. Distinguishing "no such classroom"
  // from "expired classroom" would confirm which codes exist.
  if (!classroom.isUsable(room)) {
    await recordFailedAttempt(hash);
    return res.status(404).json({
      error: 'That classroom code is not active. Check the code with your teacher.',
      code: 'NOT_ACTIVE',
    });
  }

  const token = classroom.mintSessionToken(room);
  console.log(`[classroom] join ok ${room.id}`);
  res.json({ sessionToken: token, classroom: classroom.publicView(room) });
});

/**
 * Lets a returning tab confirm its stored session is still good, and tells the
 * student how many ClaimChecks they have left.
 *
 * The student id arrives in a header and is used only as a lookup key. The
 * counts returned are read from the database — a client that sends a made-up
 * id sees a fresh row with zero used, and still cannot exceed its allowance,
 * because the reservation on the analyze route is what actually enforces it.
 */
router.get('/session', requireConfigured, requireClassroomSession, async (req, res) => {
  const studentId = usage.studentIdFromRequest(req);
  let claims = null;
  try {
    claims = await usage.readUsage({ classroom: req.classroom, studentId });
  } catch (err) {
    // The meter is informational. Failing to render it must not end a lesson.
    console.error(`[classroom] usage lookup failed for ${req.classroom.id}:`, err.message);
  }
  res.json({
    classroom: classroom.publicView(req.classroom),
    // Only the student's own figures are published. The classroom's claim total
    // is deliberately not sent to students: they already have a class allowance
    // meter, and a second countdown they cannot influence just invites racing.
    claims: claims && claims.student ? { student: claims.student } : null,
  });
});

/**
 * Records what an attempt cost a classroom, and reports its remaining
 * ClaimChecks.
 *
 * Two different things are being counted here and they must not be conflated.
 *
 *   Tokens are money. They are recorded for every attempt that reached a paid
 *   provider, whether or not it produced a result, and they accumulate against
 *   the classroom's internal safety ceiling.
 *
 *   ClaimChecks are the allowance. One is consumed only when a student
 *   receives a completed analysis. `countAnalysis: false` records the cost of a
 *   failure without moving that counter; the caller separately releases the
 *   reservation that was held for it.
 *
 * Token recording runs after the analysis rather than before, because the cost
 * is not knowable in advance. A single request can therefore push a classroom
 * slightly past its ceiling; the next one is refused. That trade is safe now
 * that the ceiling is a guardrail with 3x headroom rather than the allowance
 * itself.
 *
 * @returns {{remaining: number|null, limit: number, tokensUsed: number}}
 */
async function chargeClassroom(room, usageRecord, { countAnalysis = true } = {}) {
  const tokens = totalTokens(usageRecord);
  const searches = (usageRecord && usageRecord.web_search_requests) || 0;

  let after = null;
  try {
    after = await classroom.recordUsage(room.id, { tokens, searches, countAnalysis });
  } catch (err) {
    // The student already has their answer; losing the debit is preferable to
    // failing the request, but it must be visible in the logs.
    console.error(`[classroom] usage recording failed for ${room.id}:`, err.message);
  }

  const claimsUsed = after && after.claims_used !== undefined
    ? Number(after.claims_used)
    : (Number(room.claims_used) || 0) + (countAnalysis ? 1 : 0);
  const limit = classroom.effectiveClaimLimit(room);
  const tokensUsed = after ? Number(after.tokens_used) : Number(room.tokens_used) + tokens;

  logAnalysisCost(room, {
    usage: usageRecord,
    tokens,
    searches,
    countAnalysis,
    claimsUsed,
    limit,
    tokensUsed,
    tokenCeiling: after
      ? classroom.effectiveTokenSafetyLimit({ ...room, ...after })
      : classroom.effectiveTokenSafetyLimit(room),
  });

  return {
    remaining: limit > 0 ? Math.max(0, limit - claimsUsed) : null,
    limit: limit > 0 ? limit : null,
    tokensUsed,
  };
}

/* ── Development diagnostics ──────────────────────────────────────────
 * On by default outside production, and switchable anywhere with
 * CLAIMCHECK_TOKEN_DIAGNOSTICS. This is what makes a question like "why did two
 * analyses cost 53,856 tokens?" answerable from a log rather than from a
 * measurement run.
 *
 * Privacy: numbers, a classroom id, and a model name. No claim text, no result,
 * no student id — the anonymous id is deliberately kept out of log storage
 * even though it identifies nobody, because a stable per-student handle in a
 * log is a correlation key waiting to be used.
 */
function diagnosticsEnabled() {
  const raw = String(process.env.CLAIMCHECK_TOKEN_DIAGNOSTICS || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return !usage.isProductionLike();
}

function logAnalysisCost(room, info) {
  // The one-line summary is always emitted: it is the record that explains a
  // classroom's token total, and losing it in production is how the original
  // estimate went eight times wrong without anyone noticing.
  console.log(
    `[classroom] ${info.countAnalysis ? 'analysis' : 'FAILED analysis'} ${room.id} ` +
    `claimChecks=${info.claimsUsed}${info.limit > 0 ? '/' + info.limit : ''} ` +
    `tokens=${info.tokens} searches=${info.searches} ` +
    `classTokens=${info.tokensUsed}${info.tokenCeiling > 0 ? '/' + info.tokenCeiling : ''}`
  );

  if (!diagnosticsEnabled()) return;

  const u = info.usage || {};
  console.log('[classroom:diag] ' + JSON.stringify({
    classroomId: room.id,
    claimCheckNumber: info.claimsUsed,
    completed: info.countAnalysis,
    apiCalls: u.api_calls || 0,
    searchCalls: info.searches,
    tokens: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
      totalCharged: info.tokens,
    },
    classroomTotals: {
      tokens: info.tokensUsed,
      ceiling: info.tokenCeiling || null,
      tokensPerClaimCheck: info.claimsUsed > 0 ? Math.round(info.tokensUsed / info.claimsUsed) : null,
    },
  }));
}

/**
 * Settles a failed attempt: the student gets no ClaimCheck, the classroom still
 * gets the bill.
 *
 * Called from one place per route so the two halves cannot drift apart — the
 * failure mode worth avoiding is releasing the reservation and forgetting the
 * tokens, which would let a classroom fail expensively forever with its
 * allowance untouched.
 */
async function settleFailure(req, gate, err) {
  await usage.releaseClaim(gate.reservation, { classroom: req.classroom, studentId: gate.studentId });

  // err.usage is attached by lib/analyze.js and carries what the attempt
  // actually spent. Its absence means the failure happened before any provider
  // call — nothing to record.
  if (err && err.usage && usage.wasBillable(err)) {
    await chargeClassroom(req.classroom, err.usage, { countAnalysis: false });
  }
}

/**
 * Strips the internal usage record before the result reaches the browser.
 * Students have no use for it, and the classroom's remaining balance is
 * reported separately.
 */
function forStudent(result) {
  const { _usage, ...rest } = result;
  return rest;
}

router.post('/analyze', requireConfigured, requireClassroomSession, async (req, res) => {
  const { text, academicMode, snapshot, contextLens, language } = req.body || {};

  if (typeof text !== 'string' || text.trim().length < 8) {
    return res.status(400).json({ error: 'Provide at least 8 characters of text to analyze.' });
  }

  // Length is checked before anything is reserved, so a claim that is too long
  // is refused for free — the student can trim it and try again without having
  // spent one of their ClaimChecks on a validation error.
  const maxChars = limits.maxClaimCharacters();
  if (maxChars > 0 && text.length > maxChars) {
    return res.status(413).json({
      error: `Claims can be up to ${maxChars.toLocaleString()} characters. ` +
             'Try narrowing this down to the specific statement you want to verify.',
      code: 'CLAIM_TOO_LONG',
      maxClaimCharacters: maxChars,
      claimCharacters: text.length,
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'This server is not configured to run analyses.' });
  }

  // Advisory only — the analysis proceeds either way. See lib/pii.js for why
  // this warns rather than blocks.
  const pii = detectPii(text);

  // Last gate before the paid pipeline: student, classroom, and account budgets
  // checked and reserved in one atomic step.
  const gate = await reserveOrRefuse(req, res);
  if (!gate.ok) return;

  try {
    const result = await analyzeClaim({
      text,
      academicMode: Boolean(academicMode),
      snapshot: Boolean(snapshot),
      includeContextLens: contextLens !== false,
      language: normalizeLanguage(language),
    });
    const charged = await chargeClassroom(req.classroom, result._usage);
    res.json({
      ...forStudent(result),
      _classroom: {
        claimsRemaining: charged.remaining,
        claimsTotal: charged.limit,
        piiWarning: pii.found ? pii.types : null,
        claims: gate.reservation.student,
      },
    });
  } catch (err) {
    await settleFailure(req, gate, err);
    // Deliberately logs the classroom and the failure, never the claim.
    console.error(`[classroom] analyze failed for ${req.classroom.id}:`, err.message);
    res.status(502).json({ error: 'The analysis could not be completed. Please try again.' });
  }
});

const EXTRACT_STATUS = {
  INVALID_URL: 400,
  BLOCKED_URL: 400,
  NO_CONTENT: 422,
  UNREADABLE: 422,
  NETWORK_ERROR: 502,
};

router.post('/analyze-url', requireConfigured, requireClassroomSession, async (req, res) => {
  const { url, academicMode, snapshot, contextLens, language } = req.body || {};

  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Provide a URL to analyze.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'This server is not configured to run analyses.' });
  }

  let article;
  try {
    article = await extractArticle(url.trim());
  } catch (err) {
    if (err instanceof ExtractError) {
      return res.status(EXTRACT_STATUS[err.code] || 502).json({
        error: 'We could not read that page. Try pasting the claim text instead.',
        code: err.code,
      });
    }
    console.error(`[classroom] extraction failed for ${req.classroom.id}:`, err.message);
    return res.status(502).json({ error: 'We could not read that page. Please try again.' });
  }

  // Reserved after a successful read, for the same reason as the public route:
  // a page we could not fetch cost nothing, so it must not cost a ClaimCheck.
  const gate = await reserveOrRefuse(req, res);
  if (!gate.ok) return;

  try {
    const result = await analyzeClaim({
      text: article.text,
      sourceUrl: article.url,
      academicMode: Boolean(academicMode),
      includeSecondaryClaims: true,
      snapshot: Boolean(snapshot),
      includeContextLens: contextLens !== false,
      language: normalizeLanguage(language),
    });
    result._article = {
      title: article.title,
      byline: article.byline,
      url: article.url,
      excerpt: article.excerpt,
    };
    const charged = await chargeClassroom(req.classroom, result._usage);
    res.json({
      ...forStudent(result),
      _classroom: {
        claimsRemaining: charged.remaining,
        claimsTotal: charged.limit,
        piiWarning: null,
        claims: gate.reservation.student,
      },
    });
  } catch (err) {
    await settleFailure(req, gate, err);
    console.error(`[classroom] analyze-url failed for ${req.classroom.id}:`, err.message);
    res.status(502).json({ error: 'The analysis could not be completed. Please try again.' });
  }
});

module.exports = {
  router,
  limits: {
    MIN_TOKEN_SAFETY_LIMIT, MAX_TOKEN_SAFETY_LIMIT, MAX_DURATION_MS, MAX_CLASSROOMS_PER_OWNER,
    MIN_CLAIM_LIMIT, MAX_CLAIM_LIMIT,
    MIN_CLAIM_LIMIT_PER_STUDENT, MAX_CLAIM_LIMIT_PER_STUDENT,
    MIN_EXPECTED_STUDENTS, MAX_EXPECTED_STUDENTS,
  },
  // Exported for tests.
  _internal: {
    parseTokenSafetyLimit, parseExpiry, parseName, addressHash, clientAddress,
    parseOptionalCount, claimQuotaPatch, resolveClaimLimit, limitMessage,
    diagnosticsEnabled, classroomFormLimits,
  },
};
