'use strict';

/* Applies the saved ClaimCheck theme before first paint.
 *
 * Loaded synchronously in <head> on every classroom page so a dark-mode user
 * does not get a flash of the light theme. Reads the same localStorage key the
 * main site's toggle writes, so the preference carries across both experiences.
 *
 * This is the only thing any classroom page reads from localStorage on load,
 * and it holds a display preference — nothing about the student.
 */
(function applySavedTheme() {
  try {
    if (localStorage.getItem('theme') === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch {
    // Storage can be blocked entirely; the light theme is a fine fallback.
  }
})();
