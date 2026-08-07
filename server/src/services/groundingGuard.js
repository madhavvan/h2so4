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

const NAME_JOINERS = new Set(['of', 'the', 'and', 'for', '&']);
const PROPER_RUN = /\b[A-Z][A-Za-z0-9&.+#'’-]*(?:\s+(?:of|the|and|&|for)\s+[A-Z][A-Za-z0-9&.+#'’-]*|\s+[A-Z][A-Za-z0-9&.+#'’-]*){0,4}\b/g;

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
function parseVocabulary(vocabulary) {
  const set = new Set();
  for (const raw of String(vocabulary || '').split(/\s+/)) {
    const w = raw.trim().toLowerCase();
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
function unverifiedProperNouns(vocabulary, text, allowed) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const vocab = vocabulary instanceof Set ? vocabulary : parseVocabulary(vocabulary);
  // NO KNOWLEDGE BASE, NO OPINION. With nothing uploaded there is nothing
  // to contradict, and flagging every name would suppress every cover in
  // the app's most common state.
  if (vocab.size === 0) return [];

  const extra = new Set();
  if (allowed) collectProperNouns(allowed, extra);

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
const NUMBER_CANDIDATE_RE = /(?:~|≈|(?:over|about|approximately|around|roughly|under)\s+)?\d[\d,]*(?:\.\d+)?(?:\s*%|\s*percent\b|\s*(?:thousand|million|billion)\b|[kKmMbB](?![a-zA-Z]))?\+?/gi;

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
  return /%|\bpercent\b|\b(?:thousand|million|billion)\b|[kKmMbB]\s*$/i.test(s);
}

function collectCanonicalNumbers(source, into) {
  const str = String(source || '');
  const re = new RegExp(NUMBER_CANDIDATE_RE.source, 'gi');
  let m;
  while ((m = re.exec(str)) !== null) {
    const v = canonicalizeNumber(m[0]);
    if (v !== null) into.add(v);
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
 */
function unverifiedNumbers(contextText, text, allowed) {
  const ctx = String(contextText || '');
  // NO KNOWLEDGE BASE, NO OPINION. With nothing uploaded there is nothing
  // to contradict, and flagging every number would suppress every cover in
  // the app's most common state — a session with no files. Empty means the
  // contextText string itself is blank; a digest that contains prose but
  // zero numeric metrics is still a real KB and does NOT take this exit.
  if (!ctx.trim()) return [];

  const s = String(text || '');
  if (!s.trim()) return [];

  const known = new Set();
  collectCanonicalNumbers(ctx, known);
  if (allowed) collectCanonicalNumbers(allowed, known);

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
    if (known.has(value)) continue;
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

module.exports = {
  unverifiedProperNouns,
  unverifiedNumbers,
  isGrounded,
  hasBannedOpener,
  parseVocabulary,
  _test: { DISCOURSE, SENTENCE_OPENERS, collectProperNouns, BANNED_OPENERS },
};
