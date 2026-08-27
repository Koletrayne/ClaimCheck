# Proposal: grounding the Identity Lens taxonomy

**Status: draft for comparison. Nothing here is implemented.** The prompt in
`lib/analyze.js` still carries the current twelve-item list. See
`CONTENT_PROVENANCE.md` for why this exists.

---

## The headline finding

Mapping the current list against a published framework was supposed to be a
citation exercise. It turned up **three real coverage gaps** instead — patterns
that are well-established precursors to intergroup harm and that the Identity
Lens currently has no label for, so it cannot flag them no matter how clearly
they appear in a claim.

That is the strongest argument for doing this. Grounding the taxonomy is not
just about being able to cite something; the current list has blind spots that
the grounding exercise exposes.

## Which framework, and the tradeoff

**The Dangerous Speech Project's "hallmarks" (Susan Benesch) is the right
anchor.** Of the candidates surveyed in `CONTENT_PROVENANCE.md`, it is the only
one that classifies *message-level rhetorical features* — which is exactly what
the Identity Lens does. Stanton's stages, Allport's scale, and the ADL pyramid
are all escalation or process models describing how a society moves toward
violence; they do not label the rhetoric of a single claim, and forcing them to
would misuse them.

**But adopting it wholesale would narrow the lens, and that would be a
regression.** DSP's hallmarks are calibrated for speech that raises the risk of
intergroup *violence*. Most of what students bring to ClaimCheck is ordinary
biased rhetoric — a sweeping generalization about a group, a stereotype, a
dog whistle — which is squarely in scope for a media-literacy tool but is not
dangerous speech in Benesch's sense. A pure DSP list would stop flagging most of
what the tool actually sees.

So the proposal is **two tiers**: the DSP hallmarks cited directly, plus a
general bias-rhetoric tier grounded where honest grounding exists.

---

## Tier 1 — Dangerous-speech hallmarks

Adapted from the Dangerous Speech Project's hallmarks framework (Susan Benesch
et al.). These describe rhetoric associated with elevated risk of intergroup
violence.

| Pattern | Status vs. current list | Notes |
|---|---|---|
| **Dehumanization** | Kept (renamed from "Dehumanizing language") | Describing a group as vermin, disease, animals, or otherwise less than human |
| **Accusation in a mirror** | **NEW — gap** | Asserting the target group is planning to attack "us," so pre-emptive action is justified. DSP's most distinctive hallmark |
| **Threat to group purity or integrity** | Replaces "Demographic threat narrative" | Framing the group as contaminating or diluting the in-group |
| **Alleged threat to women and girls** | **NEW — gap** | Claiming the group endangers "our" women and girls. Historically one of the most reliable precursors to intergroup violence |
| **Questioning in-group loyalty** | **NEW — gap** | Casting members of the group as disloyal, or as owing allegiance elsewhere — the "dual loyalty" trope |

### On the three gaps

These are not theoretical omissions.

**"Questioning in-group loyalty"** is the one I would prioritize. Dual-loyalty
accusations are a long-standing antisemitic trope and are also directed at
immigrant, Muslim, Asian American, and Latino communities. In a county as
diverse as Los Angeles this is a pattern students will encounter, and the
Identity Lens presently has no way to name it — the model would have to force it
into "Us-vs-them framing," which loses what makes it distinctive.

**"Alleged threat to women and girls"** is similarly concrete and similarly
unlabelable today; the nearest current option is "Criminality stereotyping,"
which describes a different move.

**"Accusation in a mirror"** is partially covered by "Replacement / invasion
narrative," but only for that one narrative. The general form — *they are coming
for us, so we must act first* — has no label.

---

## Tier 2 — Bias and stereotyping patterns

Broader patterns, kept because the tool needs them. Grounding is noted honestly:
some of these have a clean canonical citation and some are general descriptive
vocabulary with diffuse origins.

| Pattern | Status | Grounding |
|---|---|---|
| **Scapegoating** | Kept | Allport, *The Nature of Prejudice* (1954) |
| **Us-vs-them framing** | Kept | Tajfel & Turner, social identity theory (1979) |
| **Sweeping generalization** | Kept | Allport (1954), on categorization and stereotyping |
| **Coded or dog-whistle language** | Kept | Haney López, *Dog Whistle Politics* (2014); Mendelberg, *The Race Card* (2001) |
| **Replacement / invasion narrative** | Kept | Names a documented conspiracy theory (Camus, "Great Replacement"); sits at the intersection of Tier 1's accusation-in-a-mirror and purity hallmarks |
| **Criminality stereotyping** | Kept | Specific stereotype content; general literature, no single canonical source |
| **Religious or ethnic stereotype** | Kept | General descriptive vocabulary |
| **Gender essentialism** | Kept | Standard in gender studies; no single canonical source |
| **Pathologizing identity** | Kept | Used in disability- and queer-studies critique; diffuse |
| **Conspiracy framing** | Kept | General descriptive vocabulary |

Four Tier 2 entries have no clean citation. That is worth stating in the
published version rather than papering over — "general descriptive vocabulary"
is an honest label and better than a citation that does not really support the
term.

---

## What changes

- **15 patterns**, up from 12
- **3 added** — all Tier 1 gaps
- **2 renamed** — "Dehumanizing language" → "Dehumanization"; "Demographic
  threat narrative" → "Threat to group purity or integrity"
- **0 dropped**
- **Tier is new metadata** — Tier 1 findings carry more weight than Tier 2, and
  the UI could reflect that

## Before shipping this

1. **Verify the hallmark names and definitions against DSP's current published
   guide.** They are reproduced here from subject knowledge, and DSP has revised
   its materials over time. The exact wording matters if you are going to cite
   it — this is the one step that must not be skipped.
2. **Check DSP's terms for reuse and required attribution form.**
3. **Consider expert review.** A grounded taxonomy invites scrutiny of whether
   it was applied correctly, which is a fair trade but a real one.
4. **Decide whether 15 is too many** for the model to apply reliably. Worth an
   eval against the pilot's claims before and after.

## Implementation sketch

Two options, in the prompt's Identity Lens block:

- **Flat list** — replace the twelve labels with fifteen. Smallest change; loses
  the severity distinction.
- **Tiered** — add a `tier` field to each `patterns_observed` entry so the UI
  can weight Tier 1 findings. Better, and touches the schema, the website, the
  extension, and both export formats.

Either way, add a visible credit line to the Identity Lens section and the
export report — the attribution is the point, and it needs to reach the reader,
not just this file.
