'use strict';

/* Central configuration for ClaimCheck usage guardrails.
 *
 * Every number that bounds what a student, a classroom, or the account as a
 * whole may spend lives here, and every one of them is overridable with an
 * environment variable. Nothing else in the codebase should hardcode a quota —
 * changing a limit means changing a Vercel environment variable, not shipping
 * a patch.
 *
 * Values are read from process.env on each call rather than captured at module
 * load. That costs nothing measurable and means a test (or a future admin
 * surface) can change a limit without reloading the module graph.
 */

/**
 * Reads a non-negative integer environment variable.
 *
 * Anything unparseable falls back to the default rather than throwing or
 * silently becoming NaN: a typo in a Vercel variable should degrade to the
 * documented default, not disable the guardrail it was meant to configure.
 *
 * `min` and `max` express a range the value must be inside to mean anything.
 * A value outside it also falls back, loudly. This is how the "no unlimited
 * classroom" invariant survives configuration: a limit that must be at least 1
 * cannot be turned into 0 by an environment variable, whether by a typo or on
 * purpose. Without a range, 0 is a perfectly valid non-negative integer and
 * would silently disable the gate it was meant to configure.
 */
function readInt(name, fallback, { min = 0, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[limits] ${name}="${raw}" is not a non-negative number; using ${fallback}.`);
    return fallback;
  }
  const floored = Math.floor(n);
  if (floored < min || floored > max) {
    console.warn(
      `[limits] ${name}="${raw}" is outside the accepted range ${min}–${max === Infinity ? '∞' : max}; ` +
      `using ${fallback}.`
    );
    return fallback;
  }
  return floored;
}

/* ── Defaults ─────────────────────────────────────────────────────────
 * These are the values in force when no environment variable is set. They are
 * also the numbers quoted in the user-facing copy, so a deployment that
 * overrides one should override the matching string in public/locales too.
 */
const DEFAULTS = {
  MAX_CLAIM_CHARACTERS: 750,

  /* ClaimChecks one student gets in one classroom session.
   *
   * 4 is the shape of a single lesson: read a claim, check it, check a
   * counter-claim, check one more. It is the number a teacher can say out loud
   * — "each of you gets four ClaimChecks" — and it is what the create form
   * fills in when the field is left blank.
   *
   * Lowered from 12 on 2026-08-27. A blank form now resolves to the same
   * classroom a teacher would build by hand: 25 students x 4 = 100. Nothing
   * already running changes — an existing classroom stores its own value, or
   * derives from its own roster, and neither is re-read from this constant.
   */
  STUDENT_SESSION_LIMIT: 4,

  /* ClaimChecks a whole classroom gets when it recorded neither a roster size
   * nor a per-student allowance. Kept equal to the product of the two defaults
   * (25 x 4) so the flat fallback and the derived one can never disagree —
   * the create form prints the derived number, and a fallback that resolved to
   * something else would make that number a lie. */
  CLASSROOM_SESSION_LIMIT: 100,
  // Expressed as a percentage so it stays an integer environment variable,
  // matching every other limit here. 110 would mean "10% headroom".
  //
  // 100 — no headroom — is deliberate. The capacity a teacher is shown is now
  // exactly `class size × ClaimChecks per student`, and a promise of "25
  // students × 4 checks = 100 ClaimChecks" that quietly resolved to 110 would
  // make the one number the teacher reads a number the system does not mean.
  // Raise this if a class should be allowed to overspend its own arithmetic.
  CLASSROOM_HEADROOM_PERCENT: 100,
  GLOBAL_DAILY_LIMIT: 1000,
  GLOBAL_MONTHLY_LIMIT: 15000,

  // Roster size assumed when a teacher records none. Chosen with
  // STUDENT_SESSION_LIMIT so the two agree with the flat classroom default:
  // 25 × 4 = 100 = CLASSROOM_SESSION_LIMIT.
  DEFAULT_EXPECTED_STUDENTS: 25,

  /* ── Accepted ranges ────────────────────────────────────────────────
   * Every classroom must end up with a finite ClaimCheck allowance and a
   * finite token ceiling, so none of these bounds includes 0. They apply to
   * teacher input, to direct API requests, and to the environment variables
   * that supply the defaults — one range, checked everywhere, so there is no
   * layer left where "unlimited" can be reintroduced.
   */
  MIN_CLAIMS_PER_STUDENT: 1,
  MAX_CLAIMS_PER_STUDENT: 20,
  MIN_EXPECTED_STUDENTS: 1,
  MAX_EXPECTED_STUDENTS: 1000,
  MIN_CLASSROOM_CLAIM_LIMIT: 1,
  MAX_CLASSROOM_CLAIM_LIMIT: 100000,

  /* The cap on a classroom total a teacher types in directly.
   *
   * Deliberately far below MAX_CLASSROOM_CLAIM_LIMIT, and deliberately NOT
   * environment-overridable: "a custom allowance must never exceed 150" is a
   * product rule, and a rule with a configuration switch is a rule with an
   * exception.
   *
   * It applies to an EXPLICIT total only. A classroom in automatic mode is
   * sized by its roster and may legitimately exceed this — 50 students x 4 is
   * 200 ClaimChecks and is fine. The distinction is the whole point: 200
   * derived from a real class is a considered number; 200 typed into a box is
   * usually a typo.
   */
  MAX_CUSTOM_CLAIM_LIMIT: 150,

  /* ── Token safety ceiling ───────────────────────────────────────────
   * Tokens are no longer the classroom's allowance. They are a ceiling that
   * exists to stop pathological consumption, and it is sized from measured
   * behaviour rather than an estimate.
   *
   * Measured 2026-08-27 against the live pipeline, five representative claims,
   * counting exactly what a classroom is debited (input + output + cache):
   *
   *     simple factual            29,038   1 API call   2 searches
   *     typical classroom claim   26,556   1 API call   2 searches
   *     research-heavy/contested  29,080   1 API call   2 searches
   *     quick snapshot            29,154   1 API call   2 searches
   *     academic mode             50,240   1 API call   3 searches
   *
   * Median ~29k, observed maximum ~50k. Almost all of it is input: the web
   * search tool resolves server-side and every result it reads is billed as
   * input on the one request that asked for it, so token cost tracks the
   * number of searches far more than the length of the claim.
   *
   * WHY 90,000 and not something closer to the measurements:
   *
   *   - It must clear the worst case comfortably. At 50,240 a single academic
   *     -mode analysis already costs 1.7x the median, and the pipeline permits
   *     5 searches where that one used 3 — so a legitimate analysis can plausibly
   *     reach ~80,000 without anything being wrong.
   *   - It must not be reachable by an ordinary class. At 90,000 a classroom has
   *     to average roughly 3x the median across its whole allowance before the
   *     ceiling fires. Ordinary work never gets close.
   *   - It must still stop a runaway. A classroom burning 600,000 tokens per
   *     analysis trips it within a handful of requests instead of spending
   *     unbounded credit.
   *
   * Configurable via CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS so the figure can be
   * retuned from Vercel when these measurements age, without a deployment.
   */
  TOKEN_SAFETY_PER_ANALYSIS: 90000,

  // Floor for the whole-classroom ceiling, so a deliberately tiny classroom
  // (3 ClaimChecks for a demo) is not tripped by one unusually expensive
  // analysis landing early.
  MIN_TOKEN_SAFETY_LIMIT: 250000,

  /* Bounds for the ceiling itself. The minimum is above the worst single
   * analysis measured, because a ceiling a classroom could hit on its first
   * request is a broken classroom rather than a guardrail. */
  MIN_TOKEN_SAFETY_PER_ANALYSIS: 60000,
  MAX_TOKEN_SAFETY_PER_ANALYSIS: 5000000,
  MAX_TOKEN_SAFETY_LIMIT: 50000000,
};

/**
 * Tokens allowed per ClaimCheck when sizing a classroom's safety ceiling.
 *
 * Bounded, and the lower bound is not 0. Letting this reach 0 would remove the
 * ceiling from every classroom at once via a single environment variable, which
 * is precisely the "unlimited classroom" this system must not have. An invalid
 * or out-of-range value warns and falls back to the measured default.
 */
const tokenSafetyPerAnalysis = () =>
  readInt('CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS', DEFAULTS.TOKEN_SAFETY_PER_ANALYSIS, {
    min: DEFAULTS.MIN_TOKEN_SAFETY_PER_ANALYSIS,
    max: DEFAULTS.MAX_TOKEN_SAFETY_PER_ANALYSIS,
  });

/** Smallest whole-classroom token ceiling, whatever the analysis count. */
const minTokenSafetyLimit = () =>
  readInt('CLAIMCHECK_MIN_TOKEN_SAFETY_LIMIT', DEFAULTS.MIN_TOKEN_SAFETY_LIMIT, {
    min: DEFAULTS.MIN_TOKEN_SAFETY_PER_ANALYSIS,
    max: DEFAULTS.MAX_TOKEN_SAFETY_LIMIT,
  });

/** Roster size assumed for a classroom that recorded none. */
const defaultExpectedStudents = () =>
  readInt('CLAIMCHECK_DEFAULT_EXPECTED_STUDENTS', DEFAULTS.DEFAULT_EXPECTED_STUDENTS, {
    min: DEFAULTS.MIN_EXPECTED_STUDENTS,
    max: DEFAULTS.MAX_EXPECTED_STUDENTS,
  });

/**
 * The token ceiling for a classroom allowed `analysisLimit` ClaimChecks.
 *
 *     max(floor, analysis_limit × tokens per analysis)
 *
 * Always returns a finite, positive number. An analysis limit that is missing
 * or nonsensical falls back to the floor rather than to "no ceiling" — there is
 * no input to this function, and no configuration around it, that produces an
 * unceilinged classroom.
 */
function tokenSafetyLimitFor(analysisLimit) {
  const perCheck = tokenSafetyPerAnalysis();
  const floor = minTokenSafetyLimit();
  const limit = Number(analysisLimit);
  if (!Number.isFinite(limit) || limit <= 0) return floor;
  return Math.min(DEFAULTS.MAX_TOKEN_SAFETY_LIMIT, Math.max(floor, Math.round(limit * perCheck)));
}

/**
 * Longest claim accepted by the standard claim-analysis workflow.
 *
 * This bounds the CLAIM box only. Article-URL analysis feeds extracted page
 * text straight into the pipeline and is governed by its own, much larger cap
 * in lib/extract-article.js — a news article is legitimately thousands of
 * characters and narrowing it is the tool's job, not the student's.
 */
const maxClaimCharacters = () => readInt('CLAIMCHECK_MAX_CLAIM_CHARACTERS', DEFAULTS.MAX_CLAIM_CHARACTERS);

/**
 * ClaimChecks one anonymous student may run in one classroom.
 *
 * Bounded by the same 1–20 range a teacher's own input is bounded by, because
 * this IS that input's default — an environment variable that could set it to 0
 * would be a way to make every classroom unmetered per student without touching
 * the API. Out of range warns and falls back.
 */
const studentSessionLimit = () =>
  readInt('CLAIMCHECK_STUDENT_SESSION_LIMIT', DEFAULTS.STUDENT_SESSION_LIMIT, {
    min: DEFAULTS.MIN_CLAIMS_PER_STUDENT,
    max: DEFAULTS.MAX_CLAIMS_PER_STUDENT,
  });

/** ClaimChecks a whole classroom may run, across every student. Never 0. */
const classroomSessionLimit = () =>
  readInt('CLAIMCHECK_CLASSROOM_SESSION_LIMIT', DEFAULTS.CLASSROOM_SESSION_LIMIT, {
    min: DEFAULTS.MIN_CLASSROOM_CLAIM_LIMIT,
    max: DEFAULTS.MAX_CLASSROOM_CLAIM_LIMIT,
  });

/**
 * Headroom applied when sizing a classroom budget from its roster, as a
 * percentage. 110 gives the class 10% more than the sum of every student's
 * individual allowance.
 */
const classroomHeadroomPercent = () => readInt('CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT', DEFAULTS.CLASSROOM_HEADROOM_PERCENT);

/** Analyses the whole account may run in one UTC day. 0 disables the gate. */
const globalDailyLimit = () => readInt('CLAIMCHECK_GLOBAL_DAILY_LIMIT', DEFAULTS.GLOBAL_DAILY_LIMIT);

/** Analyses the whole account may run in one UTC month. 0 disables the gate. */
const globalMonthlyLimit = () => readInt('CLAIMCHECK_GLOBAL_MONTHLY_LIMIT', DEFAULTS.GLOBAL_MONTHLY_LIMIT);

/**
 * How many ClaimChecks a classroom holds, from the two numbers a teacher
 * actually understands.
 *
 *     expected class size × ClaimChecks per student × headroom
 *     25 × 4 × 1.00 = 100
 *
 * This is the arithmetic printed on the create form, so it is deliberately the
 * arithmetic the server performs — a teacher who reads "100 ClaimChecks" gets
 * 100. Both inputs fall back to a default when blank rather than disabling the
 * calculation, so the form always has a number to show.
 *
 * Every path through this function returns a finite number of at least 1.
 * Values outside the accepted range never reach here — the route rejects them
 * with a 400 — so anything unusable that does arrive is treated as a blank
 * field and falls back to the default. Failing open on the one control that
 * bounds the class is not an option this function offers.
 *
 * @returns {number} ClaimChecks for the whole class. Always ≥ 1.
 */
function classroomCapacity({ expectedStudents, claimsPerStudent } = {}) {
  // An empty string is a blank form field, not a zero. Number('') is 0, and
  // treating that as an explicit "0 ClaimChecks per student" would have turned
  // a teacher who filled in neither box into an unmetered classroom.
  const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

  const expected = given(expectedStudents) ? Number(expectedStudents) : NaN;
  const students = inRange(expected, DEFAULTS.MIN_EXPECTED_STUDENTS, DEFAULTS.MAX_EXPECTED_STUDENTS)
    ? Math.floor(expected)
    : defaultExpectedStudents();

  const per = given(claimsPerStudent) ? Number(claimsPerStudent) : NaN;
  const perStudent = inRange(per, DEFAULTS.MIN_CLAIMS_PER_STUDENT, DEFAULTS.MAX_CLAIMS_PER_STUDENT)
    ? Math.floor(per)
    : studentSessionLimit();

  const capacity = Math.round((students * perStudent * classroomHeadroomPercent()) / 100);
  return Math.min(
    DEFAULTS.MAX_CLASSROOM_CLAIM_LIMIT,
    Math.max(DEFAULTS.MIN_CLASSROOM_CLAIM_LIMIT, capacity)
  );
}

/**
 * The ClaimCheck allowance for a classroom that has not set one explicitly.
 *
 * Reads the classroom's OWN per-student override before the server default, so
 * a teacher who asked for "4 ClaimChecks per student" sizes the class on 4 and
 * not on whatever the site-wide figure happens to be. That link is the whole
 * point of the field: the two inputs are one control, and reading only one of
 * them is how "25 × 4" used to silently become "25 × 12".
 *
 * A classroom that recorded no roster size is sized on the default roster, so
 * the flat CLAIMCHECK_CLASSROOM_SESSION_LIMIT now only applies when the
 * per-student allowance is itself unset — and the two defaults are chosen to
 * agree, so both routes give the same answer (25 × 4 = 100).
 *
 * The database applies the same precedence (an explicit classrooms.claim_limit
 * beats whatever we pass in), so this is the fallback rather than the authority.
 */
function defaultClassroomClaimLimit(room) {
  const expected = room && Number(room.expected_students);
  const perStudentRaw = room && room.claim_limit_per_student;
  const perStudent = Number(perStudentRaw);
  // A stored 0 is treated as "not recorded", not as "unmetered". 0 can no
  // longer be written — the route rejects it — but a row predating that
  // validation must not be read as an unlimited classroom.
  const hasPerStudent = perStudentRaw !== null && perStudentRaw !== undefined
    && Number.isFinite(perStudent) && perStudent > 0;

  // Nothing recorded at all: keep the flat configured default rather than
  // synthesising one out of two fallbacks.
  if ((!Number.isFinite(expected) || expected <= 0) && !hasPerStudent) {
    return classroomSessionLimit();
  }

  return classroomCapacity({
    expectedStudents: expected,
    claimsPerStudent: hasPerStudent ? perStudent : undefined,
  });
}

/**
 * The token ceiling for a classroom that has not set one explicitly: sized from
 * whatever ClaimCheck allowance that classroom resolves to.
 */
function defaultTokenSafetyLimit(room) {
  const explicit = room && Number(room && room.claim_limit);
  // Same rule as above: a stored 0 is "not set", never "no limit".
  const limit = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : defaultClassroomClaimLimit(room);
  return tokenSafetyLimitFor(limit);
}

/* ── Period keys for the global budget ────────────────────────────────
 * UTC on purpose. A limit that resets at each server's local midnight would
 * reset at a different instant on every serverless region the function runs in,
 * which is a quota with a hole in it. UTC is the same everywhere, at the cost
 * of the day boundary not lining up with any particular school day.
 */

/** 'YYYY-MM-DD' in UTC. */
function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** 'YYYY-MM' in UTC. */
function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

module.exports = {
  DEFAULTS,
  readInt,
  maxClaimCharacters,
  studentSessionLimit,
  classroomSessionLimit,
  classroomHeadroomPercent,
  globalDailyLimit,
  globalMonthlyLimit,
  defaultExpectedStudents,
  tokenSafetyPerAnalysis,
  minTokenSafetyLimit,
  tokenSafetyLimitFor,
  classroomCapacity,
  defaultClassroomClaimLimit,
  defaultTokenSafetyLimit,
  dayKey,
  monthKey,
};
