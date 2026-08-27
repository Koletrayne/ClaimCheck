'use strict';

/* Browser-side tests for the usage guardrails.
 *
 * The website is vanilla JS with no build step and had no DOM test harness, so
 * this file builds a small one: the real index.html is parsed with linkedom (a
 * dependency the project already ships for article extraction), the handful of
 * browser globals the page uses are shimmed, and the real public/*.js files are
 * evaluated inside a vm context. Nothing under test is stubbed or reimplemented.
 *
 * What that buys: the character counter, the anonymous student id, the
 * duplicate-submission guard, and the Spanish limit messages are asserted
 * against the code that actually loads in a student's browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { parseHTML } = require('linkedom');

const PUBLIC = path.join(__dirname, '..', 'public');
const readPublic = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

/** A localStorage/sessionStorage work-alike backed by a Map. */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
}

/**
 * Loads the page and its scripts into a fresh vm context.
 *
 * `storage` is passed in rather than created here so a test can reuse the same
 * backing store across two loads, which is how "survives a refresh" is
 * expressed: a refresh is a new page with the same localStorage.
 */
function loadPage({
  html = readPublic('index.html'),
  scripts = ['locales/en.js', 'locales/es.js', 'lib/i18n.js', 'app.js'],
  storage = makeStorage(),
  classroom = null,
  fetchImpl = async () => { throw new Error('network disabled in this test'); },
  // Merged into the sandbox BEFORE any script runs. Some pages boot on load
  // rather than on DOMContentLoaded — the classroom dashboard reads
  // window.cc.supabase in the same tick it is defined in — so a global attached
  // after the fact arrives too late to be seen.
  globals = {},
} = {}) {
  const dom = parseHTML(html);
  const { document } = dom;

  // linkedom implements structure, not layout. These are no-ops the page calls
  // for scrolling and focus management.
  for (const proto of [dom.HTMLElement.prototype, dom.Element.prototype]) {
    if (!proto.scrollIntoView) proto.scrollIntoView = function () {};
    if (!proto.focus) proto.focus = function () {};
    if (!proto.select) proto.select = function () {};
  }
  // linkedom exposes <select>.value as a getter over the selected option, with
  // no setter. The page assigns to it to sync the language picker, so give it a
  // plain writable property that still reads back what was written.
  for (const select of document.querySelectorAll('select')) {
    let current = select.querySelector('option') ? select.querySelector('option').getAttribute('value') : '';
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: () => current,
      set: (v) => { current = String(v); },
    });
  }
  // Same story for setSelectionRange, which the classroom join field calls.
  if (!dom.HTMLElement.prototype.setSelectionRange) {
    dom.HTMLElement.prototype.setSelectionRange = function () {};
  }

  const timers = [];
  const sandbox = {
    document,
    localStorage: storage,
    sessionStorage: makeStorage(),
    crypto: webcrypto,
    console,
    fetch: fetchImpl,
    navigator: { language: 'en-US' },
    location: { hash: '', pathname: '/', search: '', href: 'http://localhost/', replace() {} },
    history: { replaceState() {}, pushState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; },
    clearTimeout,
    // Intervals are collected so a loaded page cannot keep the test runner alive.
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); timers.push(id); return id; },
    clearInterval,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    ccClassroom: classroom,
    // The page registers a DOMContentLoaded handler and then calls the same
    // function directly when the document is already parsed, which is the path
    // this harness takes — so collecting the listeners is enough.
    addEventListener() {},
    removeEventListener() {},
  };
  // window must be the global object itself, so `window.ccI18n = ...` in one
  // script is visible as the bare identifier `ccI18n` in the next — exactly how
  // the real page's separate <script> tags see each other.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, globals);

  const context = vm.createContext(sandbox);
  for (const rel of scripts) {
    vm.runInContext(readPublic(rel), context, { filename: rel });
  }

  return {
    context,
    document,
    storage,
    $: (id) => document.getElementById(id),
    cleanup: () => timers.forEach((id) => { clearTimeout(id); clearInterval(id); }),
  };
}

/** Fires a DOM event the way a real interaction would. */
function fire(el, type) {
  el.dispatchEvent(new (el.ownerDocument.defaultView || globalThis).Event(type, { bubbles: true }));
}

/* ── 4-6. The anonymous student id ────────────────────────────────────── */

/** Loads student-id.js on its own — it needs only window, crypto, localStorage. */
function loadStudentId(storage = makeStorage()) {
  const sandbox = { crypto: webcrypto, localStorage: storage, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(readPublic('lib/student-id.js'), vm.createContext(sandbox), { filename: 'student-id.js' });
  return { api: sandbox.ccStudentId, storage };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('a new anonymous student receives a random v4 UUID', () => {
  const { api } = loadStudentId();
  const id = api.forClassroom('classroom-abc');

  assert.match(id, UUID_RE);
});

test('the id is not derived from anything about the student or the machine', () => {
  // Two students in the same classroom, on the same "device", must be
  // unlinkable. If the id were a fingerprint, these would collide.
  const a = loadStudentId().api.forClassroom('classroom-abc');
  const b = loadStudentId().api.forClassroom('classroom-abc');

  assert.notEqual(a, b);
});

test('the anonymous id persists across a page refresh', () => {
  // A refresh is a new page against the same localStorage. An id that did not
  // survive one would reset the student's allowance on every reload, which is
  // not a limit at all.
  const storage = makeStorage();
  const first = loadStudentId(storage).api.forClassroom('classroom-abc');
  const afterRefresh = loadStudentId(storage).api.forClassroom('classroom-abc');

  assert.equal(afterRefresh, first);
});

test('the id is stable across repeated calls within one page', () => {
  const { api } = loadStudentId();
  const id = api.forClassroom('classroom-abc');
  assert.equal(api.forClassroom('classroom-abc'), id);
});

test('joining a different classroom mints a separate, unlinkable id', () => {
  const storage = makeStorage();
  const { api } = loadStudentId(storage);

  const inA = api.forClassroom('classroom-A');
  const inB = api.forClassroom('classroom-B');

  assert.notEqual(inA, inB, 'usage in one classroom must not be attributable to the other');
  // And each remains stable in its own classroom.
  assert.equal(api.forClassroom('classroom-A'), inA);
  assert.equal(api.forClassroom('classroom-B'), inB);
});

test('the stored key is scoped to the classroom and holds nothing but the id', () => {
  const storage = makeStorage();
  loadStudentId(storage).api.forClassroom('classroom-abc');

  const keys = [...storage._map.keys()];
  assert.deepEqual(keys, ['claimcheck_student_id:classroom-abc']);
  assert.match(storage._map.get(keys[0]), UUID_RE);
});

test('a tampered or corrupted stored id is replaced rather than trusted', () => {
  const storage = makeStorage({ 'claimcheck_student_id:classroom-abc': 'not-a-uuid' });
  const id = loadStudentId(storage).api.forClassroom('classroom-abc');

  assert.match(id, UUID_RE);
  assert.notEqual(id, 'not-a-uuid');
});

test('a storage failure still yields a usable id', () => {
  // Private browsing throws on setItem. The student should still be able to
  // work; only their per-student count restarts.
  const hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() {},
  };
  const { api } = loadStudentId(hostile);
  assert.match(api.forClassroom('classroom-abc'), UUID_RE);
});

/* ── 1-3. The character counter ───────────────────────────────────────── */

test('the counter shows used and maximum characters', () => {
  const page = loadPage();
  try {
    const input = page.$('claim-input');
    input.value = 'a'.repeat(243);
    fire(input, 'input');

    assert.equal(page.$('char-counter').textContent, '243 / 750');
  } finally {
    page.cleanup();
  }
});

test('the counter flags an over-length claim', () => {
  const page = loadPage();
  try {
    const input = page.$('claim-input');
    const counter = page.$('char-counter');

    input.value = 'a'.repeat(750);
    fire(input, 'input');
    assert.equal(counter.className.includes('char-counter--over'), false, '750 is within the limit');

    input.value = 'a'.repeat(751);
    fire(input, 'input');
    assert.equal(counter.className.includes('char-counter--over'), true, '751 is over the limit');
    assert.equal(counter.textContent, '751 / 750');
  } finally {
    page.cleanup();
  }
});

test('the claim box does not silently truncate a long paste', () => {
  // maxlength was removed on purpose: truncating leaves the student with text
  // they did not write and no explanation. They keep the text; the counter and
  // the validation message tell them what to do about it.
  const page = loadPage();
  try {
    assert.equal(page.$('claim-input').hasAttribute('maxlength'), false);
  } finally {
    page.cleanup();
  }
});

test('an over-length claim is refused without a network request', () => {
  let calls = 0;
  const page = loadPage({ fetchImpl: async () => { calls += 1; throw new Error('blocked'); } });
  try {
    calls = 0; // ignore the page's own /api/limits fetch on load
    const input = page.$('claim-input');
    input.value = 'a'.repeat(751);
    fire(input, 'input');
    fire(page.$('check-btn'), 'click');

    assert.equal(calls, 0, 'a validation error must not cost a request');
    const error = page.$('field-error');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /750 characters/);
    assert.match(error.textContent, /narrowing this down/i);
  } finally {
    page.cleanup();
  }
});

/* ── 14. Duplicate submissions ────────────────────────────────────────── */

test('rapid double-clicking the Analyze button issues one request', async () => {
  let analyzeCalls = 0;
  const page = loadPage({
    fetchImpl: async (url) => {
      if (String(url).includes('/api/limits')) {
        return { ok: true, json: async () => ({ maxClaimCharacters: 750 }) };
      }
      analyzeCalls += 1;
      // Never settles within the test, standing in for a slow analysis — the
      // window during which an impatient user clicks again.
      return new Promise(() => {});
    },
  });

  try {
    page.$('predict-toggle').checked = false;
    page.$('claim-input').value = 'Coffee reduces the risk of type 2 diabetes.';

    const btn = page.$('check-btn');
    for (let i = 0; i < 5; i++) fire(btn, 'click');
    await new Promise((r) => setImmediate(r));

    assert.equal(analyzeCalls, 1, 'five clicks must produce exactly one analysis');
    assert.equal(btn.disabled, true, 'the button should be disabled while working');
  } finally {
    page.cleanup();
  }
});

test('the keyboard shortcut cannot bypass the in-flight guard', async () => {
  // Ctrl+Enter calls startCheck() directly and never consults the button's
  // disabled state, so the guard has to be a flag rather than the button alone.
  let analyzeCalls = 0;
  const page = loadPage({
    fetchImpl: async (url) => {
      if (String(url).includes('/api/limits')) {
        return { ok: true, json: async () => ({ maxClaimCharacters: 750 }) };
      }
      analyzeCalls += 1;
      return new Promise(() => {});
    },
  });

  try {
    page.$('predict-toggle').checked = false;
    const input = page.$('claim-input');
    input.value = 'Coffee reduces the risk of type 2 diabetes.';

    fire(page.$('check-btn'), 'click');
    await new Promise((r) => setImmediate(r));

    const ctrlEnter = new page.context.Event('keydown', { bubbles: true });
    ctrlEnter.key = 'Enter';
    ctrlEnter.ctrlKey = true;
    ctrlEnter.metaKey = false;
    for (let i = 0; i < 3; i++) input.dispatchEvent(ctrlEnter);
    await new Promise((r) => setImmediate(r));

    assert.equal(analyzeCalls, 1);
  } finally {
    page.cleanup();
  }
});

/* ── 16. Spanish limit messaging ──────────────────────────────────────── */

/** Loads just the i18n layer, with a chosen language already selected. */
function loadI18n(lang) {
  const sandbox = {
    localStorage: makeStorage({ claimcheck_lang: lang }),
    document: parseHTML('<html><body></body></html>').document,
    console,
    navigator: { language: lang },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const rel of ['locales/en.js', 'locales/es.js', 'lib/i18n.js']) {
    vm.runInContext(readPublic(rel), ctx, { filename: rel });
  }
  return sandbox.ccI18n;
}

test('every usage-limit string exists in both languages', () => {
  const keys = [
    'errors.claimTooLong',
    'errors.studentLimit',
    'errors.studentLimitGeneric',
    'errors.classroomLimit',
    'errors.globalLimit',
    'classroom.claimsRemaining',
  ];
  const en = loadI18n('en');
  const es = loadI18n('es');

  for (const key of keys) {
    const enText = en.t(key, { max: 750, limit: 12, remaining: 8 });
    const esText = es.t(key, { max: 750, limit: 12, remaining: 8 });

    // t() returns the key itself when a translation is missing, which would
    // otherwise show a raw dotted path to a student.
    assert.notEqual(enText, key, `${key} missing from English`);
    assert.notEqual(esText, key, `${key} missing from Spanish`);
    assert.notEqual(enText, esText, `${key} appears untranslated in Spanish`);
  }
});

test('Spanish limit messages interpolate the server-supplied numbers', () => {
  const es = loadI18n('es');

  assert.match(es.t('errors.claimTooLong', { max: 750 }), /750 caracteres/);
  assert.match(es.t('errors.studentLimit', { limit: 12 }), /12 afirmaciones/);
  assert.match(es.t('classroom.claimsRemaining', { remaining: 8, limit: 12 }), /8 de 12/);

  // No unreplaced placeholders should survive into user-facing copy.
  for (const key of ['errors.claimTooLong', 'errors.studentLimit', 'classroom.claimsRemaining']) {
    assert.doesNotMatch(es.t(key, { max: 750, limit: 12, remaining: 8 }), /\{[a-z]+\}/i, key);
  }
});

test('the Spanish over-length message renders in the UI when Spanish is selected', () => {
  const page = loadPage({
    storage: makeStorage({ claimcheck_lang: 'es' }),
    scripts: ['locales/en.js', 'locales/es.js', 'lib/i18n.js', 'app.js'],
  });

  try {
    const input = page.$('claim-input');
    input.value = 'a'.repeat(900);
    fire(input, 'input');
    fire(page.$('check-btn'), 'click');

    const error = page.$('field-error');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /750 caracteres/);
    assert.match(error.textContent, /afirmación específica/i);
  } finally {
    page.cleanup();
  }
});

/* ── 13. Existing behaviour is intact ─────────────────────────────────── */

test('the URL tab is unaffected by the claim character limit', () => {
  const page = loadPage();
  try {
    // Switching to URL mode hides the claim pane and its counter entirely; the
    // limit has no bearing on a pasted link.
    fire(page.$('tab-url'), 'click');

    assert.equal(page.$('url-pane').hidden, false);
    assert.equal(page.$('claim-pane').hidden, true);
    assert.equal(page.$('field-error').hidden, true);
  } finally {
    page.cleanup();
  }
});

/* ── 20. The classroom dashboard speaks in ClaimChecks ────────────────────
 *
 * The teacher-facing half of the allowance change. These run the real
 * admin.html and admin.js in the same harness, because the number this page
 * prints — "25 students × 4 ClaimChecks = 100" — is a promise made to a class,
 * and the only thing stopping it drifting from what the server computes is a
 * test that reads it off the page.
 */

/**
 * What GET /api/classroom/me publishes to the dashboard.
 *
 * Taken from lib/limits.js rather than written out, so a test cannot pass by
 * agreeing with a number the server stopped using. The page renders these; the
 * server still re-validates everything it is sent.
 */
const SERVER_LIMITS = require('../lib/classroom-routes')._internal.classroomFormLimits();

/** A Supabase client stand-in: signed in, with a token, and nothing else. */
function fakeSupabase(email = 'teacher@example.com') {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'teacher-uuid', email } } }),
      getSession: async () => ({ data: { session: { access_token: 'teacher-token' } } }),
      signInWithPassword: async () => ({ error: null }),
      signOut: async () => {},
    },
  };
}

/**
 * Loads the dashboard with a stubbed classroom API.
 *
 * `rooms` are ownerView-shaped rows, exactly as lib/classroom.js emits them.
 * Waits for boot() to finish rendering rather than guessing at a delay.
 */
async function loadAdmin({ rooms = [], educator = true, limits = SERVER_LIMITS, onPost, confirm } = {}) {
  const requests = [];
  const page = loadPage({
    html: readPublic('classroom/admin.html'),
    scripts: ['classroom/admin.js'],
    fetchImpl: async (url, options = {}) => {
      requests.push(String(url));
      if (options.body && onPost) onPost(JSON.parse(options.body));
      const body = String(url).endsWith('/me')
        ? { signedIn: true, educator, limits }
        : { classrooms: rooms };
      return { ok: true, status: 200, json: async () => body };
    },
    globals: {
      cc: { supabase: fakeSupabase(), supabaseReady: Promise.resolve() },
      Intl,
      confirm: confirm || (() => true),
      alert: () => {},
      location: { origin: 'http://localhost', hash: '', pathname: '/classroom/admin.html', search: '', href: 'http://localhost/classroom/admin.html', replace() {} },
    },
  });

  // admin.js calls boot() as it loads; give its awaits a chance to settle.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  return { ...page, requests };
}

/** An ownerView row with sensible defaults, overridable per test. */
function ownerRoom(overrides = {}) {
  return {
    id: 'room-1', displayName: 'Period 3 Civics', accessCode: 'ABCD-2345',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    active: true, expired: false, usable: true,
    claimsUsed: 2, claimsRemaining: 13, claimLimit: 15,
    claimLimitPerStudent: 4, expectedStudents: 5,
    effectiveClaimLimit: 15, effectiveClaimLimitPerStudent: 4,
    tokensUsed: 53856, tokenSafetyLimit: 1350000, tokensRemaining: 1296144,
    tokensExhausted: false, analysesRun: 2, searchesUsed: 4,
    legacyTokenBudget: 100000,
    ...overrides,
  };
}

/* ── The create form ──────────────────────────────────────────────────── */

test('the create form asks for ClaimChecks, not tokens', async () => {
  const page = await loadAdmin();

  assert.ok(page.$('create-expected'), 'expected class size is a primary field');
  assert.ok(page.$('create-per-student'), 'ClaimChecks per student is a primary field');
  assert.ok(page.$('create-capacity'), 'classroom capacity is expressed as a choice of ClaimChecks');
  assert.equal(page.$('create-budget'), null, 'the token allowance dropdown is gone');

  // Every capacity option is a ClaimCheck count, not a token count.
  for (const option of page.$('create-capacity').querySelectorAll('option')) {
    if (!option.getAttribute('value')) continue;
    assert.match(option.textContent, /ClaimCheck/);
    assert.doesNotMatch(option.textContent, /token/i);
  }

  page.cleanup();
});

test('tokens appear only inside the advanced disclosure', async () => {
  const page = await loadAdmin();
  const form = page.$('create-form');

  const advanced = form.querySelector('details');
  assert.ok(advanced, 'the token control lives behind a disclosure');
  assert.ok(advanced.contains(page.$('create-token-ceiling')));

  // Nothing outside that disclosure may mention tokens: a teacher should be
  // able to fill this form in without meeting the word.
  const advancedText = advanced.textContent;
  const outside = form.textContent.replace(advancedText, '');
  assert.doesNotMatch(outside, /token/i);

  page.cleanup();
});

test('25 students x 4 ClaimChecks reads as 100 on the form', async () => {
  const page = await loadAdmin();

  page.$('create-expected').value = '25';
  fire(page.$('create-expected'), 'input');
  page.$('create-per-student').value = '4';
  fire(page.$('create-per-student'), 'input');

  const summary = page.$('create-capacity-summary').textContent;
  assert.match(summary, /25 students × 4 ClaimChecks/);
  assert.match(summary, /classroom capacity: 100 ClaimChecks/);

  page.cleanup();
});

test('5 students x 3 ClaimChecks reads as 15 on the form', async () => {
  const page = await loadAdmin();

  page.$('create-expected').value = '5';
  fire(page.$('create-expected'), 'input');
  page.$('create-per-student').value = '3';
  fire(page.$('create-per-student'), 'input');

  assert.match(page.$('create-capacity-summary').textContent, /classroom capacity: 15 ClaimChecks/);

  page.cleanup();
});

test('blank fields show the defaults they will actually use', async () => {
  // A form that showed nothing until both boxes were filled would hide the
  // default rather than explain it.
  const page = await loadAdmin();

  const summary = page.$('create-capacity-summary').textContent;
  assert.match(summary, /25 students × 4 ClaimChecks/);
  assert.match(summary, /classroom capacity: 100 ClaimChecks/);
  assert.match(summary, /default 25 students and 4 per student/);

  page.cleanup();
});

test('the form takes its defaults from the server, not from a copy in the page', async () => {
  // The number printed here has to be the number the server computes. It lived
  // in two places once; one of them drifted, and a teacher was shown a capacity
  // that did not exist.
  const page = await loadAdmin();

  assert.equal(page.$('create-per-student').placeholder, String(SERVER_LIMITS.defaultClaimsPerStudent));
  assert.equal(page.$('create-expected').placeholder, String(SERVER_LIMITS.defaultExpectedStudents));
  assert.equal(page.$('create-per-student').getAttribute('max'), String(SERVER_LIMITS.maxClaimsPerStudent));
  assert.equal(page.$('create-per-student').getAttribute('min'), String(SERVER_LIMITS.minClaimsPerStudent));

  const expected = SERVER_LIMITS.defaultExpectedStudents * SERVER_LIMITS.defaultClaimsPerStudent;
  assert.match(page.$('create-capacity-summary').textContent,
    new RegExp(`classroom capacity: ${expected} ClaimChecks`));

  page.cleanup();
});

test('a server that raises the default moves the printed capacity with it', async () => {
  const page = await loadAdmin({
    limits: { ...SERVER_LIMITS, defaultClaimsPerStudent: 6, defaultExpectedStudents: 30 },
  });

  assert.match(page.$('create-capacity-summary').textContent, /30 students × 6 ClaimChecks/);
  assert.match(page.$('create-capacity-summary').textContent, /capacity: 180 ClaimChecks/);

  page.cleanup();
});

test('one blank field still names which default filled it in', async () => {
  const page = await loadAdmin();

  page.$('create-per-student').value = '4';
  fire(page.$('create-per-student'), 'input');

  const summary = page.$('create-capacity-summary').textContent;
  assert.match(summary, /classroom capacity: 100 ClaimChecks/);
  assert.match(summary, /default 25 students/);
  assert.doesNotMatch(summary, /per student\.$/);

  page.cleanup();
});

test('a fixed capacity overrides the calculation and says so', async () => {
  const page = await loadAdmin();

  page.$('create-expected').value = '25';
  fire(page.$('create-expected'), 'input');
  page.$('create-per-student').value = '4';
  fire(page.$('create-per-student'), 'input');
  page.$('create-capacity').value = '30';
  fire(page.$('create-capacity'), 'input');

  const summary = page.$('create-capacity-summary').textContent;
  assert.match(summary, /Classroom capacity: 30 ClaimChecks/);
  assert.match(summary, /up to 4 ClaimChecks per student/);

  page.cleanup();
});

test('zero ClaimChecks per student is refused, not treated as unlimited', async () => {
  const page = await loadAdmin();

  page.$('create-per-student').value = '0';
  fire(page.$('create-per-student'), 'input');

  const summary = page.$('create-capacity-summary').textContent;
  assert.match(summary, /must be between 1 and 20/);
  assert.match(summary, /blank for the default of 4/);
  // The two readings this must never offer: an unlimited class, or a class of
  // nothing. 0 is a mistake, and the form says which one.
  assert.doesNotMatch(summary, /no ClaimCheck cap|unlimited/i);
  assert.doesNotMatch(summary, /capacity: 0/);

  page.cleanup();
});

test('every out-of-range entry is called out instead of previewing a capacity', async () => {
  const page = await loadAdmin();

  for (const bad of ['0', '-1', '21', '100']) {
    page.$('create-per-student').value = bad;
    fire(page.$('create-per-student'), 'input');
    assert.match(page.$('create-capacity-summary').textContent, /must be between 1 and 20/,
      `${bad} ClaimChecks per student must be called out`);
  }
  page.$('create-per-student').value = '4';
  fire(page.$('create-per-student'), 'input');

  for (const bad of ['0', '-3', '1001']) {
    page.$('create-expected').value = bad;
    fire(page.$('create-expected'), 'input');
    assert.match(page.$('create-capacity-summary').textContent, /class size must be between 1 and 1000/,
      `class size ${bad} must be called out`);
  }

  page.cleanup();
});

test('a form with an out-of-range value never reaches the server', async () => {
  // A courtesy, not a control — the server refuses it too — but a round trip
  // that only ever ends in a 400 is a round trip worth not making.
  const sent = [];
  const page = await loadAdmin({ onPost: (body) => sent.push(body) });

  page.$('create-per-student').value = '0';
  fire(page.$('create-per-student'), 'input');
  fire(page.$('create-form'), 'submit');
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(sent.length, 0, 'nothing should have been submitted');
  assert.match(page.$('create-error').textContent, /must be between 1 and 20/);
  assert.equal(page.$('create-error').hidden, false);

  page.cleanup();
});

test('creating a classroom sends ClaimCheck fields and no token budget', async () => {
  const sent = [];
  const page = loadPage({
    html: readPublic('classroom/admin.html'),
    scripts: ['classroom/admin.js'],
    fetchImpl: async (url, options = {}) => {
      if (options.body) sent.push(JSON.parse(options.body));
      const body = String(url).endsWith('/me')
        ? { signedIn: true, educator: true, limits: SERVER_LIMITS }
        : { classrooms: [] };
      return { ok: true, status: 200, json: async () => body };
    },
    globals: {
      cc: { supabase: fakeSupabase(), supabaseReady: Promise.resolve() },
      Intl,
      location: { origin: 'http://localhost', hash: '', pathname: '/', search: '', href: 'http://localhost/', replace() {} },
    },
  });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  page.$('create-expected').value = '25';
  page.$('create-per-student').value = '4';
  fire(page.$('create-form'), 'submit');
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].expectedStudents, 25);
  assert.equal(sent[0].claimLimitPerStudent, 4);
  assert.equal(sent[0].claimLimit, null, 'blank capacity means "derive it", not a frozen number');
  assert.equal(sent[0].tokenSafetyLimit, null, 'blank ceiling means "size it from the capacity"');
  assert.equal('tokenBudget' in sent[0], false, 'the token budget is no longer a classroom input');

  page.cleanup();
});

/* ── The classroom card ───────────────────────────────────────────────── */

test('the dashboard leads with ClaimChecks used, not an allowance percentage', async () => {
  const page = await loadAdmin({ rooms: [ownerRoom()] });
  const labels = [...page.document.querySelectorAll('.cc-stat__label')].map((n) => n.textContent);
  const values = [...page.document.querySelectorAll('.cc-stat__value')].map((n) => n.textContent);

  assert.equal(labels[0], 'ClaimChecks used');
  assert.equal(values[0], '2 of 15');
  assert.equal(values[labels.indexOf('Remaining')], '13');
  assert.equal(values[labels.indexOf('Searches')], '4');

  // The metric that misled the teacher is gone, and so is its duplicate.
  assert.equal(labels.includes('Allowance used'), false);
  assert.equal(labels.includes('Analyses run'), false,
    'ClaimChecks used and analyses run are the same number and must not be shown twice');

  page.cleanup();
});

test('the token total is demoted to a secondary line', async () => {
  const page = await loadAdmin({ rooms: [ownerRoom()] });

  const internal = page.document.querySelector('.cc-internal');
  assert.ok(internal, 'the token figure is still available to whoever wants it');
  assert.match(internal.textContent, /Internal usage/);
  assert.match(internal.textContent, /53\.9k tokens/);

  // But it is not one of the headline stats.
  const stats = [...page.document.querySelectorAll('.cc-stat')].map((n) => n.textContent).join(' ');
  assert.doesNotMatch(stats, /53,856|53\.9k/);

  page.cleanup();
});

test('a classroom stopped by the safety ceiling says so plainly', async () => {
  // The distinction that matters: this class did NOT run out of ClaimChecks,
  // and the card must not let a teacher think it did.
  const page = await loadAdmin({
    rooms: [ownerRoom({
      usable: false, tokensExhausted: true, tokensRemaining: 0,
      claimsUsed: 4, claimsRemaining: 11,
    })],
  });

  const status = page.document.querySelector('.cc-room__status');
  assert.equal(status.textContent, 'Paused (safety limit)');

  const internal = page.document.querySelector('.cc-internal--alert');
  assert.ok(internal);
  assert.match(internal.textContent, /Internal safety limit reached/);
  assert.match(internal.textContent, /allowance was not the limit that stopped it/);

  page.cleanup();
});

test('a classroom that simply finished its ClaimChecks is labelled differently', async () => {
  const page = await loadAdmin({
    rooms: [ownerRoom({ usable: false, tokensExhausted: false, claimsUsed: 15, claimsRemaining: 0 })],
  });

  assert.equal(page.document.querySelector('.cc-room__status').textContent, 'ClaimChecks used');
  assert.equal(page.document.querySelector('.cc-internal--alert'), null);

  page.cleanup();
});

test('the dashboard has no way to render an unlimited classroom', async () => {
  // There is no such classroom to render. The card shows real numbers, and the
  // word that used to stand in for "no limit" is gone from the page entirely.
  const page = await loadAdmin({
    rooms: [ownerRoom({ claimsUsed: 0, claimsRemaining: 100, effectiveClaimLimit: 100 })],
  });

  const labels = [...page.document.querySelectorAll('.cc-stat__label')].map((n) => n.textContent);
  const values = [...page.document.querySelectorAll('.cc-stat__value')].map((n) => n.textContent);

  assert.equal(values[labels.indexOf('Remaining')], '100');
  assert.equal(values[labels.indexOf('Per student')], '4');
  assert.doesNotMatch(page.$('rooms').textContent, /unlimited/i);

  page.cleanup();
});

test('the internal usage line always names a ceiling', async () => {
  const page = await loadAdmin({ rooms: [ownerRoom()] });

  assert.match(page.document.querySelector('.cc-internal').textContent,
    /53\.9k tokens of 1\.35M internal ceiling/);

  page.cleanup();
});

test('the dashboard never renders a per-student breakdown', async () => {
  // There is no such data to render, and this pins that the card cannot start
  // showing one without failing here first.
  const page = await loadAdmin({ rooms: [ownerRoom()] });
  const text = page.$('rooms').textContent;

  assert.doesNotMatch(text, /student\s*#|Student 1|per-student list|individual/i);
  assert.match(text, /Per student/, 'only the shared cap is shown, as a single number');

  page.cleanup();
});

/* ── 21. The Edit Session panel ───────────────────────────────────────────
 *
 * The teacher-facing half of live classroom editing, running the real
 * admin.html and admin.js in a DOM. What these protect is the preview: the
 * panel exists so a teacher sees the consequence of a change before saving it,
 * and a preview that disagreed with the server would be worse than none.
 */

const editRoom = (overrides = {}) => ownerRoom({
  claimsUsed: 37, claimsRemaining: 63, claimLimit: null,
  claimLimitPerStudent: 4, expectedStudents: 25,
  effectiveClaimLimit: 100, effectiveClaimLimitPerStudent: 4,
  allowanceMode: 'automatic', overCapacity: false,
  ...overrides,
});

const panelOf = (page) => page.document.querySelector('.cc-edit');
const previewText = (page) => page.document.querySelector('.cc-edit__preview').textContent;

function setValue(page, selector, value) {
  const el = page.document.querySelector(selector);
  el.value = value;
  fire(el, 'input');
  return el;
}

function chooseMode(page, mode) {
  const auto = page.document.querySelector('.cc-edit__mode-auto');
  const custom = page.document.querySelector('.cc-edit__mode-custom');
  auto.checked = mode === 'automatic';
  custom.checked = mode === 'custom';
  fire(mode === 'custom' ? custom : auto, 'change');
}

test('an active classroom offers an Edit session control', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });

  const toggle = page.document.querySelector('.cc-edit-toggle');
  assert.ok(toggle, 'the control is on the card');
  assert.equal(toggle.textContent, 'Edit session');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(panelOf(page).hidden, true, 'and starts closed');

  page.cleanup();
});

test('an expired classroom offers no edit control', async () => {
  // The server refuses the edit, and a button that always fails is worse than
  // no button.
  const page = await loadAdmin({
    rooms: [editRoom({ expired: true, usable: false, active: true })],
  });

  assert.equal(page.document.querySelector('.cc-edit-toggle'), null);
  assert.equal(panelOf(page), null);

  page.cleanup();
});

test('a closed classroom offers no edit control either', async () => {
  const page = await loadAdmin({ rooms: [editRoom({ active: false, usable: false })] });
  assert.equal(page.document.querySelector('.cc-edit-toggle'), null);
  page.cleanup();
});

test('the panel opens showing the classroom current values', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });
  const toggle = page.document.querySelector('.cc-edit-toggle');

  toggle.dispatchEvent(new page.context.window.Event('click', { bubbles: true }));

  assert.equal(panelOf(page).hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(page.document.querySelector('.cc-edit__expected').value, '25');
  assert.equal(page.document.querySelector('.cc-edit__per-student').value, '4');
  assert.equal(page.document.querySelector('.cc-edit__mode-auto').checked, true);
  assert.ok(page.document.querySelector('.cc-edit__closes-at').value, 'the closing time is populated');

  page.cleanup();
});

test('a custom classroom opens in custom mode with its total filled in', async () => {
  const page = await loadAdmin({
    rooms: [editRoom({ allowanceMode: 'custom', claimLimit: 3, effectiveClaimLimit: 3, claimsUsed: 1, claimsRemaining: 2 })],
  });

  assert.equal(page.document.querySelector('.cc-edit__mode-custom').checked, true);
  assert.equal(page.document.querySelector('.cc-edit__custom-total').value, '3');

  page.cleanup();
});

test('the preview shows the new capacity against usage already spent', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });

  setValue(page, '.cc-edit__expected', '30');

  assert.match(previewText(page), /New capacity: 120 ClaimChecks/);
  assert.match(previewText(page), /37 already used, 83 remaining/);

  page.cleanup();
});

test('changing ClaimChecks per student moves the preview too', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });

  setValue(page, '.cc-edit__per-student', '5');

  assert.match(previewText(page), /New capacity: 125 ClaimChecks/);
  assert.match(previewText(page), /37 already used, 88 remaining/);

  page.cleanup();
});

test('a reduction below current usage is warned about, not hidden', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });

  chooseMode(page, 'custom');
  setValue(page, '.cc-edit__custom-total', '30');

  const preview = page.document.querySelector('.cc-edit__preview');
  assert.match(preview.textContent, /New capacity: 30 ClaimChecks/);
  assert.match(preview.textContent, /stop accepting new ClaimChecks immediately/);
  assert.match(preview.textContent, /Work already done is kept/);
  assert.ok(preview.className.includes('cc-edit__preview--warn'));

  page.cleanup();
});

test('the custom input is capped at 150 and refuses more', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });
  chooseMode(page, 'custom');

  const input = page.document.querySelector('.cc-edit__custom-total');
  assert.equal(input.getAttribute('max'), '150');
  assert.equal(input.getAttribute('min'), '1');

  setValue(page, '.cc-edit__custom-total', '150');
  assert.match(previewText(page), /New capacity: 150 ClaimChecks/);

  for (const bad of ['151', '200', '0', '-1']) {
    setValue(page, '.cc-edit__custom-total', bad);
    assert.match(previewText(page), /between 1 and 150/, `${bad} must be called out`);
  }

  page.cleanup();
});

test('the custom total is disabled while automatic mode is selected', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });

  assert.equal(page.document.querySelector('.cc-edit__custom-total').disabled, true);
  chooseMode(page, 'custom');
  assert.equal(page.document.querySelector('.cc-edit__custom-total').disabled, false);

  page.cleanup();
});

test('saving sends the allowance mode and the edited fields', async () => {
  const sent = [];
  const page = await loadAdmin({ rooms: [editRoom()], onPost: (b) => sent.push(b) });

  setValue(page, '.cc-edit__expected', '30');
  setValue(page, '.cc-edit__per-student', '5');
  fire(panelOf(page), 'submit');
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].expectedStudents, 30);
  assert.equal(sent[0].claimLimitPerStudent, 5);
  assert.equal(sent[0].allowanceMode, 'automatic');
  assert.ok(sent[0].expiresAt, 'the closing time is always sent, so it cannot drift');
  assert.equal(panelOf(page).hidden, true, 'and the panel closes on success');

  page.cleanup();
});

test('saving a custom allowance sends the mode and the total', async () => {
  const sent = [];
  const page = await loadAdmin({ rooms: [editRoom()], onPost: (b) => sent.push(b) });

  chooseMode(page, 'custom');
  setValue(page, '.cc-edit__custom-total', '3');
  fire(panelOf(page), 'submit');
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(sent[0].allowanceMode, 'custom');
  assert.equal(sent[0].customClaimLimit, 3);

  page.cleanup();
});

test('a reduction below usage asks for confirmation before saving', async () => {
  const sent = [];
  const asked = [];
  const page = await loadAdmin({
    rooms: [editRoom()],
    onPost: (b) => sent.push(b),
    confirm: (msg) => { asked.push(msg); return false; },
  });

  chooseMode(page, 'custom');
  setValue(page, '.cc-edit__custom-total', '30');
  fire(panelOf(page), 'submit');
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(asked.length, 1, 'the teacher is asked');
  assert.match(asked[0], /37 ClaimChecks have already been used/);
  assert.match(asked[0], /immediately stop new analyses/);
  assert.equal(sent.length, 0, 'and declining sends nothing');

  page.cleanup();
});

test('confirming a reduction goes through', async () => {
  const sent = [];
  const page = await loadAdmin({
    rooms: [editRoom()], onPost: (b) => sent.push(b), confirm: () => true,
  });

  chooseMode(page, 'custom');
  setValue(page, '.cc-edit__custom-total', '30');
  fire(panelOf(page), 'submit');
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].customClaimLimit, 30);

  page.cleanup();
});

test('an increase saves without an interruption', async () => {
  const asked = [];
  const page = await loadAdmin({
    rooms: [editRoom()], onPost: () => {}, confirm: (m) => { asked.push(m); return true; },
  });

  setValue(page, '.cc-edit__expected', '30');
  fire(panelOf(page), 'submit');
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(asked.length, 0, 'only a reduction is worth stopping for');

  page.cleanup();
});

test('the extend buttons move the closing time forward', async () => {
  const page = await loadAdmin({ rooms: [editRoom()] });

  const closesAt = page.document.querySelector('.cc-edit__closes-at');
  const before = new Date(closesAt.value).getTime();

  const plusHour = [...page.document.querySelectorAll('.cc-edit__extend .cc-btn')]
    .find((b) => b.textContent === '+1 hour');
  plusHour.dispatchEvent(new page.context.window.Event('click', { bubbles: true }));

  assert.equal(new Date(closesAt.value).getTime(), before + 60 * 60 * 1000);

  page.cleanup();
});

test('a classroom over its allowance says so on the card', async () => {
  const page = await loadAdmin({
    rooms: [editRoom({
      overCapacity: true, claimsUsed: 37, claimsRemaining: 0,
      effectiveClaimLimit: 30, allowanceMode: 'custom', claimLimit: 30, usable: false,
    })],
  });

  const notice = page.document.querySelector('.cc-internal--alert');
  assert.ok(notice, 'the card explains it rather than leaving "37 of 30" to be decoded');
  assert.match(notice.textContent, /Allowance is below usage/);
  assert.match(notice.textContent, /No further ClaimChecks can be started/);
  assert.match(notice.textContent, /Work already done is unaffected/);

  page.cleanup();
});

test('the dashboard shows which allowance mode a classroom is on', async () => {
  const auto = await loadAdmin({ rooms: [editRoom()] });
  const autoLabels = [...auto.document.querySelectorAll('.cc-stat__label')].map((n) => n.textContent);
  const autoValues = [...auto.document.querySelectorAll('.cc-stat__value')].map((n) => n.textContent);
  assert.equal(autoValues[autoLabels.indexOf('Allowance')], '25 × 4');
  auto.cleanup();

  const custom = await loadAdmin({
    rooms: [editRoom({ allowanceMode: 'custom', claimLimit: 3, effectiveClaimLimit: 3 })],
  });
  const labels = [...custom.document.querySelectorAll('.cc-stat__label')].map((n) => n.textContent);
  const values = [...custom.document.querySelectorAll('.cc-stat__value')].map((n) => n.textContent);
  assert.equal(values[labels.indexOf('Allowance')], 'Custom total');
  custom.cleanup();
});

test('the create form no longer offers a fixed total above 150', async () => {
  const page = await loadAdmin();

  const totals = [...page.$('create-capacity').options]
    .map((o) => Number(o.getAttribute('value')))
    .filter((n) => n > 0);

  assert.ok(totals.length > 0);
  assert.ok(Math.max(...totals) <= 150, `fixed totals were ${totals.join(', ')}`);

  page.cleanup();
});
