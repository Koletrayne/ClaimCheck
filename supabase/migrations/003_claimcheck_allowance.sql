-- ClaimCheck Classroom Allowance — ClaimChecks become the allowance, tokens become a ceiling
--
-- Apply by pasting this whole file into the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query -> Run). It is idempotent and safe to
-- re-run; it assumes 001_classroom_mode.sql and 002_usage_guardrails.sql have
-- already been applied.
--
-- Why this exists
-- ---------------
-- A classroom's allowance used to be a token budget, offered to teachers as
-- "50,000 tokens (~15 analyses)". Measured against the live pipeline on
-- 2026-08-27, one ClaimCheck actually costs 26,556-50,240 tokens -- a median of
-- about 29,000, not the ~3,300 that estimate implied. The estimate was roughly
-- 8x too low, so a classroom sized for "15 analyses" died after two.
--
-- Nothing was being double-counted. The pipeline makes ONE API call per
-- analysis; the web_search tool resolves server-side inside that call and every
-- result it reads is billed as input on it. The tokens were real. The label was
-- wrong.
--
-- What this changes
-- -----------------
-- * classrooms.claims_used / claim_limit (added in 002) become the PRIMARY,
--   user-facing allowance: one completed ClaimCheck, one debit. No new counter
--   is introduced -- these already existed, were already atomic, and already
--   had a per-student layer. They were simply sitting behind a token gate that
--   fired first.
-- * classrooms.token_safety_limit (new) replaces token_budget as the token
--   gate, sized at 90,000 tokens per ClaimCheck -- ~3x the measured median. It
--   is a guardrail against pathological consumption, not a budget a normal
--   class can reach.
-- * claimcheck_reserve_claim now evaluates the token ceiling in the SAME atomic
--   call as the claim gates, and reports TOKEN_SAFETY_LIMIT distinctly so a
--   classroom that trips it can be told something true rather than "you used
--   up your ClaimChecks".
-- * classroom_record_usage gains a flag so tokens spent on a FAILED analysis
--   are still charged to the ceiling without counting as a completed
--   ClaimCheck.
--
-- token_budget and tokens_used are left in place. tokens_used is still the
-- running total; token_budget is retained only so historical rows keep the
-- value their teacher originally chose, and is no longer consulted once
-- token_safety_limit is set.

-- ── Token safety ceiling ──────────────────────────────────────────────
-- NULL means "this row predates the ceiling". The reservation function reads
-- NULL as "fall back to token_budget", which preserves the old behaviour
-- exactly rather than failing open. The backfill below leaves no such rows
-- behind, so NULL should only ever appear again if something inserts a
-- classroom without going through the API.
alter table public.classrooms
  add column if not exists token_safety_limit bigint
    check (token_safety_limit is null or token_safety_limit >= 0);

-- ── Documented conversion of historical classrooms ────────────────────
-- Runs once: every row written before this migration has a NULL ceiling, and
-- every row written after gets one from the API.
--
-- The conversion honours what each teacher was SHOWN, not the raw number they
-- picked. The old dropdown labelled every option with an analysis count derived
-- from ~3,333 tokens per analysis, so a room created at 50,000 tokens was sold
-- as "~15 analyses". This recovers that promised count and re-sizes the room to
-- deliver it at the real rate.
--
--   promised analyses = round(token_budget / 3333)     -- what the label said
--   analyses          = claim_limit                     -- an explicit choice wins
--                       else expected_students x per-student
--                       else promised analyses
--   ceiling           = greatest(token_budget, 250000, analyses x 90000)
--
-- greatest() guarantees the conversion can only ever WIDEN a classroom. No
-- existing room loses capacity, no recorded usage is rewritten, and tokens_used
-- is untouched -- the history stays exactly as it was measured.
--
-- 12 appears below as a frozen constant on purpose: it is the value of
-- CLAIMCHECK_STUDENT_SESSION_LIMIT at the time of this migration. A one-time
-- backfill has to pin the number it converted against, or re-running it after
-- an operator changes that setting would produce different history.
update public.classrooms c
   set token_safety_limit = greatest(
         coalesce(c.token_budget, 0),
         250000,
         coalesce(
           c.claim_limit,
           case when coalesce(c.expected_students, 0) > 0
                then c.expected_students * coalesce(c.claim_limit_per_student, 12)
           end,
           greatest(1, round(coalesce(c.token_budget, 0) / 3333.0))
         )::bigint * 90000
       )
 where c.token_safety_limit is null;

-- The second half of the same conversion: a room that recorded neither an
-- explicit claim limit nor a roster size has nothing to derive a ClaimCheck
-- allowance from, and would otherwise fall through to the flat server default
-- of 300 -- twenty times what its "~15 analyses" label promised. Pinning the
-- promised count makes the new primary gate mean what the old label said.
--
-- Rooms that DID record a roster size are left alone: their allowance already
-- derives correctly from it, and freezing today's arithmetic into the row would
-- stop them following a future change to the per-student default.
update public.classrooms c
   set claim_limit = greatest(1, round(coalesce(c.token_budget, 0) / 3333.0))::integer
 where c.claim_limit is null
   and coalesce(c.expected_students, 0) = 0
   and c.token_budget is not null;

-- ── No unlimited classrooms ───────────────────────────────────────────
-- A finite token ceiling is now a property of the table, not a promise the
-- application makes. The backfill above gives every existing row a ceiling of
-- at least 250,000, so this cannot fail on current data; from here on, an
-- INSERT that omits it is an error rather than an unmetered classroom.
--
-- No default is supplied on purpose. A default would let a caller create a
-- classroom without deciding what it may spend, which is the situation this
-- constraint exists to prevent.
alter table public.classrooms
  alter column token_safety_limit set not null;

-- Ranges for the ClaimCheck quotas, matching the API: 1-20 per student, 1 or
-- more for the class. ADDED "NOT VALID" DELIBERATELY -- the constraint applies
-- to every future insert and update but does not re-check historical rows, so a
-- room recorded under the old rules keeps whatever it had. That is the whole
-- point: close the door going forward without rewriting the past.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'classrooms_claim_limit_positive') then
    alter table public.classrooms
      add constraint classrooms_claim_limit_positive
      check (claim_limit is null or claim_limit >= 1) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'classrooms_per_student_range') then
    alter table public.classrooms
      add constraint classrooms_per_student_range
      check (claim_limit_per_student is null or (claim_limit_per_student between 1 and 20)) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'classrooms_expected_students_range') then
    alter table public.classrooms
      add constraint classrooms_expected_students_range
      check (expected_students is null or (expected_students between 1 and 1000)) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'classrooms_token_safety_positive') then
    alter table public.classrooms
      add constraint classrooms_token_safety_positive
      check (token_safety_limit >= 1) not valid;
  end if;
end
$$;

-- ── Atomic reservation, now including the token ceiling ───────────────
-- Replaces the 002 version. The signature is unchanged: the ceiling is read
-- from the classroom row inside the function rather than passed in, for the
-- same reason the claim limits are -- a caller cannot raise a limit by lying
-- about it.
--
-- Ordering of the gates matters. The token ceiling is checked LAST, after the
-- claim gates, so a classroom that is simply out of ClaimChecks is reported as
-- out of ClaimChecks. TOKEN_SAFETY_LIMIT therefore only ever surfaces when a
-- class still had allowance left but was consuming abnormally to use it, which
-- is precisely the case worth telling a teacher about.
--
-- DROP before CREATE, and not CREATE OR REPLACE: the returned table gains two
-- columns, and Postgres refuses to replace a function whose return type
-- changed. Between the drop and the create the function does not exist, and a
-- reservation that lands in that window gets no row back. That is safe by
-- construction — lib/usage-guard.js treats a missing function as unverifiable
-- quota and refuses the request rather than spending — but it does mean a live
-- classroom can see a few seconds of "please try again shortly". Apply this
-- between lessons, not during one.
drop function if exists public.claimcheck_reserve_claim(uuid, uuid, integer, integer, integer, integer, text, text);

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
  classroom_cap  integer,
  tokens_used    bigint,
  token_cap      bigint
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
  v_tokens_used   bigint  := 0;
  v_token_cap     bigint  := 0;
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
  -- every limit, which would wave the request through -- so each of these is
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
    --
    -- nullif(..., 0) throughout: a stored 0 means "not set", never "no limit".
    -- Every gate below treats 0 as unenforced, so reading a stored 0 straight
    -- through would turn one bad row into an unmetered classroom. 0 can no
    -- longer be written, but a row that predates that validation must still be
    -- read safely. lib/classroom.js applies the identical rule.
    --
    -- The token ceiling falls back to token_budget for a row that predates 003
    -- and somehow escaped the backfill, so it keeps the gate it was created
    -- with rather than losing one.
    select c.claims_used,
           coalesce(nullif(c.claim_limit, 0), nullif(p_classroom_limit, 0), 0),
           coalesce(nullif(c.claim_limit_per_student, 0), nullif(p_student_limit, 0), 0),
           c.tokens_used,
           coalesce(nullif(c.token_safety_limit, 0), nullif(c.token_budget, 0), 0)
      into v_class_used, v_class_limit, v_student_limit, v_tokens_used, v_token_cap
      from public.classrooms c
     where c.id = p_classroom_id
       for update;

    if not found then
      return query select false, 'NO_CLASSROOM'::text, 0, 0, 0, 0, 0::bigint, 0::bigint;
      return;
    end if;

    v_class_used    := coalesce(v_class_used, 0);
    v_class_limit   := coalesce(v_class_limit, 0);
    v_student_limit := coalesce(v_student_limit, 0);
    v_tokens_used   := coalesce(v_tokens_used, 0);
    v_token_cap     := coalesce(v_token_cap, 0);

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
  elsif p_classroom_id is not null and v_token_cap > 0 and v_tokens_used >= v_token_cap then
    v_reason := 'TOKEN_SAFETY_LIMIT';
  end if;

  if v_reason is not null then
    return query select false, v_reason, v_student_used, v_student_limit,
                        v_class_used, v_class_limit, v_tokens_used, v_token_cap;
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

  return query select true, null::text, v_student_used, v_student_limit,
                      v_class_used, v_class_limit, v_tokens_used, v_token_cap;
end;
$$;

-- ── Recording usage, with and without a completed ClaimCheck ──────────
-- Replaces the 3-argument version from 001. The old signature is dropped rather
-- than left alongside this one, because a 4th argument with a default would
-- make every existing 3-argument call ambiguous.
--
-- p_count_analysis is the whole point of the change. An analysis that failed
-- after the provider had already been paid still consumed tokens, and those
-- tokens must reach the safety ceiling -- but the student never received a
-- result, so it must NOT consume one of the ClaimChecks their teacher promised
-- them. Passing false records the cost and leaves the count alone.
drop function if exists public.classroom_record_usage(uuid, bigint, integer);

create or replace function public.classroom_record_usage(
  p_classroom_id   uuid,
  p_tokens         bigint,
  p_searches       integer,
  p_count_analysis boolean default true
)
returns table (
  tokens_used        bigint,
  token_budget       bigint,
  token_safety_limit bigint,
  analyses_run       integer,
  searches_used      integer,
  claims_used        integer
)
language sql
volatile
security definer
set search_path = public
as $$
  update public.classrooms c
     set tokens_used   = c.tokens_used   + greatest(p_tokens, 0),
         searches_used = c.searches_used + greatest(p_searches, 0),
         analyses_run  = c.analyses_run  + case when p_count_analysis then 1 else 0 end
   where c.id = p_classroom_id
  returning c.tokens_used, c.token_budget, c.token_safety_limit,
            c.analyses_run, c.searches_used, c.claims_used;
$$;

-- ── Row Level Security / grants ───────────────────────────────────────
-- Restated in full because RLS is per-row and cannot hide session_secret on its
-- own; the column-level grant is what does that, and adding a column means
-- re-issuing it. token_safety_limit is readable by a signed-in teacher for the
-- rooms they own -- it is an operational number, not a secret.
revoke select on public.classrooms from anon, authenticated;
grant  select (
  id, owner_id, display_name, access_code, created_at, expires_at,
  active, token_budget, tokens_used, token_safety_limit, analyses_run, searches_used,
  claims_used, claim_limit, claim_limit_per_student, expected_students
) on public.classrooms to authenticated;

-- Only the backend may call these; anonymous students never touch the database.
revoke execute on function public.claimcheck_reserve_claim(uuid, uuid, integer, integer, integer, integer, text, text) from anon, authenticated;
revoke execute on function public.classroom_record_usage(uuid, bigint, integer, boolean)                               from anon, authenticated;
