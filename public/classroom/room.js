'use strict';

/* Student classroom environment.
 *
 * Runs BEFORE app.js and publishes window.ccClassroom, which app.js reads at
 * module scope to switch into classroom behaviour: analyses go to the classroom
 * endpoints with this session's token, nothing is written to history, and
 * shared-result links are ignored.
 *
 * What this file stores about the student: nothing. sessionStorage holds the
 * classroom session token and the classroom's own display details, both of
 * which describe the classroom rather than the person using it, and both of
 * which vanish when the tab closes.
 */

(function () {
  const STORAGE_KEY = 'claimcheck_classroom_session';

  const nameEl = document.getElementById('cc-room-name');
  const expiresEl = document.getElementById('cc-expires');
  const meterEl = document.getElementById('cc-meter');
  const meterFill = document.getElementById('cc-meter-fill');
  const piiEl = document.getElementById('cc-pii-warning');
  const leaveBtn = document.getElementById('leave-btn');

  /* ── Session ────────────────────────────────────── */

  function readSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Clears the local session and returns to the join page. */
  function endSession(message) {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
    const query = message ? `?ended=${encodeURIComponent(message)}` : '';
    window.location.replace(`/classroom/join${query}`);
  }

  const session = readSession();
  if (!session) {
    endSession();
    return;
  }

  let budgetTotal = Number(session.classroom && session.classroom.budgetTotal) || 0;

  /* ── Banner ─────────────────────────────────────── */

  function renderRoom(room) {
    if (!room) return;
    nameEl.textContent = room.displayName || 'Classroom session';
    document.title = `${room.displayName || 'Classroom'} · ClaimCheck`;

    if (room.expiresAt) {
      const when = new Date(room.expiresAt);
      expiresEl.textContent = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      expiresEl.title = when.toLocaleString();
    }
    if (room.budgetTotal) budgetTotal = Number(room.budgetTotal);
    renderMeter(Number(room.budgetRemaining));
  }

  /**
   * Shows how much of the CLASS allowance is left. This is a shared, whole-class
   * figure — it is not, and cannot be, attributed to any individual student.
   */
  function renderMeter(remaining) {
    if (!budgetTotal || !Number.isFinite(remaining)) return;
    const pct = Math.max(0, Math.min(100, (remaining / budgetTotal) * 100));
    meterFill.style.width = `${pct}%`;
    meterEl.classList.toggle('cc-meter--low', pct <= 20 && pct > 0);
    meterEl.classList.toggle('cc-meter--empty', pct <= 0);
    meterEl.setAttribute('aria-label', `Class allowance: ${Math.round(pct)}% remaining`);
  }

  const PII_LABELS = {
    email: 'an email address',
    phone: 'a phone number',
    ssn: 'a social security number',
    address: 'a street address',
    studentId: 'a student ID',
  };

  /**
   * Tells the student what was spotted after the fact.
   *
   * The check is advisory and never blocks the analysis: every pattern it looks
   * for can legitimately appear in a real claim, and a filter that refused
   * those would break ordinary fact-checking.
   */
  function showPiiWarning(types) {
    if (!types || !types.length) {
      piiEl.hidden = true;
      return;
    }
    const listed = types.map((t) => PII_LABELS[t] || 'personal information');
    const phrase = listed.length === 1
      ? listed[0]
      : `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
    piiEl.textContent =
      `Heads up: what you submitted looks like it contained ${phrase}. ` +
      'ClaimCheck did not save it, but try to keep personal details out of the claim box.';
    piiEl.hidden = false;
  }

  renderRoom(session.classroom);

  /* ── Contract consumed by app.js ────────────────── */

  window.ccClassroom = {
    token: session.token,

    /** Called after each analysis with the server's classroom metadata. */
    onResult(meta) {
      if (!meta) return;
      renderMeter(Number(meta.budgetRemaining));
      showPiiWarning(meta.piiWarning);
    },

    /** Called when the server says this session is no longer valid. */
    onSessionError(code, message) {
      const reasons = {
        CLASSROOM_EXPIRED: 'This classroom session has ended.',
        CLASSROOM_CLOSED: 'Your teacher closed this classroom.',
        SESSION_ENDED: 'Your classroom session has ended.',
        NO_SESSION: 'Your classroom session has ended.',
      };
      endSession(reasons[code] || message || 'Your classroom session has ended.');
    },
  };

  /* ── Leaving ────────────────────────────────────── */

  leaveBtn.addEventListener('click', () => {
    endSession('You left the classroom.');
  });

  /**
   * Re-checks the session periodically so a classroom that expires or is closed
   * mid-lesson removes students promptly, rather than only failing when they
   * next submit something.
   */
  async function pollSession() {
    try {
      const res = await fetch('/api/classroom/session', {
        headers: { 'X-Classroom-Session': session.token },
      });
      if (res.status === 401 || res.status === 403) {
        const data = await res.json().catch(() => ({}));
        endSession(data.error || 'Your classroom session has ended.');
        return;
      }
      if (res.ok) {
        const data = await res.json();
        renderRoom(data.classroom);
      }
    } catch {
      // Offline or a blip: leave the student where they are and try again later.
    }
  }

  setInterval(pollSession, 60000);
})();
