'use strict';

/* Lightweight PII detection for Classroom Mode.
 *
 * PURPOSE AND LIMITS — read before changing these patterns.
 *
 * The goal is narrow: catch a student who pastes their own contact details or
 * ID number into the claim box by accident. It is NOT a general PII scrubber
 * and must never be treated as one.
 *
 * Two deliberate design decisions:
 *
 * 1. It detects only strongly-structured identifiers — email addresses, phone
 *    numbers, SSN-shaped strings, street addresses, and label-anchored student
 *    IDs. It does NOT attempt to detect personal names. Name detection is the
 *    single largest false-positive source, and ClaimCheck's entire purpose is
 *    evaluating claims about named people. A detector that flags "Did Marie
 *    Curie win two Nobel Prizes?" would train students to dismiss the warning,
 *    which is worse than no warning at all.
 *
 * 2. It warns; it never blocks. Every pattern below still has a plausible
 *    legitimate hit — a claim about a published government contact address, a
 *    historical street address, a phone number quoted in a news report. The
 *    student is told what was spotted and decides. Blocking would silently
 *    break real fact-checking.
 *
 * Known false positives, accepted: phone-shaped statistics with separators
 * (e.g. "555-123-4567" as an example in a news article), addresses of public
 * buildings, "1600 Pennsylvania Avenue". Known false negatives, accepted:
 * anything unstructured — a student typing "my teacher is Ms. Alvarez and I
 * live near the water tower" is not detected and cannot reasonably be.
 *
 * Nothing in this module logs, stores, or returns the matched text — only the
 * category names, so a warning can be shown without the detector itself
 * becoming a place student data lands.
 */

const PATTERNS = [
  {
    type: 'email',
    // Deliberately ordinary: a local part, @, a dotted domain.
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'phone',
    // Requires separators or parentheses. A bare run of ten digits is far more
    // likely to be a statistic, a year range, or an ID in a historical claim
    // than a phone number, so it is intentionally not matched.
    //
    // Opens with a negative lookbehind rather than \b: a number written as
    // "(555) 123-4567" starts with a paren, and there is no word boundary
    // between a preceding space and "(", so \b would skip that whole form.
    regex: /(?<!\w)(?:\+?1[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
  },
  {
    type: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: 'address',
    // A house number followed by a street name and a street-type word.
    regex: /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|circle|cir|place|pl|terrace|ter|parkway|pkwy|highway|hwy|way)\b\.?/gi,
  },
  {
    type: 'studentId',
    // Anchored to an explicit label. An unanchored "any 6+ digit number" rule
    // would fire on dates, populations, dollar figures, and case numbers —
    // exactly the content ClaimCheck exists to check.
    regex: /\b(?:student|pupil)\s*(?:id|identification|number|no\.?|#)\s*[:#-]?\s*[A-Za-z]?\d{4,}\b/gi,
  },
];

/**
 * Scans text for structured personal identifiers.
 *
 * Returns the categories found and how many matches there were in total —
 * never the matched substrings themselves.
 */
function detectPii(text) {
  const input = typeof text === 'string' ? text : '';
  const types = [];
  let count = 0;

  for (const { type, regex } of PATTERNS) {
    // Fresh lastIndex each call: these are module-level /g regexes and would
    // otherwise resume mid-string on the next call and miss matches.
    regex.lastIndex = 0;
    const matches = input.match(regex);
    if (matches && matches.length) {
      types.push(type);
      count += matches.length;
    }
  }

  return { found: types.length > 0, types, count };
}

module.exports = { detectPii, PATTERNS };
