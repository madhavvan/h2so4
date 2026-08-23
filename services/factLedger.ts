// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FACT LEDGER — the knowledge base as CHECKABLE FACTS, not prose
//
//  What went wrong without it, in the user's own transcript:
//
//    Q: "on what platforms have you worked most and what's your fav
//        project?"
//    A: "I've worked mostly on Linux and Windows, and my favorite project
//        was at IBM, building a cloud-based system for data analytics.
//        Most of my production data work has been on AWS — S3, Glue,
//        Redshift … the healthcare event platform at Apollo …"
//
//  The first sentence is the spoken opener, produced by a fast model. The
//  rest is the answer model reading the resume correctly. IBM appears
//  nowhere in the knowledge base; neither does Linux. The candidate said
//  it out loud, and when the interviewer pushed back the app produced a
//  second invented employer (Accenture) to explain the first.
//
//  The diagnosis that matters: the opener HAD the resume. Measured — the
//  cover prompt carried 7,635 characters of it, with Siemens, Apollo and
//  KIMS all present. Handing a 70B model at temperature 0.7 a document, a
//  twelve-word budget and a 1.5-second deadline does not make its output
//  true. Nothing in the pipeline ever checked.
//
//  So: stop asking a model to be careful, and make the claim checkable.
//  Every fact here carries the span of the file it came from, so a fact
//  that is not literally in the knowledge base cannot exist. And the
//  vocabulary set below is the whole KB's proper nouns — which is all you
//  need to catch "IBM" in a millisecond, deterministically, before the
//  candidate ever hears it.
//
//  Measured on the four real resumes in the user's own database:
//    · 11 employer / education / certification lines each, with company
//      AND dates, from PDF text that contains 2 newlines in 9,803 chars
//    · 242-269 distinct proper nouns
//    · IBM: absent. Accenture: absent. Goldman: absent. Infosys: absent.
//
//  Pure, synchronous, no network, no model. Cheap enough to rebuild on
//  every knowledge-base change, which is exactly what it does.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { ContextFile } from '../types';

export type FactKind =
  | 'employer' | 'education' | 'certification' | 'project' | 'skill' | 'metric';

export interface FactSpan {
  fileId: string;
  fileName: string;
  from: number;
  to: number;
}

export interface Fact {
  kind: FactKind;
  /** The organisation, project name, skill label or metric — the thing itself. */
  subject: string;
  /** Role, degree, issuer, tech list — whatever qualifies the subject. */
  detail: string;
  /** Dates exactly as the document writes them, or '' when undated. */
  when: string;
  /** Lowercased terms for lexical selection against a question. */
  tokens: string[];
  /** Where this came from. A fact with no span is a fact we refuse to hold. */
  span: FactSpan;
}

export interface Ledger {
  fingerprint: string;
  facts: Fact[];
  employers: Fact[];
  education: Fact[];
  certifications: Fact[];
  projects: Fact[];
  skills: Fact[];
  metrics: Fact[];
  /**
   * Every proper noun that literally appears in the knowledge base,
   * lowercased and split to single tokens. This is the fabrication guard's
   * authority: a capitalised name the candidate is about to SAY that is
   * not in here was invented.
   */
  vocabulary: Set<string>;
  /** The whole KB, lowercased — final arbiter for a substring check. */
  haystack: string;
  /**
   * The opening lines of each candidate document, where a resume puts the
   * person's NAME. Nothing else in the ledger contains it — a name is not a
   * fact about employment — and a spoken opener that introduces the
   * candidate says it, so the guard has to be able to recognise it.
   */
  heads: string;
  charCount: number;
  /** Candidate-owned documents only — job descriptions are not counted. */
  fileCount: number;
  /** How many uploaded files were job postings and therefore ignored. */
  jdCount: number;
}

// ── The employer line ──
// "Data Engineer | Siemens, Dallas, TX | April 2026 – Present". Lifted from
// aiProxyService's EMPLOYER_LINE, where it is already trusted as a safety
// assertion, and for the same reason the comment there gives: the trailing
// year is what stops it matching ordinary prose. On a PDF — one blob, no
// newlines — the leading role field greedily swallows the sentence before
// it, so `cleanRole` below trims that back off.
const EMPLOYER_LINE = /[A-Za-z][^|\n●•]{2,60}\|[^|\n●•]{2,80}\|[^|\n●•]{0,40}(?:(?:19|20)\d{2}|Present|Current)/g;

// Longest-first inside each family: JS alternation is leftmost-first, so a
// bare `SKILLS` listed before `TECHNICAL SKILLS` would match the second word
// of the heading and leave "TECHNICAL " attached to whatever came before it.
const SECTION_HEAD_SRC = '(?:PROFESSIONAL WORK EXPERIENCE|PROFESSIONAL EXPERIENCE|WORK EXPERIENCE|RELEVANT EXPERIENCE|EMPLOYMENT HISTORY|EMPLOYMENT|EXPERIENCE|PROJECTS?|EDUCATION|CERTIFICATIONS?|LICENSES?|TECHNICAL SKILLS|CORE SKILLS|KEY SKILLS|SKILLS & TOOLS|SKILLS AND TOOLS|TECHNICAL EXPERTISE|TECHNICAL PROFICIENCIES|CORE COMPETENCIES|AREAS OF EXPERTISE|TECHNICAL SUMMARY|SKILLS|PROFESSIONAL SUMMARY|CAREER SUMMARY|SUMMARY|PROFILE|OBJECTIVE|ACHIEVEMENTS|AWARDS|PUBLICATIONS)';

// A degree phrase in the role slot means the line is education, not a job;
// an issuer phrase means it is a certification. Same regex finds all three
// because a resume writes them in the same three-column shape.
const DEGREE_RE = /\b(bachelor|master|b\.?s\.?|m\.?s\.?|b\.?tech|m\.?tech|ph\.?d|mba|associate degree|diploma)\b/i;
const CERT_RE = /\b(certified|certification|certificate)\b/i;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIGATURE REPAIR — the bug that made a CERTIFICATION an EMPLOYER
//
//  Some PDF generators emit the fi/fl/ff ligatures as their own glyph
//  runs, and pdfjs then hands us the word broken apart with spaces:
//  "Certi fi ed", "Snow fl ake", "e ffi ciency".
//
//  That is not cosmetic. CERT_RE is what stops a certification line
//  being read as employment — and `/\bcertified\b/` cannot match
//  "Certi fi ed". So on one real résumé the line
//
//      AWS Certi fi ed Solutions Architect - Associate | Amazon Web Services | Jun 2023
//
//  missed the certification branch, fell through to the employer branch,
//  and the candidate's spoken opener became:
//
//      "AWS Certi fi ed Solutions Architect at Amazon Web Services in 2023.
//       Before that, Microsoft and Databricks."
//
//  Three employers the candidate never had, said out loud, first, in an
//  interview — while the real ones lost on date order. The ligature
//  splitting and the certs-as-employment fabrication were logged as two
//  separate observations; they are one bug, cause and effect.
//
//  Repaired at the single point every extractor's text flows through
//  (buildLedger), so classification, vocabulary and the spoken strings
//  are all fixed by the same pass.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Real Unicode ligature codepoints — a pure character mapping, no
// judgement involved. Some extractors emit these instead of splitting.
const LIGATURE_CHARS: Array<[RegExp, string]> = [
  [/ﬀ/g, 'ff'], [/ﬁ/g, 'fi'], [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'], [/ﬄ/g, 'ffl'], [/ﬅ/g, 'st'], [/ﬆ/g, 'st'],
];

// The space-split form. Only rejoined when the cluster stands alone
// BETWEEN two lowercase letter fragments — "Certi fi ed", "Snow fl ake".
// A capital on either side ("Wi Fi") is left alone, and the handful of
// real English phrases where a bare "fi"/"fl" legitimately follows a word
// are excluded outright rather than guessed at.
// The preceding lowercase run is captured WHOLE so the genuine English
// phrases where a bare "fi" follows a word can be excluded by name rather
// than guessed at.
const SPLIT_LIGATURE = /([a-z]+)\s(ffi|ffl|ff|fi|fl)\s([a-z])/g;
const LIGATURE_KEEP_APART = /^(sci|hi|wi|lo)$/i;

/**
 * Undo PDF ligature damage. Length-changing, which is safe here because
 * every span offset in the ledger indexes the REPAIRED text — buildLedger
 * normalises once, up front, and nothing outside it re-slices the original
 * file content by span.
 */
export function repairLigatures(input: string): string {
  if (!input) return input;
  let s = input;
  for (const [re, to] of LIGATURE_CHARS) s = s.replace(re, to);
  if (s.indexOf(' fi ') === -1 && s.indexOf(' fl ') === -1
      && s.indexOf(' ff ') === -1 && s.indexOf(' ffi ') === -1 && s.indexOf(' ffl ') === -1) {
    return s;
  }
  // NB: an earlier draft protected "sci fi" with a NUMERIC placeholder and
  // restored it afterwards — that would have corrupted every real number in
  // the resume on the way back, since " 2023 " reads as an index. Deciding
  // inside the replace callback needs no placeholder at all.
  const join = (whole: string, pre: string, lig: string, post: string) =>
    (lig === 'fi' && LIGATURE_KEEP_APART.test(pre)) ? whole : pre + lig + post;
  return s.replace(SPLIT_LIGATURE, join).replace(SPLIT_LIGATURE, join);
}



// Numbers a candidate can safely speak, with their unit. Deliberately
// unit-anchored: a bare "45" is not a fact, "45 minutes" is.
// ⚠️ The terminator is a negative lookahead, NOT `\b`.
//
// `\b` after the unit requires a WORD character on the far side, and `%` is
// not a word character — so "cut end-to-end latency 94%." failed to match,
// because the character after the percent sign is a full stop. Every
// percentage in every resume was silently dropped, which is why the digest
// only ever listed counts like "3M" and "200K" and never a single one of
// the improvements a candidate most wants to say out loud.
const METRIC_RE = /(?:~|≈|over |under |about |around |roughly )?\d[\d,.]*\s*(?:%|percent|M\+?|K\+?|B\+?|million|billion|thousand|x|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?|QPS|TPS|rps|ms|GB|TB|PB)(?![A-Za-z0-9])/gi;

/**
 * The subject given to a skills section that lists capabilities one per
 * line with no "Label:" prefix — there is no heading in the document to
 * use, and inventing one would be the opener speaking a phrase the
 * candidate never wrote. instantOpener checks for this exact string.
 */
export const GENERIC_SKILL_LABEL = 'Skills';

// How much of the text under a role belongs to that role's fact. A real
// entry is 2-5 bullets, ~400-900 chars; 1,600 is generous and it bounds
// the damage when a document has no recognisable next boundary.
const EMPLOYER_BODY_CHARS = 1_600;

// A ceiling per document, so a 400K knowledge base cannot turn into tens of
// thousands of metric facts that nothing will ever select.
const METRICS_PER_FILE = 60;

// Capitalised runs — organisations, products, tools. Allows the internal
// lowercase joiners a real name uses ("Nizam's Institute of Medical
// Sciences", "Amazon Web Services").
// ⚠️ Mirror of the server's groundingGuard.js — the parity test pins them.
// The class must reach past ASCII: measured live, a CORRECT cover naming
// "Bausch+Ströbel" was rejected as `invented=[Bausch+Str]` because the run
// stopped at the "ö". Latin-1 Supplement + Latin Extended-A/B covers the
// European vendor names this domain is full of.
const NAME_CHAR = "A-Za-z0-9\\u00C0-\\u024F&.+#'’-";
const NAME_HEAD = 'A-Z\\u00C0-\\u00DE';
const PROPER_RUN = new RegExp(
  `\\b[${NAME_HEAD}][${NAME_CHAR}]*`
  + `(?:\\s+(?:of|the|and|&|for)\\s+[${NAME_HEAD}][${NAME_CHAR}]*`
  + `|\\s+[${NAME_HEAD}][${NAME_CHAR}]*){0,4}\\b`,
  'g',
);

// Words that are capitalised because a sentence started, or because English
// capitalises them — never because they name an organisation. Kept small on
// purpose: the guard only ever consults this for tokens it is about to
// FLAG, and a false negative here costs nothing (the haystack check runs
// first and passes anything the KB actually contains).
const DISCOURSE = new Set([
  'i', 'a', 'an', 'the', 'and', 'or', 'but', 'so', 'yeah', 'yes', 'no', 'not',
  'my', 'me', 'we', 'our', 'us', 'you', 'your', 'it', 'its', 'they', 'them',
  'this', 'that', 'these', 'those', 'there', 'here', 'then', 'than', 'when',
  'where', 'what', 'which', 'who', 'why', 'how', 'if', 'because', 'before',
  'after', 'while', 'most', 'more', 'less', 'much', 'many', 'some', 'any',
  'all', 'both', 'each', 'other', 'another', 'first', 'second', 'third',
  'honestly', 'basically', 'actually', 'really', 'mostly', 'right', 'okay',
  'sure', 'well', 'like', 'just', 'still', 'also', 'even', 'about', 'around',
  'over', 'under', 'across', 'between', 'through', 'during', 'from', 'into',
  'onto', 'with', 'without', 'for', 'at', 'on', 'in', 'to', 'of', 'by', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall',
  'may', 'might', 'must', 'let', 'going', 'went', 'got', 'get', 'make',
  'made', 'take', 'took', 'come', 'came', 'see', 'saw', 'say', 'said',
  'think', 'thought', 'know', 'knew', 'work', 'worked', 'working', 'built',
  'build', 'building', 'own', 'owned', 'owning', 'ran', 'run', 'running',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'present', 'current',
]);

// The words a sentence is allowed to START with without being read as a
// name. DISCOURSE above is consulted for every token in the text; this list
// exists only for the first word of a sentence, where the check used to be
// waived outright. Narrowing that waiver is what finally catches "Google is
// where I spent most of my time" — but it also means an ordinary opener like
// "Typically" or "Um" would be reported as an invented company unless it is
// listed somewhere, so anything English capitalises purely by POSITION
// belongs here. Extending this list is always the right answer to a false
// positive: a dropped opener is a moment of silence, and the answer is
// regenerated; a missed name is a lie spoken to an interviewer.
//
// The truncated-looking members near the end — 'don', 'doesn', 'wouldn' —
// are not typos. A contraction is normalised by stripping a trailing 't, so
// "Don't" arrives at the check as 'don', the same stripping that lets 'i'
// cover "I'd".
//
// Kept byte-identical to SENTENCE_OPENERS in
// server/src/services/groundingGuard.js. The parity test fails if they drift.
const SENTENCE_OPENERS = new Set([
  'probably', 'typically', 'usually', 'generally', 'normally', 'often',
  'sometimes', 'always', 'never', 'maybe', 'perhaps', 'obviously', 'clearly',
  'certainly', 'definitely', 'essentially', 'effectively', 'ultimately',
  'eventually', 'initially', 'originally', 'previously', 'recently',
  'currently', 'today', 'ideally', 'realistically', 'practically',
  'technically', 'specifically', 'especially', 'primarily', 'largely',
  'roughly', 'nearly', 'almost', 'partly', 'similarly', 'overall',
  'exactly', 'correct', 'sorry', 'thanks', 'agreed', 'true', 'fair',
  'although', 'though', 'unless', 'until', 'since', 'whereas', 'whenever',
  'wherever', 'whatever', 'whether', 'plus', 'besides', 'however',
  'meanwhile', 'otherwise', 'therefore', 'anyway', 'anyhow', 'instead',
  'rather', 'next', 'finally', 'lastly', 'later', 'earlier', 'once', 'now',
  'soon', 'again', 'back', 'within', 'toward', 'along', 'beyond', 'above',
  'below', 'behind', 'inside', 'outside', 'against', 'among', 'per', 'via',
  'versus', 'unlike', 'part',
  'every', 'everything', 'everyone', 'either', 'neither', 'none', 'nothing',
  'nobody', 'something', 'someone', 'anything', 'anyone', 'few', 'several',
  'enough', 'half', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten',
  'he', 'she', 'him', 'her', 'his', 'hers', 'their', 'theirs', 'ours',
  'mine', 'yours', 'myself', 'itself', 'themselves',
  'imagine', 'looking', 'given', 'depends', 'depending', 'assuming',
  'starting', 'suppose', 'consider', 'compared', 'speaking', 'granted',
  'used', 'need', 'needed', 'want', 'wanted', 'try', 'tried', 'done',
  'good', 'great', 'best', 'better', 'main', 'key',
  'um', 'uh', 'hmm', 'ok', 'alright',
  'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'won', 'wouldn',
  'couldn', 'shouldn', 'haven', 'hasn', 'hadn', 'ain',
  // Connective and stance adverbs. Measured against real covers, not
  // imagined: a live run rejected a correct, grounded answer because it
  // said "Additionally," — the list had 'however' and 'therefore' but not
  // its equally ordinary siblings, so the earned waiver could not be
  // earned and an English adverb was reported as an invented company.
  'additionally', 'furthermore', 'moreover', 'consequently', 'likewise',
  'conversely', 'regardless', 'admittedly', 'arguably', 'frankly',
  'importantly', 'notably', 'crucially', 'historically', 'subsequently',
  'lately', 'occasionally', 'frequently', 'rarely', 'possibly',
  'apparently', 'seemingly', 'presumably', 'hopefully', 'thankfully',
  'unfortunately', 'interestingly', 'surprisingly',
  // Plain adjectives, quantifiers and engineering adjectives that a real
  // JUDGEMENT starts with. Added 2026-08-06 when the cover prompt stopped
  // asking for a description of process and started asking for the thing
  // that is already true — at which point the openings it produced began
  // with words like these, and every one was rejected as an invented
  // company. Same failure the 'additionally' note above records; the
  // isInflectedEnglish() rule below now covers the -ing/-ly/-tion shapes
  // generically, and these are the ones morphology cannot reach.
  // Abstract nouns a judgement opens on. "Success signals don't
  // necessarily mean correctness…" was rejected as an invented company
  // over the word `Success` — morphology cannot reach these (no suffix to
  // read) and they are the vocabulary of exactly the sentences this engine
  // was rebuilt to produce.
  'success', 'failure', 'correctness', 'completion', 'accuracy',
  'throughput', 'ordering', 'reliability', 'availability', 'durability',
  'quality', 'safety', 'speed', 'scale', 'volume', 'freshness', 'staleness',
  'strict', 'strictly', 'daily', 'hourly', 'weekly', 'monthly',
  'green', 'both', 'most', 'many', 'much', 'any', 'all', 'each',
  'real', 'simple', 'hard', 'easy', 'wrong', 'right', 'full',
  'complete', 'partial', 'fast', 'slow', 'cheap', 'accurate',
  'atomic', 'idempotent', 'transactional', 'eventual', 'immediate',
  'duplicate', 'duplicates', 'sequential', 'parallel', 'linear',
  // Siblings of words already on this list, plus the two the live corpus
  // run actually caught. earlier and lately were here while early and late
  // were not, so a judgement opening on the plain adjective was reported as
  // an invented company. human earns its place through the compound rule
  // below: it is the head of human-in-the-loop, which a real cover about
  // agent design opens with and which was discarded as an employer.
  'early', 'late', 'please', 'human',
  // ── THE CLOSED CLASS, COMPLETED ONCE INSTEAD OF ONE WORD AT A TIME ──
  //
  // This list has now failed FIVE separate times on the same grammatical
  // class: Additionally (2026-08-06) -> Success -> Early/Late/Please ->
  // Thus (2026-08-17, a correct no-KB cover rejected as an invented
  // company). Each fix added the one word that bit, which is why it kept
  // recurring: a denylist-by-omission is only ever as complete as its
  // last failure.
  //
  // The escapees are not random words — they are DISCOURSE CONNECTIVES
  // and judgement openers, a closed grammatical class. Unlike nouns (the
  // open class, where the fabrication risk lives: Apple, Oracle, Fidelity)
  // connectives are finite and enumerable, so the right fix is to finish
  // the class in one deliberate pass. Morphology already covers the -ly
  // shapes (accordingly, namely, firstly); these are the suffix-less ones
  // it cannot reach. None is a company name, which is the admission test —
  // see the '-ity'/Fidelity note above for the precedent.
  'thus', 'hence', 'indeed', 'yet', 'only', 'further',
  'thereby', 'therein', 'thereafter', 'hereby', 'herein', 'henceforth',
  'whereby', 'wherein', 'albeit', 'whilst', 'nonetheless', 'nevertheless',
  'elsewhere', 'altogether', 'together', 'aside', 'apart', 'somehow',
  'somewhat', 'quite', 'twice', 'worse', 'worst',
  // Judgement adjectives with no suffix for morphology to read, sitting in
  // the same block as 'strict'/'real'/'wrong' above and added by the same
  // rule: words a technical verdict genuinely opens with.
  'critical', 'common', 'likely', 'unlikely', 'possible', 'impossible',
  'necessary', 'zero', 'single', 'double',
]);

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of String(s || '').toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const w = raw.replace(/^\.+|\.+$/g, '');
    if (w.length >= 2 && w.length <= 40) out.push(w);
  }
  return out;
}

/**
 * Trim the prose a PDF glues onto the front of the role field.
 *
 * The real first match on the user's resume begins "…view PROFESSIONAL
 * EXPERIENCE Data Engineer" — the tail of the summary, the section
 * heading, then the actual role. Cut at the last section heading, then at
 * the last sentence end, and keep the remainder.
 */
// The section headings, as bare words, so a TRUNCATED one can be
// recognised by its tail. EMPLOYER_LINE's role field is capped at 60
// characters, so on a line like
//   "CERTIFICATIONS  AWS Certified Solutions Architect – Associate | …"
// the match begins mid-heading and the field arrives as
//   "TIFICATIONS AWS Certified Solutions Architect – Associate"
// — which then became the certification's NAME. A leading all-caps
// fragment that is a proper suffix of a real heading is heading debris,
// and nothing else looks like that.
const HEAD_WORDS = SECTION_HEAD_SRC
  .replace(/^\(\?:/, '').replace(/\)$/, '')
  .split('|')
  .flatMap((h) => h.replace(/\?/g, '').split(/\s+/))
  .map((w) => w.toUpperCase())
  .filter((w) => w.length >= 4);

function isHeadingDebris(token: string): boolean {
  const t = token.toUpperCase();
  if (t.length < 2 || !/^[A-Z]+$/.test(t)) return false;
  return HEAD_WORDS.some((h) => h !== t && h.endsWith(t));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "Role:" IS A LABEL, NOT PART OF THE VALUE
//
//  Documents label their fields inline: "Role: Jr Telecom Core Engineer |
//  Client: NTT Global Data Centers Americas". The label rode into the value
//  and the app SPOKE it, twice in one run — "Role: Jr Telecom Core Engineer
//  / Network Infrastructure Engineer at NTT".
//
//  The previous fix listed the label WORDS (client, role, company, title…)
//  and so cleaned the org field while leaving the role field broken — a
//  list that has to be extended for every new document convention. The
//  shape is the signal instead: a short run of words followed by a colon,
//  at the very start of a field, is a label in any vocabulary and any
//  Latin-script language.
//
//  Bounded deliberately. 24 characters is about three words, which is
//  every field label a document actually uses; longer than that and a
//  colon is punctuation inside a real value ("Snowflake: the migration"),
//  which must survive.
function stripFieldLabel(s: string): string {
  const m = /^([A-Za-z][A-Za-z/ ]{0,20}):\s*/.exec(s);
  if (!m) return s;
  // A label is a short noun, one or two words. Anything longer is prose
  // that happens to contain a colon, and stripping it eats real content:
  // "Microsoft Certified: Azure Data Engineer Associate | Microsoft" lost
  // its first half at a 24-character bound, and the ledger then read
  // Microsoft as an EMPLOYER - the exact fabrication a regression test in
  // this repo already exists to prevent.
  const label = m[1].trim();
  if (label.length > 14 || label.split(/\s+/).length > 2) return s;
  return s.slice(m[0].length);
}

// ── THE BODY MUST NOT REPEAT THE ROLE LINE ──
//
// When a document puts the company and the role on SEPARATE lines —
// "Client: NTT Global Data Centers Americas" then "Role: Jr Telecom Core
// Engineer / Network Infrastructure Engineer" — the header match ends at
// the company, so the role line falls inside the body and the fact comes
// out as "<role> — Role: <role> Responsibilities: …".
//
// Verified in the running app on 2026-08-20, and not cosmetic:
// instantOpener searches the body for a tool the question also mentions,
// so a word duplicated out of the TITLE became speakable as a tool.
//
// TWO layers build an employer body and both had it. One helper, so a
// third cannot drift away from them.
function bodyWithoutRole(rawBody: string, role: string): string {
  const r = String(role || '').trim();
  if (!r) return rawBody;
  const stripped = stripFieldLabel(rawBody).replace(
    new RegExp('^' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s:.,;\u2013\u2014-]*', 'i'),
    '',
  ).trim();
  // Never return empty: a body that WAS only the role line is better
  // represented by the role than by nothing.
  return stripped || rawBody;
}

function cleanRole(role: string): string {
  let s = stripFieldLabel(role.replace(/\s+/g, ' ').trim());
  const head = new RegExp(SECTION_HEAD_SRC + '\\s*', 'g');
  let m: RegExpExecArray | null;
  let cut = 0;
  while ((m = head.exec(s)) !== null) cut = m.index + m[0].length;
  if (cut) s = s.slice(cut);
  const dot = s.lastIndexOf('. ');
  if (dot !== -1) s = s.slice(dot + 2);
  // A leading partial word left by the 60-char window ("ced without…").
  s = s.replace(/^[a-z]+\s+/, '').trim();
  // …and the all-caps half of a heading the window cut through.
  const first = s.split(' ')[0] || '';
  if (isHeadingDebris(first)) s = s.slice(first.length).trim();
  return s;
}

/** The organisation, without the city/state/country tail. */
function orgOf(companyField: string): string {
  const s = companyField.replace(/\s+/g, ' ').trim();
  const comma = s.indexOf(',');
  return normaliseOrg(comma === -1 ? s : s.slice(0, comma));
}

/**
 * The name as it should be SPOKEN.
 *
 * orgLooking already ran cleanOrgCandidate to decide whether a span was a
 * name, but the value that reached the ledger was the RAW span — so a
 * candidate could be validated in one form and stored in another. That gap
 * is how "Client: NTT Global Data Centers Americas" passed the check as a
 * name and was still spoken with its field label attached. Every place that
 * assigns an org goes through this, so the string that is judged and the
 * string that is said are the same string.
 */
function normaliseOrg(s: string): string {
  return cleanOrgCandidate(String(s || '').replace(/[|•●]/g, ' '));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LAYER 2 — THE DATE-ANCHORED READER
//
//  EMPLOYER_LINE above requires a three-column pipe table. Measured over
//  the 50 distinct documents in the app's own database, it read 18 of them
//  — every one generated from the SAME resume template — and found nothing
//  whatsoever in the other 32. Those 32 include four perfectly ordinary
//  resumes. A candidate whose CV is laid out any other way therefore got no
//  spoken opener on any question, silently, and the live-model cover took
//  over: which is the fabrication path this entire file exists to close.
//
//  One layout cannot be the contract when every user brings their own. What
//  every resume on earth DOES have is a DATE RANGE beside each job, so the
//  date is the anchor and the organisation and role are read from the text
//  around it. Both examples below are real documents from that database
//  that read as completely empty before this:
//
//    "Piramal, PA \t\t\t Apr 2023 - Present Senior Sterile Mfg Operator"
//     └─ org, before ─┘   └─ anchor ─┘      └────── role, after ──────┘
//
//    "Baxter, NC                    Nov 2022 – Present"   ← org, then
//    "Metrology Specialist"                                 role NEXT line
//
//  Layer 1 still runs first and wins: where a pipe table exists it is the
//  most reliable reading there is, and Layer 2 skips any date already
//  inside a span Layer 1 claimed. This only ever ADDS employers to
//  documents that previously yielded none.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MONTH_SRC = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const YEAR_SRC = '(?:19|20)\\d{2}';
// A single point in time, in the forms a resume writes one. `\d{1,2}/YYYY`
// deliberately does NOT allow a hyphen separator ("03-2021"), because the
// hyphen is also the RANGE separator and one string cannot be both.
const DATE_POINT_SRC =
  `(?:${MONTH_SRC}\\s+${YEAR_SRC}|${MONTH_SRC}\\s*['’]\\d{2}|\\d{1,2}[/.]${YEAR_SRC}|${YEAR_SRC})`;
const DATE_OPEN_SRC = `(?:${DATE_POINT_SRC}|Present|Current|Ongoing|Now|Date)`;
const DATE_RANGE = new RegExp(
  `${DATE_POINT_SRC}\\s*(?:–|—|―|‐|-|to|through|until|till)\\s*${DATE_OPEN_SRC}`, 'gi');

// The nouns a job title is built from. Broad on purpose — this is the
// vocabulary of every industry the app has users in, not just software, and
// the pharma/quality/metrology resumes in the database are exactly the ones
// the old extractor could not see.
const ROLE_WORDS = /\b(engineer|engineering|developer|dev|manager|analyst|scientist|specialist|operator|technician|technologist|associate|director|lead|consultant|intern|internship|architect|administrator|admin|coordinator|supervisor|designer|officer|executive|president|founder|assistant|advisor|adviser|strategist|programmer|tester|auditor|nurse|physician|therapist|pharmacist|chemist|researcher|professor|instructor|teacher|accountant|controller|recruiter|representative|clerk|trainee|apprentice|fellow|resident|planner|buyer|estimator|inspector|machinist|welder|electrician|mechanic|paralegal|attorney|editor|writer|producer|sdet|sre|dba|cto|ceo|cfo|coo|vp|principal|staff|head of|sme|subject matter expert)\b/i;

// Words that make a string an ORGANISATION even when nothing else does.
const ORG_SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|technologies|technology|tech|solutions|systems|group|holdings|hospital|hospitals|university|college|institute|academy|school|labs?|laboratories|pharma|pharmaceuticals?|biotech|bank|health|healthcare|services|consulting|consultancy|software|industries|gmbh|pvt|plc|ag|nv|bv|partners|associates|ventures|capital|foundation|clinic|medical|networks?|international|enterprises?|studios?|agency|motors|energy|logistics)\b/i;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A RESUME BULLET STARTS WITH A VERB. A COMPANY DOES NOT.
//
//  This is the discriminator orgLooking was missing, and the reason the
//  capitalisation heuristic could never find it: a bullet opens with a
//  capitalised action verb and is full of capitalised product names, so it
//  scores BETTER than a real employer.
//
//    "Pioneered AWS Lambda automation"     3 of 4 words capitalised = 75%
//    "Engineered real-time ETL pipelines"  2 of 4                   = 50%
//
//  Both cleared the 50% floor. Measured on real resumes in other people's
//  templates, where a newline-less PDF puts the previous bullet inside the
//  date-anchor window, the app would have said out loud:
//
//    "It's been Pioneered AWS Lambda automation, Engineered Python/SQL
//     automation and Digitized records with MongoDB."
//
//  That is a candidate naming three bullet points as their employers.
//
//  ⚠️ THE ESCAPE HATCH IS ORG_SUFFIX, AND IT IS LOAD-BEARING. Real
//  companies do start with these words — Applied Materials, United
//  Airlines, Consolidated Edison, Integrated Device Technology. Any
//  candidate carrying a corporate suffix is let through, which covers most
//  of them. The rest are rejected, and that is the RIGHT direction to be
//  wrong in: a missed employer means the opener defers and the candidate
//  hears silence, while a bullet read as an employer is spoken aloud with
//  confidence. Losing "Consolidated Edison" costs a moment; saying
//  "I worked at Digitized records with MongoDB" costs the interview.
//
//  Deliberately EXCLUDED from this list even though they are past-tense
//  verbs, because they head real company names far more often than they
//  head resume bullets: advanced, allied, associated, general, standard.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const RESUME_ACTION_VERB = new Set([
  'accelerated', 'achieved', 'administered', 'advised', 'analysed', 'analyzed',
  'architected', 'assembled', 'audited', 'authored', 'automated', 'boosted',
  'built', 'championed', 'collaborated', 'conducted', 'configured', 'consolidated',
  'constructed', 'coordinated', 'crafted', 'created', 'curated', 'cut',
  'decreased', 'defined', 'delivered', 'deployed', 'designed', 'developed',
  'devised', 'diagnosed', 'digitised', 'digitized', 'directed', 'drafted',
  'drove', 'eliminated', 'empowered', 'enabled', 'enforced', 'engineered',
  'enhanced', 'ensured', 'established', 'evaluated', 'executed', 'expanded',
  'expedited', 'facilitated', 'formulated', 'fostered', 'generated', 'grew',
  'guided', 'halved', 'handled', 'hardened', 'headed', 'identified',
  'implemented', 'improved', 'increased', 'initiated', 'innovated', 'installed',
  'instituted', 'instrumented', 'integrated', 'introduced', 'launched', 'led',
  'leveraged', 'maintained', 'managed', 'mapped', 'masterminded', 'mentored',
  'migrated', 'modelled', 'modeled', 'modernised', 'modernized', 'monitored',
  'negotiated', 'normalised', 'normalized', 'operationalised', 'operationalized',
  'optimised', 'optimized', 'orchestrated', 'organised', 'organized',
  'overhauled', 'oversaw', 'owned', 'partitioned', 'partnered', 'performed',
  'piloted', 'pioneered', 'planned', 'prepared', 'presented', 'prioritised',
  'prioritized', 'produced', 'programmed', 'provided', 'provisioned',
  'published', 'rearchitected', 'rebuilt', 'reduced', 'refactored', 'refined',
  'researched', 'resolved', 'restructured', 'revamped', 'reviewed',
  'revolutionised', 'revolutionized', 'rewrote', 'saved', 'scaled', 'scoped',
  'secured', 'shaped', 'shipped', 'simplified', 'slashed', 'solved', 'sourced',
  'spearheaded', 'sped', 'standardised', 'standardized', 'streamlined',
  'strengthened', 'supervised', 'supported', 'surveyed', 'sustained',
  'synthesised', 'synthesized', 'tested', 'tracked', 'trailblazed', 'trained',
  'transformed', 'transitioned', 'translated', 'trimmed', 'troubleshot',
  'tuned', 'unified', 'unleashed', 'upgraded', 'utilised', 'utilized',
  'validated', 'verified', 'wrote',
]);

// Only the markers that cannot occur by accident inside a sentence about
// work. Deliberately NOT ORG_SUFFIX, which includes domain words (health,
// medical, services, solutions, technologies) that ordinary achievement
// prose is full of — see the note where this is used.
const STRONG_ORG_SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|gmbh|pvt|plc|ag|nv|bv|pte|sarl|s\.a)\b\.?/i;

// ⚠️ A SECTION-POSITION RULE WAS TRIED HERE AND REVERTED — 2026-08-17.
//
// The idea: a certification line is indistinguishable from an employment
// line (name, issuer, date), so reject any dated org sitting under a
// CERTIFICATIONS or EDUCATION heading. It removed the one wrong fact it was
// aimed at ("Tableau" as an employer) and it also removed THREE REAL
// EMPLOYERS from another resume — Jasper Therapeutics, Evonik and MSN
// Pharmaceuticals all vanished.
//
// The cause is the thing that makes it unfixable cheaply: SECTION_HEAD_SRC
// is matched case-SENSITIVELY on purpose (see its own note — lowercasing it
// matches "experience" inside ordinary prose and invents boundaries
// everywhere). So the rule SEES an uppercase SKILLS heading and MISSES the
// Title Case "Professional Experience" that follows it, and every job under
// that heading is attributed to the wrong section.
//
// Net trade: it prevented a wrong fact that is never spoken (the employer
// list caps at four, and "Tableau" was fifth) at the cost of silently
// deleting real jobs that ARE spoken. Wrong direction. If this is
// revisited, the prerequisite is heading detection that survives Title
// Case without matching prose — not another predicate on top of this one.

// Resume section headings, lowercased, for an exact-match reject. Built
// from SECTION_HEAD_SRC plus the title-case ones it does not carry —
// "Soft Skills" was extracted as an employer from a real resume.
const HEADING_WORDS = new Set([
  ...SECTION_HEAD_SRC.replace(/^\(\?:/, '').replace(/\)$/, '').split('|')
    .map((h) => h.replace(/\?/g, '').toLowerCase().trim()),
  'soft skills', 'hard skills', 'other skills', 'additional skills',
  'skills summary', 'technical skill', 'tools', 'technologies', 'languages',
  'interests', 'activities', 'references', 'contact', 'work history',
  'career history', 'employment', 'volunteer experience', 'extracurricular',
]);

/** Does this read like a job title? */
function roleLooking(s: string): boolean {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 80) return false;
  if (t.split(/\s+/).length > 10) return false;
  return ROLE_WORDS.test(t);
}

// Function words that end a phrase only when the phrase is a sentence
// fragment. "Composite from 2025–2026 candidate reports…" is a line in an
// interview-prep document, and it produced an employer called
// "Composite from" — a company nobody has ever worked for.
const DANGLING = new Set([
  'from', 'at', 'of', 'in', 'on', 'to', 'the', 'and', 'for', 'with', 'by',
  'as', 'a', 'an', 'is', 'was', 'were', 'are', 'via', 'per', 'into', 'over',
]);

/**
 * Strip the packaging a document puts around a name before it is judged:
 * list markers ("4.", "-"), markdown emphasis ("**KIMS"), and the trailing
 * bracket or comma left behind when the date was cut out of the middle of
 * the line. Every one of these produced a real false employer in the app's
 * own database.
 */
function cleanOrgCandidate(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:\d+[.)]|[-•●*#>]+)\s*/, '');   // "4. " / "- " / "## "
  // ── THE LABEL IS NOT PART OF THE NAME ──
  //
  // Contractor and consultancy resumes label their fields inline:
  //   "Role: Jr Telecom Core Engineer | Client: NTT Global Data Centers"
  // The label rode along into the org, and the opener said it out loud:
  //   "It's been Client: NTT Global Data Centers Americas and Client:
  //    Sify Technologies Ltd - Hyderabad Data Center."
  // Measured on a real resume. Stripping the label leaves the real name,
  // which is what the field was always announcing.
  // Structural, not a vocabulary — see stripFieldLabel. The word list this
  // replaced cleaned the ORG field and left the ROLE field leaking "Role:".
  t = stripFieldLabel(t);
  t = t.replace(/[*_`~]/g, '');                      // markdown emphasis
  t = t.replace(/\s*\(.*$/, '');                     // an opened bracket onward
  // ── A SPACED DASH IS A SEPARATOR, NOT PART OF THE NAME ──
  //
  // Resumes hang extra detail off the employer with a dash: a supervisor,
  // a site, a department. Measured live, the opener said "It's been Indiana
  // University - Dr. Gary Schwebach, CodeAcuity Inc and ..." — a candidate
  // naming their PI as though it were the institution, and "Sify
  // Technologies Ltd - Hyderabad Data Center" for the same reason.
  //
  // ⚠️ THE SPACES ARE THE WHOLE TEST. Hewlett-Packard, Mercedes-Benz and
  // Rolls-Royce hyphenate WITHOUT surrounding spaces; a separator is
  // written with them. Cutting on a bare hyphen would truncate real names.
  t = t.replace(/\s+[-–—]\s+.*$/, '');
  // ── A MIDDOT IS A SEPARATOR TOO, AND MARKDOWN IS FULL OF THEM ──
  //
  // Same rule, different character. A prep document written in Markdown
  // separates fields with "·": "Evonik AL · Jul 2023–now · CQV Lead".
  // Measured live 2026-08-20 on a real upload, the ledger produced
  // "Evonik AL ·", "Cook MyoSite PA ·", "MSN NJ ·" and "ScieGen NY ·" —
  // and the app SPOKE them: "Mostly Evonik AL ·, Cook MyoSite PA ·, MSN
  // NJ · and ScieGen NY ·." The dot is read aloud as part of the company's
  // name.
  //
  // Bullet glyphs get the same treatment for the same reason. The trailing
  // punctuation strip below cannot do this job — it only reaches the END of
  // the string, and here the separator is followed by the rest of the line.
  t = t.replace(/\s*[·•‣▪]\s*.*$/, '');
  t = t.replace(/[\s(,;:.|·•–—-]+$/, '');            // trailing punctuation
  return t.trim();
}

/**
 * Does this read like the NAME of an organisation?
 *
 * Deliberately structural rather than a list: a name is short, mostly
 * capitalised, and is not a sentence. The trailing-period test is what keeps
 * ordinary resume prose ("Supported media fills in 2022 - 2023.") from being
 * read as an employer — a real company line does not end in a full stop.
 */
function orgLooking(s: string): boolean {
  const t = cleanOrgCandidate(s.replace(/[|•●]/g, ' '));
  if (t.length < 2 || t.length > 80) return false;
  // A NAME HAS LETTERS. Without this a markdown data table
  // ("| 1500 | 1927.5 | 6269.5 |") yielded an employer called "1500",
  // because every one of its "words" began with a digit and so counted as
  // capitalised.
  if (!/^[A-Z]/.test(t)) return false;
  if ((t.match(/[A-Za-z]/g) || []).length < 2) return false;
  if (/[.!?]$/.test(t) && !/\b(inc|ltd|corp|co|llc)\.$/i.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 9) return false;
  // A trailing function word means this is a fragment of a sentence that
  // was cut where the date began, not the end of a name.
  //
  // ⚠️ CASE IS THE WHOLE TEST. "IN" ends "Cook Medical, IN" and is the state
  // of Indiana; "in" ends a sentence fragment. Comparing case-insensitively
  // rejected Cook Medical, Cook medical and every other resume that puts a
  // two-letter state after the comma — which is most of them.
  const last = words[words.length - 1];
  if (last === last.toLowerCase() && DANGLING.has(last)) return false;
  // A METRIC IS NEVER PART OF A COMPANY NAME. The date-anchor window can
  // end mid-achievement — "slashing workload by 30%" — and a percentage is
  // the one token that says "this is a claim about work, not a letterhead".
  if (/%/.test(t)) return false;

  // ── A SECTION HEADING IS NOT AN EMPLOYER ──
  // SECTION_HEAD_SRC is matched case-SENSITIVELY elsewhere (deliberately —
  // see its note), so a title-case heading slips past it. "Soft Skills" was
  // extracted as a company and would have been spoken: "It's been Soft
  // Skills and ...". An exact match against a heading is unambiguous;
  // no company is called "Soft Skills".
  if (HEADING_WORDS.has(t.toLowerCase().replace(/[^a-z ]/g, '').trim())) return false;

  // ── A BULLET OPENS WITH AN ACTION VERB; A COMPANY DOES NOT ──
  //
  // ⚠️ THIS RUNS BEFORE THE SUFFIX ESCAPE, AND THE ESCAPE IS NARROWER THAN
  // ORG_SUFFIX. ORG_SUFFIX includes domain words — health, medical,
  // technologies, solutions, services — which appear all over ordinary
  // achievement prose. "Managed structured and unstructured healthcare
  // datasets" matched it on "healthcare", returned true before the verb
  // was ever considered, and would have been spoken as an employer.
  //
  // So the escape here is only a STRUCTURAL corporate marker: Inc, Ltd,
  // LLC, GmbH. Those never occur by accident in a sentence about work, and
  // they are what "Managed Care Solutions Inc" has and a bullet does not.
  const head = words[0].replace(/[^A-Za-z]/g, '').toLowerCase();
  if (RESUME_ACTION_VERB.has(head) && !STRONG_ORG_SUFFIX.test(t)) return false;

  if (ORG_SUFFIX.test(t)) return true;
  // Half the words capitalised is the floor: "Apollo Hospitals" and
  // "Piramal, PA" pass; "Supported troubleshooting of filling equipment"
  // does not.
  const caps = words.filter((w) => /^[A-Z0-9]/.test(w)).length;
  return caps / words.length >= 0.5;
}

/**
 * "Senior Data Engineer at Siemens" / "Metrology Specialist – Baxter" —
 * one field carrying both. Returns null when the field is only one of them.
 */
function splitRoleOrg(field: string): { role: string; org: string } | null {
  const t = field.replace(/\s+/g, ' ').trim();
  for (const re of [/\s+at\s+/i, /\s+[–—-]\s+/, /\s*,\s*/, /\s+for\s+/i]) {
    const m = re.exec(t);
    if (!m) continue;
    const left = t.slice(0, m.index).trim();
    const right = t.slice(m.index + m[0].length).trim();
    if (!left || !right) continue;
    if (roleLooking(left) && orgLooking(right) && !roleLooking(right)) return { role: left, org: normaliseOrg(right) };
    if (roleLooking(right) && orgLooking(left) && !roleLooking(left)) return { role: right, org: normaliseOrg(left) };
  }
  return null;
}

/** Split a header line into its visual columns (tabs, wide gaps, pipes). */
function columnsOf(s: string): string[] {
  return s.split(/\t| {3,}|\s*[|•●]\s*/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

interface DatedRole {
  org: string; role: string; when: string;
  /** Where the header itself sits, so the body can start after it. */
  from: number; to: number;
}

/**
 * Every "organisation + role + dates" the document states, found by
 * anchoring on the dates. `covered` is the spans Layer 1 already claimed.
 */
function readDatedRoles(text: string, covered: Array<[number, number]>): DatedRole[] {
  // Logical lines, with their offsets into the original text.
  const lines: Array<{ text: string; from: number; to: number }> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      if (i > start && text.slice(start, i).trim()) lines.push({ text: text.slice(start, i), from: start, to: i });
      start = i + 1;
    }
  }

  const out: DatedRole[] = [];
  const seen = new Set<string>();
  DATE_RANGE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_RANGE.exec(text)) !== null) {
    const at = m.index;
    const end = at + m[0].length;
    if (covered.some(([a, b]) => at < b && end > a)) continue;

    let li = -1;
    for (let i = 0; i < lines.length; i++) {
      if (at >= lines[i].from && at < lines[i].to) { li = i; break; }
    }
    if (li === -1) continue;
    const line = lines[li];

    // A PDF often arrives as one enormous line. When there is no line
    // structure to read, a window around the date is all there is; when
    // there IS, a date buried in a long paragraph is prose, not a header.
    const blob = line.text.length > 300;
    const head = blob ? text.slice(Math.max(line.from, at - 180), at) : text.slice(line.from, at);
    const tail = blob ? text.slice(end, Math.min(line.to, end + 140)) : text.slice(end, line.to);

    // A DATE INSIDE A SENTENCE IS NOT A JOB HEADER.
    //
    // "…KIMS 2016–2017 then a gap to 2022. Have the narrative ready…" is a
    // line from an interview-prep document; "MS Health Informatics at
    // Indiana University (2024–2025) — the formal bridge" is a line from a
    // note. Both produced employers. What separates them from a real header
    // is what FOLLOWS the date: a header is followed by a title, a blank, or
    // nothing — never by the rest of a sentence. Lowercase, and long enough
    // to be prose rather than a stray "to Present", settles it.
    const trailing = tail.replace(/^[^A-Za-z]+/, '');
    if (/^[a-z]/.test(trailing) && trailing.length > 12) continue;

    const before = columnsOf(head);
    const after = columnsOf(tail);
    let org = '';
    let role = '';

    // 1. The same line, nearest the date first — that is where the header
    //    for this job lives when the resume uses a right-aligned date.
    for (let i = before.length - 1; i >= 0 && (!org || !role); i--) {
      const pair = splitRoleOrg(before[i]);
      if (pair) { role = role || pair.role; org = org || pair.org; continue; }
      if (!role && roleLooking(before[i])) { role = before[i]; continue; }
      if (!org && orgLooking(before[i])) org = normaliseOrg(before[i]);
    }
    for (let i = 0; i < after.length && (!org || !role); i++) {
      const pair = splitRoleOrg(after[i]);
      if (pair) { role = role || pair.role; org = org || pair.org; continue; }
      if (!role && roleLooking(after[i])) { role = after[i]; continue; }
      if (!org && orgLooking(after[i])) org = normaliseOrg(after[i]);
    }

    // 2. The neighbouring lines. A resume that puts "Company / dates" on one
    //    line puts the title on the next one (or the one before).
    const neighbour = (idx: number) => (idx >= 0 && idx < lines.length ? lines[idx].text.trim() : '');
    for (const cand of [neighbour(li + 1), neighbour(li - 1)]) {
      if (org && role) break;
      if (!cand || cand.length > 90) continue;
      // "PROFESSIONAL EXPERIENCE" sits directly above the first job on most
      // resumes, is short, and is capitalised — so it read as the company
      // name and the real one two lines further up was never reached.
      if (headingOf(cand)) continue;
      const cols = columnsOf(cand);
      for (const c of cols) {
        if (!role && roleLooking(c)) { role = c; continue; }
        if (!org && orgLooking(c) && !roleLooking(c)) org = normaliseOrg(c);
      }
    }

    // An entry with no organisation is not a job — it is a date in prose.
    if (!org) continue;

    // "MS Health Informatics at Indiana University" arrives as one string
    // when the resume writes it that way. Splitting it is what lets the
    // degree be recognised as a degree instead of the whole phrase becoming
    // an employer nobody worked for.
    if (!role) {
      const atSplit = /^(.{3,60}?)\s+at\s+(.{2,60})$/i.exec(cleanOrgCandidate(org));
      if (atSplit) { role = atSplit[1].trim(); org = atSplit[2].trim(); }
    }

    const cleanOrg = orgOf(cleanOrgCandidate(org));
    if (!cleanOrg || cleanOrg.length < 2) continue;
    // De-duplicate: the same header can be reached from two dates on it.
    const key = `${cleanOrg.toLowerCase()}|${m[0].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      org: cleanOrg,
      // "Fidelity Investments — Data Engineer (2023-present)" leaves the
      // opening bracket behind when the date is cut out of the middle, and
      // the role is SPOKEN: "I was Data Engineer ( there" is what that
      // reaches the candidate's mouth as.
      //
      // ⚠️ AND stripFieldLabel HAS TO BE HERE TOO. It was added to cleanRole,
      // which is a DIFFERENT extraction path, so this one kept its label and
      // the app kept SPEAKING it — verified live in the app on 2026-08-20:
      //   "Role: Jr Telecom Core Engineer / Network Infrastructure Engineer
      //    at NTT Global Data Centers Americas since 2025."
      // Two paths produce a role and both reach the same mouth; a fix on one
      // of them is not a fix.
      role: stripFieldLabel(role.replace(/\s+/g, ' ')).replace(/[\s([{,;:–—-]+$/, '').trim(),
      when: m[0].replace(/\s+/g, ' ').trim(),
      from: Math.min(line.from, at),
      to: Math.max(line.to, end),
    });
  }
  return out;
}

// ── Heading-line detection for title-cased resumes ──
//
// SECTION_HEAD_SRC is matched case-SENSITIVELY on purpose: lowercasing it
// would make the word "experience" in "Experienced in aseptic processing"
// a section boundary. But plenty of resumes write "Skills" and "Education"
// in title case, on their own line. A whole LINE that is nothing but a
// heading word is unambiguous whatever its case, so that is what this tests.
const HEADING_NAMES = new Set(
  SECTION_HEAD_SRC.replace(/^\(\?:/, '').replace(/\)$/, '').split('|')
    .map((h) => h.replace(/\?/g, '').toLowerCase()),
);
function headingOf(line: string): string {
  const t = line.replace(/[^A-Za-z& ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length > 40) return '';
  return HEADING_NAMES.has(t) ? t : '';
}

/**
 * The lines of a titled section ("SKILLS", "Education"), whatever the case,
 * ending at the next heading. Returns [] when the document has no such
 * section — never a guess.
 */
function sectionLines(text: string, match: (h: string) => boolean): Array<{ text: string; from: number }> {
  const out: Array<{ text: string; from: number }> = [];
  let start = 0;
  let inside = false;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') continue;
    const raw = text.slice(start, i);
    const from = start;
    start = i + 1;
    const h = headingOf(raw);
    if (h) { inside = match(h); continue; }
    if (inside && raw.trim()) out.push({ text: raw.trim(), from });
  }
  return out;
}

// The joiners PROPER_RUN allows INSIDE a name ("Nizam's Institute of
// Medical Sciences") are not themselves names. Letting them into the
// vocabulary made "and" a member of it, and a downstream consumer that
// asks "is this token one of the candidate's technologies?" then answered
// yes — producing the opener "and — yeah, that was the Siemens work."
const NAME_JOINERS = new Set(['of', 'the', 'and', 'for', '&']);

function collectVocabulary(text: string, into: Set<string>): void {
  for (const run of text.match(PROPER_RUN) || []) {
    for (const tok of run.split(/[\s&]+/)) {
      // ⚠️ THE KEEP-SET HERE MUST MATCH THE ONE IN unverifiedProperNouns.
      // It used to keep '.', which the matcher strips — so a name ENDING A
      // SENTENCE was stored as "sla." while the matcher looked for "sla",
      // and the two never met. Measured live 2026-08-06: the interviewer
      // asked to "cut the bill without degrading SLA." and the cover
      // answering it was thrown away for inventing SLA — a word the
      // question had just used. Mirrors groundingGuard.js.
      const w = tok.replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
      if (w.length >= 2 && !NAME_JOINERS.has(w)) into.add(w);
    }
  }
}

/**
 * Is this the posting for the role being interviewed FOR, rather than a
 * document about the candidate?
 *
 * THE LEDGER MUST NOT READ ONE. Every fact here is spoken as the
 * candidate's own history, so a posting's employer becomes an employer they
 * never had and a posting's salary band becomes a "number that is true".
 * That exact failure shipped once already — the app read Halo Pharma's own
 * company overview back to Halo Pharma as the candidate's career — and the
 * fix then was to keep JDs out of the cover context. The fact ledger is the
 * cover context now, so the same rule has to live here.
 *
 * What it reads for are the phrases a posting uses about itself and a
 * candidate's resume never does. Two markers, not one: "requirements:" alone
 * appears in plenty of resumes.
 *
 * CONTENT DECIDES; THE FILENAME ONLY BREAKS A TIE.
 *
 * It used to be the other way round — the filename was tested before a
 * single character of the document was read, and the pattern matched the
 * bare words "role", "position" and "opening". So "Venu Pentala - Data
 * Engineer Role.pdf", a resume named the way people actually name resumes,
 * was dropped whole: no facts, no vocabulary, no haystack. That is not a
 * thinner ledger, it is an empty one, and an empty ledger makes every
 * question defer, makes server/src/routes/ai.js fall back to the
 * interviewer's own question as the vocabulary, and — if some other upload
 * did yield employers — makes the app deny out loud a job that is printed on
 * the candidate's resume. The filename shortcut now survives only for tokens
 * that cannot mean anything but a posting.
 *
 * Single source of truth — services/aiProxyService.ts imports this rather
 * than keeping the second copy it used to have.
 */
/**
 * How many "this text is a job posting" markers does `text` contain?
 *
 * Split out of isJobDescription so the SAME evidence can be applied at a
 * different granularity. buildCoverSource needs it per SECTION, not per
 * file: a candidate's own interview-prep document routinely quotes the
 * posting it is preparing for under its own heading, and that quoted block
 * is a job description sitting inside a file that is emphatically not one.
 * Reading it as the candidate's history is the Halo Pharma failure — the
 * app spoke the hiring company's own overview back to them as the
 * candidate's career — so the rule has to reach inside the file.
 *
 * Exported as a COUNT rather than a boolean because the two callers need
 * different thresholds, and because a threshold is easier to justify in the
 * place that owns the consequence.
 */
// Declared BEFORE the function that reads it. A `const` referenced from a
// function that runs during module initialisation is a TDZ crash, and this
// module has been bitten by that ordering before.
const JOB_POSTING_MARKERS = [
  /company overview/, /about the (company|role|position)/, /job description/,
  /what you'?ll do/, /responsibilities:/, /qualifications:/, /requirements:/,
  /we are (seeking|looking for|hiring)/, /is seeking/, /the ideal candidate/,
  /reports to:/, /employment type/, /equal opportunity employer/,
  // Seen in the real postings in the app's database, and impossible in a
  // resume: nobody writes their own requisition number or salary band.
  /requisition (number|id)/, /salary range/, /work model:/, /role overview/,
  /\bduties:/, /(minimum|preferred|basic) qualifications/, /what you'?ll bring/,
];

export function jobPostingMarkerHits(text: string): number {
  const t = String(text || '').toLowerCase();
  return JOB_POSTING_MARKERS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A POSTING IS SATURATED WITH THESE. A DOCUMENT THAT QUOTES ONE IS NOT.
//
//  This test used to read the first 3,000 characters and call two hits a
//  job description. That is a PRESENCE test, and presence does not scale:
//  a candidate's own prep document routinely opens by quoting the posting
//  it is preparing for, so 2% of the file decided the fate of the other
//  98%. Measured on a real 39,996-char upload the verdict came back TRUE
//  and the cover model received nothing at all.
//
//  Density is the property that actually separates the two, and it is
//  scale-free: no heading names, no language-specific structure, no list
//  that grows every time someone uploads from a new industry. Measured
//  across every real document to hand — distinct markers per 10,000 chars:
//
//     0.00  metrology resume         0.50  fill/finish prep doc (40K)
//     1.79  telecom resume           6.43  real posting (4.7K)
//    11.84  real posting (2.5K)     20.15  real posting (3.0K)
//
//  Every candidate document under 2, every real posting over 6. The
//  threshold goes at 2.0 with an absolute floor of two distinct markers,
//  leaving roughly 3x margin on both sides.
//
//  The absolute escape hatch covers the one case density cannot: a long
//  posting padded with legal boilerplate. Eight DIFFERENT posting markers
//  is a posting whatever its length.
const JD_MARKERS_PER_10K = 2.0;
const JD_MARKERS_ABSOLUTE = 8;

export function looksLikeJobPosting(text: string): boolean {
  const s = String(text || '');
  const hits = jobPostingMarkerHits(s);
  if (hits >= JD_MARKERS_ABSOLUTE) return true;
  if (hits < 2) return false;
  return (hits / Math.max(1, s.length / 10_000)) >= JD_MARKERS_PER_10K;
}

export function isJobDescription(f: ContextFile): boolean {
  // An explicit label outranks every heuristic below it. types.ts has
  // carried this field all along and nothing here ever consulted it; App.tsx
  // still only writes 'custom', so this is dormant rather than dead — the
  // day the uploader lets someone say which document is which, no guess
  // about a filename gets to overrule them.
  if (f.type === 'resume') return false;
  if (f.type === 'jd') return true;

  const head = (f.content || '').slice(0, 3000).toLowerCase();
  // Density, not presence — see looksLikeJobPosting. This is what stops a
  // 2,000-character quotation inside a 40,000-character prep document from
  // condemning the whole file, and it replaces the section-level blocklist
  // that used to paper over exactly that failure.
  const hits = jobPostingMarkerHits(f.content || '');
  if (looksLikeJobPosting(f.content || '')) return true;

  // What is left in the pattern is what a resume is never called. Even so it
  // asks the text for a nod: one marker beside a filename this explicit is
  // the same weight of evidence as two markers alone, and requiring it also
  // settles the case the pattern cannot tell apart on its own — "JD Smith
  // Resume.pdf", where those two letters are a person, not a posting.
  const name = (f.name || '').toLowerCase();
  if (!/(^|[^a-z])(jd|job.?description|job.?posting|job.?req|requisition|vacancy)([^a-z]|$)/.test(name)) return false;
  // …unless there is no text to ask. A scanned posting whose extraction
  // produced nothing has only its name, and excluding a document with no
  // readable content costs the ledger nothing it would have gained.
  return hits >= 1 || head.trim().length < 200;
}

function fingerprintOf(files: ContextFile[]): string {
  let h = 0;
  let chars = 0;
  for (const f of files) {
    if (f.base64) continue;
    const s = `${f.id}:${f.name}:${(f.content || '').length}`;
    chars += (f.content || '').length;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  }
  return `${files.length}:${chars}:${h.toString(36)}`;
}

/**
 * Read the knowledge base into facts. Deterministic and total: an
 * unparseable document simply contributes fewer facts, never a wrong one.
 */
export function buildLedger(files: ContextFile[]): Ledger {
  const facts: Fact[] = [];
  const vocabulary = new Set<string>();
  const haystackParts: string[] = [];
  const headParts: string[] = [];
  let charCount = 0;
  let fileCount = 0;
  let jdCount = 0;

  for (const f of files || []) {
    if (f.base64) continue;
    // Repaired BEFORE anything reads it, so classification, vocabulary,
    // metrics and the spoken strings all see the same intact words. See
    // repairLigatures: "AWS Certi fi ed …" missed CERT_RE and was spoken as
    // employment at Amazon Web Services. Every span offset below indexes
    // THIS string, and nothing outside buildLedger re-slices f.content by
    // span, so changing its length here is safe.
    const text = repairLigatures(f.content || '');
    if (!text.trim()) continue;
    // A JOB DESCRIPTION IS NOT EVIDENCE ABOUT THE CANDIDATE.
    //
    // Skipped whole: not just its facts, but its vocabulary and its
    // haystack too. Vocabulary is the guard's definition of "a name this
    // person can support" — admitting the hiring company's own copy would
    // make "I spent several years at UnitedHealth" pass the check, said to
    // UnitedHealth. The cost of excluding it is that a cover mentioning a
    // technology only the posting names gets dropped, which is the safe
    // direction: a lost cover is a moment of silence, an admitted one is a
    // job the candidate never had, spoken out loud.
    if (isJobDescription(f)) { jdCount++; continue; }
    fileCount++;
    charCount += text.length;
    haystackParts.push(text.toLowerCase());
    headParts.push(text.slice(0, 300));
    collectVocabulary(text, vocabulary);

    const fileId = f.id;
    const fileName = f.name || 'source';
    const push = (kind: FactKind, subject: string, detail: string, when: string, from: number, to: number) => {
      if (!subject) return;
      facts.push({
        kind, subject, detail, when,
        tokens: tokenize(`${subject} ${detail}`),
        span: { fileId, fileName, from, to },
      });
    };

    // ── Employers / education / certifications ──
    //
    // Collected in one pass first, because an employer fact is only useful
    // to a question if it carries the WORK, not just the letterhead.
    // "tell me about your Kafka streaming work" shares no term with
    // "Apollo Hospitals | Data Engineer" — so selection returned a skills
    // line and a bare number, and the opener had nothing to anchor on. The
    // bullets under a role are where Kafka, the 3M/day and the 94% live,
    // and they end at the next role or the next section heading.
    EMPLOYER_LINE.lastIndex = 0;
    const lines: Array<{ whole: string; index: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = EMPLOYER_LINE.exec(text)) !== null) lines.push({ whole: m[0], index: m.index });

    // What Layer 1 claimed, so the date-anchored reader below does not read
    // the same job a second time out of the same characters.
    const covered: Array<[number, number]> = [];

    for (let li = 0; li < lines.length; li++) {
      const { whole, index } = lines[li];
      const fields = whole.split('|');
      if (fields.length < 2) continue;
      const role = cleanRole(fields[0]);
      const org = orgOf(fields[1]);
      // ⚠️ A MARKDOWN TABLE IS ALSO THREE PIPE-SEPARATED COLUMNS.
      //
      // Found in the app's own database: a notes file containing
      //   | healthy4_cd45- | 1500 | 1927.5 | 6269.5 | 3.71 |
      // satisfies EMPLOYER_LINE exactly — text, pipe, text, pipe, something
      // ending in a four-digit "year". It produced the employer "1500" with
      // the role "healthy4_cd45-" and the dates "1927". Harmless while these
      // facts only informed a prompt; not harmless now that the opener
      // SPEAKS them, because "Yeah, 1500 — I was healthy4_cd45- there" is a
      // sentence this app would have said out loud.
      //
      // The column that has to survive scrutiny is the organisation: a name
      // starts with a letter and contains at least two of them, which no
      // cell of a numeric table does.
      if (!orgLooking(org)) continue;
      const when = (fields[2] || '').replace(/\s+/g, ' ').trim();
      const from = index;
      const to = index + whole.length;

      if (DEGREE_RE.test(role)) { covered.push([from, to]); push('education', org, role, when, from, to); continue; }
      if (CERT_RE.test(role)) { covered.push([from, to]); push('certification', role, org, when, from, to); continue; }

      // Everything between this role and whatever comes next, bounded so a
      // malformed document cannot attach half the file to one employer.
      const nextLine = li + 1 < lines.length ? lines[li + 1].index : text.length;
      const tail = text.slice(to, nextLine);
      const headM = new RegExp(SECTION_HEAD_SRC).exec(tail);
      const bodyEnd = to + (headM ? headM.index : tail.length);
      const rawBody = text.slice(to, Math.min(bodyEnd, to + EMPLOYER_BODY_CHARS))
        .replace(/\s+/g, ' ').trim();
      const body = bodyWithoutRole(rawBody, role);   // see the helper

      facts.push({
        kind: 'employer',
        subject: org,
        detail: body ? `${role} — ${body}` : role,
        when,
        // The span covers the role line AND its bullets: this fact is
        // claiming all of it, so all of it is the proof.
        tokens: tokenize(`${org} ${role} ${body}`),
        span: { fileId, fileName, from, to: Math.max(to, bodyEnd) },
      });
      covered.push([from, Math.max(to, bodyEnd)]);
    }

    // ── Layer 2: everything the pipe table could not see ──
    //
    // Runs on every document, not only on ones where Layer 1 found nothing:
    // a resume can carry a table for its recent roles and plain lines for
    // the older ones, and half a career is a worse answer than none.
    // `covered` is what keeps the two from reporting the same job twice.
    const dated = readDatedRoles(text, covered);
    for (let di = 0; di < dated.length; di++) {
      const d = dated[di];
      // Tested against the ORGANISATION as well as the role: a resume that
      // writes "MS Health Informatics at Indiana University" puts the degree
      // where the reader looked for a company, and calling that an employer
      // is how a degree becomes a job the candidate never held.
      const what = `${d.role} ${d.org}`;
      if (DEGREE_RE.test(what)) { push('education', d.org, d.role, d.when, d.from, d.to); continue; }
      if (CERT_RE.test(what)) { push('certification', d.role || d.org, d.org, d.when, d.from, d.to); continue; }

      // Same bounding rule as Layer 1: the bullets under this role, ending
      // at the next dated header or the next section heading, whichever
      // comes first, and never more than one entry's worth.
      const nextAt = di + 1 < dated.length ? dated[di + 1].from : text.length;
      const tail = text.slice(d.to, nextAt);
      const headM = new RegExp(SECTION_HEAD_SRC).exec(tail);
      const bodyEnd = d.to + (headM ? headM.index : tail.length);
      const body = bodyWithoutRole(
        text.slice(d.to, Math.min(bodyEnd, d.to + EMPLOYER_BODY_CHARS)).replace(/\s+/g, ' ').trim(),
        d.role,
      );

      facts.push({
        kind: 'employer',
        subject: d.org,
        detail: body ? `${d.role} — ${body}` : d.role,
        when: d.when,
        tokens: tokenize(`${d.org} ${d.role} ${body}`),
        span: { fileId, fileName, from: d.from, to: Math.max(d.to, bodyEnd) },
      });
    }

    // ── Projects ──
    // "Name — Subtitle | tech, tech" under a PROJECTS heading. The tech
    // list after the pipe is what a spoken opener actually needs.
    const projHead = /PROJECTS?\s/.exec(text);
    if (projHead) {
      const from = projHead.index + projHead[0].length;
      const rest = text.slice(from);
      const endM = new RegExp(SECTION_HEAD_SRC).exec(rest);
      const body = rest.slice(0, endM ? endM.index : rest.length);
      // "PipelineGuard   —   Pipeline Monitoring and Triage | ES|QL, RAG, …"
      //
      // The separator is an EM or EN dash, never a plain hyphen, and that
      // distinction is load-bearing. pdfjs inserts a space before hyphens
      // ("on -call", "Real -Time"), so allowing `-` here let the hyphen in
      // "Real-Time Streaming Application" act as the separator: the project
      // came out named "Real". A project title is spoken out loud, so a
      // truncated one is worse than a missing one — and a resume that uses
      // a plain hyphen simply contributes no project fact, which is safe.
      const TITLE = /([A-Z][A-Za-z0-9+#.'’-]*(?:\s+[A-Z][A-Za-z0-9+#.'’-]*){0,4})\s*[—–]\s*([^|●•]{3,90})\|\s*([^●•\n]{3,120})/g;
      let p: RegExpExecArray | null;
      let titled = 0;
      while ((p = TITLE.exec(body)) !== null) {
        push('project', p[1].trim(), `${p[2].replace(/\s+/g, ' ').trim()} — ${p[3].replace(/\s+/g, ' ').trim()}`,
          '', from + p.index, from + p.index + p[0].length);
        titled++;
      }

      // The two-separator form above is one house style. The ordinary one
      // is a title and a description, on a line, with a single separator —
      // and a resume that writes it that way contributed no project at all,
      // so "what's your favourite project" had nothing to open with.
      //
      // Still requires an EM or EN dash (or a colon), never a plain hyphen:
      // pdfjs inserts spaces around hyphens, so "Real -Time Streaming" would
      // otherwise yield a project named "Real". A truncated project name is
      // spoken out loud, so it is worse than no project at all.
      if (titled === 0) {
        for (const l of sectionLines(text, (h) => /^projects?$/.test(h))) {
          const t = l.text.replace(/^[-•●*\s]+/, '').trim();
          const sep = /^([A-Z][A-Za-z0-9+#.'’ -]{1,48}?)\s*(?:[—–]|:)\s*(.{6,160})$/.exec(t);
          if (!sep) continue;
          const name = sep[1].trim();
          // A title is a name, not a sentence fragment.
          if (name.split(/\s+/).length > 5 || !/^[A-Z]/.test(name)) continue;
          push('project', name, sep[2].replace(/\s+/g, ' ').trim(), '', l.from, l.from + l.text.length);
        }
      }
    }

    // ── Skills ──
    // "Label: tool, tool, tool" inside a skills section. The LABEL is the
    // domain a candidate names out loud; the tail is the evidence.
    // A bare `SKILLS` is last in the alternation so the longer headings win
    // at the same position — and it has to be there at all, because a plain
    // "SKILLS" heading above "Label: tool, tool" lines is one of the most
    // ordinary resume shapes there is and read as nothing.
    const skillsHead = /(TECHNICAL SKILLS|CORE SKILLS|KEY SKILLS|SKILLS & TOOLS|SKILLS AND TOOLS|TECHNICAL EXPERTISE|TECHNICAL PROFICIENCIES|CORE COMPETENCIES|AREAS OF EXPERTISE|TECHNICAL SUMMARY|SKILLS)\s/.exec(text);
    let labelledSkills = 0;
    if (skillsHead) {
      const from = skillsHead.index + skillsHead[0].length;
      const rest = text.slice(from);
      const endM = new RegExp(SECTION_HEAD_SRC).exec(rest);
      const body = rest.slice(0, endM ? endM.index : rest.length);
      const LINE = /([A-Z][A-Za-z0-9 &/+#'’-]{2,48}):\s*([^●•\n]{3,400})/g;
      let s: RegExpExecArray | null;
      while ((s = LINE.exec(body)) !== null) {
        const label = s[1].replace(/\s+/g, ' ').trim();
        // "Education:" is a section, not a skill. Without this the ledger
        // held a skill called Education whose tools were a degree, and the
        // opener offered it as the candidate's technical strength.
        if (headingOf(label)) continue;
        push('skill', label, s[2].replace(/\s+/g, ' ').trim(),
          '', from + s.index, from + s.index + s[0].length);
        labelledSkills++;
      }
    }

    // A skills section that is a LIST rather than a table — one capability
    // per line, no "Label:" prefix. Real and common: the quality-engineering
    // resume in the app's database writes eleven of them that way and the
    // colon parser above sees none of it, so "what are your strengths"
    // had nothing to answer from.
    //
    // These carry no label, so they become ONE fact with the reserved
    // subject `Skills`. services/instantOpener.ts recognises that name and
    // speaks them without inventing a heading for them.
    //
    // Only from a document that already yielded a role or a degree. A bare
    // list under a "Skills" heading is also what a JOB POSTING'S
    // requirements look like — the app's database has a 932-char notes file
    // whose "skills" were "Engineering bachelor's degree, Experience
    // executing TMV Test Cases", i.e. what the employer wants, offered back
    // as what the candidate has. A résumé states a job or a degree
    // somewhere; a requirements list does not.
    const ownsAnEntry = facts.some(
      (x) => x.span.fileId === fileId && (x.kind === 'employer' || x.kind === 'education'),
    );

    // Title-cased heading ("Skills:") with labelled lines under it. The
    // regex above is case-sensitive by necessity — lowercasing it would make
    // the word "skills" in a sentence a section boundary — so a whole-line
    // heading match is how the title-cased half of the world gets read.
    if (labelledSkills === 0) {
      for (const l of sectionLines(text, (h) => /skill|competenc|expertise|proficien|technolog/.test(h))) {
        const m2 = /^([A-Z][A-Za-z0-9 &/+#'’-]{2,48}):\s*(.{3,400})$/.exec(l.text.trim());
        if (!m2 || headingOf(m2[1])) continue;
        push('skill', m2[1].replace(/\s+/g, ' ').trim(), m2[2].replace(/\s+/g, ' ').trim(),
          '', l.from, l.from + l.text.length);
        labelledSkills++;
      }
    }

    if (labelledSkills === 0 && ownsAnEntry) {
      const items = sectionLines(text, (h) => /skill|competenc|expertise|proficien|technolog/.test(h))
        .filter((l) => {
          const t = l.text.replace(/^[-•●*\s]+/, '').trim();
          // A capability, not a sentence and not a paragraph.
          return t.length >= 3 && t.length <= 90 && !/[.!?]$/.test(t) && t.split(/\s+/).length <= 10;
        })
        .slice(0, 40);
      if (items.length >= 3) {
        const names = items.map((l) => l.text.replace(/^[-•●*\s]+/, '').trim());
        push('skill', GENERIC_SKILL_LABEL, names.join(', '), '',
          items[0].from, items[items.length - 1].from + items[items.length - 1].text.length);
      }
    }

    // ── Education and certifications stated as a section ──
    // Layer 1 reads them out of the pipe table; a resume without one lists
    // them under a heading instead. Only runs when the table found none, so
    // a document cannot report the same degree twice.
    if (!facts.some((x) => x.kind === 'education' && x.span.fileId === fileId)) {
      const eduLines = sectionLines(text, (h) => h === 'education');
      for (let i = 0; i < eduLines.length; i++) {
        const l = eduLines[i];
        if (!DEGREE_RE.test(l.text)) continue;
        const pair = splitRoleOrg(l.text);
        let org = pair?.org || '';
        if (!org) {
          for (const n of [eduLines[i + 1]?.text, eduLines[i - 1]?.text]) {
            if (n && orgLooking(n) && !DEGREE_RE.test(n)) { org = normaliseOrg(n); break; }
          }
        }
        if (!org) continue;
        const yr = /(?:19|20)\d{2}/.exec(l.text) || /(?:19|20)\d{2}/.exec(eduLines[i + 1]?.text || '');
        push('education', orgOf(org), (pair?.role || l.text).replace(/\s+/g, ' ').trim(),
          yr ? yr[0] : '', l.from, l.from + l.text.length);
      }
    }
    if (!facts.some((x) => x.kind === 'certification' && x.span.fileId === fileId)) {
      for (const l of sectionLines(text, (h) => /certification|license/.test(h))) {
        const t = l.text.replace(/^[-•●*\s]+/, '').trim();
        if (t.length < 6 || t.length > 120 || /[.!?]$/.test(t)) continue;
        const yr = /(?:19|20)\d{2}/.exec(t);
        push('certification', t.replace(/\s*[|–—-]\s*(?:19|20)\d{2}.*$/, '').trim(), '',
          yr ? yr[0] : '', l.from, l.from + l.text.length);
      }
    }

    // ── Metrics ──
    //
    // ONLY FROM INSIDE THE CANDIDATE'S OWN ENTRIES. The digest presents
    // these under the heading "NUMBERS THAT ARE TRUE", which is a claim
    // about the candidate, so a number is only eligible if it sits within
    // a span already attributed to one of their roles or projects.
    //
    // Scanning the whole file instead is how a 50K interview-prep document
    // contributed 33 "true numbers" that were study notes, and how a
    // posting's salary band would have become an achievement. A document
    // with no roles in it contributes no metrics at all, which is correct:
    // there is nothing to attribute them to.
    const owned = facts.filter(
      (x) => x.span.fileId === fileId && (x.kind === 'employer' || x.kind === 'project'),
    ).map((x) => [x.span.from, x.span.to] as [number, number]);
    if (owned.length) {
      METRIC_RE.lastIndex = 0;
      let q: RegExpExecArray | null;
      const seenMetric = new Set<string>();
      while ((q = METRIC_RE.exec(text)) !== null) {
        if (seenMetric.size >= METRICS_PER_FILE) break;
        const at = q.index;
        if (!owned.some(([a, b]) => at >= a && at < b)) continue;
        const value = q[0].replace(/\s+/g, ' ').trim();
        if (seenMetric.has(value)) continue;
        seenMetric.add(value);
        const ctxFrom = Math.max(0, at - 90);
        const ctxTo = Math.min(text.length, at + q[0].length + 40);
        push('metric', value, text.slice(ctxFrom, ctxTo).replace(/\s+/g, ' ').trim(),
          '', ctxFrom, ctxTo);
      }
    }
  }

  const byKind = (k: FactKind) => facts.filter((x) => x.kind === k);
  return {
    fingerprint: fingerprintOf(files || []),
    facts,
    employers: byKind('employer'),
    education: byKind('education'),
    certifications: byKind('certification'),
    projects: byKind('project'),
    skills: byKind('skill'),
    metrics: byKind('metric'),
    vocabulary,
    haystack: haystackParts.join('\n'),
    heads: headParts.join('\n'),
    charCount,
    jdCount,
    fileCount,
  };
}

export const EMPTY_LEDGER: Ledger = {
  fingerprint: '0:0:0', facts: [], employers: [], education: [], certifications: [],
  projects: [], skills: [], metrics: [], vocabulary: new Set(), haystack: '',
  heads: '', charCount: 0, fileCount: 0, jdCount: 0,
};

// ── The memo ──
//
// It lives HERE, in the leaf module, rather than in knowledgeCache where the
// lifecycle lives. knowledgeCache imports aiProxyService (to warm the other
// caches) and aiProxyService needs the ledger to compose an opener, so a memo
// owned by knowledgeCache would close an import cycle. factLedger imports
// nothing but a type, so everyone can reach it. knowledgeCache still owns
// WHEN it is emptied — see resetLedger.
let memoFp = '';
let memoValue: Ledger = EMPTY_LEDGER;
let memoBuilds = 0;

/** The ledger for these files. A memo hit after the first call. */
export function getLedgerFor(files: ContextFile[]): Ledger {
  const list = files || [];
  if (list.length === 0) return EMPTY_LEDGER;
  const fp = fingerprintOf(list);
  if (fp === memoFp) return memoValue;
  try {
    memoValue = buildLedger(list);
    memoBuilds++;
  } catch {
    // A malformed document must never take the answer path down with it.
    memoValue = EMPTY_LEDGER;
  }
  memoFp = fp;
  return memoValue;
}

export function resetLedger(): void {
  memoFp = '';
  memoValue = EMPTY_LEDGER;
}

/** Test/diagnostic: how many times the ledger was actually built. */
export function _ledgerBuilds(): number { return memoBuilds; }

// ── THE GUARD ──
//
// Given words the candidate is about to SAY, return the proper nouns in
// them that the knowledge base does not contain. A non-empty result means
// the sentence is inventing, and the only safe thing to do with it is
// throw it away.
//
// `alsoAllowed` exists because echoing the interviewer is not inventing:
// asked "have you worked at Goldman?", the honest answer contains the word
// Goldman. Callers pass the question (and recent turns) so a true negative
// is not mistaken for a fabrication. Note this makes the guard alone
// insufficient for entity questions — a sentence CLAIMING Goldman also
// echoes it — which is exactly why those questions are answered from the
// ledger instead of by a model. See services/instantOpener.ts.

// ── A SENTENCE-INITIAL WORD THAT IS ENGLISH MORPHOLOGY, NOT A NAME ──
// Kept byte-identical to isInflectedEnglish / ENGLISH_SUFFIX in
// server/src/services/groundingGuard.js. The parity test fails if they
// drift.
//
// SENTENCE_OPENERS is a fixed list, so the waiver it grants is only ever
// as complete as the list. Measured 2026-08-06, after the cover prompt was
// changed to ask for a real judgement instead of a description of process,
// its openings were rejected one after another — "Strict exactly-once is
// impossible…", "Treating green as completion…", "Achieving that at the
// sink…" — all ordinary English, all reported as invented companies, so
// the cover was dropped and the candidate got silence instead.
//
// Morphology is the discriminator a list cannot be: these suffixes are
// English derivation and inflection, and company names essentially never
// take them. Acronyms are excluded before this is consulted, so "IBM"
// opening a sentence is still IBM, and a bare capitalised noun (Google,
// Accenture, Optum) carries no suffix and is still caught.
// ⚠️ `-ity` IS DELIBERATELY ABSENT. It reads as pure morphology
// (quality, integrity, availability) right up until you remember that
// Fidelity is an employer — and "recently at Fidelity Investments" is a
// fabrication this codebase has already caught in the field, pinned in
// grounding-parity.test.js. `-ency`/`-ancy` are kept because no employer
// in reach takes them, and they buy back the words a judgement about
// distributed systems genuinely opens with: Consistency, Latency,
// Redundancy, Frequency.
const ENGLISH_SUFFIX = /(?:ing|edly|ed|ly|est|tion|sion|ness|ment|ance|ence|ency|ancy|able|ible|ive|ous|ful|less|ised|ized)$/i;

// Closed list, on purpose — see the hyphen note in unverifiedProperNouns.
// These are English prefixes that attach to an ordinary word; a company
// name essentially never begins with one, and keeping the list closed is
// what stops "Google-scale" being cleared by its own second half.
// Kept byte-identical to HYPHEN_PREFIX in
// server/src/services/groundingGuard.js.
const HYPHEN_PREFIX = new Set([
  'non', 'pre', 'post', 'anti', 'multi', 'sub', 'semi', 're', 'un',
  'inter', 'intra', 'over', 'under', 'cross', 'self', 'near', 'quasi',
  'pseudo', 'co', 'bi', 'tri', 'ex', 'mid', 'off', 'out', 'up', 'de',
  'micro', 'macro', 'mini', 'auto', 'meta', 'ultra', 'super', 'hyper',
]);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CURATED ACRONYM LIST IS GONE. HERE IS WHY, AND WHAT REPLACES IT.
//
//  There used to be ~150 hand-written acronyms here (SLA, ETL, CQV, IQ/OQ,
//  K8s…) whose only job was to stop the proper-noun check rejecting a term
//  of art as an invented company. It worked on the two industries it was
//  written for and failed on the third. Measured live on a telecom resume,
//  both CORRECT and both thrown away:
//
//    REJECTED invented=[UE, Request]  "UE initiates attach by sending
//                                      Attach Request to the MME."
//    REJECTED invented=[TEID]         "First, verify the tunnel integrity
//                                      and TEID matching."
//
//  Textbook 3GPP, and the list has no UE, no TEID, no PDU, no gNB, no
//  AMF/SMF/UPF. It never could: every new field is a new pull request and
//  every new language is a new list. That is a domestic cure for a disease
//  the app has everywhere.
//
//  And it could not be widened either, because the discriminator does not
//  exist at the level it was working at. "UE" and "IBM" are both two-to-
//  three capital letters. Nothing about the TOKEN separates a term of art
//  from a fabricated employer — only what the sentence DOES with it.
//
//  So provenance moved off the words and onto the CLAIM. A cover that
//  states something about the candidate's own history must hand back the
//  span of the document it read that from (see citationHolds); a cover
//  that does not make such a claim is talking about the subject, where an
//  unfamiliar term is a term of art and not a lie waiting to be spoken.
//  routes/ai.js applies the two rules; this file supplies the tests.
//
//  What is lost: an acronym inside a GROUNDED claim now has to appear in
//  the span that was cited. "I deduplicated by ID" is rejected if the
//  cited line does not say ID. That is one dropped cover and a moment of
//  silence, against a list that has to be maintained per industry forever.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function isInflectedEnglish(word: string): boolean {
  const w = String(word || '');
  // ⚠️ NEVER a hyphenated compound. "Accenture-led" and "IBM-hosted" both
  // end in -ed, and waiving them here let a fabricated employer through in
  // testing — the suffix belongs to the SECOND half while the name sits in
  // the first. Compounds are decided by the hyphen rules in
  // unverifiedProperNouns, which look at the head, and only there.
  if (w.includes('-')) return false;
  if (w.length < 6) return false;
  const m = ENGLISH_SUFFIX.exec(w);
  if (!m) return false;
  // The part before the suffix has to look like a stem, not a stub:
  // "Boeing" is bo+ing and fails this; "Treating" is treat+ing and passes.
  return (w.length - m[0].length) >= 4;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A MODEL AND A DOCUMENT SPELL PUNCTUATION DIFFERENTLY
//
//  Mirror of the server's groundingGuard.js — grounding-parity.test.js
//  asserts the two agree. Measured live 2026-08-20, two CORRECT covers
//  thrown away: `invented=[Vis]` because the model wrote "UV‑Vis" with a
//  non-breaking hyphen where the file uses an ASCII one, and
//  `invented=[Bachelor’s, India]` on a sentence that is word-for-word what
//  the résumé says, because of a curly apostrophe.
//
//  Fourth recurrence of one rule failing for want of exact spelling
//  (trailing periods, plurals, lower-case speech-to-text, now Unicode).
//  Normalise before comparing; both sides go through it, so it can only
//  make a match more likely — never let an invention through.
const PUNCT_NORMALISE: Array<[RegExp, string]> = [
  [/[‐-―−]/g, '-'],
  [/[‘’‛ʼ]/g, "'"],
  [/[“”]/g, '"'],
  [/ /g, ' '],
];

export function normalisePunctuation(s: string): string {
  let out = String(s || '');
  for (const [re, to] of PUNCT_NORMALISE) out = out.replace(re, to);
  // Accents come off too — the token scanners are ASCII classes, so a
  // non-ASCII letter ENDS a token instead of continuing it. Measured live:
  // `invented=[Bausch+Str]` on a correct cover naming Bausch+Ströbel, a
  // maker printed in the uploaded document. Both sides fold identically, so
  // this can only make a match more likely; an invented name has nothing to
  // fold onto.
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function unverifiedProperNouns(
  ledger: Ledger,
  text: string,
  alsoAllowed?: string,
): string[] {
  const s = normalisePunctuation(String(text || ''));
  if (alsoAllowed) alsoAllowed = normalisePunctuation(alsoAllowed);
  if (!s.trim() || !ledger) return [];
  // NO KNOWLEDGE BASE, NO OPINION.
  //
  // With nothing uploaded there is nothing to contradict, and a guard that
  // flags every name in that state would block every opener in the app's
  // most common state — a session with no files. Silence is not the safe
  // answer here; abstaining is. (Caught by the test: an empty ledger
  // reported IBM and Kubernetes as fabrications.)
  if (ledger.charCount === 0 || ledger.vocabulary.size === 0) return [];
  const extra = new Set<string>();
  if (alsoAllowed) collectVocabulary(alsoAllowed, extra);

  // ── THE INTERVIEWER DOES NOT SPEAK IN CAPITALS ──
  //
  // `alsoAllowed` is what the interviewer said, and the rule it encodes is
  // "a name they just used is theirs, not an invention". collectVocabulary
  // implements that by scanning PROPER_RUN — capitalised runs — which is
  // right for typed text and wrong for this product: the question arrives
  // from speech-to-text, which writes terms of art in lower case.
  //
  // Measured on the real corpus: asked "how can you define rags?", the
  // cover answered "RAG is retrieval-augmented generation…" and the guard
  // discarded it over a word the question had just said out loud.
  //
  // This widens nothing that was not already intended — a capitalised
  // mention has always been admitted, and echoing what the interviewer
  // named was the deliberate point of `alsoAllowed`. It only makes the
  // rule work on how people talk rather than on how a transcriber rendered
  // it. Kept behaviour-identical to groundingGuard.js.
  if (alsoAllowed) {
    const SPOKEN = /[A-Za-z][A-Za-z0-9+#'’-]*/g;
    let am: RegExpExecArray | null;
    while ((am = SPOKEN.exec(String(alsoAllowed))) !== null) {
      const t = am[0].replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
      if (t.length >= 2) extra.add(t);
    }
  }
  const offenders: string[] = [];
  const seen = new Set<string>();

  // Sentence-initial single words are capitalised by grammar, not by
  // meaning. That reasoning is sound and the implementation of it was not:
  // waiving the check for the whole opening slot waived it for exactly the
  // slot a fabricated employer lands in. The cover prompt tells the model to
  // start ANSWERING from the first word and to name the real employer, so
  // "Google is where I spent most of my time on that." passed while the same
  // claim one clause later ("I built that at Google") was caught, and
  // "Yeah. Accenture was the place." passed because the second sentence
  // starts too. The waiver is now earned rather than granted — see
  // SENTENCE_OPENERS and `lowered`.
  const initials = new Set<number>();
  let atStart = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (atStart && /[A-Za-z]/.test(c)) { initials.add(i); atStart = false; }
    if (c === '.' || c === '!' || c === '?' || c === '\n') atStart = true;
  }

  // The words this same text also uses in lowercase somewhere. A word written
  // both ways in one breath — "Depends. Well, it depends on the day." — is a
  // common word that happens to open a sentence; a company is capitalised
  // every time it appears. This is what spares the guard a dictionary of
  // English, and it costs one extra pass over a couple of hundred characters.
  const lowered = new Set<string>();
  const LOWER = /[A-Za-z][A-Za-z0-9+#.'’-]*/g;
  let lm: RegExpExecArray | null;
  while ((lm = LOWER.exec(s)) !== null) {
    if (/^[A-Z]/.test(lm[0])) continue;
    const t = lm[0].replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
    if (t.length >= 2) lowered.add(t);
  }

  const WORD = /[A-Za-z][A-Za-z0-9+#.'’-]*/g;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(s)) !== null) {
    const raw = m[0];
    if (!/^[A-Z]/.test(raw)) continue;
    // A MATCH THAT STARTS INSIDE A NUMBER IS PART OF THE NUMBER. The token
    // pattern begins at a letter, so "75K+" yields "K+" and "3M+" yields
    // "M+" — and the digest hands the model a NUMBERS THAT ARE TRUE line
    // full of exactly those. Mirrors groundingGuard.js — parity test.
    // `.` and `/` too: the pattern cannot begin on a slash, so "C#/.NET"
    // leaves a bare "NET" behind. Mirrors groundingGuard.js — parity test.
    if (m.index > 0 && /[0-9/.]/.test(s[m.index - 1])) continue;
    const isAcronym = /^[A-Z0-9+#.]{2,}$/.test(raw);
    const w = raw.replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
    if (w.length < 2 || seen.has(w)) continue;
    // ONE LETTER IS NOT A NAME. "C#", "C++", "F#" survive the length check
    // because their symbols count. Mirrors groundingGuard.js.
    if ((w.match(/[a-z]/g) || []).length < 2) continue;
    // A contracted pronoun is not a company. "I'd" and "I've" were being
    // reported as invented names — "I" is in DISCOURSE but "i'd" is not —
    // so a perfectly good opener ("Before I touch anything I'd want to
    // know whether it's real user impact") was rejected as a fabrication.
    // Both forms are checked, because stripping is also what lets
    // "Nizam's" match a vocabulary entry of "nizam" while a genuine
    // possessive brand ("McDonald's") still matches its own full form.
    const base = w.replace(/['’](?:s|d|ve|ll|re|m|t)$/, '');
    // ⚠️ A PLURAL IS THE SAME NAME. The interviewer asked "…every DAG is
    // green", the cover said "…the DAGs being green", and the guard called
    // DAGs invented because the allowed set held `dag` — throwing away a
    // correct sentence. Acronyms get pluralised in speech constantly:
    // DAGs/DAG, APIs/API, SLAs/SLA, KPIs/KPI. Mirrors groundingGuard.js.
    const forms = new Set([w, base].filter(Boolean));
    for (const f of [w, base]) {
      if (!f) continue;
      if (f.endsWith('es') && f.length > 4) forms.add(f.slice(0, -2));
      if (f.endsWith('s') && f.length > 3) forms.add(f.slice(0, -1));
      else forms.add(`${f}s`);
    }
    const known = (set: Set<string>) => { for (const f of forms) if (set.has(f)) return true; return false; };
    // THE EARNED WAIVER. A sentence-initial word skips the check only when
    // something says it is an ordinary word: one of the two common-word
    // lists, or its own lowercase twin elsewhere in this text. Anything else
    // — a mixed-case name in the opening position — goes through the
    // vocabulary and question checks like any other proper noun. An acronym
    // never earns the waiver; "IBM" opening a sentence is still IBM.
    // DISCOURSE is consulted here as well as below on purpose, so the waiver
    // stays correct if the checks under it are ever reordered.
    if (initials.has(m.index) && !isAcronym
      && (known(DISCOURSE) || known(SENTENCE_OPENERS) || known(lowered)
        || isInflectedEnglish(base))) continue;
    if (known(DISCOURSE)) continue;
    if (known(ledger.vocabulary)) continue;
    if (known(extra)) continue;
    // (The curated acronym waiver that stood here is gone — see the banner
    // above. A term of art now survives by being in the candidate's own
    // documents, in the question, or in a sentence that makes no claim
    // about the candidate at all, which is where terms of art live.)
    // A HYPHENATED COMPOUND IS ITS STEM PLUS ENGLISH. "Python-based" is not
    // a company: it is `python`, which the résumé lists, with a suffix the
    // model added because it was writing a sentence. Requiring the whole
    // compound in the vocabulary cost a real, correct cover in a live run.
    // Only the LEADING segment is consulted, so "Google-scale" is still
    // Google and still caught. Mirrors groundingGuard.js — parity test.
    const stem = base.split('-')[0];
    // SENTENCE_OPENERS is consulted here too: "Exactly-once" is `exactly`
    // plus English, and `exactly` is an ordinary word this file already
    // knows — it was only ever missing from THIS check, so the single most
    // likely opening word of an answer about delivery semantics was
    // reported as an invented company.
    if (stem !== base && stem.length >= 2
      && (DISCOURSE.has(stem) || SENTENCE_OPENERS.has(stem)
        || ledger.vocabulary.has(stem) || extra.has(stem))) continue;
    // A LEADING ENGLISH PREFIX IS MORPHOLOGY, NOT A NAME. "Non-idempotent"
    // is `non` + `idempotent`, and the leading-segment rule above can never
    // clear it, because "non" appears in no vocabulary anywhere. Measured
    // 2026-08-06: a correct claude cover was dropped over
    // invented=[Non-idempotent]. When the head is a prefix, the word the
    // compound is actually ABOUT is what follows it.
    // Deliberately NOT "clear it if any segment is known": "Google-scale"
    // would then be cleared by `scale`. Mirrors groundingGuard.js.
    if (stem !== base && HYPHEN_PREFIX.has(stem)) {
      const tail = base.slice(stem.length + 1);
      if (tail && (DISCOURSE.has(tail) || SENTENCE_OPENERS.has(tail)
        || ledger.vocabulary.has(tail) || extra.has(tail) || isInflectedEnglish(tail))) continue;
    }
    // Last resort: a plain substring check against the whole knowledge
    // base, so a name the proper-noun scanner tokenised differently still
    // passes. Cheap, and it only runs for words already suspected.
    if (ledger.haystack.includes(w) || (base.length >= 2 && ledger.haystack.includes(base))) continue;
    seen.add(w);
    // Report the name, not the punctuation that happened to follow it —
    // this string ends up in a log line and a test assertion.
    offenders.push(raw.replace(/[.,;:!?'’-]+$/, ''));
  }
  return offenders;
}

/** True when every proper noun in `text` is backed by the knowledge base. */
export function isGrounded(ledger: Ledger, text: string, alsoAllowed?: string): boolean {
  return unverifiedProperNouns(ledger, text, alsoAllowed).length === 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  NUMERIC GROUNDING — every number a cover states must already be true
//
//  unverifiedProperNouns above catches invented employers and tools. It
//  only looks at capitalised names, so a cover full of invented QUANTITIES
//  sailed through: measured live, the app spoke a cover that claimed
//  "queries on our service metadata were timing out during peak traffic.
//  I pulled the slow logs and ran test queries against different index
//  sizes" — none of those specifics were on the résumé, and none of them
//  were proper nouns either, so the name guard had nothing to reject.
//
//  This is the numeric sibling of that check. A number the cover states
//  that is neither in the candidate background digest nor in what the
//  interviewer just said is a quantity the model invented. Same empty-KB
//  abstention, same allowed-echo, same conservative bias: a false reject
//  is a moment of silence; a missed fabrication is a false number spoken
//  to a real interviewer.
//
//  Kept behaviour-identical to unverifiedNumbers in
//  server/src/services/groundingGuard.js. Note the signature takes a plain
//  contextText string (the digest), NOT a Ledger — deliberate; the digest
//  is what the cover model was shown, and the caller already has it.
//  Constants below are named and membered the same way on both sides —
//  same contract as DISCOURSE / SENTENCE_OPENERS.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Kept byte-identical to MAGNITUDE_OF in server/src/services/groundingGuard.js.
const MAGNITUDE_OF: Record<string, number> = {
  k: 1000, m: 1000000, b: 1000000000,
  thousand: 1000, million: 1000000, billion: 1000000000,
};

// Bare digits at or below this, with no unit at all, are ordinary speech
// ("I ran 3 experiments"), not a claim. The instant the same digit carries
// a unit — 3%, 3M, 3 million — it is checkable and is checked. Mirrors
// the METRIC_RE note above that a bare 45 is not a fact while 45 minutes
// is one.
const SMALL_BARE_CEILING = 10;
const YEAR_LO = 1900;
const YEAR_HI = 2100;

// Optional noise prefix, a digit run (commas / one decimal allowed), an
// optional unit from the magnitude/percent set, and an optional trailing
// plus. The unit alternatives are ordered so "percent"/"million" win over
// a lone letter, and the single-letter form refuses to eat the start of a
// longer word ("3 minutes" must not become three million).
// Kept byte-identical to NUMBER_CANDIDATE_RE in
// server/src/services/groundingGuard.js.
// ⚠️ Units added 2026-08-07 — see the long note on the server twin.
// Whether an invented metric was caught used to depend on TYPOGRAPHY:
// "24 hour" was caught, "24-hour" was invisible; "90 ms" caught, "820ms"
// invisible. The fabrication observed in a real interview — "causing a
// 24-hour data loss" — was the invisible spelling.
// The SAME regex reads the résumé (collectCanonicalNumbers) and the cover,
// so extending it on one side only would manufacture false rejections.
// Kept byte-identical to server/src/services/groundingGuard.js
// (grounding-parity.test.js asserts both give the same verdict).
const METRIC_UNIT_SRC = '(?:ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|[KMGTP]B|QPS|TPS|RPS|x)';
const NUMBER_CANDIDATE_RE = new RegExp(
  '(?:~|≈|(?:over|about|approximately|around|roughly|under)\\s+)?'
  + '\\d[\\d,]*(?:\\.\\d+)?'
  + '(?:\\s*%|\\s*percent\\b|\\s*(?:thousand|million|billion)\\b|[kKmMbB](?![a-zA-Z])'
  + '|[\\s-]?' + METRIC_UNIT_SRC + '\\b)?\\+?',
  'gi',
);

/** Strip the noise a cover puts around a figure so the core is what we report. */
function numberCoreOf(match: string): string {
  return String(match || '')
    .replace(/^(?:~|≈)\s*/i, '')
    .replace(/^(?:over|about|approximately|around|roughly|under)\s+/i, '');
}

/**
 * Canonical numeric value for comparison, or null when the match cannot be
 * confidently parsed — null means "do not flag", the safe direction.
 *
 * 3M, 3M+, 3 million, 3,000,000, over 3M+, ~3M, about 3 million all land
 * on the same value. 94% and 94 percent land on the same value as bare 94
 * (the model often drops the unit when it repeats a figure). K/M/B and the
 * word forms multiply; percent does not (it is a unit label, not a scale).
 */
function canonicalizeNumber(raw: string): number | null {
  let s = numberCoreOf(raw).replace(/\+$/, '').trim();
  if (!s) return null;

  // ⚠️ ORDER: the metric unit comes off FIRST, before the K/M/B scale-letter
  // branch below — that branch reads a trailing [kKmMbB] as thousand/million/
  // billion, and the B in "500 GB" is exactly such a letter. Stripping later
  // turned "500 GB" into 500 × 1e9 with a leftover "G", which fails the
  // numeric parse and returns null — and `value === null` is a `continue`,
  // so it went from CAUGHT to INVISIBLE. Keep this first.
  s = s.replace(new RegExp('[\\s-]?' + METRIC_UNIT_SRC + '\\s*$', 'i'), '').trim();

  let mult = 1;
  if (/%\s*$/.test(s) || /\bpercent\s*$/i.test(s)) {
    s = s.replace(/\s*%\s*$/, '').replace(/\s*percent\s*$/i, '').trim();
  } else {
    const word = /\s*(thousand|million|billion)\s*$/i.exec(s);
    if (word) {
      mult = MAGNITUDE_OF[word[1].toLowerCase()];
      s = s.slice(0, word.index).trim();
    } else {
      const letter = /([kKmMbB])\s*$/.exec(s);
      if (letter) {
        mult = MAGNITUDE_OF[letter[1].toLowerCase()];
        s = s.slice(0, letter.index).trim();
      }
    }
  }

  s = s.replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s) * mult;
  return Number.isFinite(n) ? n : null;
}

/** A digit run glued to a letter (or to a hyphen that glues to a letter) is
 *  a token, not a free-standing quantity — S3, EC2, DP-203, llama-3.3,
 *  GPT-5.6. Same index-adjacency technique unverifiedProperNouns uses the
 *  other way around (a letter run starting inside a number). */
function isNumberEmbeddedInToken(s: string, start: number, end: number): boolean {
  if (start > 0) {
    const prev = s[start - 1];
    if (/[A-Za-z]/.test(prev)) return true;
    if (prev === '-' && start > 1 && /[A-Za-z]/.test(s[start - 2])) return true;
  }
  if (end < s.length) {
    const next = s[end];
    if (/[A-Za-z]/.test(next)) return true;
    if (next === '-' && end + 1 < s.length && /[A-Za-z]/.test(s[end + 1])) return true;
  }
  return false;
}

/** OAuth 2.0 / Python 3.11 / Redis 7.2 / TLS 1.3 — a spaced version number,
 *  not a metric. Conservative: only pure digits-dot-digits after a
 *  capitalised, digit-free word; a real percentage or count after a
 *  capital is still checked. */
function isSpacedVersionNumber(s: string, coreStart: number, core: string): boolean {
  if (!/^\d+\.\d+$/.test(core.replace(/\+$/, ''))) return false;
  if (coreStart === 0 || s[coreStart - 1] !== ' ') return false;
  let i = coreStart - 2;
  while (i >= 0 && /[A-Za-z]/.test(s[i])) i--;
  const word = s.slice(i + 1, coreStart - 1);
  if (!word || /\d/.test(word)) return false;
  return /^[A-Z]/.test(word);
}

function isYearNumber(core: string): boolean {
  const cleaned = core.replace(/,/g, '').replace(/\+$/, '');
  if (!/^\d{4}$/.test(cleaned)) return false;
  const n = parseInt(cleaned, 10);
  return n >= YEAR_LO && n <= YEAR_HI;
}

function isSmallBareInteger(core: string): boolean {
  const cleaned = core.replace(/,/g, '').replace(/\+$/, '');
  if (!/^\d+$/.test(cleaned)) return false;
  const n = parseInt(cleaned, 10);
  return n >= 0 && n <= SMALL_BARE_CEILING;
}

/** True when this core carries a unit/magnitude/percent — i.e. is a claim. */
function hasNumberUnit(core: string): boolean {
  const s = core.replace(/\+$/, '').trim();
  // The metric units too, or a SMALL number carrying one ("3 days",
  // "2 weeks") is written off as a bare integer by isSmallBareInteger and
  // never checked at all.
  return /%|\bpercent\b|\b(?:thousand|million|billion)\b|[kKmMbB]\s*$/i.test(s)
    || new RegExp('[\\s-]?' + METRIC_UNIT_SRC + '\\s*$', 'i').test(s);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A NUMBER IS A VALUE **AND** A DIMENSION
//
//  Mirror of the server's groundingGuard.js — grounding-parity.test.js
//  asserts the two agree, and this pair has drifted before.
//
//  canonicalizeNumber strips the metric unit on purpose: "94%" then "94" is
//  a model repeating itself, and stripping is what lets the bare form
//  match. What it also did was let a figure vouch for a DIFFERENT quantity
//  with the same digits. Measured on a real upload — the document said "12
//  months" (the contract length) and the cover invented "delayed release by
//  12 weeks"; the guard compared 12 to 12 and passed it, while correctly
//  catching the controls "11 weeks" and "3.7 %".
//
//  Keyed by value AND unit family now: a bare candidate matches any
//  recorded value, a united one needs its own family or a bare record.
//  K/M/B stay a SCALE, already multiplied into the value, family ''.
const UNIT_FAMILIES: Array<[string, string]> = [
  ['ms', 'ms'],
  ['seconds?|secs?', 'sec'],
  ['minutes?|mins?', 'min'],
  ['hours?|hrs?', 'hour'],
  ['days?', 'day'],
  ['weeks?', 'week'],
  ['months?', 'month'],
  ['years?', 'year'],
  ['[KMGTP]B', 'bytes'],
  ['QPS|TPS|RPS', 'rate'],
  ['x', 'x'],
];

function unitFamilyOf(core: string): string {
  const s = String(core || '').replace(/\+$/, '').trim();
  if (/%\s*$/.test(s) || /\bpercent\s*$/i.test(s)) return '%';
  for (const [alt, fam] of UNIT_FAMILIES) {
    if (new RegExp('[\\s-]?(?:' + alt + ')\\s*$', 'i').test(s)) return fam;
  }
  return '';
}

interface KnownNumbers { values: Set<number>; keys: Set<string>; }

function newKnownNumbers(): KnownNumbers {
  return { values: new Set<number>(), keys: new Set<string>() };
}

function numberIsKnown(known: KnownNumbers, value: number, family: string): boolean {
  if (!family) return known.values.has(value);
  return known.keys.has(`${value}|${family}`) || known.keys.has(`${value}|`);
}

function collectCanonicalNumbers(source: string, into: KnownNumbers): void {
  const str = String(source || '');
  const re = new RegExp(NUMBER_CANDIDATE_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const core = numberCoreOf(m[0]);
    const v = canonicalizeNumber(m[0]);
    if (v === null) continue;
    into.values.add(v);
    into.keys.add(`${v}|${unitFamilyOf(core)}`);
  }
}

/**
 * The numbers in `text` that neither the candidate background digest nor
 * the interviewer's recent words can support. Offending values are returned
 * exactly as they appear in `text` (raw cores, not canonical forms),
 * de-duplicated, first-occurrence order.
 *
 * `contextText` is the same digest instantOpener renders under headings
 * like NUMBERS THAT ARE TRUE: / SKILLS:. Empty or whitespace-only means
 * no résumé was uploaded — abstain, exactly as unverifiedProperNouns does
 * when its vocabulary is empty. A non-empty digest that simply happens to
 * list no metrics is the opposite case: every number the cover then states
 * is unverifiable and must be reported.
 *
 * Unlike unverifiedProperNouns in this file, this takes a plain string
 * digest rather than a Ledger — the cover path already has the digest, and
 * that is the authority the model was given.
 */
export function unverifiedNumbers(
  contextText: string,
  text: string,
  allowed?: string,
): string[] {
  const ctx = String(contextText || '');
  // NO KNOWLEDGE BASE, NO OPINION.
  //
  // With nothing uploaded there is nothing to contradict, and a guard that
  // flags every number in that state would block every cover in the app's
  // most common state — a session with no files. Silence is not the safe
  // answer here; abstaining is. Empty means the contextText string itself
  // is blank; a digest that contains prose but zero numeric metrics is
  // still a real KB and does NOT take this exit.
  if (!ctx.trim()) return [];

  const s = String(text || '');
  if (!s.trim()) return [];

  const known = newKnownNumbers();
  collectCanonicalNumbers(ctx, known);
  if (allowed) collectCanonicalNumbers(allowed, known);

  const offenders: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(NUMBER_CANDIDATE_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const full = m[0];
    const core = numberCoreOf(full);
    if (!core) continue;
    // Core is always a suffix of the match after a leading noise strip, so
    // its start index is recoverable without re-searching the source.
    const coreStart = m.index + (full.length - core.length);
    const coreEnd = coreStart + core.length;

    // IGNORE filters — never a fabricated quantity worth checking. Applied
    // before the known-set lookup so an ordinal or a year is not reported
    // even when the digest happens not to mention it.
    if (isNumberEmbeddedInToken(s, coreStart, coreEnd)) continue;
    if (isSpacedVersionNumber(s, coreStart, core)) continue;
    if (isYearNumber(core)) continue;
    // Small bare digit only. 3 percent / 3M / 3 million still go through.
    if (!hasNumberUnit(core) && isSmallBareInteger(core)) continue;

    const value = canonicalizeNumber(core);
    // Unparseable → let through. A false rejection silently costs a good
    // cover; a missed fabrication is the cheaper mistake here only when we
    // truly cannot read the match.
    if (value === null) continue;
    if (numberIsKnown(known, value, unitFamilyOf(core))) continue;
    if (seen.has(core)) continue;
    seen.add(core);
    offenders.push(core);
  }
  return offenders;
}

// ── Selection ──
// Rank facts against a question lexically. Same spirit as kbRetrieval's
// BM25 but over short facts rather than passages, so a plain overlap score
// with an inverse-length term is both enough and faster.
export function selectFacts(ledger: Ledger, query: string, limit = 6, kinds?: FactKind[]): Fact[] {
  if (!ledger || ledger.facts.length === 0) return [];
  const q = new Set(tokenize(query));
  if (q.size === 0) return [];
  const pool = kinds ? ledger.facts.filter((f) => kinds.includes(f.kind)) : ledger.facts;
  return pool
    .map((f, i) => {
      let hits = 0;
      for (const t of f.tokens) if (q.has(t)) hits++;
      return { f, i, s: hits / (1 + Math.log(1 + f.tokens.length)) };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .slice(0, limit)
    .map((x) => x.f);
}

/**
 * Does the knowledge base place the candidate at this organisation?
 * Returns the fact when it does — the caller can then speak the real role
 * and dates instead of guessing.
 */
export function findOrganisation(ledger: Ledger, name: string): Fact | null {
  const needle = String(name || '').trim().toLowerCase();
  if (needle.length < 2) return null;
  const pools = [ledger.employers, ledger.education, ledger.certifications];
  for (const pool of pools) {
    for (const f of pool) {
      const subj = f.subject.toLowerCase();
      const det = f.detail.toLowerCase();
      if (subj === needle || subj.includes(needle) || needle.includes(subj)) return f;
      if (f.kind === 'certification' && det.includes(needle)) return f;
    }
  }
  return null;
}

/** Test/diagnostic surface. */
export function _ledgerSummary(l: Ledger) {
  return {
    fingerprint: l.fingerprint, files: l.fileCount, chars: l.charCount,
    facts: l.facts.length, employers: l.employers.length, education: l.education.length,
    certifications: l.certifications.length, projects: l.projects.length,
    skills: l.skills.length, metrics: l.metrics.length, vocabulary: l.vocabulary.size,
  };
}
