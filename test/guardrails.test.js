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
const appLimits = require('../lib/limits');

const SUPABASE = 'https://fake-project.supabase.co';
const realFetch = globalThis.fetch;

// The one account the Supabase fake accepts as an approved educator. Fixed so
// a classroom created through the API is owned by a predictable id.
const TEACHER_ID = '00000000-0000-4000-8000-000000000001';

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
        // Sized the way the API sizes it: the default classroom allowance of
        // 300 ClaimChecks at 90,000 tokens each. Large enough that a test which
        // is not about the ceiling never trips it by accident.
        token_safety_limit: 27000000,
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
      let tokensUsed = 0;
      let tokenCap = 0;

      const out = (allowed, reason) => ({
        allowed, reason,
        student_used: studentUsed, student_cap: studentLimit,
        classroom_used: classUsed, classroom_cap: classLimit,
        tokens_used: tokensUsed, token_cap: tokenCap,
      });

      if (classroomId) {
        const room = this.classrooms.get(classroomId);
        if (!room) {
          return { allowed: false, reason: 'NO_CLASSROOM', student_used: 0, student_cap: 0, classroom_used: 0, classroom_cap: 0, tokens_used: 0, token_cap: 0 };
        }
        // Mirrors coalesce(nullif(col, 0), …) in claimcheck_reserve_claim: a
        // stored 0 means "not recorded", never "no limit". Reading a 0 straight
        // through would turn one bad row into an unmetered classroom.
        classUsed = room.claims_used;
        if (room.claim_limit) classLimit = room.claim_limit;
        if (room.claim_limit_per_student) studentLimit = room.claim_limit_per_student;

        // The token ceiling falls back to the old budget for a row written
        // before migration 003, so it keeps a gate rather than losing one.
        tokensUsed = room.tokens_used;
        tokenCap = room.token_safety_limit || room.token_budget || 0;

        if (studentId) {
          studentKey = `${classroomId}:${studentId}`;
          studentUsed = this.students.get(studentKey) || 0;
        }
      }

      // Gate order matters and is asserted on: the token ceiling is checked
      // last, so a class that is simply out of ClaimChecks is never reported as
      // a runaway.
      let reason = null;
      if (dailyLimit > 0 && dayUsed >= dailyLimit) reason = 'GLOBAL_LIMIT';
      else if (monthlyLimit > 0 && monthUsed >= monthlyLimit) reason = 'GLOBAL_LIMIT';
      else if (classroomId && classLimit > 0 && classUsed >= classLimit) reason = 'CLASSROOM_LIMIT';
      else if (classroomId && studentId && studentLimit > 0 && studentUsed >= studentLimit) reason = 'STUDENT_LIMIT';
      else if (classroomId && tokenCap > 0 && tokensUsed >= tokenCap) reason = 'TOKEN_SAFETY_LIMIT';

      if (reason) return out(false, reason);

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
      return out(true, null);
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
      // Token verification goes to /auth/v1/user, not the REST API. One known
      // token belongs to an approved educator; anything else is rejected, so a
      // test cannot accidentally authenticate.
      if (url.startsWith(`${SUPABASE}/auth/v1/user`)) {
        const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || '';
        if (auth !== 'Bearer teacher-token') {
          return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: TEACHER_ID, email: 'teacher@example.com' }),
          text: async () => JSON.stringify({ id: TEACHER_ID, email: 'teacher@example.com' }),
        };
      }

      const path = url.slice(`${SUPABASE}/rest/v1/`.length);
      const body = init.body ? JSON.parse(init.body) : null;
      const ok = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

      // The educator allowlist. Only the id above is on it.
      if (path.startsWith('classroom_educators?')) {
        return ok(path.includes(TEACHER_ID) || path.includes('teacher%40example.com')
          ? [{ id: 'educator-row' }]
          : []);
      }

      // Creating a classroom. Writes a row shaped exactly like addClassroom's,
      // so a room created through the API behaves like one created directly.
      if (path === 'classrooms' && (init.method || 'GET') === 'POST') {
        const row = db.addClassroom({ ...body, claims_used: 0, tokens_used: 0 });
        return ok([row]);
      }

      if (path.startsWith('classrooms?id=eq.') && (init.method || 'GET') === 'PATCH') {
        const id = decodeURIComponent(path.slice('classrooms?id=eq.'.length).split('&')[0]);
        const room = db.classrooms.get(id);
        if (room) Object.assign(room, body);
        return ok(room ? [room] : []);
      }

      if (path.startsWith('classrooms?owner_id=eq.')) {
        const owner = decodeURIComponent(path.slice('classrooms?owner_id=eq.'.length).split('&')[0]);
        return ok([...db.classrooms.values()].filter((r) => r.owner_id === owner));
      }

      if (path === 'rpc/claimcheck_reserve_claim') return ok([db.reserve(body)]);
      if (path === 'rpc/claimcheck_release_claim') return ok(db.release(body));
      if (path === 'rpc/classroom_record_usage') {
        const room = db.classrooms.get(body.p_classroom_id);
        if (room) {
          // Tokens are always recorded; the completed-analysis counter moves
          // only when the caller says a student actually got a result.
          room.tokens_used += body.p_tokens;
          room.searches_used += body.p_searches;
          if (body.p_count_analysis !== false) room.analyses_run += 1;
        }
        return ok(room ? [{
          tokens_used: room.tokens_used,
          token_budget: room.token_budget,
          token_safety_limit: room.token_safety_limit,
          analyses_run: room.analyses_run,
          searches_used: room.searches_used,
          claims_used: room.claims_used,
        }] : []);
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
  // Reads the default rather than restating it, so lowering the shipped
  // per-student allowance does not need this test edited — only the number of
  // requests it makes changes.
  const perStudent = appLimits.studentSessionLimit();
  const { room, headers } = joinedStudent();
  const text = 'A real claim to check here.';

  for (let i = 1; i <= perStudent; i++) {
    const res = await post('/api/classroom/analyze', { text }, headers);
    assert.equal(res.status, 200, `claim ${i} of ${perStudent} should succeed`);
  }
  assert.equal(anthropicCalls, perStudent);

  const blocked = await post('/api/classroom/analyze', { text }, headers);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'STUDENT_LIMIT');
  assert.match(blocked.body.error, new RegExp(`${perStudent}-claim limit`));
  assert.match(blocked.body.error, /instructor/i);
  assert.equal(anthropicCalls, perStudent, 'the refused request must not reach the provider');
  assert.equal(db.students.get(`${room.id}:${headers['X-Claimcheck-Student']}`), perStudent);
});

test('the shipped per-student default is 4', async () => {
  // The number a teacher is promised when they leave the field blank. Pinned
  // separately from the test above so a change to it is a deliberate edit here
  // rather than an invisible shift in how many requests that loop makes.
  assert.equal(appLimits.studentSessionLimit(), 4);

  const { headers } = joinedStudent();
  const res = await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);
  assert.deepEqual(res.body._classroom.claims, { used: 1, limit: 4 });
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
  // Names the number the class was measured against, so a teacher reading it
  // over a student's shoulder can tell "you used your 3" from "something went
  // wrong" without opening the dashboard.
  assert.match(blocked.body.error, /used all 3 of its ClaimChecks/i);
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

/* ── 16. ClaimChecks are the allowance ────────────────────────────────────
 *
 * The classroom allowance is a count of completed analyses, not a token budget.
 * These tests pin the definition of "one ClaimCheck" and the two properties
 * that make it a promise rather than an estimate: exactly one debit per
 * completed analysis, and no debit at all for anything else.
 */

/** A response that spent real tokens and then returned something unusable. */
function anthropicBillableGarbage() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I am afraid I cannot help with that.' }],
      usage: { input_tokens: 24000, output_tokens: 3000 },
    }),
    text: async () => '',
  };
}

/** A successful analysis that reports a specific token cost. */
function anthropicCosting(input, output, searches = 0) {
  return () => ({
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: MODEL_JSON }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        ...(searches ? { server_tool_use: { web_search_requests: searches } } : {}),
      },
    }),
    text: async () => '',
  });
}

const CLAIM = 'A real claim to check here.';

test('a 15-ClaimCheck classroom permits exactly 15, and refuses the 16th', async () => {
  const { room, headers } = joinedStudent({ claim_limit: 15, claim_limit_per_student: 100 });

  for (let i = 0; i < 15; i++) {
    const res = await post('/api/classroom/analyze', { text: CLAIM }, headers);
    assert.equal(res.status, 200, `ClaimCheck ${i + 1} of 15 must succeed`);
  }

  const sixteenth = await post('/api/classroom/analyze', { text: CLAIM }, headers);
  assert.equal(sixteenth.status, 429);
  assert.equal(sixteenth.body.code, 'CLASSROOM_LIMIT');
  assert.equal(room.claims_used, 15);
  assert.equal(anthropicCalls, 15, 'the refused request must never reach the provider');
});

test('one submission is one ClaimCheck, however many internal operations it needs', async () => {
  // A single analysis makes provider calls and web searches. None of those are
  // ClaimChecks: the counter moves by exactly one, once, on completion.
  anthropicResponder = anthropicCosting(28000, 3200, 4);
  const { room, headers } = joinedStudent({ claim_limit: 15 });

  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  assert.equal(room.claims_used, 1, 'four searches are still one ClaimCheck');
  assert.equal(room.analyses_run, 1);
  assert.equal(room.searches_used, 4);
  assert.equal(room.tokens_used, 31200);
});

test('ClaimChecks used and analyses completed never diverge', async () => {
  // They are shown to a teacher as one number, so they must be one number.
  const { room, headers } = joinedStudent({ claim_limit: 10 });

  await post('/api/classroom/analyze', { text: CLAIM }, headers);
  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  anthropicResponder = anthropicAuthFailure;
  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  anthropicResponder = anthropicBillableGarbage;
  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  assert.equal(room.claims_used, 2);
  assert.equal(room.analyses_run, room.claims_used);
});

test('an expensive failure costs the classroom tokens but not a ClaimCheck', async () => {
  // The provider ran to completion and was paid; only the last step failed. The
  // money is real and must reach the ceiling. The student got nothing, so their
  // teacher's promised allowance must be untouched.
  anthropicResponder = anthropicBillableGarbage;
  const { room, headers } = joinedStudent({ claim_limit: 15, claim_limit_per_student: 4 });
  const studentKey = `${room.id}:${headers['X-Claimcheck-Student']}`;

  const res = await post('/api/classroom/analyze', { text: CLAIM }, headers);
  assert.equal(res.status, 502);

  assert.equal(room.claims_used, 0, 'a failed analysis is not a ClaimCheck');
  assert.equal(db.students.get(studentKey), 0, 'nor does it spend the student their own allowance');
  assert.equal(room.analyses_run, 0);
  assert.equal(room.tokens_used, 27000, 'but the tokens it burned are still charged');
});

test('a retried failure does not double-charge the allowance', async () => {
  anthropicResponder = anthropicBillableGarbage;
  const { room, headers } = joinedStudent({ claim_limit: 15, claim_limit_per_student: 4 });

  for (let i = 0; i < 3; i++) {
    assert.equal((await post('/api/classroom/analyze', { text: CLAIM }, headers)).status, 502);
  }

  assert.equal(room.claims_used, 0, 'three failed attempts are still zero ClaimChecks');
  assert.equal(db.students.get(`${room.id}:${headers['X-Claimcheck-Student']}`), 0);

  // The student's allowance survived intact, so they can still do their work.
  anthropicResponder = anthropicSuccess;
  assert.equal((await post('/api/classroom/analyze', { text: CLAIM }, headers)).status, 200);
  assert.equal(room.claims_used, 1);
});

test('concurrent submissions cannot overrun the ClaimCheck allowance', async () => {
  // Twenty students press the button at once with three ClaimChecks left. The
  // check and the debit are one operation, so exactly three may proceed.
  const { room, headers } = joinedStudent({ claim_limit: 3, claim_limit_per_student: 100 });

  const results = await Promise.all(
    Array.from({ length: 20 }, () => post('/api/classroom/analyze', { text: CLAIM }, headers))
  );

  assert.equal(results.filter((r) => r.status === 200).length, 3);
  assert.equal(results.filter((r) => r.status === 429).length, 17);
  assert.equal(room.claims_used, 3, 'the counter must never exceed the limit');
  assert.equal(anthropicCalls, 3, 'no paid call may happen for a refused request');
});

test('ordinary analyses do not exhaust a correctly sized classroom', async () => {
  // The regression this whole change exists to fix. Under the old model a
  // 15-analysis classroom carried a 50,000-token budget and died on the second
  // real analysis. Run all fifteen at the median measured cost.
  anthropicResponder = anthropicCosting(25900, 3200, 2);
  const { room, headers } = joinedStudent({
    claim_limit: 15,
    claim_limit_per_student: 100,
    token_safety_limit: appLimits.tokenSafetyLimitFor(15),
  });

  for (let i = 0; i < 15; i++) {
    const res = await post('/api/classroom/analyze', { text: CLAIM }, headers);
    assert.equal(res.status, 200, `ClaimCheck ${i + 1} must not be blocked by the token ceiling`);
  }

  assert.equal(room.claims_used, 15);
  assert.ok(room.tokens_used > 400000, 'fifteen real analyses genuinely cost this much');
  assert.ok(room.tokens_used < room.token_safety_limit, 'and still fit inside the ceiling');
});

test('the response tells a student ClaimChecks, not tokens', async () => {
  const { headers } = joinedStudent({ claim_limit: 15, claim_limit_per_student: 4 });

  const res = await post('/api/classroom/analyze', { text: CLAIM }, headers);

  assert.equal(res.status, 200);
  assert.equal(res.body._classroom.claimsRemaining, 14);
  assert.equal(res.body._classroom.claimsTotal, 15);
  assert.equal('budgetRemaining' in res.body._classroom, false, 'the token budget is gone from the student view');
  assert.equal(res.body._usage, undefined, 'internal usage never reaches the browser');
});

/* ── 17. The token ceiling is a guardrail, not the allowance ──────────── */

test('a pathological classroom is still stopped by the token ceiling', async () => {
  // Each analysis costs twenty times normal. The class has ClaimChecks left,
  // but the ceiling sized for them has gone, and spending must stop.
  anthropicResponder = anthropicCosting(600000, 20000, 5);
  const { room, headers } = joinedStudent({
    claim_limit: 100,
    claim_limit_per_student: 100,
    token_safety_limit: 1000000,
  });

  assert.equal((await post('/api/classroom/analyze', { text: CLAIM }, headers)).status, 200);
  assert.equal((await post('/api/classroom/analyze', { text: CLAIM }, headers)).status, 200);

  const blocked = await post('/api/classroom/analyze', { text: CLAIM }, headers);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'TOKEN_SAFETY_LIMIT');
  assert.equal(anthropicCalls, 2, 'the ceiling must stop spending, not merely report it');
  assert.ok(room.claims_used < 100, 'the class still had ClaimChecks left when it was stopped');
});

test('hitting the ceiling is reported as a resource problem, not an exhausted allowance', async () => {
  anthropicResponder = anthropicCosting(600000, 20000, 5);
  const { headers } = joinedStudent({ claim_limit: 100, claim_limit_per_student: 100, token_safety_limit: 500000 });

  await post('/api/classroom/analyze', { text: CLAIM }, headers);
  const blocked = await post('/api/classroom/analyze', { text: CLAIM }, headers);

  assert.equal(blocked.body.code, 'TOKEN_SAFETY_LIMIT');
  // Must not claim the class ran out of ClaimChecks — it did not, and sending a
  // teacher to look at that number would send them to the wrong place.
  assert.doesNotMatch(blocked.body.error, /used all/i);
  assert.match(blocked.body.error, /more resources than expected/i);
  assert.match(blocked.body.error, /instructor/i);
  // Nothing about the provider, the account, or the money is a student's business.
  assert.doesNotMatch(blocked.body.error, /anthropic|api key|token|cost/i);
});

test('a class out of ClaimChecks is told so, even if it is also near the ceiling', async () => {
  // Gate order: the ordinary reason wins. A classroom that finished its work
  // normally must never be reported as a runaway.
  const { headers } = joinedStudent({ claim_limit: 1, claim_limit_per_student: 100, token_safety_limit: 100000 });

  await post('/api/classroom/analyze', { text: CLAIM }, headers);
  const blocked = await post('/api/classroom/analyze', { text: CLAIM }, headers);

  assert.equal(blocked.body.code, 'CLASSROOM_LIMIT');
});

test('a classroom created before the ceiling existed keeps its old gate', async () => {
  // token_safety_limit is NULL on a row the migration never reached. It must
  // fall back to the budget it was created with rather than losing its gate.
  const { headers } = joinedStudent({
    claim_limit: 100,
    claim_limit_per_student: 100,
    token_safety_limit: null,
    // Small enough that one real analysis (28,000 tokens) overshoots it, which
    // is exactly the trap the old model set for every classroom.
    token_budget: 20000,
  });

  anthropicResponder = anthropicCosting(25000, 3000, 2);
  assert.equal((await post('/api/classroom/analyze', { text: CLAIM }, headers)).status, 200);

  const blocked = await post('/api/classroom/analyze', { text: CLAIM }, headers);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'TOKEN_SAFETY_LIMIT');
});

/* ── 18. Token accounting ─────────────────────────────────────────────── */

test('input and output tokens are each counted once', async () => {
  anthropicResponder = anthropicCosting(24000, 3000, 2);
  const { room, headers } = joinedStudent({ claim_limit: 15 });

  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  assert.equal(room.tokens_used, 27000, 'exactly input + output, not a multiple of it');
  assert.equal(room.searches_used, 2);
});

test('a second analysis adds its own cost and nothing more', async () => {
  anthropicResponder = anthropicCosting(24000, 3000, 2);
  const { room, headers } = joinedStudent({ claim_limit: 15 });

  await post('/api/classroom/analyze', { text: CLAIM }, headers);
  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  // The measured figure that started this investigation was 53,856 for two
  // analyses. Two at 27,000 is 54,000 — the accounting was never wrong.
  assert.equal(room.tokens_used, 54000);
  assert.equal(room.claims_used, 2);
});

test('searches are counted as searches, never converted into tokens', async () => {
  anthropicResponder = anthropicCosting(10000, 1000, 5);
  const { room, headers } = joinedStudent({ claim_limit: 15 });

  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  assert.equal(room.tokens_used, 11000, 'the five searches must not inflate the token total');
  assert.equal(room.searches_used, 5);
});

/* ── 19. Privacy is unchanged ─────────────────────────────────────────── */

test('nothing about a student is stored beyond the counter they already had', async () => {
  const { room, headers } = joinedStudent({ claim_limit: 15, claim_limit_per_student: 4 });
  const studentId = headers['X-Claimcheck-Student'];

  await post('/api/classroom/analyze', { text: 'Ada Lovelace wrote the first algorithm.' }, headers);

  // The only per-student state is the pre-existing counter, keyed by the random
  // per-classroom id. This change added no table, no column, and no field to it.
  assert.deepEqual([...db.students.keys()], [`${room.id}:${studentId}`]);
  assert.equal(db.students.get(`${room.id}:${studentId}`), 1);

  // No claim text, and no student handle, reached the classroom row.
  const stored = JSON.stringify(room);
  assert.equal(stored.includes('Ada Lovelace'), false);
  assert.equal(stored.includes(studentId), false);
});

test('the session poll still publishes only the student own figures', async () => {
  const { room, headers } = joinedStudent({ claim_limit: 15, claim_limit_per_student: 4 });
  await post('/api/classroom/analyze', { text: CLAIM }, headers);

  const res = await realFetch(`${baseUrl}/api/classroom/session`, { headers });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.claims, { student: { used: 1, limit: 4 } });
  assert.equal(body.classroom.id, room.id);
  assert.equal('accessCode' in body.classroom, false);
  assert.equal('sessionSecret' in body.classroom, false);
  assert.equal('tokensUsed' in body.classroom, false, 'a student is never shown a token count');
});

/* ── 20. No unlimited classrooms ──────────────────────────────────────────
 *
 * Every classroom must end up with a finite ClaimCheck allowance and a finite
 * token ceiling. These drive the real create route over real HTTP, because the
 * threat model is a direct API call rather than the form — the form can be
 * bypassed, the route cannot.
 */

/** Signs in as an approved educator against the Supabase fake. */
function educatorHeaders() {
  return { Authorization: 'Bearer teacher-token' };
}

/** Body for a create request, with defaults that are known good. */
function createBody(overrides = {}) {
  return {
    displayName: 'Period 3 Civics',
    expiresAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const createRoom = (overrides) => post('/api/classroom/rooms', createBody(overrides), educatorHeaders());

test('a direct API call cannot create a classroom with 0 ClaimChecks per student', async () => {
  const res = await createRoom({ expectedStudents: 25, claimLimitPerStudent: 0 });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /between 1 and 20/);
  assert.equal(db.classrooms.size, 0, 'nothing may be written when validation fails');
});

test('a direct API call cannot create a classroom with a negative or oversized allowance', async () => {
  for (const bad of [-1, -100, 21, 1000, 999999]) {
    const res = await createRoom({ claimLimitPerStudent: bad });
    assert.equal(res.status, 400, `claimLimitPerStudent=${bad} must be refused`);
  }
  for (const bad of [0, -5, 1001]) {
    const res = await createRoom({ expectedStudents: bad });
    assert.equal(res.status, 400, `expectedStudents=${bad} must be refused`);
  }
  for (const bad of [0, -1, 100001]) {
    const res = await createRoom({ claimLimit: bad });
    assert.equal(res.status, 400, `claimLimit=${bad} must be refused`);
  }
  assert.equal(db.classrooms.size, 0);
});

test('a direct API call cannot smuggle a malformed value past validation', async () => {
  // Number([]) is 0 and Number(true) is 1 — neither is a count anyone meant to
  // send, and both would pass a bare isFinite check.
  for (const bad of ['four', 'NaN', '1e400', true, false, [], {}, [4], '4abc', '  ']) {
    const res = await createRoom({ claimLimitPerStudent: bad });
    assert.equal(res.status, 400, `claimLimitPerStudent=${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(db.classrooms.size, 0);
});

test('a direct API call cannot remove the token safety ceiling', async () => {
  for (const bad of [0, -1, '0', 100, 50000001]) {
    const res = await createRoom({ tokenSafetyLimit: bad });
    assert.equal(res.status, 400, `tokenSafetyLimit=${JSON.stringify(bad)} must be refused`);
    assert.match(res.body.error, /token safety limit/i);
  }
  assert.equal(db.classrooms.size, 0);
});

test('an existing classroom cannot be edited into an unlimited one', async () => {
  const created = await createRoom({ expectedStudents: 25, claimLimitPerStudent: 4 });
  assert.equal(created.status, 201);
  const id = created.body.classroom.id;

  for (const patch of [
    { claimLimitPerStudent: 0 },
    { claimLimit: 0 },
    { expectedStudents: 0 },
    { tokenSafetyLimit: 0 },
  ]) {
    const res = await realFetch(`${baseUrl}/api/classroom/rooms/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...educatorHeaders() },
      body: JSON.stringify(patch),
    });
    assert.equal(res.status, 400, `${JSON.stringify(patch)} must be refused`);
  }

  // The stored row is untouched and still finite.
  const room = db.classrooms.get(id);
  assert.equal(room.claim_limit_per_student, 4);
  assert.equal(room.expected_students, 25);
  assert.ok(room.token_safety_limit > 0);
});

test('every classroom the API creates has a finite ClaimCheck allowance and ceiling', async () => {
  const bodies = [
    {},
    { expectedStudents: 25, claimLimitPerStudent: 4 },
    { expectedStudents: 5, claimLimitPerStudent: 3 },
    { expectedStudents: 1, claimLimitPerStudent: 1 },
    { expectedStudents: 1000, claimLimitPerStudent: 20 },
    { claimLimit: 15 },
    { claimLimitPerStudent: 4 },
    { expectedStudents: 30 },
    { expectedStudents: null, claimLimitPerStudent: null, claimLimit: null },
  ];

  for (const body of bodies) {
    const res = await createRoom(body);
    assert.equal(res.status, 201, `${JSON.stringify(body)} should create a classroom`);

    const view = res.body.classroom;
    assert.ok(Number.isFinite(view.effectiveClaimLimit) && view.effectiveClaimLimit >= 1,
      `${JSON.stringify(body)} -> claim limit ${view.effectiveClaimLimit}`);
    assert.ok(Number.isFinite(view.claimsRemaining) && view.claimsRemaining >= 1);
    assert.ok(Number.isFinite(view.tokenSafetyLimit) && view.tokenSafetyLimit > 0,
      `${JSON.stringify(body)} -> ceiling ${view.tokenSafetyLimit}`);
    assert.ok(Number.isFinite(view.effectiveClaimLimitPerStudent) && view.effectiveClaimLimitPerStudent >= 1);

    // And the row that was actually written carries the ceiling, not just the view.
    const row = db.classrooms.get(view.id);
    assert.ok(row.token_safety_limit > 0, 'the stored row must carry a real ceiling');
  }
});

test('a blank form creates a 25 x 4 = 100 ClaimCheck classroom', async () => {
  const res = await createRoom({ expectedStudents: null, claimLimitPerStudent: null, claimLimit: null });

  assert.equal(res.status, 201);
  assert.equal(res.body.classroom.effectiveClaimLimit, 100);
  assert.equal(res.body.classroom.effectiveClaimLimitPerStudent, 4);
  assert.equal(res.body.classroom.tokenSafetyLimit, 100 * 90000);
});

test('25 students x 4 ClaimChecks creates a 100-ClaimCheck classroom', async () => {
  const res = await createRoom({ expectedStudents: 25, claimLimitPerStudent: 4 });

  assert.equal(res.status, 201);
  assert.equal(res.body.classroom.effectiveClaimLimit, 100);
  assert.equal(res.body.classroom.tokenSafetyLimit, 9000000);
});

test('5 students x 3 ClaimChecks creates a 15-ClaimCheck classroom', async () => {
  const res = await createRoom({ expectedStudents: 5, claimLimitPerStudent: 3 });

  assert.equal(res.status, 201);
  assert.equal(res.body.classroom.effectiveClaimLimit, 15);
  assert.equal(res.body.classroom.tokenSafetyLimit, 15 * 90000);
});

test('the create form is told the same defaults the server will apply', async () => {
  const res = await realFetch(`${baseUrl}/api/classroom/me`, { headers: educatorHeaders() });
  const body = await res.json();

  assert.equal(body.educator, true);
  assert.equal(body.limits.defaultClaimsPerStudent, 4);
  assert.equal(body.limits.defaultExpectedStudents, 25);
  assert.equal(body.limits.minClaimsPerStudent, 1);
  assert.equal(body.limits.maxClaimsPerStudent, 20);

  // The number the form prints must be the number the server computes.
  const previewed = body.limits.defaultExpectedStudents * body.limits.defaultClaimsPerStudent;
  const created = await createRoom({});
  assert.equal(created.body.classroom.effectiveClaimLimit, previewed);
});

test('the safety-per-analysis override changes what a new classroom is given', async () => {
  const before = process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS;
  process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS = '120000';
  try {
    const res = await createRoom({ expectedStudents: 25, claimLimitPerStudent: 4 });
    assert.equal(res.status, 201);
    assert.equal(res.body.classroom.tokenSafetyLimit, 100 * 120000);
  } finally {
    if (before === undefined) delete process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS;
    else process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS = before;
  }
});

test('an invalid safety-per-analysis override still produces a real ceiling', async () => {
  const before = process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS;
  process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS = '0';
  try {
    const res = await createRoom({ expectedStudents: 25, claimLimitPerStudent: 4 });
    assert.equal(res.status, 201);
    // Fell back to the documented default rather than removing the ceiling.
    assert.equal(res.body.classroom.tokenSafetyLimit, 9000000);
  } finally {
    if (before === undefined) delete process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS;
    else process.env.CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS = before;
  }
});

test('a classroom stored with zeroes is still gated, not unlimited', async () => {
  // The read side, exercised over HTTP: a row that predates this validation
  // must not become an unmetered classroom just by being used.
  const { headers } = joinedStudent({
    claim_limit: 0,
    claim_limit_per_student: 0,
    expected_students: 0,
    token_safety_limit: 0,
    token_budget: 0,
    claims_used: 0,
  });

  const res = await post('/api/classroom/analyze', { text: 'A real claim to check here.' }, headers);
  assert.equal(res.status, 200);
  // Falls back to the server defaults rather than reporting "no limit".
  assert.equal(res.body._classroom.claimsTotal, 100);
  assert.equal(res.body._classroom.claimsRemaining, 99);
  assert.deepEqual(res.body._classroom.claims, { used: 1, limit: 4 });
});
