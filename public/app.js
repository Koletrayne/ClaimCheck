'use strict';

const claimInput    = document.getElementById('claim-input');
const checkBtn      = document.getElementById('check-btn');
const fieldError    = document.getElementById('field-error');
const statusEl      = document.getElementById('status');
const apiError      = document.getElementById('api-error');
const apiErrorText  = document.getElementById('api-error-text');
const resultsEl     = document.getElementById('results');
const academicToggle = document.getElementById('academic-toggle');

checkBtn.addEventListener('click', checkClaim);

claimInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') checkClaim();
});

/* ── Main flow ─────────────────────────────────────── */

async function checkClaim() {
  const text = claimInput.value.trim();

  clearAll();

  if (!text) {
    showFieldError('Please enter a claim to check.');
    claimInput.focus();
    return;
  }
  if (text.length < 8) {
    showFieldError('Please enter at least a few words to analyze.');
    claimInput.focus();
    return;
  }

  setLoading(true);

  try {
    const res = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        academicMode: academicToggle.checked,
      }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`The server returned an unexpected response (${res.status}).`);
    }

    if (!res.ok) {
      const msg = data && data.error ? data.error : `Analysis failed (${res.status}).`;
      if (res.status === 500 && msg.includes('ANTHROPIC_API_KEY')) {
        console.error('[ClaimCheck] Missing API key:', msg);
        throw new Error('The analysis service is not configured. Set ANTHROPIC_API_KEY in the backend .env file.');
      }
      throw new Error(msg);
    }

    renderResults(data);
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    const msg = err.message || '';
    if (err.name === 'TypeError' || msg.toLowerCase().includes('failed to fetch')) {
      showApiError('Could not reach the ClaimCheck backend. Make sure it is running.');
    } else {
      showApiError(msg || 'Something went wrong while checking this claim. Please try again.');
    }
  } finally {
    setLoading(false);
  }
}

/* ── State helpers ─────────────────────────────────── */

function setLoading(on) {
  statusEl.hidden  = !on;
  checkBtn.disabled = on;
  checkBtn.textContent = on ? 'Checking…' : 'Check Claim';
}

function clearAll() {
  fieldError.hidden = true;
  fieldError.textContent = '';
  apiError.hidden = true;
  apiErrorText.textContent = '';
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
}

function showFieldError(msg) {
  fieldError.textContent = msg;
  fieldError.hidden = false;
}

function showApiError(msg) {
  apiErrorText.textContent = msg;
  apiError.hidden = false;
}

/* ── Result rendering ──────────────────────────────── */

function renderResults(data) {
  resultsEl.innerHTML = '';
  resultsEl.hidden = false;

  // 1. Extracted claim
  if (data.claim_text) {
    const sec = makeSection('Extracted Claim');
    const p = el('p', 'claim-text-display');
    p.textContent = data.claim_text;
    if (data._meta && data._meta.academic_mode) {
      const pill = el('span', 'academic-pill');
      pill.textContent = 'Academic';
      pill.title = 'Sourced from peer-reviewed, university, and government domains only.';
      p.appendChild(pill);
    }
    sec.appendChild(p);
    resultsEl.appendChild(sec);
  }

  // 2. Claim breakdown
  const bd = data.breakdown || {};
  if (bd.what || bd.who || bd.evidence_required) {
    const sec = makeSection('Claim Breakdown');
    const grid = el('div', 'breakdown-grid');
    if (bd.what)              grid.appendChild(makeBreakdownItem('What', bd.what));
    if (bd.who)               grid.appendChild(makeBreakdownItem('Who', bd.who));
    if (bd.evidence_required) grid.appendChild(makeBreakdownItem('Evidence needed', bd.evidence_required));
    sec.appendChild(grid);
    resultsEl.appendChild(sec);
  }

  // 3. Verdict
  const v = normalizeVerdict(data.verdict);
  const verdictSec = el('div', `section verdict-card verdict--${v}`);
  const badge = el('span', 'verdict-badge');
  badge.textContent = verdictLabel(v);
  verdictSec.appendChild(badge);
  const vtitle = el('p', 'verdict-summary-title');
  vtitle.textContent = verdictSummaryTitle(v);
  verdictSec.appendChild(vtitle);
  if (data.verdict_explanation) {
    const exp = el('p', 'verdict-explanation');
    exp.textContent = data.verdict_explanation;
    verdictSec.appendChild(exp);
  }
  if (data.uncertainty_notes && data.uncertainty_notes.trim()) {
    const unc = el('p', 'uncertainty-notes');
    unc.textContent = 'Uncertainty: ' + data.uncertainty_notes;
    verdictSec.appendChild(unc);
  }
  resultsEl.appendChild(verdictSec);

  // 4. Supporting evidence
  resultsEl.appendChild(makeEvidenceSection(
    'Supporting Evidence',
    Array.isArray(data.supporting_evidence) ? data.supporting_evidence : []
  ));

  // 5. Contradicting evidence
  resultsEl.appendChild(makeEvidenceSection(
    'Contradicting Evidence',
    Array.isArray(data.contradicting_evidence) ? data.contradicting_evidence : []
  ));

  // 6. Reflection questions
  const questions = Array.isArray(data.reflection_questions) ? data.reflection_questions : [];
  if (questions.length) {
    const sec = makeSection('Questions to Consider');
    const list = el('ul', 'reflection-list');
    for (const q of questions) {
      const li = document.createElement('li');
      li.textContent = q;
      list.appendChild(li);
    }
    sec.appendChild(list);
    resultsEl.appendChild(sec);
  }

  // 7. Identity lens
  if (data.identity_lens) {
    resultsEl.appendChild(makeIdentityLensSection(data.identity_lens));
  }

  // 8. Meta
  if (data._meta) {
    const parts = [];
    if (data._meta.model) parts.push('Model: ' + data._meta.model);
    if (data._meta.searches_used != null) {
      const n = data._meta.searches_used;
      parts.push(n + ' web search' + (n === 1 ? '' : 'es'));
    }
    if (data._meta.academic_mode) parts.push('Academic mode');
    if (parts.length) {
      const meta = el('p', 'meta-row');
      meta.textContent = parts.join(' · ');
      resultsEl.appendChild(meta);
    }
  }
}

/* ── Section builders ──────────────────────────────── */

function makeSection(title) {
  const div = el('div', 'section');
  if (title) {
    const h = el('p', 'section-title');
    h.textContent = title;
    div.appendChild(h);
  }
  return div;
}

function makeBreakdownItem(label, value) {
  const div = el('div', 'breakdown-item');
  const l = el('span', 'breakdown-label');
  l.textContent = label;
  const v = el('span', 'breakdown-value');
  v.textContent = value || '—';
  div.appendChild(l);
  div.appendChild(v);
  return div;
}

function makeEvidenceSection(title, items) {
  const sec = makeSection(title);
  if (!items.length) {
    const empty = el('p', 'empty-state');
    empty.textContent = 'None found.';
    sec.appendChild(empty);
    return sec;
  }
  const list = el('ul', 'evidence-list');
  for (const item of items) {
    list.appendChild(makeEvidenceItem(item));
  }
  sec.appendChild(list);
  return sec;
}

function makeEvidenceItem(item) {
  const li = el('li', 'evidence-item');

  const summary = el('p', 'evidence-summary');
  summary.textContent = item.summary || '';
  li.appendChild(summary);

  const row = el('div', 'evidence-source-row');
  row.appendChild(buildCredBadge(item.credibility_tier));

  if (item.source_url) {
    const a = el('a', 'evidence-source');
    a.href = item.source_url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = item.source_name || safeHostname(item.source_url);
    row.appendChild(a);
  } else if (item.source_name) {
    const span = el('span', 'evidence-source-name');
    span.textContent = item.source_name;
    row.appendChild(span);
  }
  li.appendChild(row);

  if (item.credibility_note) {
    const cn = el('p', 'credibility-note');
    cn.textContent = item.credibility_note;
    li.appendChild(cn);
  }

  return li;
}

function buildCredBadge(rawTier) {
  const tier = normalizeTier(rawTier);
  const labels = { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unrated' };
  const titles = {
    high:    'High credibility — peer-reviewed research, primary government/IGO data, or established academic institution.',
    medium:  'Medium credibility — established journalism with editorial standards, or nonpartisan fact-checker.',
    low:     'Low credibility — unclear editorial process, openly partisan outlet, opinion blog, or aggregator.',
    unknown: 'Credibility could not be determined from available signals.',
  };
  const span = el('span', `cred cred--${tier}`);
  span.title = titles[tier];
  span.setAttribute('aria-label', 'Source credibility: ' + labels[tier]);
  const dot = el('span', 'cred-dot');
  dot.setAttribute('aria-hidden', 'true');
  span.appendChild(dot);
  const label = document.createElement('span');
  label.textContent = labels[tier];
  span.appendChild(label);
  return span;
}

function makeIdentityLensSection(lens) {
  const groups   = Array.isArray(lens.identity_groups)   ? lens.identity_groups.filter(Boolean)   : [];
  const patterns = Array.isArray(lens.patterns_observed) ? lens.patterns_observed.filter(Boolean) : [];
  const flagged  = Boolean(lens.targets_identity) || patterns.length > 0;

  const sec = el('div', `section identity--${flagged ? 'flagged' : 'clean'}`);
  const titleEl = el('p', 'section-title');
  titleEl.textContent = 'Identity Lens';
  sec.appendChild(titleEl);

  const badge = el('span', 'identity-badge');
  badge.textContent = flagged ? 'Identity targeting detected' : 'No identity targeting detected';
  sec.appendChild(badge);

  if (lens.analysis) {
    const analysis = el('p', 'identity-analysis');
    analysis.textContent = lens.analysis;
    sec.appendChild(analysis);
  }

  if (groups.length) {
    const sub = el('div', 'identity-subgroup');
    const lbl = el('p', 'identity-sublabel');
    lbl.textContent = 'Groups referenced';
    sub.appendChild(lbl);
    const ul = el('ul', 'identity-tag-list');
    for (const g of groups) {
      const li = el('li', 'identity-tag');
      li.textContent = String(g);
      ul.appendChild(li);
    }
    sub.appendChild(ul);
    sec.appendChild(sub);
  }

  if (patterns.length) {
    const sub = el('div', 'identity-subgroup');
    const lbl = el('p', 'identity-sublabel');
    lbl.textContent = 'Patterns observed';
    sub.appendChild(lbl);
    const ul = el('ul', 'pattern-list');
    for (const p of patterns) {
      const li = el('li', 'pattern-item');
      const name = el('span', 'pattern-name');
      name.textContent = (p.pattern || 'Pattern');
      li.appendChild(name);
      if (p.explanation) {
        li.appendChild(document.createTextNode(' — '));
        const exp = el('span', 'pattern-explain');
        exp.textContent = p.explanation;
        li.appendChild(exp);
      }
      ul.appendChild(li);
    }
    sub.appendChild(ul);
    sec.appendChild(sub);
  }

  if (flagged && lens.caution_note && String(lens.caution_note).trim()) {
    const caution = el('p', 'identity-caution');
    caution.textContent = lens.caution_note;
    sec.appendChild(caution);
  }

  return sec;
}

/* ── Helpers ───────────────────────────────────────── */

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function normalizeVerdict(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'supported' || v === 'contradicted' || v === 'unclear') return v;
  return 'unclear';
}

function verdictLabel(v) {
  return { supported: 'Supported', contradicted: 'Contradicted', unclear: 'Unclear' }[v] || 'Unclear';
}

function verdictSummaryTitle(v) {
  return {
    supported:    'Evidence broadly aligns with the claim.',
    contradicted: 'Evidence broadly conflicts with the claim.',
    unclear:      'Evidence is mixed, limited, or inconclusive.',
  }[v] || 'Evidence is mixed or inconclusive.';
}

function normalizeTier(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'unknown';
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
