'use strict';

/* Tests for source-to-claim relevance handling.
 *
 * The classroom pilot surfaced sources filed as "contradicting" that answered a
 * nearby question rather than the claim as stated. The model self-reports
 * relevance, so nothing here can catch a mislabeled source — what these assert
 * is that the label has consequences: direct evidence leads, and a verdict with
 * nothing direct behind it gets capped and explained instead of reading as
 * settled.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeClaim,
  applyRelevanceCheck,
  normalizeRelevance,
  RELEVANCE_LEVELS,
} = require('../lib/analyze');

function evidence(relevance, name, extra) {
  return {
    summary: 'What this source reports.',
    source_name: name,
    source_url: 'https://www.nature.com/' + name,
    source_type: 'peer_reviewed',
    relevance,
    addresses: 'The question this source answers.',
    credibility_tier: 'high',
    ...extra,
  };
}

function result(overrides) {
  return {
    verdict: 'supported',
    confidence: 'high',
    supporting_evidence: [],
    contradicting_evidence: [],
    ...overrides,
  };
}

const names = items => items.map(i => i.source_name);

test('direct sources are ordered ahead of related and background ones', () => {
  const r = result({
    supporting_evidence: [
      evidence('background', 'bg'),
      evidence('related', 'rel'),
      evidence('direct', 'dir'),
    ],
  });
  applyRelevanceCheck(r);
  assert.deepEqual(names(r.supporting_evidence), ['dir', 'rel', 'bg']);
});

test('the sort is stable within a relevance level', () => {
  const r = result({
    supporting_evidence: [
      evidence('related', 'rel1'),
      evidence('direct', 'dir1'),
      evidence('related', 'rel2'),
      evidence('direct', 'dir2'),
    ],
  });
  applyRelevanceCheck(r);
  assert.deepEqual(names(r.supporting_evidence), ['dir1', 'dir2', 'rel1', 'rel2']);
});

test('both evidence arrays are sorted', () => {
  const r = result({
    verdict: 'contradicted',
    supporting_evidence: [evidence('related', 's-rel'), evidence('direct', 's-dir')],
    contradicting_evidence: [evidence('background', 'c-bg'), evidence('direct', 'c-dir')],
  });
  applyRelevanceCheck(r);
  assert.deepEqual(names(r.supporting_evidence), ['s-dir', 's-rel']);
  assert.deepEqual(names(r.contradicting_evidence), ['c-dir', 'c-bg']);
});

test('a "contradicted" verdict with no direct contradicting source is capped and explained', () => {
  // The pilot's exact failure: sources filed as contradicting that answer a
  // different question.
  const r = result({
    verdict: 'contradicted',
    confidence: 'high',
    contradicting_evidence: [evidence('related', 'near-miss')],
  });
  const summary = applyRelevanceCheck(r);

  assert.equal(summary.verdict_rests_on_indirect, true);
  assert.equal(summary.contradicting_direct, 0);
  assert.equal(r.confidence, 'low');
  assert.match(r.uncertainty_notes, /None of the sources found test this claim directly/);
  // The verdict itself is left alone — the evidence is still informative.
  assert.equal(r.verdict, 'contradicted');
});

test('a "supported" verdict is judged on its supporting evidence, not the other side', () => {
  const r = result({
    verdict: 'supported',
    supporting_evidence: [evidence('related', 's-rel')],
    contradicting_evidence: [evidence('direct', 'c-dir')],
  });
  const summary = applyRelevanceCheck(r);

  assert.equal(summary.verdict_rests_on_indirect, true);
  assert.equal(summary.supporting_direct, 0);
  assert.equal(summary.contradicting_direct, 1);
  assert.equal(r.confidence, 'low');
});

test('one direct source on the deciding side leaves the verdict untouched', () => {
  const r = result({
    verdict: 'supported',
    confidence: 'high',
    supporting_evidence: [evidence('direct', 'dir'), evidence('related', 'rel')],
  });
  const summary = applyRelevanceCheck(r);

  assert.equal(summary.verdict_rests_on_indirect, false);
  assert.equal(r.confidence, 'high');
  assert.equal(r.uncertainty_notes, undefined);
});

test('an "unclear" verdict is never downgraded — it claims nothing to begin with', () => {
  const r = result({
    verdict: 'unclear',
    confidence: 'medium',
    supporting_evidence: [evidence('related', 'rel')],
  });
  const summary = applyRelevanceCheck(r);

  assert.equal(summary.verdict_rests_on_indirect, false);
  assert.equal(r.confidence, 'medium');
  assert.equal(r.uncertainty_notes, undefined);
});

test('a verdict with no evidence at all is not blamed on relevance', () => {
  // "No sources found" is a different problem with its own explanation; adding
  // a relevance note here would misdescribe what happened.
  const r = result({ verdict: 'supported', confidence: 'medium' });
  const summary = applyRelevanceCheck(r);

  assert.equal(summary.verdict_rests_on_indirect, false);
  assert.equal(r.confidence, 'medium');
  assert.equal(r.uncertainty_notes, undefined);
});

test('an existing uncertainty note is kept, not overwritten', () => {
  const r = result({
    verdict: 'supported',
    uncertainty_notes: 'Data is from 2019.',
    supporting_evidence: [evidence('related', 'rel')],
  });
  applyRelevanceCheck(r);

  assert.match(r.uncertainty_notes, /^Data is from 2019\./);
  assert.match(r.uncertainty_notes, /test this claim directly/);
});

test('malformed evidence arrays and items do not throw', () => {
  const r = result({ supporting_evidence: null, contradicting_evidence: [null, 'nope', 42] });
  assert.doesNotThrow(() => applyRelevanceCheck(r));
});

test('relevance normalizes to the enum, defaulting to "related"', () => {
  // Defaulting to "related" rather than "direct" matters: an unlabeled source is
  // one whose bearing on the claim was never established, and overstating that
  // is the failure this field exists to prevent.
  assert.equal(normalizeRelevance('DIRECT'), 'direct');
  assert.equal(normalizeRelevance('  background '), 'background');
  assert.equal(normalizeRelevance('somewhat relevant'), 'related');
  assert.equal(normalizeRelevance(''), 'related');
  assert.equal(normalizeRelevance(null), 'related');
  assert.equal(normalizeRelevance(undefined), 'related');
  for (const r of RELEVANCE_LEVELS) assert.equal(normalizeRelevance(r), r);
});

/* ── End to end through analyzeClaim ─────────────────── */

function stubFetch(modelJson) {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(modelJson) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  });
  return { restore: () => { global.fetch = original; } };
}

test('analyzeClaim normalizes relevance, sorts, and reports the summary', async () => {
  const stub = stubFetch(result({
    claim_text: 'EVs produce fewer lifetime emissions.',
    verdict: 'supported',
    confidence: 'high',
    supporting_evidence: [
      evidence('related', 'rel'),
      evidence(undefined, 'unlabeled'),
      evidence('direct', 'dir'),
    ],
  }));
  try {
    const r = await analyzeClaim({ text: 'EVs produce fewer lifetime emissions.' });
    assert.deepEqual(names(r.supporting_evidence), ['dir', 'rel', 'unlabeled']);
    // An unlabeled source is treated as related, never as direct.
    assert.equal(r.supporting_evidence[2].relevance, 'related');
    assert.equal(r._meta.relevance.supporting_direct, 1);
    assert.equal(r._meta.relevance.verdict_rests_on_indirect, false);
    assert.equal(r.confidence, 'high');
  } finally {
    stub.restore();
  }
});

test('analyzeClaim caps confidence when nothing found tests the claim', async () => {
  const stub = stubFetch(result({
    verdict: 'contradicted',
    confidence: 'high',
    contradicting_evidence: [evidence('related', 'near-miss')],
  }));
  try {
    const r = await analyzeClaim({ text: 'EVs produce fewer lifetime emissions.' });
    assert.equal(r.confidence, 'low');
    assert.equal(r._meta.relevance.verdict_rests_on_indirect, true);
    assert.match(r.uncertainty_notes, /test this claim directly/);
  } finally {
    stub.restore();
  }
});

test('academic filtering runs before the relevance check, not after', async () => {
  // Removing the only direct source has to leave the verdict qualified — the
  // relevance check must judge what survives, not what the model first returned.
  const stub = stubFetch(result({
    verdict: 'supported',
    confidence: 'high',
    supporting_evidence: [
      evidence('direct', 'newsroom', { source_url: 'https://www.nytimes.com/x', source_type: 'news' }),
      evidence('related', 'journal'),
    ],
  }));
  try {
    const r = await analyzeClaim({ text: 'A claim.', academicMode: true });
    assert.equal(r.supporting_evidence.length, 1);
    assert.equal(r._meta.filtered_sources.length, 1);
    assert.equal(r._meta.relevance.supporting_direct, 0);
    assert.equal(r._meta.relevance.verdict_rests_on_indirect, true);
    assert.equal(r.confidence, 'low');
  } finally {
    stub.restore();
  }
});
