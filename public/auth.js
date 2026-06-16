'use strict';

/* ClaimCheck website auth + cloud history sync.
   Exposes window.ccAuth for app.js to call. Reuses the same Supabase project
   and claim_checks table as the browser extension, so accounts and history are
   shared across both. */

(function () {
  const $ = (id) => document.getElementById(id);
  const show = (el) => { if (el) el.hidden = false; };
  const hide = (el) => { if (el) el.hidden = true; };

  // ── Header account button ───────────────────────────
  const accountBtn     = $('account-btn');
  const accountIcon    = accountBtn && accountBtn.querySelector('.account-btn__icon');
  const accountInitial = accountBtn && accountBtn.querySelector('.account-btn__initial');

  // ── Modal shell ─────────────────────────────────────
  const modal     = $('auth-modal');
  const closeBtn  = $('auth-close');
  const titleEl   = $('auth-title');
  const signedOut = $('auth-signed-out');
  const signedIn  = $('auth-signed-in');

  // ── Sign in / up form ───────────────────────────────
  const tabSignin   = $('auth-tab-signin');
  const tabSignup   = $('auth-tab-signup');
  const form        = $('auth-form');
  const emailEl     = $('auth-email');
  const passEl      = $('auth-password');
  const confirmField= $('auth-confirm-field');
  const confirmEl   = $('auth-password-confirm');
  const errorEl     = $('auth-error');
  const submitBtn   = $('auth-submit');
  const submitLabel = $('auth-submit-label');
  const submitSpin  = $('auth-submit-spinner');
  const forgotBtn   = $('auth-forgot');
  const googleBtn   = $('auth-google');
  const googleSpin  = $('auth-google-spinner');

  // ── Reset password ──────────────────────────────────
  const resetForm   = $('auth-reset-form');
  const resetEmail  = $('auth-reset-email');
  const resetError  = $('auth-reset-error');
  const resetSubmit = $('auth-reset-submit');
  const resetSpin   = $('auth-reset-spinner');
  const resetBack   = $('auth-reset-back');

  // ── Confirmation sub-views ──────────────────────────
  const confirmNeeded  = $('auth-confirm-needed');
  const confirmEmailEl = $('auth-confirm-email');
  const confirmBack    = $('auth-confirm-back');
  const resetSent      = $('auth-reset-sent');
  const resetSentEmail = $('auth-reset-sent-email');
  const resetSentBack  = $('auth-reset-sent-back');

  // ── Signed-in pane ──────────────────────────────────
  const accountAvatar = $('auth-account-avatar');
  const accountEmail  = $('auth-account-email');
  const signoutBtn    = $('auth-signout');
  const importRow     = $('auth-import-row');
  const importText    = $('auth-import-text');
  const importYes     = $('auth-import-yes');
  const importNo      = $('auth-import-no');

  let currentUser = null;
  let authMode = 'signin';
  const changeListeners = [];

  function sb() { return window.cc && window.cc.supabase; }
  function notifyChange() { for (const cb of changeListeners) { try { cb(currentUser); } catch {} } }

  /* ── Public API used by app.js ─────────────────────── */
  const api = {
    ready: null,
    user: () => currentUser,
    isSignedIn: () => !!currentUser,
    open: () => openModal(),
    onChange: (cb) => { if (typeof cb === 'function') changeListeners.push(cb); },
    saveCheck,
    fetchHistory,
    deleteCheck,
    clearAll,
  };
  window.ccAuth = api;

  api.ready = init();

  async function init() {
    const client = sb();
    if (!client) {
      if (accountBtn) { accountBtn.disabled = true; accountBtn.title = 'Account temporarily unavailable.'; }
      return;
    }
    try { await window.cc.supabaseReady; } catch {}

    const { data } = await client.auth.getUser();
    setUser(data && data.user ? data.user : null, { silent: true });

    client.auth.onAuthStateChange((event, session) => {
      const user = session && session.user ? session.user : null;
      setUser(user);
      if (event === 'SIGNED_IN') maybeOfferImport();
      if (event === 'SIGNED_OUT') { hide(importRow); resetForms(); }
      if (event === 'PASSWORD_RECOVERY') openModal();
    });

    wire();
  }

  /* ── User state + chrome rendering ─────────────────── */
  function setUser(user, { silent = false } = {}) {
    currentUser = user || null;
    renderAccountBtn();
    renderModalPane();
    if (!silent) notifyChange();
  }

  function renderAccountBtn() {
    if (!accountBtn) return;
    if (currentUser) {
      const email = currentUser.email || 'Account';
      const initial = (email.trim().charAt(0) || '?').toUpperCase();
      if (accountIcon) accountIcon.hidden = true;
      if (accountInitial) { accountInitial.hidden = false; accountInitial.textContent = initial; }
      accountBtn.classList.add('account-btn--signed-in');
      accountBtn.setAttribute('aria-label', 'Account — signed in as ' + email);
      accountBtn.title = email;
    } else {
      if (accountIcon) accountIcon.hidden = false;
      if (accountInitial) { accountInitial.hidden = true; accountInitial.textContent = ''; }
      accountBtn.classList.remove('account-btn--signed-in');
      accountBtn.setAttribute('aria-label', 'Sign in or create an account');
      accountBtn.title = 'Sign in or create an account';
    }
  }

  function renderModalPane() {
    if (currentUser) {
      hide(signedOut);
      show(signedIn);
      const email = currentUser.email || '';
      if (accountEmail) accountEmail.textContent = email;
      if (accountAvatar) accountAvatar.textContent = (email.charAt(0) || 'U').toUpperCase();
      if (titleEl) titleEl.textContent = 'Account';
    } else {
      show(signedOut);
      hide(signedIn);
      if (titleEl) titleEl.textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
    }
  }

  /* ── Modal open/close ──────────────────────────────── */
  function openModal() {
    if (!modal) return;
    if (!currentUser) setAuthMode(authMode);
    renderModalPane();
    modal.hidden = false;
    if (accountBtn) accountBtn.setAttribute('aria-expanded', 'true');
    setTimeout(() => { if (!currentUser && emailEl) emailEl.focus(); }, 50);
  }
  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    if (accountBtn) accountBtn.setAttribute('aria-expanded', 'false');
  }

  /* ── Mode switching ────────────────────────────────── */
  function setAuthMode(mode) {
    authMode = mode === 'signup' ? 'signup' : 'signin';
    const isSignup = authMode === 'signup';
    if (tabSignin) tabSignin.classList.toggle('auth-tab--active', !isSignup);
    if (tabSignup) tabSignup.classList.toggle('auth-tab--active', isSignup);
    if (tabSignin) tabSignin.setAttribute('aria-selected', String(!isSignup));
    if (tabSignup) tabSignup.setAttribute('aria-selected', String(isSignup));
    if (submitLabel) submitLabel.textContent = isSignup ? 'Create account' : 'Sign in';
    if (passEl) passEl.autocomplete = isSignup ? 'new-password' : 'current-password';
    if (confirmField) confirmField.hidden = !isSignup;
    if (confirmEl) confirmEl.required = isSignup;
    if (!isSignup && confirmEl) confirmEl.value = '';
    hide(confirmNeeded); hide(resetForm); hide(resetSent);
    show(form);
    if (forgotBtn) forgotBtn.hidden = isSignup;
    if (titleEl) titleEl.textContent = isSignup ? 'Create account' : 'Sign in';
    clearError();
  }

  function resetForms() {
    if (form) { form.reset(); form.hidden = false; }
    if (confirmEl) confirmEl.value = '';
    hide(confirmNeeded); hide(resetSent); hide(resetForm);
    setAuthMode('signin');
    setSubmitLoading(false);
  }

  /* ── Errors + spinners ─────────────────────────────── */
  function clearError() { if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; } }
  function showError(msg) { if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; } }
  function setSubmitLoading(on) { if (submitBtn) submitBtn.disabled = on; if (submitSpin) submitSpin.hidden = !on; }
  function setGoogleLoading(on) { if (googleBtn) googleBtn.disabled = on; if (googleSpin) googleSpin.hidden = !on; }
  function setResetLoading(on) { if (resetSubmit) resetSubmit.disabled = on; if (resetSpin) resetSpin.hidden = !on; }
  function clearResetError() { if (resetError) { resetError.textContent = ''; resetError.hidden = true; } }
  function showResetError(msg) { if (resetError) { resetError.textContent = msg; resetError.hidden = false; } }

  function humanizeError(err) {
    const msg = (err && (err.message || err.error_description)) || String(err);
    if (/Invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
    if (/User already registered/i.test(msg)) return 'An account with that email already exists. Try signing in.';
    if (/Password should be at least/i.test(msg)) return msg;
    if (/Email not confirmed/i.test(msg)) return 'Please confirm your email before signing in.';
    return msg;
  }

  /* ── Submit handlers ───────────────────────────────── */
  async function handleSubmit(e) {
    e.preventDefault();
    const client = sb();
    if (!client) { showError('Auth service unavailable.'); return; }
    const email = (emailEl.value || '').trim();
    const password = passEl.value || '';
    if (!email || !password) { showError('Email and password are required.'); return; }
    if (authMode === 'signup' && password !== (confirmEl.value || '')) {
      showError('Passwords don’t match.');
      confirmEl.focus();
      return;
    }
    clearError();
    setSubmitLoading(true);
    try {
      const cfg = (window.cc && window.cc.supabaseConfig) || {};
      if (authMode === 'signup') {
        const opts = {};
        if (cfg.emailRedirectTo) opts.emailRedirectTo = cfg.emailRedirectTo;
        const { data, error } = await client.auth.signUp({ email, password, options: opts });
        if (error) throw error;
        if (data && data.session) {
          // Logged in immediately (email confirmation disabled).
        } else {
          if (confirmEmailEl) confirmEmailEl.textContent = email;
          hide(form);
          show(confirmNeeded);
        }
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      showError(humanizeError(err));
    } finally {
      setSubmitLoading(false);
    }
  }

  async function handleGoogle() {
    const client = sb();
    if (!client) { showError('Auth service unavailable.'); return; }
    clearError();
    setGoogleLoading(true);
    try {
      const cfg = (window.cc && window.cc.supabaseConfig) || {};
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: cfg.emailRedirectTo || window.location.origin },
      });
      if (error) throw error;
      // Full-page redirect to Google happens here; nothing else to do.
    } catch (err) {
      showError(humanizeError(err));
      setGoogleLoading(false);
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    const client = sb();
    if (!client) { showResetError('Auth service unavailable.'); return; }
    const email = (resetEmail.value || '').trim();
    if (!email) { showResetError('Email is required.'); return; }
    clearResetError();
    setResetLoading(true);
    try {
      const cfg = (window.cc && window.cc.supabaseConfig) || {};
      const opts = {};
      if (cfg.emailRedirectTo) opts.redirectTo = cfg.emailRedirectTo;
      const { error } = await client.auth.resetPasswordForEmail(email, opts);
      if (error) throw error;
      if (resetSentEmail) resetSentEmail.textContent = email;
      hide(resetForm);
      show(resetSent);
    } catch (err) {
      showResetError(humanizeError(err));
    } finally {
      setResetLoading(false);
    }
  }

  function showResetView() {
    hide(form); hide(confirmNeeded); hide(resetSent);
    if (resetEmail) resetEmail.value = emailEl.value || '';
    show(resetForm);
    clearResetError();
    setTimeout(() => resetEmail && resetEmail.focus(), 50);
  }

  async function handleSignOut() {
    const client = sb();
    if (!client) return;
    try { await client.auth.signOut(); } catch (err) { showError(humanizeError(err)); }
  }

  /* ── Local-history import on first sign-in ─────────── */
  function readLocalHistory() {
    try { return JSON.parse(localStorage.getItem('claimcheck_history') || '[]'); } catch { return []; }
  }

  function maybeOfferImport() {
    const local = readLocalHistory();
    if (!Array.isArray(local) || local.length === 0) { hide(importRow); return; }
    if (importText) importText.textContent =
      'Import ' + local.length + ' past check' + (local.length === 1 ? '' : 's') + ' to your account?';
    show(importRow);
    openModal();
  }

  async function handleImport() {
    const client = sb();
    if (!client || !currentUser) return;
    const local = readLocalHistory();
    if (!local.length) { hide(importRow); return; }
    if (importYes) { importYes.disabled = true; importYes.textContent = 'Importing…'; }
    if (importNo) importNo.disabled = true;
    try {
      const rows = local.map((entry) => buildRow(entry));
      if (rows.length) {
        const { error } = await client.from('claim_checks').insert(rows);
        if (error) throw error;
      }
      localStorage.removeItem('claimcheck_history');
      hide(importRow);
      notifyChange();
    } catch (err) {
      showError('Import failed: ' + humanizeError(err));
    } finally {
      if (importYes) { importYes.disabled = false; importYes.textContent = 'Import'; }
      if (importNo) importNo.disabled = false;
    }
  }

  function dismissImport() {
    localStorage.removeItem('claimcheck_history');
    hide(importRow);
    notifyChange();
  }

  /* ── claim_checks persistence ──────────────────────── */
  function buildRow(entry) {
    const r = (entry && entry.data) || {};
    const row = {
      user_id: currentUser ? currentUser.id : null,
      claim_text: r.claim_text || (entry && entry.claim) || '',
      verdict: r.verdict || (entry && entry.verdict) || null,
      explanation: r.verdict_explanation || null,
      source_url: null,
      sources: {
        breakdown: r.breakdown || null,
        supporting_evidence: Array.isArray(r.supporting_evidence) ? r.supporting_evidence : [],
        contradicting_evidence: Array.isArray(r.contradicting_evidence) ? r.contradicting_evidence : [],
        reflection_questions: Array.isArray(r.reflection_questions) ? r.reflection_questions : [],
        identity_lens: r.identity_lens || null,
        context_lens: r.contextLens || r.context_lens || null,
        uncertainty_notes: r.uncertainty_notes || null,
        meta: r._meta || null,
        // Website-specific extras (ignored by the extension):
        input_text: (entry && entry.claim) || '',
        prediction: (entry && entry.prediction) || null,
        academic: !!(entry && entry.academic),
      },
      confidence_score: null,
    };
    if (entry && entry.timestamp) row.created_at = new Date(entry.timestamp).toISOString();
    return row;
  }

  function rowToEntry(row) {
    const s = row.sources || {};
    return {
      id: row.id,
      timestamp: row.created_at ? Date.parse(row.created_at) : Date.now(),
      claim: s.input_text || row.claim_text || '',
      claim_text: row.claim_text || '',
      verdict: (row.verdict || 'unclear'),
      academic: !!s.academic,
      prediction: s.prediction || null,
      data: {
        claim_text: row.claim_text,
        verdict: row.verdict,
        verdict_explanation: row.explanation,
        breakdown: s.breakdown || {},
        supporting_evidence: s.supporting_evidence || [],
        contradicting_evidence: s.contradicting_evidence || [],
        reflection_questions: s.reflection_questions || [],
        identity_lens: s.identity_lens || null,
        contextLens: s.context_lens || null,
        uncertainty_notes: s.uncertainty_notes || null,
        _meta: s.meta || null,
      },
      _cloud: true,
    };
  }

  async function saveCheck(entry) {
    const client = sb();
    if (!client || !currentUser) return { ok: false, reason: 'signed_out' };
    try {
      const { error } = await client.from('claim_checks').insert(buildRow(entry));
      if (error) throw error;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'error', message: humanizeError(err) };
    }
  }

  async function fetchHistory() {
    const client = sb();
    if (!client || !currentUser) return [];
    const { data, error } = await client
      .from('claim_checks')
      .select('id, created_at, claim_text, verdict, explanation, source_url, sources, confidence_score')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data || []).map(rowToEntry);
  }

  async function deleteCheck(id) {
    const client = sb();
    if (!client || !currentUser) return;
    const { error } = await client.from('claim_checks').delete().eq('id', id);
    if (error) throw error;
  }

  async function clearAll() {
    const client = sb();
    if (!client || !currentUser) return;
    const { error } = await client.from('claim_checks').delete().eq('user_id', currentUser.id);
    if (error) throw error;
  }

  /* ── Event wiring ──────────────────────────────────── */
  function wire() {
    if (accountBtn) accountBtn.addEventListener('click', () => {
      if (modal && modal.hidden) openModal(); else closeModal();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) closeModal(); });

    if (tabSignin) tabSignin.addEventListener('click', () => setAuthMode('signin'));
    if (tabSignup) tabSignup.addEventListener('click', () => setAuthMode('signup'));
    if (form) form.addEventListener('submit', handleSubmit);
    if (googleBtn) googleBtn.addEventListener('click', handleGoogle);
    if (forgotBtn) forgotBtn.addEventListener('click', showResetView);
    if (resetForm) resetForm.addEventListener('submit', handleReset);
    if (resetBack) resetBack.addEventListener('click', () => setAuthMode('signin'));
    if (resetSentBack) resetSentBack.addEventListener('click', () => setAuthMode('signin'));
    if (confirmBack) confirmBack.addEventListener('click', () => setAuthMode('signin'));
    if (signoutBtn) signoutBtn.addEventListener('click', handleSignOut);
    if (importYes) importYes.addEventListener('click', handleImport);
    if (importNo) importNo.addEventListener('click', dismissImport);
  }
})();
