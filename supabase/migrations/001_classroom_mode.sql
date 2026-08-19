-- ClaimCheck Classroom Mode — schema
--
-- Apply by pasting this whole file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → Run). It is idempotent.
--
-- Design notes
-- ------------
-- * There is deliberately NO student table. Anonymous classroom sessions are
--   stateless HMAC-signed tokens minted by the backend; nothing about a student
--   is ever written to this database. Sessions are revoked by rotating
--   classrooms.session_secret, which invalidates every outstanding token for
--   that classroom at once.
-- * Every table has RLS enabled. Clients (browser, anon/publishable key) get
--   SELECT only, and only for rows they own. All writes go through the
--   ClaimCheck backend using the service role key, so classroom creation,
--   budget debits and code generation are authoritative server-side.
-- * No table here stores claim text, analysis results, IP addresses, or
--   anything else derived from what a student typed.

-- ── Educator allowlist ────────────────────────────────────────────────
-- Seeded by an administrator. Being in this table is what grants the right to
-- create classrooms; it does not change anything about the user's normal
-- ClaimCheck account, and existing accounts are unaffected.
create table if not exists public.classroom_educators (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  user_id    uuid references auth.users(id) on delete set null,
  note       text,
  added_at   timestamptz not null default now()
);

create unique index if not exists classroom_educators_email_key
  on public.classroom_educators (lower(email));

-- ── Classrooms ────────────────────────────────────────────────────────
create table if not exists public.classrooms (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  display_name   text,

  -- Access code shown to students. Stored in plain text on purpose: it is a
  -- low-sensitivity, short-lived credential that a teacher needs to re-display
  -- (projector, late arrivals). It is protected by RLS (owner-only SELECT) and
  -- student lookups go through the backend, which never returns the row.
  access_code    text not null,

  -- Per-classroom HMAC key for anonymous student session tokens. Rotating it
  -- revokes every live session for this classroom. Never leaves the backend.
  session_secret text not null,

  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  active         boolean not null default true,

  -- Classroom-level usage accounting. Aggregate only — these counters cannot
  -- be attributed to, or used to reconstruct, any individual student's work.
  token_budget   bigint  not null default 100000 check (token_budget >= 0),
  tokens_used    bigint  not null default 0      check (tokens_used >= 0),
  analyses_run   integer not null default 0      check (analyses_run >= 0),
  searches_used  integer not null default 0      check (searches_used >= 0)
);

create unique index if not exists classrooms_access_code_key
  on public.classrooms (upper(access_code));

create index if not exists classrooms_owner_id_idx
  on public.classrooms (owner_id);

-- ── Access-code guess throttling ──────────────────────────────────────
-- Backs the code-guessing rate limiter. The in-memory limiter in server.js is
-- best-effort only on serverless (each instance has its own memory), so failed
-- attempts are counted here instead.
--
-- Client IPs are stored as a keyed hash, never in the clear, and rows are
-- pruned by prune_classroom_code_attempts() below.
create table if not exists public.classroom_code_attempts (
  id           bigserial primary key,
  ip_hash      text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists classroom_code_attempts_lookup_idx
  on public.classroom_code_attempts (ip_hash, attempted_at desc);

-- ── Helper: is the current user an allowlisted educator? ──────────────
create or replace function public.is_classroom_educator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.classroom_educators e
    where e.user_id = auth.uid()
       or lower(e.email) = lower(nullif(auth.jwt() ->> 'email', ''))
  );
$$;

-- ── Housekeeping ──────────────────────────────────────────────────────
-- Drops throttling rows older than a day. Safe to call any time; the backend
-- calls it opportunistically.
create or replace function public.prune_classroom_code_attempts()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.classroom_code_attempts
  where attempted_at < now() - interval '1 day';
$$;

-- ── Row Level Security ────────────────────────────────────────────────
alter table public.classroom_educators     enable row level security;
alter table public.classrooms              enable row level security;
alter table public.classroom_code_attempts enable row level security;

-- Educators may check their OWN allowlist entry (the dashboard uses this to
-- decide whether to show classroom controls). They cannot enumerate the list.
drop policy if exists "educator reads own allowlist entry" on public.classroom_educators;
create policy "educator reads own allowlist entry"
  on public.classroom_educators
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
  );

-- A teacher may read only classrooms they own, and only while allowlisted.
-- Students are anonymous (no JWT), so this policy never matches for them —
-- they cannot enumerate classrooms or read any classroom row at all.
drop policy if exists "owner reads own classrooms" on public.classrooms;
create policy "owner reads own classrooms"
  on public.classrooms
  for select
  to authenticated
  using (owner_id = auth.uid() and public.is_classroom_educator());

-- No INSERT/UPDATE/DELETE policies exist on any table above, so every client
-- write is denied by RLS. Mutations happen only via the backend's service role,
-- which bypasses RLS by design. Belt-and-braces: revoke the grants Supabase
-- hands to client roles by default.
revoke insert, update, delete on public.classrooms              from anon, authenticated;
revoke insert, update, delete on public.classroom_educators     from anon, authenticated;
revoke all                    on public.classroom_code_attempts from anon, authenticated;

-- session_secret must never reach a browser. RLS operates per-row, not
-- per-column, so revoke the column explicitly and re-grant the rest.
revoke select on public.classrooms from anon, authenticated;
grant  select (
  id, owner_id, display_name, access_code, created_at, expires_at,
  active, token_budget, tokens_used, analyses_run, searches_used
) on public.classrooms to authenticated;

-- ── Atomic classroom usage accounting ─────────────────────────────────
-- Adds usage to a classroom's running totals in one statement.
--
-- This must be atomic: a classroom is many students submitting concurrently,
-- and a read-modify-write from the application would lose debits under that
-- load and let a class overrun the budget its teacher set. The row lock taken
-- by UPDATE serializes concurrent debits for the same classroom.
--
-- Called only by the backend's service role. It records aggregate counters
-- only; no argument carries anything a student typed.
create or replace function public.classroom_record_usage(
  p_classroom_id uuid,
  p_tokens       bigint,
  p_searches     integer
)
returns table (
  tokens_used     bigint,
  token_budget    bigint,
  analyses_run    integer,
  searches_used   integer
)
language sql
volatile
security definer
set search_path = public
as $$
  update public.classrooms c
     set tokens_used   = c.tokens_used   + greatest(p_tokens, 0),
         searches_used = c.searches_used + greatest(p_searches, 0),
         analyses_run  = c.analyses_run  + 1
   where c.id = p_classroom_id
  returning c.tokens_used, c.token_budget, c.analyses_run, c.searches_used;
$$;

-- Only the backend may call these; anonymous students never touch the database.
revoke execute on function public.classroom_record_usage(uuid, bigint, integer) from anon, authenticated;
revoke execute on function public.prune_classroom_code_attempts()               from anon, authenticated;
