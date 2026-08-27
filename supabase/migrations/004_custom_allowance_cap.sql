-- ClaimCheck Classroom Mode — cap an explicitly chosen classroom allowance
--
-- Apply by pasting this whole file into the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query -> Run). It is idempotent and safe to
-- re-run; it assumes 003_claimcheck_allowance.sql has already been applied.
--
-- What this adds, and what it does NOT
-- -----------------------------------
-- Live classroom editing introduces two allowance modes. They are already
-- representable by the column that exists, so NO new column is added:
--
--   claim_limit IS NULL  ->  automatic. Sized from expected_students x
--                            claim_limit_per_student, and re-sized whenever
--                            either changes.
--   claim_limit IS SET   ->  custom. Exactly this many ClaimChecks for the
--                            whole class.
--
-- A second `allowance_mode` column would only restate what claim_limit already
-- says, and could disagree with it. There is nothing here to store.
--
-- The one thing the database gains is the bound on an EXPLICIT total: 1-150.
-- That bound belongs here as well as in the API because it is the difference
-- between a considered number and a typo. A limit the system DERIVES from a
-- roster is not bounded by it -- 75 students x 4 is 300 ClaimChecks and is
-- fine -- and that case stores NULL, so this constraint never sees it.
--
-- Added NOT VALID, like the ranges in 003: it binds every future insert and
-- update without re-checking rows recorded under the old rules. No existing
-- classroom is altered, and no usage is touched by this migration at all.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'classrooms_custom_claim_limit_range') then
    alter table public.classrooms
      add constraint classrooms_custom_claim_limit_range
      check (claim_limit is null or (claim_limit between 1 and 150)) not valid;
  end if;
end
$$;

-- The 003 constraint `classrooms_claim_limit_positive` (claim_limit >= 1) is
-- deliberately left in place. It is subsumed by the range above, but dropping a
-- deployed constraint to tidy up buys nothing and can only go wrong.
