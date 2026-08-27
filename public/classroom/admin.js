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
    status.textContent = live ? 'Open'
      : room.expired ? 'Expired'
      : !room.active ? 'Closed'
      // A stopped-but-open classroom ran out of one of two things, and they
      // mean opposite things to a teacher: the class finished its ClaimChecks,
      // or something consumed far more than it should have.
      : room.tokensExhausted ? 'Paused (safety limit)'
      : 'ClaimChecks used';
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

    // Whole-class stats, led by the number the classroom is actually measured
    // in. There is deliberately no per-student breakdown here, because none is
    // collected — linking usage back to a person is exactly what the anonymous
    // per-classroom id is designed to make impossible.
    //
    // "Analyses run" used to sit alongside "ClaimChecks used" showing the same
    // thing counted twice. A failed analysis now returns its ClaimCheck, so the
    // two are the same number by construction and only one is shown.
    const stats = el('div', 'cc-stats');
    for (const [label, value] of [
      // Every classroom has a finite allowance, so each of these is always a
      // real number. There is no "Unlimited" to render.
      ['ClaimChecks used',
        `${numberFmt.format(room.claimsUsed)} of ${numberFmt.format(room.effectiveClaimLimit)}`],
      ['Remaining', numberFmt.format(room.claimsRemaining)],
      ['Per student', numberFmt.format(room.effectiveClaimLimitPerStudent)],
      ['Allowance', room.allowanceMode === 'custom'
        ? 'Custom total'
        : `${numberFmt.format(room.expectedStudents || formLimits.defaultExpectedStudents)} × ` +
          `${numberFmt.format(room.effectiveClaimLimitPerStudent)}`],
      ['Searches', numberFmt.format(room.searchesUsed)],
    ]) {
      const stat = el('div', 'cc-stat');
      stat.appendChild(el('div', 'cc-stat__label', label));
      stat.appendChild(el('div', 'cc-stat__value', value));
      stats.appendChild(stat);
    }
    card.appendChild(stats);

    // A classroom whose allowance was lowered below what it had already used.
    // "37 of 30 used" is arithmetic a teacher should not have to interpret, and
    // it means something quite specific: nothing was lost, nothing more can
    // start.
    if (room.overCapacity) {
      const notice = el('div', 'cc-internal cc-internal--alert');
      notice.appendChild(el('strong', '', 'Allowance is below usage. '));
      notice.appendChild(document.createTextNode(
        `This classroom has already completed ${numberFmt.format(room.claimsUsed)} ClaimChecks, ` +
        `more than its current allowance of ${numberFmt.format(room.effectiveClaimLimit)}. ` +
        'No further ClaimChecks can be started. Work already done is unaffected — ' +
        'raise the allowance to let the class continue.'
      ));
      card.appendChild(notice);
    }

    card.appendChild(internalUsageNote(room));

    // Actions
    const actions = el('div', 'cc-room__actions');

    // Editable while the classroom is still open. An expired one is not: the
    // server refuses it, and offering a control that always fails is worse than
    // not offering it. Appended below the actions once they are all built.
    let panel = null;
    if (!room.expired && room.active) {
      panel = editPanel(room, refresh);
      const toggle = el('button', 'cc-btn cc-btn--primary-ghost cc-edit-toggle', 'Edit session');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
      });
      actions.appendChild(toggle);
    }

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
    if (panel) card.appendChild(panel);
    return card;
  }

  /** '53.9k' — a token count at a glance, without asking anyone to read seven digits. */
  function compactTokens(n) {
    const value = Number(n) || 0;
    if (value < 1000) return String(value);
    if (value < 1000000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${(value / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }

  /**
   * A secondary line reporting what the classroom cost internally.
   *
   * Demoted from the headline metric on purpose. Tokens are a cost control, not
   * an allowance, and a teacher asked to interpret "53,856 (108%)" has been
   * handed a number that does not answer the question they have — which is how
   * many more ClaimChecks their class can run.
   *
   * It stays visible rather than disappearing entirely, because when the safety
   * ceiling does fire this is the only line on the page that explains why.
   */
  function internalUsageNote(room) {
    const note = el('div', 'cc-internal');

    if (room.tokensExhausted) {
      note.classList.add('cc-internal--alert');
      note.appendChild(el('strong', '', 'Internal safety limit reached. '));
      note.appendChild(document.createTextNode(
        'This classroom used far more resources than its ClaimChecks should need, so ClaimCheck paused it. ' +
        'Its ClaimCheck allowance was not the limit that stopped it. Contact your administrator.'
      ));
      return note;
    }

    note.appendChild(el('span', 'cc-internal__label', 'Internal usage'));
    note.appendChild(document.createTextNode(
      ` ${compactTokens(room.tokensUsed)} tokens of ` +
      `${compactTokens(room.tokenSafetyLimit)} internal ceiling`
    ));
    return note;
  }

  /* ── Editing a running classroom ──────────────────────────────────
   *
   * Built as an inline panel on the card rather than a modal: a teacher
   * editing a live session needs the current usage visible while they choose
   * new numbers, and a modal covers exactly that.
   *
   * Nothing here enforces anything. Every value is re-validated by the server,
   * which is the only thing that decides. What this does is show the
   * consequence of a change BEFORE it is saved — particularly a reduction,
   * which stops the class immediately and should never be a surprise.
   */

  const pad = (n) => String(n).padStart(2, '0');

  /** ISO timestamp -> the value a datetime-local input wants, in local time. */
  function toLocalInput(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
           `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function field(labelText, control, help) {
    const wrap = el('div', 'cc-field');
    const label = el('label', 'cc-field__label', labelText);
    wrap.appendChild(label);
    wrap.appendChild(control);
    if (help) wrap.appendChild(el('span', 'cc-field__help', help));
    return wrap;
  }

  function numberInput(className, value, { min, max }) {
    const input = el('input', className);
    // setAttribute rather than the properties: the browser reflects `.min` to
    // the attribute, but the DOM used in tests does not, and the bound has to be
    // in the markup for the browser's own validation to apply it.
    input.setAttribute('type', 'number');
    input.setAttribute('min', String(min));
    input.setAttribute('max', String(max));
    input.setAttribute('step', '1');
    if (value !== null && value !== undefined) input.value = String(value);
    return input;
  }

  /**
   * The edit panel for one classroom.
   *
   * `room` is the ownerView the dashboard already has, so the form opens
   * showing what the classroom is actually set to right now.
   */
  function editPanel(room, onSaved) {
    const form = el('form', 'cc-edit');
    form.hidden = true;

    const expected = numberInput('cc-edit__expected', room.expectedStudents, {
      min: formLimits.minExpectedStudents, max: formLimits.maxExpectedStudents,
    });
    expected.placeholder = String(formLimits.defaultExpectedStudents);

    const perStudent = numberInput('cc-edit__per-student', room.claimLimitPerStudent, {
      min: formLimits.minClaimsPerStudent, max: formLimits.maxClaimsPerStudent,
    });
    perStudent.placeholder = String(formLimits.defaultClaimsPerStudent);

    const row = el('div', 'cc-field-row');
    row.appendChild(field('Expected students', expected, 'A count only — never a list of names.'));
    row.appendChild(field(
      'ClaimChecks per student',
      perStudent,
      `${formLimits.minClaimsPerStudent}–${formLimits.maxClaimsPerStudent}. Applies to students already in the room.`
    ));
    form.appendChild(row);

    /* ── Allowance mode ── */
    const modeName = `mode-${room.id}`;
    const autoRadio = el('input');
    autoRadio.type = 'radio';
    autoRadio.name = modeName;
    autoRadio.className = 'cc-edit__mode-auto';
    autoRadio.value = 'automatic';
    const customRadio = el('input');
    customRadio.type = 'radio';
    customRadio.name = modeName;
    customRadio.className = 'cc-edit__mode-custom';
    customRadio.value = 'custom';
    if (room.allowanceMode === 'custom') customRadio.checked = true;
    else autoRadio.checked = true;

    const customTotal = numberInput('cc-edit__custom-total',
      room.allowanceMode === 'custom' ? room.effectiveClaimLimit : null,
      { min: 1, max: MAX_CUSTOM });
    customTotal.placeholder = 'e.g. 3';

    const modeBox = el('fieldset', 'cc-edit__modes');
    modeBox.appendChild(el('legend', 'cc-field__label', 'Allowance'));

    const autoLabel = el('label', 'cc-edit__mode');
    autoLabel.appendChild(autoRadio);
    autoLabel.appendChild(el('span', '', 'Automatic'));
    const autoHint = el('span', 'cc-edit__mode-hint');
    autoLabel.appendChild(autoHint);
    modeBox.appendChild(autoLabel);

    const customLabel = el('label', 'cc-edit__mode');
    customLabel.appendChild(customRadio);
    customLabel.appendChild(el('span', '', 'Custom total'));
    customLabel.appendChild(customTotal);
    customLabel.appendChild(el('span', 'cc-edit__mode-hint', `Whole class, max ${MAX_CUSTOM}`));
    modeBox.appendChild(customLabel);
    form.appendChild(modeBox);

    /* ── Closing time ── */
    const closesAt = el('input', 'cc-edit__closes-at');
    closesAt.type = 'datetime-local';
    closesAt.value = toLocalInput(room.expiresAt);

    const extendRow = el('div', 'cc-edit__extend');
    for (const [label, minutes] of [['+15 min', 15], ['+30 min', 30], ['+1 hour', 60]]) {
      const b = el('button', 'cc-btn cc-btn--tiny', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        const from = new Date(closesAt.value || room.expiresAt);
        closesAt.value = toLocalInput(new Date(from.getTime() + minutes * 60000).toISOString());
        renderPreview();
      });
      extendRow.appendChild(b);
    }
    const closeField = field('Classroom closes at', closesAt,
      'An absolute time, so extending twice does not double-count. Between 5 minutes and 30 days from now.');
    closeField.appendChild(extendRow);
    form.appendChild(closeField);

    /* ── Live preview ── */
    const preview = el('p', 'cc-edit__preview');
    preview.setAttribute('aria-live', 'polite');
    form.appendChild(preview);

    const error = el('div', 'cc-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    form.appendChild(error);

    /** The capacity the current form values would produce. */
    function plannedCapacity() {
      if (customRadio.checked) {
        const n = optionalCount(customTotal.value);
        if (typeof n !== 'number' || n < 1 || n > MAX_CUSTOM) return null;
        return n;
      }
      const students = optionalCount(expected.value);
      const each = optionalCount(perStudent.value);
      const s = typeof students === 'number' ? students : formLimits.defaultExpectedStudents;
      const e = typeof each === 'number' ? each : formLimits.defaultClaimsPerStudent;
      if (!inFormRange(s, formLimits.minExpectedStudents, formLimits.maxExpectedStudents)) return null;
      if (!inFormRange(e, formLimits.minClaimsPerStudent, formLimits.maxClaimsPerStudent)) return null;
      return Math.round((s * e * formLimits.headroomPercent) / 100);
    }

    function renderPreview() {
      const used = room.claimsUsed;
      const students = optionalCount(expected.value);
      const each = optionalCount(perStudent.value);
      const s = typeof students === 'number' ? students : formLimits.defaultExpectedStudents;
      const e = typeof each === 'number' ? each : formLimits.defaultClaimsPerStudent;
      autoHint.textContent = `${plural(s, 'student')} × ${plural(e, 'ClaimCheck')} = ` +
                             `${numberFmt.format(Math.round((s * e * formLimits.headroomPercent) / 100))} total`;
      customTotal.disabled = !customRadio.checked;

      const capacity = plannedCapacity();
      if (capacity === null) {
        preview.className = 'cc-edit__preview cc-edit__preview--warn';
        preview.textContent = customRadio.checked
          ? `Enter a custom total between 1 and ${MAX_CUSTOM} ClaimChecks.`
          : `Check the class size (${formLimits.minExpectedStudents}–${formLimits.maxExpectedStudents}) ` +
            `and ClaimChecks per student (${formLimits.minClaimsPerStudent}–${formLimits.maxClaimsPerStudent}).`;
        return;
      }

      if (capacity < used) {
        preview.className = 'cc-edit__preview cc-edit__preview--warn';
        preview.textContent =
          `New capacity: ${plural(capacity, 'ClaimCheck')}. ${numberFmt.format(used)} already used — ` +
          'this classroom will stop accepting new ClaimChecks immediately. Work already done is kept.';
        return;
      }

      preview.className = 'cc-edit__preview';
      preview.textContent =
        `New capacity: ${plural(capacity, 'ClaimCheck')}. ` +
        `${numberFmt.format(used)} already used, ${numberFmt.format(capacity - used)} remaining.`;
    }

    for (const control of [expected, perStudent, customTotal]) {
      control.addEventListener('input', renderPreview);
    }
    for (const control of [autoRadio, customRadio]) {
      control.addEventListener('change', renderPreview);
    }
    closesAt.addEventListener('input', renderPreview);
    renderPreview();

    /* ── Actions ── */
    const actions = el('div', 'cc-edit__actions');
    const save = el('button', 'btn-primary cc-edit__save', 'Save changes');
    save.type = 'submit';
    const cancel = el('button', 'cc-btn cc-edit__cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { form.hidden = true; });
    actions.appendChild(save);
    actions.appendChild(cancel);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError(error);

      const capacity = plannedCapacity();
      if (capacity === null) { showError(error, preview.textContent); return; }

      // The one change worth stopping to confirm: it ends the class's ability
      // to start anything new, the moment it saves.
      if (capacity < room.claimsUsed) {
        const ok = window.confirm(
          `${room.claimsUsed} ClaimChecks have already been used. Setting the allowance to ` +
          `${capacity} will immediately stop new analyses. Continue?`
        );
        if (!ok) return;
      }

      const closing = new Date(closesAt.value);
      if (Number.isNaN(closing.getTime())) {
        showError(error, 'Enter a valid closing time.');
        return;
      }

      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        await api(`/rooms/${room.id}`, {
          method: 'PATCH',
          body: {
            expectedStudents: forRequest(optionalCount(expected.value)),
            claimLimitPerStudent: forRequest(optionalCount(perStudent.value)),
            allowanceMode: customRadio.checked ? 'custom' : 'automatic',
            customClaimLimit: customRadio.checked ? forRequest(optionalCount(customTotal.value)) : undefined,
            expiresAt: closing.toISOString(),
          },
        });
        form.hidden = true;
        await onSaved();
      } catch (err) {
        showError(error, err.message);
      } finally {
        save.disabled = false;
        save.textContent = 'Save changes';
      }
    });

    return form;
  }

  const MAX_CUSTOM = 150;
  const inFormRange = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;

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

    // The server's own defaults and bounds, so the capacity this form previews
    // is the capacity the server will compute.
    applyFormLimits(status.limits);

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

  /**
   * Blank field -> null (use the default); a number -> that number;
   * anything unparseable -> 'invalid'.
   *
   * Negatives and zero come back as themselves rather than as null, so the
   * capacity preview can say why they are wrong. Collapsing them into "blank"
   * would show a teacher the default capacity for a value the server is about
   * to reject.
   */
  function optionalCount(raw) {
    const trimmed = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.floor(n) : 'invalid';
  }

  /** null and 'invalid' both mean "do not send a number"; null means "use the default". */
  const forRequest = (v) => (typeof v === 'number' ? v : null);

  /* ── Capacity readout ─────────────────────────────── */

  // Defaults and bounds come from the server (GET /api/classroom/me), so the
  // capacity this form prints is computed from the same numbers the server will
  // use. They were hardcoded here once; a number that lives in two places is a
  // number that eventually disagrees with itself, and that is precisely the bug
  // this whole feature exists to fix.
  //
  // The values below are only the fallback for a page that loaded before the
  // request returned. Nothing is enforced here — the server re-validates every
  // field it is sent, and a value this form would accept can still be refused.
  let formLimits = {
    defaultExpectedStudents: 25,
    defaultClaimsPerStudent: 4,
    minExpectedStudents: 1,
    maxExpectedStudents: 1000,
    minClaimsPerStudent: 1,
    maxClaimsPerStudent: 20,
    headroomPercent: 100,
  };

  /** Applies the server's numbers to the form's placeholders and input bounds. */
  function applyFormLimits(next) {
    if (!next) return;
    formLimits = { ...formLimits, ...next };

    if (expectedInput) {
      expectedInput.placeholder = String(formLimits.defaultExpectedStudents);
      expectedInput.min = String(formLimits.minExpectedStudents);
      expectedInput.max = String(formLimits.maxExpectedStudents);
    }
    if (perStudentInput) {
      perStudentInput.placeholder = String(formLimits.defaultClaimsPerStudent);
      perStudentInput.min = String(formLimits.minClaimsPerStudent);
      perStudentInput.max = String(formLimits.maxClaimsPerStudent);
    }
    renderCapacity();
  }

  const capacitySummary = $('create-capacity-summary');
  const expectedInput = $('create-expected');
  const perStudentInput = $('create-per-student');
  const capacitySelect = $('create-capacity');

  function plural(n, word) {
    return `${numberFmt.format(n)} ${word}${n === 1 ? '' : 's'}`;
  }

  /**
   * Shows the teacher what they are about to promise their class.
   *
   * Reads placeholders as real values when a field is blank, because that is
   * what the server will do with it — a form that showed nothing until both
   * boxes were filled would hide the default rather than explain it.
   */
  function renderCapacity() {
    if (!capacitySummary) return;

    const expected = optionalCount(expectedInput.value);
    const perStudent = optionalCount(perStudentInput.value);
    const fixed = optionalCount(capacitySelect.value);

    const inRange = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;

    // An out-of-range entry is called out here rather than silently previewing
    // a capacity the server would refuse. There is no longer any value that
    // means "unlimited": 0 is a validation error, not a way to remove the cap.
    if (perStudent !== null
        && !inRange(perStudent, formLimits.minClaimsPerStudent, formLimits.maxClaimsPerStudent)) {
      capacitySummary.textContent =
        `ClaimChecks per student must be between ${formLimits.minClaimsPerStudent} and ` +
        `${formLimits.maxClaimsPerStudent}. Leave it blank for the default of ` +
        `${formLimits.defaultClaimsPerStudent}.`;
      return;
    }
    if (expected !== null
        && !inRange(expected, formLimits.minExpectedStudents, formLimits.maxExpectedStudents)) {
      capacitySummary.textContent =
        `Expected class size must be between ${formLimits.minExpectedStudents} and ` +
        `${formLimits.maxExpectedStudents}. Leave it blank for the default of ` +
        `${formLimits.defaultExpectedStudents}.`;
      return;
    }

    const students = expected === null ? formLimits.defaultExpectedStudents : expected;
    const each = perStudent === null ? formLimits.defaultClaimsPerStudent : perStudent;

    if (fixed !== null) {
      capacitySummary.textContent =
        `Classroom capacity: ${plural(fixed, 'ClaimCheck')} shared by the class, ` +
        `up to ${plural(each, 'ClaimCheck')} per student.`;
      return;
    }

    const total = Math.round((students * each * formLimits.headroomPercent) / 100);
    const assumed = [];
    if (expected === null) assumed.push(`${formLimits.defaultExpectedStudents} students`);
    if (perStudent === null) assumed.push(`${formLimits.defaultClaimsPerStudent} per student`);

    capacitySummary.textContent =
      `${plural(students, 'student')} × ${plural(each, 'ClaimCheck')} — ` +
      `classroom capacity: ${plural(total, 'ClaimCheck')}.` +
      (assumed.length ? ` Using the default ${assumed.join(' and ')}.` : '');
  }

  for (const input of [expectedInput, perStudentInput, capacitySelect]) {
    if (input) input.addEventListener('input', renderCapacity);
  }
  renderCapacity();

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(createError);
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';

    try {
      // Client-side pre-check. A courtesy, not a control: it saves a round trip
      // and gives the message next to the field, but the server re-validates
      // every one of these and is the only thing that decides.
      const perStudent = optionalCount(perStudentInput.value);
      const expected = optionalCount(expectedInput.value);
      if ((perStudent !== null && !(typeof perStudent === 'number'
            && perStudent >= formLimits.minClaimsPerStudent
            && perStudent <= formLimits.maxClaimsPerStudent))
        || (expected !== null && !(typeof expected === 'number'
            && expected >= formLimits.minExpectedStudents
            && expected <= formLimits.maxExpectedStudents))) {
        showError(createError, capacitySummary.textContent);
        return;
      }

      const minutes = Number($('create-duration').value);
      await api('/rooms', {
        method: 'POST',
        body: {
          displayName: $('create-name').value.trim(),
          expiresAt: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
          // Empty means "unset" rather than zero — the backend reads null as
          // "fall back to the server default", and zero as "no limit".
          //
          // claimLimit is only sent when the teacher picked a fixed capacity.
          // Leaving it null is what tells the server to derive the allowance
          // from class size × per student, and to keep deriving it if the
          // site-wide default ever changes.
          claimLimit: forRequest(optionalCount(capacitySelect.value)),
          claimLimitPerStudent: forRequest(perStudent),
          expectedStudents: forRequest(expected),
          // Blank means "size it from the capacity", which is the normal case.
          tokenSafetyLimit: forRequest(optionalCount($('create-token-ceiling').value)),
        },
      });
      $('create-name').value = '';
      perStudentInput.value = '';
      expectedInput.value = '';
      $('create-token-ceiling').value = '';
      renderCapacity();
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
