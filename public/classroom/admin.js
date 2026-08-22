'use strict';

/* Teacher / administrator classroom dashboard.
 *
 * Authentication reuses the existing ClaimCheck Supabase project and the same
 * session storage key the main site uses, so a teacher already signed in there
 * arrives here signed in. This page only ever holds the user's access token in
 * memory long enough to attach it to a request.
 *
 * Every mutation goes through the ClaimCheck backend rather than straight to
 * the database: access codes need server-side randomness, and budgets and
 * ownership need to be enforced somewhere a browser cannot reach.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const views = {
    loading: $('view-loading'),
    signin: $('view-signin'),
    denied: $('view-denied'),
    dashboard: $('view-dashboard'),
  };

  const emailLabel = $('admin-email');
  const signoutBtn = $('signout-btn');
  const signinForm = $('signin-form');
  const signinError = $('signin-error');
  const signinBtn = $('signin-btn');
  const createForm = $('create-form');
  const createBtn = $('create-btn');
  const createError = $('create-error');
  const roomsEl = $('rooms');

  function showView(name) {
    for (const [key, el] of Object.entries(views)) {
      if (el) el.hidden = key !== name;
    }
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }

  function clearError(el) {
    el.textContent = '';
    el.hidden = true;
  }

  /* ── Supabase session ─────────────────────────────── */

  function sb() {
    return window.cc && window.cc.supabase;
  }

  /** The current access token, or '' when signed out. */
  async function accessToken() {
    const client = sb();
    if (!client) return '';
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.access_token) || '';
  }

  /* ── Backend calls ────────────────────────────────── */

  /**
   * Calls the classroom API with the teacher's bearer token.
   *
   * The token proves who the caller is; the server independently decides what
   * they may do. Nothing here is trusted to gate anything on its own — hiding a
   * button is a courtesy, not a control.
   */
  async function api(path, options = {}) {
    const token = await accessToken();
    const res = await fetch(`/api/classroom${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let data = {};
    try { data = await res.json(); } catch { /* some responses have no body */ }

    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ── Rendering ────────────────────────────────────── */

  const numberFmt = new Intl.NumberFormat();

  function formatWhen(iso) {
    const when = new Date(iso);
    const sameDay = when.toDateString() === new Date().toDateString();
    return sameDay
      ? `today at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function joinLink(room) {
    return `${window.location.origin}/classroom/${room.accessCode}`;
  }

  function renderRooms(rooms) {
    roomsEl.textContent = '';

    if (!rooms.length) {
      roomsEl.appendChild(el('div', 'card cc-empty', 'No classrooms yet. Create one above to get started.'));
      return;
    }

    for (const room of rooms) {
      roomsEl.appendChild(renderRoom(room));
    }
  }

  function renderRoom(room) {
    const live = room.usable;
    const card = el('div', `card cc-room${live ? '' : ' cc-room--inactive'}`);

    // Head
    const head = el('div', 'cc-room__head');
    head.appendChild(el('span', 'cc-room__name', room.displayName || 'Untitled classroom'));
    const status = el('span', `cc-room__status cc-room__status--${live ? 'live' : 'ended'}`);
    status.textContent = live ? 'Open' : room.expired ? 'Expired' : !room.active ? 'Closed' : 'Allowance used';
    head.appendChild(status);
    head.appendChild(el('span', 'cc-banner__stat', live ? `Ends ${formatWhen(room.expiresAt)}` : `Ended ${formatWhen(room.expiresAt)}`));
    card.appendChild(head);

    // Code + link
    if (live) {
      const codeBox = el('div', 'cc-code-display');
      codeBox.appendChild(el('span', 'cc-code-value', room.accessCode));
      const side = el('div', 'cc-code-side');
      side.appendChild(el('span', '', 'Or share this link:'));
      side.appendChild(el('code', '', joinLink(room)));
      codeBox.appendChild(side);
      card.appendChild(codeBox);
    }

    // Whole-class stats. There is deliberately no per-student breakdown here,
    // because none is collected.
    const stats = el('div', 'cc-stats');
    const used = room.tokensUsed;
    const pct = room.tokenBudget ? Math.round((used / room.tokenBudget) * 100) : 0;
    for (const [label, value] of [
      ['Allowance used', `${numberFmt.format(used)} (${pct}%)`],
      ['Remaining', numberFmt.format(room.tokensRemaining)],
      ['Analyses run', numberFmt.format(room.analysesRun)],
      ['Searches', numberFmt.format(room.searchesUsed)],
      // Claim counts, the quota students are actually measured against. Still a
      // whole-class figure: there is no per-student breakdown here, because
      // linking usage back to a person is exactly what the anonymous id is
      // designed to make impossible.
      ['ClaimChecks used', room.effectiveClaimLimit
        ? `${numberFmt.format(room.claimsUsed)} of ${numberFmt.format(room.effectiveClaimLimit)}`
        : numberFmt.format(room.claimsUsed)],
      ['Per student', room.effectiveClaimLimitPerStudent
        ? numberFmt.format(room.effectiveClaimLimitPerStudent)
        : 'Unlimited'],
    ]) {
      const stat = el('div', 'cc-stat');
      stat.appendChild(el('div', 'cc-stat__label', label));
      stat.appendChild(el('div', 'cc-stat__value', value));
      stats.appendChild(stat);
    }
    card.appendChild(stats);

    // Actions
    const actions = el('div', 'cc-room__actions');

    if (live) {
      actions.appendChild(button('Copy code', async (btn) => {
        await copy(room.accessCode, btn, 'Copied');
      }));
      actions.appendChild(button('Copy join link', async (btn) => {
        await copy(joinLink(room), btn, 'Copied');
      }));
      actions.appendChild(button('New code', async () => {
        if (!confirm('Issue a new code?\n\nThe current code stops working and every student currently in this classroom will be returned to the join page.')) return;
        await api(`/rooms/${room.id}/regenerate`, { method: 'POST' });
        await refresh();
      }));
      actions.appendChild(button('Close now', async () => {
        if (!confirm('Close this classroom?\n\nStudents will be removed immediately and the code will stop working.')) return;
        await api(`/rooms/${room.id}`, { method: 'PATCH', body: { active: false } });
        await refresh();
      }));
    }

    const del = button('Delete', async () => {
      if (!confirm('Delete this classroom permanently?\n\nIts settings and usage totals will be removed. This cannot be undone.')) return;
      await api(`/rooms/${room.id}`, { method: 'DELETE' });
      await refresh();
    });
    del.classList.add('cc-btn--danger');
    actions.appendChild(del);

    card.appendChild(actions);
    return card;
  }

  function button(label, handler) {
    const btn = el('button', 'cc-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await handler(btn);
      } catch (err) {
        alert(err.message || 'That did not work. Please try again.');
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  async function copy(text, btn, doneLabel) {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = doneLabel;
    } catch {
      // Clipboard access can be denied; showing the value lets the teacher copy it.
      window.prompt('Copy this:', text);
      return;
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  }

  /* ── Data ─────────────────────────────────────────── */

  async function refresh() {
    const { classrooms } = await api('/rooms');
    renderRooms(classrooms);
  }

  /* ── Boot ─────────────────────────────────────────── */

  async function boot() {
    const client = sb();
    if (!client) {
      showView('signin');
      showError(signinError, 'Sign-in is unavailable on this server.');
      return;
    }

    try { await window.cc.supabaseReady; } catch { /* fall through to getUser */ }

    const { data } = await client.auth.getUser();
    const user = data && data.user;

    if (!user) {
      showView('signin');
      signoutBtn.hidden = true;
      emailLabel.textContent = '';
      return;
    }

    emailLabel.textContent = user.email || '';
    signoutBtn.hidden = false;

    // The server decides whether this account may manage classrooms.
    let status;
    try {
      status = await api('/me');
    } catch (err) {
      showView('signin');
      showError(signinError, err.message);
      return;
    }

    if (!status.educator) {
      showView('denied');
      return;
    }

    showView('dashboard');
    try {
      await refresh();
    } catch (err) {
      showError(createError, err.message);
    }
  }

  /* ── Events ───────────────────────────────────────── */

  signinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const client = sb();
    if (!client) return;

    clearError(signinError);
    signinBtn.disabled = true;
    signinBtn.textContent = 'Signing in…';

    try {
      const { error } = await client.auth.signInWithPassword({
        email: $('signin-email').value.trim(),
        password: $('signin-password').value,
      });
      if (error) throw error;
      showView('loading');
      await boot();
    } catch (err) {
      showError(signinError, /Invalid login credentials/i.test(err.message || '')
        ? 'That email or password is not correct.'
        : err.message || 'Could not sign in.');
    } finally {
      signinBtn.disabled = false;
      signinBtn.textContent = 'Sign in';
    }
  });

  signoutBtn.addEventListener('click', async () => {
    const client = sb();
    if (client) await client.auth.signOut();
    window.location.reload();
  });

  /** Blank field -> null (use the default); anything else -> a number. */
  function optionalCount(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(createError);
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';

    try {
      const minutes = Number($('create-duration').value);
      await api('/rooms', {
        method: 'POST',
        body: {
          displayName: $('create-name').value.trim(),
          tokenBudget: Number($('create-budget').value),
          expiresAt: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
          // Empty means "unset" rather than zero — the backend reads null as
          // "fall back to the server default", and zero as "no limit".
          claimLimitPerStudent: optionalCount($('create-per-student').value),
          expectedStudents: optionalCount($('create-expected').value),
        },
      });
      $('create-name').value = '';
      $('create-per-student').value = '';
      $('create-expected').value = '';
      await refresh();
    } catch (err) {
      showError(createError, err.message);
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Create classroom';
    }
  });

  boot();
})();
