'use strict';

/* Tests for the Classroom Mode PII detector.
 *
 * The false-negative tests below matter less than the false-positive ones. A
 * detector that cries wolf on ordinary fact-checking claims teaches students to
 * dismiss the warning, at which point it protects nobody — so the "legitimate
 * claims stay clean" block is the load-bearing part of this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectPii } = require('../lib/pii');

/* ── True positives: the accidents this exists to catch ───────────────── */

test('detects an email address', () => {
  const r = detectPii('Is it true that jordan.smith@school.edu gets more spam?');
  assert.ok(r.found);
  assert.deepEqual(r.types, ['email']);
});

test('detects formatted phone numbers', () => {
  for (const text of [
    'call me at 555-123-4567',
    'my number is (555) 123-4567',
    'reach me: +1 555 123 4567',
    'phone 555.123.4567 please',
  ]) {
    assert.ok(detectPii(text).found, `should flag: ${text}`);
    assert.ok(detectPii(text).types.includes('phone'));
  }
});

test('detects an SSN-shaped string', () => {
  const r = detectPii('my social is 123-45-6789');
  assert.ok(r.types.includes('ssn'));
});

test('detects a street address', () => {
  for (const text of ['I live at 742 Evergreen Terrace', '52 Maple Street, apartment 3']) {
    assert.ok(detectPii(text).types.includes('address'), `should flag: ${text}`);
  }
});

test('detects a labeled student ID', () => {
  for (const text of ['student id 8827341', 'my Student Number: A448122', 'pupil id #99381']) {
    assert.ok(detectPii(text).types.includes('studentId'), `should flag: ${text}`);
  }
});

test('reports every distinct category present', () => {
  const r = detectPii('email me at a@b.edu or call 555-123-4567, student id 4471029');
  assert.equal(r.found, true);
  for (const type of ['email', 'phone', 'studentId']) {
    assert.ok(r.types.includes(type), `expected ${type}`);
  }
});

/* ── False positives: legitimate claims that must stay clean ──────────── */

test('ordinary fact-checking claims about named people are not flagged', () => {
  const claims = [
    'Did Marie Curie win Nobel Prizes in two different sciences?',
    'Abraham Lincoln was the tallest US president.',
    'Taylor Swift has won more Grammys than any other artist.',
    'Did Albert Einstein fail mathematics as a student?',
    'Rosa Parks refused to give up her bus seat in Montgomery in 1955.',
    'Dr. Anthony Fauci served as director of NIAID for 38 years.',
  ];
  for (const claim of claims) {
    const r = detectPii(claim);
    assert.equal(r.found, false, `should NOT flag a claim about a public figure: ${claim}\ngot: ${r.types}`);
  }
});

test('statistics, dates and large numbers are not mistaken for identifiers', () => {
  const claims = [
    'The population of Los Angeles County is about 9800000 people.',
    'The Great Wall of China is 21196 kilometers long.',
    'In 1969 the Apollo 11 mission landed 2 people on the moon.',
    'The federal budget deficit reached 1700000000000 dollars.',
    'Roughly 8000000000 people live on Earth as of 2023.',
    'The bill passed 218 to 210 in the House.',
    'Case number 12345678 was decided in 2019.',
  ];
  for (const claim of claims) {
    const r = detectPii(claim);
    assert.equal(r.found, false, `should NOT flag: ${claim}\ngot: ${r.types}`);
  }
});

test('an unlabeled run of digits is not treated as a student ID', () => {
  // This is the deliberate false negative that keeps the detector usable:
  // any "6+ digits means an ID" rule would fire on half the claims above.
  assert.equal(detectPii('The figure was 8827341 last year.').found, false);
});

test('personal names alone are never flagged', () => {
  assert.equal(detectPii('My name is Jordan Alvarez.').found, false);
  assert.equal(detectPii('I am in Ms. Chen’s third period class.').found, false);
});

/* ── Robustness ───────────────────────────────────────────────────────── */

test('handles empty and non-string input without throwing', () => {
  for (const input of ['', null, undefined, 42, {}, []]) {
    const r = detectPii(input);
    assert.equal(r.found, false);
    assert.deepEqual(r.types, []);
  }
});

test('repeated calls give the same answer', () => {
  // The patterns are module-level /g regexes; a stale lastIndex between calls
  // would make detection silently intermittent.
  const text = 'contact jordan@school.edu';
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(detectPii(text).types, ['email'], `call ${i + 1} disagreed`);
  }
});

test('the result never contains the matched text', () => {
  const r = detectPii('email jordan.smith@school.edu or call 555-123-4567');
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes('jordan'), false);
  assert.equal(serialized.includes('555'), false);
  assert.deepEqual(Object.keys(r).sort(), ['count', 'found', 'types']);
});
