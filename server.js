require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { analyzeClaim } = require('./lib/analyze');

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));
app.use(express.json({ limit: '256kb' }));

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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ClaimCheck backend listening on http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('WARNING: ANTHROPIC_API_KEY not set — /analyze will 500 until it is.');
    }
  });
}

module.exports = app;