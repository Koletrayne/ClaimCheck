# Content provenance

Most of what ClaimCheck shows a student is generated per-analysis by the model.
A small amount is **fixed editorial content**: strings authored once and baked
into the system prompt, which reach the student either verbatim or as a scheme
the model fills in — including in every exported PDF and Word report that leaves
the building.

How each one actually behaves was checked against live production output on
2026-08-19, and the two differ. That distinction is recorded below because it
changes what is being reproduced, and therefore what needs clearing.

Fixed content is different from generated content in one way that matters: a
deployment that redistributes it (a school district, a county) carries it under
its own name, so where it came from is worth knowing.

## Origin, confirmed 2026-08-19

**Both items below were produced by Claude during development sessions and
accepted as written. Neither was hand-authored, and neither was copied in from
an external curriculum, framework, or article.** This was confirmed by the
project owner, and it has two consequences that pull in opposite directions.

**Nobody is likely to own this text.** Under current U.S. Copyright Office
guidance and *Thaler v. Perlmutter*, material without human authorship is not
copyrightable. Purely model-generated strings are therefore probably not
ClaimCheck's to license, assign, or claim exclusivity over. That matters if a
deploying agency expects to own the tool's content outright — it should be told,
not discovered later.

**But "generated" is not the same as "cleared."** A model asked for a taxonomy
of hate-speech rhetorical patterns draws on training data that includes the
published frameworks in that field. Model-generated content is content of
*unverified* origin, not content of *known-original* origin. The real question is
therefore not "did someone copy this" but "does this substantially reproduce a
specific published framework." Section 3 records what checking that turned up.

---

## 1. The four reflection questions

**Location:** `lib/analyze.js`, the `reflection_questions` default in the output
schema. Rendered under "Reflection Questions" on the website, in the extension,
and in both export formats.

```
What exactly is the claim being made?
What sources support the claim?
What evidence contradicts the claim?
Who might benefit from spreading this narrative?
```

**What actually reaches the student: the scheme, not the wording.** Verified
against live output — the model treats these four as archetypes and rewrites
them for the specific claim. A real result for an EV-emissions claim returned
"Does 'lifetime emissions' include just driving, or also manufacturing and
disposal — and does the claim specify?" in slot one, and "Who funds or produces
the research on this topic, and could that affect how results are presented?" in
slot four. Same four moves — identify the claim, what supports it, what
contradicts it, who benefits — in wholly different words.

**Provenance: model-generated (see "Origin" above).**

The literal wording largely does not reach output, which removes the weaker half
of the concern. What is reproduced every time is the *scheme* — identify the
claim, what supports it, what contradicts it, who benefits — and a curated set
can attract compilation protection even where no individual element does, so
paraphrasing the elements would not by itself avoid the question.

In this case the scheme is close to universal argument-analysis scaffolding
rather than anything distinctive. The nearest well-known relative is Stanford's
Civic Online Reasoning triad (who is behind the information, what is the
evidence, what do other sources say) — similar in spirit, but three questions
rather than four and not the same three. Mike Caulfield's SIFT is a different
structure entirely. Nothing here suggests derivation from a particular source.

## 2. The rhetorical pattern taxonomy

**Location:** `lib/analyze.js`, the approved pattern set in the Identity Lens
instructions (step 6). The model may only name patterns from this list; each one
it selects is rendered in the Identity Lens section and carried into exports.

```
Dehumanizing language          Scapegoating
Conspiracy framing             Demographic threat narrative
Criminality stereotyping       Us-vs-them framing
Sweeping generalization        Replacement / invasion narrative
Religious or ethnic stereotype Gender essentialism
Coded or dog-whistle language  Pathologizing identity
```

**What actually reaches the student: the labels, verbatim.** Verified against
live output — the prompt constrains the model to name patterns *from this set*,
so the selected labels appear exactly as written. A real result for a
scapegoating claim returned "Sweeping generalization", "Criminality
stereotyping", and "Us-vs-them framing" as literal strings, each paired with a
model-written explanation. Unlike the reflection questions, this content is
reproduced word for word.

**Provenance: model-generated (see "Origin" above).** This is the more important
of the two, because both the wording and the arrangement reach output verbatim.

Why it matters: this is a curated twelve-item taxonomy, and taxonomies are the
classic case where selection and arrangement carries protection independently of
the individual labels. Several of these terms are also terms of art in the
established hate-speech and dangerous-speech literature — "dehumanization",
"us-vs-them", and "replacement narrative" all have identifiable scholarly
lineages. If the set was adapted from a published framework, attribution is
owed on academic-norms grounds regardless of how the copyright question lands,
and for an education deployment that attribution is also a credibility asset.

---

## 3. Comparison against the published frameworks

Since the taxonomy's origin is a model rather than a document, the useful check
is whether it tracks a specific published framework closely enough to be a
derivative of it. Compared against the frameworks it could plausibly descend
from:

| Framework | Structure | Overlap with the twelve |
|---|---|---|
| Dangerous Speech Project (Benesch) — "hallmarks" | 5 items | Only "dehumanization" |
| Stanton — 10 Stages of Genocide | Process model, 10 stages | Only "dehumanization" |
| Allport — Scale of Prejudice | Escalation model, 5 levels | None |
| ADL — Pyramid of Hate | Escalation model, 5 tiers | None |

Two observations from that comparison:

1. **The signature concepts of each framework are absent.** Benesch's most
   distinctive hallmark, "accusation in a mirror," does not appear; neither do
   her "threat to group integrity" or "questioning in-group loyalty." A
   derivative work normally carries the distinctive elements, not just the
   generic one.
2. **The only recurring overlap is the least protectable term.**
   "Dehumanization" appears across essentially every framework in the field
   precisely because it is standard descriptive vocabulary, not a curated
   choice.
3. **The structure does not match.** Three of the four published frameworks are
   escalation or process models — ordered stages. The ClaimCheck list is an
   unordered set of rhetorical moves. Selection *and arrangement* is the theory
   under which a taxonomy attracts protection, and neither matches.

The remaining items are general descriptive vocabulary drawn from several
different fields rather than one source: "scapegoating" (psychology),
"us-vs-them framing" (in-group/out-group, social identity theory), "coded or
dog-whistle language" (political science), "gender essentialism" (gender
studies), and "replacement / invasion narrative" (naming a real, publicly
identified conspiracy theory). The rest — "conspiracy framing," "sweeping
generalization," "criminality stereotyping," "demographic threat narrative,"
"religious or ethnic stereotype," "pathologizing identity" — are plain
descriptive compounds.

**Assessment: this reads as an assembly of widely-used terms of art from
multiple literatures, not a curated set taken from one.** That is the
best-available outcome for content of model origin.

**Caveats, stated plainly:** this comparison was done from subject knowledge,
not a systematic survey of the media-literacy and hate-speech curriculum
literature, and it is not a legal clearance. It reduces the concern; it does not
formally discharge it.

---

## The open question is pedagogical, not legal

Setting copyright aside, there is a question this file cannot answer and a county
reviewer or teacher is likely to ask: **why these twelve patterns and not
others?**

Right now the honest answer is that a language model proposed them and they were
accepted. That is defensible for a pilot and thin for a county deployment. The
list has no cited basis, no stated inclusion criteria, and no expert review — and
it is the component that renders a judgment about a student's material and prints
it into an exported report.

The move that resolves the legal residue and the pedagogical gap at once is to
**deliberately ground the taxonomy in a published framework and cite it.** Adopt
or adapt a named source, credit it in the Identity Lens UI and in the export
report, and record the mapping here. That converts "unverified origin" into
"explicitly derived from X, with credit," which is stronger than originality for
an educational tool: teachers trust a framework with a lineage more than one
without, and it gives a principled answer to "who decided these twelve."

If the list stays as-is, say so here and say why, so the choice is a documented
decision rather than an unexamined default.

**A drafted version of that grounding exists:** see
`IDENTITY_LENS_TAXONOMY_PROPOSAL.md`, which maps the current twelve onto the
Dangerous Speech Project's hallmarks. It is a proposal only — nothing in
`lib/analyze.js` has changed. Note that the mapping exercise surfaced three
patterns the current list cannot label at all, so this is a coverage question as
well as a provenance one.

---

## Keeping this current

If any fixed editorial content is added to the prompt later — another question
set, another taxonomy, another list of named categories — add it here at the
same time, and record whether it was written, sourced, or model-generated while
that is still known.

## What is NOT covered here

Everything the model generates per-analysis: verdicts, explanations, evidence
summaries, credibility and relevance notes, the Context Lens, and the identity
analysis prose. That content is produced fresh for each claim and is governed by
the paraphrase rules in the system prompt (see the "Rules" block in
`lib/analyze.js`), not by this file.
