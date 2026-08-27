'use strict';

/* Tests for academic mode's source filter.
 *
 * The web_search tool's allowed_domains only constrains what a SEARCH returns —
 * it cannot stop the model from citing a newspaper it already knows about. That
 * gap is how unexpected domains reached students during the classroom pilot, so
 * these assert the server-side enforcement rather than the prompt wording.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeClaim,
  applyAcademicFilter,
  isAcademicHost,
  normalizeSourceType,
  SOURCE_TYPES,
} = require('../lib/analyze');

/** Replaces global fetch with one that returns a single finished turn. */
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

function evidence(overrides) {
  return {
    summary: 'A study found an effect.',
    source_name: 'Example',
    source_url: 'https://www.nature.com/articles/example',
    source_type: 'peer_reviewed',
    credibility_note: 'peer-reviewed journal',
    credibility_tier: 'high',
    ...overrides,
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

test('approved scholarly, government and IGO hosts pass', () => {
  for (const url of [
    'https://www.nature.com/articles/x',
    'https://pubmed.ncbi.nlm.nih.gov/12345/',   // subdomain of a listed domain
    'https://www.cdc.gov/data',
    'https://www.who.int/report',
    'https://arxiv.org/abs/2401.00001',
    'https://www.washington.edu/study',          // .edu suffix, not individually listed
    'https://www.ons.gov.uk/data',               // .gov suffix
    'https://www.bristol.ac.uk/research',        // .ac.uk suffix
  ]) {
    assert.equal(isAcademicHost(url), true, url);
  }
});

test('news, blogs, and unparseable URLs do not pass', () => {
  for (const url of [
    'https://www.nytimes.com/2024/01/01/story.html',
    'https://medium.com/@someone/post',
    'https://www.foxnews.com/politics/story',
    'not a url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isAcademicHost(url), false, String(url));
  }
});

test('a lookalike domain does not pass on a listed domain as a substring', () => {
  assert.equal(isAcademicHost('https://notnature.com/x'), false);
  assert.equal(isAcademicHost('https://nature.com.evil.co/x'), false);
  assert.equal(isAcademicHost('https://cdc.gov.example.com/x'), false);
  assert.equal(isAcademicHost('https://myedu.com/x'), false);
});

test('an off-list domain is removed and reported', () => {
  const r = result({
    supporting_evidence: [
      evidence(),
      evidence({ source_name: 'NYT', source_url: 'https://www.nytimes.com/story', source_type: 'news' }),
    ],
  });
  const removed = applyAcademicFilter(r);

  assert.equal(r.supporting_evidence.length, 1);
  assert.equal(r.supporting_evidence[0].source_name, 'Example');
  assert.deepEqual(removed, [
    { source_name: 'NYT', domain: 'nytimes.com', source_type: 'news', reason: 'domain' },
  ]);
});

test('an approved host with a non-academic source_type is still removed', () => {
  // A think tank hosted on a .edu is exactly the case the pilot flagged as
  // unexpected under an "academic" filter.
  const r = result({
    supporting_evidence: [evidence({
      source_name: 'Policy Center',
      source_url: 'https://www.someuniversity.edu/policy-blog',
      source_type: 'advocacy',
    })],
  });
  const removed = applyAcademicFilter(r);

  assert.equal(r.supporting_evidence.length, 0);
  assert.equal(removed[0].reason, 'source_type');
});

test('an approved source_type without a usable URL is removed', () => {
  const r = result({
    supporting_evidence: [evidence({ source_url: '', source_type: 'peer_reviewed' })],
  });
  const removed = applyAcademicFilter(r);

  assert.equal(r.supporting_evidence.length, 0);
  assert.equal(removed[0].reason, 'domain');
  assert.equal(removed[0].domain, '');
});

test('contradicting evidence is filtered on the same terms', () => {
  const r = result({
    supporting_evidence: [evidence()],
    contradicting_evidence: [
      evidence({ source_url: 'https://www.breitbart.com/x', source_type: 'news' }),
      evidence({ source_url: 'https://www.bmj.com/content/x' }),
    ],
  });
  applyAcademicFilter(r);

  assert.equal(r.supporting_evidence.length, 1);
  assert.equal(r.contradicting_evidence.length, 1);
  assert.equal(r.contradicting_evidence[0].source_url, 'https://www.bmj.com/content/x');
});

test('filtering away every source falls back to an unclear verdict', () => {
  const r = result({
    verdict: 'supported',
    confidence: 'high',
    uncertainty_notes: 'Evidence is recent.',
    supporting_evidence: [evidence({ source_url: 'https://www.cnn.com/x', source_type: 'news' })],
  });
  const removed = applyAcademicFilter(r);

  assert.equal(removed.length, 1);
  assert.equal(r.verdict, 'unclear');
  assert.equal(r.confidence, 'low');
  // The pre-existing note is kept, not overwritten.
  assert.match(r.uncertainty_notes, /^Evidence is recent\./);
  assert.match(r.uncertainty_notes, /Academic mode removed every source/);
});

test('a verdict survives when at least one approved source remains', () => {
  const r = result({
    supporting_evidence: [evidence()],
    contradicting_evidence: [evidence({ source_url: 'https://www.cnn.com/x', source_type: 'news' })],
  });
  applyAcademicFilter(r);

  assert.equal(r.verdict, 'supported');
  assert.equal(r.confidence, 'high');
  assert.equal(r.uncertainty_notes, undefined);
});

test('malformed evidence arrays and items do not throw', () => {
  const r = result({ supporting_evidence: null, contradicting_evidence: [null, 'nope', 42] });
  assert.doesNotThrow(() => applyAcademicFilter(r));
  assert.deepEqual(r.supporting_evidence, []);
  assert.deepEqual(r.contradicting_evidence, []);
});

test('removal records carry no student-authored text, only source identifiers', () => {
  const r = result({
    supporting_evidence: [evidence({
      summary: 'SENSITIVE claim wording that must not leak.',
      source_url: 'https://www.nytimes.com/story',
      source_type: 'news',
    })],
  });
  const removed = applyAcademicFilter(r);
  assert.equal(JSON.stringify(removed).includes('SENSITIVE'), false);
  assert.deepEqual(Object.keys(removed[0]).sort(), ['domain', 'reason', 'source_name', 'source_type']);
});

test('analyzeClaim applies the filter in academic mode and reports what it removed', async () => {
  const stub = stubFetch(result({
    claim_text: 'Coffee reduces type 2 diabetes risk.',
    supporting_evidence: [
      evidence(),
      evidence({ source_name: 'NYT', source_url: 'https://www.nytimes.com/story', source_type: 'news' }),
    ],
  }));
  try {
    const r = await analyzeClaim({ text: 'Coffee reduces type 2 diabetes risk.', academicMode: true });
    assert.equal(r.supporting_evidence.length, 1);
    assert.equal(r._meta.filtered_sources.length, 1);
    assert.equal(r._meta.filtered_sources[0].domain, 'nytimes.com');
  } finally {
    stub.restore();
  }
});

test('standard mode keeps every source and reports nothing filtered', async () => {
  const stub = stubFetch(result({
    supporting_evidence: [
      evidence(),
      evidence({ source_name: 'NYT', source_url: 'https://www.nytimes.com/story', source_type: 'news' }),
    ],
  }));
  try {
    const r = await analyzeClaim({ text: 'Coffee reduces type 2 diabetes risk.' });
    assert.equal(r.supporting_evidence.length, 2);
    assert.deepEqual(r._meta.filtered_sources, []);
  } finally {
    stub.restore();
  }
});

test('analyzeClaim normalizes source_type on every evidence item in both modes', async () => {
  const stub = stubFetch(result({
    supporting_evidence: [evidence({ source_type: 'Academic Journal' })],
    contradicting_evidence: [evidence({ source_type: undefined })],
  }));
  try {
    const r = await analyzeClaim({ text: 'Coffee reduces type 2 diabetes risk.' });
    assert.equal(r.supporting_evidence[0].source_type, 'other');
    assert.equal(r.contradicting_evidence[0].source_type, 'other');
  } finally {
    stub.restore();
  }
});

test('source_type normalizes to the enum, defaulting to "other"', () => {
  assert.equal(normalizeSourceType('PEER_REVIEWED'), 'peer_reviewed');
  assert.equal(normalizeSourceType('  government '), 'government');
  assert.equal(normalizeSourceType('academic journal'), 'other');
  assert.equal(normalizeSourceType(''), 'other');
  assert.equal(normalizeSourceType(null), 'other');
  assert.equal(normalizeSourceType(undefined), 'other');
  assert.equal(normalizeSourceType(123), 'other');
  for (const t of SOURCE_TYPES) assert.equal(normalizeSourceType(t), t);
});
