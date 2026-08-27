'use strict';

/* How a classroom's ClaimCheck allowance and its token ceiling are sized.
 *
 * These are pure calculations, so they are tested directly rather than through
 * HTTP. The enforcement that acts on them — reserving, refusing, releasing —
 * lives in guardrails.test.js, which drives the real app.
 *
 * The number these tests exist to protect is the one a teacher reads on the
 * create form. "25 students x 4 ClaimChecks = 100" has to be arithmetic the
 * server actually performs, because it is a promise made in the teacher's own
 * units. Every regression here is a promise quietly broken.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../lib/limits');
const classroom = require('../lib/classroom');
const routes = require('../lib/classroom-routes');

/** Runs `fn` with environment overrides, restoring whatever was there before. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ── 1. Capacity from the two numbers a teacher understands ───────────── */

test('class size x ClaimChecks per student is the classroom capacity', () => {
  assert.equal(limits.classroomCapacity({ expectedStudents: 25, claimsPerStudent: 4 }), 100);
  assert.equal(limits.classroomCapacity({ expectedStudents: 5, claimsPerStudent: 3 }), 15);
  assert.equal(limits.classroomCapacity({ expectedStudents: 30, claimsPerStudent: 5 }), 150);
  assert.equal(limits.classroomCapacity({ expectedStudents: 1, claimsPerStudent: 1 }), 1);
});

test('the default headroom is exactly none, so the printed arithmetic is the real arithmetic', () => {
  // A teacher shown "100 ClaimChecks" who silently received 110 would be
  // reading a number the system does not mean. Headroom stays configurable for
  // an operator who wants it; it is simply not on by default.
  assert.equal(limits.DEFAULTS.CLASSROOM_HEADROOM_PERCENT, 100);
  assert.equal(limits.classroomCapacity({ expectedStudents: 25, claimsPerStudent: 4 }), 25 * 4);

  withEnv({ CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 110 }, () => {
    assert.equal(limits.classroomCapacity({ expectedStudents: 25, claimsPerStudent: 4 }), 110);
  });
});

test('the shipped default for ClaimChecks per student is 4', () => {
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: undefined }, () => {
    assert.equal(limits.DEFAULTS.STUDENT_SESSION_LIMIT, 4);
    assert.equal(limits.studentSessionLimit(), 4);
  });
});

test('blank fields fall back to defaults rather than disabling the calculation', () => {
  withEnv({
    CLAIMCHECK_DEFAULT_EXPECTED_STUDENTS: undefined,
    CLAIMCHECK_STUDENT_SESSION_LIMIT: undefined,
    CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: undefined,
  }, () => {
    // Neither field given: both defaults, and they are chosen to agree with the
    // flat classroom default (25 x 4 = 100).
    assert.equal(limits.classroomCapacity({}), 100);
    assert.equal(limits.classroomCapacity({ expectedStudents: null, claimsPerStudent: null }), 100);
    assert.equal(limits.classroomCapacity({ expectedStudents: '', claimsPerStudent: '' }), 100);

    // One field given: the other still defaults.
    assert.equal(limits.classroomCapacity({ expectedStudents: 10 }), 40);
    assert.equal(limits.classroomCapacity({ claimsPerStudent: 6 }), 150);
  });
});

test('no value for ClaimChecks per student produces an unlimited classroom', () => {
  // 0 used to multiply out to 0, which every gate reads as "no limit". Nothing
  // reaches that state now: an out-of-range value is treated as a blank field
  // and falls back to the default, and the route refuses it outright besides.
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 4, CLAIMCHECK_DEFAULT_EXPECTED_STUDENTS: 25 }, () => {
    for (const bad of [0, -1, -100, 21, 5000, 'lots', NaN, Infinity]) {
      const capacity = limits.classroomCapacity({ expectedStudents: 25, claimsPerStudent: bad });
      assert.ok(Number.isFinite(capacity) && capacity >= 1,
        `claimsPerStudent=${bad} produced ${capacity}`);
      assert.equal(capacity, 100, `claimsPerStudent=${bad} must fall back to the default`);
    }
  });
});

test('a negative or nonsense class size falls back rather than going negative', () => {
  withEnv({ CLAIMCHECK_DEFAULT_EXPECTED_STUDENTS: 25, CLAIMCHECK_STUDENT_SESSION_LIMIT: 4 }, () => {
    for (const bad of [0, -5, 'twenty', NaN, 1001]) {
      assert.equal(limits.classroomCapacity({ expectedStudents: bad, claimsPerStudent: 4 }), 100,
        `expectedStudents=${bad} must fall back to the default roster`);
    }
  });
});

test('capacity is always a finite number of at least one ClaimCheck', () => {
  // Brute force over everything a body parser can hand this function. There is
  // no combination that yields 0, a negative, NaN, or Infinity — which is what
  // "no unlimited classrooms" has to mean at the arithmetic level.
  const inputs = [undefined, null, '', 0, -1, 1, 20, 21, 1000, 1001, NaN, Infinity, 'x', true, [], {}];
  for (const students of inputs) {
    for (const per of inputs) {
      const capacity = limits.classroomCapacity({ expectedStudents: students, claimsPerStudent: per });
      assert.ok(
        Number.isFinite(capacity) && capacity >= 1 && capacity <= limits.DEFAULTS.MAX_CLASSROOM_CLAIM_LIMIT,
        `classroomCapacity(${JSON.stringify(students)}, ${JSON.stringify(per)}) = ${capacity}`
      );
    }
  }
});

/* ── 2. A stored classroom resolves to the same capacity ──────────────── */

test('a classroom row derives its allowance from its OWN per-student value', () => {
  // The bug this pins: defaultClassroomClaimLimit used to read the SERVER's
  // per-student limit and ignore the classroom's, so a teacher who asked for
  // "25 x 4" silently got 25 x 12. The two fields are one control.
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 12, CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 100 }, () => {
    assert.equal(
      limits.defaultClassroomClaimLimit({ expected_students: 25, claim_limit_per_student: 4 }),
      100
    );
    assert.equal(
      classroom.effectiveClaimLimit({ expected_students: 25, claim_limit_per_student: 4, claim_limit: null }),
      100
    );
  });
});

test('an explicit classroom limit beats the derived one', () => {
  assert.equal(
    classroom.effectiveClaimLimit({ claim_limit: 30, expected_students: 25, claim_limit_per_student: 4 }),
    30
  );
});

test('the API resolves capacity the same way the stored row does', () => {
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 12, CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 100 }, () => {
    // Test B from the brief: 25 students, 4 each, verified through the path the
    // create route actually takes.
    const { patch } = routes._internal.claimQuotaPatch({ expectedStudents: 25, claimLimitPerStudent: 4 });
    assert.equal(routes._internal.resolveClaimLimit(patch), 100);

    // Test A from the brief: 5 students, 3 each.
    const small = routes._internal.claimQuotaPatch({ expectedStudents: 5, claimLimitPerStudent: 3 });
    assert.equal(routes._internal.resolveClaimLimit(small.patch), 15);
  });
});

test('a classroom that recorded nothing at all keeps the flat server default', () => {
  withEnv({ CLAIMCHECK_CLASSROOM_SESSION_LIMIT: 300 }, () => {
    assert.equal(routes._internal.resolveClaimLimit({}), 300);
  });
});

/* ── 3. The token ceiling is sized from measured behaviour ────────────── */

test('the ceiling is sized per ClaimCheck, well above what one actually costs', () => {
  // Measured 2026-08-27 against the live pipeline: 26,556-50,240 tokens per
  // analysis, median ~29,000. The ceiling has to sit far enough above the
  // worst case that ordinary work never reaches it.
  const MEASURED_MEDIAN = 29080;
  const MEASURED_WORST = 50240;

  assert.ok(limits.tokenSafetyPerAnalysis() >= MEASURED_WORST,
    'one ClaimCheck must never be able to exhaust its own share of the ceiling');
  assert.ok(limits.tokenSafetyPerAnalysis() >= MEASURED_MEDIAN * 2.5,
    'the ceiling must leave room for a class that runs consistently expensive claims');
  assert.equal(limits.DEFAULTS.TOKEN_SAFETY_PER_ANALYSIS, 90000);
});

test('a correctly sized classroom is not exhausted by ordinary analyses', () => {
  // The regression that started all of this: a 15-ClaimCheck classroom died
  // after two analyses. Run the whole allowance at the worst cost observed and
  // confirm the ceiling is still not reached.
  const WORST_OBSERVED = 50240;

  for (const analyses of [15, 30, 75, 150, 300]) {
    const ceiling = limits.tokenSafetyLimitFor(analyses);
    assert.ok(
      ceiling > analyses * WORST_OBSERVED,
      `${analyses} ClaimChecks at the worst observed cost (${analyses * WORST_OBSERVED}) ` +
      `must fit inside the ceiling (${ceiling})`
    );
  }
});

test('the ceiling never drops below a floor, however small the classroom', () => {
  // A 1-ClaimCheck demo classroom must not be tripped by a single unusually
  // expensive analysis landing first.
  assert.equal(limits.tokenSafetyLimitFor(1), limits.minTokenSafetyLimit());
  assert.ok(limits.tokenSafetyLimitFor(1) > 50240 * 2);
});

test('a missing analysis limit still produces a ceiling, never none', () => {
  // There is nothing to size a ceiling from, so it falls back to the floor.
  // Returning 0 here — which every gate reads as "no ceiling" — would leave a
  // classroom able to spend without bound.
  const floor = limits.minTokenSafetyLimit();
  for (const bad of [0, null, undefined, NaN, -5, 'x']) {
    assert.equal(limits.tokenSafetyLimitFor(bad), floor, `tokenSafetyLimitFor(${bad})`);
  }
});

test('every classroom size yields a finite, positive ceiling', () => {
  for (const analyses of [1, 5, 15, 100, 300, 100000]) {
    const ceiling = limits.tokenSafetyLimitFor(analyses);
    assert.ok(Number.isFinite(ceiling) && ceiling > 0, `${analyses} -> ${ceiling}`);
    assert.ok(ceiling <= limits.DEFAULTS.MAX_TOKEN_SAFETY_LIMIT, `${analyses} -> ${ceiling}`);
  }
});

test('the per-analysis token allowance is configurable from the environment', () => {
  withEnv({ CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS: 120000, CLAIMCHECK_MIN_TOKEN_SAFETY_LIMIT: 60000 }, () => {
    assert.equal(limits.tokenSafetyPerAnalysis(), 120000);
    assert.equal(limits.tokenSafetyLimitFor(10), 1200000);
  });
  withEnv({ CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS: 200000 }, () => {
    assert.equal(limits.tokenSafetyLimitFor(15), 3000000);
  });
});

test('an invalid per-analysis override falls back to the measured default', () => {
  // Same convention as every other limit: a bad environment value degrades to
  // the documented default rather than disabling the guardrail it configures.
  // 0 is explicitly among the rejected values — it used to switch the ceiling
  // off for every classroom at once.
  for (const bad of ['ninety thousand', '', ' ', 0, -1, 59999, 5000001, 'NaN']) {
    withEnv({ CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS: bad }, () => {
      assert.equal(limits.tokenSafetyPerAnalysis(), 90000, `${JSON.stringify(bad)} must be refused`);
      assert.ok(limits.tokenSafetyLimitFor(100) > 0);
    });
  }
});

test('an invalid ceiling floor also falls back rather than removing the floor', () => {
  for (const bad of [0, -1, 'none']) {
    withEnv({ CLAIMCHECK_MIN_TOKEN_SAFETY_LIMIT: bad }, () => {
      assert.equal(limits.minTokenSafetyLimit(), 250000);
    });
  }
});

/* ── 4. Legacy rows keep working ──────────────────────────────────────── */

test('a row with no stored ceiling falls back to its old token budget', () => {
  // Mirrors coalesce(nullif(token_safety_limit,0), nullif(token_budget,0)) in
  // the database. The fallback exists so a row the migration never reached
  // keeps its old gate rather than losing one.
  assert.equal(classroom.effectiveTokenSafetyLimit({ token_safety_limit: null, token_budget: 50000 }), 50000);
  assert.equal(classroom.effectiveTokenSafetyLimit({ token_safety_limit: 1350000, token_budget: 50000 }), 1350000);
});

test('a stored 0 is read as "not set", never as "no ceiling"', () => {
  // 0 can no longer be written — every route refuses it — but a row from before
  // that validation, or one written by hand, must not become an unmetered
  // classroom just by being read.
  assert.equal(classroom.effectiveTokenSafetyLimit({ token_safety_limit: 0, token_budget: 50000 }), 50000);
  assert.equal(
    classroom.effectiveTokenSafetyLimit({ token_safety_limit: 0, token_budget: 0 }),
    limits.minTokenSafetyLimit()
  );
  assert.equal(classroom.effectiveTokenSafetyLimit({}), limits.minTokenSafetyLimit());
});

test('a stored ClaimCheck limit of 0 is read as "not set" too', () => {
  withEnv({ CLAIMCHECK_STUDENT_SESSION_LIMIT: 4, CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT: 100 }, () => {
    // Falls through to the roster derivation rather than becoming unlimited.
    assert.equal(
      classroom.effectiveClaimLimit({ claim_limit: 0, expected_students: 10, claim_limit_per_student: 4 }),
      40
    );
    // And a per-student 0 falls through to the server default.
    assert.equal(
      classroom.effectiveClaimLimitPerStudent({ claim_limit_per_student: 0 }),
      4
    );
  });
});

test('no stored classroom state produces an unlimited allowance', () => {
  // The read side of the invariant: whatever a row contains, both numbers a
  // classroom is gated on come back finite and positive.
  const rows = [
    {},
    { claim_limit: 0, claim_limit_per_student: 0, expected_students: 0, token_safety_limit: 0, token_budget: 0 },
    { claim_limit: null, claim_limit_per_student: null, expected_students: null, token_safety_limit: null },
    { claim_limit: -5, token_safety_limit: -5 },
  ];
  for (const row of rows) {
    const claims = classroom.effectiveClaimLimit(row);
    const ceiling = classroom.effectiveTokenSafetyLimit(row);
    assert.ok(Number.isFinite(claims) && claims >= 1, `claim limit ${claims} for ${JSON.stringify(row)}`);
    assert.ok(Number.isFinite(ceiling) && ceiling >= 1, `ceiling ${ceiling} for ${JSON.stringify(row)}`);
    assert.ok(Number.isFinite(classroom.remainingClaims({ ...row, claims_used: 0 })));
    assert.ok(Number.isFinite(classroom.remainingTokens({ ...row, tokens_used: 0 })));
  }
});

test('a classroom is out of ClaimChecks before it is out of tokens', () => {
  const room = {
    claim_limit: 15, claims_used: 15, claim_limit_per_student: null, expected_students: null,
    token_safety_limit: 1350000, tokens_used: 400000, active: true,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  assert.equal(classroom.remainingClaims(room), 0);
  assert.equal(classroom.tokensExhausted(room), false);
  assert.equal(classroom.isUsable(room), false, 'a class out of ClaimChecks stops accepting work');
});

/* ── 5. The token ceiling stays admin-only ────────────────────────────── */

test('the token ceiling override is bounded, and absent means "derive it"', () => {
  const parse = routes._internal.parseTokenSafetyLimit;

  assert.equal(parse(undefined), undefined, 'not sent means derive from the allowance');
  assert.equal(parse(''), undefined);
  assert.equal(parse(null), undefined);

  assert.equal(parse(1350000), 1350000);
  assert.equal(parse('2700000'), 2700000);

  assert.equal(parse(0), 'invalid', '0 no longer removes the ceiling — nothing does');
  assert.equal(parse(500), 'invalid', 'below the floor');
  assert.equal(parse(50000001), 'invalid', 'above the cap');
  assert.equal(parse('lots'), 'invalid');
  assert.equal(parse(-1), 'invalid');
});

/* ── 5b. Quota validation ─────────────────────────────────────────────── */

test('ClaimChecks per student is accepted only between 1 and 20', () => {
  const patch = (v) => routes._internal.claimQuotaPatch({ claimLimitPerStudent: v });

  for (const good of [1, 4, 20, '4', '20']) {
    assert.equal(patch(good).error, undefined, `${JSON.stringify(good)} must be accepted`);
    assert.equal(patch(good).patch.claim_limit_per_student, Number(good));
  }

  for (const bad of [0, -1, -20, 21, 100, 1000, 'four', 'NaN', '', ' ', NaN, Infinity, true, [], {}, [4]]) {
    if (bad === '' || bad === ' ') continue; // blank means "use the default"
    assert.ok(patch(bad).error, `${JSON.stringify(bad)} must be rejected`);
  }

  // Blank clears the override rather than setting a number.
  assert.equal(patch('').patch.claim_limit_per_student, null);
  assert.equal(patch(null).patch.claim_limit_per_student, null);
  // Not sent at all: leave whatever is stored alone.
  assert.equal('claim_limit_per_student' in routes._internal.claimQuotaPatch({}).patch, false);
});

test('expected class size is accepted only between 1 and 1000', () => {
  const patch = (v) => routes._internal.claimQuotaPatch({ expectedStudents: v });

  for (const good of [1, 25, 1000, '25']) {
    assert.equal(patch(good).error, undefined, `${JSON.stringify(good)} must be accepted`);
  }
  for (const bad of [0, -1, 1001, 'twenty', NaN, Infinity, true, {}]) {
    assert.ok(patch(bad).error, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('a fixed classroom capacity of 0 is rejected', () => {
  const patch = (v) => routes._internal.claimQuotaPatch({ claimLimit: v });

  assert.equal(patch(15).error, undefined);
  assert.ok(patch(0).error, '0 ClaimChecks is an unlimited classroom, not an empty one');
  assert.ok(patch(-1).error);
  assert.ok(patch(100001).error);
});

test('a rejected value names the range and the default', () => {
  // The error has to tell a teacher what to type instead. "Invalid input" sends
  // them back to guessing.
  const { error } = routes._internal.claimQuotaPatch({ claimLimitPerStudent: 0 });
  assert.match(error, /between 1 and 20/);
  assert.match(error, /blank/);
  assert.match(error, /default of 4/);
});

test('a 300-ClaimCheck classroom fits inside the accepted ceiling range', () => {
  // The old cap was 2,000,000, sized when an analysis was thought to cost
  // ~3,300 tokens. A full-size classroom now needs more than ten times that,
  // and a bound that rejects the system's own default is a bound that breaks
  // classroom creation.
  const ceiling = limits.tokenSafetyLimitFor(300);
  assert.ok(ceiling <= routes.limits.MAX_TOKEN_SAFETY_LIMIT,
    `the derived ceiling for 300 ClaimChecks (${ceiling}) must be an accepted value`);
  assert.equal(routes._internal.parseTokenSafetyLimit(ceiling), ceiling);
});

/* ── 6. Privacy ───────────────────────────────────────────────────────── */

test('nothing published to a student names or measures an individual', () => {
  const room = {
    id: '11111111-2222-3333-4444-555555555555',
    owner_id: 'owner-uuid', display_name: 'Period 3', access_code: 'ABCD2345',
    session_secret: 'secret-do-not-leak', expires_at: new Date(Date.now() + 3600000).toISOString(),
    active: true, claim_limit: 100, claims_used: 12, claim_limit_per_student: 4,
    expected_students: 25, token_safety_limit: 9000000, tokens_used: 350000,
    analyses_run: 12, searches_used: 24, token_budget: 100000,
  };

  const view = classroom.publicView(room);
  assert.deepEqual(Object.keys(view).sort(),
    ['claimsRemaining', 'claimsTotal', 'displayName', 'expiresAt', 'id'].sort());
  assert.equal(view.claimsTotal, 100);
  assert.equal(view.claimsRemaining, 88);

  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('secret-do-not-leak'), false);
  assert.equal(serialized.includes('ABCD2345'), false);
  assert.equal(serialized.includes('owner-uuid'), false);
});

test('the teacher view is a whole-class view with no per-student breakdown', () => {
  const room = {
    id: 'room-id', owner_id: 'owner', display_name: 'Period 3', access_code: 'ABCD2345',
    session_secret: 'secret-do-not-leak', created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(), active: true,
    claim_limit: 100, claims_used: 12, claim_limit_per_student: 4, expected_students: 25,
    token_safety_limit: 9000000, tokens_used: 350000, token_budget: 100000,
    analyses_run: 12, searches_used: 24,
  };

  const view = classroom.ownerView(room);
  assert.equal(view.claimsUsed, 12);
  assert.equal(view.claimsRemaining, 88);
  assert.equal(view.effectiveClaimLimit, 100);
  assert.equal(JSON.stringify(view).includes('secret-do-not-leak'), false);

  // Every count is an aggregate. There is no key here that could hold, or grow
  // into, a list of students — the anonymous per-classroom id exists precisely
  // so no such list can be assembled.
  for (const value of Object.values(view)) {
    assert.equal(Array.isArray(value), false, 'no per-student collection may appear in the teacher view');
  }
});

test('sizing a classroom needs a count and nothing else', () => {
  // expected_students is a number, never a roster. This pins the shape of the
  // inputs so a future "and their names" cannot be added without failing here.
  const { patch } = routes._internal.claimQuotaPatch({
    expectedStudents: 25,
    claimLimitPerStudent: 4,
    // Anything not on the allow-list is dropped rather than stored.
    studentNames: ['Ada', 'Grace'],
    rosterId: 'district-roster-9',
  });

  assert.deepEqual(Object.keys(patch).sort(), ['claim_limit_per_student', 'expected_students']);
  assert.equal(typeof patch.expected_students, 'number');
  assert.equal(typeof patch.claim_limit_per_student, 'number');
});
