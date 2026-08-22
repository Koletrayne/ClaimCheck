require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { analyzeClaim, normalizeLanguage } = require('./lib/analyze');
const { extractArticle, ExtractError } = require('./lib/extract-article');
const { normalizeResult, buildPdf, buildDocx, safeFilename } = require('./lib/export-report');
const { router: classroomRouter } = require('./lib/classroom-routes');
const { isConfigured: classroomConfigured } = require('./lib/supabase-admin');
const limits = require('./lib/limits');
const usage = require('./lib/usage-guard');

const app = express();
const PORT = process.env.PORT || 3001;

// Lightweight in-memory per-IP rate limiter for the URL analysis route, which is
// the only endpoint that makes outbound fetches on a user's behalf. Best-effort
// only: serverless instances are stateless, so this protects a single warm
// instance rather than the whole fleet.
const URL_RATE_LIMIT = 10;            // requests
const URL_RATE_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes
const urlHits = new Map();            // ip -> number[] (timestamps)

function urlRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (urlHits.get(ip) || []).filter(t => now - t < URL_RATE_WINDOW_MS);
  if (recent.length >= URL_RATE_LIMIT) {
    return res.status(429).json({
      error: 'You have analyzed several URLs recently. Please wait a few minutes and try again.',
    });
  }
  recent.push(now);
  urlHits.set(ip, recent);
  next();
}

// HTTP status for each extraction error code.
const EXTRACT_STATUS = {
  INVALID_URL: 400,
  BLOCKED_URL: 400,
  NO_CONTENT: 422,
  UNREADABLE: 422,
  NETWORK_ERROR: 502,
};

// Hard upper bound on claim-box input, independent of the configurable quota.
// Matches the cap that has always applied to this route.
const ABSOLUTE_CLAIM_CEILING = 8000;

const UNREADABLE_FALLBACK =
  'We could not automatically read this page. Try copying and pasting the article text or claim directly into ClaimCheck.';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
    classroomMode: classroomConfigured(),
    usageEnforcement: usage.enforcementAvailable(),
  });
});

/**
 * The limits the browser needs in order to validate before submitting.
 *
 * Deliberately narrow: it publishes the input cap so the character counter and
 * the server agree on one number, and nothing else. Per-student, per-classroom,
 * and account budgets are NOT here — those are decided server-side per request,
 * and a student has no business learning the account's daily ceiling. There is
 * no API-credit figure, no provider name, and no billing detail anywhere in
 * this response.
 */
app.get('/api/limits', (req, res) => {
  res.json({ maxClaimCharacters: limits.maxClaimCharacters() });
});

/**
 * Rejects a claim that is longer than the configured cap.
 *
 * Enforced here as well as in the browser because the browser's copy is only a
 * convenience — a request built by hand skips it entirely, and the long input
 * it would carry is exactly the expensive kind this cap exists to refuse. The
 * check runs before any provider request and before a usage reservation, so an
 * over-long claim costs the caller no allowance.
 *
 * Returns null when the claim is acceptable, or a ready-to-send error body.
 */
function claimLengthError(text) {
  const configured = limits.maxClaimCharacters();
  // Setting the limit to 0 turns the quota off, but not the sanity ceiling: the
  // pipeline was never built to be handed a whole document through the claim
  // box, and that ceiling predates this feature.
  const max = configured > 0 ? configured : ABSOLUTE_CLAIM_CEILING;

  if (text.length <= max) return null;

  return {
    error: `Claims can be up to ${max.toLocaleString()} characters. ` +
           'Try narrowing this down to the specific statement you want to verify.',
    code: 'CLAIM_TOO_LONG',
    maxClaimCharacters: max,
    claimCharacters: text.length,
  };
}

// Shown when the whole account has hit its daily or monthly ceiling. Says
// nothing about which budget, what it is set to, how much is left, who spends
// it, or which provider is involved — none of that is a student's business, and
// some of it is commercially sensitive.
const GLOBAL_LIMIT_MESSAGE =
  'ClaimCheck is temporarily unavailable because the usage limit has been reached. ' +
  'Please try again later or contact your instructor.';

// Shown when quota state could not be established at all. Deliberately distinct
// from the message above: nothing is known to be exhausted, the condition is
// expected to clear on its own, and "try again shortly" is the right advice.
// Like the other one it names no database, no provider, and no internal detail.
const USAGE_UNVERIFIED_MESSAGE =
  'ClaimCheck is temporarily unable to verify usage limits. Please try again shortly.';

/** The user-facing message for a refused reservation on the public routes. */
function reservationMessage(reservation) {
  return reservation.reason === 'USAGE_UNVERIFIED'
    ? USAGE_UNVERIFIED_MESSAGE
    : GLOBAL_LIMIT_MESSAGE;
}

// ── Classroom Mode ───────────────────────────────────────────────────────
// Entirely additive: the public ClaimCheck experience above and below this
// block is untouched, and these routes report 503 until Classroom Mode is
// configured. The classroom pages themselves are static files under
// public/classroom/ and are served by express.static; the only page route
// needed here is the /classroom/CODE join shortcut, which has no file to match.
app.use('/api/classroom', classroomRouter);

// Extensionless page paths. express.static serves public/classroom/index.html
// for /classroom itself, but not these, so they are mapped explicitly.
const CLASSROOM_PAGES = { join: 'join.html', admin: 'admin.html', room: 'room.html' };

app.get('/classroom/:segment', (req, res, next) => {
  const { segment } = req.params;

  const page = CLASSROOM_PAGES[segment];
  if (page) return res.sendFile(path.join(__dirname, 'public', 'classroom', page));

  // Otherwise treat the segment as an access code if it is shaped like one, and
  // let the join page read it back out of the URL. Anything else falls through
  // to the normal 404 path.
  if (/^[A-Za-z0-9]{8}$|^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(segment)) {
    return res.sendFile(path.join(__dirname, 'public', 'classroom', 'join.html'));
  }
  next();
});

app.post('/analyze', async (req, res) => {
  const { text, sourceUrl, academicMode, snapshot, contextLens, language } = req.body || {};

  if (typeof text !== 'string' || text.trim().length < 8) {
    return res.status(400).json({
      error: 'Provide at least 8 characters of text to analyze.',
    });
  }

  const tooLong = claimLengthError(text);
  if (tooLong) return res.status(413).json(tooLong);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Set it in the backend .env file.',
    });
  }

  // Account-level budget. The public site has no classroom and no student, so
  // only the global day/month layers apply — but they apply here too, because
  // an unbounded public endpoint is the easiest way to run up a bill.
  const reservation = await usage.reserveClaim({});
  if (!reservation.allowed) {
    return res.status(reservation.status).json({
      error: reservationMessage(reservation),
      code: reservation.reason,
    });
  }

  try {
    const result = await analyzeClaim({ text, sourceUrl, academicMode: Boolean(academicMode), snapshot: Boolean(snapshot), includeContextLens: contextLens !== false, language: normalizeLanguage(language) });
    res.json(result);
  } catch (err) {
    // Hand the reservation back when the attempt cost nothing, so a bad API key
    // or a refused connection does not quietly eat the day's budget.
    if (!usage.wasBillable(err)) await usage.releaseClaim(reservation, {});
    console.error('[analyze] failed:', err);
    res.status(502).json({
      error: err.message || 'Claim analysis failed.',
    });
  }
});

app.post('/analyze-url', urlRateLimiter, async (req, res) => {
  const { url, academicMode, snapshot, contextLens, language } = req.body || {};

  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Provide a URL to analyze.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Set it in the backend .env file.',
    });
  }

  let article;
  try {
    article = await extractArticle(url.trim());
  } catch (err) {
    if (err instanceof ExtractError) {
      const status = EXTRACT_STATUS[err.code] || 502;
      // For pages we reached but couldn't read, return the friendly guidance copy.
      const message = (err.code === 'NO_CONTENT' || err.code === 'UNREADABLE')
        ? UNREADABLE_FALLBACK
        : err.message;
      return res.status(status).json({ error: message, code: err.code });
    }
    console.error('[analyze-url] extraction failed:', err);
    return res.status(502).json({ error: 'We could not read that page. Please try again.' });
  }

  // Reserved only now that the page has been read successfully. Extraction is
  // free — it costs a fetch, not a provider call — so a page that could not be
  // reached or parsed must not spend any of the budget. The character cap does
  // not apply on this route: article text is extracted, not typed, and
  // narrowing it is what the tool is for.
  const reservation = await usage.reserveClaim({});
  if (!reservation.allowed) {
    return res.status(reservation.status).json({
      error: reservationMessage(reservation),
      code: reservation.reason,
    });
  }

  try {
    const result = await analyzeClaim({
      text: article.text,
      sourceUrl: article.url,
      academicMode: Boolean(academicMode),
      includeSecondaryClaims: true,
      snapshot: Boolean(snapshot),
      includeContextLens: contextLens !== false,
      language: normalizeLanguage(language),
    });
    result._article = {
      title: article.title,
      byline: article.byline,
      url: article.url,
      excerpt: article.excerpt,
    };
    res.json(result);
  } catch (err) {
    if (!usage.wasBillable(err)) await usage.releaseClaim(reservation, {});
    console.error('[analyze-url] analysis failed:', err);
    res.status(502).json({ error: err.message || 'Claim analysis failed.' });
  }
});

app.post('/export', async (req, res) => {
  const { format, result, meta } = req.body || {};

  if (format !== 'pdf' && format !== 'docx') {
    return res.status(400).json({ error: 'Unsupported export format.' });
  }
  if (!result || typeof result !== 'object') {
    return res.status(400).json({ error: 'No analysis result to export.' });
  }

  try {
    const report = normalizeResult(result, meta || {});
    const ext = format === 'pdf' ? 'pdf' : 'docx';
    const filename = safeFilename(report, ext);
    const buffer = format === 'pdf' ? await buildPdf(report) : await buildDocx(report);

    res.setHeader(
      'Content-Type',
      format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[export] failed:', err);
    res.status(500).json({ error: 'Could not generate the export file. Please try again.' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ClaimCheck backend listening on http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('WARNING: ANTHROPIC_API_KEY not set — /analyze will 500 until it is.');
    }
  });
}

module.exports = app;