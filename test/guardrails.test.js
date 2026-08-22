'use strict';

/* End-to-end tests for the usage guardrails, driven through real HTTP requests
 * against the real Express app.
 *
 * Both external dependencies are replaced at the fetch boundary rather than by
 * stubbing our own modules, so everything between the socket and the provider
 * call — routing, validation, the student-id header, the reservation, the
 * refund path — is the code that actually ships.
 *
 * The Supabase fake reimplements claimcheck_reserve_claim's decision logic in
 * JavaScript. What that can and cannot prove is spelled out at the concurrency
 * test below.
 */

// Must be set before anything requires lib/supabase-admin, which reads the
// Supabase URL at module load.
process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-credential';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const app = require('../server');
const classroomLib = require('../lib/classroom');

const SUPABASE = 'https://fake-project.supabase.co';
const realFetch = globalThis.fetch;

/* ── In-memory stand-in for the database ──────────────────────────────── */

/**
 * Holds the state the guardrails read and write, and implements the two RPCs.
 *
 * The reservation handler runs to completion without awaiting anything, which
 * is what makes it atomic under Node's single-threaded model — the analogue of
 * the row locks the real function takes.
 */
function makeDb() {
  return {
    classrooms: new Map(),   // id -> row
    students: new Map(),     // `${classroomId}:${studentId}` -> claims_used
    global: new Map(),       // `${kind}:${key}` -> claims_used
    limits: { student: 12, classroom: 300, daily: 1000, monthly: 15000 },

    addClassroom(overrides = {}) {
      const row = {
        id: crypto.randomUUID(),
        owner_id: crypto.randomUUID(),
        display_name: 'Period 3 Civics',
        access_code: 'ABCD2345',
        session_secret: crypto.randomBytes(32).toString('hex'),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        active: true,
        token_budget: 100000,
        tokens_used: 0,
        analyses_run: 0,
        searches_used: 0,
        claims_used: 0,
        claim_limit: null,
        claim_limit_per_student: null,
        expected_students: null,
        ...overrides,
      };
      this.classrooms.set(row.id, row);
      return row;
    },

    reserve(args) {
      const {
        p_classroom_id: classroomId,
        p_student_id: studentId,
        p_student_limit: studentLimitIn,
        p_classroom_limit: classroomLimitIn,
        p_daily_limit: dailyLimit,
        p_monthly_limit: monthlyLimit,
        p_day: day,
        p_month: month,
      } = args;

      const dayKey = `day:${day}`;
      const monthKey = `month:${month}`;
      const dayUsed = this.global.get(dayKey) || 0;
      const monthUsed = this.global.get(monthKey) || 0;

      let classUsed = 0;
      let classLimit = classroomLimitIn || 0;
      let studentUsed = 0;
      let studentLimit = studentLimitIn || 0;
      let studentKey = null;

      if (classroomId) {
        const room = this.classrooms.get(classroomId);
        if (!room) {
          return { allowed: false, reason: 'NO_CLASSROOM', student_used: 0, student_cap: 0, classroom_used: 0, classroom_cap: 0 };
        }
        classUsed = room.claims_used;
        if (room.claim_limit !== null) classLimit = room.claim_limit;
        if (room.claim_limit_per_student !== null) studentLimit = room.claim_limit_per_student;

        if (studentId) {
          studentKey = `${classroomId}:${studentId}`;
          studentUsed = this.students.get(studentKey) || 0;
        }
      }

      let reason = null;
      if (dailyLimit > 0 && dayUsed >= dailyLimit) reason = 'GLOBAL_LIMIT';
      else if (monthlyLimit > 0 && monthUsed >= monthlyLimit) reason = 'GLOBAL_LIMIT';
      else if (classroomId && classLimit > 0 && classUsed >= classLimit) reason = 'CLASSROOM_LIMIT';
      else if (classroomId && studentId && studentLimit > 0 && studentUsed >= studentLimit) reason = 'STUDENT_LIMIT';

      if (reason) {
        return { allowed: false, reason, student_used: studentUsed, student_cap: studentLimit, classroom_used: classUsed, classroom_cap: classLimit };
      }

      this.global.set(dayKey, dayUsed + 1);
      this.global.set(monthKey, monthUsed + 1);
      if (classroomId) {
        this.classrooms.get(classroomId).claims_used = classUsed + 1;
        classUsed += 1;
        if (studentKey) {
          this.students.set(studentKey, studentUsed + 1);
          studentUsed += 1;
        }
      }
      return { allowed: true, reason: null, student_used: studentUsed, student_cap: studentLimit, classroom_used: classUsed, classroom_cap: classLimit };
    },

    release(args) {
      const { p_classroom_id: classroomId, p_student_id: studentId, p_day: day, p_month: month } = args;
      const dec = (map, key) => map.set(key, Math.max(0, (map.get(key) || 0) - 1));
      dec(this.global, `day:${day}`);
      dec(this.global, `month:${month}`);
      if (classroomId && this.classrooms.has(classroomId)) {
        const room = this.classrooms.get(classroomId);
        room.claims_used = Math.max(0, room.claims_used - 1);
        if (studentId) dec(this.students, `${classroomId}:${studentId}`);
      }
      return null;
    },
  };
}

/* ── Anthropic stand-in ───────────────────────────────────────────────── */

const MODEL_JSON = JSON.stringify({
  claim_text: 'Coffee reduces type 2 diabetes risk.',
  verdict: 'supported',
  confidence: 'medium',
  verdict_explanation: 'Observational studies show an association.',
  breakdown: {},
  supporting_evidence: [],
  contradicting_evidence: [],
  reflection_questions: [],
});

/** A successful single-turn analysis that reports having spent tokens. */
function anthropicSuccess() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: MODEL_JSON }],
      usage: { input_tokens: 1200, output_tokens: 400 },
    }),
    text: async () => '',
  };
}

/** An auth rejection: the request was refused, so nothing was billed. */
function anthropicAuthFailure() {
  return {
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"invalid api key"}}',
    json: async () => ({}),
  };
}

/* ── Harness ──────────────────────────────────────────────────────────── */

let db;
let server;
let baseUrl;
let anthropicResponder;
let anthropicCalls;
let articleHtml;

function installFetchStub() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.startsWith('https://api.anthropic.com/')) {
      anthropicCalls += 1;
      return anthropicResponder();
    }

    if (articleHtml && url.startsWith('https://example.com/')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
        text: async () => articleHtml,
        url,
      };
    }

    if (url.startsWith(SUPABASE)) {
      const path = url.slice(`${SUPABASE}/rest/v1/`.length);
      const body = init.body ? JSON.parse(init.body) : null;
      const ok = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

      if (path === 'rpc/claimcheck_reserve_claim') return ok([db.reserve(body)]);
      if (path === 'rpc/claimcheck_release_claim') return ok(db.release(body));
      if (path === 'rpc/classroom_record_usage') {
        const room = db.classrooms.get(body.p_classroom_id);
        if (room) {
          room.tokens_used += body.p_tokens;
          room.searches_used += body.p_searches;
          room.analyses_run += 1;
        }
        return ok(room ? [{ tokens_used: room.tokens_used, token_budget: room.token_budget }] : []);
      }

      if (path.startsWith('classrooms?id=eq.')) {
        const id = decodeURIComponent(path.slice('classrooms?id=eq.'.length).split('&')[0]);
        const room = db.classrooms.get(id);
        return ok(room ? [room] : []);
      }

      if (path.startsWith('classroom_student_usage?')) {
        const classroomId = decodeURIComponent((path.match(/classroom_id=eq\.([^&]+)/) || [])[1] || '');
        const studentId = decodeURIComponent((path.match(/student_id=eq\.([^&]+)/) || [])[1] || '');
        const used = db.students.get(`${classroomId}:${studentId}`);
        return ok(used === undefined ? [] : [{ claims_used: used }]);
      }

      return ok([]);
    }

    return realFetch(input, init);
  };
}

test.before(async () => {
  installFetchStub();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  db = makeDb();
  anthropicResponder = anthropicSuccess;
  anthropicCalls = 0;
  articleHtml = null;
});

/** Posts JSON to the app under test, bypassing the fetch stub's own routing. */
async function post(path, body, headers = {}) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, raw: text };
}

/** A classroom plus a joined student, ready to submit claims. */
function joinedStudent(overrides = {}) {
  const room = db.addClassroom(overrides);
  return {
    room,
    headers: {
      'X-Classroom-Session': classroomLib.mintSessionToken(room),
      'X-Claimcheck-Student': crypto.randomUUID(),
    },
  };
}

const claimOf = (n) => 'a'.repeat(n);

/* ── 1-3. The character limit ─────────────────────────────────────────── */

test('a 749-character claim is accepted', async () => {
  const { headers } = joinedStudent();
  const res = await post('/api/classroom/analyze', { text: claimOf(749) }, headers);
  assert.equal(res.status, 200);
  assert.equal(anthropicCalls, 1);
});

test('a claim of exactly 750 characters is accepted', async () => {
  const { headers } = joinedStudent();
  const res = await post('/api/classroom/analyze', { text: claimOf(750) }, headers);
  assert.equal(res.status, 200);
  assert.equal(anthropicCalls, 1);
});

test('a 751-character claim is rejected before any provider request', async () => {
  const { headers } = joinedStudent();
  const res = await post('/api/classroom/analyze', { text: claimOf(751) }, headers);

  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'CLAIM_TOO_LONG');
  assert.equal(res.body.maxClaimCharacters, 750);
  assert.match(res.body.error, /750 characters/);
  assert.match(res.body.error, /narrowing this down/i);
  assert.equal(anthropicCalls, 0, 'an over-long claim must not reach the provider');
});

test('the character limit is enforced even when the browser is bypassed entirely', async () => {
  // The whole point of the server-side copy: this request never ran any client
  // code, so client validation is not in the picture at all.
  const res = await post('/analyze', { text: claimOf(5000) });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'CLAIM_TOO_LONG');
  assert.equal(anthropicCalls, 0);
});

/* ── 13. Validation failures cost nothing ─────────────────────────────── */

test('a claim rejected for length does not consume the student allowance', async () => {
  const { room, headers } = joinedStudent();
  const key = `${room.id}:${headers['X-Claimcheck-Student']}`;

  await post('/api/classroom/analyze', { text: claimOf(751) }, headers);
  await post('/api/classroom/analyze', { text: '' }, headers);
  await post('/api/classroom/analyze', { text: 'short' }, headers);

  assert.equal(db.students.get(key), undefined, 'no counter row should even exist yet');
  assert.equal(room.claims_used, 0);
  assert.equal(db.global.get(`day:${new Date().toISOString().slice(0, 10)}`), undefined);
});

/* ── 6. Independent tracking across classrooms ────────────────────────── */

test('the same anonymous id in two classrooms has two independent allowances', async () => {
  const studentId = crypto.randomUUID();
  const roomA = db.addClassroom({ display_name: 'A' });
  const roomB = db.addClassroom({ display_name: 'B' });

  const headersFor = (room) => ({
    'X-Classroom-Session': classroomLib.mintSessionToken(room),
    'X-Claimcheck-Student': studentId,
  });

  for (let i = 0; i < 4; i++) {
    await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headersFor(roomA));
  }
  await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headersFor(roomB));

  assert.equal(db.students.get(`${roomA.id}:${studentId}`), 4);
  assert.equal(db.students.get(`${roomB.id}:${studentId}`), 1, 'classroom B must not see classroom A usage');
});

/* ── 7-8. The per-student limit ───────────────────────────────────────── */

test('a student may submit up to the configured limit, and no further', async () => {
  const { room, headers } = joinedStudent();
  const text = 'A real claim to check here.';

  for (let i = 1; i <= 12; i++) {
    const res = await post('/api/classroom/analyze', { text }, headers);
    assert.equal(res.status, 200, `claim ${i} of 12 should succeed`);
  }
  assert.equal(anthropicCalls, 12);

  const blocked = await post('/api/classroom/analyze', { text }, headers);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'STUDENT_LIMIT');
  assert.match(blocked.body.error, /12-claim limit/);
  assert.match(blocked.body.error, /instructor/i);
  assert.equal(anthropicCalls, 12, 'the refused request must not reach the provider');
  assert.equal(db.students.get(`${room.id}:${headers['X-Claimcheck-Student']}`), 12);
});

test('one student hitting their limit does not block another student', async () => {
  const room = db.addClassroom();
  const token = classroomLib.mintSessionToken(room);
  const text = 'A real claim to check here.';
  const exhausted = { 'X-Classroom-Session': token, 'X-Claimcheck-Student': crypto.randomUUID() };
  const fresh = { 'X-Classroom-Session': token, 'X-Claimcheck-Student': crypto.randomUUID() };

  for (let i = 0; i < 12; i++) await post('/api/classroom/analyze', { text }, exhausted);
  assert.equal((await post('/api/classroom/analyze', { text }, exhausted)).status, 429);
  assert.equal((await post('/api/classroom/analyze', { text }, fresh)).status, 200);
});

test('a classroom request without an anonymous id is refused', async () => {
  // Accepting it would make the per-student limit optional for any client
  // willing to leave a header off.
  const room = db.addClassroom();
  const res = await post(
    '/api/classroom/analyze',
    { text: 'A real claim to check here.' },
    { 'X-Classroom-Session': classroomLib.mintSessionToken(room) }
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_STUDENT_ID');
  assert.equal(anthropicCalls, 0);
});

/* ── 9. The classroom limit ───────────────────────────────────────────── */

test('the classroom limit stops further requests once the class is exhausted', async () => {
  // A small class limit with a large per-student one, so the classroom gate is
  // unambiguously the thing that fires.
  const { room, headers } = joinedStudent({ claim_limit: 3, claim_limit_per_student: 100 });
  const text = 'A real claim to check here.';

  for (let i = 0; i < 3; i++) {
    assert.equal((await post('/api/classroom/analyze', { text }, headers)).status, 200);
  }

  const blocked = await post('/api/classroom/analyze', { text }, headers);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'CLASSROOM_LIMIT');
  assert.match(blocked.body.error, /classroom has reached its ClaimCheck usage limit/i);
  assert.equal(anthropicCalls, 3);
  assert.equal(room.claims_used, 3);
});

test('the classroom limit applies across all its students, not per student', async () => {
  const room = db.addClassroom({ claim_limit: 2, claim_limit_per_student: 100 });
  const token = classroomLib.mintSessionToken(room);
  const text = 'A real claim to check here.';
  const student = () => ({ 'X-Classroom-Session': token, 'X-Claimcheck-Student': crypto.randomUUID() });

  assert.equal((await post('/api/classroom/analyze', { text }, student())).status, 200);
  assert.equal((await post('/api/classroom/analyze', { text }, student())).status, 200);

  const third = await post('/api/classroom/analyze', { text }, student());
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'CLASSROOM_LIMIT');
});

/* ── 10-11. The global budget ─────────────────────────────────────────── */

test('the global daily limit stops requests once it is reached', async () => {
  const today = new Date().toISOString().slice(0, 10);
  db.global.set(`day:${today}`, 1000);

  const { headers } = joinedStudent();
  const res = await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'GLOBAL_LIMIT');
  assert.equal(anthropicCalls, 0, 'no paid provider request may be made once the account budget is spent');
});

test('the global monthly limit stops requests once it is reached', async () => {
  const month = new Date().toISOString().slice(0, 7);
  db.global.set(`month:${month}`, 15000);

  const { headers } = joinedStudent();
  const res = await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'GLOBAL_LIMIT');
  assert.equal(anthropicCalls, 0);
});

test('the global budget covers the public site as well as classrooms', async () => {
  db.global.set(`day:${new Date().toISOString().slice(0, 10)}`, 1000);

  const res = await post('/analyze', { text: 'A real claim to check here.' });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'GLOBAL_LIMIT');
  assert.equal(anthropicCalls, 0);
});

test('the global limit message reveals nothing about budgets, spending, or providers', async () => {
  db.global.set(`day:${new Date().toISOString().slice(0, 10)}`, 1000);
  const res = await post('/analyze', { text: 'A real claim to check here.' });

  const message = res.body.error;
  assert.match(message, /temporarily unavailable/i);
  for (const leak of [/anthropic/i, /claude/i, /openai/i, /perplexity/i, /token/i, /credit/i, /\$/, /\bapi key\b/i, /\b1000\b/, /\b15000\b/]) {
    assert.doesNotMatch(message, leak, `message must not mention ${leak}`);
  }
});

/* ── Fail-closed when quota state cannot be determined ────────────────── */

/**
 * Makes every Supabase reservation call fail, as an outage or an unapplied
 * migration would. Classroom lookups still work, so the request gets all the
 * way to the quota check before anything goes wrong — which is the case that
 * matters.
 */
function breakReservations(mode = 'throw') {
  const previous = db.reserve;
  db.reserve = () => {
    if (mode === 'throw') throw new Error('relation "global_usage" does not exist');
    return null; // a successful call that returned nothing
  };
  return () => { db.reserve = previous; };
}

test('a database failure refuses the request instead of spending money', async () => {
  const { headers } = joinedStudent();
  const restore = breakReservations('throw');

  try {
    const res = await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'USAGE_UNVERIFIED');
    assert.equal(anthropicCalls, 0, 'no paid provider call may happen when the quota is unknown');
  } finally {
    restore();
  }
});

test('an unapplied migration refuses the request too', async () => {
  // A reservation RPC that does not exist returns no row rather than throwing.
  // Same conclusion: quota state is unknown, so nothing is spent.
  const { headers } = joinedStudent();
  const restore = breakReservations('null');

  try {
    const res = await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'USAGE_UNVERIFIED');
    assert.equal(anthropicCalls, 0);
  } finally {
    restore();
  }
});

test('the public claim route fails closed as well', async () => {
  const restore = breakReservations('throw');
  try {
    const res = await post('/analyze', { text: 'A real claim to check here.' });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'USAGE_UNVERIFIED');
    assert.equal(anthropicCalls, 0);
  } finally {
    restore();
  }
});

test('the URL routes fail closed as well', async () => {
  articleHtml = longArticleHtml();
  const restore = breakReservations('throw');
  try {
    const pub = await post('/analyze-url', { url: 'https://example.com/news/coffee' });
    assert.equal(pub.status, 503);
    assert.equal(pub.body.code, 'USAGE_UNVERIFIED');

    const { headers } = joinedStudent();
    const room = await post('/api/classroom/analyze-url', { url: 'https://example.com/news/coffee' }, headers);
    assert.equal(room.status, 503);
    assert.equal(room.body.code, 'USAGE_UNVERIFIED');

    assert.equal(anthropicCalls, 0, 'every paid route must fail closed');
  } finally {
    restore();
  }
});

test('the fail-closed message says nothing about the database', async () => {
  const restore = breakReservations('throw');
  try {
    const res = await post('/analyze', { text: 'A real claim to check here.' });
    const message = res.body.error;

    assert.match(message, /temporarily unable to verify usage limits/i);
    assert.match(message, /try again shortly/i);
    for (const leak of [/supabase/i, /postgres/i, /database/i, /relation/i, /sql/i, /global_usage/i, /anthropic/i, /claude/i]) {
      assert.doesNotMatch(message, leak, `message must not mention ${leak}`);
    }
  } finally {
    restore();
  }
});

test('a fail-closed refusal is distinguishable from an exhausted budget', async () => {
  // Same 503, different codes and different copy: one is "come back later",
  // the other is "the account is out". Collapsing them would mislead.
  db.global.set(`day:${new Date().toISOString().slice(0, 10)}`, 1000);
  const exhausted = await post('/analyze', { text: 'A real claim to check here.' });

  db.global.clear();
  const restore = breakReservations('throw');
  let unverified;
  try {
    unverified = await post('/analyze', { text: 'A real claim to check here.' });
  } finally {
    restore();
  }

  assert.equal(exhausted.body.code, 'GLOBAL_LIMIT');
  assert.equal(unverified.body.code, 'USAGE_UNVERIFIED');
  assert.notEqual(exhausted.body.error, unverified.body.error);
});

/* ── 12. Concurrency ──────────────────────────────────────────────────── */

test('simultaneous requests cannot exceed the configured limit', async () => {
  // What this proves: the application performs its check and its increment as
  // ONE operation, so twenty in-flight requests cannot all observe the same
  // pre-increment count. It does not, and cannot, prove that Postgres itself
  // serializes them — that comes from the FOR UPDATE row locks in
  // claimcheck_reserve_claim, which have no in-process equivalent to assert
  // against. The failure this catches is the one that lives in our code:
  // reading the count in Node and writing it back in a separate round trip.
  const { room, headers } = joinedStudent({ claim_limit: 1000, claim_limit_per_student: 12 });
  const text = 'A real claim to check here.';

  const results = await Promise.all(
    Array.from({ length: 20 }, () => post('/api/classroom/analyze', { text }, headers))
  );

  const accepted = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status === 429).length;

  assert.equal(accepted, 12, 'exactly the allowance should be granted, no more');
  assert.equal(refused, 8);
  assert.equal(anthropicCalls, 12, 'the provider must be called once per granted claim and no more');
  assert.equal(db.students.get(`${room.id}:${headers['X-Claimcheck-Student']}`), 12);
});

/* ── 9 (cont). Provider failures and refunds ──────────────────────────── */

test('a failure before any billable provider work returns the reservation', async () => {
  anthropicResponder = anthropicAuthFailure;
  const { room, headers } = joinedStudent();

  const res = await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);
  assert.equal(res.status, 502);

  assert.equal(db.students.get(`${room.id}:${headers['X-Claimcheck-Student']}`), 0,
    'a rejected API key spends nothing, so it must cost no allowance');
  assert.equal(room.claims_used, 0);
  assert.equal(db.global.get(`day:${new Date().toISOString().slice(0, 10)}`), 0);
});

test('a successful analysis consumes exactly one claim at every layer', async () => {
  const { room, headers } = joinedStudent();
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);

  assert.equal(db.students.get(`${room.id}:${headers['X-Claimcheck-Student']}`), 1);
  assert.equal(room.claims_used, 1);
  assert.equal(db.global.get(`day:${today}`), 1);
  assert.equal(db.global.get(`month:${month}`), 1);
});

/* ── 15. The URL workflow still works ─────────────────────────────────── */

/**
 * A readable article whose body is far longer than the claim limit.
 *
 * Built as real HTML and served through the fetch stub, so the request goes
 * through the actual extractor rather than a stubbed-out one — otherwise this
 * test would pass even if the route had been broken.
 */
function longArticleHtml(paragraphs = 40) {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<p>Paragraph ${i + 1}. Researchers reported this week that regular coffee consumption ` +
    'was associated with a measurably lower incidence of type 2 diabetes across a large ' +
    'longitudinal cohort, though the authors cautioned that the association is not ' +
    'evidence of causation and that confounding lifestyle factors remain plausible.</p>'
  ).join('\n');
  return `<!DOCTYPE html><html><head><title>Coffee and diabetes risk</title></head>` +
         `<body><article><h1>Coffee and diabetes risk</h1>${body}</article></body></html>`;
}

test('article-URL analysis is not subject to the claim character limit', async () => {
  // Extracted article text is routinely far longer than 750 characters. The cap
  // belongs to the claim box; applying it here would break the feature outright.
  articleHtml = longArticleHtml();
  assert.ok(articleHtml.length > 6000, 'the fixture must exceed the claim limit many times over');

  const res = await post('/analyze-url', { url: 'https://example.com/news/coffee' });

  assert.equal(res.status, 200, `expected the article to analyze, got ${res.raw.slice(0, 200)}`);
  assert.equal(res.body.verdict, 'supported');
  assert.equal(res.body._article.title, 'Coffee and diabetes risk');
  assert.equal(anthropicCalls, 1, 'the article should have reached the analysis pipeline');
});

test('a long article still consumes exactly one claim from the global budget', async () => {
  articleHtml = longArticleHtml();
  const today = new Date().toISOString().slice(0, 10);

  await post('/analyze-url', { url: 'https://example.com/news/coffee' });

  assert.equal(db.global.get(`day:${today}`), 1);
});

test('a URL that could not be read costs no allowance', async () => {
  // Extraction is a plain fetch, not a provider call. A page we never reached
  // must not spend a ClaimCheck.
  const today = new Date().toISOString().slice(0, 10);
  const res = await post('/analyze-url', { url: 'http://127.0.0.1:1/blocked' });

  assert.notEqual(res.status, 200);
  assert.equal(db.global.get(`day:${today}`), undefined, 'nothing should have been reserved');
  assert.equal(anthropicCalls, 0);
});

/* ── The public claim workflow is unchanged otherwise ─────────────────── */

test('an ordinary public claim analysis still succeeds', async () => {
  const res = await post('/analyze', { text: 'Coffee reduces the risk of type 2 diabetes.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, 'supported');
  assert.equal(anthropicCalls, 1);
});

test('/api/limits publishes the character cap and nothing else', async () => {
  const res = await realFetch(`${baseUrl}/api/limits`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.maxClaimCharacters, 750);
  // Per-student, classroom, and account budgets are decided per request and are
  // deliberately not published to the browser.
  assert.deepEqual(Object.keys(body), ['maxClaimCharacters']);
});
