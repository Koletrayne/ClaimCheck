'use strict';

/* Tests for the security-critical parts of Classroom Mode: access-code
 * generation, anonymous session tokens, and classroom state gating.
 *
 * Uses Node's built-in test runner, so there is no test dependency to install.
 * Run with `npm test`.
 *
 * Nothing here touches the network or the database — the data-access functions
 * in lib/classroom.js are thin PostgREST wrappers, while the logic worth
 * pinning down is the crypto and the gating rules below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../lib/classroom');

const uuid = (n) => `${String(n).repeat(8)}-2222-3333-4444-555555555555`.slice(0, 36);

function makeClassroom(overrides = {}) {
  return {
    id: uuid(1),
    owner_id: uuid(2),
    display_name: 'Period 3 Civics',
    access_code: 'ABCD2345',
    session_secret: 'a'.repeat(64),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    active: true,
    token_budget: 100000,
    tokens_used: 0,
    analyses_run: 0,
    searches_used: 0,
    ...overrides,
  };
}

/* ── Access codes ─────────────────────────────────────────────────────── */

test('access codes have the expected shape and alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = c.generateAccessCode();
    assert.equal(code.length, c.CODE_LENGTH);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    assert.ok(c.isValidCodeShape(code));
  }
});

test('access codes exclude glyphs that are easy to misread', () => {
  for (const ambiguous of ['O', '0', 'I', '1', 'L']) {
    assert.ok(!c.CODE_ALPHABET.includes(ambiguous), `alphabet must not contain ${ambiguous}`);
  }
});

test('access codes do not repeat across many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(c.generateAccessCode());
  assert.equal(seen.size, 2000, 'generated codes should be unique');
});

test('code generation is not biased toward the start of the alphabet', () => {
  // Rejection sampling should leave every symbol roughly equally likely. A
  // modulo-biased generator would over-produce the first 8 symbols by ~12%.
  const counts = new Map();
  const draws = 40000;
  for (let i = 0; i < draws / c.CODE_LENGTH; i++) {
    for (const ch of c.generateAccessCode()) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  const expected = draws / c.CODE_ALPHABET.length;
  for (const ch of c.CODE_ALPHABET) {
    const n = counts.get(ch) || 0;
    assert.ok(
      Math.abs(n - expected) < expected * 0.25,
      `symbol ${ch} appeared ${n} times, expected around ${expected}`
    );
  }
});

test('codes normalize case, spaces and dashes; display form is grouped', () => {
  assert.equal(c.normalizeCode('abcd-2345'), 'ABCD2345');
  assert.equal(c.normalizeCode('  abcd 2345 '), 'ABCD2345');
  assert.equal(c.formatCode('abcd2345'), 'ABCD-2345');
});

test('malformed codes are rejected before any database lookup', () => {
  for (const bad of ['', 'SHORT', 'ABCD23456', 'ABCD-011I', null, undefined, 'ABCD 234!']) {
    assert.equal(c.isValidCodeShape(bad), false, `${bad} should be rejected`);
  }
});

/* ── Anonymous session tokens ─────────────────────────────────────────── */

test('a minted token verifies against its own classroom', () => {
  const room = makeClassroom();
  const token = c.mintSessionToken(room);
  assert.ok(c.verifySessionToken(c.peekSessionToken(token), room));
});

test('session tokens carry no student identity', () => {
  const room = makeClassroom();
  const claims = c.peekSessionToken(c.mintSessionToken(room)).claims;
  assert.deepEqual(Object.keys(claims).sort(), ['c', 'e', 'n']);
  assert.equal(claims.c, room.id);
  assert.equal(typeof claims.e, 'number');
});

test('two students in one classroom get unlinkable tokens', () => {
  const room = makeClassroom();
  const a = c.mintSessionToken(room);
  const b = c.mintSessionToken(room);
  assert.notEqual(a, b);
  assert.ok(c.verifySessionToken(c.peekSessionToken(a), room));
  assert.ok(c.verifySessionToken(c.peekSessionToken(b), room));
});

test('rotating the session secret revokes live sessions', () => {
  const room = makeClassroom();
  const token = c.mintSessionToken(room);
  const rotated = { ...room, session_secret: 'b'.repeat(64) };
  assert.equal(c.verifySessionToken(c.peekSessionToken(token), rotated), false);
});

test('a token is not valid for a different classroom', () => {
  const room = makeClassroom();
  const other = makeClassroom({ id: uuid(9) });
  const token = c.mintSessionToken(room);
  assert.equal(c.verifySessionToken(c.peekSessionToken(token), other), false);
});

test('tokens expire, and never outlive their classroom', () => {
  const past = makeClassroom({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const token = c.mintSessionToken(past);
  assert.equal(c.verifySessionToken(c.peekSessionToken(token), past), false);

  // A very long-lived classroom still yields a capped session.
  const long = makeClassroom({ expires_at: new Date(Date.now() + 30 * 24 * 3600e3).toISOString() });
  const claims = c.peekSessionToken(c.mintSessionToken(long)).claims;
  assert.ok(claims.e <= Date.now() + c.SESSION_MAX_MS + 1000);
});

test('tampered and malformed tokens are rejected', () => {
  const room = makeClassroom();
  const token = c.mintSessionToken(room);
  const [payload, sig] = token.split('.');

  assert.equal(c.verifySessionToken(c.peekSessionToken(`${payload}.AAAA`), room), false);
  assert.equal(c.verifySessionToken(c.peekSessionToken(`${payload}x.${sig}`), room), false);
  assert.equal(c.peekSessionToken('not-a-token'), null);
  assert.equal(c.peekSessionToken(''), null);
  assert.equal(c.peekSessionToken(null), null);
  assert.equal(c.verifySessionToken(null, room), false);

  // A forged payload claiming a longer expiry has no valid signature.
  const forged = Buffer.from(
    JSON.stringify({ c: room.id, e: Date.now() + 9e9, n: 'x' })
  ).toString('base64url');
  assert.equal(c.verifySessionToken(c.peekSessionToken(`${forged}.${sig}`), room), false);
});

/* ── Classroom gating ─────────────────────────────────────────────────── */

test('a healthy classroom is usable', () => {
  assert.ok(c.isUsable(makeClassroom()));
});

test('deactivated, expired and exhausted classrooms are not usable', () => {
  assert.equal(c.isUsable(makeClassroom({ active: false })), false);
  assert.equal(c.isUsable(makeClassroom({ expires_at: new Date(Date.now() - 1).toISOString() })), false);
  assert.equal(c.isUsable(makeClassroom({ tokens_used: 100000 })), false);
  assert.equal(c.isUsable(makeClassroom({ tokens_used: 100001 })), false);
});

test('remaining tokens never go negative', () => {
  assert.equal(c.remainingTokens(makeClassroom({ tokens_used: 250000 })), 0);
  assert.equal(c.remainingTokens(makeClassroom({ tokens_used: 40000 })), 60000);
});

/* ── View shaping ─────────────────────────────────────────────────────── */

test('the student view leaks no secret, code, or owner', () => {
  const view = c.publicView(makeClassroom());
  const keys = Object.keys(view);
  for (const forbidden of ['session_secret', 'sessionSecret', 'access_code', 'accessCode', 'owner_id', 'ownerId', 'id']) {
    assert.ok(!keys.includes(forbidden), `student view must not expose ${forbidden}`);
  }
  assert.equal(JSON.stringify(view).includes(makeClassroom().session_secret), false);
});

test('the owner view exposes the code but never the session secret', () => {
  const room = makeClassroom();
  const view = c.ownerView(room);
  assert.equal(view.accessCode, 'ABCD-2345');
  assert.equal(JSON.stringify(view).includes(room.session_secret), false);
  assert.equal(view.tokensRemaining, 100000);
});
