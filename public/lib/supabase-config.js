// Public Supabase project values shared with the ClaimCheck browser extension.
// The anon (publishable) key is safe to ship to clients — Row Level Security
// policies enforce per-user data isolation. The service role key is NEVER used here.
window.cc = window.cc || {};
window.cc.supabaseConfig = {
  url: 'https://lvnsoitchesujrmuabia.supabase.co',
  anonKey: 'sb_publishable_Y-w-maSptgwz3NzzKtkBCA_yhbI2f4K',
  // Where Supabase sends users back to after confirming email / OAuth.
  // For the website this is simply the page they are on. This origin must be
  // listed under Supabase → Authentication → URL Configuration → Redirect URLs.
  emailRedirectTo: window.location.origin + window.location.pathname,
};
