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

    const created = await classroom.createClassroom({
      ownerId: req.educator.id,
      displayName: parseName(displayName),
      expiresAt: expiry,
      tokenBudget: budget,
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

/** Lets a returning tab confirm its stored session is still good. */
router.get('/session', requireConfigured, requireClassroomSession, (req, res) => {
  res.json({ classroom: classroom.publicView(req.classroom) });
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
  if (text.length > 8000) {
    return res.status(413).json({ error: 'Selection too long. Trim to under 8,000 characters.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'This server is not configured to run analyses.' });
  }

  // Advisory only — the analysis proceeds either way. See lib/pii.js for why
  // this warns rather than blocks.
  const pii = detectPii(text);

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
      _classroom: { budgetRemaining: remaining, piiWarning: pii.found ? pii.types : null },
    });
  } catch (err) {
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
      _classroom: { budgetRemaining: remaining, piiWarning: null },
    });
  } catch (err) {
    console.error(`[classroom] analyze-url failed for ${req.classroom.id}:`, err.message);
    res.status(502).json({ error: 'The analysis could not be completed. Please try again.' });
  }
});

module.exports = {
  router,
  limits: { MIN_BUDGET, MAX_BUDGET, DEFAULT_BUDGET, MAX_DURATION_MS, MAX_CLASSROOMS_PER_OWNER },
  // Exported for tests.
  _internal: { parseBudget, parseExpiry, parseName, addressHash, clientAddress },
};
