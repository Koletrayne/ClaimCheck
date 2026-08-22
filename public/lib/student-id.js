'use strict';

/* Anonymous student identity for classroom usage limits.
 *
 * Publishes window.ccStudentId.
 *
 * The problem this solves: a classroom needs to stop one student from spending
 * the whole class's ClaimCheck allowance, without any student having an
 * account, a name, or a profile. The answer is a random UUID that means nothing
 * outside this classroom.
 *
 * What the id IS: 122 bits from the browser's CSPRNG, generated locally, sent
 * to our own backend and to nowhere else, and used as a lookup key for a single
 * integer counter.
 *
 * What the id is NOT, deliberately and by construction: it is not derived from
 * a name, an email address, an IP address, a device identifier, a canvas or
 * font or audio fingerprint, a screen size, a timezone, or anything else about
 * the person or the machine. Two students on identical hardware get different
 * ids; the same student in two classrooms gets two ids that cannot be linked to
 * each other. Nothing about the student is inferable from the value.
 *
 * Scoping: one id per classroom, keyed by the classroom's id. Joining a
 * different classroom mints a fresh id with a fresh allowance, and usage in one
 * classroom is invisible to the other.
 */

(function () {
  const PREFIX = 'claimcheck_student_id:';

  /**
   * A v4 UUID, from crypto.randomUUID where available.
   *
   * The fallback path is still CSPRNG-backed (crypto.getRandomValues) — it
   * exists for older browsers that predate randomUUID, not to weaken the
   * source. There is deliberately no Math.random path: a predictable id would
   * let one student guess and consume another's allowance.
   */
  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Returns this browser's anonymous id for one classroom, creating it on first
   * use.
   *
   * localStorage rather than sessionStorage is the point: the id has to survive
   * a page refresh, a closed tab, and a browser restart, or the limit it backs
   * would reset every time a student reloaded — which is not a limit at all.
   *
   * The trade that comes with it: on a shared lab machine, the next student to
   * join the SAME classroom in the SAME browser profile inherits this id and
   * whatever allowance it has already spent. That is a fairness cost, not a
   * privacy one (the id says nothing about either student), and it is the right
   * side of the trade — the alternative resets the counter on demand. A teacher
   * whose class shares machines should raise the per-student limit rather than
   * rely on per-seat accuracy.
   *
   * A corrupted or tampered value is replaced rather than trusted. The server
   * validates the shape again regardless, and treats an unknown id as a new
   * student with a full allowance — so editing this value buys a bypass of the
   * per-student gate only, with the classroom and account budgets still in
   * force behind it.
   */
  function forClassroom(classroomId) {
    if (!classroomId) return null;
    const key = PREFIX + classroomId;

    try {
      const existing = localStorage.getItem(key);
      if (existing && UUID_RE.test(existing)) return existing;

      const fresh = newId();
      localStorage.setItem(key, fresh);
      return fresh;
    } catch {
      // Private browsing or a storage quota error. Fall back to an id that
      // lives only for this page view: the student can still work, and their
      // usage still counts against the classroom and account budgets — only the
      // per-student count restarts on refresh.
      return newId();
    }
  }

  /** Removes the stored id for one classroom. */
  function clear(classroomId) {
    if (!classroomId) return;
    try { localStorage.removeItem(PREFIX + classroomId); } catch { /* nothing to clear */ }
  }

  window.ccStudentId = { forClassroom, clear, isValid: (v) => UUID_RE.test(String(v || '')) };
})();
