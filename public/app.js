'use strict';

const claimInput    = document.getElementById('claim-input');
const urlInput      = document.getElementById('url-input');
const tabClaim      = document.getElementById('tab-claim');
const tabUrl        = document.getElementById('tab-url');
const claimPane     = document.getElementById('claim-pane');
const urlPane       = document.getElementById('url-pane');
const checkBtn      = document.getElementById('check-btn');
const fieldError    = document.getElementById('field-error');
const statusEl      = document.getElementById('status');
const apiError      = document.getElementById('api-error');
const apiErrorText  = document.getElementById('api-error-text');
const resultsEl     = document.getElementById('results');
const academicToggle = document.getElementById('academic-toggle');
const predictToggle  = document.getElementById('predict-toggle');
const predictPanel   = document.getElementById('predict-panel');
const sharedBanner   = document.getElementById('shared-banner');
const dismissShared  = document.getElementById('dismiss-shared');
const libraryToggle  = document.getElementById('library-toggle');
const libraryPanel   = document.getElementById('library-panel');
const themeToggle    = document.getElementById('theme-toggle');
const historyBtn     = document.getElementById('history-btn');
const historyModal   = document.getElementById('history-modal');
const historyClose   = document.getElementById('history-close');
const historyListEl  = document.getElementById('history-list');

(function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', (saved ? saved === 'dark' : prefersDark) ? 'dark' : 'light');
})();

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

/* ── Claim history ─────────────────────────────────── */

const HISTORY_KEY = 'claimcheck_history';
const HISTORY_MAX = 50;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

async function saveToHistory(entry) {
  // When signed in, persist to the user's Supabase account so history syncs
  // across the website and the browser extension. Fall back to localStorage
  // if the cloud save fails or the user is a guest.
  if (window.ccAuth && window.ccAuth.isSignedIn()) {
    try {
      const res = await window.ccAuth.saveCheck(entry);
      if (res && res.ok) return;
    } catch { /* fall through to local */ }
  }
  const list = loadHistory();
  list.unshift(entry);
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

function removeHistoryEntry(id) {
  const list = loadHistory().filter(e => e.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

async function clearAllHistory() {
  if (window.ccAuth && window.ccAuth.isSignedIn()) {
    try { await window.ccAuth.clearAll(); } catch { /* ignore */ }
    return;
  }
  clearHistory();
}

function historyCountText(n, signedIn) {
  return n + ' entr' + (n === 1 ? 'y' : 'ies') + (signedIn ? ' · synced' : '');
}

historyBtn.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyModal.addEventListener('click', (e) => { if (e.target === historyModal) closeHistory(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !historyModal.hidden) closeHistory(); });

// Refresh the history panel when the user signs in or out so it reflects the
// correct source (cloud vs local).
if (window.ccAuth && typeof window.ccAuth.onChange === 'function') {
  window.ccAuth.onChange(() => {
    if (historyModal && !historyModal.hidden) renderHistoryList();
  });
}

function openHistory() {
  historyModal.hidden = false;
  historyClose.focus();
  renderHistoryList();
}

function closeHistory() {
  historyModal.hidden = true;
  historyBtn.focus();
}

async function renderHistoryList() {
  const signedIn = !!(window.ccAuth && window.ccAuth.isSignedIn());

  // For signed-in users we fetch from Supabase; show a loading state while
  // the request is in flight.
  if (signedIn) {
    historyListEl.innerHTML = '';
    const loading = el('p', 'history-empty');
    loading.textContent = 'Loading your synced checks…';
    historyListEl.appendChild(loading);
  }

  let entries;
  let loadError = false;
  if (signedIn) {
    try {
      entries = await window.ccAuth.fetchHistory();
    } catch {
      loadError = true;
      entries = [];
    }
    // The panel may have been closed while we were awaiting.
    if (historyModal.hidden) return;
  } else {
    entries = loadHistory();
  }

  historyListEl.innerHTML = '';

  if (loadError) {
    const err = el('p', 'history-empty');
    err.textContent = 'Could not load your synced history. Please try again.';
    historyListEl.appendChild(err);
    return;
  }

  if (!entries.length) {
    const empty = el('p', 'history-empty');
    empty.textContent = signedIn
      ? 'No saved checks yet. Check a claim to see it here.'
      : 'No analyses yet. Check a claim to see it here.';
    historyListEl.appendChild(empty);
    return;
  }

  const subhead = el('div', 'history-subhead');
  const count = el('span', 'history-count');
  count.textContent = historyCountText(entries.length, signedIn);
  const clearBtn = el('button', 'history-clear');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear all';
  clearBtn.addEventListener('click', async () => {
    await clearAllHistory();
    renderHistoryList();
  });
  subhead.appendChild(count);
  subhead.appendChild(clearBtn);
  historyListEl.appendChild(subhead);

  for (const entry of entries) {
    historyListEl.appendChild(makeHistoryItem(entry, signedIn));
  }
}

function makeHistoryItem(entry, signedIn) {
  const wrap = el('div', 'history-item');

  const loadBtn = el('button', 'history-item__load');
  loadBtn.type = 'button';

  const claimP = el('p', 'history-item__claim');
  claimP.textContent = entry.claim_text || entry.claim;
  loadBtn.appendChild(claimP);

  const meta = el('div', 'history-item__meta');
  const badge = el('span', `history-verdict history-verdict--${entry.verdict}`);
  badge.textContent = verdictLabel(entry.verdict);
  const date = el('span', 'history-item__date');
  date.textContent = formatHistoryDate(entry.timestamp);
  meta.appendChild(badge);
  meta.appendChild(date);
  loadBtn.appendChild(meta);

  loadBtn.addEventListener('click', () => loadHistoryEntry(entry));
  wrap.appendChild(loadBtn);

  const delBtn = el('button', 'history-item__delete');
  delBtn.type = 'button';
  delBtn.setAttribute('aria-label', 'Remove this entry');
  delBtn.textContent = '×';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    delBtn.disabled = true;
    if (entry._cloud && window.ccAuth) {
      try { await window.ccAuth.deleteCheck(entry.id); }
      catch { delBtn.disabled = false; return; }
    } else {
      removeHistoryEntry(entry.id);
    }
    wrap.remove();
    const remaining = historyListEl.querySelectorAll('.history-item');
    if (!remaining.length) renderHistoryList();
    else {
      const countEl = historyListEl.querySelector('.history-count');
      if (countEl) {
        countEl.textContent = historyCountText(remaining.length, signedIn);
      }
    }
  });
  wrap.appendChild(delBtn);

  return wrap;
}

function loadHistoryEntry(entry) {
  closeHistory();
  clearAll();

  const isUrl = entry.inputType === 'url' || (!!entry.url && !entry.claim);
  setInputMode(isUrl ? 'url' : 'claim');
  if (isUrl) {
    urlInput.value = typeof entry.url === 'string' ? entry.url : '';
  } else {
    claimInput.value = typeof entry.claim === 'string' ? entry.claim : '';
  }

  academicToggle.checked = Boolean(entry.academic);
  currentPrediction      = entry.prediction || null;
  lastResult = {
    v: 1,
    mode: isUrl ? 'url' : 'claim',
    claim: entry.claim || '',
    url: entry.url || '',
    academic: entry.academic,
    prediction: entry.prediction,
    data: entry.data,
  };
  lastRequest = { mode: isUrl ? 'url' : 'claim', text: entry.claim || '', url: entry.url || '', academic: entry.academic };
  renderResults(entry.data, { prediction: entry.prediction });
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatHistoryDate(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const diffMs   = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1)  return 'Just now';
  if (diffMins < 60) return diffMins + 'm ago';
  if (diffDays === 0) return 'Today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return diffDays + ' days ago';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

let currentAnalysis  = null;   // in-flight fetch promise
let currentPrediction = null;  // 'true' | 'false' | 'unsure' | null
let inputMode        = 'claim'; // 'claim' | 'url'
let lastRequest      = { mode: 'claim', text: '', url: '', academic: false };
let lastResult       = null;   // shareable payload of the rendered analysis

const STARTER_CLAIMS = [
  {
    category: 'Science & Nature',
    claims: [
      'Lightning never strikes the same place twice.',
      'The Great Wall of China is visible from space with the naked eye.',
      'Antibiotics are an effective treatment for viral infections like the common cold.',
      'A goldfish has a memory span of only three seconds.',
    ],
  },
  {
    category: 'Health & Nutrition',
    claims: [
      'Eating carrots significantly improves your night vision.',
      'You must drink eight glasses of water a day to stay healthy.',
      'Vitamin C supplements prevent the common cold.',
      'Vaccines cause autism.',
    ],
  },
  {
    category: 'History & Society',
    claims: [
      'Napoleon Bonaparte was unusually short for his time.',
      'Humans only use 10 percent of their brains.',
      'People convicted in the Salem witch trials were burned at the stake.',
      'Albert Einstein failed mathematics as a student.',
    ],
  },
  {
    category: 'Media & Technology',
    claims: [
      "A browser's incognito mode makes your web activity completely anonymous.",
      '5G mobile networks spread the COVID-19 virus.',
      'Charging your phone overnight permanently damages the battery.',
      'A higher megapixel count always means a better camera.',
    ],
  },
  {
    category: 'Civic & Environment',
    claims: [
      'The United States incarcerates more people than any other country.',
      'In many markets, newly built solar and wind power is now cheaper than new coal or gas.',
      'Recycling alone can solve the ocean plastic pollution crisis.',
      'Electric cars produce zero emissions over their full lifecycle.',
    ],
  },
];

checkBtn.addEventListener('click', startCheck);

claimInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') startCheck();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startCheck(); }
});

tabClaim.addEventListener('click', () => setInputMode('claim'));
tabUrl.addEventListener('click', () => setInputMode('url'));

function setInputMode(mode) {
  inputMode = mode === 'url' ? 'url' : 'claim';
  const isUrl = inputMode === 'url';

  tabClaim.classList.toggle('input-tab--active', !isUrl);
  tabUrl.classList.toggle('input-tab--active', isUrl);
  tabClaim.setAttribute('aria-selected', String(!isUrl));
  tabUrl.setAttribute('aria-selected', String(isUrl));
  claimPane.hidden = isUrl;
  urlPane.hidden = !isUrl;

  checkBtn.textContent = isUrl ? 'Analyze Article' : 'Check Claim';
  // The "predict first" gate only makes sense for a claim the user can read up
  // front, so it is hidden in URL mode.
  predictPanel.hidden = true;
  fieldError.hidden = true;
  (isUrl ? urlInput : claimInput).focus();
}

function startCheck() {
  if (inputMode === 'url') checkUrl();
  else checkClaim();
}

for (const btn of predictPanel.querySelectorAll('.predict-btn')) {
  btn.addEventListener('click', () => onPredictionChosen(btn.dataset.prediction));
}

dismissShared.addEventListener('click', () => { sharedBanner.hidden = true; });

libraryToggle.addEventListener('click', toggleLibrary);
buildLibrary();

window.addEventListener('DOMContentLoaded', loadFromHash);
if (document.readyState !== 'loading') loadFromHash();

/* ── Main flow ─────────────────────────────────────── */

function checkClaim() {
  const text = claimInput.value.trim();

  clearAll();
  currentPrediction = null;

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

  const academic = academicToggle.checked;
  lastRequest = { mode: 'claim', text, url: '', academic };

  // Kick off the analysis right away so the prediction step adds no latency.
  currentAnalysis = runAnalysis(text, academic);
  currentAnalysis.catch(() => {}); // silence unhandled rejection; handled on await

  if (predictToggle.checked) {
    showPredictPanel();
  } else {
    settleAnalysis();
  }
}

function checkUrl() {
  const url = urlInput.value.trim();

  clearAll();
  currentPrediction = null;

  if (!url) {
    showFieldError('Please paste a URL to analyze.');
    urlInput.focus();
    return;
  }
  if (!isValidHttpUrl(url)) {
    showFieldError('Please enter a valid http:// or https:// URL.');
    urlInput.focus();
    return;
  }

  const academic = academicToggle.checked;
  lastRequest = { mode: 'url', text: '', url, academic };

  // No prediction gate in URL mode — the user hasn't seen the claim yet.
  currentAnalysis = runUrlAnalysis(url, academic);
  currentAnalysis.catch(() => {});
  settleAnalysis();
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function runUrlAnalysis(url, academic) {
  const res = await fetch('/analyze-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, academicMode: academic }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`The server returned an unexpected response (${res.status}).`);
  }

  if (!res.ok) {
    throw new Error(data && data.error ? data.error : `Analysis failed (${res.status}).`);
  }
  return data;
}

async function runAnalysis(text, academic) {
  const res = await fetch('/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, academicMode: academic }),
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
  return data;
}

async function settleAnalysis() {
  setLoading(true);
  try {
    const data = await currentAnalysis;
    const isUrl = lastRequest.mode === 'url';
    const article = (data && data._article) || {};
    lastResult = {
      v: 1,
      mode: lastRequest.mode,
      claim: lastRequest.text,
      url: lastRequest.url,
      academic: lastRequest.academic,
      prediction: currentPrediction,
      data,
    };
    await saveToHistory({
      id: Date.now(),
      timestamp: Date.now(),
      inputType: lastRequest.mode,
      claim: isUrl ? '' : lastRequest.text,
      url: lastRequest.url,
      articleTitle: article.title || '',
      claim_text: data.claim_text || (isUrl ? article.title : lastRequest.text),
      verdict: normalizeVerdict(data.verdict),
      academic: lastRequest.academic,
      prediction: currentPrediction,
      data,
    });
    renderResults(data, { prediction: currentPrediction });
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

/* ── Prediction gate ───────────────────────────────── */

function showPredictPanel() {
  currentPrediction = null;
  for (const b of predictPanel.querySelectorAll('.predict-btn')) {
    b.classList.remove('predict-btn--active');
  }
  predictPanel.hidden = false;
  checkBtn.disabled = true;
  predictPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function onPredictionChosen(prediction) {
  currentPrediction = prediction;
  predictPanel.hidden = true;
  checkBtn.disabled = false;
  settleAnalysis();
}

/* ── Starter library ───────────────────────────────── */

function buildLibrary() {
  const frag = document.createDocumentFragment();
  for (const group of STARTER_CLAIMS) {
    const cat = el('div', 'library__category');
    const label = el('p', 'library__category-label');
    label.textContent = group.category;
    cat.appendChild(label);

    const list = el('div', 'library__claims');
    for (const claim of group.claims) {
      const item = el('button', 'library__claim');
      item.type = 'button';
      item.textContent = claim;
      item.addEventListener('click', () => loadStarterClaim(claim));
      list.appendChild(item);
    }
    cat.appendChild(list);
    frag.appendChild(cat);
  }
  libraryPanel.appendChild(frag);
}

function toggleLibrary() {
  const open = libraryPanel.hidden;
  libraryPanel.hidden = !open;
  libraryToggle.setAttribute('aria-expanded', String(open));
  libraryToggle.classList.toggle('library__toggle--open', open);
}

function loadStarterClaim(text) {
  setInputMode('claim');
  claimInput.value = text;
  libraryPanel.hidden = true;
  libraryToggle.setAttribute('aria-expanded', 'false');
  libraryToggle.classList.remove('library__toggle--open');
  fieldError.hidden = true;
  claimInput.focus();
  claimInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ── State helpers ─────────────────────────────────── */

function setLoading(on) {
  const isUrl = lastRequest.mode === 'url';
  const statusText = document.getElementById('status-text');
  if (statusText) {
    statusText.textContent = isUrl
      ? 'Reading the article and identifying claims… this can take a little longer.'
      : 'Analyzing claim — this may take up to 30 seconds…';
  }
  statusEl.hidden  = !on;
  checkBtn.disabled = on;
  const idleLabel = isUrl ? 'Analyze Article' : 'Check Claim';
  checkBtn.textContent = on ? (isUrl ? 'Analyzing…' : 'Checking…') : idleLabel;
}

function clearAll() {
  fieldError.hidden = true;
  fieldError.textContent = '';
  apiError.hidden = true;
  apiErrorText.textContent = '';
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
  predictPanel.hidden = true;
  sharedBanner.hidden = true;
  checkBtn.disabled = false;
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

function renderResults(data, opts = {}) {
  resultsEl.innerHTML = '';
  resultsEl.hidden = false;

  // 0. Action bar (share + export)
  resultsEl.appendChild(makeActionsBar());

  // 0a. Article source header (URL analyses only)
  if (data._article && (data._article.title || data._article.url)) {
    resultsEl.appendChild(makeArticleHeader(data._article));
  }

  // 0b. Prediction recap
  if (opts.prediction) {
    resultsEl.appendChild(makePredictionRecap(opts.prediction, normalizeVerdict(data.verdict)));
  }

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

  // 1b. Secondary claims (URL analyses may surface a few)
  const secondary = Array.isArray(data.secondary_claims)
    ? data.secondary_claims.filter(c => typeof c === 'string' && c.trim())
    : [];
  if (secondary.length) {
    const sec = makeSection('Other Claims in the Article');
    const list = el('ul', 'secondary-claims-list');
    for (const c of secondary) {
      const li = document.createElement('li');
      li.textContent = c;
      list.appendChild(li);
    }
    sec.appendChild(list);
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

  // 7b. Context Lens — educational background framing
  resultsEl.appendChild(makeContextLensSection(data.contextLens || data.context_lens));

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

/* ── Context Lens ──────────────────────────────────── */

function makeContextLensSection(rawLens) {
  const lens = rawLens && typeof rawLens === 'object' ? rawLens : {};

  const snapshot = strOrEmpty(lens.backgroundSnapshot);
  const keyContext = cleanList(lens.keyContext);
  const whyMatters = strOrEmpty(lens.whyContextMatters);
  const missing = cleanList(lens.missingInformation);
  const questions = cleanList(lens.reflectionQuestions);
  const warning = strOrEmpty(lens.contextWarning);

  const hasContent = snapshot || keyContext.length || whyMatters || missing.length || questions.length;

  const sec = el('div', 'section context-lens');

  // Expandable header so the lens feels like an optional, opt-in tool.
  const toggle = el('button', 'context-lens__toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');

  const icon = el('span', 'context-lens__icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🔍';

  const titleWrap = el('span', 'context-lens__titlewrap');
  const title = el('span', 'context-lens__title');
  title.textContent = 'Context Lens';
  const sub = el('span', 'context-lens__subtitle');
  sub.textContent = 'Background to help you judge the claim fairly';
  titleWrap.appendChild(title);
  titleWrap.appendChild(sub);

  const chevron = el('span', 'context-lens__chevron');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';

  toggle.appendChild(icon);
  toggle.appendChild(titleWrap);
  toggle.appendChild(chevron);
  sec.appendChild(toggle);

  const body = el('div', 'context-lens__body');
  body.hidden = true;

  if (!hasContent) {
    const fallback = el('p', 'context-lens__fallback');
    fallback.textContent =
      'Context could not be generated for this claim. Try checking the claim again or adding more detail.';
    body.appendChild(fallback);
  } else {
    if (warning) {
      const warn = el('div', 'context-lens__warning');
      const wicon = el('span', 'context-lens__warning-icon');
      wicon.setAttribute('aria-hidden', 'true');
      wicon.textContent = '⚠';
      const wtext = el('span', 'context-lens__warning-text');
      wtext.textContent = warning;
      warn.appendChild(wicon);
      warn.appendChild(wtext);
      body.appendChild(warn);
    }

    if (snapshot) {
      body.appendChild(makeContextBlock('Background Snapshot'));
      const p = el('p', 'context-lens__paragraph');
      p.textContent = snapshot;
      body.appendChild(p);
    }

    if (keyContext.length) {
      body.appendChild(makeContextBlock('Key Context'));
      body.appendChild(makeContextList(keyContext, 'context-lens__list'));
    }

    if (whyMatters) {
      body.appendChild(makeContextBlock('Why This Context Matters'));
      const p = el('p', 'context-lens__paragraph');
      p.textContent = whyMatters;
      body.appendChild(p);
    }

    if (missing.length) {
      body.appendChild(makeContextBlock('Missing or Needed Information'));
      body.appendChild(makeContextList(missing, 'context-lens__list'));
    }

    if (questions.length) {
      body.appendChild(makeContextBlock('Reflection Questions'));
      body.appendChild(makeContextList(questions, 'context-lens__list context-lens__list--questions'));
    }
  }

  sec.appendChild(body);

  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    sec.classList.toggle('context-lens--open', open);
  });

  return sec;
}

function makeContextBlock(label) {
  const h = el('p', 'context-lens__label');
  h.textContent = label;
  return h;
}

function makeContextList(items, className) {
  const ul = el('ul', className);
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

function strOrEmpty(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function cleanList(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

/* ── Prediction recap ──────────────────────────────── */

function makePredictionRecap(prediction, verdict) {
  const state = predictionOutcome(prediction, verdict);
  const sec = el('div', `section predict-recap predict-recap--${state}`);

  const title = el('p', 'section-title');
  title.textContent = 'Your Prediction vs. The Evidence';
  sec.appendChild(title);

  const row = el('div', 'predict-recap__row');

  const mine = el('div', 'predict-recap__col');
  const mineLbl = el('span', 'predict-recap__collabel');
  mineLbl.textContent = 'You predicted';
  const mineChip = el('span', `predict-chip predict-chip--${prediction}`);
  mineChip.textContent = predictionLabel(prediction);
  mine.appendChild(mineLbl);
  mine.appendChild(mineChip);

  const arrow = el('span', 'predict-recap__arrow');
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');

  const ev = el('div', 'predict-recap__col');
  const evLbl = el('span', 'predict-recap__collabel');
  evLbl.textContent = 'Evidence says';
  const evChip = el('span', `predict-chip predict-chip--verdict-${verdict}`);
  evChip.textContent = verdictLabel(verdict);
  ev.appendChild(evLbl);
  ev.appendChild(evChip);

  row.appendChild(mine);
  row.appendChild(arrow);
  row.appendChild(ev);
  sec.appendChild(row);

  const note = el('p', 'predict-recap__note');
  note.textContent = predictionNote(state, prediction);
  sec.appendChild(note);

  return sec;
}

function predictionOutcome(prediction, verdict) {
  if (prediction === 'unsure' || verdict === 'unclear') return 'partial';
  const expected = prediction === 'true' ? 'supported' : 'contradicted';
  return verdict === expected ? 'match' : 'mismatch';
}

function predictionLabel(p) {
  return { true: 'Likely true', false: 'Likely false', unsure: 'Not sure' }[p] || 'Not sure';
}

function predictionNote(state, prediction) {
  if (state === 'match') {
    return 'Your initial read lined up with the evidence. Notice what signals led you there — were they reliable reasons, or a lucky guess?';
  }
  if (state === 'mismatch') {
    return 'Your initial read differed from where the evidence points. That gap is worth examining: what made the claim feel believable before you checked?';
  }
  if (prediction === 'unsure') {
    return 'You held off on judging — a reasonable instinct for an unfamiliar claim. See how the evidence resolves it below.';
  }
  return 'You had a confident prediction, but the evidence itself is mixed or limited. Certainty in your gut does not always match the strength of available proof.';
}

/* ── Sharing ───────────────────────────────────────── */

function makeActionsBar() {
  const bar = el('div', 'results-actions');

  const shareBtn = el('button', 'btn-share');
  shareBtn.type = 'button';
  shareBtn.textContent = 'Copy share link';
  shareBtn.addEventListener('click', () => onShareClick(shareBtn));
  bar.appendChild(shareBtn);

  const pdfBtn = el('button', 'btn-share btn-export');
  pdfBtn.type = 'button';
  pdfBtn.textContent = 'Export as PDF';
  pdfBtn.addEventListener('click', () => onExportClick('pdf', pdfBtn));
  bar.appendChild(pdfBtn);

  const docxBtn = el('button', 'btn-share btn-export');
  docxBtn.type = 'button';
  docxBtn.textContent = 'Export as Word';
  docxBtn.addEventListener('click', () => onExportClick('docx', docxBtn));
  bar.appendChild(docxBtn);

  return bar;
}

function makeArticleHeader(article) {
  const box = el('div', 'article-header');

  const label = el('span', 'article-header__label');
  label.textContent = 'Analyzed from';
  box.appendChild(label);

  if (article.title) {
    const title = el('p', 'article-header__title');
    title.textContent = article.title;
    box.appendChild(title);
  }

  if (article.url) {
    const src = el('a', 'article-header__source');
    src.href = article.url;
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.textContent = safeHostname(article.url);
    box.appendChild(src);
  }

  return box;
}

/* ── Export (PDF / Word) ───────────────────────────── */

function exportMeta() {
  const r = lastResult || {};
  const article = (r.data && r.data._article) || {};
  const isUrl = r.mode === 'url';
  return {
    inputType: isUrl ? 'url' : 'claim',
    originalInput: isUrl ? (r.url || '') : (r.claim || ''),
    articleTitle: article.title || '',
    sourceUrl: isUrl ? (r.url || article.url || '') : '',
  };
}

async function onExportClick(format, btn) {
  if (!lastResult || !lastResult.data) return;

  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting…';

  try {
    const res = await fetch('/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, result: lastResult.data, meta: exportMeta() }),
    });
    if (!res.ok) throw new Error('Export failed');

    const blob = await res.blob();
    const filename = filenameFromDisposition(res.headers.get('Content-Disposition'))
      || `ClaimCheck_Report.${format}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    btn.textContent = btn.dataset.label;
    btn.disabled = false;
  } catch {
    btn.textContent = 'Export failed';
    btn.classList.add('btn-share--error');
    clearTimeout(btn._exportTimer);
    btn._exportTimer = setTimeout(() => {
      btn.textContent = btn.dataset.label;
      btn.classList.remove('btn-share--error');
      btn.disabled = false;
    }, 2400);
  }
}

function filenameFromDisposition(header) {
  if (!header) return '';
  const m = /filename="?([^"]+)"?/.exec(header);
  return m ? m[1] : '';
}

async function onShareClick(btn) {
  if (!lastResult) return;
  let url;
  try {
    const encoded = encodeState(lastResult);
    url = `${location.origin}${location.pathname}#r=${encoded}`;
    history.replaceState(null, '', `${location.pathname}#r=${encoded}`);
  } catch {
    flashBtn(btn, 'Could not build link');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    flashBtn(btn, 'Link copied!');
  } catch {
    flashBtn(btn, 'Link in address bar');
  }
}

function flashBtn(btn, msg) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = msg;
  btn.classList.add('btn-share--done');
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('btn-share--done');
  }, 2200);
}

function loadFromHash() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (!m) return;

  let state;
  try {
    state = decodeState(m[1]);
  } catch {
    return;
  }
  if (!state || typeof state !== 'object' || !state.data) return;

  clearAll();
  const isUrl = state.mode === 'url' || (!!state.url && !state.claim);
  setInputMode(isUrl ? 'url' : 'claim');
  if (isUrl) {
    urlInput.value = typeof state.url === 'string' ? state.url : '';
  } else {
    claimInput.value = typeof state.claim === 'string' ? state.claim : '';
  }
  academicToggle.checked = Boolean(state.academic);
  currentPrediction     = state.prediction || null;
  lastResult            = state;
  lastRequest           = { mode: isUrl ? 'url' : 'claim', text: isUrl ? '' : claimInput.value, url: isUrl ? urlInput.value : '', academic: academicToggle.checked };

  renderResults(state.data, { prediction: state.prediction });
  sharedBanner.hidden = false;
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function encodeState(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
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
