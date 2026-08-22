'use strict';

/* Pre-flight usage enforcement for the paid analysis pipeline.
 *
 * Everything here runs BEFORE analyzeClaim() and therefore before any request
 * reaches Claude, Perplexity, or any other paid provider. That ordering is the
 * whole point: a limit checked after the fact is a report, not a guardrail.
 *
 * Three layers, checked together in one atomic database call:
 *
 *   student    one anonymous student in one classroom
 *   classroom  every student in that classroom combined
 *   global     the whole account, per UTC day and per UTC month
 *
 * Trust boundary: the client supplies a classroom session token and an
 * anonymous student id, and nothing else. How many claims that student has
 * used, what their cap is, and whether any layer is exhausted are all decided
 * here from database state. A client that lies about its counts changes
 * nothing; a client that omits its student id is refused.
 *
 * Privacy: the student id is an opaque random UUID minted in the browser. This
 * module never sees, logs, or stores claim text, and it never records anything
 * about a student beyond a per-classroom counter keyed by that random id.
 */

const { rpc, rest, isConfigured } = require('./supabase-admin');
const limits = require('./limits');

/** Reasons a reservation can be refused. Mirrored in the client copy. */
const REASONS = {
  STUDENT_LIMIT: 'STUDENT_LIMIT',
  CLASSROOM_LIMIT: 'CLASSROOM_LIMIT',
  GLOBAL_LIMIT: 'GLOBAL_LIMIT',
  NO_CLASSROOM: 'NO_CLASSROOM',
  // Quota state could not be determined at all: the database was unreachable,
  // returned an error, or is not configured. Distinct from the limit reasons
  // above because nothing is known to be exhausted — we simply cannot say, and
  // "cannot say" now means "do not spend money".
  USAGE_UNVERIFIED: 'USAGE_UNVERIFIED',
};

/** HTTP status for each refusal. */
const REASON_STATUS = {
  STUDENT_LIMIT: 429,
  CLASSROOM_LIMIT: 429,
  // The account budget is an operator-side problem, not something the student
  // did, so it reads as "the service is unavailable right now" rather than
  // "you asked for too much".
  GLOBAL_LIMIT: 503,
  NO_CLASSROOM: 403,
  USAGE_UNVERIFIED: 503,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a client-supplied anonymous student id.
 *
 * Shape only — there is nothing to look up, because the id is generated in the
 * browser and this is the first the server hears of it. Rejecting anything that
 * is not a canonical UUID keeps the value safe to hand to Postgres as a uuid
 * parameter and stops a client from smuggling a non-random, guessable, or
 * identifying string in as its "anonymous" id.
 */
function normalizeStudentId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Reads the anonymous student id off a request (header preferred, body accepted). */
function studentIdFromRequest(req) {
  const header = req.get && req.get('x-claimcheck-student');
  const body = req.body && req.body.anonymousStudentId;
  return normalizeStudentId(header || body || '');
}

/**
 * Whether usage enforcement can run at all.
 *
 * Without Supabase there is nowhere to keep an authoritative count.
 */
const enforcementAvailable = () => isConfigured();

/**
 * Whether this process is running as a deployed, credit-spending instance.
 *
 * Two independent signals, because relying on either alone leaves a gap:
 * NODE_ENV can be left unset by a hand-rolled deployment, and VERCEL is absent
 * anywhere that is not Vercel. Either one being present is enough to treat the
 * process as production.
 */
function isProductionLike() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

/**
 * The escape hatch from fail-closed behaviour, and the three things it cannot
 * do.
 *
 * These guardrails exist for financial protection, so not being able to check a
 * quota has to mean "do not spend money", not "spend it anyway". The hatch
 * exists only for a deployment that never wanted usage tracking and has no
 * Supabase credentials to give it — a local checkout, or a self-hosted instance
 * paying for its own key. Without it, a missing environment variable would take
 * such an instance entirely offline.
 *
 * It cannot:
 *   1. Run in production. NODE_ENV=production or VERCEL being set makes it
 *      inert, whatever it is set to. This is the important one: it means no
 *      production configuration exists — not a misconfiguration, not a lost
 *      credential, not a copied env file — in which unverified usage becomes
 *      unmetered spending.
 *   2. Override a database that is merely broken. It is only consulted when
 *      Supabase is entirely unconfigured; a configured-but-failing database
 *      always fails closed.
 *   3. Be switched on by accident. It is opt-in, off by default, and named for
 *      exactly what it does.
 */
function unverifiedUsageAllowed() {
  const raw = String(process.env.CLAIMCHECK_ALLOW_UNVERIFIED_USAGE || '').trim().toLowerCase();
  const requested = raw === 'true' || raw === '1' || raw === 'yes';

  if (requested && isProductionLike()) {
    warnHatchIgnoredOnce();
    return false;
  }
  return requested;
}

let warnedHatchIgnored = false;

function warnHatchIgnoredOnce() {
  if (warnedHatchIgnored) return;
  warnedHatchIgnored = true;
  console.error(
    '[usage] CLAIMCHECK_ALLOW_UNVERIFIED_USAGE is set but IGNORED: it cannot disable ' +
    'usage verification in a production deployment. Requests will be refused until ' +
    'Supabase is configured. Remove this variable from the production environment.'
  );
}

let warnedUnavailable = false;

function warnUnavailableOnce(allowed) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  if (allowed) {
    console.warn(
      '[usage] Supabase is not configured and CLAIMCHECK_ALLOW_UNVERIFIED_USAGE is set — ' +
      'usage budgets are NOT being enforced and spending is UNMETERED. ' +
      'Do not run a paid deployment in this state.'
    );
  } else {
    console.error(
      '[usage] Supabase is not configured, so usage limits cannot be verified and every ' +
      'analysis will be refused. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or set ' +
      'CLAIMCHECK_ALLOW_UNVERIFIED_USAGE=true to run without enforcement.'
    );
  }
}

/** The refusal returned whenever quota state cannot be established. */
function unverified(period) {
  return {
    allowed: false,
    enforced: false,
    reason: REASONS.USAGE_UNVERIFIED,
    status: REASON_STATUS.USAGE_UNVERIFIED,
    student: null,
    classroom: null,
    period,
  };
}

/**
 * Reserves one claim against every applicable layer, atomically.
 *
 * Call this immediately before invoking the analysis pipeline, never earlier:
 * a reservation that is taken and then not used has to be handed back, and the
 * fewer paths that can happen on, the better.
 *
 * @param {object}      opts
 * @param {object|null} opts.classroom  classroom row, or null on the public site
 * @param {string|null} opts.studentId  validated anonymous student id
 * @returns {Promise<object>} `{ allowed, reason, status, enforced, student, classroom, period }`
 */
async function reserveClaim({ classroom = null, studentId = null } = {}) {
  const now = new Date();
  const period = { day: limits.dayKey(now), month: limits.monthKey(now) };

  if (!enforcementAvailable()) {
    const allowed = unverifiedUsageAllowed();
    warnUnavailableOnce(allowed);
    if (!allowed) return unverified(period);
    return { allowed: true, enforced: false, reason: null, status: 200, student: null, classroom: null, period };
  }

  const studentLimit = limits.studentSessionLimit();
  const classroomLimit = classroom ? limits.defaultClassroomClaimLimit(classroom) : 0;

  let row;
  try {
    const rows = await rpc('claimcheck_reserve_claim', {
      p_classroom_id: classroom ? classroom.id : null,
      p_student_id: classroom ? studentId : null,
      p_student_limit: classroom ? studentLimit : 0,
      p_classroom_limit: classroomLimit,
      p_daily_limit: limits.globalDailyLimit(),
      p_monthly_limit: limits.globalMonthlyLimit(),
      p_day: period.day,
      p_month: period.month,
    });
    row = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    // The database is the source of truth and it is unreachable, so nothing is
    // known about any of the four budgets. Proceeding would mean spending money
    // with no ceiling for as long as the outage lasts, which is the exact
    // scenario these guardrails exist to prevent — so the request is refused.
    // A lesson interrupted is recoverable; an unbounded bill is not.
    //
    // err.message is the sanitised message from lib/supabase-admin, which
    // already keeps schema and connection detail out of anything returned to a
    // caller. The full detail is logged there, not here.
    console.error('[usage] reservation failed; refusing the request (fail-closed):', err.message);
    return unverified(period);
  }

  if (!row) {
    // A successful call that returned nothing means the function is missing or
    // the migration has not been applied. Same conclusion: quota state is
    // unknown, so no paid work happens.
    console.error('[usage] reservation returned no row; refusing the request (fail-closed).');
    return unverified(period);
  }

  const result = {
    allowed: Boolean(row.allowed),
    enforced: true,
    reason: row.reason || null,
    status: row.allowed ? 200 : (REASON_STATUS[row.reason] || 429),
    period,
    student: classroom && studentId
      ? { used: Number(row.student_used) || 0, limit: Number(row.student_cap) || 0 }
      : null,
    classroom: classroom
      ? { used: Number(row.classroom_used) || 0, limit: Number(row.classroom_cap) || 0 }
      : null,
  };

  if (!result.allowed) {
    // Deliberately logs the reason and the classroom, never the claim or the
    // student id — the id is anonymous but there is no reason to put a stable
    // per-student handle into log storage.
    console.warn(
      `[usage] refused reason=${result.reason} ` +
      `classroom=${classroom ? classroom.id : 'none'} ` +
      `day=${period.day}`
    );
  }

  return result;
}

/**
 * Hands a reservation back after an analysis failed without costing anything.
 *
 * Only safe to call when no billable provider work happened — see
 * `wasBillable` in the route handlers. Releasing after a real provider call
 * would hand back allowance for money that was actually spent, which is the one
 * direction this feature must never fail in.
 */
async function releaseClaim(reservation, { classroom = null, studentId = null } = {}) {
  if (!reservation || !reservation.enforced || !reservation.allowed) return;
  if (!enforcementAvailable()) return;

  try {
    await rpc('claimcheck_release_claim', {
      p_classroom_id: classroom ? classroom.id : null,
      p_student_id: classroom ? studentId : null,
      p_day: reservation.period.day,
      p_month: reservation.period.month,
    });
  } catch (err) {
    // The student already saw their error. An unreturned reservation costs them
    // one claim of allowance, which is a far better outcome than a second
    // failure on top of the first — but it must be visible.
    console.error('[usage] releasing an unused reservation failed:', err.message);
  }
}

/**
 * Reads current usage for display, without reserving anything.
 *
 * Used by the classroom session poll so a student can see how many ClaimChecks
 * they have left. Returns the server's numbers; the browser renders them and
 * has no say in them.
 */
async function readUsage({ classroom = null, studentId = null } = {}) {
  if (!classroom || !enforcementAvailable()) return null;

  const classroomLimit = Number.isFinite(Number(classroom.claim_limit)) && classroom.claim_limit !== null
    ? Number(classroom.claim_limit)
    : limits.defaultClassroomClaimLimit(classroom);

  const studentLimit = Number.isFinite(Number(classroom.claim_limit_per_student)) && classroom.claim_limit_per_student !== null
    ? Number(classroom.claim_limit_per_student)
    : limits.studentSessionLimit();

  const usage = {
    classroom: { used: Number(classroom.claims_used) || 0, limit: classroomLimit },
    student: null,
  };

  if (!studentId) return usage;

  try {
    const rows = await rest(
      'classroom_student_usage' +
      `?classroom_id=eq.${encodeURIComponent(classroom.id)}` +
      `&student_id=eq.${encodeURIComponent(studentId)}` +
      '&select=claims_used&limit=1'
    );
    const used = Array.isArray(rows) && rows.length ? Number(rows[0].claims_used) || 0 : 0;
    usage.student = { used, limit: studentLimit };
  } catch (err) {
    console.error('[usage] reading student usage failed:', err.message);
    usage.student = { used: 0, limit: studentLimit };
  }

  return usage;
}

/**
 * Whether a failed analysis actually cost money.
 *
 * lib/analyze.js attaches the usage accumulated so far to anything it throws,
 * so a failure that never got a billable response back from the provider is
 * distinguishable from one that did. When the signal is missing we assume the
 * request WAS billable and keep the charge — over-counting costs a student one
 * claim, while under-counting is a hole in the budget.
 */
function wasBillable(err) {
  if (!err || !err.usage) return true;
  const u = err.usage;
  const tokens =
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0);
  return tokens > 0 || (u.web_search_requests || 0) > 0;
}

module.exports = {
  REASONS,
  REASON_STATUS,
  isProductionLike,
  unverifiedUsageAllowed,
  normalizeStudentId,
  studentIdFromRequest,
  enforcementAvailable,
  reserveClaim,
  releaseClaim,
  readUsage,
  wasBillable,
};
