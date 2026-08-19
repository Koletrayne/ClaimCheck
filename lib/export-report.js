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

// All report chrome, per language. Exported reports use the language the analysis
// was generated in; the AI-authored content is already in that language. Source
// names and URLs are never translated. Adding a language = one entry here.
const REPORT_LABELS = {
  en: {
    locale: 'en-US',
    reportTitle: 'ClaimCheck Report',
    generatedPrefix: 'Generated ',
    articleAnalyzed: 'Article Analyzed',
    claimAnalyzed: 'Claim Analyzed',
    mainClaim: 'Main Claim Evaluated',
    secondaryClaims: 'Secondary claims:',
    verdict: 'Verdict',
    confidencePrefix: 'Confidence: ',
    uncertaintyPrefix: 'Uncertainty: ',
    supporting: 'Supporting Evidence',
    contradicting: 'Contradicting Evidence',
    citations: 'Citations & Sources',
    contextHeading: 'Context & Background',
    keyContext: 'Key context:',
    whyMatters: 'Why this context matters:',
    missingInfo: 'Missing or needed information:',
    identityHeading: 'Identity & Misinformation Concerns',
    warningPrefix: 'Warning: ',
    questions: 'Questions to Consider',
    disclaimerHeading: 'Limitations & Disclaimer',
    sourcePrefix: 'Source: ',
    credibilityPrefix: 'Credibility: ',
    credibilityWord: 'credibility',
    tiers: { high: 'High', medium: 'Medium', low: 'Low', unrated: 'Unrated' },
    verdicts: { supported: 'Supported', contradicted: 'Contradicted', unclear: 'Unclear' },
    confidences: { high: 'High', medium: 'Medium', low: 'Low' },
    noTargeting: 'No identity-based targeting was detected in this claim.',
    groupsReferenced: 'Groups referenced: ',
    patternsObserved: 'Patterns observed: ',
    disclaimer:
      'ClaimCheck is an educational tool designed to support critical thinking and media ' +
      'literacy. Results should be reviewed alongside the cited sources and are not a ' +
      'substitute for independent judgment.',
  },
  es: {
    locale: 'es',
    reportTitle: 'Informe de ClaimCheck',
    generatedPrefix: 'Generado el ',
    articleAnalyzed: 'Artículo analizado',
    claimAnalyzed: 'Afirmación analizada',
    mainClaim: 'Afirmación principal evaluada',
    secondaryClaims: 'Afirmaciones secundarias:',
    verdict: 'Veredicto',
    confidencePrefix: 'Confianza: ',
    uncertaintyPrefix: 'Incertidumbre: ',
    supporting: 'Evidencia a favor',
    contradicting: 'Evidencia en contra',
    citations: 'Citas y fuentes',
    contextHeading: 'Contexto y antecedentes',
    keyContext: 'Contexto clave:',
    whyMatters: 'Por qué importa este contexto:',
    missingInfo: 'Información faltante o necesaria:',
    identityHeading: 'Preocupaciones sobre identidad y desinformación',
    warningPrefix: 'Advertencia: ',
    questions: 'Preguntas para reflexionar',
    disclaimerHeading: 'Limitaciones y aviso',
    sourcePrefix: 'Fuente: ',
    credibilityPrefix: 'Credibilidad: ',
    credibilityWord: 'credibilidad',
    tiers: { high: 'Alta', medium: 'Media', low: 'Baja', unrated: 'Sin calificar' },
    verdicts: { supported: 'Respaldada', contradicted: 'Cuestionada', unclear: 'No está claro' },
    confidences: { high: 'Alta', medium: 'Media', low: 'Baja' },
    noTargeting: 'No se detectó ningún ataque basado en la identidad en esta afirmación.',
    groupsReferenced: 'Grupos mencionados: ',
    patternsObserved: 'Patrones observados: ',
    disclaimer:
      'ClaimCheck es una herramienta educativa diseñada para apoyar el pensamiento crítico y ' +
      'la alfabetización mediática. Los resultados deben revisarse junto con las fuentes citadas ' +
      'y no sustituyen el juicio independiente.',
  },
};

function pickLabels(language) {
  return REPORT_LABELS[language] || REPORT_LABELS.en;
}

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

function tierLabel(tier, L) {
  const t = str(tier).toLowerCase();
  return L.tiers[t] || L.tiers.unrated;
}

function confidenceLabel(c, L) {
  const v = str(c).toLowerCase();
  return L.confidences[v] || '';
}

// pdf-lib's StandardFonts use WinAnsi encoding, which can't represent the
// typographic characters the model routinely emits (em dashes, curly quotes,
// ellipses, arrows, the warning glyph). Map the common ones to ASCII and strip
// anything else outside the Latin-1 range so PDF generation never throws.
function pdfSafe(s) {
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•●]/g, '-')
    .replace(/→/g, '->')
    .replace(/[⚠️]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

function mapEvidence(items, L) {
  if (!Array.isArray(items)) return [];
  return items
    .map(it => ({
      summary: str(it.summary),
      sourceName: str(it.source_name),
      sourceUrl: str(it.source_url),
      credibility: tierLabel(it.credibility_tier, L),
      credibilityNote: str(it.credibility_note),
    }))
    .filter(e => e.summary || e.sourceName);
}

function buildIdentityConcerns(lens, L) {
  if (!lens || typeof lens !== 'object') return '';
  const flagged = Boolean(lens.targets_identity) ||
    (Array.isArray(lens.patterns_observed) && lens.patterns_observed.length > 0);
  if (!flagged) {
    return str(lens.analysis) || L.noTargeting;
  }
  const parts = [];
  if (str(lens.analysis)) parts.push(str(lens.analysis));
  const groups = list(lens.identity_groups);
  if (groups.length) parts.push(L.groupsReferenced + groups.join(', ') + '.');
  const patterns = (Array.isArray(lens.patterns_observed) ? lens.patterns_observed : [])
    .map(p => {
      const name = str(p && p.pattern);
      const exp = str(p && p.explanation);
      if (!name) return '';
      return exp ? `${name} — ${exp}` : name;
    })
    .filter(Boolean);
  if (patterns.length) parts.push(L.patternsObserved + patterns.join('; ') + '.');
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

  // Prefer the language the caller passed; fall back to what the analysis
  // recorded; default to English. Only the two supported codes are honored.
  const rawLang = meta.language || (raw._meta && raw._meta.language);
  const language = REPORT_LABELS[rawLang] ? rawLang : 'en';
  const L = pickLabels(language);

  return {
    language,
    labels: L,
    title: L.reportTitle,
    generatedAt: new Date(),
    inputType: meta.inputType === 'url' ? 'url' : 'claim',
    originalInput: str(meta.originalInput),
    articleTitle: str(meta.articleTitle) || str(article.title),
    sourceUrl: str(meta.sourceUrl) || str(article.url),
    mainClaim: str(raw.claim_text) || str(meta.originalInput),
    secondaryClaims: list(raw.secondary_claims),
    verdict: L.verdicts[verdictKey] || L.verdicts.unclear,
    confidence: confidenceLabel(raw.confidence, L),
    verdictExplanation: str(raw.verdict_explanation),
    uncertaintyNotes: str(raw.uncertainty_notes),
    supporting: mapEvidence(raw.supporting_evidence, L),
    contradicting: mapEvidence(raw.contradicting_evidence, L),
    contextBackground: str(context.backgroundSnapshot),
    keyContext: list(context.keyContext),
    whyContextMatters: str(context.whyContextMatters),
    missingInfo: list(context.missingInformation),
    contextWarning: str(context.contextWarning),
    identityConcerns: buildIdentityConcerns(raw.identity_lens, L),
    reflectionQuestions: list(raw.reflection_questions),
    disclaimer: L.disclaimer,
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

function formatTimestamp(d, locale) {
  return d.toLocaleString(locale || 'en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/* ── PDF builder (pdf-lib) ─────────────────────────────── */

async function buildPdf(report) {
  const L = report.labels || pickLabels(report.language);
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
    for (const rawLine of pdfSafe(text).split('\n')) {
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
  text(L.reportTitle, { size: 20, f: bold, gap: 2 });
  text(L.generatedPrefix + formatTimestamp(report.generatedAt, L.locale), { size: 9.5, color: MUTED, gap: 6 });

  // Source
  heading(report.inputType === 'url' ? L.articleAnalyzed : L.claimAnalyzed);
  if (report.inputType === 'url') {
    if (report.articleTitle) text(report.articleTitle, { size: 12, f: bold, gap: 2 });
    if (report.sourceUrl) text(L.sourcePrefix + report.sourceUrl, { size: 9.5, color: ACCENT });
  } else {
    text(report.originalInput || report.mainClaim);
  }

  // Main claim
  heading(L.mainClaim);
  text(report.mainClaim || '—');
  if (report.secondaryClaims.length) {
    text(L.secondaryClaims, { size: 10, f: bold, gap: 2 });
    bullets(report.secondaryClaims);
  }

  // Verdict
  heading(L.verdict);
  text(report.verdict, { size: 13, f: bold, color: ACCENT, gap: report.confidence ? 1 : 3 });
  if (report.confidence) text(L.confidencePrefix + report.confidence, { size: 9.5, color: MUTED });
  if (report.verdictExplanation) text(report.verdictExplanation);
  if (report.uncertaintyNotes) text(L.uncertaintyPrefix + report.uncertaintyNotes, { color: MUTED });

  // Evidence
  if (report.supporting.length) {
    heading(L.supporting);
    drawEvidence(report.supporting);
  }
  if (report.contradicting.length) {
    heading(L.contradicting);
    drawEvidence(report.contradicting);
  }

  // Citations
  const citations = collectCitations(report);
  if (citations.length) {
    heading(L.citations);
    bullets(citations);
  }

  // Context
  if (report.contextBackground || report.keyContext.length || report.whyContextMatters || report.missingInfo.length) {
    heading(L.contextHeading);
    if (report.contextBackground) text(report.contextBackground);
    if (report.keyContext.length) { text(L.keyContext, { size: 10, f: bold, gap: 2 }); bullets(report.keyContext); }
    if (report.whyContextMatters) { text(L.whyMatters, { size: 10, f: bold, gap: 2 }); text(report.whyContextMatters); }
    if (report.missingInfo.length) { text(L.missingInfo, { size: 10, f: bold, gap: 2 }); bullets(report.missingInfo); }
  }

  // Identity / misinformation concerns
  if (report.contextWarning || report.identityConcerns) {
    heading(L.identityHeading);
    if (report.contextWarning) text(L.warningPrefix + report.contextWarning, { color: rgb(0.6, 0.3, 0.05) });
    if (report.identityConcerns) text(report.identityConcerns);
  }

  // Reflection questions
  if (report.reflectionQuestions.length) {
    heading(L.questions);
    bullets(report.reflectionQuestions);
  }

  // Disclaimer
  heading(L.disclaimerHeading);
  text(report.disclaimer, { size: 9.5, color: MUTED });

  function drawEvidence(items) {
    for (const e of items) {
      if (e.summary) text(e.summary, { gap: 1 });
      const sourceParts = [];
      if (e.sourceName) sourceParts.push(e.sourceName);
      sourceParts.push(L.credibilityPrefix + e.credibility);
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
  const L = report.labels || pickLabels(report.language);
  const seen = new Set();
  const out = [];
  for (const e of [...report.supporting, ...report.contradicting]) {
    if (!e.sourceName && !e.sourceUrl) continue;
    const key = (e.sourceName + '|' + e.sourceUrl).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = e.sourceName || e.sourceUrl;
    const tier = e.credibility ? ` (${e.credibility} ${L.credibilityWord})` : '';
    out.push(e.sourceUrl ? `${label}${tier} — ${e.sourceUrl}` : `${label}${tier}`);
  }
  return out;
}

/* ── Word builder (docx) ───────────────────────────────── */

async function buildDocx(report) {
  const L = report.labels || pickLabels(report.language);
  const children = [];

  const h = (text, level = HeadingLevel.HEADING_2) =>
    new Paragraph({ text, heading: level, spacing: { before: 220, after: 80 } });
  const p = (text, opts = {}) =>
    new Paragraph({ children: [new TextRun({ text, ...opts })], spacing: { after: 100 } });
  const bullet = text => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });

  children.push(new Paragraph({
    text: L.reportTitle,
    heading: HeadingLevel.TITLE,
    spacing: { after: 60 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: L.generatedPrefix + formatTimestamp(report.generatedAt, L.locale), italics: true, color: '666666', size: 19 })],
    spacing: { after: 160 },
  }));

  // Source
  children.push(h(report.inputType === 'url' ? L.articleAnalyzed : L.claimAnalyzed));
  if (report.inputType === 'url') {
    if (report.articleTitle) children.push(p(report.articleTitle, { bold: true }));
    if (report.sourceUrl) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: L.sourcePrefix }),
          new ExternalHyperlink({ children: [new TextRun({ text: report.sourceUrl, style: 'Hyperlink' })], link: report.sourceUrl }),
        ],
        spacing: { after: 100 },
      }));
    }
  } else {
    children.push(p(report.originalInput || report.mainClaim));
  }

  // Main claim
  children.push(h(L.mainClaim));
  children.push(p(report.mainClaim || '—'));
  if (report.secondaryClaims.length) {
    children.push(p(L.secondaryClaims, { bold: true }));
    report.secondaryClaims.forEach(c => children.push(bullet(c)));
  }

  // Verdict
  children.push(h(L.verdict));
  children.push(p(report.verdict, { bold: true, size: 26 }));
  if (report.confidence) children.push(p(L.confidencePrefix + report.confidence, { italics: true, color: '666666' }));
  if (report.verdictExplanation) children.push(p(report.verdictExplanation));
  if (report.uncertaintyNotes) children.push(p(L.uncertaintyPrefix + report.uncertaintyNotes, { italics: true, color: '666666' }));

  // Evidence
  const evidenceBlock = (label, items) => {
    if (!items.length) return;
    children.push(h(label));
    for (const e of items) {
      if (e.summary) children.push(p(e.summary));
      const meta = [];
      if (e.sourceName) meta.push(e.sourceName);
      meta.push(L.credibilityPrefix + e.credibility);
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
  evidenceBlock(L.supporting, report.supporting);
  evidenceBlock(L.contradicting, report.contradicting);

  // Citations
  const citations = collectCitations(report);
  if (citations.length) {
    children.push(h(L.citations));
    citations.forEach(c => children.push(bullet(c)));
  }

  // Context
  if (report.contextBackground || report.keyContext.length || report.whyContextMatters || report.missingInfo.length) {
    children.push(h(L.contextHeading));
    if (report.contextBackground) children.push(p(report.contextBackground));
    if (report.keyContext.length) { children.push(p(L.keyContext, { bold: true })); report.keyContext.forEach(c => children.push(bullet(c))); }
    if (report.whyContextMatters) { children.push(p(L.whyMatters, { bold: true })); children.push(p(report.whyContextMatters)); }
    if (report.missingInfo.length) { children.push(p(L.missingInfo, { bold: true })); report.missingInfo.forEach(c => children.push(bullet(c))); }
  }

  // Identity / misinformation
  if (report.contextWarning || report.identityConcerns) {
    children.push(h(L.identityHeading));
    if (report.contextWarning) children.push(p(L.warningPrefix + report.contextWarning, { color: '9A4D00' }));
    if (report.identityConcerns) children.push(p(report.identityConcerns));
  }

  // Reflection
  if (report.reflectionQuestions.length) {
    children.push(h(L.questions));
    report.reflectionQuestions.forEach(q => children.push(bullet(q)));
  }

  // Disclaimer
  children.push(h(L.disclaimerHeading));
  children.push(p(report.disclaimer, { italics: true, color: '666666', size: 18 }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { normalizeResult, buildPdf, buildDocx, safeFilename };
