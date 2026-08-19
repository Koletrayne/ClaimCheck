'use strict';

/*
 * ClaimCheck localization core (dependency-free).
 *
 * Locale dictionaries are registered on `window.ccLocales` by the per-language
 * files in /locales (en.js, es.js, …). Adding a new language is:
 *   1. create /locales/<code>.js that sets window.ccLocales.<code> = {…}
 *   2. add its <script> tag in index.html
 *   3. add the <option> to the language selector
 * No other code changes are required.
 *
 * Exposes window.ccI18n:
 *   t(key, params?)   -> translated string ("a.b.c" dot-path, {name} interpolation)
 *   getLang()         -> active language code
 *   setLang(code)     -> switch language (validated, persisted, re-applies + notifies)
 *   onChange(cb)      -> subscribe to language changes; returns an unsubscribe fn
 *   applyStatic(root) -> fill [data-i18n*] elements under root (default: document)
 *   languages()       -> [{ code, name }] for building the selector
 *   locale()          -> BCP-47 tag for Intl/toLocale* formatting ("en-US"/"es")
 */
(function () {
  const DEFAULT_LANG = 'en';
  const STORAGE_KEY = 'claimcheck_lang';
  // The single source of truth for which languages ClaimCheck accepts. Server-side
  // validation mirrors this list; keep them in sync when adding a language.
  const SUPPORTED = ['en', 'es'];
  const BCP47 = { en: 'en-US', es: 'es' };

  const locales = (window.ccLocales = window.ccLocales || {});
  const listeners = new Set();

  function isSupported(code) {
    return typeof code === 'string' && SUPPORTED.indexOf(code) !== -1;
  }

  let current = readSaved();

  function readSaved() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isSupported(saved)) return saved;
    } catch { /* ignore */ }
    return DEFAULT_LANG;
  }

  // Resolve a dot-path ("a.b.c") in the given dictionary.
  function resolve(dict, key) {
    if (!dict) return undefined;
    let node = dict;
    for (const part of key.split('.')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }

  function interpolate(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
    );
  }

  function t(key, params) {
    let val = resolve(locales[current], key);
    if (val === undefined && current !== DEFAULT_LANG) {
      // Fall back to the default language so a missing translation degrades to
      // English rather than showing a raw key.
      val = resolve(locales[DEFAULT_LANG], key);
    }
    if (val === undefined) return key;
    if (Array.isArray(val)) return val; // callers that ask for lists get the array
    if (typeof val !== 'string') return val;
    return interpolate(val, params);
  }

  // Return a translated list (array of strings) or [] if absent.
  function tList(key) {
    const val = t(key);
    return Array.isArray(val) ? val : [];
  }

  function applyStatic(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((elm) => {
      elm.textContent = t(elm.getAttribute('data-i18n'));
    });
    const attrMap = {
      'data-i18n-placeholder': 'placeholder',
      'data-i18n-aria-label': 'aria-label',
      'data-i18n-title': 'title',
    };
    Object.keys(attrMap).forEach((dataAttr) => {
      scope.querySelectorAll('[' + dataAttr + ']').forEach((elm) => {
        elm.setAttribute(attrMap[dataAttr], t(elm.getAttribute(dataAttr)));
      });
    });
  }

  function setLang(code) {
    if (!isSupported(code) || code === current) {
      if (isSupported(code)) return; // no-op on same language
      code = DEFAULT_LANG;
    }
    current = code;
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
    document.documentElement.setAttribute('lang', code);
    applyStatic(document);
    listeners.forEach((cb) => { try { cb(code); } catch { /* ignore */ } });
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function languages() {
    return SUPPORTED.map((code) => ({
      code,
      name: (resolve(locales[code], 'meta.name')) || code,
    }));
  }

  window.ccI18n = {
    t,
    tList,
    getLang: () => current,
    setLang,
    onChange,
    applyStatic,
    languages,
    supported: () => SUPPORTED.slice(),
    isSupported,
    locale: () => BCP47[current] || current,
  };

  // Reflect the persisted language on <html> as early as possible, and fill the
  // static markup once the DOM is ready.
  document.documentElement.setAttribute('lang', current);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyStatic(document));
  } else {
    applyStatic(document);
  }
})();
