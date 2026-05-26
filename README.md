# ClaimCheck Backend

Node/Express service that powers the ClaimCheck Chrome extension. It accepts highlighted text from the extension, calls the Anthropic Claude API with the built-in web-search tool, and returns a structured evidence report.

The API key lives on the server — the extension never sees it.

## Setup

```bash
cd claimcheck-backend
npm install
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY
npm start
```

The server listens on `http://localhost:3000`.

## Endpoints

### `GET /health`
Returns `{ status, model, hasKey }`. Use this to confirm the backend is running and configured.

### `POST /analyze`
Body:
```json
{ "text": "<highlighted passage>", "sourceUrl": "<optional page URL>" }
```

Response: structured JSON with `claim_text`, `breakdown`, `supporting_evidence[]`, `contradicting_evidence[]`, `verdict`, `verdict_explanation`, `uncertainty_notes`, and `reflection_questions`. See `lib/analyze.js` for the full schema.

## Environment

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required. Server-side Anthropic key. |
| `ANTHROPIC_MODEL` | Defaults to `claude-sonnet-4-6`. |
| `PORT` | Defaults to `3000`. |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist. Leave blank to allow all. |
