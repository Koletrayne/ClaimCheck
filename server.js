require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { analyzeClaim } = require('./lib/analyze');
const { extractArticle, ExtractError } = require('./lib/extract-article');
const { normalizeResult, buildPdf, buildDocx, safeFilename } = require('./lib/export-report');

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
  });
});

app.post('/analyze', async (req, res) => {
  const { text, sourceUrl, academicMode } = req.body || {};

  if (typeof text !== 'string' || text.trim().length < 8) {
    return res.status(400).json({
      error: 'Provide at least 8 characters of text to analyze.',
    });
  }

  if (text.length > 8000) {
    return res.status(413).json({
      error: 'Selection too long. Trim to under 8,000 characters.',
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Set it in the backend .env file.',
    });
  }

  try {
    const result = await analyzeClaim({ text, sourceUrl, academicMode: Boolean(academicMode) });
    res.json(result);
  } catch (err) {
    console.error('[analyze] failed:', err);
    res.status(502).json({
      error: err.message || 'Claim analysis failed.',
    });
  }
});

app.post('/analyze-url', urlRateLimiter, async (req, res) => {
  const { url, academicMode } = req.body || {};

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

  try {
    const result = await analyzeClaim({
      text: article.text,
      sourceUrl: article.url,
      academicMode: Boolean(academicMode),
      includeSecondaryClaims: true,
    });
    result._article = {
      title: article.title,
      byline: article.byline,
      url: article.url,
      excerpt: article.excerpt,
    };
    res.json(result);
  } catch (err) {
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