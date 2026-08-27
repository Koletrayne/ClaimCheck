# ClaimCheck Usage Guardrails

> **Updated 2026-08-27 — see `CLASSROOM_ALLOWANCE.md`.** The per-student and
> per-classroom claim counters described here are unchanged, and are now the
> PRIMARY classroom allowance, surfaced to teachers as "ClaimChecks" rather than
> sitting behind a token budget. Three behaviours below have changed:
>
> * A classroom budget is derived from the classroom's OWN
>   `claim_limit_per_student`, not the server-wide default. Headroom now defaults
>   to 100%, so `class size × per student` is exact.
> * A failed analysis ALWAYS returns its reservation, including one that reached
>   a paid provider. Its tokens are charged to the new token safety ceiling
>   instead, so cost is still tracked without spending a student's ClaimCheck.
> * `claimcheck_reserve_claim` gained a fifth gate, the token safety ceiling,
>   evaluated last and reported as `TOKEN_SAFETY_LIMIT`.

Added 2026-08-22. Four layers that stand between a student pressing "Check
Claim" and a paid provider request, so no single student, classroom, or runaway
script can spend an unbounded amount of API credit.

Related: [`CLASSROOM_MODE.md`](CLASSROOM_MODE.md) for the classroom architecture
and the full privacy inventory.

---

## 1. The layers

| Layer | Scope | Default | Env var |
|---|---|---|---|
| Claim length | One submission | 750 characters | `CLAIMCHECK_MAX_CLAIM_CHARACTERS` |
| Per student | One anonymous student, one classroom | 12 claims | `CLAIMCHECK_STUDENT_SESSION_LIMIT` |
| Per classroom | All students in one classroom | 300 claims | `CLAIMCHECK_CLASSROOM_SESSION_LIMIT` |
| Global daily | The whole account, per UTC day | 1,000 claims | `CLAIMCHECK_GLOBAL_DAILY_LIMIT` |
| Global monthly | The whole account, per UTC month | 15,000 claims | `CLAIMCHECK_GLOBAL_MONTHLY_LIMIT` |

A classroom that records an expected class size gets a default limit derived
from the per-student allowance instead of the flat 300:

```
expected_students × CLAIMCHECK_STUDENT_SESSION_LIMIT × (CLAIMCHECK_CLASSROOM_HEADROOM_PERCENT / 100)
25 × 12 × 1.10 = 330
```

Deriving one from the other means raising the per-student limit raises the class
budget with it, rather than leaving a class unable to reach the allowance its
students were each promised. The 10% headroom exists because a class rarely
divides its work evenly — a budget set to the exact sum would strand the
heaviest users behind a classroom limit while quieter students still had unused
allowance.

Setting any limit to `0` disables that layer. All values live in
[`lib/limits.js`](lib/limits.js) and are read from the environment on every
call, so nothing needs redeploying to change a number — only the environment
variable.

---

## 2. Where enforcement happens

Every analysis, on both the public site and in a classroom, passes through one
of four route handlers, and each one calls `usage.reserveClaim()` immediately
before `analyzeClaim()`:

| Route | Layers applied |
|---|---|
| `POST /analyze` | global daily + monthly |
| `POST /analyze-url` | global daily + monthly |
| `POST /api/classroom/analyze` | student + classroom + global |
| `POST /api/classroom/analyze-url` | student + classroom + global |

`analyzeClaim()` in [`lib/analyze.js`](lib/analyze.js) is the only code that
talks to Anthropic, so a reservation that is refused means no provider request
is made at all — not a request that is made and then discarded.

### Ordering within a request

1. Shape validation (type, minimum length).
2. **Character limit** — refused here, so a too-long claim costs no allowance.
3. Missing API key check.
4. For URLs: article extraction. Extraction is a plain fetch and costs nothing,
   so it happens *before* the reservation and a page that cannot be read is
   free.
5. **Reservation** — atomic, all layers at once.
6. The paid pipeline.

---

## 3. The anonymous student id

Generated in the student's browser by
[`public/lib/student-id.js`](public/lib/student-id.js):

```
localStorage['claimcheck_student_id:<classroom-uuid>'] = crypto.randomUUID()
```

* **Random**, from the browser's CSPRNG. Not derived from a name, email, IP,
  device id, screen size, timezone, or any fingerprinting signal.
* **Per classroom.** Joining a second classroom mints a second id, so usage in
  one classroom is not linkable to the other.
* **Persistent across refreshes**, which is the point — an id that reset on
  reload would make the per-student limit meaningless.
* **Validated server-side** as a canonical UUID before it is used
  (`usage.normalizeStudentId`). A classroom request without one is refused, so
  the limit cannot be opted out of by omitting a header.

The browser sends it as `X-Claimcheck-Student`. It is a lookup key and nothing
more: the server reads the count and the cap from the database and ignores
anything the client believes about either.

**Shared-device trade-off** is documented in `CLASSROOM_MODE.md` §4.

---

## 4. Race safety

Reservation is a single Postgres function,
`claimcheck_reserve_claim`, in
[`supabase/migrations/002_usage_guardrails.sql`](supabase/migrations/002_usage_guardrails.sql).

The failure it exists to prevent:

```
read count        <- thirty students all read 11
if count < 12     <- thirty students all pass
run analysis      <- thirty analyses run
increment         <- the limit of 12 was exceeded by 18
```

Two properties make the real implementation safe:

1. **Fixed lock order.** Every call takes `SELECT … FOR UPDATE` on the global
   day row, then the global month row, then the classroom row, then the student
   row — always that order. Concurrent callers queue rather than deadlock.
2. **Evaluate, then write.** All four gates are checked before any counter
   moves, so a refused request leaves every counter exactly as it found it. A
   partial reservation would burn allowance for work that never ran.

`SELECT INTO` assigns NULL when it matches no row, and a NULL compares false
against every limit — which would fail open. Each count is therefore pinned with
`coalesce(…, 0)` immediately after being read.

---

## 5. What counts as a ClaimCheck

**Charged:** the backend accepted a valid request and is about to invoke the
paid pipeline.

**Not charged:**

* empty or too-short submissions
* claims over the character limit
* malformed requests
* requests refused by any of the four gates
* a URL that could not be fetched or parsed
* an analysis that failed *before any billable provider work*

That last case is decided rather than guessed. `runAgenticLoop` attaches the
usage accumulated so far to anything it throws, so
`usage.wasBillable(err)` can tell a rejected API key (zero tokens, zero
searches — refunded via `claimcheck_release_claim`) from a timeout on the third
search turn (tokens already spent — kept).

**Documented imperfection:** when the usage signal is missing entirely, the
request is assumed billable and the charge is kept. Over-counting costs a
student one claim; under-counting is a hole in the budget, so the ambiguous case
resolves toward the safe side. Release is also best-effort — if the release call
itself fails it is logged and the student loses one claim rather than the
request failing twice.

---

## 6. Resets

There is no scheduled job anywhere in this feature.

* **Global daily / monthly:** `global_usage` is keyed by a UTC calendar string
  (`2026-08-22`, `2026-08`). A new day or month has no row yet, so the first
  request creates one at zero. The budget "resets" because the key changed.
  UTC rather than local time so every serverless region agrees on the boundary.
* **Per student and per classroom:** these are scoped to a classroom, and a
  classroom is temporary. Counters die with the classroom —
  `classroom_student_usage` is `on delete cascade`. There is no mid-classroom
  reset; a teacher who needs to grant more raises
  `claim_limit_per_student` on the room, or opens a new classroom.
* `prune_global_usage()` exists for tidiness (drops rows older than 400 days)
  and is safe to call any time. Nothing depends on it running.

---

## 7. What students are never told

The global-limit message says the service is temporarily unavailable and stops.
It does not name a provider, a budget, a remaining balance, a spend figure, or a
token count, and there is a test asserting exactly that
(`test/guardrails.test.js`). `/api/limits` publishes the character cap and
nothing else — per-student, classroom, and account budgets are decided per
request and never published.

Students do see their own remaining ClaimChecks
("8 of 12 ClaimChecks remaining"), because that is actionable and is their own
figure.

---

## 8. Configuration checklist

Environment variables (all optional — the defaults above apply when unset) are
listed in [`.env.example`](.env.example).

The migration `supabase/migrations/002_usage_guardrails.sql` **must be applied
before the code is deployed.** Until it is, every reservation fails, and because
the guard is fail-closed (§9) every analysis is refused with a 503. Apply the
SQL first, then deploy.

---

## 9. Fail-closed behaviour

These guardrails exist for financial protection, so being unable to check a
quota means **do not spend money** — not "spend it anyway and hope".

When quota state cannot be established, every paid route refuses with
**HTTP 503** and code `USAGE_UNVERIFIED`:

> ClaimCheck is temporarily unable to verify usage limits. Please try again shortly.

This covers all three ways verification can fail:

| Situation | Behaviour |
|---|---|
| Database unreachable or erroring | Refuse. No opt-out. |
| Migration not applied (RPC returns no row) | Refuse. No opt-out. |
| Supabase not configured at all, in production | **Refuse.** No opt-out. |
| Supabase not configured at all, outside production | Refuse, unless `CLAIMCHECK_ALLOW_UNVERIFIED_USAGE=true` |

### The escape hatch cannot reach production

`CLAIMCHECK_ALLOW_UNVERIFIED_USAGE` exists only for a local checkout or a
self-hosted instance running on its own API key. It cannot do three things:

1. **Run in production.** `NODE_ENV=production` *or* `VERCEL` being set makes it
   inert regardless of its value, and logs an error saying so. Two signals
   rather than one, because a hand-rolled deployment can forget `NODE_ENV` and
   `VERCEL` only exists on Vercel.
2. **Override a broken database.** It is consulted only when Supabase is
   entirely unconfigured.
3. **Switch on by accident.** Opt-in, off by default.

The invariant this buys: **there is no production configuration in which paid
requests become unmetered.** Losing `SUPABASE_URL` in production takes
ClaimCheck offline — it never silently stops metering.

The refusal is deliberately distinct from `GLOBAL_LIMIT`, which also returns
503. Same status, different code and different copy: one means "come back
later", the other means "the account budget is spent". The underlying reason is
logged server-side; the user-facing message names no database, no provider, and
no internal detail.

**Operational consequence, stated plainly:** a Supabase outage now takes
ClaimCheck down rather than letting it run unmetered. That is the intended
trade — a lesson interrupted is recoverable, an unbounded bill is not — but it
puts Supabase availability on the critical path for every analysis, which it was
not before.
