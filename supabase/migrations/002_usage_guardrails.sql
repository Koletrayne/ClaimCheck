-- ClaimCheck Usage Guardrails — schema
--
-- Apply by pasting this whole file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → Run). It is idempotent and safe to
-- re-run; it assumes 001_classroom_mode.sql has already been applied.
--
-- What this adds
-- --------------
-- Three layers of claim-count accounting that sit in FRONT of the paid analysis
-- pipeline, so a runaway student, a runaway classroom, or a runaway account
-- cannot quietly spend API credits:
--
--   per student  ->  public.classroom_student_usage   (classroom_id + student_id)
--   per class    ->  public.classrooms.claims_used    (new column)
--   per account  ->  public.global_usage              (one row per day, one per month)
--
-- Design notes
-- ------------
-- * The counters here are CLAIM COUNTS, deliberately separate from the token
--   accounting added in 001. Tokens are a post-hoc measure of what an analysis
--   actually cost; claims are a pre-flight quota that can be checked BEFORE any
--   provider request is made. Both are useful and neither replaces the other.
-- * The anonymous student id is a random UUID minted in the student's own
--   browser. It is not derived from a name, an email, an IP address, a device
--   id, or any fingerprint, and it is scoped to one classroom, so the same
--   browser in two classrooms produces two unlinkable ids. Nothing in this file
--   stores claim text, results, or anything else a student typed.
-- * Reservation is atomic (see claimcheck_reserve_claim below). A read in the
--   application followed by a write would let simultaneous submissions all pass
--   the same check, which is precisely the failure this feature exists to stop.
-- * Both new tables have RLS enabled with no client policies, so students and
--   teachers alike cannot read or write usage rows directly. All access is via
--   the backend's service role.

-- ── Classroom-level claim quota ───────────────────────────────────────
-- Added to the existing classrooms table rather than a parallel table: this is
-- per-classroom state with the same lifetime and the same owner as the row it
-- lives on, and keeping it here means one row lock covers the whole classroom
-- gate.
alter table public.classrooms
  add column if not exists claims_used integer not null default 0
    check (claims_used >= 0);

-- NULL means "use the server's configured default". Storing NULL rather than
-- baking the default into each row lets an operator change
-- CLAIMCHECK_CLASSROOM_SESSION_LIMIT and have every classroom that never
-- customised its limit follow along.
alter table public.classrooms
  add column if not exists claim_limit integer
    check (claim_limit is null or claim_limit >= 0);

-- Optional per-classroom override of the per-student allowance. Same NULL rule.
alter table public.classrooms
  add column if not exists claim_limit_per_student integer
    check (claim_limit_per_student is null or claim_limit_per_student >= 0);

-- Optional roster size, used only to derive a sensible default classroom quota
-- (expected_students × the per-student limit × a headroom factor). It is a count,
-- never a list, and identifies nobody.
alter table public.classrooms
  add column if not exists expected_students integer
    check (expected_students is null or expected_students >= 0);

-- ── Per-student claim usage ───────────────────────────────────────────
-- One row per (classroom, anonymous student). The composite primary key is both
-- the uniqueness constraint and the lookup index — every query against this
-- table names both columns, so no secondary lookup index is needed.
create table if not exists public.classroom_student_usage (
  classroom_id uuid    not null references public.classrooms(id) on delete cascade,
  student_id   uuid    not null,
  claims_used  integer not null default 0 check (claims_used >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (classroom_id, student_id)
);

-- Supports "clean up usage for classrooms that ended" style maintenance without
-- scanning the whole table.
create index if not exists classroom_student_usage_updated_idx
  on public.classroom_student_usage (updated_at);

-- ── Global / account usage ────────────────────────────────────────────
-- Two period kinds share one table so a single function can check both inside
-- the same transaction. period_key is a UTC calendar key: 'YYYY-MM-DD' for a
-- day, 'YYYY-MM' for a month.
--
-- There is no reset job. A new day or month simply has no row yet, and the row
-- is created on first use with claims_used = 0, so the budget resets because
-- the key changed rather than because something ran on a schedule.
create table if not exists public.global_usage (
  period_kind text    not null check (period_kind in ('day', 'month')),
  period_key  text    not null,
  claims_used integer not null default 0 check (claims_used >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (period_kind, period_key)
);

-- ── Atomic reservation ────────────────────────────────────────────────
-- Checks every layer and reserves one claim, in a single round trip from the
-- application's point of view.
--
-- Why this must be one function rather than four round trips: a classroom is
-- thirty students pressing the button at the same moment. Read-then-write from
-- Node lets every one of those requests observe the same pre-increment count
-- and pass a limit that only one of them should have passed.
--
-- Two properties make it safe:
--   1. Locks are taken in a FIXED order on every call — global day, global
--      month, classroom, student. Concurrent callers therefore queue behind one
--      another instead of deadlocking.
--   2. Every gate is evaluated BEFORE any counter is written, so a refused
--      request leaves all four counters exactly as it found them. A partially
--      applied reservation would burn allowance for work that never ran.
--
-- A limit of 0 means "not enforced" (the caller passes 0 when a layer does not
-- apply), which is why every comparison is guarded by `> 0`.
create or replace function public.claimcheck_reserve_claim(
  p_classroom_id    uuid,
  p_student_id      uuid,
  p_student_limit   integer,
  p_classroom_limit integer,
  p_daily_limit     integer,
  p_monthly_limit   integer,
  p_day             text,
  p_month           text
)
returns table (
  allowed        boolean,
  reason         text,
  student_used   integer,
  student_cap    integer,
  classroom_used integer,
  classroom_cap  integer
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_day_used      integer := 0;
  v_month_used    integer := 0;
  v_class_used    integer := 0;
  v_class_limit   integer := coalesce(p_classroom_limit, 0);
  v_student_used  integer := 0;
  v_student_limit integer := coalesce(p_student_limit, 0);
  v_reason        text    := null;
begin
  -- Lock order step 1: the global day row.
  insert into public.global_usage (period_kind, period_key)
       values ('day', p_day)
  on conflict (period_kind, period_key) do nothing;

  select g.claims_used into v_day_used
    from public.global_usage g
   where g.period_kind = 'day' and g.period_key = p_day
     for update;

  -- SELECT INTO assigns NULL when it matches no row, overwriting the initial
  -- value rather than leaving it alone. A NULL count compares false against
  -- every limit, which would wave the request through — so each of these is
  -- pinned back to a number immediately. Failing open is the one behaviour
  -- these gates must never have.
  v_day_used := coalesce(v_day_used, 0);

  -- Lock order step 2: the global month row.
  insert into public.global_usage (period_kind, period_key)
       values ('month', p_month)
  on conflict (period_kind, period_key) do nothing;

  select g.claims_used into v_month_used
    from public.global_usage g
   where g.period_kind = 'month' and g.period_key = p_month
     for update;

  v_month_used := coalesce(v_month_used, 0);

  if p_classroom_id is not null then
    -- Lock order step 3: the classroom row. A per-classroom override wins over
    -- the server default the caller passed in, and is read here rather than
    -- trusted from the request.
    select c.claims_used,
           coalesce(c.claim_limit, coalesce(p_classroom_limit, 0)),
           coalesce(c.claim_limit_per_student, coalesce(p_student_limit, 0))
      into v_class_used, v_class_limit, v_student_limit
      from public.classrooms c
     where c.id = p_classroom_id
       for update;

    if not found then
      return query select false, 'NO_CLASSROOM'::text, 0, 0, 0, 0;
      return;
    end if;

    v_class_used    := coalesce(v_class_used, 0);
    v_class_limit   := coalesce(v_class_limit, 0);
    v_student_limit := coalesce(v_student_limit, 0);

    -- Lock order step 4: the student row, created on first use.
    if p_student_id is not null then
      insert into public.classroom_student_usage (classroom_id, student_id)
           values (p_classroom_id, p_student_id)
      on conflict (classroom_id, student_id) do nothing;

      select s.claims_used into v_student_used
        from public.classroom_student_usage s
       where s.classroom_id = p_classroom_id and s.student_id = p_student_id
         for update;

      v_student_used := coalesce(v_student_used, 0);
    end if;
  end if;

  -- Evaluate every gate first; write nothing yet.
  if p_daily_limit > 0 and v_day_used >= p_daily_limit then
    v_reason := 'GLOBAL_LIMIT';
  elsif p_monthly_limit > 0 and v_month_used >= p_monthly_limit then
    v_reason := 'GLOBAL_LIMIT';
  elsif p_classroom_id is not null and v_class_limit > 0 and v_class_used >= v_class_limit then
    v_reason := 'CLASSROOM_LIMIT';
  elsif p_classroom_id is not null and p_student_id is not null
        and v_student_limit > 0 and v_student_used >= v_student_limit then
    v_reason := 'STUDENT_LIMIT';
  end if;

  if v_reason is not null then
    return query select false, v_reason, v_student_used, v_student_limit, v_class_used, v_class_limit;
    return;
  end if;

  update public.global_usage g
     set claims_used = g.claims_used + 1, updated_at = now()
   where g.period_kind = 'day' and g.period_key = p_day;

  update public.global_usage g
     set claims_used = g.claims_used + 1, updated_at = now()
   where g.period_kind = 'month' and g.period_key = p_month;

  if p_classroom_id is not null then
    update public.classrooms c
       set claims_used = c.claims_used + 1
     where c.id = p_classroom_id;
    v_class_used := v_class_used + 1;

    if p_student_id is not null then
      update public.classroom_student_usage s
         set claims_used = s.claims_used + 1, updated_at = now()
       where s.classroom_id = p_classroom_id and s.student_id = p_student_id;
      v_student_used := v_student_used + 1;
    end if;
  end if;

  return query select true, null::text, v_student_used, v_student_limit, v_class_used, v_class_limit;
end;
$$;

-- ── Releasing an unused reservation ───────────────────────────────────
-- Gives a reservation back when the analysis failed before any paid provider
-- work happened (an invalid API key, a refused connection). Counters floor at
-- zero, so a duplicate or late release can never manufacture allowance.
--
-- Uses the same fixed lock order as the reservation function, for the same
-- reason.
create or replace function public.claimcheck_release_claim(
  p_classroom_id uuid,
  p_student_id   uuid,
  p_day          text,
  p_month        text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.global_usage g
     set claims_used = greatest(g.claims_used - 1, 0), updated_at = now()
   where g.period_kind = 'day' and g.period_key = p_day;

  update public.global_usage g
     set claims_used = greatest(g.claims_used - 1, 0), updated_at = now()
   where g.period_kind = 'month' and g.period_key = p_month;

  if p_classroom_id is not null then
    update public.classrooms c
       set claims_used = greatest(c.claims_used - 1, 0)
     where c.id = p_classroom_id;

    if p_student_id is not null then
      update public.classroom_student_usage s
         set claims_used = greatest(s.claims_used - 1, 0), updated_at = now()
       where s.classroom_id = p_classroom_id and s.student_id = p_student_id;
    end if;
  end if;
end;
$$;

-- ── Housekeeping ──────────────────────────────────────────────────────
-- Global usage rows are tiny (about 32 per month) but unbounded over years.
-- Safe to call any time; keeps roughly a year of history for reporting.
create or replace function public.prune_global_usage()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.global_usage
  where created_at < now() - interval '400 days';
$$;

-- ── Row Level Security ────────────────────────────────────────────────
-- No policies are defined on either new table, so every client read and write
-- is denied. Usage counts are read and written exclusively by the backend's
-- service role, which bypasses RLS. In particular: a student cannot see another
-- student's usage, cannot see their own row, and cannot edit their counter.
alter table public.classroom_student_usage enable row level security;
alter table public.global_usage            enable row level security;

revoke all on public.classroom_student_usage from anon, authenticated;
revoke all on public.global_usage            from anon, authenticated;

-- The new classroom columns follow the column-level grant established in 001,
-- which was written out explicitly because RLS is per-row and cannot hide
-- session_secret on its own. Re-stating the whole grant keeps that protection
-- intact while letting a teacher's dashboard read the quota columns for the
-- rooms they own.
revoke select on public.classrooms from anon, authenticated;
grant  select (
  id, owner_id, display_name, access_code, created_at, expires_at,
  active, token_budget, tokens_used, analyses_run, searches_used,
  claims_used, claim_limit, claim_limit_per_student, expected_students
) on public.classrooms to authenticated;

-- Only the backend may call these; anonymous students never touch the database.
revoke execute on function public.claimcheck_reserve_claim(uuid, uuid, integer, integer, integer, integer, text, text) from anon, authenticated;
revoke execute on function public.claimcheck_release_claim(uuid, uuid, text, text)                                     from anon, authenticated;
revoke execute on function public.prune_global_usage()                                                                 from anon, authenticated;
