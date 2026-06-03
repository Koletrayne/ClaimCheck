// Creates a Supabase client for the website. Unlike the extension (which stores
// its session in chrome.storage.local), the website uses the browser's default
// localStorage and lets the SDK auto-detect OAuth / email-confirmation codes in
// the URL on load (detectSessionInUrl: true).
//
// Exposes the client at window.cc.supabase and a promise at
// window.cc.supabaseReady that resolves once any saved session is hydrated.

(function initSupabase() {
  const cfg = window.cc && window.cc.supabaseConfig;
  const sb = window.supabase;
  if (!cfg || !sb || typeof sb.createClient !== 'function') {
    console.error('[ClaimCheck] Supabase config or SDK missing — auth disabled.');
    window.cc = window.cc || {};
    window.cc.supabase = null;
    window.cc.supabaseReady = Promise.resolve(null);
    return;
  }

  const client = sb.createClient(cfg.url, cfg.anonKey, {
    auth: {
      storageKey: 'cc.sb.auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });

  window.cc = window.cc || {};
  window.cc.supabase = client;
  window.cc.supabaseReady = client.auth.getSession().then(
    ({ data }) => (data && data.session ? data.session : null),
    () => null
  );
})();
