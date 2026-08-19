'use strict';

/* Classroom join flow.
 *
 * Exchanges an access code for an anonymous session token, stashes it in
 * sessionStorage, and hands off to the student room.
 *
 * sessionStorage rather than localStorage is deliberate: the token dies with
 * the tab, so a shared or lab computer does not carry one student's classroom
 * session into whoever sits down next. Nothing else about the student is stored
 * on the device, and the token itself names only a classroom and an expiry.
 */

(function () {
  const form = document.getElementById('join-form');
  const input = document.getElementById('code-input');
  const button = document.getElementById('join-btn');
  const errorEl = document.getElementById('join-error');

  const STORAGE_KEY = 'claimcheck_classroom_session';

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function setBusy(busy) {
    button.disabled = busy;
    button.textContent = busy ? 'Joining…' : 'Join classroom';
  }

  /** Uppercases and re-inserts the readability dash as the student types. */
  function formatAsTyped(raw) {
    const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  }

  /**
   * Surfaces the reason a student was returned here — an expired classroom, a
   * teacher closing the room, or simply leaving. The reason is passed in the
   * query string and cleared from the address bar immediately, so it does not
   * linger in browser history.
   */
  (function showEndedReason() {
    const reason = new URLSearchParams(window.location.search).get('ended');
    if (!reason) return;
    showError(reason);
    window.history.replaceState({}, '', '/classroom/join');
  })();

  input.addEventListener('input', () => {
    const cursorAtEnd = input.selectionStart === input.value.length;
    input.value = formatAsTyped(input.value);
    if (cursorAtEnd) input.setSelectionRange(input.value.length, input.value.length);
    clearError();
  });

  async function join(code) {
    clearError();
    setBusy(true);
    try {
      const res = await fetch('/api/classroom/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error('Something went wrong. Please try again.');
      }

      if (!res.ok) throw new Error(data.error || 'That code did not work.');

      // Store only what the room needs: the token plus the classroom's display
      // details. No student identifier exists to store.
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        token: data.sessionToken,
        classroom: data.classroom,
      }));

      window.location.replace('/classroom/room.html');
    } catch (err) {
      showError(err.message || 'That code did not work.');
      setBusy(false);
      input.focus();
      input.select();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.replace(/[^A-Za-z0-9]/g, '');
    if (code.length !== 8) {
      showError('A classroom code is eight letters and numbers.');
      input.focus();
      return;
    }
    join(code);
  });

  /**
   * Supports the direct link form, /classroom/ABCD-2345.
   *
   * The code is pre-filled and submitted automatically, then removed from the
   * address bar so it is not left sitting in browser history on a shared
   * machine. The room URL carries no code at all.
   */
  (function handleDirectLink() {
    const match = window.location.pathname.match(/^\/classroom\/([A-Za-z0-9-]{8,9})\/?$/);
    if (!match) {
      input.focus();
      return;
    }
    const code = match[1].replace(/[^A-Za-z0-9]/g, '');
    if (code.length !== 8) {
      input.focus();
      return;
    }
    input.value = formatAsTyped(code);
    window.history.replaceState({}, '', '/classroom/join');
    join(code);
  })();
})();
