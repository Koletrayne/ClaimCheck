'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ExternalHyperlink,
} = require('docx');

const DISCLAIMER =
  'ClaimCheck is an educational tool designed to support critical thinking and media ' +
  'literacy. Results should be reviewed alongside the cited sources and are not a ' +
  'substitute for independent judgment.';

const VERDICT_LABELS = {
  supported: 'Supported',
  contradicted: 'Contradicted',
  unclear: 'Unclear',
};

/* ── Normalization ─────────────────────────────────────────
   Adapt the existing /analyze result JSON into a flat report structure that both
   the PDF and Word builders consume. We do not change the analysis pipeline. */

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function list(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => str(x)).filter(Boolean);
}

function tierLabel(tier) {
  const t = str(tier).toLowerCase();
  return { high: 'High', medium: 'Medium', low: 'Low' }[t] || 'Unrated';
}

function mapEvidence(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(it => ({
      summary: str(it.summary),
      sourceName: str(it.source_name),
      sourceUrl: str(it.source_url),
      credibility: tierLabel(it.credibility_tier),
      credibilityNote: str(it.credibility_note),
    }))
    .filter(e => e.summary || e.sourceName);
}

function buildIdentityConcerns(lens) {
  if (!lens || typeof lens !== 'object') return '';
  const flagged = Boolean(lens.targets_identity) ||
    (Array.isArray(lens.patterns_observed) && lens.patterns_observed.length > 0);
  if (!flagged) {
    return str(lens.analysis) || 'No identity-based targeting was detected in this claim.';
  }
  const parts = [];
  if (str(lens.analysis)) parts.push(str(lens.analysis));
  const groups = list(lens.identity_groups);
  if (groups.length) parts.push('Groups referenced: ' + groups.join(', ') + '.');
  const patterns = (Array.isArray(lens.patterns_observed) ? lens.patterns_observed : [])
    .map(p => {
      const name = str(p && p.pattern);
      const exp = str(p && p.explanation);
      if (!name) return '';
      return exp ? `${name} — ${exp}` : name;
    })
    .filter(Boolean);
  if (patterns.length) parts.push('Patterns observed: ' + patterns.join('; ') + '.');
  if (str(lens.caution_note)) parts.push(str(lens.caution_note));
  return parts.join(' ');
}

/**
 * @param {object} raw  The /analyze (or /analyze-url) result JSON.
 * @param {object} meta { inputType, originalInput, articleTitle, sourceUrl }
 */
function normalizeResult(raw = {}, meta = {}) {
  const article = raw._article || {};
  const context = raw.contextLens || raw.context_lens || {};
  const verdictKey = str(raw.verdict).toLowerCase();

  return {
    title: 'ClaimCheck Report',
    generatedAt: new Date(),
    inputType: meta.inputType === 'url' ? 'url' : 'claim',
    originalInput: str(meta.originalInput),
    articleTitle: str(meta.articleTitle) || str(article.title),
    sourceUrl: str(meta.sourceUrl) || str(article.url),
    mainClaim: str(raw.claim_text) || str(meta.originalInput),
    secondaryClaims: list(raw.secondary_claims),
    verdict: VERDICT_LABELS[verdictKey] || 'Unclear',
    verdictExplanation: str(raw.verdict_explanation),
    uncertaintyNotes: str(raw.uncertainty_notes),
    supporting: mapEvidence(raw.supporting_evidence),
    contradicting: mapEvidence(raw.contradicting_evidence),
    contextBackground: str(context.backgroundSnapshot),
    keyContext: list(context.keyContext),
    whyContextMatters: str(context.whyContextMatters),
    missingInfo: list(context.missingInformation),
    contextWarning: str(context.contextWarning),
    identityConcerns: buildIdentityConcerns(raw.identity_lens),
    reflectionQuestions: list(raw.reflection_questions),
    disclaimer: DISCLAIMER,
    meta: raw._meta || null,
  };
}

/* ── Filename ─────────────────────────────────────────── */

function safeFilename(report, ext) {
  let stub;
  if (report.inputType === 'url') {
    stub = report.articleTitle || hostnameOf(report.sourceUrl) || 'article';
  } else {
    stub = report.mainClaim || report.originalInput || 'claim';
  }
  const slug = stub
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('_')
    .slice(0, 60) || 'report';
  const date = report.generatedAt.toISOString().slice(0, 10);
  return `ClaimCheck_Report_${slug}_${date}.${ext}`;
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function formatTimestamp(d) {
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/* ── PDF builder (pdf-lib) ─────────────────────────────── */

async function buildPdf(report) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 612, PAGE_H = 792, MARGIN = 54;
  const MAX_W = PAGE_W - MARGIN * 2;
  const INK = rgb(0.12, 0.12, 0.14);
  const MUTED = rgb(0.4, 0.4, 0.44);
  const ACCENT = rgb(0.13, 0.42, 0.62);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function ensureSpace(needed) {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  }

  function wrap(text, f, size, maxW) {
    const lines = [];
    for (const rawLine of String(text).split('\n')) {
      const words = rawLine.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (f.widthOfTextAtSize(test, size) > maxW && line) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  function text(content, { size = 10.5, f = font, color = INK, gap = 3, indent = 0 } = {}) {
    if (!content) return;
    const maxW = MAX_W - indent;
    const lineHeight = size * 1.35;
    for (const line of wrap(content, f, size, maxW)) {
      ensureSpace(lineHeight);
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font: f, color });
      y -= lineHeight;
    }
    y -= gap;
  }

  function heading(label) {
    ensureSpace(26);
    y -= 6;
    page.drawText(label.toUpperCase(), { x: MARGIN, y: y - 11, size: 11, font: bold, color: ACCENT });
    y -= 16;
    page.drawLine({
      start: { x: MARGIN, y: y },
      end: { x: PAGE_W - MARGIN, y: y },
      thickness: 0.75,
      color: rgb(0.85, 0.87, 0.9),
    });
    y -= 8;
  }

  function bullets(items, { f = font, size = 10.5 } = {}) {
    for (const item of items) {
      const lineHeight = size * 1.35;
      const lines = wrap(item, f, size, MAX_W - 14);
      lines.forEach((line, i) => {
        ensureSpace(lineHeight);
        if (i === 0) {
          page.drawText('•', { x: MARGIN, y: y - size, size, font: f, color: ACCENT });
        }
        page.drawText(line, { x: MARGIN + 14, y: y - size, size, font: f, color: INK });
        y -= lineHeight;
      });
      y -= 2;
    }
  }

  // Title block
  text('ClaimCheck Report', { size: 20, f: bold, gap: 2 });
  text('Generated ' + formatTimestamp(report.generatedAt), { size: 9.5, color: MUTED, gap: 6 });

  // Source
  heading(report.inputType === 'url' ? 'Article Analyzed' : 'Claim Analyzed');
  if (report.inputType === 'url') {
    if (report.articleTitle) text(report.articleTitle, { size: 12, f: bold, gap: 2 });
    if (report.sourceUrl) text('Source: ' + report.sourceUrl, { size: 9.5, color: ACCENT });
  } else {
    text(report.originalInput || report.mainClaim);
  }

  // Main claim
  heading('Main Claim Evaluated');
  text(report.mainClaim || '—');
  if (report.secondaryClaims.length) {
    text('Secondary claims:', { size: 10, f: bold, gap: 2 });
    bullets(report.secondaryClaims);
  }

  // Verdict
  heading('Verdict');
  text(report.verdict, { size: 13, f: bold, color: ACCENT, gap: 3 });
  if (report.verdictExplanation) text(report.verdictExplanation);
  if (report.uncertaintyNotes) text('Uncertainty: ' + report.uncertaintyNotes, { color: MUTED });

  // Evidence
  if (report.supporting.length) {
    heading('Supporting Evidence');
    drawEvidence(report.supporting);
  }
  if (report.contradicting.length) {
    heading('Contradicting Evidence');
    drawEvidence(report.contradicting);
  }

  // Citations
  const citations = collectCitations(report);
  if (citations.length) {
    heading('Citations & Sources');
    bullets(citations);
  }

  // Context
  if (report.contextBackground || report.keyContext.length || report.whyContextMatters || report.missingInfo.length) {
    heading('Context & Background');
    if (report.contextBackground) text(report.contextBackground);
    if (report.keyContext.length) { text('Key context:', { size: 10, f: bold, gap: 2 }); bullets(report.keyContext); }
    if (report.whyContextMatters) { text('Why this context matters:', { size: 10, f: bold, gap: 2 }); text(report.whyContextMatters); }
    if (report.missingInfo.length) { text('Missing or needed information:', { size: 10, f: bold, gap: 2 }); bullets(report.missingInfo); }
  }

  // Identity / misinformation concerns
  if (report.contextWarning || report.identityConcerns) {
    heading('Identity & Misinformation Concerns');
    if (report.contextWarning) text('⚠ ' + report.contextWarning, { color: rgb(0.6, 0.3, 0.05) });
    if (report.identityConcerns) text(report.identityConcerns);
  }

  // Reflection questions
  if (report.reflectionQuestions.length) {
    heading('Questions to Consider');
    bullets(report.reflectionQuestions);
  }

  // Disclaimer
  heading('Limitations & Disclaimer');
  text(report.disclaimer, { size: 9.5, color: MUTED });

  function drawEvidence(items) {
    for (const e of items) {
      if (e.summary) text(e.summary, { gap: 1 });
      const sourceParts = [];
      if (e.sourceName) sourceParts.push(e.sourceName);
      sourceParts.push('Credibility: ' + e.credibility);
      text(sourceParts.join('  ·  '), { size: 9, color: MUTED, gap: 1 });
      if (e.sourceUrl) text(e.sourceUrl, { size: 8.5, color: ACCENT, gap: 1 });
      if (e.credibilityNote) text(e.credibilityNote, { size: 9, color: MUTED });
      y -= 4;
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function collectCitations(report) {
  const seen = new Set();
  const out = [];
  for (const e of [...report.supporting, ...report.contradicting]) {
    if (!e.sourceName && !e.sourceUrl) continue;
    const key = (e.sourceName + '|' + e.sourceUrl).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = e.sourceName || e.sourceUrl;
    const tier = e.credibility ? ` (${e.credibility} credibility)` : '';
    out.push(e.sourceUrl ? `${label}${tier} — ${e.sourceUrl}` : `${label}${tier}`);
  }
  return out;
}

/* ── Word builder (docx) ───────────────────────────────── */

async function buildDocx(report) {
  const children = [];

  const h = (text, level = HeadingLevel.HEADING_2) =>
    new Paragraph({ text, heading: level, spacing: { before: 220, after: 80 } });
  const p = (text, opts = {}) =>
    new Paragraph({ children: [new TextRun({ text, ...opts })], spacing: { after: 100 } });
  const bullet = text => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });

  children.push(new Paragraph({
    text: 'ClaimCheck Report',
    heading: HeadingLevel.TITLE,
    spacing: { after: 60 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Generated ' + formatTimestamp(report.generatedAt), italics: true, color: '666666', size: 19 })],
    spacing: { after: 160 },
  }));

  // Source
  children.push(h(report.inputType === 'url' ? 'Article Analyzed' : 'Claim Analyzed'));
  if (report.inputType === 'url') {
    if (report.articleTitle) children.push(p(report.articleTitle, { bold: true }));
    if (report.sourceUrl) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: 'Source: ' }),
          new ExternalHyperlink({ children: [new TextRun({ text: report.sourceUrl, style: 'Hyperlink' })], link: report.sourceUrl }),
        ],
        spacing: { after: 100 },
      }));
    }
  } else {
    children.push(p(report.originalInput || report.mainClaim));
  }

  // Main claim
  children.push(h('Main Claim Evaluated'));
  children.push(p(report.mainClaim || '—'));
  if (report.secondaryClaims.length) {
    children.push(p('Secondary claims:', { bold: true }));
    report.secondaryClaims.forEach(c => children.push(bullet(c)));
  }

  // Verdict
  children.push(h('Verdict'));
  children.push(p(report.verdict, { bold: true, size: 26 }));
  if (report.verdictExplanation) children.push(p(report.verdictExplanation));
  if (report.uncertaintyNotes) children.push(p('Uncertainty: ' + report.uncertaintyNotes, { italics: true, color: '666666' }));

  // Evidence
  const evidenceBlock = (label, items) => {
    if (!items.length) return;
    children.push(h(label));
    for (const e of items) {
      if (e.summary) children.push(p(e.summary));
      const meta = [];
      if (e.sourceName) meta.push(e.sourceName);
      meta.push('Credibility: ' + e.credibility);
      children.push(new Paragraph({
        children: [new TextRun({ text: meta.join('  ·  '), size: 18, color: '666666' })],
        spacing: { after: 30 },
      }));
      if (e.sourceUrl) {
        children.push(new Paragraph({
          children: [new ExternalHyperlink({ children: [new TextRun({ text: e.sourceUrl, style: 'Hyperlink', size: 18 })], link: e.sourceUrl })],
          spacing: { after: 30 },
        }));
      }
      if (e.credibilityNote) children.push(new Paragraph({
        children: [new TextRun({ text: e.credibilityNote, size: 18, italics: true, color: '666666' })],
        spacing: { after: 100 },
      }));
    }
  };
  evidenceBlock('Supporting Evidence', report.supporting);
  evidenceBlock('Contradicting Evidence', report.contradicting);

  // Citations
  const citations = collectCitations(report);
  if (citations.length) {
    children.push(h('Citations & Sources'));
    citations.forEach(c => children.push(bullet(c)));
  }

  // Context
  if (report.contextBackground || report.keyContext.length || report.whyContextMatters || report.missingInfo.length) {
    children.push(h('Context & Background'));
    if (report.contextBackground) children.push(p(report.contextBackground));
    if (report.keyContext.length) { children.push(p('Key context:', { bold: true })); report.keyContext.forEach(c => children.push(bullet(c))); }
    if (report.whyContextMatters) { children.push(p('Why this context matters:', { bold: true })); children.push(p(report.whyContextMatters)); }
    if (report.missingInfo.length) { children.push(p('Missing or needed information:', { bold: true })); report.missingInfo.forEach(c => children.push(bullet(c))); }
  }

  // Identity / misinformation
  if (report.contextWarning || report.identityConcerns) {
    children.push(h('Identity & Misinformation Concerns'));
    if (report.contextWarning) children.push(p('⚠ ' + report.contextWarning, { color: '9A4D00' }));
    if (report.identityConcerns) children.push(p(report.identityConcerns));
  }

  // Reflection
  if (report.reflectionQuestions.length) {
    children.push(h('Questions to Consider'));
    report.reflectionQuestions.forEach(q => children.push(bullet(q)));
  }

  // Disclaimer
  children.push(h('Limitations & Disclaimer'));
  children.push(p(report.disclaimer, { italics: true, color: '666666', size: 18 }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { normalizeResult, buildPdf, buildDocx, safeFilename };
