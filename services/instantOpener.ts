// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE INSTANT OPENER — the first words, composed from facts, in ~1ms
//
//  The cover answer exists to stop the candidate sitting in silence while
//  the real answer forms. It did that by asking a fast model for a
//  sentence, which cost 528-1,662ms measured, and — because a 70B model at
//  temperature 0.7 with a twelve-word budget is not a careful reader —
//  sometimes produced a sentence about a job the candidate never had. The
//  app then spoke it out loud.
//
//  The intuition behind the original design was right and worth keeping:
//  everything needed is already on the machine the instant the file is
//  uploaded. What was cached was the DOCUMENT, so a model still had to
//  read it at question time. What gets cached here is the ANSWER.
//
//  So this file composes the opening sentence directly out of the fact
//  ledger. Three properties fall straight out of that:
//
//    1. It cannot fabricate. Every employer, tool, project, date and
//       number in the output was copied from a span of the uploaded file.
//       There is no generation step in which something could be invented.
//    2. It is instant. No network, no model, no tokens. Measured in
//       microseconds, against a cover chain that BLOCKED the main answer
//       for up to 1,200ms (openai/claude), 2,000ms (xai) or 3,000ms
//       (groq) — because the main provider call was only issued after the
//       cover resolved.
//    3. It knows when to say nothing. This is the part the old design had
//       no way to express. Asked "then why did you answer IBM?", a model
//       told to always start answering and never deny anything produced
//       "That was based on my experience with their systems at
//       Accenture" — a second invented employer, to justify the first.
//       There is no opening sentence that improves that moment. The
//       correct move is to let the real model, which has the transcript,
//       answer it. `suppress` is how that is said.
//
//  Deliberately NOT a language model, not even a cached one. A bank of
//  pre-generated sentences would still need verifying, would go stale
//  against the file, and would cost a call per upload. Variation here
//  comes from the phrase tables plus the candidate's own facts, keyed by
//  a stable hash of the question so the same question always opens the
//  same way and consecutive questions do not.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import {
  Ledger, Fact, findOrganisation, selectFacts, unverifiedProperNouns, GENERIC_SKILL_LABEL,
} from './factLedger';

export type OpenerShape =
  | 'entity-yes' | 'entity-no' | 'platforms' | 'project' | 'background'
  | 'topic' | 'meta' | 'unknown';

export type OpenerDecision =
  /** Say exactly this, now. Grounded by construction. */
  | { kind: 'speak'; text: string; shape: OpenerShape }
  /** No opener from us — a live model may still cover the gap. */
  | { kind: 'defer'; shape: OpenerShape; why: string }
  /**
   * No opener, and NO model may cover this either. Reserved for questions
   * where an opening sentence is itself the failure — being challenged
   * about a previous answer, above all.
   */
  | { kind: 'suppress'; shape: OpenerShape; why: string };

// ── Question shapes ──
//
// Ordered by how specific the evidence is. Meta first: being asked about
// a previous answer outranks every other reading of the words, because
// the same sentence ("why did you say Kafka?") is also a topic question
// and answering it as one is how the app talked itself into a second lie.
const META = [
  /\b(?:why|how come)\b[^?]{0,40}\byou\b[^?]{0,30}\b(?:say|said|answer|answered|mention|mentioned|tell|told|claim|claimed|put)\b/i,
  /\byou\s+(?:just\s+)?(?:said|told me|mentioned|claimed|answered)\b/i,
  /\b(?:did|have)\s+you\s+(?:just\s+)?(?:lie|lied|make that up|made that up)\b/i,
  /\byou\s+(?:lied|are lying|were lying|made that up|got that wrong)\b/i,
  /\bwhat\s+(?:are|were)\s+(?:those|the|your)\s+mistakes?\b/i,
  // Contractions matter: "that's wrong" is the single most likely way a
  // person pushes back, and requiring a space before "'s" missed it.
  /\b(?:that|this|it)(?:['’]s|s)?\s+(?:is\s+|was\s+)?(?:not\s+(?:true|right|correct|what)|wrong|incorrect|false|a lie|nonsense|made up)\b/i,
  /\b(?:correct|clarify|explain)\s+(?:yourself|that answer|what you said)\b/i,
  /\bwhy\s+(?:the\s+)?(?:contradiction|inconsistency)\b/i,
  /\bare you (?:sure|certain|making)\b/i,
];

const BACKGROUND = [
  /\btell me about yourself\b/i,
  /\bintroduce yourself\b/i,
  /\bintroduction\b/i,
  // "can you walk through your experience" — no "me", and the object may be
  // work/professional experience rather than "background". Every one of
  // these is a real question from the app's own transcript that the
  // narrower pattern missed, and they are the commonest opening question
  // in any interview.
  /\b(?:walk|take)\s+(?:me\s+)?(?:through|us through)\s+(?:your\s+)?(?:\w+\s+){0,2}(?:background|experience|career|journey|resume|cv|profile|history)\b/i,
  /\btell me about\s+your\s+(?:\w+\s+){0,2}(?:background|experience|career|journey|resume|cv|profile|history)\b/i,
  /\b(?:your|the)\s+(?:professional\s+|work\s+|overall\s+)?background\b/i,
  /\bwho are you\b/i,
  /\bsummar(?:ise|ize)\s+your\s+(?:background|experience|career|profile)\b/i,
  /\bhow many years\b[^?]{0,30}\bexperience\b/i,
  // "what's your experience?" on its own is the background question. Anchored
  // at the end so "your experience WITH Python" — a different question with a
  // different answer — does not become a career summary.
  /\bwhat(?:'s|s| is| was)?\s+your\s+experience\s*[?.!]?$/i,
  /\bexplain+\s+your\s*self\b/i,
];

// "what did you study", "what was your bachelors on" — answerable exactly
// and only from the education facts, and previously answered by nobody:
// the entity shapes need a NAME in the question and there is none here.
const EDUCATION = [
  /\b(?:what|where)\b[^?]{0,30}\b(?:did you |you )?(?:study|studied|graduate|major)\b/i,
  /\byour\s+(?:degree|bachelors?|masters?|mba|phd|doctorate|education|university|college|school)\b/i,
  /\bwhat (?:was|is|are) your (?:bachelors?|masters?|degree|major)\b/i,
  /\b(?:are|do) you (?:a )?(?:graduate|degree)\b/i,
  /\beducational background\b/i,
];

// The plural form. `PROJECT` below wants a favourite; "what are the
// projects you worked on?" wants the list, and fell through to nothing.
//
// Anchored at the start of the question on purpose. An unanchored
// "your projects" also matches "How do you ensure Responsible AI principles
// in your projects?" — where the subject is Responsible AI and reciting a
// project list answers a question nobody asked. The word has to be what the
// question is ABOUT, not a word the question happens to contain.
const PROJECTS_PLURAL = [
  /^(?:so |okay |and |um |uh )*(?:what|which)\b[^?]{0,30}\bprojects\b/i,
  /^(?:so |okay |and |um |uh )*(?:tell me about|walk me through|describe)\b[^?]{0,25}\bprojects\b/i,
  /\bwhat (?:kind of |sort of |type of )?projects\b/i,
  /\bprojects (?:have|did|do) you (?:work|worked|built|build|deliver)\b/i,
  // "list ur projects" — terse and typed, which is how the desktop user
  // asks rather than speaks.
  /^(?:list|name|show)\b[^?]{0,20}\bprojects\b/i,
];

// "where have you worked?", "which companies?" — the list of employers is
// the whole answer, it is never wrong, and nothing was answering it: the
// entity shapes need a NAME in the question and there is none here.
const WHERE_WORKED = [
  /\bwhere\b[^?]{0,25}\b(?:have|did|do)\s+(?:you|your)\b[^?]{0,15}\bwork/i,
  /\bwhere have you been working\b/i,
  /\b(?:what|which)\s+(?:companies|organi[sz]ations|employers|firms|places)\b/i,
  /\bwho (?:have|did) you work for\b/i,
  /\byour (?:work|employment|job) history\b/i,
  /\blist your (?:companies|employers|roles)\b/i,
];

const WHERE_WORKED_FORMS = [
  (orgs: string) => `${orgs} — those are the ones.`,
  (orgs: string) => `It's been ${orgs}.`,
  (orgs: string) => `Mostly ${orgs}.`,
];

// "do you have experience with Kafka?", "have you used Snowflake?" — a
// question about a TOOL rather than an employer, and the single most common
// shape in a technical screen after the background question.
const EXPERIENCE_WITH = [
  /\b(?:do|did) you have (?:any )?(?:experience|exposure|familiarity) (?:with|in|on)\s+(.{2,40})/i,
  // "did you use X" / "do you use X" were missing, and they are among the
  // most common ways an interviewer asks this — measured deferring on
  // "Did you use Tableau?" while "have you used Tableau?" answered fine.
  // The auxiliary carries no meaning here; only the verb does.
  /\b(?:have|has|had|did|do|does)\s+you\s+(?:ever\s+)?(?:use|used|work(?:ed)?\s+(?:with|on)|touch(?:ed)?|built\s+with|build\s+with)\s+(.{2,40})/i,
  /\b(?:what|how much)(?:'s| is| was)? your experience (?:with|in|on)\s+(.{2,40})/i,
  /\bare you (?:familiar|comfortable|experienced) (?:with|in)\s+(.{2,40})/i,
  /\bhow (?:strong|good) are you (?:with|in|at)\s+(.{2,40})/i,
];

const PLATFORMS = [
  /\b(?:what|which)\b[^?]{0,40}\b(?:platforms?|stacks?|technolog\w+|tools?|languages?|clouds?|databases?)\b/i,
  /\bwhat (?:have you|did you|do you) work(?:ed)? (?:on|with)\b/i,
  /\bwhat (?:are|is) your (?:strongest|main|primary|core)\b/i,
  /\btech stack\b/i,
];

// A problem to solve, not a question about the candidate. An opener that
// reaches for employment history here is the exact anti-pattern the cover
// prompt already warned about and still produced: asked to design a rate
// limiter, the app opened "Most of my time's been on Azure Data Platform".
// There is no fact in a resume that opens a coding question well, so this
// shape declines and lets the answer model do its job.
const PROBLEM = [
  /\b(?:design|architect|implement|write|code|build)\s+(?:a|an|the)\b/i,
  /\b(?:reverse|sort|find|merge|traverse|invert|balance)\s+(?:a|an|the)?\s*(?:string|array|list|tree|graph|matrix|linked)/i,
  /\btime complexity|space complexity|big.?o\b/i,
  /\bestimate\s+(?:the|how many)\b/i,
  /\bhow many\s+(?:people|users|cars|piano|gas station)/i,
  /\bhow would you\s+(?:design|build|architect|scale|debug|approach|handle)\b/i,
  /\bexactly.?once|idempoten|back.?pressure|rate limit(?:er|ing)\b/i,
  /\bgiven (?:an?|the)\s+(?:array|string|list|tree|graph|matrix|integer)\b/i,
];

const PROJECT = [
  /\b(?:fav(?:ou?rite)?|best|proudest|favorite)\b[^?]{0,25}\bproject\b/i,
  /\bproject\b[^?]{0,25}\b(?:you'?re |are )?(?:most )?proud\b/i,
  /\b(?:tell me about|walk me through|describe|explain)\b[^?]{0,20}\b(?:a |your |one |the )?[a-z ]{0,15}project\b/i,
  /\bwhat(?:'s| is| was) your (?:favou?rite|best) (?:project|work)\b/i,
];

// "have you worked at X", "do you know X", "what about X", "who is X"
const ENTITY_SYNTAX = [
  // The optional pronoun is load-bearing: "were you at Deloitte?" puts
  // "you" between the verb and the preposition, and without it that
  // question found no entity and the opener declined instead of saying no.
  /\b(?:worked|work|working|employed|been|were|was)\s+(?:you\s+|i\s+)?(?:at|for|with|in)\s+([A-Za-z][\w&.''-]*(?:\s+[A-Z][\w&.''-]*){0,3})/i,
  /\b(?:heard of|know of|familiar with|know)\s+([A-Z][\w&.''-]*(?:\s+[A-Z][\w&.''-]*){0,3})/,
  /\b(?:who|what)\s+(?:is|are|was)\s+([A-Z][\w&.''-]*(?:\s+[A-Z][\w&.''-]*){0,3})\b/,
  /\bwhat(?:'s| is| was) (?:your )?(?:work|role|job|time)\s+at\s+([A-Za-z][\w&.''-]*(?:\s+[A-Z][\w&.''-]*){0,3})/i,
  /\bwhat about\s+([A-Z][\w&.''-]*(?:\s+[A-Z][\w&.''-]*){0,3})\s*\?/,
];

// Words that follow "worked at/for" without naming an organisation.
const NOT_AN_ORG = new Set([
  'a', 'an', 'the', 'any', 'many', 'some', 'all', 'both', 'scale', 'startups',
  'startup', 'companies', 'company', 'enterprise', 'enterprises', 'places',
  'place', 'home', 'remote', 'onsite', 'office', 'production', 'prod', 'teams',
  'team', 'anywhere', 'somewhere', 'that', 'this', 'it', 'them', 'there',
  'before', 'previously', 'india', 'us', 'usa', 'here',
  // Possessives and pronouns. "…matters for your work in your career" put
  // "your" through the org extractor, and the app answered a career
  // question with "No, not there. Where I have worked is…".
  'your', 'my', 'our', 'their', 'his', 'her', 'its', 'you', 'i', 'we', 'they',
  'career', 'careers', 'job', 'jobs', 'role', 'roles', 'work', 'industry',
  'past', 'current', 'recent', 'general', 'depth', 'detail', 'terms',
]);

// A question that is ASKING ABOUT an entity, rather than merely containing
// a capitalised token. Used to gate the bare-acronym fallback below.
const ENTITY_FRAME = /\b(?:what about|how about|who is|who are|heard of|know of|familiar with|worked (?:at|for)|been (?:at|to)|ever (?:at|with))\b/i;

function anyMatch(res: RegExp[], s: string): boolean {
  for (const r of res) if (r.test(s)) return true;
  return false;
}

/**
 * The words the knowledge base itself presents as TECHNOLOGIES: the tools
 * listed in every skills line, and the names and tech lists of the projects.
 *
 * This is the authority for "is this shared word a tool?", replacing a
 * denylist of common English words that could never be complete. A resume
 * with no skills section contributes no tools and the topic shape simply
 * does not fire for it — correct, because without a stated tool list there
 * is no evidence that the word both strings share is a technology at all.
 *
 * Memoised on the ledger's own fingerprint: composeOpener runs per
 * question, and this must stay free at that cadence.
 */
let toolFp = '';
let toolSet: Set<string> = new Set();
// Solo tools share toolSet's fingerprint cache — they are built in the
// same pass, so they can never be stale relative to it.
let soloSet: Set<string> = new Set();
function toolVocabulary(ledger: Ledger): Set<string> {
  if (ledger.fingerprint === toolFp) return toolSet;
  const out = new Set<string>();

  // A TOOL LIST IS MADE OF SHORT ITEMS; A CAPABILITY IS A PHRASE.
  //
  // "Apache Kafka, Kinesis, Debezium" are tools. "Non-Conformance &
  // Deviation Handling" and "Quality Data Analysis & Trend Monitoring" are
  // things a person does, and admitting their words as technologies is what
  // produced, out loud, "handling — yeah, that was the Epicrispr
  // Biotechnologies work." Item length separates the two without needing a
  // dictionary: nobody writes a four-word product name in a skills list.
  const admitItem = (item: string): void => {
    const clean = item.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.split(' ').length > 3) return;
    for (const raw of clean.split(/[^A-Za-z0-9+#.]+/)) {
      const tok = raw.replace(/^\.+|\.+$/g, '');
      // Capitalised or an acronym — a lowercase word inside a tool list is
      // the "for" in "triage for cloud pipelines", not a technology.
      if (!/^[A-Z0-9]/.test(tok)) continue;
      const w = tok.toLowerCase();
      if (w.length >= 2 && w.length <= 30) out.add(w);
    }
  };
  const admitList = (s: string): void => {
    for (const item of String(s || '').split(/[,;|/]+/)) admitItem(item);
  };

  // ── A TOKEN THAT ONLY EVER APPEARS INSIDE A LONGER NAME IS NOT A TOOL ──
  //
  // `admitItem` splits every list entry into tokens, so a two-word product
  // contributes both of its halves. That is right for "Apache Kafka" (kafka
  // is a tool) and catastrophic for "Google Cloud", "Snowflake schema
  // modeling" and "Data Engineering Tools", which contributed `cloud`,
  // `schema` and `data`. Measured on the real question corpus, spoken:
  //
  //   "how do you handle schema evolution"  -> "schema, at Indiana
  //                                             University mostly."
  //   "Are you using tablet cloud or tablet server?"
  //                                         -> "cloud — yeah, that was the
  //                                             G Technologies work."
  //
  // TOPIC_STOP exists to catch these and, as its own comment predicted, a
  // denylist never finishes: it had `data` and not `cloud` or `schema`.
  //
  // The structural signal is that a real product name STANDS ALONE
  // somewhere in the lists — "Kafka" and "Kubernetes" are their own comma
  // item; `cloud` and `schema` never are, they only ever appear welded to
  // something else. So the topic shape, which SPEAKS the token, is
  // restricted to solo items. The looser set stays for everything that
  // merely reads the vocabulary.
  // A section HEADING names a category; its words are the ones that are
  // never products. "Cloud Platforms" is why `cloud` must not be sayable,
  // "Databases" is why `databases` must not — while `kafka`, which appears
  // in no heading, is exactly the kind of word this shape exists to say.
  const headingWords = new Set<string>();
  for (const s of ledger.skills) {
    for (const w of String(s.subject || '').toLowerCase().split(/[^a-z0-9+#.]+/)) {
      if (w.length >= 2) headingWords.add(w);
    }
  }
  const solo = new Set<string>();
  const admitSolo = (s: string): void => {
    for (const item of String(s || '').split(/[,;|/]+/)) {
      const clean = item.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      const words = clean.split(' ');
      // A single-word item is the product outright. For a short compound,
      // the LAST word is the product and the first is a vendor — "Apache
      // Kafka" is Kafka, "AWS Glue" is Glue. Rejecting compounds outright
      // was too strict and cost a real answer to "tell me about your Kafka
      // work", which opener-safety pins.
      if (words.length > 3) continue;
      const tok = words[words.length - 1].replace(/[^A-Za-z0-9+#.]/g, '').replace(/^\.+|\.+$/g, '');
      if (!/^[A-Z0-9]/.test(tok)) continue;
      const w = tok.toLowerCase();
      if (w.length < 2 || w.length > 30) continue;
      // …unless that last word is a category word, in which case the item
      // is a KIND of thing, not a thing. "Google Cloud" ends in a heading
      // word; "Apache Kafka" does not.
      if (words.length > 1 && (headingWords.has(w) || TOPIC_STOP.has(w))) continue;
      solo.add(w);
    }
  };
  for (const s of ledger.skills) admitSolo(s.detail);
  for (const p of ledger.projects) {
    const d0 = String(p.detail || '');
    const dash0 = d0.indexOf(' — ');
    admitSolo(dash0 === -1 ? d0 : d0.slice(dash0 + 3));
  }

  for (const s of ledger.skills) admitList(s.detail);
  for (const p of ledger.projects) {
    admitItem(p.subject);
    // Projects read "Subtitle — tool, tool". Only the part after the dash is
    // a tool list; the subtitle is prose and contributed "for".
    const d = String(p.detail || '');
    const dash = d.indexOf(' — ');
    admitList(dash === -1 ? d : d.slice(dash + 3));
  }
  toolFp = ledger.fingerprint;
  toolSet = out;
  soloSet = solo;
  return out;
}

/** Tools that appear as a STANDALONE list item — the ones safe to SPEAK. */
function soloToolVocabulary(ledger: Ledger): Set<string> {
  toolVocabulary(ledger);          // populates soloSet under the same fingerprint
  return soloSet;
}

/** Words that name a CATEGORY on this résumé, taken from its own headings. */
function categoryWords(ledger: Ledger): Set<string> {
  const out = new Set<string>();
  for (const s of ledger.skills) {
    for (const w of String(s.subject || '').toLowerCase().split(/[^a-z0-9+#.]+/)) {
      if (w.length >= 2) out.add(w);
    }
  }
  return out;
}

/**
 * Is this word a technology this candidate can be said to have used?
 *
 * The skills and project lists are the best evidence, but they are not the
 * only evidence: plenty of résumés name a tool ONLY in an experience
 * bullet — "Owned Apache Kafka and Python pipelines" with no Streaming
 * line to back it up. Requiring the skills list rejected "have you used
 * Kafka?" on exactly those résumés, which is a worse failure than the one
 * it was guarding against.
 *
 * So the knowledge base's whole vocabulary is admitted, minus the two
 * things that are demonstrably NOT products: the résumé's own section
 * headings (`cloud`, `databases`, `data`) and TOPIC_STOP's ordinary verbs
 * and nouns. That is what keeps "what is your experience in data
 * engineering?" from answering "data was a big part of the Apollo work".
 */
function isSpeakableTech(ledger: Ledger, word: string): boolean {
  const w = String(word || '').toLowerCase();
  // Three characters, because the two-letter words that reached this point
  // were prepositions: "what databases have you used IN production?"
  // captured `in` and the app said "I have, yeah — in is in there."
  if (!w || w.length < 3) return false;
  if (TOPIC_STOP.has(w)) return false;
  if (categoryWords(ledger).has(w)) return false;
  // ⚠️ THE SKILLS AND PROJECT LISTS ONLY — never the whole vocabulary.
  //
  // `ledger.vocabulary` is every proper noun in the knowledge base, which
  // is a far weaker claim than "this is a technology". Admitting it (to
  // rescue a tool named only in an experience bullet) immediately put
  // these back into the candidate's mouth, measured on the real corpus:
  //
  //   "Which AWS services have you used for data pipelines?"
  //        -> "That's the Apollo Hospitals side of things — pipelines."
  //   "Your experience with the risk management?"
  //        -> "risk, at Philips mostly."
  //   "…not to talk about the role or really anything…"
  //        -> "That's the MSN Pharmaceuticals side of things — Role."
  //
  // The bullet-only case that motivated the widening turned out to be an
  // artefact of a synthetic test résumé: every real résumé in the app's
  // database that mentions Kafka also lists it under skills. A narrow list
  // that occasionally stays quiet beats a broad one that says "pipelines"
  // out loud.
  return toolVocabulary(ledger).has(w);
}

// ── A PROCESS QUESTION IS NOT ANSWERED BY NAMING A TOOL ──
//
// The topic shape says, in effect, "yes, and here is where I used it".
// That is a real answer to "did you use Tableau prep?" and a non-answer to
// "how have you managed Kubernetes clusters, and what strategies did you
// use for scaling?" — where naming Kubernetes and an employer engages with
// nothing that was asked. Graded on the real corpus, this single
// distinction accounts for most of the shape's bad output:
//
//   "How did you productionize the LLM calls (latency, cost, retries)?"
//        -> "That's the Apollo Hospitals side of things — Azure."
//   "How does the team balance experimentation with reliability?"
//        -> "Azure — yeah, that was the Apollo Hospitals work."
//   "Walk me through a complex PySpark pipeline you built."
//        -> "That's the G Technologies side of things — PySpark."
//
// None of these are WRONG, which is what makes them dangerous: they are
// confident, fluent and empty, and they are the first thing the
// interviewer hears. There is no fact in a résumé that opens a "how"
// question, so the honest move is to defer and let the model that can
// actually reason answer it.
const PROCESS_Q = new RegExp([
  '\\bhow\\s+(?:do|did|does|would|have|has|are|is|can|could|should|you)\\b',
  '|\\bwhat\\s+(?:strategies|approach|steps|process|techniques|optimi[sz]ations|trade-?offs)\\b',
  '|\\b(?:walk|take)\\s+me\\s+through\\b',
  '|\\b(?:explain|describe|elaborate)\\b',
  '|\\btell\\s+me\\s+about\\s+(?:a|an|the)\\b',
  '|\\bwhy\\s+(?:do|did|would|is|are|was)\\b',
  '|\\bwhat\\s+would\\s+you\\s+do\\b',
].join(''), 'i');

/** True when the question asks HOW something is done, not WHETHER it was. */
function isProcessQuestion(q: string): boolean {
  return PROCESS_Q.test(String(q || ''));
}

// ── MENTIONING A TOOL IS NOT ASKING ABOUT THEIR EXPERIENCE OF IT ──
//
// The lexical topic branch fires when the question and an employer's
// bullet share a technology word. That is a very low bar: an interview is
// FULL of sentences that name a tool without asking whether the candidate
// used it. Graded on the real corpus, everything below was spoken, and
// every one of them deflects a real question into a CV placement:
//
//   "hey, what is the latest glue version?"
//        -> "Glue, at KIMS Hospitals mostly."          (they asked a fact)
//   "what tabs do you see in the AWS Glue dashboard?"
//        -> "Glue — yeah, that was the G Technologies work."
//   "My application in the Kubernetes platform is not responding."
//        -> "That's the G Technologies side of things — Kubernetes."
//   "I need you optimize the Spark job? That is running too slow"
//        -> "Spark — yeah, that was the Nizam's Institute work."
//
// This is exactly the "trivial resume recall" the product owner called
// out: anyone can name where they used a tool, and doing it in front of a
// question that asked something else is worse than saying nothing. So the
// branch now requires the question to actually ASK about their experience.
// `EXPERIENCE_WITH` above handles the cases whose phrasing it can capture;
// this is the same intent expressed as a gate for the ones it cannot.
const EXPERIENCE_FRAMING = new RegExp([
  '\\b(?:have|has|had|did)\\s+you\\s+(?:ever\\s+)?',
  '(?:use|used|work|worked|build|built|run|ran|manage|managed|touch|touched|ship|shipped|write|written)\\b',
  '|\\bdo\\s+you\\s+have\\s+(?:any\\s+)?experience\\b',
  '|\\bare\\s+you\\s+familiar\\s+with\\b',
  '|\\byour\\s+experience\\s+(?:with|in|of)\\b',
  '|\\bever\\s+(?:used|worked|built)\\b',
  '|\\bhow\\s+(?:long|many\\s+years)\\s+have\\s+you\\b',
  // Possessive framing is asking about them just as plainly as "have you
  // used" is. An earlier, tighter version of this list deferred on "tell
  // me about your Kafka work" — a question that is entirely about their
  // experience — which the opener-safety suite caught. Same failure shape
  // as the BACKGROUND_Q narrowing: too strict costs a real answer.
  '|\\btell\\s+me\\s+about\\s+your\\b',
  '|\\byour\\s+(?:experience|work|background|projects?|role)\\b',
].join(''), 'i');

/** True when the question asks about the candidate's own use of something. */
function asksAboutTheirExperience(q: string): boolean {
  return EXPERIENCE_FRAMING.test(String(q || ''));
}

/** Stable, order-independent hash — picks a phrasing without randomness. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

/** "Sep 2022 – December 2023" → "2022 to 2023"; keeps "Present" as-is. */
function spokenDates(when: string): string {
  const s = String(when || '').trim();
  if (!s) return '';
  const years = s.match(/(?:19|20)\d{2}/g) || [];
  const present = /present|current/i.test(s);
  if (present && years.length) return `${years[0]} to now`;
  // "May 2025 – December 2025" is one year, not a range. Left unhandled it
  // reached the candidate's mouth as "since 2025 to 2025".
  if (years.length >= 2 && years[0] !== years[years.length - 1]) {
    return `${years[0]} to ${years[years.length - 1]}`;
  }
  if (years.length >= 1) return years[0];
  return '';
}

/**
 * The tenure clause, in the grammar the dates actually justify.
 *
 * The background opener used to hard-code "since", which is right for a
 * current role and wrong for every other one: a closed range came out as
 * "Data Engineer at Apollo Hospitals since 2022 to 2023".
 */
function tenure(when: string): string {
  const spoken = spokenDates(when);
  if (!spoken) return '';
  if (spoken.endsWith(' to now')) return `since ${spoken.replace(/ to now$/, '')}`;
  if (spoken.includes(' to ')) return `from ${spoken}`;
  return `in ${spoken}`;
}

/** The role title, without the bullet text the ledger attaches to it. */
function roleOf(f: Fact): string {
  const d = String(f.detail || '');
  const dash = d.indexOf(' — ');
  const role = (dash === -1 ? d : d.slice(0, dash)).replace(/\s+/g, ' ').trim();
  return role.replace(/\s*\(Intern\)\s*/i, ' intern').trim();
}

/**
 * First N comma-separated items of a skills line, as a person would say
 * them.
 *
 * The parenthetical strip is not cosmetic. A real resume writes "Redshift
 * (sort and distribution keys), Snowflake, BigQuery", and the opener read
 * that out verbatim: "Redshift (sort and distribution keys), Snowflake,
 * BigQuery" — written shorthand, spoken aloud, in an interview. The
 * qualifier belongs to the document; the tool name is what gets said.
 */
// A skills line is written "Python (FastAPI, Flask, pandas), Java (Spring
// Boot, Hibernate), C#/.NET" — the parentheses group sub-tools under the
// language above them. Splitting on every comma first and stripping the
// parens afterwards mangled that: the split cut "Python (FastAPI" from
// "Flask", the strip then ate "(FastAPI" as if it were a whole group, and
// what reached the model was
//     Python, Flask, pandas), Java, Hibernate), JavaScript/TypeScript
// — FastAPI and Spring Boot silently DELETED, and two stray ")" offered to
// the model as the names of things the candidate knows. Measured on a real
// résumé: asked "Do you know FastAPI?", the cover answered "I don't recall
// using FastAPI directly", because by then it was true of the digest.
// So: walk the string, track paren depth, and keep every tool in the order
// it was written. Nothing is invented and nothing is dropped.
function firstTools(f: Fact, n: number): string[] {
  const s = String(f.detail || '');
  const tools: string[] = [];
  let cur = '';
  let depth = 0;
  const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) tools.push(t); cur = ''; };
  for (const ch of s) {
    if (ch === '(') { flush(); depth++; continue; }        // the group's parent is complete
    if (ch === ')') { flush(); if (depth > 0) depth--; continue; }
    if (ch === ',') { flush(); continue; }
    cur += ch;
  }
  flush();
  const seen = new Set<string>();
  return tools
    .filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n);
}

function listOrgs(orgs: string[], max = 4): string {
  const xs = orgs.slice(0, max);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** Most recent role first — the ledger holds them in document order. */
function currentRole(ledger: Ledger): Fact | null {
  const withPresent = ledger.employers.find((e) => /present|current/i.test(e.when));
  return withPresent || ledger.employers[0] || null;
}

// ── Entity extraction from the question ──
//
// Case matters less than syntax. Deepgram capitalises most proper nouns
// but not reliably, and the user types too — "okay, and what is work at
// apollo?" is a real question from the transcript. So an organisation the
// LEDGER knows is matched case-insensitively by name, and an organisation
// it does not know is recognised by the sentence shape around it.
function namedKnownOrg(ledger: Ledger, question: string): Fact | null {
  const q = question.toLowerCase();
  let best: Fact | null = null;
  let bestLen = 0;
  for (const pool of [ledger.employers, ledger.education, ledger.certifications]) {
    for (const f of pool) {
      const subj = f.subject.toLowerCase();
      if (subj.length < 3) continue;
      // Whole name, or its distinctive first word ("apollo" for
      // "Apollo Hospitals", "siemens" for "Siemens").
      const head = subj.split(/[\s,]+/)[0];
      const hit = q.includes(subj) || (head.length >= 4 && new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q));
      if (hit && subj.length > bestLen) { best = f; bestLen = subj.length; }
    }
  }
  return best;
}

// The tail a company name carries and a product name does not. Only the
// unmistakable ones: a legal form, or the noun a firm puts after its own
// word. Anything a skills line could plausibly end with — Systems,
// Solutions, Services, Labs — is left out on purpose, because this list is
// the ONLY thing standing between "what about Distributed Systems?" and a
// spoken denial of employment.
const ORG_TAIL = new Set([
  'inc', 'llc', 'llp', 'ltd', 'limited', 'plc', 'corp', 'corporation',
  'company', 'gmbh', 'pvt', 'pte', 'group', 'holdings', 'bank',
  'technologies', 'industries', 'enterprises', 'associates', 'partners',
  'consulting', 'consultancy', 'hospitals', 'pharmaceuticals', 'pharma',
  'laboratories', 'university', 'college', 'institute', 'motors', 'ventures',
]);

/** "Kestrelby Pharma", "Nizam's Institute" — a name that says company. */
function organisationShape(name: string): boolean {
  const words = name.trim().split(/\s+/);
  const tail = words[words.length - 1].replace(/[^A-Za-z]/g, '').toLowerCase();
  return ORG_TAIL.has(tail);
}

/**
 * May the app say "no, I have not worked there" about this name?
 *
 * A capital letter is the ordinary evidence, and Deepgram supplies it for
 * most proper nouns. When it does not, the SENTENCE still can — but only
 * for the prepositions that actually take an employer.
 *
 *   "have you worked FOR ibm"      → a company. Denial allowed.
 *   "have you worked WITH data"    → a technology.
 *   "have you worked IN healthcare"→ a sector.
 *
 * `worked with` and `worked in` were reaching the same denial as `worked
 * for`, so a lowercase technology could be answered with "No, I haven't —
 * my roles have been…", which is not an answer to the question that was
 * asked and contradicts a resume that lists the technology.
 *
 * ⚠️ AND A CAPITAL LETTER USED TO OVERRULE ALL OF IT. The first line here
 * was `if (/^[A-Z]/.test(name)) return true`, which short-circuited the
 * preposition test above for every capitalised name — so the guard only
 * ever ran on words the transcriber had LOWERCASED, and Deepgram
 * capitalises product names. In production it was dead code. Measured
 * against a real ledger, this is what the candidate said out loud:
 *
 *   "Have you worked with Kubernetes?" → "I have not, no — it has been
 *                                        Fidelity Investments and Apollo
 *                                        Hospitals for me."
 *   "Ever worked with Cassandra?"      → "No, I have not — my roles have
 *                                        been…"
 *   "Do you know Terraform?"           → "No, not there. Where I have
 *                                        worked is…"
 *
 * A denial of employment in answer to a question about a tool, on the
 * commonest screening question there is, several times an interview. So the
 * preposition decides for upper and lower case alike, and the only other
 * way in is the name's own shape. `heard of` / `know of` / `familiar with`
 * no longer count: "are you familiar with Kubernetes" is exactly the
 * question the veto below exists for, wearing a different verb.
 */
function deniableEntity(question: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A veto, not a vote, and checked first. "with"/"in"/"on" in front of the
  // name is the shape of the question this file must never answer with a
  // denial — the tool branch below is where it belongs.
  if (new RegExp(`\\b(?:with|in|on|using)\\s+${n}\\b`, 'i').test(question)) return false;
  if (new RegExp(`\\b(?:worked|work|working|employed|been|were|was)\\s+(?:you\\s+|i\\s+)?(?:at|for)\\s+${n}\\b`, 'i').test(question)) return true;
  // No preposition at all — "what about X?", "who is X?", "do you know X?".
  // Those frames fit a company and a product equally well, so nothing but
  // the name itself can settle it.
  return organisationShape(name);
}

function candidateEntity(question: string): string | null {
  for (const re of ENTITY_SYNTAX) {
    const m = re.exec(question);
    if (m && m[1]) {
      const raw = m[1].replace(/\s+/g, ' ').trim().replace(/[?.,!]+$/, '');
      const first = raw.split(/\s+/)[0].toLowerCase();
      if (!raw || NOT_AN_ORG.has(first)) continue;
      if (raw.length < 2) continue;
      return raw;
    }
  }
  // ⚠️ A bare acronym in a short question ("IBM?", "what about AWS").
  //
  // This used to fire on ANY question under 60 characters containing an
  // acronym, and an acronym in a technical question is almost always a
  // TECHNOLOGY. Measured: "How have you made Airflow DAS resilient and at
  // scale?" yielded the entity "DAS", found no such employer, and the app
  // opened with "No, I haven't — my roles have been Piramal, Aurolife…" —
  // a confident denial of having worked somewhere, in answer to a question
  // about Airflow. There is no recovering from that in an interview.
  //
  // So the question must actually be ASKING about an entity: either it uses
  // an entity frame, or it is essentially nothing but the acronym itself.
  const acro = /\b([A-Z]{2,}(?:\s+[A-Z][a-z]+)?)\b/.exec(question);
  if (acro) {
    const remainder = question.replace(acro[1], ' ').replace(/[^A-Za-z ]+/g, ' ').trim();
    const bare = remainder.split(/\s+/).filter(Boolean).length <= 2;
    if (bare || ENTITY_FRAME.test(question)) return acro[1];
  }
  return null;
}

// ── Phrase tables ──
// Each entry is a whole spoken sentence template. They differ in rhythm on
// purpose: an opener that is identical every time is a tell of its own,
// and three of the answers in the user's transcript opened with the
// identical words "Most of my time's been on".
const YES_FORMS = [
  (org: string, role: string, when: string) => `Yeah, ${org} — I was ${role} there${when ? `, ${when}` : ''}.`,
  (org: string, role: string, when: string) => `${org}, yes — ${role}${when ? ` from ${when}` : ''}.`,
  (org: string, role: string, when: string) => `I was, yeah — ${role} at ${org}${when ? `, ${when}` : ''}.`,
];

const NO_FORMS = [
  (orgs: string) => `No, I haven't — my roles have been ${orgs}.`,
  (orgs: string) => `No, not there. Where I have worked is ${orgs}.`,
  (orgs: string) => `I haven't, no — it's been ${orgs} for me.`,
];

const PLATFORM_FORMS = [
  (label: string, tools: string) => `Mostly ${label} — ${tools}.`,
  (label: string, tools: string) => `${label} is where most of it has been: ${tools}.`,
  (label: string, tools: string) => `Most of it has been ${label} — ${tools}.`,
];

const PROJECT_FORMS = [
  (name: string, what: string) => `${name} is the one I'd pick — ${what}.`,
  (name: string, what: string) => `Probably ${name}: ${what}.`,
  (name: string, what: string) => `${name}, easily — ${what}.`,
];

const TOPIC_FORMS = [
  (tool: string, org: string) => `${tool} — yeah, that was the ${org} work.`,
  (tool: string, org: string) => `That's the ${org} side of things — ${tool}.`,
  (tool: string, org: string) => `${tool}, at ${org} mostly.`,
];

// A skills section that listed capabilities one per line gives no heading
// to name, so these say the same thing without one. Speaking the reserved
// label would be the app inventing a category the candidate never wrote.
const UNLABELLED_PLATFORM_FORMS = [
  (tools: string) => `Mostly ${tools}.`,
  (tools: string) => `${tools}, mainly.`,
  (tools: string) => `That's been ${tools} for the most part.`,
];

const EDUCATION_FORMS = [
  (what: string, where: string, when: string) => `${what} at ${where}${when ? `, ${when}` : ''}.`,
  (what: string, where: string, when: string) => `I did ${what} at ${where}${when ? ` — ${when}` : ''}.`,
  (what: string, where: string, when: string) => `${where} — ${what}${when ? `, ${when}` : ''}.`,
];

const PROJECTS_PLURAL_FORMS = [
  (list: string) => `The main ones are ${list}.`,
  (list: string) => `Mainly ${list}.`,
  (list: string) => `${list} are the ones worth talking about.`,
];

const HAVE_USED_FORMS = [
  (tool: string, org: string) => `Yeah — ${tool} was a big part of the ${org} work.`,
  (tool: string, org: string) => `I have, yeah. Mostly at ${org}, with ${tool}.`,
  (tool: string, org: string) => `${tool}, yes — that was ${org}.`,
];

const HAVE_USED_NO_ORG_FORMS = [
  (tool: string) => `Yeah, ${tool} I've worked with.`,
  (tool: string) => `${tool}, yes — that's been part of my work.`,
  (tool: string) => `I have, yeah — ${tool} is in there.`,
];

const OPENER_MAX_CHARS = 260;

// Words that reach the vocabulary because a resume capitalises them at the
// start of a bullet or a heading, but which name nothing. Naming one of
// these as "the technology" would be worse than declining.
const TOPIC_STOP = new Set([
  'data', 'built', 'owned', 'ran', 'shipped', 'cut', 'rebuilt', 'engineer',
  'senior', 'lead', 'the', 'and', 'with', 'from', 'into', 'over', 'under',
  'per', 'day', 'night', 'week', 'month', 'year', 'team', 'work', 'path',
  'end', 'production', 'records', 'rows', 'time', 'latency', 'cost',
  // Domain nouns that a Title-Cased skills line makes look like products.
  // Every one of these is a capitalised word in a real resume in the app's
  // database, and naming one as "the technology" reads as a non-answer.
  'engineering', 'management', 'analysis', 'handling', 'documentation',
  'validation', 'testing', 'development', 'operations', 'support', 'control',
  'monitoring', 'improvement', 'compliance', 'quality', 'manufacturing',
  'processing', 'communication', 'leadership', 'ownership', 'mentoring',
  'reporting', 'planning', 'training', 'review', 'reviews', 'process',
  'processes', 'systems', 'system', 'tools', 'skills', 'experience', 'for',
]);

/**
 * The half of `recentTurns` that is EVIDENCE.
 *
 * The transcript arrives labelled — "Interviewer: …" for the human, "You
 * already said: …" for the candidate — from buildOpenerPayload in
 * services/aiProxyService.ts. Both halves belong in a PROMPT, because a
 * follow-up is unreadable without the answer it follows. Only one half is
 * evidence, and the whole thing was being treated as such.
 *
 * A name the interviewer used is theirs: echoing it back is not inventing
 * it, which is the entire reason `alsoAllowed` exists. A name the app
 * itself said last turn is the opposite — it is precisely what may have
 * been invented last turn — and admitting it to the vocabulary is how a
 * fabrication authorises itself. Measured: unverifiedProperNouns(ledger,
 * "The IBM work was mostly Kafka.", "what did you do there?") reports IBM;
 * append "You already said: I spent three years at IBM…" and it reports
 * nothing. That is the IBM → Accenture cascade the header of this file says
 * the design prevents, arriving through the back door.
 *
 * Anything that is not labelled as the interviewer's is not trusted. The
 * transcript is tail-sliced to a character budget, so its first line can
 * arrive with its label cut off; a fragment nobody can be sure the
 * interviewer said is treated as the app's own words. That costs a cover at
 * worst. The other default costs a spoken lie.
 *
 * Kept in step with interviewerSaid() in server/src/routes/ai.js — the two
 * guards have to allow the same words or the parity between them is a
 * fiction.
 */
export function interviewerLines(recentTurns?: string): string {
  return String(recentTurns || '')
    .split('\n')
    .filter((line) => /^Interviewer:/.test(line.trim()))
    .join('\n');
}

/**
 * Compose the words the candidate says first, or decide that nothing
 * should be said.
 *
 * `recentTurns` is the last couple of exchanges. It is used only to widen
 * what counts as already-mentioned vocabulary, never to compose from — a
 * previous ANSWER is not evidence, and treating it as evidence is how a
 * fabrication survives into the next turn. Which is why only the
 * interviewer's own lines of it reach the guard; see interviewerLines.
 */
export function composeOpener(
  ledger: Ledger,
  question: string,
  recentTurns?: string,
): OpenerDecision {
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  if (!q) return { kind: 'defer', shape: 'unknown', why: 'empty question' };

  // ── Being challenged about a previous answer ──
  // Never opened, by anyone. The model that holds the transcript is the
  // only thing that can answer this honestly.
  if (anyMatch(META, q)) {
    return { kind: 'suppress', shape: 'meta', why: 'question is about a previous answer' };
  }

  // Without a knowledge base there are no facts to compose from, and
  // guessing is the thing this file exists to stop.
  if (!ledger || ledger.charCount === 0) {
    return { kind: 'defer', shape: 'unknown', why: 'no knowledge base' };
  }

  // A problem to solve. Checked BEFORE the topic shape, because a design
  // question about Kafka does lexically hit the Kafka employer fact — and
  // "that was the Apollo Hospitals work" is not how anyone opens an
  // exactly-once design answer.
  if (anyMatch(PROBLEM, q)) {
    return { kind: 'defer', shape: 'unknown', why: 'problem to solve — no fact opens this' };
  }

  const seed = hash(q);
  // What the interviewer has actually said, and nothing the app said back.
  // Built the same way the server builds `allowed` in routes/ai.js.
  const said = `${q}\n${interviewerLines(recentTurns)}`;
  const emit = (text: string, shape: OpenerShape): OpenerDecision => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > OPENER_MAX_CHARS) {
      return { kind: 'defer', shape, why: 'composed opener out of bounds' };
    }
    // Belt and braces. Everything here came from ledger spans, so this
    // should never fire — and if a phrase table is ever edited carelessly
    // it will fire instead of shipping an unsupported name.
    const bad = unverifiedProperNouns(ledger, clean, said);
    if (bad.length) {
      return { kind: 'defer', shape, why: `self-check rejected: ${bad.join(', ')}` };
    }
    return { kind: 'speak', text: clean, shape };
  };

  // ── 1. A named organisation ──
  const known = namedKnownOrg(ledger, q);
  if (known && known.kind === 'employer') {
    return emit(pick(YES_FORMS, seed)(known.subject, roleOf(known) || 'there', spokenDates(known.when)), 'entity-yes');
  }
  if (known && (known.kind === 'education' || known.kind === 'certification')) {
    // Real, but not a job. Say what it actually was rather than let the
    // main model imply employment.
    const what = known.kind === 'education' ? `that's where I did my ${roleOf(known)}` : 'that\'s a certification, not a role';
    return emit(`${known.subject} — ${what}.`, 'entity-yes');
  }

  const candidate = candidateEntity(q);
  if (candidate) {
    const inLedger = findOrganisation(ledger, candidate);
    if (!inLedger) {
      // ── A "NO" IS A CLAIM, AND IT NEEDS THE SAME EVIDENCE AS A "YES" ──
      //
      // Two ways this went wrong, both measured against the real database.
      //
      // 1. The name is in the documents, just not as an employer — a client
      //    in a project blurb, a platform in a skills line. Answering "no,
      //    I haven't" there contradicts the candidate's own resume, and the
      //    main model, which can see all of it, then says the opposite one
      //    sentence later.
      if (ledger.haystack.includes(candidate.toLowerCase())) {
        return { kind: 'defer', shape: 'entity-no', why: 'name is in the documents, but not as an organisation' };
      }
      // 2. NOTHING PARSED. When the extractor could not read this resume,
      //    an empty employer list is a fact about the PARSER, not about the
      //    candidate — and this branch used to `suppress`, which forbids
      //    the live-model cover too. So a resume the reader did not
      //    understand produced guaranteed silence on 3.7% of real
      //    questions: the exact dead air the whole feature exists to
      //    prevent, caused by the component meant to prevent it.
      if (ledger.employers.length === 0) {
        return { kind: 'defer', shape: 'entity-no', why: 'no employers parsed — absence is not evidence of absence' };
      }
      // 3. Denying employment is the strongest claim this file makes, so
      //    the thing being denied has to be recognisable as an employer.
      //    "Have you worked WITH Kubernetes?" wears the employer syntax and
      //    asks about a tool; declining here is what finally gives it the
      //    same outcome section 1b gives an unsupported tool — no opener at
      //    all — instead of the denial that used to come out of the branch
      //    above it. Deliberately a `defer` and not a fall-through into 1b:
      //    a name that reached this line is one the documents do NOT
      //    contain (step 1 caught the ones they do), and 1b matches on the
      //    first word, so falling through would answer "have you worked with
      //    Apache Airflow?" with "Apache, yes" off the back of Apache Kafka.
      //    Silence is the whole point of this branch.
      if (!deniableEntity(q, candidate)) {
        return { kind: 'defer', shape: 'entity-no', why: 'too weak a signal to deny employment on' };
      }
      // THE IBM CASE. A direct, true, instant no — the one answer the old
      // cover prompt forbade itself from giving.
      const orgs = listOrgs(ledger.employers.map((e) => e.subject));
      return emit(pick(NO_FORMS, seed)(orgs), 'entity-no');
    }
  }

  // ── 1b. "Have you used X?" — a tool, not an employer ──
  //
  // Deliberately asymmetric with the organisation case above, and the
  // asymmetry is the point. Not appearing on a resume MEANS something for
  // an employer — you either worked there or you did not — and means very
  // little for a tool, because a resume lists what fit on the page. So a
  // tool the documents support gets an instant, grounded yes, and a tool
  // they do not gets no opener at all rather than a "no" the candidate may
  // have to walk back.
  for (const re of EXPERIENCE_WITH) {
    const hit = re.exec(q);
    if (!hit || !hit[1]) continue;
    const asked = hit[1].replace(/[?.,!(].*$/, '').replace(/\s+/g, ' ').trim();
    if (!asked || asked.length < 2) break;
    // The vocabulary is every proper noun in the knowledge base; the
    // haystack is the final arbiter for anything it tokenised differently.
    const head = asked.split(/\s+/)[0].toLowerCase();
    const known = ledger.vocabulary.has(asked.toLowerCase())
      || ledger.vocabulary.has(head)
      || ledger.haystack.includes(asked.toLowerCase());
    // ⚠️ FALL THROUGH, do not return. This frame also catches the PLURAL
    // inventory question — "Which AWS services have you used for data
    // pipelines?", "What vector databases have you used?" — where what was
    // captured is a phrase rather than a product, so the vocabulary check
    // fails. Returning `defer` here answered those with silence while the
    // platforms shape below, which exists precisely to name the tools off a
    // skills line, was never reached.
    if (!known) break;
    // ⚠️ THE CAPTURED TERM HAS TO BE A TECHNOLOGY, AND THIS BRANCH USED TO
    // ACCEPT ANY VOCABULARY WORD. `ledger.vocabulary` is every proper noun
    // in the knowledge base, so "what is your experience in data
    // engineering?" captured "data engineering", matched on the head
    // `data`, and the app said out loud:
    //     "Yeah — data was a big part of the Apollo Hospitals work."
    // TOPIC_STOP was never consulted here — it guards the lexical branch
    // further down — so the same denylist that already contained `data`
    // did nothing. Both branches now answer to the same test.
    const askedLower = asked.toLowerCase();
    const isTech = isSpeakableTech(ledger, askedLower)
      || asked.split(/\s+/).some((p) => isSpeakableTech(ledger, p));
    if (!isTech) break;
    // A "how" question is not answered by naming where a tool was used.
    if (isProcessQuestion(q)) break;
    // Name where it happened when the ledger can place it, because "yes"
    // alone invites the follow-up this opener exists to get ahead of.
    const placed = selectFacts(ledger, asked, 3).find((f) => f.kind === 'employer');
    // ⚠️ THE PRODUCT, NOT THE VENDOR. When the captured phrase is not in
    // the vocabulary as a whole, this used to speak its FIRST word — so
    // "Have you used Apache Airflow in production?" was answered
    // "Yeah — Apache was a big part of the Apollo Hospitals work."
    // Nobody calls Airflow "Apache". Prefer the token the knowledge base
    // itself treats as a product, scanning from the END, because English
    // puts the vendor first and the thing second.
    const solo = soloToolVocabulary(ledger);
    const parts = asked.split(/\s+/);
    const product = [...parts].reverse().find((p) => solo.has(p.toLowerCase().replace(/[^a-z0-9+#.]/gi, '')));
    const label = ledger.vocabulary.has(asked.toLowerCase())
      ? asked
      : (product || parts[0]);
    return placed
      ? emit(pick(HAVE_USED_FORMS, seed)(label, placed.subject), 'topic')
      : emit(pick(HAVE_USED_NO_ORG_FORMS, seed)(label), 'topic');
  }

  // ── 2. Background / introduce yourself ──
  if (anyMatch(BACKGROUND, q)) {
    const cur = currentRole(ledger);
    if (cur) {
      const prev = ledger.employers.filter((e) => e !== cur).slice(0, 2).map((e) => e.subject);
      const tail = prev.length ? ` Before that, ${listOrgs(prev, 2)}.` : '';
      const since = tenure(cur.when);
      return emit(`${roleOf(cur) || 'Engineer'} at ${cur.subject}${since ? ` ${since}` : ''}.${tail}`, 'background');
    }
  }

  // ── 2b. Education ──
  //
  // ⚠️ ANSWER THE DEGREE THAT WAS ASKED ABOUT, OR SAY NOTHING.
  //
  // The EDUCATION matcher above deliberately recognises "bachelors" and
  // "masters" as separate questions — and this selection then ignored the
  // difference. `selectFacts` ranks by lexical overlap, so "what was your
  // bachelors on?" shares no term with "Master of Science", scores nothing,
  // and fell through to `|| ledger.education[0]` — the most recent entry.
  // Measured on a real résumé: the candidate was asked about their
  // BACHELORS and spoke "Indiana University — Master of Science".
  //
  // That is the same shape as the `ledger.skills[0]` fallback removed from
  // the platforms branch below, and it fails the same way: nothing matched,
  // so it guessed, and a guess here is spoken instantly and with
  // confidence. When the question names a level we do not have, deferring
  // is correct — the main model answers from the full résumé a beat later.
  if (anyMatch(EDUCATION, q)) {
    const wantsUndergrad = /\b(?:bachelor'?s?|undergrad(?:uate)?|b\.?s\.?|b\.?a\.?|b\.?tech|b\.?e\.?)\b/i.test(q);
    const wantsPostgrad = /\b(?:master'?s?|m\.?s\.?|m\.?tech|mba|ph\.?d|doctorate|post-?grad(?:uate)?)\b/i.test(q);
    // Only when the question picks exactly ONE level is there a wrong
    // answer to give. "where did you study" stays as it was.
    const level = wantsUndergrad !== wantsPostgrad
      ? (wantsUndergrad ? /\b(?:bachelor|b\.?s\.?|b\.?a\.?|b\.?tech|b\.?e\.?)\b/i : /\b(?:master|m\.?s\.?|m\.?tech|mba|ph\.?d|doctor)\b/i)
      : null;

    const matchesLevel = (f: typeof ledger.education[number]) =>
      !level || level.test(`${roleOf(f) || ''} ${f.detail || ''}`);

    const ranked = selectFacts(ledger, q, 2, ['education']).filter(matchesLevel);
    const edu = ranked[0]
      // The blind fallback survives ONLY for an unqualified question, where
      // any degree is a truthful answer.
      || (level ? ledger.education.filter(matchesLevel)[0] : ledger.education[0]);
    if (edu) {
      const what = roleOf(edu);
      if (what) return emit(pick(EDUCATION_FORMS, seed)(what, edu.subject, spokenDates(edu.when)), 'background');
    }
  }

  // ── 3. Platforms / stack ──
  //
  // The LABEL of the chosen skills line is the first thing said out loud,
  // so a line whose label matches the question wins over one that merely
  // shares a word in its tool list. Asked "what platforms have you worked
  // on", plain lexical ranking picked "Warehousing & Data Modelling" (one
  // short line, one incidental hit) and the answer model then opened its own
  // sentence with "On the platform side, AWS is where I've worked most
  // deeply" — the opener and the answer disagreeing about the subject, one
  // clause apart. The label carries the topic; rank on it first.
  if (anyMatch(PLATFORMS, q)) {
    // Singularised, because the question says "platforms" and the resume's
    // label says "AWS Data Platform". A plain substring test misses that by
    // one letter, which is exactly how the label match failed to fire on
    // the most literal platforms question there is.
    const stem = (t: string) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t);
    const qTerms = new Set(
      q.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 3).map(stem),
    );
    // ── MATCH THE ITEMS, NOT JUST THE HEADING, AND NEVER GUESS ──
    //
    // This used to score sections by HEADING alone and then fall back to
    // `ledger.skills[0]` — an arbitrary section — and speak its FIRST three
    // items. Graded on the real question corpus, that produced, aloud:
    //
    //   "What vector databases have you used (OpenSearch, Neptune,
    //    Pinecone)?"   -> "Databases — PostgreSQL, MySQL, MongoDB."
    //        …while the résumé's own Databases line lists Pinecone,
    //          Weaviate, Milvus and Chroma. It had the answer and read
    //          past it.
    //   "What are the Tableau tools did you use?"
    //                  -> "Data Engineering Tools — Airflow, Prefect, Spark."
    //   "what's g technology is based on?"
    //                  -> "Programming Languages — Java, Spring Boot, Python."
    //
    // So: score a section by how many of ITS ITEMS the question names, with
    // the heading worth less than an item; surface the items that MATCHED
    // rather than the first three; and when nothing matches, say nothing.
    // An arbitrary section spoken with confidence is the "trivial résumé
    // recall" this engine is supposed to be better than.
    // ⚠️ WHOLE TOKENS, WEIGHTED BY HOW DISTINCTIVE THEY ARE.
    //
    // A substring test lets the most generic word in the question decide
    // the answer. "What is your experience with the ETL tools, work
    // orchestration, airflow…" scored `data` against "Data Quality" and
    // answered "SRE & Governance — Data Quality, Data Observability" — a
    // section the question never mentioned — while the Data Engineering
    // Tools line, which literally lists Airflow, sat unread. Matching whole
    // tokens and weighting by term length makes `airflow` (7) outrank
    // `data` (4), which is the whole difference.
    //
    // Items are cleaned first: firstTools splits "Elasticsearch (or
    // OpenSearch)" into a fragment beginning with a conjunction, and
    // "or OpenSearch" spoken aloud is an obvious parse artifact.
    const cleanItem = (t: string) => t.replace(/^(?:or|and|e\.g\.?|etc\.?)\s+/i, '').trim();
    const scoreOf = (s: Fact): { score: number; hits: string[] } => {
      const items = firstTools(s, 40).map(cleanItem).filter(Boolean);
      const scored: Array<{ item: string; w: number }> = [];
      for (const it of items) {
        const toks = new Set(it.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean).map(stem));
        let w = 0;
        for (const t of qTerms) if (toks.has(t)) w = Math.max(w, t.length);
        if (w) scored.push({ item: it, w });
      }
      // Most distinctive match first, so "Pinecone" is spoken before the
      // category word "Vector Databases" that happens to sit beside it.
      scored.sort((a, b) => b.w - a.w);
      const label = s.subject.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean).map(stem);
      let headScore = 0;
      for (const t of qTerms) if (label.includes(t)) headScore = Math.max(headScore, t.length);
      // ⚠️ THE BEST MATCH DECIDES, NOT THE MOST MATCHES.
      // Summing let a section win on volume: "…ETL tools, work
      // orchestration, airflow…" matched the generic `data` against three
      // items of "SRE & Governance — Data Quality, Data Observability,
      // Data Contracts" (3 x 4) and beat the single `airflow` (1 x 7) in
      // the section that literally lists Airflow. One distinctive hit is
      // worth more than three vague ones, so the max leads and the count
      // only breaks ties.
      const maxW = scored.length ? scored[0].w : 0;
      const score = maxW * 10 + Math.min(scored.length, 3) + headScore;
      // A hit that merely repeats the heading ("Vector Databases" under
      // "Databases") is a sub-category label, not a product. Keep it, but
      // behind anything concrete — nobody answers "which databases?" with
      // the word "databases".
      const isCategoryish = (it: string) => {
        const toks = it.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean).map(stem);
        return toks.length > 1 && toks.some((t) => label.includes(t));
      };
      const concrete = scored.filter((x) => !isCategoryish(x.item));
      const rest = scored.filter((x) => isCategoryish(x.item));
      return { score, hits: [...concrete, ...rest].map((x) => x.item) };
    };
    let best: Fact | null = null;
    let bestHits: string[] = [];
    let bestScore = 0;
    for (const s of ledger.skills) {
      const { score, hits } = scoreOf(s);
      if (score > bestScore) { bestScore = score; best = s; bestHits = hits; }
    }
    // No fallback to an arbitrary section, and never in front of a "how"
    // or "describe" question — a skills list does not answer either.
    const skill = bestScore > 0 && !isProcessQuestion(q) ? best : null;
    if (skill) {
      // The matched items first; top up from the section when the match was
      // on the heading alone, or when everything that matched was the
      // category word itself — "which databases?" answered with the word
      // "Databases" is not an answer, so name actual products beside it.
      const picked = bestHits.slice(0, 3);
      if (picked.length < 3) {
        for (const t of firstTools(skill, 8)) {
          if (picked.length >= 3) break;
          if (!picked.some((p) => p.toLowerCase() === t.toLowerCase())) picked.push(t);
        }
      }
      const tools = picked.slice(0, 3).join(', ');
      // A skills section written as a bare list has no heading to speak, so
      // the label is the reserved placeholder rather than the candidate's
      // own words. Saying it out loud would be inventing a category.
      if (tools) {
        return skill.subject === GENERIC_SKILL_LABEL
          ? emit(pick(UNLABELLED_PLATFORM_FORMS, seed)(tools), 'platforms')
          : emit(pick(PLATFORM_FORMS, seed)(skill.subject, tools), 'platforms');
      }
    }
  }

  // ── 4. Favourite project ──
  if (anyMatch(PROJECT, q)) {
    const ranked = selectFacts(ledger, q, 2, ['project']);
    const proj = ranked[0] || ledger.projects[0];
    if (proj) {
      const what = String(proj.detail || '').split(' — ')[0].replace(/\s+/g, ' ').trim();
      if (what) return emit(pick(PROJECT_FORMS, seed)(proj.subject, what), 'project');
    }
  }

  // ── 4b. "What projects have you worked on?" — the list, not a favourite ──
  // Falls back to employers when the resume states no projects section:
  // where the work happened is a true and useful answer to the same
  // question, and it is what a candidate would actually say.
  if (anyMatch(PROJECTS_PLURAL, q)) {
    if (ledger.projects.length) {
      return emit(pick(PROJECTS_PLURAL_FORMS, seed)(listOrgs(ledger.projects.map((p) => p.subject), 3)), 'project');
    }
    if (ledger.employers.length) {
      return emit(pick(PROJECTS_PLURAL_FORMS, seed)(
        `the work at ${listOrgs(ledger.employers.map((e) => e.subject), 2)}`), 'project');
    }
  }

  // ── 4c. Where have you worked ──
  if (anyMatch(WHERE_WORKED, q) && ledger.employers.length) {
    return emit(pick(WHERE_WORKED_FORMS, seed)(listOrgs(ledger.employers.map((e) => e.subject))), 'platforms');
  }

  // ── 5. A topic the ledger can place ──
  // Only when a strong lexical hit lands on an EMPLOYER fact, i.e. the
  // knowledge base actually says where this work happened. A skills-line
  // hit alone is not enough to say "at X".
  const hits = selectFacts(ledger, q, 3);
  const emp = hits.find((f) => f.kind === 'employer');
  if (emp) {
    const qTokens = new Set(q.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean));
    // ⚠️ THE SHARED WORD HAS TO BE THE NAME OF A TECHNOLOGY.
    //
    // A denylist of common words was not enough, and could never be.
    // Measured against the real questions and four real resumes, the word
    // both strings shared was routinely an ordinary verb picked out of a
    // bullet — the app produced, out loud:
    //
    //     "Worked — yeah, that was the Piramal work."
    //     "engineering — yeah, that was the Jasper Therapeutics work."
    //
    // The knowledge base already states which words are technologies: they
    // are the ones in the skills lines and the projects' tech lists. A word
    // that is not one of those is not a tool, however capitalised a bullet
    // left it.
    // SOLO tools only here, because this branch SPEAKS the token. See
    // soloToolVocabulary: a word that only ever appears welded into a
    // longer name ("Google Cloud", "Snowflake schema modeling") is not a
    // product, and saying it aloud produced "cloud — yeah, that was the
    // G Technologies work."
    // LONGEST match, not first. "Have you used Apache Airflow?" shares both
    // `apache` and `airflow` with the bullet, and taking the first produced
    // "Yeah — Apache was a big part of the Apollo Hospitals work." The
    // vendor prefix is never the answer; the product is.
    //
    // isSpeakableTech rather than the solo list: a tool named only in an
    // experience bullet ("Owned Apache Kafka and Python pipelines", no
    // Streaming skills line) is still a tool, and requiring the skills list
    // deferred "tell me about your Kafka work" on exactly those résumés.
    // Category words are still excluded, and the two gates below — the
    // question must ASK about their experience and must not be a "how" —
    // are what make the looser word list safe here.
    const tool = String(emp.detail || '')
      .split(/[\s,;()]+/)
      .map((t) => t.replace(/[^A-Za-z0-9+#.]/g, ''))
      .filter((t) => t.length > 2 && qTokens.has(t.toLowerCase())
        && isSpeakableTech(ledger, t.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    // Speak only when the question actually asked about their experience,
    // and never in front of a "how" question — naming a tool begins to
    // answer neither.
    if (tool && asksAboutTheirExperience(q) && !isProcessQuestion(q)) {
      return emit(pick(TOPIC_FORMS, seed)(tool, emp.subject), 'topic');
    }
  }

  // Nothing certain to say. A live model may still fill the gap on the
  // slow routes; on the fast ones the answer itself arrives first.
  return { kind: 'defer', shape: 'unknown', why: 'no fact confidently answers this shape' };
}

/**
 * The compact, COMPLETE background a fallback model gets instead of nine
 * thousand characters of one document's prose.
 *
 * The old `coverContext` was `capText(concat(distilled files), 9000)`.
 * Measured on a real three-resume upload: 9,063 of 29,334 characters, and
 * with a unique marker per file, only the FIRST file reached the model at
 * all. On a 413K knowledge base it was 2.2%. This is every employer,
 * project, skill line and metric in the whole knowledge base, in ~1-3KB,
 * because facts do not grow the way prose does.
 */
export function ledgerDigest(ledger: Ledger, maxChars = 3_500): string {
  if (!ledger || ledger.charCount === 0) return '';

  // ⚠️ EVERY SECTION GETS ITS OWN BUDGET.
  //
  // This used to render every fact and then slice the result to `maxChars`,
  // which is a single tail truncation over a document whose sections are
  // written in a fixed order — so the LAST sections are the ones that
  // vanish. Measured, on knowledge bases built from the app's real files:
  //
  //     20K  →  ROLES, PROJECTS, SKILLS          (already truncated)
  //     85K  →  ROLES, PROJECTS                  (skills gone)
  //    200K  →  ROLES                            (everything else gone)
  //    400K  →  ROLES                            (only roles, and cut)
  //
  // So the more the candidate uploaded, the LESS the cover knew about them,
  // until a large knowledge base carried nothing but a list of employers —
  // no skills, no projects, no numbers. The fix is not a bigger cap: it is
  // that no section may consume another's share. Each renders inside its own
  // allowance and reports what it dropped, and unclaimed room is handed on,
  // so a small knowledge base still prints in full.
  const share = (fraction: number) => Math.max(220, Math.floor(maxChars * fraction));
  const budgets: Record<string, number> = {
    roles: share(0.38), projects: share(0.16), skills: share(0.24),
    education: share(0.08), certifications: share(0.06), metrics: share(0.08),
  };

  const out: string[] = [];
  let carry = 0;

  /** Render `items` under `head`, inside `budget`, and say what was cut. */
  const section = (key: string, head: string, items: string[]): void => {
    if (!items.length) return;
    const budget = budgets[key] + carry;
    const kept: string[] = [];
    let used = head.length + 1;
    for (const line of items) {
      if (used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    if (!kept.length) {
      // Nothing fits — say the section exists rather than imply it does not.
      // A model that is told "SKILLS: 14 lines not shown" will not claim the
      // candidate has no skills; one shown nothing at all might.
      out.push(`${head} [${items.length} not shown]`);
      carry = 0;
      return;
    }
    out.push(head);
    for (const k of kept) out.push(k);
    const dropped = items.length - kept.length;
    if (dropped > 0) out.push(`  […${dropped} more]`);
    carry = Math.max(0, budget - used);
  };

  // ⚠️ A ROLE WITHOUT ITS EVIDENCE IS A DENIAL WAITING TO HAPPEN.
  //
  // This rendered "- Apollo Hospitals — Software Engineer (Sep 2022 – Dec
  // 2023)" and stopped, dropping e.detail — which is where every bullet
  // lives, and with it every technology the candidate actually used. The
  // résumé said "Engineered Kafka and Python streaming services for 3M+
  // records/day"; the digest said a job title and two dates. Measured live
  // against real providers, asked "Have you worked with Kafka?", the cover
  // answered "not directly with Kafka in my roles" — and Kubernetes, Docker
  // and Terraform were absent from the digest entirely, so those got denied
  // too. The model was not hallucinating. It was answering honestly about a
  // document that had been emptied of the evidence.
  //
  // Headers are priced FIRST so every employer is still named even when the
  // budget is tight — losing an employer is worse than losing its detail.
  // Whatever is left over is split evenly across the roles as evidence, so a
  // two-role résumé gets rich lines and a ten-role one gets terse ones, and
  // neither overflows into the sections below.
  const roleHeads = ledger.employers.map(
    (e) => `- ${e.subject}${roleOf(e) ? ` — ${roleOf(e)}` : ''}${e.when ? ` (${e.when})` : ''}`);
  const headChars = roleHeads.reduce((n, h) => n + h.length + 1, 0);
  const nRoles = ledger.employers.length;
  // section() prices each ITEM whole, so an evidence line that overflows
  // takes its own header down with it — which is how the first cut of this
  // silently dropped the fifth employer entirely. Shrink the evidence until
  // every header provably fits; an employer must never be lost to make room
  // for another employer's detail.
  // 27 = the "ROLES (most recent first):" line section() charges before any
  // item; 3 = the "\n  " that prefixes each evidence line; 12 = slack, so a
  // rounding error cannot cost an employer.
  const ROLE_SECTION_OVERHEAD = 27 + 12;
  const room = budgets.roles - ROLE_SECTION_OVERHEAD - headChars - nRoles * 3;
  let perRole = nRoles > 0 ? Math.floor(room / nRoles) : 0;
  if (perRole < 50) perRole = 0;          // too tight to be worth a fragment
  section('roles', 'ROLES (most recent first):', ledger.employers.map((e, i) => {
    // Below ~50 chars an evidence line is a fragment that ends mid-word and
    // reads as noise; better to show the header alone than a stub.
    if (perRole < 50) return roleHeads[i];
    // e.detail opens with the title we already printed — drop that prefix
    // rather than spending the budget saying it twice.
    const body = String(e.detail || '').replace(/^[^—]{0,80}—\s*/, '').replace(/\s+/g, ' ').trim();
    if (!body) return roleHeads[i];
    let ev = body.slice(0, perRole);
    if (body.length > perRole) ev = ev.replace(/\s+\S*$/, '') + '…';   // never cut mid-word
    return `${roleHeads[i]}\n  ${ev}`;
  }));
  section('projects', 'PROJECTS:', ledger.projects.map(
    (p) => `- ${p.subject} — ${String(p.detail).slice(0, 120)}`));
  section('skills', 'SKILLS:', ledger.skills.map(
    (s) => `- ${s.subject === GENERIC_SKILL_LABEL ? '' : `${s.subject}: `}${firstTools(s, 6).join(', ')}`));
  section('education', 'EDUCATION:', ledger.education.map(
    (e) => `- ${e.subject} — ${roleOf(e)}${e.when ? ` (${e.when})` : ''}`));
  section('certifications', 'CERTIFICATIONS:', ledger.certifications.map((c) => `- ${c.subject}`));
  section('metrics', 'NUMBERS THAT ARE TRUE:', [ledger.metrics.map((m) => m.subject).join(', ')]);

  // A final guard, so the contract "never longer than maxChars" holds even
  // if a single rendered line is itself enormous.
  let text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n[…]';
  return text;
}

/**
 * Every proper noun the knowledge base contains, as one space-separated
 * string, so the server can check a fallback model's sentence without
 * being shipped the documents. ~4-6KB for a four-resume knowledge base,
 * and it replaces a 9KB prose block rather than adding to it.
 */
export function ledgerVocabulary(ledger: Ledger, maxChars = 8_000): string {
  if (!ledger || ledger.vocabulary.size === 0) return '';
  const all = Array.from(ledger.vocabulary);
  const whole = all.join(' ');
  if (whole.length <= maxChars) return whole;

  // ⚠️ WHAT A TRUNCATED VOCABULARY DROPS DECIDES WHAT THE APP CAN SAY.
  //
  // This used to sort longest-first, on the reasoning that "names are the
  // longer tokens". Measured against a 400K knowledge base built from the
  // app's own files, that reasoning is backwards: it dropped 1,026 real
  // names, and the ones it dropped were `venu`, `madhav`, `aws`, `etl`,
  // `rag`, `ai` — the candidate's own name and the acronyms a technical
  // answer is made of — while keeping the run-together junk that PDF text
  // extraction produces, because that junk is long.
  //
  // A name missing here is not a missing name: server/src/services/
  // groundingGuard.js treats anything outside this list as INVENTED and
  // throws the cover away. So the old ordering made a large knowledge base
  // silently reject its own true sentences.
  //
  // Order by how likely a word is to be SPOKEN, which is knowable:
  //   1. words in the facts and in the documents' opening lines — the
  //      employers, projects, tools and the candidate's own name, which is
  //      also exactly what the digest shows the model;
  //   2. short tokens, because acronyms are short and acronyms are what a
  //      technical answer names;
  //   3. everything else.
  const priority = new Set<string>();
  const admit = (s: string): void => {
    for (const w of String(s || '').toLowerCase().split(/[^a-z0-9+#.'’-]+/)) {
      if (w.length >= 2 && ledger.vocabulary.has(w)) priority.add(w);
    }
  };
  for (const f of ledger.facts) { admit(f.subject); admit(f.detail); }
  admit(ledger.heads);

  const rest = all.filter((w) => !priority.has(w)).sort((a, b) => a.length - b.length);
  const ordered = [...priority, ...rest];

  const kept: string[] = [];
  let used = 0;
  for (const w of ordered) {
    if (used + w.length + 1 > maxChars) continue;
    kept.push(w);
    used += w.length + 1;
  }
  return kept.join(' ');
}

/** Test/diagnostic: why a question produced what it produced. */
export function _explain(ledger: Ledger, question: string): string {
  const d = composeOpener(ledger, question);
  if (d.kind === 'speak') return `speak[${d.shape}] "${d.text}"`;
  return `${d.kind}[${d.shape}] ${d.why}`;
}
