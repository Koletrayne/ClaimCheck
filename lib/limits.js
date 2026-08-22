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
 */
function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[limits] ${name}="${raw}" is not a non-negative number; using ${fallback}.`);
    return fallback;
  }
  return Math.floor(n);
}

/* ── Defaults ─────────────────────────────────────────────────────────
 * These are the values in force when no environment variable is set. They are
 * also the numbers quoted in the user-facing copy, so a deployment that
 * overrides one should override the matching string in public/locales too.
 */
const DEFAULTS = {
  MAX_CLAIM_CHARACTERS: 750,
  STUDENT_SESSION_LIMIT: 12,
  CLASSROOM_SESSION_LIMIT: 300,
  // Expressed as a percentage so it stays an integer environment variable,
  // matching every other limit here. 110 means "10% headroom".
  CLASSROOM_HEADROOM_PERCENT: 110,
  GLOBAL_DAILY_LIMIT: 1000,
  GLOBAL_MONTHLY_LIMIT: 15000,
};

/**
 * Longest claim accepted by the standard claim-analysis workflow.
 *
 * This bounds the CLAIM box only. Article-URL analysis feeds extracted page
 * text straight into the pipeline and is governed by its own, much larger cap
 * in lib/extract-article.js — a news article is legitimately thousands of
 * characters and narrowing it is the tool's job, not the student's.
 */
const maxClaimCharacters = () => readInt('CLAIMCHECK_MAX_CLAIM_CHARACTERS', DEFAULTS.MAX_CLAIM_CHARACTERS);

/** Analyses one anonymous student may run in one classroom. 0 disables the gate. */
const studentSessionLimit = () => readInt('CLAIMCHECK_STUDENT_SESSION_LIMIT', DEFAULTS.STUDENT_SESSION_LIMIT);

/** Analyses a whole classroom may run, across every student. 0 disables the gate. */
const classroomSessionLimit = () => readInt('CLAIMCHECK_CLASSROOM_SESSION_LIMIT', DEFAULTS.CLASSROOM_SESSION_LIMIT);

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
 * The claim quota for a classroom that has not set one explicitly.
 *
 * Derived from the per-student allowance rather than an unrelated constant:
 *
 *     expected_students × student limit × headroom
 *     25 × 12 × 1.10 = 330
 *
 * Tying the two together means raising the per-student limit raises the class
 * budget with it, instead of quietly leaving a class unable to reach the
 * allowance its students were each promised. The headroom exists because a
 * class rarely divides its work evenly — a few students always run more checks
 * than the rest, and a budget set to the exact sum would strand them behind a
 * classroom limit while other students still had unused allowance.
 *
 * A teacher who never recorded a roster size gets the flat configured default.
 * The database applies the same precedence (an explicit classrooms.claim_limit
 * beats whatever we pass in), so this is the fallback rather than the authority.
 */
function defaultClassroomClaimLimit(room) {
  const expected = room && Number(room.expected_students);
  if (!Number.isFinite(expected) || expected <= 0) return classroomSessionLimit();

  const perStudent = studentSessionLimit();
  // A per-student limit of 0 means students are unmetered, so deriving a class
  // budget from it would produce 0 — which the database reads as "no limit".
  // That is the correct reading, but fall back to the flat default rather than
  // arriving there by accident.
  if (perStudent <= 0) return classroomSessionLimit();

  return Math.round((expected * perStudent * classroomHeadroomPercent()) / 100);
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
  defaultClassroomClaimLimit,
  dayKey,
  monthKey,
};
