# ClaimCheck Classroom Mode — Architecture & Data Handling

Classroom Mode lets an educator open a temporary ClaimCheck environment that
students enter with a short-lived code, without creating accounts or leaving a
record of who they are or what they checked.

This document describes what was built, what it stores, what it deliberately
does not store, and what still needs review. It is written to be read by
engineering, privacy, and security reviewers.

> **Scope note.** This document describes design and implementation choices. It
> does not assert compliance with any statute or standard. Whether this system
> is appropriate for a given deployment is a determination for legal, privacy,
> and security review, not something this document or the product claims.

---

## 1. System architecture

Classroom Mode is additive. The existing public ClaimCheck experience — the
homepage, the claim-analysis flow, accounts, history, and the browser extension
— is unchanged and does not depend on anything here. Classroom Mode stays
completely inert until `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set;
without them every classroom route returns `503`.

```
ClaimCheck (single Express app, single deployment)
│
├── Public ClaimCheck                     ← unchanged
│   ├── GET  /                            homepage
│   ├── POST /analyze, /analyze-url       claim analysis
│   └── POST /export                      PDF / Word
│
└── Classroom Mode                        ← new
    │
    ├── Pages (static, public/classroom/)
    │   ├── /classroom                    landing
    │   ├── /classroom/join               code entry
    │   ├── /classroom/<CODE>             direct-link join
    │   ├── /classroom/room.html          student environment
    │   └── /classroom/admin              teacher dashboard
    │
    └── API (/api/classroom)
        ├── Teacher   GET/POST/PATCH/DELETE /rooms, /rooms/:id/regenerate, /me
        └── Student   POST /join, GET /session, POST /analyze, /analyze-url
```

### Files added

| Path | Role |
|---|---|
| `supabase/migrations/001_classroom_mode.sql` | Schema, RLS policies, usage function |
| `lib/supabase-admin.js` | Server-side Supabase access (plain `fetch`, no SDK) |
| `lib/classroom.js` | Access codes, session tokens, classroom records |
| `lib/classroom-routes.js` | All classroom HTTP routes |
| `lib/pii.js` | Conservative PII detection |
| `public/classroom/*` | Landing, join, room, dashboard |
| `test/classroom.test.js`, `test/pii.test.js`, `test/usage.test.js` | Tests |

### Files modified

| Path | Change |
|---|---|
| `server.js` | Mounts the classroom router; adds the `/classroom/<CODE>` route; reports `classroomMode` in `/health` |
| `lib/analyze.js` | Accumulates Anthropic token usage (previously discarded) and exposes it as `_usage` |
| `public/app.js` | Five changes, each gated on `window.ccClassroom` being present |

Every `app.js` change is behind `if (CLASSROOM)` / `if (!CLASSROOM)`. On the
public homepage `window.ccClassroom` is undefined and the file behaves exactly
as before.

---

## 2. Authentication model

**Teachers** authenticate with their existing ClaimCheck Supabase account —
the same accounts, the same project, and the same browser session key
(`cc.sb.auth`) the main site uses, so a teacher already signed in on ClaimCheck
arrives at the dashboard already signed in.

Two things changed relative to the rest of ClaimCheck:

1. **The backend now verifies tokens.** Previously all auth was client-side.
   Classroom teacher routes send the Supabase access token as a bearer token,
   and the server verifies it against Supabase's own `/auth/v1/user` endpoint on
   every request. Delegating to Supabase (rather than validating a JWT locally)
   means a signed-out or deleted user is rejected immediately rather than
   staying valid until token expiry, and no JWT signing secret is needed here.

2. **An allowlist gates classroom creation.** Being signed in is not enough. The
   account must also appear in `classroom_educators`. Without this, anyone who
   can register a ClaimCheck account could allocate themselves a token budget
   against the shared Anthropic key.

Existing users are unaffected: nobody is converted into a teacher, no account
metadata is modified, and the allowlist is a separate table.

**Adding an educator** (administrator action, via the Supabase SQL editor):

```sql
insert into public.classroom_educators (email, note)
values ('teacher@school.edu', 'Added by <admin> on <date>');
```

**Students do not authenticate at all.** There is no student login, no
anonymous account, and no Supabase user created behind the scenes.

---

## 3. Student access model

```
Teacher creates classroom
        │
        ▼
Access code: 8 chars from a 31-symbol alphabet  →  ~39.6 bits of entropy
        │  (0/O and 1/I/L excluded so a projected code cannot be mistyped
        │   into a different valid code)
        ▼
Student enters the code at /classroom/join, or opens /classroom/<CODE>
        │
        ▼
Server validates: code exists, classroom active, not expired, budget remaining
        │
        ▼
Server mints an HMAC-SHA256 session token:
        payload = { c: <classroom uuid>, e: <expiry ms>, n: <random nonce> }
        signature = HMAC(payload, classroom.session_secret)
        │
        ▼
Token stored in the tab's sessionStorage; student enters the room
```

The session token is the only student-side state, and it is deliberately thin:

- **Random** — the nonce is 9 random bytes, so two students in the same
  classroom get unlinkable tokens.
- **Non-identifying** — the payload names a classroom and an expiry. There is no
  student identifier in it, because none exists anywhere in the system.
- **Short-lived** — expiry is `min(classroom end, now + 8 hours)`.
- **Classroom-specific** — signed with that classroom's own secret, so a token
  is meaningless to any other classroom.
- **Revocable** — rotating `classrooms.session_secret` invalidates every
  outstanding token for that classroom at once.
- **Stateless** — nothing is written to the database when a student joins. No
  row is created, so there is no student record to delete later.

`sessionStorage` rather than `localStorage` is deliberate: the token dies with
the tab, so a shared or lab computer does not carry one student's session to
whoever sits down next.

Every gate is re-checked server-side on **every** request — signature, expiry,
active flag, and remaining budget — not merely at join time. A classroom that
expires or is closed mid-lesson therefore removes students who are already
inside, not just new joiners. The student page also re-checks once a minute so
this happens promptly rather than at the next submission.

---

## 4. Database tables

Three new tables. None of them has a column that can hold student-authored
content or a student identifier.

### `classrooms`

| Column | Purpose |
|---|---|
| `id` (uuid, pk) | Internal id. Never exposed to students. |
| `owner_id` (uuid → auth.users) | The educator who created it |
| `display_name` (text, nullable) | Optional label shown to students |
| `access_code` (text, unique) | The code students type |
| `session_secret` (text) | Per-classroom HMAC key; never leaves the server |
| `created_at`, `expires_at` | Lifetime |
| `active` (bool) | Manual close |
| `token_budget`, `tokens_used` | Usage allowance and consumption |
| `analyses_run`, `searches_used` | Aggregate counters |

`access_code` is stored in plain text. It is a short-lived, low-sensitivity
credential meant to be displayed on a projector, and a teacher needs to
re-display it for late arrivals. It is protected by RLS (owner-only `SELECT`),
and student lookups go through the backend, which never returns the row.

### `classroom_educators`

Allowlist of accounts permitted to create classrooms: `email`, optional
`user_id`, `note`, `added_at`.

### `classroom_code_attempts`

Backs the code-guessing throttle: `ip_hash`, `attempted_at`. Client addresses
are stored as a **keyed HMAC digest, never in the clear**, and rows are pruned
after 24 hours by `prune_classroom_code_attempts()`.

### `classroom_student_usage`

Added 2026-08-22 by the usage guardrails. One row per (classroom, anonymous
student) holding a single integer: how many ClaimChecks that student has run in
that classroom.

| Column | Notes |
|---|---|
| `classroom_id` | FK to `classrooms`, `on delete cascade` |
| `student_id` | The anonymous UUID minted in the student's browser |
| `claims_used` | Integer counter, nothing else |
| `created_at` / `updated_at` | Timestamps |

Primary key `(classroom_id, student_id)`, which is also the only index the
lookups need.

### There is no student *identity* table

The original design had no student table at all. That is no longer literally
true, and this section is deliberately worded to say what changed rather than to
keep an obsolete claim alive.

What the usage table does and does not do:

* It stores a **counter keyed by a random UUID**, and nothing else. No name, no
  email, no IP, no device or browser fingerprint, no claim text, no results, no
  timestamps of individual submissions — just a running total.
* The UUID is generated in the student's browser by `crypto.randomUUID()`
  (`public/lib/student-id.js`) and is **scoped to one classroom**. The same
  browser joining a second classroom mints a second, unrelated id, so usage in
  one classroom cannot be linked to usage in another.
* Nothing in the system maps a UUID to a person. There is no lookup that turns
  `7f3a6c…` into a student, because no such association is ever recorded.
* Sessions are still stateless signed tokens. The usage row is not a session and
  does not authenticate anything; presenting an unknown id simply creates a new
  row with a zero counter.

**What genuinely changed for privacy:** an identifier now survives a tab close,
where previously nothing did. It lives in `localStorage` because a per-student
limit that resets on every page refresh is not a limit. The identifier is
random, per-classroom, and meaningless outside the counter it keys — but it is a
persistent pseudonymous identifier, and the honest description of this system is
"anonymous with a per-classroom usage pseudonym", not "stores nothing about
students".

**Shared-device consequence:** on a lab machine, the next student to join the
*same* classroom in the *same* browser profile inherits the previous student's
id and its spent allowance. That is a fairness cost, accepted because the
alternative — clearing the id on leave — would let any student reset their own
limit at will.

### Row Level Security

RLS is enabled on all three tables and was not disabled anywhere. Existing
`claim_checks` policies are untouched.

| Table | Client access |
|---|---|
| `classrooms` | `SELECT` only, only rows where `owner_id = auth.uid()` **and** the caller is an allowlisted educator |
| `classroom_educators` | `SELECT` only, only the caller's own row (cannot enumerate the list) |
| `classroom_code_attempts` | No policies and all grants revoked — backend only |
| `classroom_student_usage` | No policies and all grants revoked — backend only |
| `global_usage` | No policies and all grants revoked — backend only |

No `INSERT`/`UPDATE`/`DELETE` policy exists on any of these tables, so **every
client write is denied by RLS**. All mutations go through the backend's service
role. `session_secret` is additionally protected by a column-level grant so it
cannot be selected by a client even by an owner.

Students are anonymous and carry no JWT, so `auth.uid()` is null for them and
the owner policy never matches. They cannot read, enumerate, or modify any
classroom row, and the access code cannot be used to reach unrelated data —
it is not a database credential, only an argument to a backend route.

---

## 5. What student information is collected

**In the database: one integer per student per classroom, keyed by a random
UUID.** Nothing else. See `classroom_student_usage` above for why that counter
exists and what it deliberately is not.

The complete set of student-derived data anywhere in the system:

| Data | Where | Lifetime | Why it exists |
|---|---|---|---|
| Claim / URL text | Server memory, in flight only | Duration of the request | Required to perform the analysis |
| Analysis result | Server memory, then the student's browser | Until the tab is closed or the page reloads | It is the answer being returned |
| Session token | The tab's `sessionStorage` | Until the tab closes or the classroom ends | Proves which classroom the request belongs to |
| Hashed client address | `classroom_code_attempts`, on **failed** code attempts only | ≤ 24 hours | Rate-limits code guessing |
| Anonymous student id | The browser's `localStorage`, scoped per classroom | Until the browser's storage is cleared | Keys the per-student ClaimCheck counter |
| ClaimChecks used | `classroom_student_usage`, keyed by that id | Until the classroom is deleted | Enforces the per-student limit |

Nothing above identifies a student. The anonymous id and its counter are the
only student-derived rows that reach disk, alongside the hashed address on a
failed code guess.

## What is NOT collected

- Student names, emails, usernames, or accounts
- Student IDs, ages, birthdays, or grade levels
- Passwords or credentials of any kind
- Per-student search history or claim history
- Per-student analytics, behavioral profiles, or grades
- Cross-classroom identifiers (the anonymous id is per classroom by construction)
- Browser, canvas, font, audio, or any other fingerprinting
- Raw IP addresses as an identifier

**Qualified since 2026-08-22:** the system previously collected *no* identifier
that survived a tab close. It now stores one random per-classroom UUID in
`localStorage` to enforce the per-student ClaimCheck limit. It is pseudonymous
rather than anonymous, and it is described plainly rather than counted as
"nothing".
- Raw IP addresses (only a keyed hash, only on failed code attempts)

---

## 6. Data retention behavior

| Stage | Persisted? |
|---|---|
| Student submits a claim | No — held in memory for the request |
| Backend calls the AI provider | No |
| Result returned to student | No — rendered in the browser only |
| Analysis complete | Only aggregate counters increment: `tokens_used`, `analyses_run`, `searches_used` |

Concretely, in Classroom Mode:

- **No `claim_checks` rows are written.** `saveToHistory()` in `app.js` returns
  immediately when classroom mode is active. This is a single early return
  placed above every persistence path, so it cannot be bypassed by one of them.
- **Nothing is written to `localStorage`.** Verified in the browser: after a
  full classroom session, `localStorage` is empty.
- **`sessionStorage` holds only the session token and the classroom's own
  display fields** (`displayName`, `expiresAt`, `budgetRemaining`,
  `budgetTotal`) — all properties of the classroom, not the student.
- **Share links are disabled.** A ClaimCheck share URL encodes the entire claim
  and result into the address. That is exactly the sort of student work that
  should not outlive the session or travel outside the classroom, so the button
  is not rendered and inbound `#r=` links are ignored in classroom mode.
- **PDF / Word export is kept.** It is generated on demand and stored nowhere,
  so a student can hand work in without the platform retaining it.

The public ClaimCheck retention behavior is unchanged.

---

## 7. Expiration and deletion

Every classroom has a required `expires_at` (5 minutes to 30 days).

When a classroom expires or is closed:

1. The access code stops working — `isUsable()` fails and `/join` refuses it.
2. New students cannot enter.
3. Existing sessions are cut off — every request re-checks expiry and the active
   flag, and the student page re-checks once a minute.
4. Manual close additionally rotates `session_secret`, which invalidates all
   outstanding tokens immediately.
5. No student-generated content needs deleting, because none was stored.

**Retained after expiry** (classroom-level, aggregate only): creation date,
expiration date, total tokens consumed, total analyses, total searches. These
cannot identify a student or reconstruct anything a student typed.

**Deleting a classroom** removes the row and its counters entirely.

---

## 8. AI provider data flow

```
Student browser
   │  POST /api/classroom/analyze  { text, options }
   │  header: X-Classroom-Session  (classroom id + expiry only)
   ▼
ClaimCheck backend  ── session valid? active? not expired? budget left? ──▶ reject
   │
   ├── PII scan (advisory; never blocks, never logs matches)
   │
   ▼
Anthropic Messages API      ← API key lives only in server env
   │  claim text + system prompt
   │  (no student identifier, no classroom id, no session token is sent)
   ▼
ClaimCheck backend
   │  accumulate token usage across every turn
   │  debit the classroom budget (atomic)
   ▼
Student browser  ← result + remaining class allowance
```

The browser never holds or sends an AI provider credential; `ANTHROPIC_API_KEY`
is read only in `lib/analyze.js` on the server. Requests to Anthropic carry the
claim text and the prompt — they do **not** carry a student identifier, the
classroom id, the session token, or the access code.

Web search is a server-side tool executed by the Anthropic API, so search
queries derived from a claim reach Anthropic and its search provider. This is
the same behavior as public ClaimCheck.

---

## 9. Logging behavior

Classroom routes log operational facts only. The rule applied throughout
`lib/classroom-routes.js`: **never log claim text, analysis results, access
codes, or session tokens.**

What is logged:

```
[classroom] created <uuid> budget=100000
[classroom] join ok <uuid>
[classroom] analysis <uuid> tokens=12480 searches=3
[classroom] updated <uuid> fields=active,session_secret
[classroom] analyze failed for <uuid>: <error message>
```

Errors are logged with the classroom id and the failure, never the input that
caused it. Supabase transport failures unwrap `err.cause` so a DNS problem and
an expired certificate are distinguishable — a diagnostic improvement that also
applies to the rest of the app.

Security and error logging was not removed or weakened.

**Note:** the platform's own request logs (Vercel) record method, path, status,
timing, and client IP for every request, including classroom ones. Paths are
`/api/classroom/analyze` and carry no claim text or code, but the platform log
is outside the application's control and does contain client IPs. This is called
out again in §13.

---

## 10. Analytics

No analytics library, tag manager, or third-party script is loaded on any
classroom page. The student room loads no Supabase client and no auth library
either — verified in the browser (`window.supabase` and `window.ccAuth` are both
`undefined` there).

The only metrics that exist are the per-classroom aggregate counters used for
the budget: tokens consumed, analyses run, searches used. There is no
per-student measurement and no identifier that would make one possible.

---

## 11. Token accounting

ClaimCheck had **no** token tracking before this work — `lib/analyze.js`
discarded the Anthropic `usage` object entirely. Classroom budgets required
building it.

`runAgenticLoop` now accumulates usage across **every** turn. This matters
because each turn re-sends the whole accumulated message list, so a
research-heavy claim can bill several times what the final response alone
reports. Reading usage off the last turn would silently undercount and let a
class run far past its budget; `test/usage.test.js` pins this.

A classroom's budget is spent in a single unit:

```
tokens = input + output + cache_read + cache_creation
```

Web searches are counted separately (`searches_used`) for reporting, since the
provider bills them per request rather than per token.

Debits go through the `classroom_record_usage` Postgres function so the
increment is one atomic statement. A classroom is many students submitting at
once, and a read-modify-write from Node would lose debits under that
concurrency — verified with 10 concurrent debits landing exactly.

**Accounting is classroom-level only.** There is no per-student attribution, by
design and by construction: the request carries nothing that would identify a
student to attribute usage to.

**Known behavior:** the budget is checked *before* an analysis and debited
*after*, because the cost is not knowable in advance. A single request can
therefore push a classroom slightly past its budget; the next request is
refused. The alternative — refusing work that might have fitted — was judged
worse for a classroom.

---

## 12. Security controls

| Control | Implementation |
|---|---|
| Code entropy | 8 chars × 31-symbol alphabet ≈ 39.6 bits, CSPRNG with rejection sampling so no symbol is biased |
| Code expiry | Enforced on join and on every request |
| Code revocation | "New code" rotates both the code and the signing secret |
| Internal ids hidden | Students never receive `id`, `owner_id`, `access_code`, or `session_secret` |
| Rate limiting | 12 failed attempts per client per 15 minutes, counted in Postgres (survives serverless instance churn) plus an in-memory fast path |
| Server-side validation | Every classroom check runs on the server; the frontend gates nothing |
| Ownership checks | Verified against the authenticated token's user id; a classroom owned by someone else returns the same `404` as one that does not exist, so ids cannot be probed |
| Token integrity | HMAC-SHA256 with `crypto.timingSafeEqual` |
| RLS | Enabled on all new tables; no client write policy anywhere |
| Credential isolation | Service role key and Anthropic key are server-only; `.env` is gitignored |
| Input limits | 8 characters minimum, 8,000 maximum, matching public ClaimCheck |
| Budget bounds | 1,000–2,000,000 tokens; expiry 5 minutes–30 days; 50 active classrooms per educator |

Verified against the live database (26 checks): unauthenticated and forged-token
requests to every teacher route are rejected; wrong, malformed, and expired
codes are refused; tampered and cross-classroom tokens are rejected;
deactivation and secret rotation cut off live sessions.

---

## 13. Remaining privacy and security concerns

Honest list of what is unresolved or accepted.

1. **Platform request logs contain client IPs.** Vercel logs every request with
   its source IP, outside application control. Paths and bodies carry no claim
   text, but the correlation of IP → "was in a classroom at this time" exists in
   the hosting platform's logs. Reviewing Vercel's log retention settings is a
   deployment decision, not a code one.

2. **PII detection is deliberately narrow and will miss things.** It detects
   only strongly-structured identifiers (email, phone, SSN-shaped, street
   address, label-anchored student ID). It does **not** detect names, and a
   student writing "my teacher is Ms. Alvarez and I live near the water tower"
   is not flagged. Name detection was rejected because ClaimCheck's purpose is
   evaluating claims about named people — a detector that flagged "Did Marie
   Curie win two Nobel Prizes?" would train students to ignore the warning.
   It also warns **after** submission rather than blocking, so flagged text has
   already reached the AI provider.

3. **Known PII false positives**, accepted: phone-shaped numbers with separators
   quoted in an article, addresses of public buildings, "1600 Pennsylvania
   Avenue". Because the check only warns, these are a minor annoyance rather
   than a blocked analysis.

4. **The access code is stored in plain text.** Justified in §4, but it does mean
   database read access yields live classroom codes. Codes are short-lived and
   grant only the ability to run analyses against a class budget.

5. **Rate limiting depends on a trusted proxy.** `X-Forwarded-For` is used to
   identify clients. On Vercel this header is set by the edge and trustworthy.
   A direct-to-Node deployment without such a proxy would let a caller spoof the
   header and evade the throttle.

6. **A classroom can slightly overshoot its budget** — see §11.

7. **Usage debits can be lost on a database error.** If `classroom_record_usage`
   fails after a successful analysis, the student keeps their answer and the
   debit is dropped rather than failing the request. This is logged as an error.

8. **Claim text reaches Anthropic and its search provider.** Unavoidable for the
   product to function, and identical to public ClaimCheck, but it is the point
   at which student-typed text leaves ClaimCheck's control. If a student types
   personal information despite the notice, it goes with it.

9. **Anthropic's data retention applies to classroom requests.** ClaimCheck
   stores nothing, but requests to the provider are subject to that provider's
   own retention terms. Worth confirming against the account's agreement.

10. **`prune_classroom_code_attempts()` is not scheduled.** It is defined and
    safe to call, but nothing invokes it on a timer yet. A Supabase scheduled
    job (`pg_cron`) or a periodic call should be added, or hashed-address rows
    accumulate beyond the intended 24 hours.

11. **No QR code yet.** Listed as optional in the requirements and deferred; the
    dashboard provides the code and a copyable join link. See §15.

12. **Deleting a classroom deletes its usage totals.** Fine for privacy,
    but it means accounting history disappears too. If usage records are needed
    for administrative purposes, close classrooms rather than deleting them.

---

## 14. Data inventory

| Data | Why necessary | Where stored | Retention | How deleted | Third parties |
|---|---|---|---|---|---|
| Teacher account (email, id) | Identify who owns a classroom | Supabase `auth.users` (pre-existing) | Until the account is deleted | Existing account deletion | Supabase |
| Educator allowlist entry | Restrict who may spend the shared AI budget | `classroom_educators` | Until removed by an admin | `DELETE` by admin | Supabase |
| Classroom settings (name, code, expiry, budget) | Operate the session | `classrooms` | Until deleted by owner | Dashboard "Delete" | Supabase |
| `session_secret` | Sign and revoke student sessions | `classrooms` | Rotated on close/regenerate | With the row | Supabase (never sent to a browser) |
| Aggregate counters (tokens, analyses, searches) | Enforce and report the budget | `classrooms` | Until the classroom is deleted | With the row | Supabase |
| Hashed client address | Throttle code guessing | `classroom_code_attempts` | ≤ 24 hours | `prune_classroom_code_attempts()` | Supabase |
| Student session token | Prove which classroom a request belongs to | The student's tab (`sessionStorage`) | Tab close, or classroom end | Automatic | None |
| Claim text | Perform the analysis | Server memory in flight; sent to the AI provider | Not retained by ClaimCheck | N/A | **Anthropic** (+ its web-search provider) |
| Analysis result | Answer the student | Server memory; the student's browser | Until reload or tab close | Automatic | None |
| Theme preference | Avoid a light flash in dark mode | `localStorage` (`theme`) | Until cleared | Browser clear | None |

**Flagged as worth questioning:** the hashed client address is the only
student-adjacent value written to disk. It is necessary for the code-guessing
throttle the requirements asked for, is keyed-hashed rather than stored raw, is
written only on *failed* attempts, and expires within a day. If the throttle
were considered unnecessary, this row could be removed entirely and Classroom
Mode would then write nothing student-derived to disk at all.

---

## 15. Not implemented

**QR code for the join link.** Listed as optional. It was deferred rather than
half-built: a QR encoder that produces a plausible-looking but unscannable image
is worse than none, and there is no way to verify a real camera scan in the
development environment. The dashboard provides the access code in large type
and a one-click copyable join link, which covers the projector and hand-out
cases. If wanted, the join link is short enough for a QR version 3–4 at error
correction level M.

---

## 16. Setup

1. **Apply the migration** — paste `supabase/migrations/001_classroom_mode.sql`
   into the Supabase SQL editor and run it. It is idempotent.

2. **Set environment variables** (see `.env.example`):

   ```
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role key>   # server only, never client
   CLASSROOM_IP_HASH_SECRET=<32 random bytes, hex>
   ```

   Generate the hash secret with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **Add at least one educator:**

   ```sql
   insert into public.classroom_educators (email, note)
   values ('teacher@school.edu', 'Initial administrator');
   ```

4. **Verify** — `GET /health` should report `"classroomMode": true`.

Until step 2 is complete, Classroom Mode is invisible and every classroom route
returns `503`. The public ClaimCheck experience works either way.

---

## 17. Tests

```bash
npm test
```

Covers access-code entropy and distribution, session token forgery, tampering,
expiry, cross-classroom reuse and revocation, classroom gating, view shaping
(no secret leakage), token accounting across multi-turn loops, and PII
detection — including a block of real fact-checking claims that must **not** be
flagged.
