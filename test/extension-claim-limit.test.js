'use strict';

/* Tests the browser extension's claim-length gate.
 *
 * Lives in the backend's test directory because that is where the project's
 * only test runner is; the extension has no build step and no package.json of
 * its own, and giving it one to hold three tests would cost more than it
 * returns. The paths below reach across into ../../claimcheck-extension.
 *
 * The real sidepanel.html and sidepanel.js are loaded into a linkedom DOM with
 * the Chrome extension APIs shimmed, so what is asserted is the shipping code,
 * not a restatement of it.
 *
 * Scope note: this covers the CLIENT-side convenience check only. The server
 * enforces the same cap independently — see guardrails.test.js — and the
 * extension cannot weaken that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { parseHTML } = require('linkedom');

const EXT = path.join(__dirname, '..', '..', 'claimcheck-extension');
const readExt = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');

// The extension lives in a sibling directory that is NOT part of this
// repository, so a fresh clone of the backend alone will not have it. Skipping
// is the honest outcome there: reporting a pass for code that was never loaded
// would be worse than reporting nothing. Where both directories are checked out
// side by side — the normal working setup — these run for real.
const EXTENSION_PRESENT = fs.existsSync(path.join(EXT, 'sidepanel', 'sidepanel.js'));
const suite = EXTENSION_PRESENT ? test : test.skip;

if (!EXTENSION_PRESENT) {
  console.warn(`[test] claimcheck-extension not found at ${EXT} — extension tests skipped.`);
}

/**
 * Loads the side panel with a Chrome API shim.
 *
 * `maxClaimCharacters` is what the shimmed background script reports back, so a
 * test can confirm the panel honours the server's configured number rather than
 * its own built-in fallback.
 */
async function loadPanel({ maxClaimCharacters = 750, pendingAnalysis = null } = {}) {
  const dom = parseHTML(readExt('sidepanel/sidepanel.html'));
  const { document } = dom;

  for (const proto of [dom.HTMLElement.prototype, dom.Element.prototype]) {
    if (!proto.scrollIntoView) proto.scrollIntoView = function () {};
    if (!proto.focus) proto.focus = function () {};
  }

  const sessionStore = pendingAnalysis ? { pendingAnalysis } : {};
  const sent = [];

  const area = (store) => ({
    get: async (keys) => {
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
      return { ...(keys || {}), ...store };
    },
    set: async (obj) => { Object.assign(store, obj); },
    remove: async (k) => { delete store[k]; },
  });

  const timers = [];
  const sandbox = {
    document,
    console,
    crypto: webcrypto,
    navigator: { language: 'en-US' },
    location: { href: 'chrome-extension://test/sidepanel.html', hash: '', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; },
    clearTimeout,
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); timers.push(id); return id; },
    clearInterval,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    URL,
    URLSearchParams,
    fetch: async () => { throw new Error('network disabled in this test'); },
    addEventListener() {},
    removeEventListener() {},
    chrome: {
      runtime: {
        lastError: null,
        openOptionsPage() {},
        sendMessage: async (msg) => {
          sent.push(msg);
          if (msg && msg.type === 'claimcheck/limits') return { ok: true, maxClaimCharacters };
          if (msg && msg.type === 'claimcheck/analyze') {
            // Never settles: any test that reaches here has already failed its
            // real assertion, and hanging is louder than a fake success.
            return new Promise(() => {});
          }
          return { ok: false, error: 'unhandled' };
        },
      },
      storage: {
        sync: area({ backendUrl: 'http://localhost:3001', academicMode: false, historyLimit: 20 }),
        local: area({}),
        session: area(sessionStore),
        onChanged: { addListener() {} },
      },
      identity: { getRedirectURL: () => 'https://test/', launchWebAuthFlow: async () => '' },
    },
    // The panel's Supabase layer. Signed-out is the simplest honest state and
    // keeps auth entirely out of what these tests are measuring.
    ccSupabase: null,
    supabase: { createClient: () => null },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(readExt('sidepanel/sidepanel.js'), context, { filename: 'sidepanel.js' });

  // init() is async; let it run to completion (or to a rejection it handles).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  return {
    context,
    document,
    sent,
    $: (id) => document.getElementById(id),
    cleanup: () => timers.forEach((id) => { clearTimeout(id); clearInterval(id); }),
  };
}

const fire = (el, type) => el.dispatchEvent(new (el.ownerDocument.defaultView || globalThis).Event(type, { bubbles: true }));

suite('the panel asks the backend for the configured limit', async () => {
  const panel = await loadPanel({ maxClaimCharacters: 500 });
  try {
    assert.ok(
      panel.sent.some((m) => m.type === 'claimcheck/limits'),
      'the panel should not hardcode the limit'
    );
    panel.$('paste-input').value = 'a'.repeat(501);
    fire(panel.$('paste-input'), 'input');
    assert.equal(panel.$('char-counter').textContent, '501 / 500');
  } finally {
    panel.cleanup();
  }
});

suite('a pasted claim over the limit is not submitted', async () => {
  const panel = await loadPanel();
  try {
    panel.$('paste-input').value = 'a'.repeat(751);
    fire(panel.$('paste-input'), 'input');
    fire(panel.$('analyze-btn'), 'click');

    const analyzed = panel.sent.filter((m) => m.type === 'claimcheck/analyze');
    assert.equal(analyzed.length, 0, 'no analysis request may be sent');

    const error = panel.$('error');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /750 characters/);
  } finally {
    panel.cleanup();
  }
});

suite('a claim at exactly the limit is submitted', async () => {
  const panel = await loadPanel();
  try {
    panel.$('paste-input').value = 'a'.repeat(750);
    fire(panel.$('paste-input'), 'input');
    fire(panel.$('analyze-btn'), 'click');
    await new Promise((r) => setImmediate(r));

    assert.equal(
      panel.sent.filter((m) => m.type === 'claimcheck/analyze').length, 1,
      '750 is within the limit and must go through'
    );
  } finally {
    panel.cleanup();
  }
});

suite('an over-long highlighted selection is refused with selection-specific wording', async () => {
  // The context-menu path. Someone who highlighted three paragraphs needs to be
  // told to highlight less — not to "trim what they pasted", which they didn't.
  const panel = await loadPanel({
    pendingAnalysis: { text: 'a'.repeat(4000), sourceUrl: 'https://example.com/article' },
  });
  try {
    const analyzed = panel.sent.filter((m) => m.type === 'claimcheck/analyze');
    assert.equal(analyzed.length, 0, 'a too-long selection must never reach the backend');

    const error = panel.$('error');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /selection is too long/i);
    assert.match(error.textContent, /highlight the specific factual statement/i);
  } finally {
    panel.cleanup();
  }
});

suite('the over-long selection is left in the box so it can be trimmed', async () => {
  // Discarding it would send the user back to the page to re-highlight blind.
  const panel = await loadPanel({
    pendingAnalysis: { text: 'a'.repeat(4000), sourceUrl: 'https://example.com/article' },
  });
  try {
    assert.equal(panel.$('paste-input').value.length, 4000);
    assert.equal(panel.$('char-counter').textContent, '4000 / 750');
    assert.ok(panel.$('char-counter').className.includes('char-counter--over'));
  } finally {
    panel.cleanup();
  }
});

suite('a selection within the limit still runs automatically', async () => {
  const panel = await loadPanel({
    pendingAnalysis: { text: 'Coffee reduces the risk of type 2 diabetes.', sourceUrl: 'https://example.com/a' },
  });
  try {
    assert.equal(
      panel.sent.filter((m) => m.type === 'claimcheck/analyze').length, 1,
      'the existing selection workflow must be unchanged for normal selections'
    );
  } finally {
    panel.cleanup();
  }
});
