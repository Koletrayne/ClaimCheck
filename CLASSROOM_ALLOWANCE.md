# Classroom Allowance — ClaimChecks, not tokens

*Written 2026-08-27. Supersedes the token-budget model described in
`CLASSROOM_MODE.md` §11 and the classroom half of `USAGE_GUARDRAILS.md`.*

A classroom's allowance is now a **count of completed ClaimChecks**. Tokens
still exist, still bound spending, and are still recorded — but they are a
safety ceiling behind the count, not the thing a teacher chooses or a class runs
out of.

---

## 1. What went wrong

A teacher created a classroom with the "50,000 tokens (~15 analyses)" option.
After **two** analyses the dashboard read:

```
Allowance used     53,856 (108%)
Remaining          0
Analyses run       2
Searches           4
```

### The tokens were real

Nothing was double-counted. Measured on 2026-08-27 against the live pipeline,
counting exactly what a classroom is debited (`input + output + cache_read +
cache_creation`):

| Claim | Tokens | API calls | Searches |
|---|---:|---:|---:|
| Simple factual | 29,038 | 1 | 2 |
| Typical classroom claim | 26,556 | 1 | 2 |
| Research-heavy / contested | 29,080 | 1 | 2 |
| Quick snapshot | 29,154 | 1 | 2 |
| Academic mode | 50,240 | 1 | 3 |

Median ≈ 29,000. The reported 53,856 for two analyses is 26,928 each — within
2% of the "typical classroom claim" measurement. The accounting was correct.

### The estimate was wrong by about 8x

"50,000 tokens ≈ 15 analyses" implies ~3,333 tokens per analysis. The real
figure is ~29,000.

The surprise, and the reason the estimate was so far off, is **where the tokens
go**. One analysis is a single API call, not a multi-turn conversation: the
`web_search` tool resolves server-side inside that one request, and every page
it reads is billed as input on it. Two searches cost roughly 20,000 input
tokens on their own. So cost tracks **the number of searches**, not the length
of the claim — and a per-analysis estimate derived from prompt size plus a
response could never have been close.

### Two related bugs found while auditing

1. **`defaultClassroomClaimLimit` ignored the classroom's own
   `claim_limit_per_student`.** It multiplied the roster by the *server-wide*
   per-student limit, so a teacher who asked for "25 students × 4 ClaimChecks"
   silently got 25 × 12. The two fields were documented as one control and were
   not wired as one.

2. **A billable failure kept the student's ClaimCheck.** An analysis that
   reached the provider and then failed (unparseable response, truncation) both
   charged the allowance and returned nothing. Worse, `analyzeClaim` attached
   usage only to *transport* failures, so the most expensive failure mode — the
   provider ran to completion and only the last step broke — recorded no cost at
   all.

---

## 2. The model

### One ClaimCheck

> **One successfully completed, user-requested claim analysis that returns a
> final result to the student.**

Not a search, not a source retrieval, not a model call, not a retry. One
submission may cause several internal operations; it moves the counter by
exactly 1, once, on completion.

### Every classroom is finite

Two things must always be true of a classroom, and neither is left to the
application to remember:

* it has a **finite ClaimCheck allowance** — at least 1, never "unlimited";
* it has a **finite token safety ceiling** — at least the configured floor.

There is no input, no stored value, and no environment variable that produces a
classroom without both. See §5b for how that is enforced at each layer.

### Two limits, two jobs

| | Unit | Who sees it | When it fires |
|---|---|---|---|
| **ClaimCheck allowance** | completed analyses | teacher and student | normally — this is the lesson's budget |
| **Token safety ceiling** | tokens | administrator | almost never — a runaway |

The ClaimCheck allowance already existed as `classrooms.claims_used` /
`claim_limit` (added in migration 002). It was already atomic and already had a
per-student layer. It was simply sitting behind a token gate that fired first.
No third counter was introduced.

### Sizing the ceiling

```
token_safety_limit = max(
    CLAIMCHECK_MIN_TOKEN_SAFETY_LIMIT,          default 250,000
    analysis_limit × CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS   default 90,000
)
```

Both figures are environment variables, so the ceiling can be retuned from
Vercel when these measurements age — no deployment required.

**Why 90,000**, and not something nearer the measured median of ~29,000:

* **It must clear the worst case comfortably.** Academic mode already measured
  50,240 — 1.7x the median — at 3 searches, and the pipeline permits 5. A
  legitimate analysis can plausibly reach ~80,000 with nothing wrong.
* **It must not be reachable by an ordinary class.** At 90,000 a classroom has to
  average roughly 3x the median across its *whole* allowance before the ceiling
  fires. Ordinary work never gets close.
* **It must still stop a runaway.** A classroom burning 600,000 tokens per
  analysis trips it within a handful of requests instead of spending unbounded
  credit.

The accepted range is 60,000–5,000,000, and **0 is not in it**. 0 used to mean
"no ceiling", which made a single environment variable enough to unmeter every
classroom at once. Anything invalid or out of range warns and falls back to the
default: a typo must never switch a cost guardrail off.

| ClaimChecks | Ceiling | Worst-case real use | Headroom |
|---:|---:|---:|---:|
| 15 | 1,350,000 | 753,600 | 1.8x |
| 30 | 2,700,000 | 1,507,200 | 1.8x |
| 100 | 9,000,000 | 5,024,000 | 1.8x |
| 300 | 27,000,000 | 15,072,000 | 1.8x |

The 250,000 floor stops a deliberately tiny classroom (a 3-ClaimCheck demo)
being tripped by one expensive analysis landing first.

---

## 3. Capacity from the two numbers a teacher understands

```
capacity = expected class size × ClaimChecks per student × headroom
25 × 4 × 1.00 = 100
```

That is also what a **blank** form produces. The shipped defaults are 25 students
and **4 ClaimChecks each**, so a teacher who fills in nothing gets exactly the
classroom the form previews.

`CLASSROOM_HEADROOM_PERCENT` now defaults to **100**, not 110. The create form
prints "25 students × 4 ClaimChecks — classroom capacity: 100 ClaimChecks", and
a teacher who reads 100 must get 100. Headroom remains configurable for an
operator who wants a class to be able to overspend its own arithmetic.

Blank fields fall back to defaults (25 students, 4 each) rather than disabling
the calculation, and the readout names which default it used. The three defaults
are chosen to agree, so the derived capacity and the flat fallback can never
disagree: 25 × 4 = 100 = `CLAIMCHECK_CLASSROOM_SESSION_LIMIT`.

The form reads those defaults from the server (`GET /api/classroom/me`) rather
than holding a copy. A number that lives in two places eventually disagrees with
itself, which is the exact failure this whole feature exists to correct.

Precedence, applied identically in `lib/limits.js`, `lib/classroom.js` and
`claimcheck_reserve_claim`:

1. an explicit `claim_limit`
2. `expected_students × claim_limit_per_student`
3. `CLAIMCHECK_CLASSROOM_SESSION_LIMIT`

---

## 4. When a ClaimCheck is spent

A reservation is a **hold**, not a charge. It is taken before the pipeline runs
because that is the only place a limit can be enforced atomically; it becomes a
debit only when a result reaches the student.

| Outcome | ClaimCheck | Tokens |
|---|---|---|
| Completed analysis returned | charged | charged |
| Provider refused (bad key, connection) | released | nothing spent |
| Provider ran, then the response was unusable | released | **charged** |
| Timeout mid-analysis | released | charged |
| Validation error (claim too long, bad URL) | never reserved | nothing spent |

Money and allowance are tracked separately and deliberately: a failure that cost
real tokens still counts against the ceiling, because it really did cost money.

Releases are idempotent twice over — the reservation is marked in-process, and
the database function floors every counter at zero.

---

## 5. Concurrency

Every gate — global day, global month, classroom ClaimChecks, per-student
ClaimChecks, and now the token ceiling — is evaluated inside a single call to
`claimcheck_reserve_claim`, under `FOR UPDATE` row locks taken in a fixed order.
Every gate is checked before any counter is written, so a refused request leaves
all counters exactly as it found them.

Twenty simultaneous submissions against a 3-ClaimCheck classroom grant exactly
three. Verified in `test/guardrails.test.js` and against the real database.

---

## 5b. Validation

Server-side and authoritative. The form applies the same rules for a better
error message, but nothing is trusted from it — a direct API call is refused by
the same code.

| Field | Accepted | Blank | 0 | Negative | Malformed |
|---|---|---|---|---|---|
| ClaimChecks per student | 1–20 | default (4) | **400** | **400** | **400** |
| Expected class size | 1–1000 | default (25) | **400** | **400** | **400** |
| Classroom capacity | 1–100,000 | derived from the two above | **400** | **400** | **400** |
| Token safety limit | 60,000–50,000,000 | derived from capacity | **400** | **400** | **400** |

"Malformed" covers more than a non-numeric string. `Number([])` is 0 and
`Number(true)` is 1, so arrays and booleans are rejected on type before they are
ever converted — otherwise `{"claimLimitPerStudent": []}` would have quietly
created an unlimited classroom.

Blank and 0 are deliberately **different** intentions and must not collapse into
one value. Blank means "use the default"; 0 means "remove the limit" and is
refused. They collapsed once already, when a blank field reached `Number('')`
and became 0.

### The same rule at every layer

An invariant enforced in one place is an invariant with a way around it.

1. **The form** shows the range and refuses to submit an out-of-range value.
2. **The route** re-validates every field, and a final assertion refuses to write
   a row whose capacity or ceiling is not finite and positive — belt and braces
   over the parsing above it.
3. **The environment defaults** are range-checked too, so
   `CLAIMCHECK_STUDENT_SESSION_LIMIT=0` cannot unmeter every classroom from
   Vercel. Out of range warns and falls back.
4. **The read path** treats a stored 0 as "not recorded", never as "no limit", in
   both `lib/classroom.js` and `claimcheck_reserve_claim` (`nullif(…, 0)`). A row
   written before this validation cannot become unmetered just by being read.
5. **The database** makes it structural: `token_safety_limit` is `NOT NULL` with
   no default, and CHECK constraints pin each range. They are added `NOT VALID`,
   so they bind every future write without re-checking history.

---

## 5c. Editing a running classroom

*Added 2026-08-27.* A teacher can change a live classroom's roster, per-student
allowance, total allowance, and closing time from the dashboard, without ending
the session. `PATCH /api/classroom/rooms/:id`, owner-only.

### Two allowance modes, one column

There is no `allowance_mode` column. `claim_limit` already carries the
distinction, and a second field describing the first is a field that can
disagree with it:

| `claim_limit` | Mode | Total |
|---|---|---|
| `NULL` | automatic | `expected_students × claim_limit_per_student`, recomputed on every read |
| set | custom | exactly that number |

The API accepts `allowanceMode` + `customClaimLimit`, and still accepts the bare
`claimLimit` the create form has always sent. Both land on the same column under
the same 1–150 bound, so neither spelling is looser than the other.

### The 150 cap, and what it does not apply to

An **explicitly typed** total is capped at 150 — in the form, in the route, and
in the database (migration 004). A **derived** total is not: 75 students × 4 is
300 ClaimChecks and is allowed, because it stores `NULL` and the constraint
never sees it. That asymmetry is the point: 300 derived from a real roster is a
considered number, 300 typed into a box is usually a typo. The create form's
fixed-total options stop at 150 for the same reason.

### Nothing is ever reset

An edit writes settings, never counters. `claims_used`, `analyses_run`,
`tokens_used`, `searches_used`, and every per-student counter are untouched by
every path through the route.

A new allowance **below** current usage is allowed. A teacher who needs to stop
a class cannot be told the arithmetic forbids it. The work already done stays
exactly as recorded, and the classroom simply has nothing left: `remainingClaims`
floors at 0, `isUsable` goes false, and the reservation refuses with
`CLASSROOM_LIMIT`. Nothing goes negative. `ownerView.overCapacity` marks it so
the dashboard can say what "37 of 30 used" means rather than leaving it to be
decoded. Raising the allowance again resumes the class from where it was.

The same holds per student: 4 used against a new limit of 3 is 0 remaining, not
a refund and not a rewrite.

### Expired classrooms

Refused (403 `CLASSROOM_EXPIRED`). Extending `expires_at` on a finished session
would silently reopen it — students holding tokens minted before it ended would
find it working again. Reopening may be worth supporting one day, but as a
control that says so, not as a side effect of the edit form. Closing and
deleting stay available; neither reopens anything.

### Closing time

Absolute `expires_at`, edited directly, so "extend by an hour" twice is
unambiguous. The existing 5-minute-to-30-day bounds still apply, which means a
closing time in the past is refused rather than ending a class by accident —
"Close now" already exists separately for that.

### Concurrency

Unchanged. The reservation function was not touched. A PostgREST `PATCH` is a
single `UPDATE`, and `claimcheck_reserve_claim` holds `FOR UPDATE` on the same
row, so an edit and a reservation serialize against each other: once the edit
commits, the very next reservation reads the new limit. Concurrent *teacher*
edits are last-write-wins on the settings; counters are never read-modify-written
and so are never at risk.

### Token ceiling

Recalculated from the new effective allowance whenever it changes, in both
directions — a classroom cut to 3 ClaimChecks does not keep a 100-ClaimCheck
ceiling. `tokens_used` is never reset.

A shrunken classroom can in principle end up with a ceiling below its recorded
usage, and is then safety-exhausted for future requests. In practice the
ClaimCheck gate always fires first: reaching the ceiling instead would require
`tokens_used / new_limit > 90,000` while `claims_used < new_limit`, and at ~29k
per analysis those two cannot both hold. So a reduction never mislabels an
ordinary classroom as a runaway.

### Audit

Every edit emits one `[classroom:audit]` line with before and after, the fields
changed, current usage, and whether the result is over capacity. Classroom id
and numbers only — no student id, no claim text, no access code.

---

## 6. Gate order

```
global day → global month → classroom ClaimChecks → student ClaimChecks → token ceiling
```

The token ceiling is checked **last**. A classroom that simply finished its
ClaimChecks must be reported as having finished its ClaimChecks;
`TOKEN_SAFETY_LIMIT` therefore only ever surfaces when a class still had
allowance left and was consuming abnormally to use it.

The two refusals say different things:

* `CLASSROOM_LIMIT` — "This classroom has used all 15 of its ClaimChecks."
* `TOKEN_SAFETY_LIMIT` — "ClaimCheck has paused this classroom because it is
  using far more resources than expected. This is not your ClaimCheck allowance
  running out — please tell your instructor."

A ceiling breach also writes a structured log line with classroom id, claim
count, token total, observed tokens-per-ClaimCheck, and timestamp. No student
id and no claim content: the anonymous id identifies nobody, but a stable
per-student handle in log storage is a correlation key waiting to be used.

---

## 7. Migration 003

`supabase/migrations/003_claimcheck_allowance.sql`. Idempotent; validated
against the live production schema inside a rolled-back transaction.

**Adds** `classrooms.token_safety_limit` (bigint), backfilled for every existing
row and then made `NOT NULL` **with no default** — a classroom that never decided
what it may spend is exactly the row this column exists to prevent.

**Adds** four CHECK constraints pinning the accepted ranges (§5b). All are added
`NOT VALID`: they bind every future insert and update but do not re-check
historical rows, so the door closes going forward without rewriting the past.
**Replaces** `claimcheck_reserve_claim` (adds the token gate; returns two more
columns) and `classroom_record_usage` (adds `p_count_analysis`).

### Historical conversion

Existing rows are converted, not silently reinterpreted. The conversion honours
what each teacher was **shown**, not the raw number they picked — the old
dropdown labelled every option with an analysis count derived from ~3,333
tokens, so a room bought at 50,000 tokens was sold as "~15 analyses".

```
promised analyses = round(token_budget / 3333)
analyses          = claim_limit
                    else expected_students × per-student
                    else promised analyses
ceiling           = greatest(token_budget, 250000, analyses × 90000)
```

`greatest()` guarantees the conversion can only **widen** a classroom. No room
loses capacity, `tokens_used` is untouched, and no recorded history is rewritten.

A row that recorded neither an explicit limit nor a roster size also has
`claim_limit` pinned to its promised count — otherwise it would fall through to
the flat default of 300, twenty times what its label promised. Rooms that *did*
record a roster are left alone, so they keep deriving their allowance and keep
following a future change to the per-student default.

A row whose `token_safety_limit` is still NULL (one the migration never reached)
falls back to `token_budget`, preserving the old behaviour rather than failing
open. After this migration no such row exists — the column is `NOT NULL` — but
the fallback stays because losing a gate is worse than keeping a stale one.

**Lowering the per-student default from 12 to 4 does not touch a single existing
classroom.** Each stores its own `claim_limit_per_student` or derives from its
own `expected_students`, and neither is re-read from the constant. Verified
against the live database: both production classrooms convert to exactly what
their teachers asked for — 5 × 5 = 25 and 6 × 4 = 24 ClaimChecks — and neither
falls through to the flat default that changed.

### Deployment note

`claimcheck_reserve_claim` is **dropped and recreated**, because Postgres
refuses to replace a function whose return type changed. For the moment between
the two statements the function does not exist, and a reservation landing there
gets no row back. That is safe by construction — `lib/usage-guard.js` treats a
missing function as unverifiable quota and refuses rather than spending — but it
means a live classroom can see a few seconds of "please try again shortly".
**Apply between lessons, not during one.**

---

## 8. Privacy

Unchanged. This work added **no table, no column, and no field** describing a
student.

* Students still join with a code and never sign in.
* The only per-student state remains the counter added in 002, keyed by a random
  per-classroom UUID minted in the browser (see `USAGE_GUARDRAILS.md` for the
  honest description of what that is and is not).
* `expected_students` is a **count**, never a roster. It sizes a budget and
  identifies nobody.
* Per-student enforcement is capped by that same anonymous counter. Where it
  cannot be relied on — a shared machine, a cleared browser — the whole-class
  ClaimCheck budget is the real limit, which is why `class size × per student`
  is described to teachers as allocation planning rather than per-pupil metering.
* The student-facing payload lost a field: the class meter now reports
  ClaimChecks, and no token figure is published to a student at all.
* The teacher dashboard remains whole-class only. There is no per-student
  breakdown because none is collected.

---

## 9. Configuration

| Variable | Default | Meaning |
|---|---:|---|
| Variable | Default | Range | Meaning |
|---|---:|---|---|
| `CLAIMCHECK_STUDENT_SESSION_LIMIT` | 4 | 1–20 | ClaimChecks one student may run |
| `CLAIMCHECK_CLASSROOM_SESSION_LIMIT` | 100 | 1–100,000 | Flat fallback when nothing was recorded |
| `CLAIMCHECK_DEFAULT_EXPECTED_STUDENTS` | 25 | 1–1000 | Roster assumed when blank |
| `CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT` | 100 | ≥ 0 | 100 = the printed arithmetic is exact |
| `CLAIMCHECK_TOKEN_SAFETY_PER_ANALYSIS` | 90000 | 60,000–5,000,000 | Tokens per ClaimCheck the ceiling is sized on |
| `CLAIMCHECK_MIN_TOKEN_SAFETY_LIMIT` | 250000 | 60,000–50,000,000 | Floor for the whole-class ceiling |
| `CLAIMCHECK_TOKEN_DIAGNOSTICS` | off in production | — | Per-call token logging |

None of these ranges includes 0. An out-of-range or unparseable value warns and
falls back to the default shown, which is the existing convention for every
limit in `lib/limits.js` — a typo in a Vercel variable should degrade to the
documented default, never disable the guardrail it was meant to configure.

Existing cost protections are untouched: the 750-character claim cap, the global
daily (1,000) and monthly (15,000) claim budgets, `web_search` `max_uses` (5, or
2 in snapshot mode), `maxTurns` (6/4), `max_tokens` (6,144), the article
extraction caps, and fail-closed behaviour when quota state cannot be verified.

---

## 10. Diagnostics

With `CLAIMCHECK_TOKEN_DIAGNOSTICS=true` (default outside production):

```
[analyze:diag] call 1 model=claude-sonnet-4-6 stop=end_turn input=25327 output=3711 \
               cache_read=0 cache_create=0 searches=2 charged=29038
[classroom] analysis <uuid> claimChecks=2/15 tokens=29038 searches=2 classTokens=55594/1350000
[classroom:diag] {"classroomId":"...","claimCheckNumber":2,"completed":true,"apiCalls":1,
                  "searchCalls":2,"tokens":{"input":25327,"output":3711,"cacheRead":0,
                  "cacheCreate":0,"totalCharged":29038},
                  "classroomTotals":{"tokens":55594,"ceiling":1350000,
                  "tokensPerClaimCheck":27797}}
```

The one-line summary is emitted **always**, including in production. It is the
record that explains a classroom's token total, and losing it is how the
original estimate went eight times wrong without anyone noticing.

Never logged: claim text, results, access codes, session tokens, student ids.

---

## 11. Recommended defaults

| Setting | Recommendation |
|---|---|
| Expected class size | the real roster (default 25) |
| ClaimChecks per student | leave blank — the default is now **4** |
| Duration | 90 minutes for one period |
| Capacity | leave on Automatic |
| Token safety limit | leave blank |

A 25-student class at 4 each is **100 ClaimChecks** — a 9,000,000-token ceiling
against roughly 2.9M tokens of realistic use. This is the shape a blank form
produces, so the recommended classroom is also the default one.

Raise ClaimChecks per student to 8–12 for a multi-session project; the maximum
is 20. Existing classrooms are unaffected by the default: each stores its own
per-student value or derives from its own roster, and neither is re-read from
this constant.
