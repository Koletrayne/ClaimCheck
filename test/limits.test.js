'use strict';

/* Tests for the usage guardrail configuration and the claim character limit.
 *
 * These cover the boundary the whole feature turns on. 750 is not a round
 * number chosen for elegance — it is the exact point where a claim stops being
 * accepted, so 749 / 750 / 751 are asserted individually rather than trusting
 * that one comparison operator was written the right way round.
 *
 * Nothing here touches the network or the database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../lib/limits');
const guard = require('../lib/usage-guard');

/** Applies environment overrides and returns a function that undoes them. */
function applyEnv(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Runs a synchronous `fn` with the given environment variables set. */
function withEnv(vars, fn) {
  const restore = applyEnv(vars);
  try {
    return fn();
  } finally {
    restore();
  }
}

/**
 * The async counterpart. Kept separate rather than making withEnv detect a
 * promise, because the synchronous version's `finally` would otherwise restore
 * the environment the instant the callback hit its first await — leaving the
 * assertions to run against whatever the environment happened to be, which
 * fails silently and intermittently rather than loudly.
 */
async function withEnvAsync(vars, fn) {
  const restore = applyEnv(vars);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/* ── Defaults ─────────────────────────────────────────────────────────── */

test('the documented defaults are the values actually in force', () => {
  withEnv({
    CLAIMCHECK_MAX_CLAIM_CHARACTERS: undefined,
    CLAIMCHECK_STUDENT_SESSION_LIMIT: undefined,
    CLAIMCHECK_CLASSROOM_SESSION_LIMIT: undefined,
    CLAIMCHECK_GLOBAL_DAILY_LIMIT: undefined,
    CLAIMCHECK_GLOBAL_MONTHLY_LIMIT: undefined,
  }, () => {
    assert.equal(limits.maxClaimCharacters(), 750);
    assert.equal(limits.studentSessionLimit(), 12);
    assert.equal(limits.classroomSessionLimit(), 300);
    assert.equal(limits.globalDailyLimit(), 1000);
    assert.equal(limits.globalMonthlyLimit(), 15000);
  });
});

test('every limit is overridable from the environment', () => {
  withEnv({
    CLAIMCHECK_MAX_CLAIM_CHARACTERS: 500,
    CLAIMCHECK_STUDENT_SESSION_LIMIT: 5,
    CLAIMCHECK_CLASSROOM_SESSION_LIMIT: 90,
    CLAIMCHECK_GLOBAL_DAILY_LIMIT: 42,
    CLAIMCHECK_GLOBAL_MONTHLY_LIMIT: 999,
  }, () => {
    assert.equal(limits.maxClaimCharacters(), 500);
    assert.equal(limits.studentSessionLimit(), 5);
    assert.equal(limits.classroomSessionLimit(), 90);
    assert.equal(limits.globalDailyLimit(), 42);
    assert.equal(limits.globalMonthlyLimit(), 999);
  });
});

test('a malformed environment value falls back to the default rather than becoming NaN', () => {
  // A NaN limit compares false against everything, which would silently switch
  // the guardrail off — the one failure mode this feature cannot have.
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 'twelve' }, () => {
    assert.equal(limits.studentSessionLimit(), 12);
  });
  withEnv({ CLAIMCHECK_GLOBAL_DAILY_LIMIT: '-5' }, () => {
    assert.equal(limits.globalDailyLimit(), 1000);
  });
  withEnv({ CLAIMCHECK_MAX_CLAIM_CHARACTERS: '' }, () => {
    assert.equal(limits.maxClaimCharacters(), 750);
  });
});

/* ── The 750-character boundary ───────────────────────────────────────── */

/**
 * Mirrors the length check the routes apply. Kept here as a tiny pure function
 * so the boundary can be asserted without standing up an HTTP server; the
 * routes are exercised end-to-end in guardrails.test.js.
 */
const withinLimit = (text) => text.length <= limits.maxClaimCharacters();

test('a 749-character claim is accepted', () => {
  assert.equal(withinLimit('a'.repeat(749)), true);
});

test('a claim of exactly 750 characters is accepted', () => {
  // The limit is inclusive: "up to 750 characters" means 750 is allowed.
  assert.equal(withinLimit('a'.repeat(750)), true);
});

test('a 751-character claim is rejected', () => {
  assert.equal(withinLimit('a'.repeat(751)), false);
});

test('the boundary moves with the configured limit', () => {
  withEnv({ CLAIMCHECK_MAX_CLAIM_CHARACTERS: 100 }, () => {
    assert.equal(withinLimit('a'.repeat(100)), true);
    assert.equal(withinLimit('a'.repeat(101)), false);
  });
});

/* ── Classroom quota defaults ─────────────────────────────────────────── */

test('a classroom with an expected roster is sized from the per-student limit', () => {
  // expected_students × student limit × headroom: 25 × 12 × 1.10 = 330.
  withEnv({
    CLAIMCHECK_STUDENT_SESSION_LIMIT: 12,
    CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 110,
    CLAIMCHECK_CLASSROOM_SESSION_LIMIT: 300,
  }, () => {
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 25 }), 330);
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 30 }), 396);
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 1 }), 13);
  });
});

test('raising the per-student limit raises the classroom default with it', () => {
  // The point of deriving one from the other: a class must never be capped
  // below the allowance its own students were each promised.
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 20, CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 110 }, () => {
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 25 }), 550);
  });
});

test('the classroom default always leaves headroom above the exact student sum', () => {
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 12, CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 110 }, () => {
    for (const students of [1, 5, 12, 25, 30, 40]) {
      const exactSum = students * 12;
      assert.ok(
        limits.defaultClassroomClaimLimit({ expected_students: students }) >= exactSum,
        `${students} students must get at least ${exactSum}`
      );
    }
  });
});

test('the headroom percentage is configurable', () => {
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 10, CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 100 }, () => {
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 20 }), 200);
  });
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 10, CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 150 }, () => {
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 20 }), 300);
  });
});

test('an unmetered per-student limit falls back to the flat classroom default', () => {
  // 0 students-limit means "no per-student gate". Multiplying by it would yield
  // 0, which the database reads as "no classroom limit either" — a quota that
  // silently disappears. The flat default is the safer reading.
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 0, CLAIMCHECK_CLASSROOM_SESSION_LIMIT: 300 }, () => {
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 25 }), 300);
  });
});

test('a classroom without an expected roster falls back to the flat default', () => {
  withEnv({ CLAIMCHECK_CLASSROOM_SESSION_LIMIT: 300 }, () => {
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: null }), 300);
    assert.equal(limits.defaultClassroomClaimLimit({}), 300);
    // Zero students is not a roster size; it must not produce a zero budget.
    assert.equal(limits.defaultClassroomClaimLimit({ expected_students: 0 }), 300);
  });
});

/* ── Period keys ──────────────────────────────────────────────────────── */

test('period keys are UTC calendar keys', () => {
  const when = new Date('2026-08-22T23:45:00.000Z');
  assert.equal(limits.dayKey(when), '2026-08-22');
  assert.equal(limits.monthKey(when), '2026-08');
});

test('a new day and a new month produce new keys, which is how budgets reset', () => {
  // No scheduled job resets anything: the key simply changes and the next
  // request creates a fresh row at zero.
  assert.notEqual(limits.dayKey(new Date('2026-08-31T12:00:00Z')), limits.dayKey(new Date('2026-09-01T12:00:00Z')));
  assert.notEqual(limits.monthKey(new Date('2026-08-31T12:00:00Z')), limits.monthKey(new Date('2026-09-01T12:00:00Z')));
  // Same month, different day: the monthly key must NOT roll over.
  assert.equal(limits.monthKey(new Date('2026-08-01T00:00:00Z')), limits.monthKey(new Date('2026-08-31T23:59:59Z')));
});

/* ── Anonymous student id validation ──────────────────────────────────── */

test('a canonical UUID is accepted and normalized to lowercase', () => {
  assert.equal(
    guard.normalizeStudentId('7F3A6C21-4B8E-4D2A-9C1F-0E5A7B3D9C44'),
    '7f3a6c21-4b8e-4d2a-9c1f-0e5a7b3d9c44'
  );
  assert.equal(
    guard.normalizeStudentId('  7f3a6c21-4b8e-4d2a-9c1f-0e5a7b3d9c44  '),
    '7f3a6c21-4b8e-4d2a-9c1f-0e5a7b3d9c44'
  );
});

test('anything that is not a UUID is refused', () => {
  // The id goes to Postgres as a uuid parameter, and a client that could send
  // an arbitrary string could also send a non-random, guessable, or
  // identifying one. Shape validation closes both.
  for (const bad of [
    '', null, undefined, 42, {}, [],
    'not-a-uuid',
    'student-1',
    '7f3a6c21-4b8e-4d2a-9c1f',                      // too short
    "7f3a6c21-4b8e-4d2a-9c1f-0e5a7b3d9c44' or 1=1", // injection shape
    '7f3a6c21_4b8e_4d2a_9c1f_0e5a7b3d9c44',         // wrong separators
  ]) {
    assert.equal(guard.normalizeStudentId(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('the student id is read from the header in preference to the body', () => {
  // The header is what our own client sends. Accepting the body too keeps the
  // route usable from a plain JSON POST, but a request carrying both must not
  // let the body override the header.
  const header = '11111111-2222-4333-8444-555555555555';
  const body = '99999999-8888-4777-8666-555555555555';
  const req = { get: (name) => (name === 'x-claimcheck-student' ? header : null), body: { anonymousStudentId: body } };
  assert.equal(guard.studentIdFromRequest(req), header);
});

/* ── Fail-closed when Supabase is not configured ──────────────────────── */

// This file deliberately does not load .env, so lib/supabase-admin sees no
// credentials and enforcementAvailable() is false — the "not configured at all"
// case, as distinct from a configured database that is broken.

test('with no Supabase configured, reservations are refused by default', async () => {
  assert.equal(guard.enforcementAvailable(), false, 'precondition: no credentials in this test file');

  await withEnvAsync({ NODE_ENV: 'test', VERCEL: undefined, CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: undefined }, async () => {
    const result = await guard.reserveClaim({});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'USAGE_UNVERIFIED');
    assert.equal(result.status, 503);
  });
});

test('the escape hatch restores permissive behaviour, and only when opted into', async () => {
  // Intended for a local checkout or a self-hosted instance on its own key.
  // It has to be set deliberately; a missing variable never lands here.
  for (const value of ['true', '1', 'yes', 'TRUE']) {
    await withEnvAsync({ NODE_ENV: 'test', VERCEL: undefined, CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: value }, async () => {
      const result = await guard.reserveClaim({});
      assert.equal(result.allowed, true, `${value} should opt in`);
      assert.equal(result.enforced, false, 'and should say enforcement is off');
    });
  }

  for (const value of ['false', '0', 'no', '', 'maybe', undefined]) {
    await withEnvAsync({ NODE_ENV: 'test', VERCEL: undefined, CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: value }, async () => {
      const result = await guard.reserveClaim({});
      assert.equal(result.allowed, false, `${JSON.stringify(value)} must not opt in`);
    });
  }
});

/* ── The escape hatch cannot reach production ─────────────────────────── */

// The invariant these protect: there is no production configuration — no
// misconfiguration, no lost credential, no copied env file — in which paid
// requests become unmetered. Losing SUPABASE_URL in production takes ClaimCheck
// offline; it never silently turns metering off.

test('the escape hatch is inert when NODE_ENV is production', async () => {
  await withEnvAsync({ NODE_ENV: 'production', VERCEL: undefined, CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: 'true' }, async () => {
    assert.equal(guard.unverifiedUsageAllowed(), false);

    const result = await guard.reserveClaim({});
    assert.equal(result.allowed, false, 'production must refuse rather than run unmetered');
    assert.equal(result.reason, 'USAGE_UNVERIFIED');
    assert.equal(result.status, 503);
  });
});

test('the escape hatch is inert on Vercel even without NODE_ENV', async () => {
  // A deployment that never set NODE_ENV is still a deployment. VERCEL is set
  // by the platform itself and cannot be forgotten.
  await withEnvAsync({ NODE_ENV: undefined, VERCEL: '1', CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: 'true' }, async () => {
    assert.equal(guard.unverifiedUsageAllowed(), false);

    const result = await guard.reserveClaim({});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'USAGE_UNVERIFIED');
  });
});

test('no truthy spelling of the escape hatch works in production', async () => {
  for (const value of ['true', '1', 'yes', 'TRUE', 'Yes']) {
    await withEnvAsync({ NODE_ENV: 'production', CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: value }, async () => {
      const result = await guard.reserveClaim({});
      assert.equal(result.allowed, false, `"${value}" must not bypass metering in production`);
    });
  }
});

test('every paid route refuses in production when Supabase credentials are absent', async () => {
  // The scenario stated in the requirement: credentials removed or lost, in
  // production, with the hatch set. Every layer must still refuse.
  await withEnvAsync({ NODE_ENV: 'production', CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: 'true' }, async () => {
    assert.equal(guard.enforcementAvailable(), false, 'precondition: no credentials');

    for (const scenario of [
      { label: 'public route', args: {} },
      { label: 'classroom route', args: { classroom: { id: '11111111-1111-4111-8111-111111111111' }, studentId: '22222222-2222-4222-8222-222222222222' } },
    ]) {
      const result = await guard.reserveClaim(scenario.args);
      assert.equal(result.allowed, false, `${scenario.label} must refuse`);
      assert.equal(result.status, 503, `${scenario.label} must return 503`);
    }
  });
});

test('the hatch still works outside production, which is its only purpose', async () => {
  await withEnvAsync({ NODE_ENV: 'development', VERCEL: undefined, CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: 'true' }, async () => {
    const result = await guard.reserveClaim({});
    assert.equal(result.allowed, true);
    assert.equal(result.enforced, false);
  });

  // And is still off by default there.
  await withEnvAsync({ NODE_ENV: 'development', VERCEL: undefined, CLAIMCHECK_ALLOW_UNVERIFIED_USAGE: undefined }, async () => {
    const result = await guard.reserveClaim({});
    assert.equal(result.allowed, false);
  });
});

test('isProductionLike recognises both signals independently', () => {
  withEnv({ NODE_ENV: 'production', VERCEL: undefined }, () => assert.equal(guard.isProductionLike(), true));
  withEnv({ NODE_ENV: undefined, VERCEL: '1' }, () => assert.equal(guard.isProductionLike(), true));
  withEnv({ NODE_ENV: 'production', VERCEL: '1' }, () => assert.equal(guard.isProductionLike(), true));
  withEnv({ NODE_ENV: 'test', VERCEL: undefined }, () => assert.equal(guard.isProductionLike(), false));
  withEnv({ NODE_ENV: undefined, VERCEL: undefined }, () => assert.equal(guard.isProductionLike(), false));
});

test('releasing a refused reservation is a no-op', async () => {
  // A refusal never took a reservation, so there is nothing to give back.
  // Releasing one anyway must not reach the database or throw.
  const refused = await guard.reserveClaim({});
  assert.equal(refused.allowed, false);
  await guard.releaseClaim(refused, {}); // resolves without error
});

/* ── Billability of a failed analysis ─────────────────────────────────── */

test('a failure that never reached the provider is not billable', () => {
  const err = new Error('Anthropic API 401: invalid key');
  err.usage = { input_tokens: 0, output_tokens: 0, web_search_requests: 0 };
  assert.equal(guard.wasBillable(err), false);
});

test('a failure after real provider work is billable', () => {
  const err = new Error('timed out on turn 3');
  err.usage = { input_tokens: 8000, output_tokens: 200, web_search_requests: 2 };
  assert.equal(guard.wasBillable(err), true);
});

test('a search with no tokens still counts as billable', () => {
  // Web searches are billed per request, separately from tokens. Treating a
  // zero-token failure as free would give away searches that were paid for.
  const err = new Error('failed');
  err.usage = { input_tokens: 0, output_tokens: 0, web_search_requests: 1 };
  assert.equal(guard.wasBillable(err), true);
});

test('a failure with no usage information is assumed billable', () => {
  // Over-counting costs a student one claim; under-counting is a hole in the
  // budget. When in doubt, keep the charge.
  assert.equal(guard.wasBillable(new Error('something else broke')), true);
  assert.equal(guard.wasBillable(null), true);
});
