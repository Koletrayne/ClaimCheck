'use strict';

/* Tests for the agentic loop's turn control.
 *
 * These exist because of a live production failure: Spanish snapshots returned
 * 502 every time with "This model does not support assistant message prefill."
 * The loop treated any unrecognized stop_reason as "keep going", so a response
 * cut off by "max_tokens" was pushed onto the message list and re-sent —
 * asking the API to continue from a truncated assistant turn, which it rejects.
 *
 * The tests assert on what the loop SENDS, not just what it returns, because
 * the bug was invisible in the return value.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeClaim, snapshotTokenBudget } = require('../lib/analyze');

const MODEL_JSON = JSON.stringify({
  claim_text: 'A claim.',
  verdict: 'supported',
  confidence: 'medium',
  verdict_explanation: 'Because.',
  breakdown: {},
  supporting_evidence: [],
  contradicting_evidence: [],
  reflection_questions: [],
});

/**
 * Stubs fetch with a queue of API responses and records every request body, so
 * a test can assert on what was actually sent.
 */
function stubFetch(responses) {
  const original = global.fetch;
  const sent = [];
  let call = 0;
  global.fetch = async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: true, json: async () => r };
  };
  return {
    sent,
    get calls() { return call; },
    restore: () => { global.fetch = original; },
  };
}

const searchBlock = { type: 'server_tool_use', name: 'web_search', input: {} };

function turn(stop_reason, content) {
  return { stop_reason, content, usage: { input_tokens: 10, output_tokens: 10 } };
}

test('a truncated turn is never re-sent as a prefill', async () => {
  // The exact production failure: max_tokens on a turn that also used a tool.
  // The old loop continued here, appending a truncated assistant message and
  // asking the API to continue from it.
  const stub = stubFetch([
    turn('max_tokens', [searchBlock, { type: 'text', text: '{"claim_text":"A cla' }]),
    turn('end_turn', [{ type: 'text', text: MODEL_JSON }]),
  ]);
  try {
    await assert.rejects(
      () => analyzeClaim({ text: 'A claim.', snapshot: true, language: 'es' }),
      /ran out of room/
    );
    assert.equal(stub.calls, 1, 'must not make a second call after truncation');
    const last = stub.sent[0].messages;
    assert.equal(last[last.length - 1].role, 'user', 'conversation must end with a user message');
  } finally {
    stub.restore();
  }
});

test('truncation reports a message the user can act on', async () => {
  const stub = stubFetch([turn('max_tokens', [{ type: 'text', text: '{"claim' }])]);
  try {
    // Snapshot mode has a specific remedy, so it gets a specific message.
    await assert.rejects(
      () => analyzeClaim({ text: 'A claim.', snapshot: true }),
      /Turn off Quick snapshot/
    );
  } finally {
    stub.restore();
  }

  const stub2 = stubFetch([turn('max_tokens', [{ type: 'text', text: '{"claim' }])]);
  try {
    const err = await analyzeClaim({ text: 'A claim.' }).catch(e => e);
    assert.match(err.message, /ran out of room/);
    assert.doesNotMatch(err.message, /Quick snapshot/);
    // The old message told the user to ADD text, which is the wrong advice here.
    assert.doesNotMatch(err.message, /more text/);
  } finally {
    stub2.restore();
  }
});

test('a truncated turn that still parsed is not treated as an error', async () => {
  // max_tokens can land after the JSON is complete; there is nothing wrong with
  // that result, so it should be returned rather than rejected.
  const stub = stubFetch([turn('max_tokens', [{ type: 'text', text: MODEL_JSON + '\n\nSome trailing' }])]);
  try {
    const r = await analyzeClaim({ text: 'A claim.', snapshot: true });
    assert.equal(r.verdict, 'supported');
  } finally {
    stub.restore();
  }
});

test('an unrecognized stop reason ends the loop instead of continuing', async () => {
  const stub = stubFetch([
    turn('some_future_reason', [searchBlock, { type: 'text', text: MODEL_JSON }]),
    turn('end_turn', [{ type: 'text', text: MODEL_JSON }]),
  ]);
  try {
    const r = await analyzeClaim({ text: 'A claim.' });
    assert.equal(r.verdict, 'supported');
    assert.equal(stub.calls, 1, 'unknown reasons must not drive another turn');
  } finally {
    stub.restore();
  }
});

test('tool_use still drives another turn', async () => {
  const stub = stubFetch([
    turn('tool_use', [searchBlock]),
    turn('end_turn', [{ type: 'text', text: MODEL_JSON }]),
  ]);
  try {
    const r = await analyzeClaim({ text: 'A claim.' });
    assert.equal(r.verdict, 'supported');
    assert.equal(stub.calls, 2, 'a pending tool call must continue the loop');
  } finally {
    stub.restore();
  }
});

test('a continuation reason with no pending tool call does not spin', async () => {
  const stub = stubFetch([turn('tool_use', [{ type: 'text', text: MODEL_JSON }])]);
  try {
    await analyzeClaim({ text: 'A claim.' });
    assert.equal(stub.calls, 1);
  } finally {
    stub.restore();
  }
});

test('searches on the final turn are counted', async () => {
  // The API resolves server-side tools within one request, so a response can
  // carry search blocks and still finish with end_turn. Counting after the exit
  // check dropped those searches and reported "0 searches" for an analysis that
  // plainly did some.
  const stub = stubFetch([turn('end_turn', [searchBlock, searchBlock, { type: 'text', text: MODEL_JSON }])]);
  try {
    const r = await analyzeClaim({ text: 'A claim.' });
    assert.equal(r._meta.searches_used, 2);
  } finally {
    stub.restore();
  }
});

test('searches are summed across turns', async () => {
  const stub = stubFetch([
    turn('tool_use', [searchBlock]),
    turn('end_turn', [searchBlock, { type: 'text', text: MODEL_JSON }]),
  ]);
  try {
    const r = await analyzeClaim({ text: 'A claim.' });
    assert.equal(r._meta.searches_used, 2);
  } finally {
    stub.restore();
  }
});

test('snapshots get more output room in languages that need it', () => {
  // Spanish renders the same analysis longer than English; at the English
  // budget it reliably hit the cap mid-JSON.
  assert.equal(snapshotTokenBudget('en'), 2500);
  assert.ok(snapshotTokenBudget('es') > snapshotTokenBudget('en'));
});

test('the token budget actually sent matches the mode and language', async () => {
  const cases = [
    [{ snapshot: true, language: 'en' }, 2500],
    [{ snapshot: true, language: 'es' }, snapshotTokenBudget('es')],
    [{ language: 'es' }, 6144],
    [{}, 6144],
  ];
  for (const [opts, expected] of cases) {
    const stub = stubFetch([turn('end_turn', [{ type: 'text', text: MODEL_JSON }])]);
    try {
      await analyzeClaim({ text: 'A claim.', ...opts });
      assert.equal(stub.sent[0].max_tokens, expected, JSON.stringify(opts));
    } finally {
      stub.restore();
    }
  }
});
