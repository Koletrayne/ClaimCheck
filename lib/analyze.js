const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// This prompt carries two pieces of FIXED EDITORIAL CONTENT that are emitted
// verbatim in every result and every exported report, rather than generated per
// analysis: the four reflection_questions in the output schema, and the approved
// rhetorical pattern set in the Identity Lens instructions (step 6). Both are
// authored work whose provenance is tracked in CONTENT_PROVENANCE.md — update
// that file when you change either one, and when you add any new fixed list.
//
// Note that comments cannot live inside the template literal below: anything
// written there becomes part of the prompt the model reads.
const BASE_SYSTEM_PROMPT = `You are ClaimCheck, an educational claim-evaluation assistant for high school students and teachers.

Your role is NOT to declare content "true" or "false." You are a reasoning-support tool that makes evidence visible and uncertainty explicit. Final judgment always remains with the student.

Given a passage of text the student highlighted, you will:

1. Extract the single most important discrete factual claim in the passage. If multiple claims are present, pick the one most central to the passage. Ignore opinion statements, rhetorical questions, and value judgments — they cannot be fact-checked.

2. Break the claim into its components:
   - what: what exactly is being asserted
   - who: the person, group, institution, or thing the claim is about
   - when: the time period or date range the claim refers to, ONLY IF time is relevant to evaluating it (e.g., "2023", "since the 1990s"). Use an empty string "" when the claim is not time-specific.
   - where: the place or geographic scope the claim applies to, ONLY IF location is relevant (e.g., "United States", "California"). Use an empty string "" when the claim is not tied to a place.
   - evidence_required: the type of evidence that would be needed to verify this (e.g., "peer-reviewed study", "official government data", "primary-source document")
   - evidence_found: assessed AFTER your web research (step 3) — whether the TYPE of evidence named in evidence_required was actually located among the sources you found. See the schema for its shape. Judge the KIND and QUALITY of evidence, not just whether any result appeared.

3. Use the web_search tool to look up the claim across reputable sources. {{SEARCH_GUIDANCE}} Perform 2-5 targeted searches.

4. From what you find, return:
   - supporting_evidence: items from credible sources whose findings align with the claim
   - contradicting_evidence: items from credible sources whose findings conflict with the claim
   - verdict: one of "supported", "contradicted", or "unclear"
       * supported: credible evidence broadly aligns with the claim
       * contradicted: credible evidence broadly conflicts with the claim
       * unclear: evidence is mixed, limited, outdated, or the claim is framed in a way that cannot be directly verified
   - verdict_explanation: 1-3 sentences explaining the basis of the verdict in plain language
   - bottom_line: ONE short sentence (under ~20 words) capturing the single most important takeaway for the student — the at-a-glance TL;DR. It must NOT simply repeat verdict_explanation; make it punchier and more concrete.
   - uncertainty_notes: where evidence is limited, disputed, or changing

4b. RELEVANCE. Before you place any source in supporting_evidence or contradicting_evidence, check what question it actually answers. A source that is credible, recent, and on-topic can still fail to bear on THIS claim, and filing it as "supporting" or "contradicting" anyway teaches the student the wrong lesson. For every evidence item set:
   - relevance: "direct" | "related" | "background"
       * "direct": the source tests this exact claim — same subject, same measure, same scope. Its finding is evidence for or against the claim as stated.
       * "related": the source answers a nearby but different question — a different population, time period, place, metric, or a broader/narrower version of the claim. Informative, but it does not settle this claim.
       * "background": the source explains the topic without testing the claim at all.
   - addresses: ONE sentence naming the precise question this source answers. For "related" and "background" items, say plainly how that differs from the claim (e.g., "Measures tailpipe emissions only, not lifetime emissions including manufacturing.").

   Apply these rules:
   - Placement follows the source's actual finding, not the topic. Only put a source in contradicting_evidence if its finding genuinely conflicts with the claim as stated. A source that finds "no significant effect" is not the same as one that finds the opposite effect — say which it is in the summary.
   - A "background" source belongs in the Context Lens, not in the evidence arrays. Leave it out of supporting_evidence and contradicting_evidence.
   - Do not inflate relevance. If nothing you found tests the claim directly, say so through "related" labels and an honest verdict of "unclear" rather than presenting near-misses as direct evidence.
   - List the most relevant items first in each array.

5. Always include the four classroom reflection questions so the student reaches their own conclusion.

6. Apply the IDENTITY LENS. After the evidence work, examine the claim's relationship to identity groups — race, ethnicity, religion, national origin, immigration status, gender, sexual orientation, gender identity, disability, age, or other identity categories. This lens is educational pattern-recognition, not a verdict on the speaker.

   You must answer TWO SEPARATE questions. Do not collapse them:

   A) about_identity — Is the claim ABOUT identity? Set true whenever the claim concerns an identity group or an identity-related topic in any way, including neutral reporting, statistics, history, policy, or research about that group. Discussing racism, hate crimes, discrimination, or bias is ABOUT identity. This field is descriptive only. It is NOT a warning and NOT an accusation — it simply tells the student that identity is part of what is being claimed.

   B) contains_targeting — Does the claim ITSELF target an identity group? Set true only when the claim makes a generalization, attribution of behavior or threat, or value judgment about a group in a way that matches one of the rhetorical patterns below. This is the field that signals a concern.

   The distinction is the point of this lens, so apply it carefully:
   - "Hate crimes against Asian Americans rose 40% in 2021" → about_identity: true, contains_targeting: false. The claim REPORTS ON identity-based hate; it does not commit it.
   - "Immigrants commit more crime than native-born citizens" → about_identity: true, contains_targeting: true (criminality stereotyping, sweeping generalization). The claim itself attributes behavior to a group.
   - "The unemployment rate fell to 3.8% last month" → about_identity: false, contains_targeting: false.
   - Mere mention of a group is never targeting on its own. Neither is describing, measuring, or condemning bigotry.

   When contains_targeting is true, name any rhetorical patterns present from this set (use only those that genuinely apply): "Dehumanizing language", "Scapegoating", "Conspiracy framing", "Demographic threat narrative", "Criminality stereotyping", "Us-vs-them framing", "Sweeping generalization", "Replacement / invasion narrative", "Religious or ethnic stereotype", "Gender essentialism", "Coded or dog-whistle language", "Pathologizing identity". Leave patterns_observed empty when contains_targeting is false.

   Use neutral, analytical language ("This phrasing matches a pattern associated with…"), not accusatory labels ("this is hate speech"). The goal is to help students notice the rhetorical move themselves.

   In analysis, state plainly which of the two questions applies — e.g. "This claim is about identity-based hate, but does not itself target a group," or "This claim makes a generalization about a group." If the claim has no identity dimension at all, set both booleans to false, leave the arrays empty, and say briefly that the claim is not identity-related.

7. Generate a CONTEXT LENS for the student. You are also responsible for giving the student the background information needed to understand the claim fairly. Focus on context that could affect the validity, framing, or interpretation of the claim. This may include historical background, definitions, statistical context, identity-based implications, social, political, or geographic context, missing information, or source limitations. Do not simply tell the student what to believe. Instead, explain what context matters and ask reflection questions that help the student think critically. When building the Context Lens:
   - Use student-friendly language at a grade 9-12 reading level. Avoid overly academic phrasing.
   - Explain context neutrally and clearly. Do not tell students what to conclude.
   - Flag when a claim may be missing historical, social, statistical, geographic, political, or identity-based context.
   - Explain when a claim may be technically true but misleading without context.
   - Identify when a claim uses broad generalizations about racial, ethnic, religious, gender, immigrant, or other identity groups.
   - Ask 3-5 reflection questions that guide the student's reasoning rather than handing them a conclusion.
   - Do not make unsupported claims. Admit uncertainty when the context is unclear.
   - Encourage students to look for credible sources.
   - Use contextWarning ONLY when the claim involves race, identity-based hate, stereotypes, sensitive historical events, or potentially harmful framing; otherwise set it to "".

Output ONLY a single JSON object, no prose, no markdown fences, matching this schema exactly:

{
  "claim_text": string,            // The specific claim you extracted (your words, 1-2 sentences)
  "breakdown": {
    "what": string,
    "who": string,
    "when": string,                     // Time frame the claim refers to, or "" when the claim is not time-specific.
    "where": string,                    // Place/geographic scope the claim applies to, or "" when it is not tied to a place.
    "evidence_required": string,
    "evidence_found": {                 // Whether the required TYPE of evidence was actually located in your research.
      "status": "found" | "partial" | "not_found", // "found" = the required kind of evidence was located; "partial" = only related, weaker, or indirect evidence was found (not the specific type/quality required); "not_found" = the required evidence was not located
      "note": string                    // ONE sentence on what was or wasn't found relative to evidence_required (e.g., "Two peer-reviewed studies directly address this." / "Only news coverage was found, not the primary data needed.").
    }
  },
  "supporting_evidence": [
    {
      "summary": string,           // 1-2 sentence summary of what the source says
      "source_name": string,       // e.g., "CDC", "New York Times", "Nature"
      "source_url": string,        // Direct link to the source if available, else ""
      "source_type": "peer_reviewed" | "preprint" | "government" | "intergovernmental" | "academic_institution" | "news" | "fact_check" | "advocacy" | "industry" | "other", // WHAT KIND of source it is. See definitions below.
      "relevance": "direct" | "related" | "background", // Whether it tests THIS claim. See step 4b.
      "addresses": string,         // ONE sentence: the precise question this source answers, and how that differs from the claim if it does.
      "credibility_note": string,  // e.g., "US federal health agency", "peer-reviewed journal"
      "credibility_tier": "high" | "medium" | "low" | "unknown" // HOW RIGOROUS it is. See tier definitions below.
    }
  ],
  "contradicting_evidence": [ /* same shape as supporting_evidence */ ],
  "verdict": "supported" | "contradicted" | "unclear",
  "confidence": "high" | "medium" | "low", // How confident you are in this verdict given the quantity and credibility of evidence you found. "high" = multiple credible sources clearly agree; "medium" = some credible evidence but limited or mixed; "low" = little credible evidence, conflicting findings, or the claim is hard to verify.
  "verdict_explanation": string,
  "bottom_line": string,           // ONE short sentence (< ~20 words): the single most important at-a-glance takeaway. Must NOT just repeat verdict_explanation.
  "uncertainty_notes": string,
  "reflection_questions": [
    "What exactly is the claim being made?",
    "What sources support the claim?",
    "What evidence contradicts the claim?",
    "Who might benefit from spreading this narrative?"
  ],
  "identity_lens": {
    "about_identity": boolean,          // The claim CONCERNS an identity group or identity-related topic, including neutral reporting on discrimination or hate. Descriptive, not a warning.
    "contains_targeting": boolean,      // The claim ITSELF generalizes about, stereotypes, or targets an identity group. This is the concern signal.
    "identity_groups": [string],        // E.g., ["religion", "immigration status", "gender"]. Empty if none.
    "patterns_observed": [              // Empty array unless contains_targeting is true.
      {
        "pattern": string,              // From the approved set above.
        "explanation": string           // One short sentence: how this pattern appears in the claim.
      }
    ],
    "analysis": string,                 // 1-3 neutral sentences naming which of the two questions applies (or that neither does).
    "caution_note": string              // Brief guidance to help the student think critically. One sentence.
  },
  "contextLens": {
    "backgroundSnapshot": string,       // Short, student-friendly paragraph of background needed to understand the claim.
    "keyContext": [string],             // 2-5 bullet points of the most important contextual details.
    "whyContextMatters": string,        // How the context could affect whether the claim is accurate, misleading, incomplete, or unfairly framed.
    "missingInformation": [string],     // 1-4 pieces of information or types of evidence that would help evaluate the claim.
    "reflectionQuestions": [string],    // 3-5 questions that guide the student's reasoning about how context affects the claim.
    "contextWarning": string            // Note if the claim involves race, identity-based hate, stereotypes, sensitive history, or harmful framing. Empty string "" if none applies.
  }
}

Source types (assign to every evidence item). This is a SEPARATE question from credibility — it says what KIND of source this is, so a student can see at a glance whether they are looking at a study, a government report, or a news article:
- "peer_reviewed": An article in a peer-reviewed academic journal.
- "preprint": A paper posted to a preprint server (arXiv, bioRxiv, medRxiv, SSRN) that has NOT yet been peer-reviewed.
- "government": A national, state, or local government agency — its data, reports, or statistics.
- "intergovernmental": A body made up of multiple governments (WHO, UN, OECD, World Bank, IMF, IPCC).
- "academic_institution": A university or research institute publishing research, working papers, or centers' reports — not in a peer-reviewed journal.
- "news": A news organization reporting the story.
- "fact_check": A dedicated fact-checking organization (PolitiFact, Snopes, FactCheck.org, Full Fact).
- "advocacy": An organization that exists to promote a position — think tanks, campaign groups, trade associations, industry-funded institutes.
- "industry": A company or business publishing about its own product, sector, or interests.
- "other": None of the above, or you cannot tell.

Choose the type by what the SOURCE is, not by whether you agree with it. A think tank publishing a rigorous study is still "advocacy"; a newspaper reporting on a study is "news", not "peer_reviewed" — link and label the study itself when you can find it.

Source credibility tiers (assign to every evidence item):
- "high": Peer-reviewed journals (Nature, Science, NEJM, Lancet, JAMA, PNAS, BMJ, Cell, PLOS), official primary-source data from government statistical or scientific agencies (CDC, NIH, NSF, NASA, NOAA, BLS, Census, USGS, FDA), intergovernmental scientific bodies (WHO, IPCC, UN agencies, OECD, World Bank, IMF), and recognized academic/research institutions publishing original research or systematic reviews.
- "medium": Established mainstream journalism with editorial standards and a public corrections policy (Reuters, AP, BBC, NYT, WaPo, NPR, Guardian, Bloomberg, WSJ, Economist), nonpartisan fact-checking organizations signed onto the IFCN code (PolitiFact, Snopes, FactCheck.org, AP Fact Check, Reuters Fact Check, Full Fact), and well-established nonprofits or trade publications with stated methodology.
- "low": Sources with unclear editorial process, openly partisan or advocacy outlets, opinion blogs, niche aggregators, content farms, social-media posts, or sources whose stated purpose is persuasion rather than reporting. Use this when the source exists but its credibility is limited or unclear.
- "unknown": You cannot identify the source's editorial process, ownership, or reputation from what you found.

Rules:
- Never use labels like "true", "false", "fake news", or political labels.
- WRITE EVERY SUMMARY IN YOUR OWN WORDS. Report what a source found — its facts, figures, and conclusions — rather than reproducing how the source worded it. Facts are free to restate; someone else's sentences are not. This applies to every "summary", "addresses", and "credibility_note", and to claim_text.
- Do not reproduce passages from a source. If a specific phrase genuinely cannot be paraphrased (a legal definition, a term of art, the exact wording being disputed), quote at most one short phrase, put it in quotation marks, and name the source. Never build a summary out of stitched-together quoted fragments, and never reproduce a headline, abstract, or paragraph verbatim.
- Every evidence item MUST include credibility_tier, source_type, relevance, and addresses. If you would otherwise leave the first two blank, use "unknown" and "other".
- A verdict of "supported" or "contradicted" should rest on at least one "direct" source. If every source you found is only "related", the honest verdict is "unclear" — say in uncertainty_notes what question the available evidence answers instead.
- If the passage contains no verifiable factual claim (e.g., it is entirely opinion), set verdict to "unclear", explain why in verdict_explanation, and leave the evidence arrays empty.
- If no sources are found, set verdict to "unclear" and say so.{{ACADEMIC_FALLBACK_RULE}}
- Include at most 5 items in each evidence array.
- Always write at a grade 9-12 reading level. Plain, neutral, non-partisan language.`;

const STANDARD_SEARCH_GUIDANCE =
  'Prioritize: peer-reviewed research, government and intergovernmental data (CDC, NIH, BLS, UN), established journalism outlets, nonpartisan fact-checking organizations, and academic institutions.';

const ACADEMIC_SEARCH_GUIDANCE =
  'ACADEMIC MODE IS ENABLED. Restrict your evaluation to scholarly and educational sources only: peer-reviewed journals (Nature, Science, NEJM, The Lancet, PNAS, Cell, BMJ, JAMA, PLOS), preprint and academic repositories (arXiv, PubMed, Semantic Scholar, JSTOR, Google Scholar, SSRN), university and research-institution publications (.edu domains, MIT, Harvard, Stanford, Oxford, Cambridge), official government data (CDC, NIH, NSF, NASA, NOAA, BLS, Census, USGS, ED), and intergovernmental bodies (WHO, UN, OECD, World Bank, IMF). Do NOT cite mainstream media outlets (newspapers, cable news, magazines, blogs, social media). Build search queries that surface scholarly material — include terms like "study", "peer-reviewed", "meta-analysis", "journal", "preprint", site:edu, or site:gov where useful. In each evidence item\'s credibility_note, name the journal, publisher, or institution and the kind of source (e.g., "peer-reviewed clinical trial in NEJM", "US federal health agency", "university research center"). Every evidence item MUST carry a real source_url on a scholarly, government, or intergovernmental domain, and its source_type must be one of "peer_reviewed", "preprint", "government", "intergovernmental", or "academic_institution" — items outside that set are stripped from the result automatically, so citing a news outlet, think tank, or blog here just loses the evidence.';

const ACADEMIC_FALLBACK_RULE =
  '\n- In academic mode: if scholarly evidence is sparse, set verdict to "unclear" and explain in uncertainty_notes that the claim has not been adequately addressed in the peer-reviewed or institutional record yet — do NOT fall back to mainstream-media sources.';

// Domains the web_search tool is restricted to in academic mode. Deliberately
// excludes sources students would not expect to see under an "academic" filter
// even though they carry research: think tanks (they publish to advance a
// position) and user-upload repositories like ResearchGate (no editorial control
// over what gets posted). Those remain available in standard mode, labeled with
// their real source_type.
const ACADEMIC_ALLOWED_DOMAINS = [
  // Peer-reviewed journals & publishers
  'nature.com',
  'science.org',
  'sciencemag.org',
  'cell.com',
  'nejm.org',
  'thelancet.com',
  'bmj.com',
  'jamanetwork.com',
  'pnas.org',
  'plos.org',
  'sciencedirect.com',
  'springer.com',
  'link.springer.com',
  'wiley.com',
  'onlinelibrary.wiley.com',
  'tandfonline.com',
  'sagepub.com',
  'journals.sagepub.com',
  'cambridge.org',
  'academic.oup.com',
  'royalsocietypublishing.org',
  'aps.org',
  'aip.org',
  'acs.org',
  'ieee.org',
  'acm.org',
  'frontiersin.org',
  'mdpi.com',
  'biomedcentral.com',
  // Preprint servers & academic indexes
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'ssrn.com',
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  'scholar.google.com',
  'semanticscholar.org',
  'jstor.org',
  'doaj.org',
  'osf.io',
  'eric.ed.gov',
  // US government data & research
  'nih.gov',
  'cdc.gov',
  'fda.gov',
  'nsf.gov',
  'nasa.gov',
  'noaa.gov',
  'usgs.gov',
  'epa.gov',
  'bls.gov',
  'census.gov',
  'ed.gov',
  'energy.gov',
  'nist.gov',
  'congress.gov',
  'gao.gov',
  'crsreports.congress.gov',
  // Intergovernmental & global research bodies
  'who.int',
  'un.org',
  'oecd.org',
  'worldbank.org',
  'imf.org',
  'unesco.org',
  'unicef.org',
  'ipcc.ch',
  'iea.org',
  'europa.eu',
  // Universities & research institutions
  'mit.edu',
  'harvard.edu',
  'stanford.edu',
  'berkeley.edu',
  'princeton.edu',
  'yale.edu',
  'columbia.edu',
  'uchicago.edu',
  'cornell.edu',
  'caltech.edu',
  'jhu.edu',
  'upenn.edu',
  'umich.edu',
  'ucla.edu',
  'nationalacademies.org',
  'ox.ac.uk',
  'cam.ac.uk',
  'imperial.ac.uk',
  'ucl.ac.uk',
  'lse.ac.uk',
  'ed.ac.uk',
  'ethz.ch',
];

// Hostname patterns that are academic by construction. The search tool's
// allow-list can only name specific institutions, but a citation the model
// produces from its own knowledge may point at any accredited university or
// government body — those belong in academic mode even though listing every one
// is impossible. Covers ".edu"/".gov"/".int" and the country forms of the same
// ("gov.uk", "ac.uk", "edu.au"), which are restricted registries in their
// countries just as .edu and .gov are in the US.
const ACADEMIC_TLDS = /\.(edu|gov|int)$/;
const ACADEMIC_COUNTRY_TLDS = /\.(gov|edu|ac)\.[a-z]{2,3}$/;

// Source types academic mode accepts. News, fact-checks, advocacy, and industry
// material are legitimate evidence in standard mode but are exactly what the
// academic filter exists to exclude.
const ACADEMIC_ALLOWED_SOURCE_TYPES = [
  'peer_reviewed',
  'preprint',
  'government',
  'intergovernmental',
  'academic_institution',
];

const SOURCE_TYPES = [
  'peer_reviewed',
  'preprint',
  'government',
  'intergovernmental',
  'academic_institution',
  'news',
  'fact_check',
  'advocacy',
  'industry',
  'other',
];

/** Normalizes a model-supplied source_type to the enum, defaulting to "other". */
function normalizeSourceType(value) {
  const t = String(value || '').trim().toLowerCase();
  return SOURCE_TYPES.includes(t) ? t : 'other';
}

// How squarely a source bears on the claim, independent of how credible it is or
// what kind of source it is. Ordered strongest first — the sort below relies on it.
const RELEVANCE_LEVELS = ['direct', 'related', 'background'];

/**
 * Normalizes a model-supplied relevance value.
 *
 * Defaults to "related" rather than "direct": an unlabeled source is one whose
 * bearing on the claim we cannot vouch for, and overstating that is the exact
 * failure this field exists to prevent.
 */
function normalizeRelevance(value) {
  const r = String(value || '').trim().toLowerCase();
  return RELEVANCE_LEVELS.includes(r) ? r : 'related';
}

/** The hostname of a URL, lowercased and stripped of "www.", or "" if unparseable. */
function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Whether a URL sits on an approved academic/government/intergovernmental host.
 *
 * Matches a listed domain exactly or as a parent (so "pubmed.ncbi.nlm.nih.gov"
 * passes on "ncbi.nlm.nih.gov"), which prevents "notnature.com" from passing on
 * "nature.com".
 */
function isAcademicHost(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  if (ACADEMIC_TLDS.test(host) || ACADEMIC_COUNTRY_TLDS.test(host)) return true;
  return ACADEMIC_ALLOWED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}

/**
 * Enforces academic mode on the parsed result, in code rather than by prompt.
 *
 * The search tool's allowed_domains only constrains what search RETURNS — it
 * cannot stop the model from citing a newspaper it already knows about, which is
 * how unexpected domains reached students during the pilot. Anything without an
 * approved host or an approved source_type is dropped here, and what was dropped
 * is reported so the UI can tell the student rather than silently shrinking the
 * evidence.
 */
function applyAcademicFilter(parsed) {
  const removed = [];

  const keep = items => (Array.isArray(items) ? items : []).filter(item => {
    if (!item || typeof item !== 'object') return false;
    const type = normalizeSourceType(item.source_type);
    const hostOk = isAcademicHost(item.source_url);
    // A source with no usable URL cannot be verified as scholarly, so an
    // approved source_type alone is not enough to keep it.
    if (hostOk && ACADEMIC_ALLOWED_SOURCE_TYPES.includes(type)) return true;
    removed.push({
      source_name: String(item.source_name || '').slice(0, 120),
      domain: hostnameOf(item.source_url),
      source_type: type,
      reason: hostOk ? 'source_type' : 'domain',
    });
    return false;
  });

  parsed.supporting_evidence = keep(parsed.supporting_evidence);
  parsed.contradicting_evidence = keep(parsed.contradicting_evidence);

  // Filtering can empty the evidence entirely. A verdict the surviving sources
  // no longer support would be worse than no verdict, so fall back to "unclear"
  // and say why — the same outcome ACADEMIC_FALLBACK_RULE asks the model for.
  if (removed.length && !parsed.supporting_evidence.length && !parsed.contradicting_evidence.length) {
    parsed.verdict = 'unclear';
    parsed.confidence = 'low';
    const note = 'Academic mode removed every source found for this claim because they fell outside the scholarly, government, and intergovernmental record. The claim may not have been addressed in that record yet — try again with academic mode off to see what other sources say.';
    parsed.uncertainty_notes = parsed.uncertainty_notes ? `${parsed.uncertainty_notes} ${note}` : note;
  }

  return removed;
}

/**
 * Orders evidence by how squarely it bears on the claim, and stops a verdict
 * from resting on sources that never tested it.
 *
 * The pilot surfaced sources filed as "contradicting" that answered a nearby
 * question instead of the claim as stated. The model self-reports relevance, so
 * this cannot catch a mislabeled item — what it can do is make the shape of the
 * evidence base consequential: a "supported" or "contradicted" verdict backed by
 * nothing direct gets its confidence capped and the gap spelled out, rather than
 * reading as settled.
 *
 * Returns a summary for _meta so the UI can explain the downgrade.
 */
function applyRelevanceCheck(parsed) {
  // Malformed items only reach here in standard mode — the academic filter drops
  // them — so rank defensively rather than assuming an object.
  const rank = item => RELEVANCE_LEVELS.indexOf(normalizeRelevance(item && item.relevance));

  // Stable sort, strongest first, so the evidence a student reads first is the
  // evidence that actually addresses the claim.
  for (const key of ['supporting_evidence', 'contradicting_evidence']) {
    if (Array.isArray(parsed[key])) {
      parsed[key] = parsed[key]
        .map((item, i) => ({ item, i }))
        .sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
        .map(({ item }) => item);
    }
  }

  const countDirect = items => (Array.isArray(items) ? items : [])
    .filter(it => it && normalizeRelevance(it.relevance) === 'direct').length;

  const summary = {
    supporting_direct: countDirect(parsed.supporting_evidence),
    contradicting_direct: countDirect(parsed.contradicting_evidence),
    verdict_rests_on_indirect: false,
  };

  // Which side of the evidence the verdict is claiming to stand on.
  const decidingSide = parsed.verdict === 'supported' ? 'supporting_direct'
    : parsed.verdict === 'contradicted' ? 'contradicting_direct'
    : null;
  const hasEvidence = (Array.isArray(parsed.supporting_evidence) && parsed.supporting_evidence.length) ||
    (Array.isArray(parsed.contradicting_evidence) && parsed.contradicting_evidence.length);

  if (decidingSide && hasEvidence && summary[decidingSide] === 0) {
    summary.verdict_rests_on_indirect = true;
    parsed.confidence = 'low';
    const note = 'None of the sources found test this claim directly — each answers a related but different question, so treat this verdict as provisional and read what each source actually addresses.';
    parsed.uncertainty_notes = parsed.uncertainty_notes ? `${parsed.uncertainty_notes} ${note}` : note;
  }

  return summary;
}

// When analyzing an extracted article (URL mode) we ask the model to ALSO list
// any clearly-present secondary claims, in addition to the single main claim it
// already extracts. Appended to the system prompt so the base schema stays intact.
const SECONDARY_CLAIMS_RULE = `

ADDITIONAL OUTPUT FOR ARTICLE ANALYSIS:
The text above is the readable body of a web article rather than a single highlighted passage. Still extract and evaluate the single most central factual claim as your main claim. In ADDITION, include a top-level "secondary_claims" field in your JSON output:
- "secondary_claims": array of 0-3 strings. Each is one other distinct, factual, checkable claim clearly made in the article, phrased in your own words (1 sentence each). Do NOT repeat the main claim. Use an empty array if there are no clear secondary claims. Do not include opinions, questions, or value judgments.`;

// Snapshot mode: a faster, abbreviated evaluation. Same JSON schema (so every
// downstream consumer — rendering, history, export — keeps working) but the model
// is told to move quickly and stay brief, and it gets fewer searches/turns/tokens.
const SNAPSHOT_RULE = `

SNAPSHOT MODE — PRIORITIZE SPEED AND BREVITY:
- Perform at most 2 web searches (0-2). Lean on what those few searches return; do not chase exhaustive coverage.
- Keep "verdict_explanation" to ONE sentence, always set "confidence", and always set "bottom_line" (one short TL;DR sentence, distinct from verdict_explanation).
- Include at most 2 items in "supporting_evidence" and at most 2 in "contradicting_evidence" — only the single strongest source on each side. Still set "relevance" and a short "addresses" on each: a fast answer that miscategorizes a source is worse than a slow one.
- Still set "claim_text", "verdict", "confidence", and apply the Identity Lens: set BOTH identity_lens.about_identity and identity_lens.contains_targeting (keeping them distinct as described above) plus a ONE-sentence identity_lens.analysis (leave its arrays empty unless targeting is clearly present). Set contextLens.contextWarning only if the claim involves identity-based hate, stereotypes, or harmful framing; otherwise "".
- You may leave "breakdown" fields, "reflection_questions", "uncertainty_notes", and the remaining contextLens fields brief or empty. Do NOT pad.
- Output the same JSON schema as above (a complete, valid JSON object).`;

// When the Context Lens is toggled off, tell the model to skip step 7 entirely so
// we don't spend tokens/time generating background the user has opted out of.
const CONTEXT_LENS_OFF_RULE = `

CONTEXT LENS DISABLED: The user has turned the Context Lens off. Skip step 7 entirely — do NOT produce background, key context, "why context matters", missing-information, or context reflection questions. Set "contextLens" to null. Spend no effort on it.`;

// Supported output languages. This is the single server-side source of truth and
// mirrors the frontend selector / i18n core. Adding a language means adding its
// code here and a corresponding rule in LANGUAGE_RULES below.
const SUPPORTED_LANGUAGES = ['en', 'es'];
const DEFAULT_LANGUAGE = 'en';

const FULL_MAX_TOKENS = 6144;
const SNAPSHOT_MAX_TOKENS = 2500;
// Spanish renders the same analysis in materially more tokens than English —
// longer words, more articles and prepositions, and the schema's field names
// stay English while every value grows. At the English budget a Spanish
// snapshot reliably hit the cap mid-JSON and failed. Full mode has enough
// headroom already; only snapshot needs the allowance.
const SNAPSHOT_MAX_TOKENS_NON_ENGLISH = 3400;

/** Output budget for a snapshot in the given (already normalized) language. */
function snapshotTokenBudget(lang) {
  return lang === DEFAULT_LANGUAGE ? SNAPSHOT_MAX_TOKENS : SNAPSHOT_MAX_TOKENS_NON_ENGLISH;
}

// Only ever accept an exact code from the allow-list — never interpolate raw user
// input into the prompt. An unknown/absent value falls back to English.
function normalizeLanguage(lang) {
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}

// Fixed, per-language output rule appended to the system prompt. These are static
// constants (not user-provided text), which keeps language selection safe from
// prompt injection. English is the default behavior, so its rule is empty.
const LANGUAGE_RULES = {
  en: '',
  es: `

OUTPUT LANGUAGE — SPANISH (español): The user selected Spanish. Write ALL human-readable output in natural, neutral Latin American Spanish appropriate for high school students and teachers in the United States (California). This applies to: claim_text, the breakdown fields what/who/when/where/evidence_required and breakdown.evidence_found.note, every evidence "summary" and "credibility_note", verdict_explanation, bottom_line, uncertainty_notes, every reflection_questions item, secondary_claims, all identity_lens text (analysis, caution_note, and each pattern's explanation), and every contextLens field (backgroundSnapshot, keyContext, whyContextMatters, missingInformation, reflectionQuestions, contextWarning).
- Do NOT translate JSON keys, and keep the ENUM VALUES exactly as specified in English: "verdict" ("supported"/"contradicted"/"unclear"), "confidence" ("high"/"medium"/"low"), "credibility_tier" ("high"/"medium"/"low"/"unknown"), and "breakdown.evidence_found.status" ("found"/"partial"/"not_found"). These are machine values, not display text.
- Apply exactly the same evidence standards, source-credibility tiers, and rigor as for English claims. Do NOT lower quality because the claim or the sources are in another language.
- Do NOT restrict research to Spanish-language sources. Use the strongest available evidence in ANY language (government agencies, peer-reviewed research, universities, reputable news, established fact-checkers). You may reason/search in English internally, but the user-facing output must be in Spanish.
- Keep proper nouns, organization names, publication names, and each "source_name" in their original form. Do NOT translate URLs. Do NOT invent translated titles for sources. Summarize sources in your own Spanish rather than quoting them — the paraphrase rule above applies in every language. If a short quotation is genuinely unavoidable, keep it in the source's original language inside quotation marks and translate nothing.
- If the claim itself is written in Spanish, understand and evaluate it directly — do not translate it to English in the output.`,
};

async function analyzeClaim({ text, sourceUrl, academicMode = false, includeSecondaryClaims = false, snapshot = false, includeContextLens = true, language = DEFAULT_LANGUAGE }) {
  const lang = normalizeLanguage(language);
  const userContext = sourceUrl
    ? `Source page: ${sourceUrl}\n\nHighlighted text:\n"""${text}"""`
    : `Highlighted text:\n"""${text}"""`;

  const system = BASE_SYSTEM_PROMPT
    .replace('{{SEARCH_GUIDANCE}}', academicMode ? ACADEMIC_SEARCH_GUIDANCE : STANDARD_SEARCH_GUIDANCE)
    .replace('{{ACADEMIC_FALLBACK_RULE}}', academicMode ? ACADEMIC_FALLBACK_RULE : '')
    + (includeSecondaryClaims ? SECONDARY_CLAIMS_RULE : '')
    + (snapshot ? SNAPSHOT_RULE : '')
    + (includeContextLens ? '' : CONTEXT_LENS_OFF_RULE)
    + (LANGUAGE_RULES[lang] || '');

  const webSearchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: snapshot ? 2 : 5,
  };
  if (academicMode) {
    webSearchTool.allowed_domains = ACADEMIC_ALLOWED_DOMAINS;
  }

  const result = await runAgenticLoop({
    system,
    userMessage: userContext,
    tools: [webSearchTool],
    maxTurns: snapshot ? 4 : 6,
    maxTokens: snapshot ? snapshotTokenBudget(lang) : FULL_MAX_TOKENS,
  });

  const parsed = extractJson(result.finalText);
  if (!parsed) {
    // Distinguish "ran out of room" from "returned something unparseable". They
    // need different things from the user, and the generic message told a
    // snapshot user to add more text when less would have helped.
    if (result.truncated) {
      throw new Error(
        snapshot
          ? 'This analysis ran out of room before it finished. Turn off Quick snapshot for a full analysis, or try a shorter claim.'
          : 'This analysis ran out of room before it finished. Try again with a shorter or more specific claim.'
      );
    }
    throw new Error('Model did not return valid JSON. Try again with more text.');
  }
  // Guarantee the Context Lens is gone when disabled — the soft prompt rule isn't
  // always honored, so strip it here so the response is authoritative for every
  // consumer (UI, history, export).
  if (!includeContextLens) {
    parsed.contextLens = null;
    parsed.context_lens = null;
  }
  // Pin every evidence item to the source_type and relevance enums before
  // anything downstream reads them, so the UI, export, academic filter and
  // relevance check all see the same values.
  for (const key of ['supporting_evidence', 'contradicting_evidence']) {
    if (Array.isArray(parsed[key])) {
      for (const item of parsed[key]) {
        if (item && typeof item === 'object') {
          item.source_type = normalizeSourceType(item.source_type);
          item.relevance = normalizeRelevance(item.relevance);
        }
      }
    }
  }
  // Academic filtering runs first: it changes which sources survive, and the
  // relevance check has to judge the evidence base the student will actually see.
  const removedSources = academicMode ? applyAcademicFilter(parsed) : [];
  const relevance = applyRelevanceCheck(parsed);
  return {
    ...parsed,
    _meta: {
      model: MODEL,
      searches_used: result.searchesUsed,
      academic_mode: academicMode,
      snapshot,
      context_lens: includeContextLens,
      language: lang,
      // What the academic filter stripped, so the UI can tell the student the
      // evidence list was narrowed rather than just showing fewer sources.
      filtered_sources: removedSources,
      // How much of the evidence actually tests the claim, and whether the
      // verdict had to be qualified because none of it does.
      relevance,
    },
    // Aggregate token/search counts for this analysis. Purely numeric — it
    // carries nothing about the claim or the result. Classroom Mode debits a
    // classroom's budget with it; the public flow ignores it, and every
    // existing consumer (history, share links, PDF/Word export) picks named
    // fields, so an extra key changes nothing for them.
    _usage: result.usage,
  };
}

/**
 * Adds one API response's usage onto a running total.
 *
 * Accumulating across turns matters: every turn re-sends the whole accumulated
 * message list, so a multi-turn analysis bills far more input tokens than the
 * last response alone reports. Reading usage off the final turn would
 * under-count a research-heavy claim several times over.
 */
function addUsage(total, usage) {
  if (!usage) return total;
  total.input_tokens += usage.input_tokens || 0;
  total.output_tokens += usage.output_tokens || 0;
  total.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  total.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  // Server-side web searches are billed per request, separately from tokens.
  total.web_search_requests += (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return total;
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    web_search_requests: 0,
    api_calls: 0,
  };
}

// Stop reasons that mean the model has more to say and the conversation should
// be re-sent. Everything else ends the loop.
//
// This is an allow-list on purpose. It used to be a deny-list of terminal
// reasons ("end_turn"/"stop_sequence"), which meant any reason not on that list
// — including "max_tokens" — fell through to "continue". Re-sending after
// "max_tokens" appends a TRUNCATED assistant message and then asks the API to
// continue from it, which it rejects outright: "This model does not support
// assistant message prefill." A new stop reason added upstream would hit the
// same path, so the loop now continues only when it recognizes a reason to.
const CONTINUATION_STOP_REASONS = new Set(['tool_use', 'pause_turn']);

async function runAgenticLoop({ system, userMessage, tools, maxTurns, maxTokens = 6144 }) {
  const messages = [{ role: 'user', content: userMessage }];
  let finalText = '';
  let searchesUsed = 0;
  let truncated = false;
  const usage = emptyUsage();

  for (let turn = 0; turn < maxTurns; turn++) {
    let response;
    try {
      response = await callAnthropic({ system, messages, tools, maxTokens });
    } catch (err) {
      // Carry the usage accumulated so far out with the failure. Usage
      // guardrails reserve a claim before this loop runs and need to know
      // whether the attempt actually cost anything before handing that
      // reservation back — a rejected API key spends nothing, a timeout on the
      // third search turn has already spent plenty. Without this the caller
      // cannot tell the two apart and has to assume the worst.
      err.usage = usage;
      throw err;
    }

    addUsage(usage, response.usage);
    usage.api_calls += 1;

    messages.push({ role: 'assistant', content: response.content });

    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length) {
      finalText = textBlocks.map(b => b.text).join('\n');
    }

    // Count searches before deciding whether to stop. A single response can
    // carry server_tool_use blocks AND finish with "end_turn" — the API resolves
    // server-side tools within the same request — so counting after the exit
    // check silently dropped every search made on the final turn.
    const webSearchUses = response.content.filter(b => b.type === 'server_tool_use' && b.name === 'web_search');
    searchesUsed += webSearchUses.length;

    if (response.stop_reason === 'max_tokens') {
      truncated = true;
      break;
    }
    if (!CONTINUATION_STOP_REASONS.has(response.stop_reason)) break;

    // A continuation reason with no pending tool call would loop without
    // progress; treat it as finished.
    const toolUses = response.content.filter(b => b.type === 'server_tool_use' || b.type === 'tool_use');
    if (!toolUses.length) break;
    // server_tool_use (web_search) is resolved server-side by the API — the next turn
    // continues automatically when we re-send the accumulated messages.
  }

  return { finalText, searchesUsed, usage, truncated };
}

async function callAnthropic({ system, messages, tools, maxTokens = 6144 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      tools,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Collapses a usage record into the single number a classroom budget is spent in.
 *
 * Cached reads are counted because they still consume budget, just at a lower
 * rate upstream; the point here is a stable, predictable unit a teacher can
 * reason about, not an exact reproduction of billing.
 */
function totalTokens(usage) {
  if (!usage) return 0;
  return (
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

module.exports = {
  analyzeClaim,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  totalTokens,
  emptyUsage,
  // Exported for tests — these are the enforcement the prompt cannot provide.
  applyAcademicFilter,
  applyRelevanceCheck,
  isAcademicHost,
  normalizeSourceType,
  normalizeRelevance,
  snapshotTokenBudget,
  SOURCE_TYPES,
  RELEVANCE_LEVELS,
};
