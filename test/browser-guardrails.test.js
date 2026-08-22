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
