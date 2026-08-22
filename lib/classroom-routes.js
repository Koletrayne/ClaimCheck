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

const MIN_BUDGET = 1000;
const MAX_BUDGET = 2000000;
const DEFAULT_BUDGET = 100000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_DURATION_MS = 5 * 60 * 1000;            // 5 minutes
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;   // 2 hours
const MAX_CLASSROOMS_PER_OWNER = 50;
const MAX_NAME_LENGTH = 80;

// Bounds for the optional per-classroom quota overrides a teacher can set.
const MAX_CLAIM_LIMIT = 100000;
const MAX_CLAIM_LIMIT_PER_STUDENT = 1000;
const MAX_EXPECTED_STUDENTS = 1000;

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
  if (classroom.remainingTokens(room) <= 0) {
    return res.status(429).json({
      error: 'This classroom has used up its allowance. Let your teacher know.',
      code: 'BUDGET_EXHAUSTED',
    });
  }

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
      return 'This classroom has reached its ClaimCheck usage limit. Please ask your instructor for assistance.';
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
    };
    res.status(reservation.status).json({
      error: limitMessage(reservation.reason, detail),
      code: reservation.reason,
      // Counts come from the database, never from the request. The student-level
      // figures are safe to show; the classroom and account totals are not
      // itemised beyond what the student already sees on their own meter.
      _usage: reservation.student
        ? { student: reservation.student }
        : null,
    });
    return { ok: false };
  }

  return { ok: true, reservation, studentId };
}

/* ── Validation helpers ───────────────────────────────────────────────── */

function parseBudget(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_BUDGET;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_BUDGET || rounded > MAX_BUDGET) return null;
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
 */
function parseOptionalCount(value, max) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return 'invalid';
  return Math.floor(n);
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

  const perStudent = parseOptionalCount(body.claimLimitPerStudent, MAX_CLAIM_LIMIT_PER_STUDENT);
  if (perStudent === 'invalid') {
    return { error: `Choose a per-student claim limit between 0 and ${MAX_CLAIM_LIMIT_PER_STUDENT}, or leave it blank for the default.` };
  }
  if (perStudent !== undefined) patch.claim_limit_per_student = perStudent;

  const classLimit = parseOptionalCount(body.claimLimit, MAX_CLAIM_LIMIT);
  if (classLimit === 'invalid') {
    return { error: `Choose a classroom claim limit between 0 and ${MAX_CLAIM_LIMIT.toLocaleString()}, or leave it blank for the default.` };
  }
  if (classLimit !== undefined) patch.claim_limit = classLimit;

  const expected = parseOptionalCount(body.expectedStudents, MAX_EXPECTED_STUDENTS);
  if (expected === 'invalid') {
    return { error: `Choose an expected class size between 0 and ${MAX_EXPECTED_STUDENTS}, or leave it blank.` };
  }
  if (expected !== undefined) patch.expected_students = expected;

  return { patch };
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
    return res.json({ signedIn: true, educator: Array.isArray(rows) && rows.length > 0 });
  } catch {
    return res.status(502).json({ error: 'Could not verify classroom access.' });
  }
});

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
  const { displayName, expiresAt, tokenBudget } = req.body || {};

  const budget = parseBudget(tokenBudget);
  if (budget === null) {
    return res.status(400).json({
      error: `Choose a usage allowance between ${MIN_BUDGET.toLocaleString()} and ${MAX_BUDGET.toLocaleString()} tokens.`,
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

    const created = await classroom.createClassroom({
      ownerId: req.educator.id,
      displayName: parseName(displayName),
      expiresAt: expiry,
      tokenBudget: budget,
      claimQuota: quota.patch,
    });
    console.log(`[classroom] created ${created.id} budget=${budget}`);
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

    const patch = {};
    const { displayName, active, expiresAt, tokenBudget } = req.body || {};

    if (displayName !== undefined) patch.display_name = parseName(displayName);
    if (active !== undefined) patch.active = Boolean(active);

    if (expiresAt !== undefined) {
      const expiry = parseExpiry(expiresAt);
      if (expiry === null) {
        return res.status(400).json({ error: 'Choose an end time between 5 minutes and 30 days from now.' });
      }
      patch.expires_at = expiry.toISOString();
    }

    if (tokenBudget !== undefined) {
      const budget = parseBudget(tokenBudget);
      if (budget === null) {
        return res.status(400).json({
          error: `Choose a usage allowance between ${MIN_BUDGET.toLocaleString()} and ${MAX_BUDGET.toLocaleString()} tokens.`,
        });
      }
      if (budget < Number(room.tokens_used)) {
        return res.status(400).json({
          error: 'The new allowance is below what this classroom has already used.',
        });
      }
      patch.token_budget = budget;
    }

    const quota = claimQuotaPatch(req.body || {});
    if (quota.error) return res.status(400).json({ error: quota.error });
    Object.assign(patch, quota.patch);

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    // Deactivating rotates the signing secret so students already inside are
    // removed immediately, rather than merely being unable to rejoin.
    if (patch.active === false) {
      patch.session_secret = crypto.randomBytes(32).toString('hex');
    }

    const updated = await classroom.updateClassroom(room.id, patch);
    console.log(`[classroom] updated ${room.id} fields=${Object.keys(patch).join(',')}`);
    res.json({ classroom: classroom.ownerView(updated) });
  } catch (err) {
    console.error('[classroom] update failed:', err.message);
    res.status(502).json({ error: 'Could not update the classroom.' });
  }
});

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
 * Debits a classroom for one analysis and reports what is left.
 *
 * Runs after the analysis rather than before, because the cost is not knowable
 * in advance. A single request can therefore push a classroom slightly past its
 * budget; the next request is refused. This is a deliberate trade — the
 * alternative is refusing work that might have fitted.
 */
async function chargeClassroom(room, result) {
  const usage = (result && result._usage) || null;
  const tokens = totalTokens(usage);
  const searches = (usage && usage.web_search_requests) || 0;

  try {
    const after = await classroom.recordUsage(room.id, { tokens, searches });
    console.log(`[classroom] analysis ${room.id} tokens=${tokens} searches=${searches}`);
    if (after) {
      return Math.max(0, Number(after.token_budget) - Number(after.tokens_used));
    }
  } catch (err) {
    // The student already has their answer; losing the debit is preferable to
    // failing the request, but it must be visible in the logs.
    console.error(`[classroom] usage recording failed for ${room.id}:`, err.message);
  }
  return Math.max(0, classroom.remainingTokens(room) - tokens);
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
    const remaining = await chargeClassroom(req.classroom, result);
    res.json({
      ...forStudent(result),
      _classroom: {
        budgetRemaining: remaining,
        piiWarning: pii.found ? pii.types : null,
        claims: gate.reservation.student,
      },
    });
  } catch (err) {
    if (!usage.wasBillable(err)) {
      await usage.releaseClaim(gate.reservation, { classroom: req.classroom, studentId: gate.studentId });
    }
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
    const remaining = await chargeClassroom(req.classroom, result);
    res.json({
      ...forStudent(result),
      _classroom: {
        budgetRemaining: remaining,
        piiWarning: null,
        claims: gate.reservation.student,
      },
    });
  } catch (err) {
    if (!usage.wasBillable(err)) {
      await usage.releaseClaim(gate.reservation, { classroom: req.classroom, studentId: gate.studentId });
    }
    console.error(`[classroom] analyze-url failed for ${req.classroom.id}:`, err.message);
    res.status(502).json({ error: 'The analysis could not be completed. Please try again.' });
  }
});

module.exports = {
  router,
  limits: {
    MIN_BUDGET, MAX_BUDGET, DEFAULT_BUDGET, MAX_DURATION_MS, MAX_CLASSROOMS_PER_OWNER,
    MAX_CLAIM_LIMIT, MAX_CLAIM_LIMIT_PER_STUDENT, MAX_EXPECTED_STUDENTS,
  },
  // Exported for tests.
  _internal: {
    parseBudget, parseExpiry, parseName, addressHash, clientAddress,
    parseOptionalCount, claimQuotaPatch, limitMessage,
  },
};
