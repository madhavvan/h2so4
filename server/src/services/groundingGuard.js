// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GROUNDING GUARD — nothing the candidate has not lived gets spoken
//
//  The primary opener is now composed on the client from verified facts and
//  cannot fabricate (services/instantOpener.ts). But a live model still
//  covers the long-gap routes — grok at 9-20s, groq at 20-50s — where
//  silence is a real failure and there is no fact that opens the question.
//  Those covers are the last remaining path by which an invented employer
//  can reach a candidate's mouth, so they are checked here before a single
//  token is forwarded.
//
//  The check is deliberately the same shape as the client's
//  unverifiedProperNouns: a capitalised word or an acronym that appears
//  neither in the knowledge base's vocabulary nor in what the interviewer
//  just said is a name the model invented. test/grounding-parity.test.js
//  pins the two implementations to identical verdicts over a shared corpus,
//  because a guard that disagrees with its own client-side twin is worse
//  than no guard: it would pass exactly the sentences the other rejects.
//
//  This module knows nothing about documents. It is handed
//  `coverVocabulary` — a space-separated list of the proper nouns the
//  knowledge base contains, ~700 chars for one resume — which is why the
//  server never needs the resume to police a claim about it.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Kept byte-identical to DISCOURSE in services/factLedger.ts. The parity
// test fails if they drift.
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
// positive: a dropped cover is a moment of silence, and the answer is
// regenerated; a missed name is a lie spoken to an interviewer.
//
// The truncated-looking members near the end — 'don', 'doesn', 'wouldn' —
// are not typos. A contraction is normalised by stripping a trailing 't, so
// "Don't" arrives at the check as 'don', the same stripping that lets 'i'
// cover "I'd".
//
// Kept byte-identical to SENTENCE_OPENERS in services/factLedger.ts. The
// parity test fails if they drift.
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

// Closed list, on purpose — see the hyphen note in unverifiedProperNouns.
// These are English prefixes that attach to an ordinary word; a company
// name essentially never begins with one, and keeping the list closed is
// what stops "Google-scale" being cleared by its own second half.
// Kept byte-identical to HYPHEN_PREFIX in services/factLedger.ts.
const HYPHEN_PREFIX = new Set([
  'non', 'pre', 'post', 'anti', 'multi', 'sub', 'semi', 're', 'un',
  'inter', 'intra', 'over', 'under', 'cross', 'self', 'near', 'quasi',
  'pseudo', 'co', 'bi', 'tri', 'ex', 'mid', 'off', 'out', 'up', 'de',
  'micro', 'macro', 'mini', 'auto', 'meta', 'ultra', 'super', 'hyper',
]);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AN ACRONYM OF THE TRADE IS NOT AN EMPLOYER.
//
//  `isAcronym` deliberately blocks the sentence-initial waiver, because
//  "IBM" opening a sentence is still IBM. Correct — but it left the whole
//  acronym class with no way to be recognised at all, and the vocabulary
//  only ever contains what the candidate's own documents happen to spell
//  out. Measured on the real corpus (server/test/zz-cover-live, 24 real
//  questions on groq), acronyms were the single biggest rejection bucket:
//
//    "RAG is retrieval-augmented generation…"        → invented=[RAG]
//    "SLA targets are what decide the design…"       → invented=[SLA]
//    "ETL jobs land raw, then CDC keeps it current"  → invented=[ETL, CDC, SLO]
//
//  Every one is a correct, grounded sentence discarded over a term of art,
//  and the candidate got silence instead.
//
//  These are things, not organisations. Naming one is never a claim to
//  have worked anywhere, which is the only thing this guard exists to
//  police. So the list is closed and it is written to a single rule:
//
//    ⚠️ NOTHING THAT IS ALSO AN EMPLOYER, ever — no IBM, AWS, GCP, SAP,
//    HP, GE, EY, PwC, KPMG, TCS, HCL, CVS, UHG, JPMC, HSBC, DBS, IQVIA.
//    An acronym that names a company is exactly the fabrication this file
//    was written to catch, and adding one here would open the door it is
//    holding shut. When in doubt, leave it out: the cost of omission is
//    one dropped cover, the cost of inclusion is a spoken lie.
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

const NAME_JOINERS = new Set(['of', 'the', 'and', 'for', '&']);
// ⚠️ THE CHARACTER CLASS MUST REACH PAST ASCII, OR A REAL NAME BECOMES A
// FABRICATED ONE. Measured live 2026-08-20 on a correct cover:
//
//   REJECTED invented=[Bausch+Str]
//   text="I've engineered Bausch+Ströbel, VarioSys, and Syntegon filling lines."
//
// All three makers are named in the uploaded document. The class stopped at
// the "ö", so "Bausch+Ströbel" was read as the token "Bausch+Str", which of
// course matched nothing — and a true sentence was thrown away as an
// invention. Latin-1 Supplement + Latin Extended-A/B (À-ɏ) covers
// the European vendor names this domain is full of: Ströbel, Bürkert,
// Sartorius Stedim, Getinge, Müller, Zeiss.
const NAME_CHAR = "A-Za-z0-9\\u00C0-\\u024F&.+#'’-";
const NAME_HEAD = 'A-Z\\u00C0-\\u00DE';
const PROPER_RUN = new RegExp(
  `\\b[${NAME_HEAD}][${NAME_CHAR}]*`
  + `(?:\\s+(?:of|the|and|&|for)\\s+[${NAME_HEAD}][${NAME_CHAR}]*`
  + `|\\s+[${NAME_HEAD}][${NAME_CHAR}]*){0,4}\\b`,
  'g',
);

function collectProperNouns(text, into) {
  const runs = String(text || '').match(PROPER_RUN) || [];
  for (const run of runs) {
    for (const tok of run.split(/[\s&]+/)) {
      // ⚠️ THE KEEP-SET HERE MUST MATCH THE ONE IN unverifiedProperNouns.
      // It used to keep '.', which the matcher strips — so a name ENDING A
      // SENTENCE was stored as "sla." while the matcher looked for "sla",
      // and the two never met. Measured live 2026-08-06: the interviewer
      // asked to "cut the bill without degrading SLA." and the cover
      // answering it was thrown away for inventing SLA — a word the
      // question had just used. Any name at a sentence end was affected:
      // "...worked at IBM." put "ibm." in the allowed set, not "ibm".
      const w = tok.replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
      if (w.length >= 2 && !NAME_JOINERS.has(w)) into.add(w);
    }
  }
}

/** Parse the client's space-separated vocabulary string into a set. */
/**
 * The known-word set the checks look words up in.
 *
 * ⚠️ IT MUST NORMALISE EXACTLY AS THE LOOKUP DOES. This used to lowercase
 * and nothing else, while every lookup site strips punctuation first
 * (`replace(/[^A-Za-z0-9+#'’-]/g,'')`, three places below). So a vocabulary
 * of "Skills: Airflow, Python, MongoDB." stored `airflow,` `python,`
 * `mongodb.` — with the punctuation — and a sentence saying "Airflow" asked
 * for `airflow`, missed, and was reported as an INVENTED name. The guard
 * then threw away a true cover, and a thrown-away cover is silence in a
 * live interview.
 *
 * That did not bite the main path, because the client sends
 * `ledgerVocabulary(ledger)` — already-normalised tokens joined by spaces.
 * It bit the FALLBACK: with no knowledge base uploaded, routes/ai.js passes
 * `allowed` instead, which is the question and the interviewer's turns, and
 * that is ordinary punctuated prose. "Have you used Airflow, Kafka, or
 * Spark?" hid all three behind their own commas, so answering the question
 * honestly got the answer rejected.
 *
 * Widening this can only ever ADD words the candidate's own background or
 * the interviewer actually said — it never lets in a name that appears in
 * neither, which is the thing the guard exists to catch. Pinned by
 * vocab-roundtrip.test.js.
 */
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BOTH SIDES MUST CUT WORDS IN THE SAME PLACES
//
//  This split on WHITESPACE and then STRIPPED the punctuation inside each
//  word, while the offender scanner (PROPER_RUN) BREAKS at that same
//  punctuation. The two disagreed about where a word ends, and the
//  disagreement always fell the same way — against the candidate.
//
//  Measured live 2026-08-20 on a telecom résumé that contains the literal
//  string "5G Core SA/NSA":
//
//    REJECTED invented=[SA]  "…assisting readiness and troubleshooting of
//                             the 5G Core SA/NSA environment."
//
//  The scanner read "SA" and "NSA"; the vocabulary held "sansa". A term
//  printed in the candidate's own résumé was reported as an invented
//  company. The same merge hits every slashed compound there is — IQ/OQ/PQ,
//  CI/CD, TCP/IP, LC-MS/MS, AC/DC, 4G/5G — which is to say most fields.
//
//  So: SPLIT on anything outside the token class instead of deleting it.
//  Now the two sides tokenise identically by construction, and a compound
//  contributes each of its parts as well as nothing else.
const VOCAB_TOKEN = /[^A-Za-z0-9\u00C0-\u024F+#'’-]+/;

function parseVocabulary(vocabulary) {
  const set = new Set();
  for (const raw of normalisePunctuation(String(vocabulary || '')).split(VOCAB_TOKEN)) {
    const w = raw.replace(/^[-'’]+|[-'’]+$/g, '').toLowerCase();
    if (w.length >= 2) set.add(w);
  }
  return set;
}

/**
 * The proper nouns in `text` that the knowledge base does not support.
 *
 * `allowed` is what the interviewer said (question + recent turns). Echoing
 * a name they used is not inventing one — asked "have you worked at
 * Goldman?", the honest answer contains the word Goldman. Note that this
 * makes the guard alone insufficient for a question that NAMES a company:
 * a sentence claiming Goldman also echoes it. Those questions are answered
 * from the fact ledger on the client and never reach a model, which is why
 * that hole does not exist in practice.
 */
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A MODEL AND A DOCUMENT SPELL PUNCTUATION DIFFERENTLY
//
//  Measured live 2026-08-20, both correct covers, both thrown away:
//
//    invented=[Vis]                "I personally qualified HPLC, GC,
//                                   dissolution, balances, UV‑Vis, TOC…"
//    invented=[Bachelor’s, India]  "I earned a Bachelor’s in Pharmaceutical
//                                   Engineering from JNTUH in India…"
//
//  Every instrument in the first is printed in the uploaded document, and
//  the second is word-for-word what the résumé says. The model wrote UV‑Vis
//  with a NON-BREAKING hyphen (U+2011) where the file uses an ASCII one, so
//  the token split and "Vis" became an invented company; and Bachelor’s
//  with a curly apostrophe where the file has a straight one, so it stopped
//  matching the vocabulary that contained it.
//
//  This is the fourth time this same rule has failed for want of exact
//  spelling — trailing periods, plurals, lower-case speech-to-text, and now
//  Unicode punctuation. The lesson each time is identical: NORMALISE BEFORE
//  COMPARING. Both sides go through this, so it can only ever make a match
//  more likely — it cannot let an invented name through.
const PUNCT_NORMALISE = [
  [/[‐-―−]/g, '-'],      // ‐ ‑ ‒ – — ― and the minus sign
  [/[‘’‛ʼ]/g, "'"], // ‘ ’ ‛ ʼ
  [/[“”]/g, '"'],             // “ ”
  [/ /g, ' '],                     // non-breaking space
];

function normalisePunctuation(s) {
  let out = String(s || '');
  for (const [re, to] of PUNCT_NORMALISE) out = out.replace(re, to);
  // ── AND THE ACCENTS COME OFF TOO ──
  //
  // The token scanners below (SPOKEN / LOWER / WORD) are ASCII character
  // classes, so a letter outside ASCII ENDS a token rather than continuing
  // it. Measured live 2026-08-20, a correct cover binned:
  //
  //   REJECTED invented=[Bausch+Str]
  //   "I've engineered Bausch+Ströbel, VarioSys, and Syntegon filling lines."
  //
  // All three makers are printed in the uploaded document. The scan stopped
  // at the "ö" and reported the fragment as an invented company.
  //
  // Folding here rather than widening ten separate character classes: this
  // runs on the cover, the vocabulary AND the allowed text, so both sides
  // fold identically and a match can only become MORE likely — an invented
  // name has nothing to fold onto. Ströbel and Strobel become one name,
  // which is also what a person typing a vendor without the umlaut wants.
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function unverifiedProperNouns(vocabulary, text, allowed) {
  const s = normalisePunctuation(String(text || ''));
  if (!s.trim()) return [];
  const vocab = vocabulary instanceof Set
    ? vocabulary
    : parseVocabulary(normalisePunctuation(vocabulary));
  allowed = normalisePunctuation(allowed);
  // NO KNOWLEDGE BASE, NO OPINION. With nothing uploaded there is nothing
  // to contradict, and flagging every name would suppress every cover in
  // the app's most common state.
  if (vocab.size === 0) return [];

  const extra = new Set();
  if (allowed) collectProperNouns(allowed, extra);

  // ── THE INTERVIEWER DOES NOT SPEAK IN CAPITALS ──
  //
  // `allowed` is the question plus the interviewer's own lines, and the
  // rule it encodes is "a name the interviewer just used is theirs, not an
  // invention". collectProperNouns implements that by scanning for
  // CAPITALISED runs — which is right for typed text and wrong for this
  // product, because the question arrives from Deepgram and speech-to-text
  // writes terms of art in lower case.
  //
  // Measured on the real corpus: the interviewer asked "how can you define
  // rags?" and the cover answered "RAG is retrieval-augmented generation —
  // you ground a model in documents." That was thrown away as an invented
  // proper noun, over a word the question had just said out loud. The
  // existing note in collectProperNouns records the same bug one layer
  // down ("cut the bill without degrading SLA." storing `sla.`), so this
  // rule has already failed twice for want of exact spelling.
  //
  // So every word of what the interviewer said counts, in any case. This
  // widens nothing that was not already intended: a capitalised mention has
  // always been admitted here, and the trade — that echoing a company the
  // interviewer named is allowed — was made deliberately when `allowed` was
  // introduced. What changes is that the rule now works on how people
  // actually talk rather than on how a transcriber happened to render it.
  //
  // ⚠️ Deliberately NOT applied to the candidate's own previous answer.
  // `allowed` is built from the question and interviewerSaid() only, which
  // is what keeps a fabrication from vouching for its own sequel — see the
  // note at the `allowed` construction in routes/ai.js.
  if (allowed) {
    const SPOKEN = /[A-Za-z][A-Za-z0-9+#'’-]*/g;
    let am;
    while ((am = SPOKEN.exec(String(allowed))) !== null) {
      const t = am[0].replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
      if (t.length >= 2) extra.add(t);
    }
  }

  // A word capitalised only because a sentence started is capitalised by
  // grammar, not by meaning. That reasoning is sound and the implementation
  // of it was not: waiving the check for the whole opening slot waived it for
  // exactly the slot a fabricated employer lands in. COVER_SYSTEM tells the
  // model to start ANSWERING from the first word and to name the real
  // employer, so "Google is where I spent most of my time on that." passed
  // while the same claim one clause later ("I built that at Google") was
  // caught, and "Yeah. Accenture was the place." passed because the second
  // sentence starts too. The waiver is now earned rather than granted — see
  // SENTENCE_OPENERS and `lowered`.
  const initials = new Set();
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
  const lowered = new Set();
  const LOWER = /[A-Za-z][A-Za-z0-9+#.'’-]*/g;
  let lm;
  while ((lm = LOWER.exec(s)) !== null) {
    if (/^[A-Z]/.test(lm[0])) continue;
    const t = lm[0].replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
    if (t.length >= 2) lowered.add(t);
  }

  const offenders = [];
  const seen = new Set();
  const WORD = /[A-Za-z][A-Za-z0-9+#.'’-]*/g;
  let m;
  while ((m = WORD.exec(s)) !== null) {
    const raw = m[0];
    if (!/^[A-Z]/.test(raw)) continue;
    // A MATCH THAT STARTS INSIDE A NUMBER IS PART OF THE NUMBER. The token
    // pattern begins at a letter, so "75K+" yields "K+" and "3M+" yields
    // "M+" — and the digest hands the model a NUMBERS THAT ARE TRUE line
    // full of exactly those, so quoting the résumé's own metrics got the
    // answer rejected. Measured: "processing 75K+ records daily" reported
    // K+ as an invented name. The cost of this rule is a company written
    // tight against a digit ("3Com"); the benefit is every metric the
    // candidate is encouraged to cite.
    // `.` and `/` for the same reason: the pattern cannot begin on a slash,
    // so "C#/.NET" matches "C#" and then leaves a bare "NET" behind, and
    // ".NET" is on this résumé. A letter pressed directly against one of
    // these symbols is the tail of a technical token, not a new name — a
    // space is what separates names.
    if (m.index > 0 && /[0-9/.]/.test(s[m.index - 1])) continue;
    const isAcronym = /^[A-Z0-9+#.]{2,}$/.test(raw);
    const w = raw.replace(/[^A-Za-z0-9+#'’-]/g, '').toLowerCase();
    if (w.length < 2 || seen.has(w)) continue;
    // ONE LETTER IS NOT A NAME. "C#", "C++", "F#", "R" survive the length
    // check because their symbols count, but a single-letter employer is
    // not a thing the guard can police, while single-letter-plus-symbol is
    // overwhelmingly a language. C# is in the digest's skills line and NOT
    // in the vocabulary (the vocabulary tokeniser drops it), so the guard
    // was rejecting answers for saying a word the digest had just shown.
    if ((w.match(/[a-z]/g) || []).length < 2) continue;
    // Contracted pronouns are not companies — see the matching note in
    // services/factLedger.ts. Kept byte-identical to it; grounding-parity
    // fails if the two drift.
    const base = w.replace(/['’](?:s|d|ve|ll|re|m|t)$/, '');
    // ⚠️ A PLURAL IS THE SAME NAME. The interviewer asked "…but every DAG
    // is green", the cover answered "…the DAGs being green", and the guard
    // reported DAGs as invented because the allowed set held `dag`. That
    // threw away a correct, grounded sentence — "Success signals don't
    // necessarily mean correctness, so the DAGs being green doesn't
    // confirm the dashboard's accuracy" — and cost the candidate 2.4
    // seconds of silence while the main model caught up. Same class for
    // APIs/API, SLAs/SLA, KPIs/KPI, DAGs/DAG: acronyms get pluralised in
    // speech constantly.
    const forms = new Set([w, base].filter(Boolean));
    for (const f of [w, base]) {
      if (!f) continue;
      if (f.endsWith('es') && f.length > 4) forms.add(f.slice(0, -2));
      if (f.endsWith('s') && f.length > 3) forms.add(f.slice(0, -1));
      else forms.add(`${f}s`);
    }
    const known = (set) => { for (const f of forms) if (set.has(f)) return true; return false; };
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
    if (known(vocab)) continue;
    if (known(extra)) continue;
    // (The curated acronym waiver that stood here is gone — see the banner
    // above. A term of art now survives by being in the candidate's own
    // documents, in the question, or in a sentence that makes no claim
    // about the candidate at all, which is where terms of art live.)
    // A HYPHENATED COMPOUND IS ITS STEM PLUS ENGLISH. "Python-based" is not
    // a company: it is `python`, which the résumé lists, with a suffix the
    // model added because it was writing a sentence. Requiring the whole
    // compound in the vocabulary cost a real, correct cover in a live run —
    // an accurate answer about the candidate's own project, discarded over
    // one word. Only the LEADING segment is consulted, so "Google-scale" is
    // still Google and still caught.
    const stem = base.split('-')[0];
    // SENTENCE_OPENERS is consulted here too: "Exactly-once" is `exactly`
    // plus English, and `exactly` is an ordinary word this file already
    // knows — it was only ever missing from THIS check, so the single most
    // likely opening word of an answer about delivery semantics was
    // reported as an invented company.
    if (stem !== base && stem.length >= 2
      && (DISCOURSE.has(stem) || SENTENCE_OPENERS.has(stem)
        || vocab.has(stem) || extra.has(stem))) continue;
    // A LEADING ENGLISH PREFIX IS MORPHOLOGY, NOT A NAME. "Non-idempotent"
    // is `non` + `idempotent`, and the leading-segment rule above can never
    // clear it, because "non" appears in no vocabulary anywhere. Measured
    // 2026-08-06: a correct claude cover — "Non-idempotent sinks mean the
    // guarantee has to live upstream" — was dropped over
    // invented=[Non-idempotent]. When the head is a prefix, the word the
    // compound is actually ABOUT is what follows it, so that is what gets
    // checked.
    //
    // Deliberately NOT "clear it if any segment is known": "Google-scale"
    // would then be cleared by `scale`, and Google is precisely what must
    // still be caught. Only a closed list of prefixes opens this door.
    if (stem !== base && HYPHEN_PREFIX.has(stem)) {
      const tail = base.slice(stem.length + 1);
      if (tail && (DISCOURSE.has(tail) || SENTENCE_OPENERS.has(tail)
        || vocab.has(tail) || extra.has(tail) || isInflectedEnglish(tail))) continue;
    }
    seen.add(w);
    offenders.push(raw.replace(/[.,;:!?'’-]+$/, ''));
  }
  return offenders;
}

// ── A SENTENCE-INITIAL WORD THAT IS ENGLISH MORPHOLOGY, NOT A NAME ──
//
// SENTENCE_OPENERS is a fixed list, so the waiver it grants is only ever
// as complete as the list — and a denylist-by-omission fails in the
// direction that hurts. Measured 2026-08-06, after the cover prompt was
// changed to ask for a real judgement instead of a description of
// process, the openers it produced were rejected one after another:
//
//   "Strict exactly-once is impossible when the sink cannot deduplicate."
//   "Treating green as completion rather than correctness is the point."
//   "Achieving that at the sink is the part that cannot be promised."
//
// Every one is ordinary English and every one was reported as an invented
// proper noun, so the cover was dropped and the candidate got silence.
// Better openings are exactly the ones most likely to start with a word
// nobody thought to list.
//
// Morphology is the discriminator a list cannot be. These suffixes are
// English derivation and inflection — gerunds, participles, adverbs,
// comparatives, nominalisations. Company names essentially never take
// them, and the ones that could (-ing, as in Boeing or Corning) are still
// caught the moment they appear anywhere but the opening position,
// because this waiver applies ONLY at a sentence start.
//
// What this deliberately does NOT waive, because these are the actual
// attack: acronyms (`isAcronym` is checked before this is consulted, so
// "IBM" opening a sentence is still IBM), and any bare capitalised noun —
// Google, Accenture, Fidelity, Optum — none of which carry a suffix here.
// ⚠️ `-ity` IS DELIBERATELY ABSENT. It reads as pure morphology
// (quality, integrity, availability) right up until you remember that
// Fidelity is an employer — and "recently at Fidelity Investments" is a
// fabrication this codebase has already caught in the field, pinned in
// grounding-parity.test.js. `-ency`/`-ancy` are kept because no employer
// in reach takes them, and they buy back the words a judgement about
// distributed systems genuinely opens with: Consistency, Latency,
// Redundancy, Frequency.
const ENGLISH_SUFFIX = /(?:ing|edly|ed|ly|est|tion|sion|ness|ment|ance|ence|ency|ancy|able|ible|ive|ous|ful|less|ised|ized)$/i;

/**
 * True when a word is recognisably an inflected/derived English form
 * rather than a name. Length floor keeps short accidents ("Ed", "Ally")
 * out; the stem must be substantial enough that the suffix is morphology
 * and not most of the word.
 */
function isInflectedEnglish(word) {
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

function isGrounded(vocabulary, text, allowed) {
  return unverifiedProperNouns(vocabulary, text, allowed).length === 0;
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
//  Kept behaviour-identical to unverifiedNumbers in services/factLedger.ts.
//  Constants below are named and membered the same way on both sides —
//  same contract as DISCOURSE / SENTENCE_OPENERS.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Kept byte-identical to MAGNITUDE_OF in services/factLedger.ts.
const MAGNITUDE_OF = {
  k: 1000, m: 1000000, b: 1000000000,
  thousand: 1000, million: 1000000, billion: 1000000000,
};

// Bare digits at or below this, with no unit at all, are ordinary speech
// ("I ran 3 experiments"), not a claim. The instant the same digit carries
// a unit — 3%, 3M, 3 million — it is checkable and is checked. Mirrors
// the METRIC_RE note in factLedger.ts that a bare 45 is not a fact while
// 45 minutes is one.
const SMALL_BARE_CEILING = 10;
const YEAR_LO = 1900;
const YEAR_HI = 2100;

// Optional noise prefix, a digit run (commas / one decimal allowed), an
// optional unit from the magnitude/percent set, and an optional trailing
// plus. The unit alternatives are ordered so "percent"/"million" win over
// a lone letter, and the single-letter form refuses to eat the start of a
// longer word ("3 minutes" must not become three million).
// Kept byte-identical to NUMBER_CANDIDATE_RE in services/factLedger.ts.
// ⚠️ THE GUARD USED TO SEE ONLY PERCENTAGES AND SCALE WORDS.
//
// Whether an invented metric was caught depended on TYPOGRAPHY, not on
// meaning. Measured against this file before the units below existed:
//
//     "24 hour"  → caught          "24-hour" → INVISIBLE
//     "90 ms"    → caught          "820ms"   → INVISIBLE
//     "500 GB"   → caught          "40x"     → INVISIBLE
//
// The hyphen and the glued unit both trip isNumberEmbeddedInToken, which
// exists to skip version numbers and identifiers and cannot tell those
// from a duration. That is not academic: the fabrication recorded from a
// real interview — "causing a **24-hour** data loss" — is precisely the
// invisible spelling. The number WAS the kind of thing this guard is for;
// it escaped on punctuation alone.
//
// Units are listed here so the SAME regex feeds both sides of the check:
// collectCanonicalNumbers reads the résumé with it and unverifiedNumbers
// reads the cover with it. Extending only the cover side would invent
// false rejections — a true "3 days" from the résumé would look made up.
// Kept byte-identical to services/factLedger.ts (grounding-parity.test.js).
const METRIC_UNIT_SRC = '(?:ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|[KMGTP]B|QPS|TPS|RPS|x)';
const NUMBER_CANDIDATE_RE = new RegExp(
  '(?:~|≈|(?:over|about|approximately|around|roughly|under)\\s+)?'
  + '\\d[\\d,]*(?:\\.\\d+)?'
  + '(?:\\s*%|\\s*percent\\b|\\s*(?:thousand|million|billion)\\b|[kKmMbB](?![a-zA-Z])'
  + '|[\\s-]?' + METRIC_UNIT_SRC + '\\b)?\\+?',
  'gi',
);

/** Strip the noise a cover puts around a figure so the core is what we report. */
function numberCoreOf(match) {
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
function canonicalizeNumber(raw) {
  let s = numberCoreOf(raw).replace(/\+$/, '').trim();
  if (!s) return null;

  // ⚠️ ORDER: the metric unit comes off FIRST, before the K/M/B scale-letter
  // branch below. That branch reads a trailing [kKmMbB] as thousand/million/
  // billion — and the B in "500 GB" is exactly such a letter. Stripping later
  // meant "500 GB" became 500 × 1e9 with a leftover "G", failed the numeric
  // parse, returned null, and `value === null` is a `continue` — so adding
  // units to the regex without fixing this order made "500 GB" INVISIBLE when
  // it had been caught before. Caught by the round-trip test; keep it first.
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
function isNumberEmbeddedInToken(s, start, end) {
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
function isSpacedVersionNumber(s, coreStart, core) {
  if (!/^\d+\.\d+$/.test(core.replace(/\+$/, ''))) return false;
  if (coreStart === 0 || s[coreStart - 1] !== ' ') return false;
  let i = coreStart - 2;
  while (i >= 0 && /[A-Za-z]/.test(s[i])) i--;
  const word = s.slice(i + 1, coreStart - 1);
  if (!word || /\d/.test(word)) return false;
  return /^[A-Z]/.test(word);
}

function isYearNumber(core) {
  const cleaned = core.replace(/,/g, '').replace(/\+$/, '');
  if (!/^\d{4}$/.test(cleaned)) return false;
  const n = parseInt(cleaned, 10);
  return n >= YEAR_LO && n <= YEAR_HI;
}

function isSmallBareInteger(core) {
  const cleaned = core.replace(/,/g, '').replace(/\+$/, '');
  if (!/^\d+$/.test(cleaned)) return false;
  const n = parseInt(cleaned, 10);
  return n >= 0 && n <= SMALL_BARE_CEILING;
}

/** True when this core carries a unit/magnitude/percent — i.e. is a claim. */
function hasNumberUnit(core) {
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
//  canonicalizeNumber strips the metric unit before parsing, deliberately:
//  a model that says "94%" in one sentence and "94" in the next is
//  repeating itself, not inventing, and stripping is what lets the bare
//  form match. That part is right and is preserved below.
//
//  What it also did was let a number vouch for a DIFFERENT quantity that
//  happened to share its digits. Measured on a real upload: the document
//  contained "12 months" — the length of the contract — and the cover said
//  an invented mistake "delayed product release by 12 weeks". The guard
//  compared 12 to 12 and passed it. Verified against controls at the same
//  time: "11 weeks" and "3.7 %" were both correctly caught, so the check
//  itself worked; it was the comparison that was too coarse.
//
//  So the known set is keyed by value AND unit family, and the bare form is
//  kept alongside it:
//    · a bare candidate matches ANY recorded value  (the "94" case above)
//    · a candidate WITH a unit needs that unit, or a bare recorded value
//      (the document wrote "70+", the cover says "70 assets")
//    · "12 weeks" against a recorded "12 months" now fails, which is the
//      whole point
//
//  Magnitude letters are NOT units — K/M/B are a scale and canonicalizeNumber
//  has already multiplied them into the value, so "3M" and "3 million" and
//  "3,000,000" all key as 3000000 with an empty family, exactly as before.
const UNIT_FAMILIES = [
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

function unitFamilyOf(core) {
  const s = String(core || '').replace(/\+$/, '').trim();
  if (/%\s*$/.test(s) || /\bpercent\s*$/i.test(s)) return '%';
  for (const [alt, fam] of UNIT_FAMILIES) {
    if (new RegExp('[\\s-]?(?:' + alt + ')\\s*$', 'i').test(s)) return fam;
  }
  return '';
}

/** Does `known` support this value in this unit family? */
function numberIsKnown(known, value, family) {
  if (!family) return known.values.has(value);
  return known.keys.has(`${value}|${family}`) || known.keys.has(`${value}|`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "TWENTY-FIVE" IS A NUMBER
//
//  Everything below scans for DIGITS, so the whole check was blind to a
//  figure written out. Proved by running the same fabricated claim twice:
//
//    "roughly twenty-five 5G registration failures daily"  ->  []
//    "roughly 25 5G registration failures daily"           ->  ["25"]
//
//  Same claim, same guard, opposite verdicts - and the spelled-out form is
//  the one a model reaches for when it is inventing, because prose is
//  where it is inventing. Measured live, three fabrications rode out on
//  this: "roughly twenty-five ... daily", "a dozen pipelines", and "some
//  months I'd run fifty or sixty".
//
//  Both sides go through the conversion, so a document that says "three
//  years" still vouches for a cover that says "3 years", and vice versa -
//  it can only ever make a match MORE likely.
//
//  ⚠️ A CLOSED CLASS AGAIN: the numerals of one language, which is a fixed
//  list of about thirty words in any language that has them. Not a
//  vocabulary that grows with industries.
const NUMBER_WORD = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, dozen: 12,
};
const SCALE_WORD = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const NUMBER_PHRASE = new RegExp(
  '\\b(?:' + Object.keys(NUMBER_WORD).join('|') + ')'
  + '(?:[\\s-]+(?:' + Object.keys(NUMBER_WORD).join('|') + '))?'
  + '(?:[\\s-]+(?:' + Object.keys(SCALE_WORD).join('|') + '))?\\b',
  'gi',
);

/** "twenty-five" -> "25", in place, so the digit scanners can see it. */
function digitsForWords(text) {
  return String(text || '').replace(NUMBER_PHRASE, (m) => {
    let total = 0;
    let scale = 1;
    for (const w of m.toLowerCase().split(/[\s-]+/)) {
      if (NUMBER_WORD[w] !== undefined) total += NUMBER_WORD[w];
      else if (SCALE_WORD[w] !== undefined) scale = SCALE_WORD[w];
    }
    const v = (total || 1) * scale;
    // Leave the word in place as well. Dropping it would change the
    // sentence the proper-noun scanner sees, and the point here is only to
    // make the value visible to the number scanner.
    return `${v} ${m}`;
  });
}

function collectCanonicalNumbers(source, into) {
  const str = String(source || '');
  const re = new RegExp(NUMBER_CANDIDATE_RE.source, 'gi');
  let m;
  while ((m = re.exec(str)) !== null) {
    const core = numberCoreOf(m[0]);
    const v = canonicalizeNumber(m[0]);
    if (v === null) continue;
    into.values.add(v);
    into.keys.add(`${v}|${unitFamilyOf(core)}`);
  }
}

/** The shape collectCanonicalNumbers fills and numberIsKnown reads. */
function newKnownNumbers() {
  return { values: new Set(), keys: new Set() };
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
 */
function unverifiedNumbers(contextText, text, allowed) {
  const ctx = String(contextText || '');
  // NO KNOWLEDGE BASE, NO OPINION. With nothing uploaded there is nothing
  // to contradict, and flagging every number would suppress every cover in
  // the app's most common state — a session with no files. Empty means the
  // contextText string itself is blank; a digest that contains prose but
  // zero numeric metrics is still a real KB and does NOT take this exit.
  if (!ctx.trim()) return [];

  const s = digitsForWords(String(text || ''));
  if (!s.trim()) return [];

  const known = newKnownNumbers();
  collectCanonicalNumbers(digitsForWords(ctx), known);
  if (allowed) collectCanonicalNumbers(digitsForWords(allowed), known);

  const offenders = [];
  const seen = new Set();
  const re = new RegExp(NUMBER_CANDIDATE_RE.source, 'gi');
  let m;
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE HOUSE PHRASE
//
//  COVER_SYSTEM contains a section headed "⚠️ NO HOUSE PHRASE. THE FIRST
//  WORDS MUST COME FROM THE QUESTION", and it did not work. Measured over
//  the last 400 model answers in the user's database, 61 of them — 15.3% —
//  opened with a phrase that section forbids. Three separate answers began
//  with the identical words "Most of my time's been on", and one of those
//  was in front of a question about concurrency in RAG systems: a career
//  summary welded by a comma onto an unrelated technical answer, which is
//  two answers at once and the interviewer hears both.
//
//  A prompt cannot enforce variety on a 70B model at temperature 0.7 under
//  a 1.5-second deadline. A string check can. Same failure mode as the
//  proper-noun guard, same remedy: measure the output rather than trusting
//  the instruction, and drop the cover rather than speak it.
//
//  Anchored to the START of the text only. "Most of my time" appearing
//  mid-sentence in a genuine answer is fine; it is the OPENING that is the
//  tell, because an opening that fits every question answers none of them.
const BANNED_OPENERS = [
  /^most of my time'?s? (?:been|has been)\b/i,
  /^i'?ve (?:worked |spent )?most(?:ly)? (?:of my time )?on\b/i,
  /^i'?ve spent most of my (?:time|career)\b/i,
  /^first thing i'?d (?:look at is|establish is) (?:defining|what)\b/i,
  /^(?:that'?s|that is) (?:a )?(?:great|good|interesting|excellent) question\b/i,
  /^(?:great|good|interesting) question\b/i,
  /^(?:certainly|absolutely|of course|indeed|fundamentally)\b/i,
  /^let me (?:break this down|walk you through)\b/i,
  /^(?:at its core|in essence)\b/i,
  /^so the way i'?d (?:approach|frame) that is to build upon\b/i,

  // ── PROCESS NARRATION ──
  // Added 2026-08-06 from covers measured live in the running app. Each of
  // these was spoken in front of a hard technical question and said
  // nothing about it:
  //   "I'd want to confirm the current ETL pipeline's performance metrics…"
  //   "I'd verify the current data processing workflows at <employer>…"
  //   "I'd start by confirming the current ETL pipeline's performance."
  //   "First, I'd verify the current table's ingestion rate…"
  // They are the same failure as "Most of my time's been on": an opening
  // that fits every question and therefore answers none. The prompt now
  // asks for the constraint, the distinction or the reframe instead; this
  // is the measurement that catches it when the model narrates anyway.
  // Deliberately requires the generic OBJECT ("the current/existing/
  // baseline …") as well as the verb, so a substantive sentence that
  // happens to begin "I'd establish that exactly-once isn't achievable
  // here" is untouched.
  /^(?:first,?\s*)?i'?d (?:want to |like to |need to )?(?:verify|confirm|establish|assess|review|understand|check|look at) (?:the |a |their )?(?:current|existing|baseline)\b/i,
  /^i'?d start by (?:verifying|confirming|looking at|understanding|checking|establishing|assessing|reviewing|measuring)\b/i,
  /^i'?d want to (?:understand|know) (?:the|more about|what)\b/i,
];

/**
 * The banned opening phrase this text starts with, or '' if it is clean.
 * Returns the phrase (not a boolean) so the rejection log says which one
 * fired — otherwise tuning this list means guessing.
 */
function hasBannedOpener(text) {
  const s = String(text || '').replace(/^[\s"'“”‘’—–-]+/, '');
  if (!s) return '';
  for (const re of BANNED_OPENERS) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  return '';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER BROKE CHARACTER AND NARRATED THE JOB.
//
//  Every other check in this file polices what the cover CLAIMS. This one
//  polices who is speaking. Measured on the real corpus (24 questions,
//  groq), when the transcript handed the model a fragment rather than a
//  question — which speech-to-text does constantly, mid-interview — it
//  stopped being the candidate and started describing the task:
//
//    "I need the candidate background to answer this question. The
//     interviewer is asking about specific work, which means I need to
//     know what project or role…"
//    "I need more context to answer this properly. The interviewer's
//     statement trails off mid-thought…"
//
//  Both PASSED every existing check — there is no invented name and no
//  invented number in them — and this text is forwarded to the candidate's
//  screen and read aloud a fraction of a second later. Saying "the
//  interviewer is asking about specific work" TO the interviewer is not a
//  weak answer, it is the assistant being discovered.
//
//  ⚠️ NOT A BAN ON FRAGMENTS. Asked something that was not a question, the
//  right output is what a person says — "I'm not sure I caught a question
//  in there" — and the same run produced exactly that, correctly, and it
//  must keep passing. What is banned is the THIRD PERSON: the interview
//  described from outside instead of spoken from inside.
//
//  So the list is only phrases a human candidate would never say out loud
//  in the room. "The question is really about X" is a legitimate reframe
//  and is deliberately NOT here; "the candidate" always is, because the
//  candidate is the one talking.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const META_LEAKS = [
  /\bthe interviewer(?:'s|’s)?\b/i,
  /\bthe candidate(?:'s|’s)?\b/i,
  /\bthis candidate(?:'s|’s)?\b/i,
  /\bcandidate background\b/i,
  /\bthe background (?:provided|section|given|supplied)\b/i,
  /\bthe (?:resume|résumé|context|transcript) provided\b/i,
  /\bthe provided (?:resume|résumé|background|context)\b/i,
  /\bas an? (?:AI|language model|assistant)\b/i,
  /\bI(?:'m| am) an? (?:AI|language model|assistant)\b/i,
  /\bno (?:candidate )?background (?:was |is )?(?:provided|given|supplied)\b/i,
];

/**
 * The meta phrase this cover broke character with, or '' if it is clean.
 * Returns the phrase rather than a boolean so the rejection log names what
 * fired — the same reason hasBannedOpener does.
 */
function hasMetaLeak(text) {
  const s = String(text || '');
  if (!s.trim()) return '';
  for (const re of META_LEAKS) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  return '';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A PLAN ANNOUNCED IS NOT A POINT MADE.
//
//  COVER_SYSTEM forbids opening a problem question by narrating process,
//  in capitals, with examples. Measured against gpt-5.6 on 2026-08-17 it
//  was ignored on BOTH scenario questions in the set:
//
//    "First, I'd inventory every DAG, tag by owner and criticality..."
//    "First, I'd verify that the downstream metrics are consuming the
//     right output..."
//
//  Neither is wrong and neither is an answer — both would fit almost any
//  question, which is the definition of filler. And the model plainly
//  KNOWS better: the second one's own last clause was the real opener
//  ("a green pipeline only guarantees task completion, not correctness"),
//  it just arrived third.
//
//  ⚠️ THIS IS NOT A REJECTION RULE, unlike everything else in this file.
//  The other checks police what would be a LIE; this one polices what is
//  merely weak, and dropping a cover for being weak buys silence instead.
//  It is used by /cover/prewarm to spend its spare window on ONE retry —
//  see the note there. A second miss is kept and spoken.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PROCESS_OPENERS = [
  /^(?:well|so|ok(?:ay)?)?[,\s]*first(?:ly)?\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*(?:the|my)\s+first\s+(?:thing|step|move|question)\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*to\s+start\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*initially\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*before\s+(?:i|anything|doing)\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*i(?:'|’)?d\s+(?:start|begin)\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*i\s+would\s+(?:start|begin)\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*(?:my|the)\s+approach\s+(?:here\s+)?(?:would\s+be|is)\b/i,
  /^(?:well|so|ok(?:ay)?)?[,\s]*step\s+one\b/i,
];

/**
 * The process-narration phrase this cover opens with, or '' if it leads
 * with a point. Returns the phrase, not a boolean, so a log says which
 * shape fired rather than leaving it to be guessed.
 */
function opensWithProcessNarration(text) {
  const s = String(text || '').replace(/^[\s"'“”‘’—–-]+/, '');
  if (!s.trim()) return '';
  for (const re of PROCESS_OPENERS) {
    const m = re.exec(s);
    if (m) return m[0].trim();
  }
  return '';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RULE 1 — A CLAIM ABOUT YOURSELF COMES WITH THE LINE YOU READ IT IN
//
//  The cover model is asked for two things: the sentence, and the exact
//  words from the candidate's documents that the sentence rests on. This
//  checks the second against the first.
//
//  It is a SUBSTRING test after mechanical normalisation, and deliberately
//  nothing cleverer. Fuzzy matching is how a citation stops being evidence:
//  the whole value of the rule is that the model cannot satisfy it by
//  writing something plausible, only by copying something real.
//
//  What normalisation covers is the difference between two renderings of
//  the same text, never a difference in what it says:
//    · Unicode form and accents  (the U+2011 hyphen that binned a correct
//      cover naming Bausch+Ströbel; the curly apostrophe that binned a
//      correct sentence about a Bachelor's degree)
//    · case
//    · runs of whitespace, and the line breaks a PDF extractor invents
//    · punctuation, which a model re-punctuates when it quotes
//
//  A citation that does not hold is the strongest signal in this file. It
//  does not mean the sentence is unsupported — it means the model invented
//  its own evidence, and a model doing that is not to be trusted with the
//  sentence either. routes/ai.js drops the whole cover.
function citationKey(s) {
  return normalisePunctuation(String(s || ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// A sentence can rest on two lines of a document, and a model asked for
// the words it read will then hand back both:
//
//   CITE: "AMF, SMF, UPF, UDM, NRF" and "MME, SGW, PGW, HSS, PCRF"
//
// Measured live: three of six citations were this shape, every fragment
// real, and all three were reported as confabulations because the JOIN is
// not in the document. Rejecting an honest quotation for its punctuation
// is the same class of mistake as rejecting UV-Vis for its hyphen.
//
// So a citation may be several quotations, and EVERY one of them has to
// hold. Requiring all of them is what keeps this from becoming a way to
// smuggle an invented line in beside a real one.
function fragmentsOf(cite) {
  const s = String(cite || '').trim();
  const quoted = s.match(/"[^"]{4,}"|“[^”]{4,}”/g);
  if (quoted && quoted.length > 1) return quoted.map((q) => q.slice(1, -1));
  // Unquoted, or a single quotation: newlines and bullets are the only
  // other separators a model reaches for. Deliberately NOT splitting on
  // commas or " and " - those occur inside real sentences constantly, and
  // splitting there would let half a quotation vouch for the whole.
  const parts = s.split(/\r?\n+|(?:^|\s)[-•*]\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : [s];
}

/**
 * Does `cite` actually occur in `source`?
 *
 * A citation is evidence, so this is a plain substring test after
 * mechanical normalisation and nothing cleverer. Fuzzy matching would
 * destroy the only property that makes it worth having: that the model
 * cannot satisfy it by writing something plausible.
 */
function citationHolds(source, cite) {
  const key = citationKey(source);
  const frags = fragmentsOf(cite);
  let held = 0;
  for (const f of frags) {
    const c = citationKey(f);
    // Too short to be evidence of anything. "the", "yes", a bare number —
    // these occur in every document and would license any sentence at all.
    if (c.length < 12) continue;
    if (key.indexOf(c) === -1) return false;
    held++;
  }
  return held > 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RULE 2 — IS THE SENTENCE ABOUT THE CANDIDATE, OR ABOUT THE SUBJECT?
//
//  This is the discriminator the old acronym list was standing in for, and
//  it works where that one could not, because it reads the CLAIM instead of
//  guessing from the token.
//
//    "UE initiates attach by sending Attach Request to the MME."
//        — about the subject. UE and MME are terms of art. Nothing here can
//          be false about this candidate, because it says nothing about them.
//
//    "I spent three years at IBM."
//        — about the candidate. IBM is two characters away from UE in every
//          lexical sense and a world away in consequence.
//
//  Both of those were live measurements: the first was REJECTED as an
//  invented company, the second is the failure mode the guard exists for.
//  No property of the words separates them. The verb does.
//
//  ⚠️ THIS IS THE ONE LANGUAGE-SCOPED CONSTANT IN THE COVER PATH, and it
//  is a CLOSED GRAMMATICAL CLASS, not a vocabulary: first-person pronouns
//  and the auxiliaries of past tense. It does not grow when a candidate
//  from a new industry uploads a document — the failing of every list this
//  replaced. Supporting another language is one more constant here, not an
//  open-ended maintenance surface. Transcription is English-only today
//  (Deepgram), so that is where it is aimed.
//
//  WHAT IT DELIBERATELY DOES NOT MATCH: the hypothetical. "The way I'd
//  frame it", "I would start from the constraint" — first person, no claim
//  about anything that happened. Those are the framing lane and they are
//  most of what a good cover says.
const SELF_PRONOUN_SRC = "(?:i|we|my|our|me|us|mine|ours|myself|ourselves)";
// -- THE HYPOTHETICAL IS NOT A HISTORY --
//
// "The way I'd frame it", "I would start from the constraint" - first
// person, and no claim that anything happened. That is the framing lane
// and it is most of what a good cover says, so a modal clause comes out
// before the test below looks for a claim. Modals are a closed class too.
// ⚠️ THE NEGATED MODALS BELONG HERE TOO, and leaving them out cost a good
// answer. Found by auditing a real interview in the app's own database:
//
//   "I also wouldn't let a model approve an audit conclusion or execute a
//    consequential action."
//
// That is a stance — one of the strongest things a candidate can say about
// AI in a controlled environment — and deniesOwnHistory read it as a
// denial, because "wouldn't" is a negator sitting next to "I". A modal
// expresses possibility, not past fact, so a negated modal is no more a
// claim about history than the bare one is.
//
// It was also INCONSISTENT before this: "I can't" was already being
// stripped by accident, because `can\b` happens to match the "can" of
// "can't" while `would\b` does not match the "would" of "wouldn't". Two
// sentences of the same shape got opposite verdicts.
//
// What this gives up: a soft denial phrased as a modal — "I can't recall
// using X" — is no longer refused. That is the right side to be wrong on;
// it is hedged rather than false, and the hard forms ("I haven't used X",
// "I didn't run X", "No, I have not") are untouched.
// The optional word is an adverb slot: "I ALSO wouldn't", "I really
// would", "I probably could". Any single word, so it needs no list --
// a non-modal after it simply fails to match and the sentence stays a
// claim ("I also worked at X" is untouched).
const HYPOTHETICAL_SELF =
  /\b(?:i|we)\b\s*(?:[a-z]+\s+)?(?:'d\b|'ll\b|would\b|will\b|could\b|might\b|can\b|may\b|should\b|shall\b|wouldn't|won't|couldn't|shouldn't|shan't|can't|cannot|mightn't|mustn't)/gi;

/**
 * Does this sentence assert something about the candidate's own history?
 *
 * Used to decide which of the two rules applies, NOT to reject on its own.
 *
 * -- WHY THIS IS SO BLUNT --
 *
 * Three drafts of this tried to read the VERB: auxiliaries, then -ed and
 * -ing morphology, then a preposition-plus-name shape. Each one leaked,
 * and each leak was an irregular past tense: "I spent three years at IBM",
 * "I built a dozen pipelines", "I held Cpk 1.33 across all heads". Every
 * one of those is a real measured failure, and closing them by listing
 * irregular verbs is the same disease as the acronym list it replaced -
 * a vocabulary that has to grow forever and is wrong in every other
 * language.
 *
 * So: once the hypothetical is removed, ANY first-person reference left in
 * the sentence makes it a claim about the speaker, and a claim about the
 * speaker needs the line it came from. No verb lexicon, no tense analysis,
 * nothing that has to be extended per industry.
 *
 * The cost is one class of false positive - "I think the constraint is X",
 * a framing sentence with a first-person hedge - which now needs a
 * citation and will usually be dropped instead of spoken. COVER_SYSTEM
 * already forbids that shape of opener, so the cost is small and it falls
 * on the safe side.
 *
 * -- AND ABSENCE IS A CLAIM, WHICH IS THE POINT --
 *
 * "I haven't used Kneat." "I haven't worked with LLMs." Both were spoken
 * aloud in live runs, both were false, and both were the most expensive
 * error the cover has made - the app denying, to an interviewer, work the
 * candidate had actually done. No citation can prove an absence, so under
 * this rule the cover can never say one. It is the main model, which has
 * read the whole document, that gets to decide the candidate has NOT done
 * something.
 *
 * The same rule also removes the honest "I don't have that number to
 * hand", which is a genuine loss - but it was measured arriving one
 * sentence later from the main model anyway, and it is not worth keeping a
 * hole open for.
 */
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AND ABSENCE IS THE ONE CLAIM NO CITATION CAN EVER CARRY
//
//  The citation rule proves the model READ something. It does not prove
//  the model read THIS. Measured live, accepted and would have been
//  spoken:
//
//    "No, I haven't worked with Kubernetes directly. My virtualization
//     experience has been with VMware ESXi and Hyper-V..."
//
//  It cited the VMware line, which is real, and the citation held - so a
//  denial rode into the room on evidence for a different sentence. That it
//  happened to be TRUE this time is luck, not mechanism, and the same
//  shape spoken twice in earlier runs was false both times: "I haven't
//  used Kneat" for a tool that is a main part of the job, and "I haven't
//  worked directly with LLMs" in front of an answer that then described
//  two LLM projects. That is the most expensive error this app can make -
//  denying, to an interviewer, work the candidate actually did.
//
//  No quotation can show a thing did not happen. So a denial about the
//  candidate is refused outright, with or without a citation. Only the
//  main model, which has read the whole document, gets to say no.
//
//  ⚠️ CLOSED GRAMMATICAL CLASS, like the pronouns above - negators, not
//  vocabulary. It does not grow when a new industry uploads a document.
//
//  The cost is real and is accepted: "I didn't own the PPQ batches, I led
//  the engineering runs" is honest, useful, and now silent. It arrives
//  from the main model a second later, which is the trade this whole
//  design makes.
const NEGATOR = new RegExp(
  "\\b(?:not|never|no|none|nothing|neither|nor|hardly|barely|rarely"
  + "|haven't|hasn't|hadn't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't"
  + "|won't|wouldn't|can't|cannot|couldn't|shan't|shouldn't)\\b",
  'i',
);

// ── THE NEGATION HAS TO BE ATTACHED TO THE PERSON ──
//
// "Both appear somewhere in the sentence" was too coarse, and it cost a
// good cover the first time it ran live:
//
//   REJECTED deniedOwnHistory
//   "If a subscriber attaches successfully but can't browse, the problem
//    is almost always with the IP path to the internet — …"
//
// That is a statement about subscribers, and a strong one. It was thrown
// away because "can't" is a negator and something later in it referred to
// the speaker. A denial about oneself puts the two TOGETHER — "I haven't",
// "no, I did not", "I never" — so proximity is the test, not co-occurrence.
//
// Three tokens of slack covers every form of it ("No, I have not…") and
// nothing reaches across a clause.
const DENIAL_WINDOW = 3;

function deniesOwnHistory(text) {
  const raw = normalisePunctuation(String(text || ''));
  if (!raw.trim()) return false;
  if (!NEGATOR.test(raw)) return false;
  // A hypothetical is not a history, here as much as in claimsOwnHistory:
  // "I'd check the IP path" is the framing lane, whatever else the
  // sentence says about what is not happening.
  const words = raw.replace(HYPOTHETICAL_SELF, ' ').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const self = new RegExp('^' + SELF_PRONOUN_SRC + '$', 'i');
  const neg = new RegExp('^(?:' + NEGATOR.source.replace(/^..|..$/g, '') + ')$', 'i');
  for (let i = 0; i < words.length; i++) {
    // "I've" is one token here, and the pronoun is only its first half.
    // Contractions of the AUXILIARY come off; contractions of the NEGATOR
    // (haven't, didn't) must not, which is why this is done per-test.
    if (!self.test(words[i].replace(/'(?:ve|d|ll|m|re|s)$/i, ''))) continue;
    for (let j = Math.max(0, i - DENIAL_WINDOW); j <= Math.min(words.length - 1, i + DENIAL_WINDOW); j++) {
      if (j !== i && neg.test(words[j])) return true;
    }
  }
  return false;
}

function claimsOwnHistory(text) {
  const raw = normalisePunctuation(String(text || ''));
  if (!raw.trim()) return false;
  return SELF_REFERENCE.test(raw.replace(HYPOTHETICAL_SELF, ' '));
}

const SELF_REFERENCE = new RegExp('\\b' + SELF_PRONOUN_SRC + '\\b', 'i');

module.exports = {
  unverifiedProperNouns,
  unverifiedNumbers,
  isGrounded,
  hasBannedOpener,
  hasMetaLeak,
  opensWithProcessNarration,
  parseVocabulary,
  citationHolds,
  claimsOwnHistory,
  deniesOwnHistory,
  _test: { DISCOURSE, SENTENCE_OPENERS, collectProperNouns, BANNED_OPENERS, META_LEAKS },
};
