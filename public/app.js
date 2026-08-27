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
const snapshotToggle = document.getElementById('snapshot-toggle');
const contextToggle  = document.getElementById('context-toggle');
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
const langSelect     = document.getElementById('lang-select');
const charCounter    = document.getElementById('char-counter');

/* ── Classroom Mode ────────────────────────────────── */
// Set by public/classroom/room.js BEFORE this file loads, and absent on the
// public homepage. Every use below is gated on it, so when it is null this file
// behaves exactly as it did before Classroom Mode existed.
//
// Its presence changes three things: analyses go to the classroom endpoints
// with the anonymous session token attached, nothing is written to history or
// the cloud, and shared-result links are ignored.
const CLASSROOM = window.ccClassroom || null;

/* ── Claim length limit ────────────────────────────── */

// The cap the claim box enforces. This local value keeps the counter honest
// before the server has answered; /api/limits then supplies the configured
// number so one environment variable drives both sides. The server re-checks
// the length on every request regardless — this copy exists to give immediate
// feedback, not to be trusted.
const DEFAULT_MAX_CLAIM_CHARS = 750;
let maxClaimChars = DEFAULT_MAX_CLAIM_CHARS;

(async function loadLimits() {
  try {
    const res = await fetch('/api/limits');
    if (!res.ok) return;
    const data = await res.json();
    const max = Number(data && data.maxClaimCharacters);
    if (Number.isFinite(max) && max > 0) {
      maxClaimChars = max;
      updateCharCounter();
    }
  } catch {
    // Offline or an older backend: the built-in default stands, and the server
    // remains the authority either way.
  }
})();

/**
 * Redraws the live `243 / 750` counter under the claim box.
 *
 * Counts UTF-16 code units, matching String.length on the server, so the two
 * agree exactly on where the boundary falls even for emoji and accented text.
 */
function updateCharCounter() {
  if (!charCounter) return;
  const used = claimInput.value.length;
  const over = used > maxClaimChars;

  charCounter.textContent = `${used.toLocaleString(window.ccI18n.locale())} / ${maxClaimChars.toLocaleString(window.ccI18n.locale())}`;
  charCounter.classList.toggle('char-counter--over', over);
  // Only announced once the limit is passed. A counter that speaks on every
  // keystroke makes the box unusable with a screen reader.
  charCounter.setAttribute('aria-live', over ? 'polite' : 'off');
}

/* ── Localization ──────────────────────────────────── */
// Thin wrappers over the shared i18n core so call sites stay terse.
const t     = (key, params) => window.ccI18n.t(key, params);
const tList = (key) => window.ccI18n.tList(key);

// The active language ('en' | 'es'), validated by the i18n core. Sent to the
// backend so the AI analysis is generated in the same language, and stored on
// each result/history entry so shared links and exports stay coherent.
let currentLang = window.ccI18n.getLang();

(function initLangSelect() {
  if (langSelect) {
    langSelect.value = currentLang;
    langSelect.addEventListener('change', () => window.ccI18n.setLang(langSelect.value));
  }
})();

// When the language changes: keep the selector in sync, refresh dynamic strings,
// and re-render whatever is currently on screen so the switch is instant and the
// user keeps their work (the AI text stays as generated; re-run to translate it).
window.ccI18n.onChange((lang) => {
  currentLang = lang;
  if (langSelect && langSelect.value !== lang) langSelect.value = lang;
  checkBtn.textContent = idleButtonLabel();
  rebuildLibrary();
  if (lastResult && lastResult.data && !resultsEl.hidden) {
    renderResults(lastResult.data, { prediction: currentPrediction });
  }
  if (historyModal && !historyModal.hidden) renderHistoryList();
});

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
  // Classroom Mode keeps no record of what students check — not in the cloud,
  // not in localStorage. This early return is the single point that guarantees
  // it for every analysis path, so do not move the check further down.
  if (CLASSROOM) return;

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
  const count = t(n === 1 ? 'history.countOne' : 'history.countOther', { n });
  return count + (signedIn ? t('history.syncedSuffix') : '');
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
    loading.textContent = t('history.loading');
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
    err.textContent = t('history.loadError');
    historyListEl.appendChild(err);
    return;
  }

  if (!entries.length) {
    const empty = el('p', 'history-empty');
    empty.textContent = signedIn ? t('history.emptySignedIn') : t('history.emptyGuest');
    historyListEl.appendChild(empty);
    return;
  }

  const subhead = el('div', 'history-subhead');
  const count = el('span', 'history-count');
  count.textContent = historyCountText(entries.length, signedIn);
  const clearBtn = el('button', 'history-clear');
  clearBtn.type = 'button';
  clearBtn.textContent = t('history.clearAll');
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
  delBtn.setAttribute('aria-label', t('history.remove'));
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

  // Show the analysis in the language it was generated in, so the UI chrome
  // matches the AI content the entry contains.
  const storedLang = entry.language || (entry.data && entry.data._meta && entry.data._meta.language);
  const entryLang = window.ccI18n.isSupported(storedLang) ? storedLang : currentLang;
  if (entryLang !== currentLang) window.ccI18n.setLang(entryLang);

  const isUrl = entry.inputType === 'url' || (!!entry.url && !entry.claim);
  setInputMode(isUrl ? 'url' : 'claim');
  if (isUrl) {
    urlInput.value = typeof entry.url === 'string' ? entry.url : '';
  } else {
    claimInput.value = typeof entry.claim === 'string' ? entry.claim : '';
    updateCharCounter();
  }

  const snapshot = Boolean(entry.snapshot || (entry.data && entry.data._meta && entry.data._meta.snapshot));
  const contextLens = resolveContextPref(entry, entry.data);
  academicToggle.checked = Boolean(entry.academic);
  snapshotToggle.checked = snapshot;
  contextToggle.checked  = contextLens;
  checkBtn.textContent   = idleButtonLabel();
  currentPrediction      = entry.prediction || null;
  lastResult = {
    v: 1,
    mode: isUrl ? 'url' : 'claim',
    claim: entry.claim || '',
    url: entry.url || '',
    academic: entry.academic,
    snapshot,
    contextLens,
    language: entryLang,
    prediction: entry.prediction,
    data: entry.data,
  };
  lastRequest = { mode: isUrl ? 'url' : 'claim', text: entry.claim || '', url: entry.url || '', academic: entry.academic, snapshot, contextLens, language: entryLang };
  renderResults(entry.data, { prediction: entry.prediction });
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatHistoryDate(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const loc = window.ccI18n.locale();
  const diffMs   = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1)  return t('history.justNow');
  if (diffMins < 60) return t('history.minutesAgo', { n: diffMins });
  if (diffDays === 0) return t('history.today', { time: d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }) });
  if (diffDays === 1) return t('history.yesterday');
  if (diffDays < 7)  return t('history.daysAgo', { n: diffDays });
  return d.toLocaleDateString(loc, { month: 'short', day: 'numeric' });
}

let currentAnalysis  = null;   // in-flight fetch promise
let currentPrediction = null;  // 'true' | 'false' | 'unsure' | null
let inputMode        = 'claim'; // 'claim' | 'url'
let lastRequest      = { mode: 'claim', text: '', url: '', academic: false, snapshot: false, contextLens: true, language: currentLang };
let lastResult       = null;   // shareable payload of the rendered analysis

// Starter examples are pulled from the active locale so they can be shown in the
// user's language. Adding a category is a locale-file change; the keys here are
// the stable category identifiers shared across all locales.
const STARTER_CATEGORIES = ['science', 'health', 'history', 'media', 'civic'];

function starterGroups() {
  return STARTER_CATEGORIES.map((key) => ({
    category: t('library.categories.' + key),
    claims: tList('library.claims.' + key),
  }));
}

checkBtn.addEventListener('click', startCheck);

claimInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') startCheck();
});

// 'input' rather than 'keyup' so pasting, dragging text in, undo, and speech
// input all move the counter — the ways a claim most often gets too long are
// the ways that never touch a key.
claimInput.addEventListener('input', updateCharCounter);
updateCharCounter();

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startCheck(); }
});

tabClaim.addEventListener('click', () => setInputMode('claim'));
tabUrl.addEventListener('click', () => setInputMode('url'));

// Keep the primary button label in sync with the snapshot toggle.
snapshotToggle.addEventListener('change', () => { checkBtn.textContent = idleButtonLabel(); });

// The Context Lens on/off choice is a sticky preference across sessions.
(function initContextToggle() {
  const saved = localStorage.getItem('contextLens');
  if (saved !== null) contextToggle.checked = saved === 'true';
})();
contextToggle.addEventListener('change', () => {
  localStorage.setItem('contextLens', String(contextToggle.checked));
});

function setInputMode(mode) {
  inputMode = mode === 'url' ? 'url' : 'claim';
  const isUrl = inputMode === 'url';

  tabClaim.classList.toggle('input-tab--active', !isUrl);
  tabUrl.classList.toggle('input-tab--active', isUrl);
  tabClaim.setAttribute('aria-selected', String(!isUrl));
  tabUrl.setAttribute('aria-selected', String(isUrl));
  claimPane.hidden = isUrl;
  urlPane.hidden = !isUrl;

  checkBtn.textContent = idleButtonLabel();
  // The "predict first" gate only makes sense for a claim the user can read up
  // front, so it is hidden in URL mode.
  predictPanel.hidden = true;
  fieldError.hidden = true;
  (isUrl ? urlInput : claimInput).focus();
}

/**
 * True while a request is in flight or waiting on the prediction gate.
 *
 * The disabled Analyze button is not sufficient on its own: Ctrl+Enter in the
 * claim box and Enter in the URL box both call startCheck() directly and never
 * consult the button, so an impatient double-tap used to fire a second analysis
 * — and in a classroom that is a second ClaimCheck deducted for one question.
 * This flag closes every path at once.
 */
let analysisInFlight = false;

function startCheck() {
  if (analysisInFlight) return;
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
    showFieldError(t('errors.claimEmpty'));
    claimInput.focus();
    return;
  }
  if (text.length < 8) {
    showFieldError(t('errors.claimShort'));
    claimInput.focus();
    return;
  }
  // Refused here so an over-long claim never reaches the network — a validation
  // error must not cost the student one of their ClaimChecks. The server
  // enforces the same cap for anything that skips this check.
  if (text.length > maxClaimChars) {
    showFieldError(t('errors.claimTooLong', { max: maxClaimChars }));
    updateCharCounter();
    claimInput.focus();
    return;
  }

  const academic = academicToggle.checked;
  const snapshot = snapshotToggle.checked;
  const contextLens = contextToggle.checked;
  const language = currentLang;
  lastRequest = { mode: 'claim', text, url: '', academic, snapshot, contextLens, language };

  analysisInFlight = true;

  // Kick off the analysis right away so the prediction step adds no latency.
  currentAnalysis = runAnalysis(text, academic, snapshot, contextLens, language);
  currentAnalysis.catch(() => {}); // silence unhandled rejection; handled on await

  // The predict-first gate is skipped in snapshot mode — the point of a snapshot
  // is a quick rundown, not a reflection exercise.
  if (predictToggle.checked && !snapshot) {
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
    showFieldError(t('errors.urlEmpty'));
    urlInput.focus();
    return;
  }
  if (!isValidHttpUrl(url)) {
    showFieldError(t('errors.urlInvalid'));
    urlInput.focus();
    return;
  }

  const academic = academicToggle.checked;
  const snapshot = snapshotToggle.checked;
  const contextLens = contextToggle.checked;
  const language = currentLang;
  lastRequest = { mode: 'url', text: '', url, academic, snapshot, contextLens, language };

  analysisInFlight = true;

  // No prediction gate in URL mode — the user hasn't seen the claim yet.
  currentAnalysis = runUrlAnalysis(url, academic, snapshot, contextLens, language);
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

/**
 * Endpoint and headers for an analysis request.
 *
 * In Classroom Mode the request goes to the classroom endpoints and carries the
 * anonymous session token. The token identifies the classroom, never a student,
 * and the API key stays on the server in both modes — the browser never talks
 * to an AI provider directly.
 */
function analysisRequest(path) {
  const headers = { 'Content-Type': 'application/json' };
  if (!CLASSROOM) return { url: path, headers };
  headers['X-Classroom-Session'] = CLASSROOM.token;
  // The anonymous per-classroom id, so the backend can count this student's
  // ClaimChecks. Sent as a lookup key only: the server decides how many have
  // been used and what the cap is, and ignores anything this page thinks.
  if (CLASSROOM.studentId) headers['X-Claimcheck-Student'] = CLASSROOM.studentId;
  return { url: `/api/classroom${path}`, headers };
}

/* ── Usage limits ──────────────────────────────────── */

// Refused because a usage budget is exhausted, rather than because something
// went wrong. Each maps to its own translated message.
const USAGE_LIMIT_CODES = new Set([
  'STUDENT_LIMIT', 'CLASSROOM_LIMIT', 'TOKEN_SAFETY_LIMIT', 'GLOBAL_LIMIT', 'USAGE_UNVERIFIED',
]);

/**
 * Turns a limit refusal into the message the user should read.
 *
 * Translated locally from the server's `code` so a Spanish-language student
 * gets Spanish. The server's own English text is the fallback for a code this
 * build does not recognise, which keeps a newer backend intelligible to an
 * older page.
 */
function usageLimitMessage(data) {
  const code = data && data.code;
  switch (code) {
    case 'STUDENT_LIMIT': {
      const limit = (data._usage && data._usage.student && data._usage.student.limit) || 0;
      return limit > 0 ? t('errors.studentLimit', { limit }) : t('errors.studentLimitGeneric');
    }
    case 'CLASSROOM_LIMIT': {
      const limit = (data._usage && data._usage.classroom && data._usage.classroom.limit) || 0;
      return limit > 0 ? t('errors.classroomLimit', { limit }) : t('errors.classroomLimitGeneric');
    }
    // Deliberately not the same message as CLASSROOM_LIMIT. The class did NOT
    // run out of ClaimChecks; something consumed far more than it should have,
    // and telling a student otherwise sends their teacher to the wrong number.
    case 'TOKEN_SAFETY_LIMIT': return t('errors.tokenSafetyLimit');
    case 'GLOBAL_LIMIT':      return t('errors.globalLimit');
    case 'USAGE_UNVERIFIED':  return t('errors.usageUnverified');
    default:                return (data && data.error) || t('errors.generic');
  }
}

/**
 * Handles a non-OK analysis response that was a budget or length refusal.
 * Returns the message to show, or null when this was an ordinary failure.
 */
function limitRefusal(data) {
  if (!data || !data.code) return null;

  if (data.code === 'CLAIM_TOO_LONG') {
    return t('errors.claimTooLong', { max: Number(data.maxClaimCharacters) || maxClaimChars });
  }
  if (USAGE_LIMIT_CODES.has(data.code)) {
    if (CLASSROOM && typeof CLASSROOM.onLimitReached === 'function') CLASSROOM.onLimitReached(data);
    return usageLimitMessage(data);
  }
  return null;
}

/** Hands the classroom UI its budget meter and any PII warning. */
function reportClassroomMeta(data) {
  if (CLASSROOM && data && data._classroom && typeof CLASSROOM.onResult === 'function') {
    CLASSROOM.onResult(data._classroom);
  }
}

async function runUrlAnalysis(url, academic, snapshot, contextLens, language) {
  const req = analysisRequest('/analyze-url');
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ url, academicMode: academic, snapshot: Boolean(snapshot), contextLens: contextLens !== false, language }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(t('errors.unexpectedResponse', { status: res.status }));
  }

  if (!res.ok) {
    const refusal = limitRefusal(data);
    if (refusal) throw new Error(refusal);
    throw new Error(data && data.error ? data.error : t('errors.analysisFailed', { status: res.status }));
  }
  reportClassroomMeta(data);
  return data;
}

async function runAnalysis(text, academic, snapshot, contextLens, language) {
  const req = analysisRequest('/analyze');
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ text, academicMode: academic, snapshot: Boolean(snapshot), contextLens: contextLens !== false, language }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(t('errors.unexpectedResponse', { status: res.status }));
  }

  if (!res.ok) {
    const refusal = limitRefusal(data);
    if (refusal) throw new Error(refusal);

    const msg = data && data.error ? data.error : t('errors.analysisFailed', { status: res.status });
    if (res.status === 500 && msg.includes('ANTHROPIC_API_KEY')) {
      console.error('[ClaimCheck] Missing API key:', msg);
      throw new Error(t('errors.notConfigured'));
    }
    // A classroom that ended, was closed, or ran out of allowance mid-lesson
    // needs the student sent back to the join page rather than shown a retry.
    if (CLASSROOM && typeof CLASSROOM.onSessionError === 'function' &&
        (res.status === 401 || res.status === 403)) {
      CLASSROOM.onSessionError(data && data.code, msg);
    }
    throw new Error(msg);
  }
  reportClassroomMeta(data);
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
      snapshot: lastRequest.snapshot,
      contextLens: lastRequest.contextLens,
      language: lastRequest.language,
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
      snapshot: lastRequest.snapshot,
      contextLens: lastRequest.contextLens,
      language: lastRequest.language,
      prediction: currentPrediction,
      data,
    });
    renderResults(data, { prediction: currentPrediction });
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    const msg = err.message || '';
    if (err.name === 'TypeError' || msg.toLowerCase().includes('failed to fetch')) {
      showApiError(t('errors.backendUnreachable'));
    } else {
      showApiError(msg || t('errors.generic'));
    }
  } finally {
    // Cleared here rather than at the fetch boundary so it also covers the
    // prediction gate, which holds a kicked-off analysis open while the user
    // decides.
    analysisInFlight = false;
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

function rebuildLibrary() {
  libraryPanel.innerHTML = '';
  buildLibrary();
}

function buildLibrary() {
  const frag = document.createDocumentFragment();
  for (const group of starterGroups()) {
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
  updateCharCounter();
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
  const isSnapshot = lastRequest.snapshot;
  const statusText = document.getElementById('status-text');
  if (statusText) {
    if (isSnapshot) {
      statusText.textContent = isUrl ? t('status.snapshotUrl') : t('status.snapshotClaim');
    } else {
      statusText.textContent = isUrl ? t('status.url') : t('status.claim');
    }
  }
  statusEl.hidden  = !on;
  checkBtn.disabled = on;
  const idleLabel = idleButtonLabel();
  checkBtn.textContent = on ? (isSnapshot ? t('buttons.snapshotting') : (isUrl ? t('buttons.analyzing') : t('buttons.checking'))) : idleLabel;
}

function idleButtonLabel() {
  if (snapshotToggle.checked) return t('buttons.quickSnapshot');
  return inputMode === 'url' ? t('buttons.analyzeArticle') : t('buttons.checkClaim');
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

  // 0c. Snapshot summary card — the at-a-glance rundown, shown in every mode.
  const isSnapshot = !!(data._meta && data._meta.snapshot);
  resultsEl.appendChild(makeSnapshotCard(data, isSnapshot));

  // In snapshot mode we keep things to a quick rundown: the card above plus the
  // strongest evidence, with a one-click upgrade to the full analysis.
  if (isSnapshot) {
    resultsEl.appendChild(makeEvidenceSection(
      t('results.supporting'),
      Array.isArray(data.supporting_evidence) ? data.supporting_evidence : []
    ));
    resultsEl.appendChild(makeEvidenceSection(
      t('results.contradicting'),
      Array.isArray(data.contradicting_evidence) ? data.contradicting_evidence : []
    ));
    // Surface the Identity Lens in snapshot mode only when identity is actually
    // in play — either the claim is about it or the claim itself targets a group.
    if (data.identity_lens && identityFlags(data.identity_lens).about) {
      resultsEl.appendChild(makeIdentityLensSection(data.identity_lens));
    }
    resultsEl.appendChild(makeRunFullButton());
    appendMeta(data);
    return;
  }

  // 1. Extracted claim
  if (data.claim_text) {
    const sec = makeSection(t('results.extractedClaim'));
    const p = el('p', 'claim-text-display');
    p.textContent = data.claim_text;
    if (data._meta && data._meta.academic_mode) {
      const pill = el('span', 'academic-pill');
      pill.textContent = t('results.academicPill');
      pill.title = t('results.academicPillTitle');
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
    const sec = makeSection(t('results.otherClaims'));
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
  const evidenceMatch = normalizeEvidenceFound(data);
  if (bd.what || bd.who || bd.when || bd.where || bd.evidence_required || evidenceMatch) {
    const sec = makeSection(t('results.breakdown'));
    const grid = el('div', 'breakdown-grid');
    if (bd.what)              grid.appendChild(makeBreakdownItem(t('results.what'), bd.what));
    if (bd.who)               grid.appendChild(makeBreakdownItem(t('results.who'), bd.who));
    // When/Where appear only when the claim is actually tied to a time or place.
    if (strOrEmpty(bd.when))  grid.appendChild(makeBreakdownItem(t('results.when'), bd.when));
    if (strOrEmpty(bd.where)) grid.appendChild(makeBreakdownItem(t('results.where'), bd.where));
    if (bd.evidence_required) grid.appendChild(makeBreakdownItem(t('results.evidenceNeeded'), bd.evidence_required));
    sec.appendChild(grid);
    // Close the loop: did the type of evidence the claim requires actually turn up?
    if (evidenceMatch) sec.appendChild(makeEvidenceMatch(evidenceMatch));
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
    unc.textContent = t('results.uncertaintyPrefix') + data.uncertainty_notes;
    verdictSec.appendChild(unc);
  }
  resultsEl.appendChild(verdictSec);

  // 3b. Tell the student when the verdict could not be pinned to a source that
  // tests the claim, or when academic mode narrowed the evidence — rather than
  // letting either happen silently.
  const relevanceNotice = makeRelevanceNotice(data);
  if (relevanceNotice) resultsEl.appendChild(relevanceNotice);

  const filterNotice = makeAcademicFilterNotice(data);
  if (filterNotice) resultsEl.appendChild(filterNotice);

  // 4. Supporting evidence
  resultsEl.appendChild(makeEvidenceSection(
    t('results.supporting'),
    Array.isArray(data.supporting_evidence) ? data.supporting_evidence : []
  ));

  // 5. Contradicting evidence
  resultsEl.appendChild(makeEvidenceSection(
    t('results.contradicting'),
    Array.isArray(data.contradicting_evidence) ? data.contradicting_evidence : []
  ));

  // 6. Reflection questions
  const questions = Array.isArray(data.reflection_questions) ? data.reflection_questions : [];
  if (questions.length) {
    const sec = makeSection(t('results.questions'));
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

  // 7b. Context Lens — educational background framing.
  // Skipped when the user turned the Context Lens off for this analysis.
  // (Older results without the _meta flag keep showing it, as before.)
  if (!(data._meta && data._meta.context_lens === false)) {
    resultsEl.appendChild(makeContextLensSection(data.contextLens || data.context_lens));
  }

  // 8. Meta
  appendMeta(data);
}

function appendMeta(data) {
  if (!data._meta) return;
  const parts = [];
  if (data._meta.model) parts.push(t('meta.model', { model: data._meta.model }));
  if (data._meta.searches_used != null) {
    const n = data._meta.searches_used;
    parts.push(t(n === 1 ? 'meta.searchOne' : 'meta.searchOther', { n }));
  }
  if (data._meta.academic_mode) parts.push(t('meta.academicMode'));
  if (data._meta.snapshot) parts.push(t('meta.snapshot'));
  if (parts.length) {
    const meta = el('p', 'meta-row');
    meta.textContent = parts.join(' · ');
    resultsEl.appendChild(meta);
  }
}

/* ── Snapshot summary ──────────────────────────────── */

function makeSnapshotCard(data, isSnapshot) {
  const v = normalizeVerdict(data.verdict);
  const card = el('div', `snapshot-card snapshot-card--${v}`);

  const head = el('div', 'snapshot-card__head');
  const label = el('span', 'snapshot-card__label');
  label.textContent = isSnapshot ? t('snapshot.labelQuick') : t('snapshot.label');
  head.appendChild(label);

  const badges = el('div', 'snapshot-card__badges');
  const badge = el('span', 'verdict-badge');
  badge.textContent = verdictLabel(v);
  badges.appendChild(badge);
  const conf = confidenceValue(data.confidence);
  if (conf) {
    const cpill = el('span', `confidence-pill confidence-pill--${conf}`);
    cpill.textContent = t('confidence.suffix', { level: confidenceLabel(conf) });
    cpill.title = t('confidence.title');
    badges.appendChild(cpill);
  }
  head.appendChild(badges);
  card.appendChild(head);

  if (data.claim_text) {
    const claim = el('p', 'snapshot-card__claim');
    claim.textContent = data.claim_text;
    card.appendChild(claim);
  }

  // Prefer the model's dedicated one-line TL;DR so this card doesn't just repeat
  // the full verdict_explanation shown in the verdict card below. Older results
  // that predate bottom_line fall back to the first sentence of the explanation.
  const takeaway = strOrEmpty(data.bottom_line)
    || firstSentence(data.verdict_explanation)
    || verdictSummaryTitle(v);
  if (takeaway) {
    const t = el('p', 'snapshot-card__takeaway');
    t.textContent = takeaway;
    card.appendChild(t);
  }

  const concern = deriveConcern(data);
  const flag = el('div', `snapshot-flag snapshot-flag--${concern.level}`);
  const ficon = el('span', 'snapshot-flag__icon');
  ficon.setAttribute('aria-hidden', 'true');
  ficon.textContent = { warn: '⚠', note: 'ⓘ' }[concern.level] || '✓';
  const ftext = el('span', 'snapshot-flag__text');
  ftext.textContent = concern.text;
  flag.appendChild(ficon);
  flag.appendChild(ftext);
  card.appendChild(flag);

  const sCount = Array.isArray(data.supporting_evidence) ? data.supporting_evidence.length : 0;
  const cCount = Array.isArray(data.contradicting_evidence) ? data.contradicting_evidence.length : 0;
  const fp = [t('snapshot.footSupporting', { n: sCount }), t('snapshot.footContradicting', { n: cCount })];
  if (data._meta && data._meta.searches_used != null) {
    const n = data._meta.searches_used;
    fp.push(t(n === 1 ? 'meta.searchOne' : 'meta.searchOther', { n }));
  }
  const foot = el('p', 'snapshot-card__foot');
  foot.textContent = fp.join(' · ');
  card.appendChild(foot);

  return card;
}

// The Identity Lens answers two separate questions, and only the second is a
// concern. Results saved before the split carry a single `targets_identity`
// boolean, which conflated them — read it as the targeting answer.
function identityFlags(lens) {
  const l = lens && typeof lens === 'object' ? lens : {};
  const patterns = Array.isArray(l.patterns_observed) ? l.patterns_observed.filter(Boolean) : [];
  const legacy = Boolean(l.targets_identity);
  const targeting = (typeof l.contains_targeting === 'boolean' ? l.contains_targeting : legacy)
    || patterns.length > 0;
  const about = typeof l.about_identity === 'boolean' ? l.about_identity : (legacy || targeting);
  return { about: about || targeting, targeting, patterns };
}

function deriveConcern(data) {
  const { about, targeting } = identityFlags(data.identity_lens);
  if (targeting) {
    return { level: 'warn', text: t('snapshot.identityFlagged') };
  }
  const ctx = data.contextLens || data.context_lens || {};
  const warn = strOrEmpty(ctx.contextWarning);
  if (warn) return { level: 'note', text: warn };
  if (about) return { level: 'note', text: t('snapshot.identityAbout') };
  return { level: 'ok', text: t('snapshot.noConcern') };
}

function makeRunFullButton() {
  const wrap = el('div', 'snapshot-upgrade');
  const note = el('p', 'snapshot-upgrade__note');
  note.textContent = t('snapshot.upgradeNote');
  const btn = el('button', 'btn-primary snapshot-upgrade__btn');
  btn.type = 'button';
  btn.textContent = t('buttons.runFull');
  btn.addEventListener('click', () => rerunAsFull(btn));
  wrap.appendChild(note);
  wrap.appendChild(btn);
  return wrap;
}

function rerunAsFull(btn) {
  if (!lastResult) return;
  snapshotToggle.checked = false;
  if (lastResult.mode === 'url') {
    setInputMode('url');
    urlInput.value = lastResult.url || '';
  } else {
    setInputMode('claim');
    claimInput.value = lastResult.claim || '';
    updateCharCounter();
  }
  academicToggle.checked = Boolean(lastResult.academic);
  btn.disabled = true;
  startCheck();
}

// Work out the Context Lens preference for a saved/shared result: prefer the
// explicit flag, fall back to what the backend recorded, default to on for older
// entries that predate the toggle.
function resolveContextPref(entry, data) {
  if (entry && typeof entry.contextLens === 'boolean') return entry.contextLens;
  if (data && data._meta && typeof data._meta.context_lens === 'boolean') return data._meta.context_lens;
  return true;
}

function confidenceValue(raw) {
  const c = String(raw || '').trim().toLowerCase();
  return (c === 'high' || c === 'medium' || c === 'low') ? c : '';
}

function confidenceLabel(c) {
  return { high: t('confidence.high'), medium: t('confidence.medium'), low: t('confidence.low') }[c] || '';
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

/* ── Evidence match ("close the loop") ─────────────── */

function normalizeMatchStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return (v === 'found' || v === 'partial' || v === 'not_found') ? v : '';
}

// Work out the "evidence located" signal shown in the breakdown. Prefer the
// model's own assessment of whether the required evidence TYPE was found; for
// older results that predate the field, only assert the unambiguous case (no
// sources at all) rather than guessing whether the required type actually matched.
function normalizeEvidenceFound(data) {
  const bd = data.breakdown || {};
  const raw = bd.evidence_found;
  let status = '';
  let note = '';
  if (raw && typeof raw === 'object') {
    status = normalizeMatchStatus(raw.status);
    note = strOrEmpty(raw.note);
  }
  if (!status) {
    const sCount = Array.isArray(data.supporting_evidence) ? data.supporting_evidence.length : 0;
    const cCount = Array.isArray(data.contradicting_evidence) ? data.contradicting_evidence.length : 0;
    if (sCount + cCount === 0 && strOrEmpty(bd.evidence_required)) status = 'not_found';
    else return null;
  }
  return { status, note };
}

function evidenceMatchLabel(status) {
  return {
    found: t('evidenceMatch.found'),
    partial: t('evidenceMatch.partial'),
    not_found: t('evidenceMatch.notFound'),
  }[status] || '';
}

function makeEvidenceMatch(match) {
  const statusClass = match.status.replace('_', '-'); // not_found -> not-found
  const wrap = el('div', `evidence-match evidence-match--${statusClass}`);

  const head = el('div', 'evidence-match__head');
  const label = el('span', 'evidence-match__label');
  label.textContent = t('results.evidenceLocated');

  const pill = el('span', 'evidence-match__pill');
  const icon = el('span', 'evidence-match__icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = { found: '✓', partial: '~', not_found: '✕' }[match.status] || '';
  const pillText = document.createElement('span');
  pillText.textContent = evidenceMatchLabel(match.status);
  pill.appendChild(icon);
  pill.appendChild(pillText);

  head.appendChild(label);
  head.appendChild(pill);
  wrap.appendChild(head);

  if (match.note) {
    const note = el('p', 'evidence-match__note');
    note.textContent = match.note;
    wrap.appendChild(note);
  }
  return wrap;
}

function makeEvidenceSection(title, items) {
  const sec = makeSection(title);
  if (!items.length) {
    const empty = el('p', 'empty-state');
    empty.textContent = t('results.noneFound');
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
  const rel = normalizeRelevance(item.relevance);
  const li = el('li', `evidence-item${rel && rel !== 'direct' ? ' evidence-item--indirect' : ''}`);

  const summary = el('p', 'evidence-summary');
  summary.textContent = item.summary || '';
  li.appendChild(summary);

  // A source that does not test the claim gets called out where the student
  // reads it, not buried in a badge — filing near-misses as plain supporting or
  // contradicting evidence is what confused the pilot classes.
  if (rel && rel !== 'direct') {
    const flag = el('p', `relevance-flag relevance-flag--${rel}`);
    const label = el('span', 'relevance-flag__label');
    label.textContent = t(`relevance.${rel}`);
    flag.appendChild(label);
    const addresses = strOrEmpty(item.addresses);
    if (addresses) {
      flag.appendChild(document.createTextNode(' '));
      const what = el('span', 'relevance-flag__what');
      what.textContent = addresses;
      flag.appendChild(what);
    }
    li.appendChild(flag);
  }

  const row = el('div', 'evidence-source-row');
  // Two independent signals: what kind of source it is, then how rigorous it is.
  row.appendChild(buildTypeBadge(item.source_type));
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

function makeRelevanceNotice(data) {
  const rel = data._meta && data._meta.relevance;
  if (!rel || !rel.verdict_rests_on_indirect) return null;

  const box = el('div', 'filter-notice filter-notice--relevance');
  const head = el('p', 'filter-notice__head');
  head.textContent = t('relevance.noticeHead');
  box.appendChild(head);

  const body = el('p', 'filter-notice__body');
  body.textContent = t('relevance.noticeBody');
  box.appendChild(body);
  return box;
}

function makeAcademicFilterNotice(data) {
  const removed = data._meta && Array.isArray(data._meta.filtered_sources) ? data._meta.filtered_sources : [];
  if (!removed.length) return null;

  const box = el('div', 'filter-notice');
  const head = el('p', 'filter-notice__head');
  head.textContent = t(removed.length === 1 ? 'filter.headOne' : 'filter.headOther', { n: removed.length });
  box.appendChild(head);

  const body = el('p', 'filter-notice__body');
  body.textContent = t('filter.body');
  box.appendChild(body);

  // Naming the domains is the point — the student can go look at them directly
  // and decide for themselves whether academic mode was right to exclude them.
  const domains = [...new Set(removed.map(r => r && r.domain).filter(Boolean))];
  if (domains.length) {
    const list = el('p', 'filter-notice__domains');
    list.textContent = t('filter.domains', { domains: domains.join(', ') });
    box.appendChild(list);
  }
  return box;
}

// Source types share a colour family by character: scholarly evidence, official
// bodies, reporting, then interested parties. Grouping them this way lets a
// student see the shape of the evidence base without reading every label.
const SOURCE_TYPE_GROUPS = {
  peer_reviewed: 'scholarly',
  preprint: 'scholarly',
  academic_institution: 'scholarly',
  government: 'official',
  intergovernmental: 'official',
  news: 'reporting',
  fact_check: 'reporting',
  advocacy: 'interested',
  industry: 'interested',
  other: 'other',
};

function normalizeSourceType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SOURCE_TYPE_GROUPS, t) ? t : '';
}

// Returns '' for results saved before relevance existed, so they render exactly
// as they always did rather than picking up a label nothing actually assessed.
function normalizeRelevance(raw) {
  const r = String(raw || '').trim().toLowerCase();
  return ['direct', 'related', 'background'].includes(r) ? r : '';
}

function buildTypeBadge(rawType) {
  const type = normalizeSourceType(rawType);
  // Results saved before source_type existed simply show no type badge.
  if (!type || type === 'other') return document.createDocumentFragment();
  const span = el('span', `srctype srctype--${SOURCE_TYPE_GROUPS[type]}`);
  span.textContent = t(`sourceType.${type}`);
  span.title = t(`sourceType.title.${type}`);
  return span;
}

function buildCredBadge(rawTier) {
  const tier = normalizeTier(rawTier);
  const labels = {
    high: t('credibility.high'), medium: t('credibility.medium'),
    low: t('credibility.low'), unknown: t('credibility.unknown'),
  };
  const titles = {
    high:    t('credibility.titleHigh'),
    medium:  t('credibility.titleMedium'),
    low:     t('credibility.titleLow'),
    unknown: t('credibility.titleUnknown'),
  };
  const span = el('span', `cred cred--${tier}`);
  span.title = titles[tier];
  span.setAttribute('aria-label', t('credibility.ariaPrefix') + labels[tier]);
  const dot = el('span', 'cred-dot');
  dot.setAttribute('aria-hidden', 'true');
  span.appendChild(dot);
  const label = document.createElement('span');
  label.textContent = labels[tier];
  span.appendChild(label);
  return span;
}

function makeIdentityLensSection(lens) {
  const groups = Array.isArray(lens.identity_groups) ? lens.identity_groups.filter(Boolean) : [];
  const { about, targeting, patterns } = identityFlags(lens);
  const state = targeting ? 'flagged' : (about ? 'about' : 'clean');

  const sec = el('div', `section identity--${state}`);
  const titleEl = el('p', 'section-title');
  titleEl.textContent = t('identity.title');
  sec.appendChild(titleEl);

  const subtitle = el('p', 'identity-subtitle');
  subtitle.textContent = t('identity.subtitle');
  sec.appendChild(subtitle);

  const badge = el('span', 'identity-badge');
  badge.textContent = t(`identity.${state}`);
  sec.appendChild(badge);

  const readout = el('p', 'identity-readout');
  readout.textContent = t('identity.readout', {
    about: t(about ? 'identity.yes' : 'identity.no'),
    targeting: t(targeting ? 'identity.yes' : 'identity.no'),
  });
  sec.appendChild(readout);

  if (lens.analysis) {
    const analysis = el('p', 'identity-analysis');
    analysis.textContent = lens.analysis;
    sec.appendChild(analysis);
  }

  if (groups.length) {
    const sub = el('div', 'identity-subgroup');
    const lbl = el('p', 'identity-sublabel');
    lbl.textContent = t('identity.groups');
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
    lbl.textContent = t('identity.patterns');
    sub.appendChild(lbl);
    const ul = el('ul', 'pattern-list');
    for (const p of patterns) {
      const li = el('li', 'pattern-item');
      const name = el('span', 'pattern-name');
      name.textContent = (p.pattern || t('identity.patternFallback'));
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

  if (targeting && lens.caution_note && String(lens.caution_note).trim()) {
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
  title.textContent = t('context.title');
  const sub = el('span', 'context-lens__subtitle');
  sub.textContent = t('context.subtitle');
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
    fallback.textContent = t('context.fallback');
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
      body.appendChild(makeContextBlock(t('context.background')));
      const p = el('p', 'context-lens__paragraph');
      p.textContent = snapshot;
      body.appendChild(p);
    }

    if (keyContext.length) {
      body.appendChild(makeContextBlock(t('context.key')));
      body.appendChild(makeContextList(keyContext, 'context-lens__list'));
    }

    if (whyMatters) {
      body.appendChild(makeContextBlock(t('context.why')));
      const p = el('p', 'context-lens__paragraph');
      p.textContent = whyMatters;
      body.appendChild(p);
    }

    if (missing.length) {
      body.appendChild(makeContextBlock(t('context.missing')));
      body.appendChild(makeContextList(missing, 'context-lens__list'));
    }

    if (questions.length) {
      body.appendChild(makeContextBlock(t('context.reflection')));
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

// First sentence of a string — used as the summary-card fallback when a result
// has no dedicated bottom_line. The lookahead avoids splitting on decimals
// ("4.5 billion") by only breaking at .!? followed by whitespace or end.
function firstSentence(v) {
  const s = strOrEmpty(v);
  if (!s) return '';
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0].trim() : s;
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
  title.textContent = t('predict.recapTitle');
  sec.appendChild(title);

  const row = el('div', 'predict-recap__row');

  const mine = el('div', 'predict-recap__col');
  const mineLbl = el('span', 'predict-recap__collabel');
  mineLbl.textContent = t('predict.youPredicted');
  const mineChip = el('span', `predict-chip predict-chip--${prediction}`);
  mineChip.textContent = predictionLabel(prediction);
  mine.appendChild(mineLbl);
  mine.appendChild(mineChip);

  const arrow = el('span', 'predict-recap__arrow');
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');

  const ev = el('div', 'predict-recap__col');
  const evLbl = el('span', 'predict-recap__collabel');
  evLbl.textContent = t('predict.evidenceSays');
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
  return { true: t('predict.likelyTrue'), false: t('predict.likelyFalse'), unsure: t('predict.notSure') }[p] || t('predict.notSure');
}

function predictionNote(state, prediction) {
  if (state === 'match') return t('predict.noteMatch');
  if (state === 'mismatch') return t('predict.noteMismatch');
  if (prediction === 'unsure') return t('predict.noteUnsure');
  return t('predict.notePartial');
}

/* ── Sharing ───────────────────────────────────────── */

function makeActionsBar() {
  const bar = el('div', 'results-actions');

  // No share link in Classroom Mode. A share URL carries the full claim and
  // result encoded in the address, which is exactly the kind of student work
  // that should not outlive the session or travel outside the classroom.
  // Export stays: it is generated on demand and stored nowhere.
  if (!CLASSROOM) {
    const shareBtn = el('button', 'btn-share');
    shareBtn.type = 'button';
    shareBtn.textContent = t('buttons.copyShare');
    shareBtn.addEventListener('click', () => onShareClick(shareBtn));
    bar.appendChild(shareBtn);
  }

  const pdfBtn = el('button', 'btn-share btn-export');
  pdfBtn.type = 'button';
  pdfBtn.textContent = t('buttons.exportPdf');
  pdfBtn.addEventListener('click', () => onExportClick('pdf', pdfBtn));
  bar.appendChild(pdfBtn);

  const docxBtn = el('button', 'btn-share btn-export');
  docxBtn.type = 'button';
  docxBtn.textContent = t('buttons.exportWord');
  docxBtn.addEventListener('click', () => onExportClick('docx', docxBtn));
  bar.appendChild(docxBtn);

  return bar;
}

function makeArticleHeader(article) {
  const box = el('div', 'article-header');

  const label = el('span', 'article-header__label');
  label.textContent = t('results.analyzedFrom');
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
    // Export in the language the analysis was generated in (fall back to the
    // active UI language for older records that predate this field).
    language: r.language || (r.data && r.data._meta && r.data._meta.language) || currentLang,
  };
}

async function onExportClick(format, btn) {
  if (!lastResult || !lastResult.data) return;

  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('buttons.exporting');

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
    btn.textContent = t('buttons.exportFailed');
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
    flashBtn(btn, t('buttons.linkFailed'));
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    flashBtn(btn, t('buttons.linkCopied'));
  } catch {
    flashBtn(btn, t('buttons.linkInBar'));
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
  // Classroom Mode ignores shared-result links: a student's tab should show
  // only work done in this session, never a result pasted in from elsewhere.
  if (CLASSROOM) return;

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
  // A shared link carries the language it was analyzed in; show it coherently.
  const sharedLang = window.ccI18n.isSupported(state.language) ? state.language : currentLang;
  if (sharedLang !== currentLang) window.ccI18n.setLang(sharedLang);
  const isUrl = state.mode === 'url' || (!!state.url && !state.claim);
  setInputMode(isUrl ? 'url' : 'claim');
  if (isUrl) {
    urlInput.value = typeof state.url === 'string' ? state.url : '';
  } else {
    claimInput.value = typeof state.claim === 'string' ? state.claim : '';
    updateCharCounter();
  }
  const snapshot = Boolean(state.snapshot || (state.data && state.data._meta && state.data._meta.snapshot));
  const contextLens = resolveContextPref(state, state.data);
  academicToggle.checked = Boolean(state.academic);
  snapshotToggle.checked = snapshot;
  contextToggle.checked = contextLens;
  checkBtn.textContent  = idleButtonLabel();
  currentPrediction     = state.prediction || null;
  if (!state.language) state.language = sharedLang;
  lastResult            = state;
  lastRequest           = { mode: isUrl ? 'url' : 'claim', text: isUrl ? '' : claimInput.value, url: isUrl ? urlInput.value : '', academic: academicToggle.checked, snapshot, contextLens, language: sharedLang };

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
  const key = (v === 'supported' || v === 'contradicted' || v === 'unclear') ? v : 'unclear';
  return t('verdict.' + key + '.label');
}

function verdictSummaryTitle(v) {
  const key = (v === 'supported' || v === 'contradicted' || v === 'unclear') ? v : 'unclear';
  return t('verdict.' + key + '.summary');
}

function normalizeTier(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'unknown';
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
