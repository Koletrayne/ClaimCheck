'use strict';

/* Student classroom environment.
 *
 * Runs BEFORE app.js and publishes window.ccClassroom, which app.js reads at
 * module scope to switch into classroom behaviour: analyses go to the classroom
 * endpoints with this session's token, nothing is written to history, and
 * shared-result links are ignored.
 *
 * What this file stores about the student: sessionStorage holds the classroom
 * session token and the classroom's own display details, both of which describe
 * the classroom rather than the person using it, and both of which vanish when
 * the tab closes. localStorage additionally holds one random UUID per classroom
 * — see public/lib/student-id.js for what that is and, more importantly, what
 * it deliberately is not.
 */

(function () {
  const STORAGE_KEY = 'claimcheck_classroom_session';

  const nameEl = document.getElementById('cc-room-name');
  const expiresEl = document.getElementById('cc-expires');
  const meterEl = document.getElementById('cc-meter');
  const meterFill = document.getElementById('cc-meter-fill');
  const claimsEl = document.getElementById('cc-claims');
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

  /* ── Anonymous student id ───────────────────────── */

  // Minted (or recalled) for THIS classroom only. app.js attaches it to every
  // analysis request so the backend can count this student's ClaimChecks
  // without knowing anything else about them.
  const classroomId = session.classroom && session.classroom.id;
  const studentId = window.ccStudentId ? window.ccStudentId.forClassroom(classroomId) : null;

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

  /**
   * Shows how many ClaimChecks this student has left.
   *
   * The numbers are whatever the server last said — this function never
   * calculates or decrements them locally, because a count the browser
   * maintains is a count the browser can be talked out of. When the server has
   * not sent any (usage enforcement switched off, or a failed lookup), the
   * indicator stays hidden rather than showing a guess.
   */
  function renderClaims(claims) {
    if (!claimsEl) return;
    const used = claims && Number(claims.used);
    const limit = claims && Number(claims.limit);

    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
      claimsEl.hidden = true;
      return;
    }

    const remaining = Math.max(0, limit - used);
    claimsEl.hidden = false;
    claimsEl.textContent = window.ccI18n
      ? window.ccI18n.t('classroom.claimsRemaining', { remaining, limit })
      : `${remaining} of ${limit} ClaimChecks remaining`;
    claimsEl.classList.toggle('cc-claims--low', remaining > 0 && remaining <= 3);
    claimsEl.classList.toggle('cc-claims--out', remaining === 0);
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

    // Sent as X-Claimcheck-Student on every analysis request. The server uses it
    // as a counter key and validates its shape; it never becomes part of any
    // stored result.
    studentId,

    /** Called after each analysis with the server's classroom metadata. */
    onResult(meta) {
      if (!meta) return;
      renderMeter(Number(meta.budgetRemaining));
      renderClaims(meta.claims);
      showPiiWarning(meta.piiWarning);
    },

    /**
     * Called when a request was refused by a usage limit, with the server's
     * authoritative counts. Refreshes the indicator so a student who has just
     * run out sees zero immediately rather than after the next poll.
     */
    onLimitReached(body) {
      if (body && body._usage && body._usage.student) renderClaims(body._usage.student);
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
      const headers = { 'X-Classroom-Session': session.token };
      // Sent so the server can look up this student's remaining ClaimChecks.
      // It is a lookup key, not a claim of entitlement — the counts come back
      // from the database either way.
      if (studentId) headers['X-Claimcheck-Student'] = studentId;

      const res = await fetch('/api/classroom/session', { headers });
      if (res.status === 401 || res.status === 403) {
        const data = await res.json().catch(() => ({}));
        endSession(data.error || 'Your classroom session has ended.');
        return;
      }
      if (res.ok) {
        const data = await res.json();
        renderRoom(data.classroom);
        if (data.claims && data.claims.student) renderClaims(data.claims.student);
      }
    } catch {
      // Offline or a blip: leave the student where they are and try again later.
    }
  }

  // Runs once on load so the student sees their remaining ClaimChecks straight
  // away, then on the usual interval.
  pollSession();
  setInterval(pollSession, 60000);
})();
