'use strict';

/* Tests for token accounting in the analysis pipeline.
 *
 * Classroom budgets are only as trustworthy as these numbers, and the failure
 * mode is silent: reading usage off the last turn instead of summing every turn
 * under-counts a research-heavy claim several times over, letting a class run
 * far past the budget its teacher set.
 *
 * The Anthropic API is stubbed here — these assert our accumulation arithmetic,
 * not the provider's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeClaim, totalTokens, emptyUsage } = require('../lib/analyze');

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

/** One API turn that used a web search and has not finished yet. */
function searchTurn(usage) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'server_tool_use', name: 'web_search', input: {} }],
    usage,
  };
}

/** The final API turn, carrying the JSON result. */
function finalTurn(usage) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: MODEL_JSON }],
    usage,
  };
}

/**
 * Replaces global fetch with a stub that returns the given responses in order,
 * and restores the original afterwards.
 */
function stubFetch(responses) {
  const original = global.fetch;
  let call = 0;
  global.fetch = async () => {
    const body = responses[call++];
    if (!body) throw new Error('stub fetch called more times than expected');
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return {
    calls: () => call,
    restore: () => { global.fetch = original; },
  };
}

test('usage is summed across every turn, not read off the last one', async () => {
  const stub = stubFetch([
    searchTurn({ input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 1 } }),
    searchTurn({ input_tokens: 4000, output_tokens: 150, server_tool_use: { web_search_requests: 2 } }),
    finalTurn({ input_tokens: 9000, output_tokens: 800 }),
  ]);

  try {
    const result = await analyzeClaim({ text: 'Coffee reduces type 2 diabetes risk.' });
    const usage = result._usage;

    assert.equal(stub.calls(), 3, 'expected three API turns');
    assert.equal(usage.input_tokens, 14000);
    assert.equal(usage.output_tokens, 1150);
    assert.equal(usage.web_search_requests, 3);
    assert.equal(usage.api_calls, 3);

    // The whole point: the last turn alone reports 9800 tokens, but the
    // analysis actually consumed 15150.
    assert.equal(totalTokens(usage), 15150);
    assert.notEqual(totalTokens(usage), 9800);
  } finally {
    stub.restore();
  }
});

test('cache tokens are counted toward the budget', async () => {
  const stub = stubFetch([
    finalTurn({
      input_tokens: 500,
      output_tokens: 300,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 1000,
    }),
  ]);

  try {
    const result = await analyzeClaim({ text: 'Coffee reduces type 2 diabetes risk.' });
    assert.equal(result._usage.cache_read_input_tokens, 2000);
    assert.equal(result._usage.cache_creation_input_tokens, 1000);
    assert.equal(totalTokens(result._usage), 3800);
  } finally {
    stub.restore();
  }
});

test('a response missing usage does not break accounting', async () => {
  const stub = stubFetch([
    searchTurn(undefined),
    finalTurn({ input_tokens: 100, output_tokens: 50 }),
  ]);

  try {
    const result = await analyzeClaim({ text: 'Coffee reduces type 2 diabetes risk.' });
    assert.equal(totalTokens(result._usage), 150);
    assert.equal(result._usage.api_calls, 2);
    assert.ok(Number.isFinite(totalTokens(result._usage)));
  } finally {
    stub.restore();
  }
});

test('usage carries no student-authored content', async () => {
  const stub = stubFetch([finalTurn({ input_tokens: 100, output_tokens: 50 })]);

  try {
    const secret = 'my name is Jordan and my phone is 555-0143';
    const result = await analyzeClaim({ text: secret });

    // Everything in the usage record must be a plain number, so a classroom's
    // stored counters can never contain anything a student typed.
    for (const [key, value] of Object.entries(result._usage)) {
      assert.equal(typeof value, 'number', `_usage.${key} should be a number`);
    }
    assert.equal(JSON.stringify(result._usage).includes('Jordan'), false);
  } finally {
    stub.restore();
  }
});

test('totalTokens and emptyUsage handle edge cases', () => {
  assert.equal(totalTokens(null), 0);
  assert.equal(totalTokens(undefined), 0);
  assert.equal(totalTokens({}), 0);
  assert.equal(totalTokens(emptyUsage()), 0);
  assert.equal(emptyUsage().web_search_requests, 0);
});

test('the public result shape is unchanged apart from the added _usage key', async () => {
  const stub = stubFetch([finalTurn({ input_tokens: 100, output_tokens: 50 })]);

  try {
    const result = await analyzeClaim({ text: 'Coffee reduces type 2 diabetes risk.' });
    // Fields the website, extension, history sync and exports rely on.
    for (const field of ['claim_text', 'verdict', 'verdict_explanation', 'breakdown',
      'supporting_evidence', 'contradicting_evidence', 'reflection_questions', '_meta']) {
      assert.ok(field in result, `result should still carry ${field}`);
    }
    assert.equal(result.verdict, 'supported');
    assert.equal(result._meta.searches_used, 0);
    assert.equal(result._meta.language, 'en');
  } finally {
    stub.restore();
  }
});
