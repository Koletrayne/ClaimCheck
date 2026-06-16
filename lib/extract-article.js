'use strict';

const dns = require('dns').promises;
const ipaddr = require('ipaddr.js');
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');

// Tunables. Kept conservative so a single URL analysis stays well within the
// existing /analyze limits and can't be used to pull down huge payloads.
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;       // 2 MB cap on downloaded HTML
const MAX_REDIRECTS = 3;
const MIN_ARTICLE_CHARS = 250;            // below this we treat the page as unreadable
const MODEL_TEXT_BUDGET = 7000;           // keep under the 8,000-char /analyze limit
const OPENING_BUDGET = 5000;
const CLOSING_BUDGET = 1500;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ClaimCheck/0.3';

// IP range categories that must never be reached from a user-supplied URL.
const BLOCKED_RANGES = new Set([
  'unspecified',
  'broadcast',
  'loopback',
  'private',
  'linkLocal',
  'uniqueLocal',
  'reserved',
  'carrierGradeNat',
]);

/**
 * Error with a machine-readable `code` so the route can map to the right HTTP
 * status and a friendly message.
 */
class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtractError';
    this.code = code; // INVALID_URL | BLOCKED_URL | NETWORK_ERROR | UNREADABLE | NO_CONTENT
  }
}

function isBlockedIp(ip) {
  try {
    const addr = ipaddr.parse(ip);
    const range = addr.range();
    if (BLOCKED_RANGES.has(range)) return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — check the embedded v4 too.
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
      return BLOCKED_RANGES.has(addr.toIPv4Address().range());
    }
    return false;
  } catch {
    return true; // unparseable — fail closed
  }
}

/**
 * Parse + validate a single URL: must be http/https, must not be localhost, and
 * must not resolve to a private/loopback/link-local/reserved address (SSRF guard).
 * Returns a WHATWG URL on success.
 */
async function validateUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    throw new ExtractError('INVALID_URL', 'That does not look like a valid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ExtractError('INVALID_URL', 'Only http and https URLs are supported.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new ExtractError('BLOCKED_URL', 'This address cannot be analyzed for security reasons.');
  }

  // If the host is a literal IP, check it directly. Otherwise resolve via DNS
  // and check every returned address.
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) {
      throw new ExtractError('BLOCKED_URL', 'This address cannot be analyzed for security reasons.');
    }
  } else {
    let records;
    try {
      records = await dns.lookup(host, { all: true });
    } catch {
      throw new ExtractError('NETWORK_ERROR', 'We could not resolve that website address.');
    }
    if (!records.length || records.some(r => isBlockedIp(r.address))) {
      throw new ExtractError('BLOCKED_URL', 'This address cannot be analyzed for security reasons.');
    }
  }

  return parsed;
}

/**
 * Fetch with a timeout, manual redirect handling (each hop re-validated against
 * the SSRF guard), an HTML content-type requirement, and a hard size cap.
 * Returns { html, finalUrl }.
 */
async function safeFetchHtml(startUrl) {
  let current = await validateUrl(startUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new ExtractError('NETWORK_ERROR', 'The page took too long to respond.');
      }
      throw new ExtractError('NETWORK_ERROR', 'We could not reach that page.');
    }
    clearTimeout(timer);

    // Handle redirects ourselves so each destination is re-validated.
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === MAX_REDIRECTS) {
        throw new ExtractError('NETWORK_ERROR', 'That page redirected too many times.');
      }
      const next = new URL(res.headers.get('location'), current.href);
      current = await validateUrl(next.href);
      continue;
    }

    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new ExtractError('NO_CONTENT', 'This page requires a login or subscription to read.');
    }
    if (!res.ok) {
      throw new ExtractError('NETWORK_ERROR', `The page returned an error (${res.status}).`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new ExtractError('UNREADABLE', 'That link is not a readable web page.');
    }

    const html = await readCapped(res, MAX_BYTES);
    return { html, finalUrl: current.href };
  }

  throw new ExtractError('NETWORK_ERROR', 'That page redirected too many times.');
}

// Read a response body but stop once we exceed the byte cap.
async function readCapped(res, maxBytes) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    return text.slice(0, maxBytes);
  }
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out += decoder.decode(value, { stream: true });
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  out += decoder.decode();
  return out;
}

/**
 * Trim extracted article text to fit the model budget. Prioritizes the opening
 * (headline/lede/first paragraphs) and keeps the conclusion, dropping the middle.
 */
function trimForModel(title, textContent) {
  const body = (textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  const header = title ? `${title}\n\n` : '';

  if (header.length + body.length <= MODEL_TEXT_BUDGET) {
    return (header + body).trim();
  }

  const opening = body.slice(0, OPENING_BUDGET).trim();
  const closing = body.slice(-CLOSING_BUDGET).trim();
  return `${header}${opening}\n\n[…]\n\n${closing}`.trim();
}

/**
 * Fetch a URL and extract clean, readable article text.
 * @returns {Promise<{ title: string, byline: string, url: string, excerpt: string, text: string }>}
 */
async function extractArticle(rawUrl) {
  const { html, finalUrl } = await safeFetchHtml(rawUrl);

  let article;
  try {
    // linkedom is a lightweight, CommonJS DOM that works on serverless runtimes
    // (unlike jsdom, whose transitive deps break under Vercel's bytecode loader).
    const { document } = parseHTML(html);
    article = new Readability(document).parse();
  } catch {
    throw new ExtractError('UNREADABLE', 'We could not parse that page.');
  }

  if (!article || !article.textContent || article.textContent.trim().length < MIN_ARTICLE_CHARS) {
    throw new ExtractError(
      'NO_CONTENT',
      'We could not find readable article text on that page.'
    );
  }

  const title = (article.title || '').trim();
  return {
    title,
    byline: (article.byline || '').trim(),
    url: finalUrl,
    excerpt: (article.excerpt || '').trim(),
    text: trimForModel(title, article.textContent),
  };
}

module.exports = { extractArticle, validateUrl, ExtractError };
