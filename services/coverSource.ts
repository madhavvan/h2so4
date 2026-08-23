// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHAT THE COVER MODEL READS — THE DOCUMENTS, NOT A SUMMARY OF THEM
//
//  This replaced ledgerDigest() on the coverContext field. The digest was
//  a RECONSTRUCTION: it parsed the uploaded files into a fact ledger and
//  then rebuilt prose from that ledger. Every fabrication measured in the
//  2026-08-20 live runs came out of the rebuild, not the model.
//
//  Measured, on a real 39,891-char upload:
//    · 863 characters reached the cover model — 2.2% of the document
//    · four employers arrived as EIGHT entries ("Evonik AL ·" and
//      "Evonik" both, the markdown separator kept inside the name)
//    · a line reading "Also claimed: … GMARS/CMMS …" was attached to an
//      employer, and the model duly claimed GMARS out loud — three times
//      across two runs — for a document that says in capitals DO NOT
//      CLAIM IT
//    · a heading "NUMBERS THAT ARE TRUE:" introduced 44 figures scraped
//      from the whole file, INCLUDING the interviewer's own company's
//      capital-investment numbers
//    · the words that decide the answers — Kneat, HPLC, USP, the degree —
//      were not in it at all, so the app denied a qualification the
//      candidate actually holds
//
//  The fix is not a better summariser. It is not summarising.
//
//  ━━━ WHAT CHANGED AGAIN, AND WHY ━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//  The first version of this module sent the whole document minus two
//  named classes of section, matched by a list of HEADING NAMES. It was
//  written against one pharmaceutical prep document and it worked on
//  exactly that document. The next real upload titled the same section
//  differently and sailed straight through, carrying nine consultancy
//  names the candidate never worked for and a salary band.
//
//  That list was the wrong mechanism, and extending it would not have made
//  it the right one: it encodes one industry's vocabulary in one language,
//  in an app used by candidates in every field. The measurement it was
//  built on is real, though, so it is worth restating what it showed
//  (three samples per cell, real COVER_SYSTEM and userPrompt):
//
//    context                       "used Kneat"   "used GMARS"   TTFT p90
//    digest (863ch)                0/3            0/3              630ms
//    raw, whole 40K file           0/3 (loses it) 2/3            1,376ms
//    the candidate's own material  3/3            3/3            1,023ms
//
//  The finding is NOT "drop client-research sections". It is that a model
//  handed 12,000 tokens of mixed content loses the one line that matters.
//  That is a RELEVANCE problem, and relevance is measurable without
//  knowing anything about the industry: the app already ranks passages
//  against a question with BM25, for the main answer, in kbRetrieval.
//
//  So the cover reads the passages of the candidate's documents that bear
//  on THIS question, verbatim, plus the document's own opening block so it
//  always knows who is speaking. No heading list, no domain vocabulary, no
//  language assumption beyond the ones BM25 already makes.
//
//  It is also four times smaller, which is TTFT back.
//
//  Failing SAFE means keeping. Nothing is dropped for looking suspicious;
//  passages are ranked, and the budget decides where the ranking stops.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import type { ContextFile } from '../types';
import { isJobDescription } from './factLedger';
import { retrieveEvidence } from './kbRetrieval';

// ── THE WHOLE-DOCUMENT CEILING ──
//
// ⚠️ 36,000 → 120,000. The old number was a PROMPT budget: it was chosen so
// that the whole document would fit inside the prewarm's TTFT window, back
// when the whole document was what got sent. Selection replaced that, and
// the stale ceiling then did real damage — measured on the 39,995-char
// fill/finish document, it cut 6,588 characters off the TAIL, and the tail
// is the section that reads "Do not claim:". Precisely the failure the
// 9,000-char slice caused, one order of magnitude up.
//
// What is left to bound here is memory and the size of the text retrieval
// indexes, not a prompt. 120,000 clears any single prep document with room
// to spare and still refuses a pathological upload.
//
// The model never sees this much: selectCoverEvidence sends ~7,000 chars,
// and that selection is ALSO what the grounding guard checks a citation
// against — so a bigger ceiling here does not loosen the guard by a
// character.
// ── THE POOL RETRIEVAL IS ALLOWED TO SEARCH ────────────────────────────
// Raised 120,000 -> 600,000 on 2026-08-23, and the reason is a measured
// failure, not headroom for its own sake.
//
// This cap is applied BEFORE selection and is memoised on the file
// fingerprint, so it is question-independent: it decides, once per upload,
// which half of a document every future question is allowed to see. It cut
// positionally — keep the head, drop the tail — and in a prep dossier the
// tail is where the specialised material lives. On a real 168 KB dossier it
// dropped 49,359 characters including, by name:
//
//   "20.1 Karl Fischer — USP <921> Water Determination"
//   "20.12 LC-MS — upgraded from the previous stub"
//   "20.5 Conductivity and pharmaceutical water"
//   ...and 25 more instrument sections
//
// Measured consequence: "Have you qualified a Karl Fischer titrator?" was
// refused by the grounding guard at EVERY evidence budget from 2,500 to
// 9,000 chars — not because the slice was too small, but because the
// section had been discarded before retrieval ran. No amount of tuning the
// downstream budget can recover a passage that is not in the pool.
//
// The cap is not protecting a shared server: services/ is RENDERER code, so
// this runs on the user's own machine over their own documents, and the
// BM25 index is memoised per file-set (built once per upload, not per
// question). The bound is kept only so a pathological upload cannot wedge
// the tab.
//
// Retrieval, not position, is what should decide relevance. Its job is to
// find the passage that answers the question; this constant's job is only
// to stop the machine falling over.
export const COVER_SOURCE_MAX_CHARS = 600_000;

// ── WHAT ONE QUESTION IS ANSWERED FROM ──
//
// Measured TTFT for openai/gpt-oss-20b at reasoning_effort 'low':
//
//     4,630 prompt tokens  (≈  9,000 chars of context)   570ms median
//    10,458 prompt tokens  (≈ 33,600 chars of context)   889ms median, p90 1,023ms
//    12,044 prompt tokens  (≈ 39,900 chars, raw)         986ms median, p90 1,376ms
//
// The prewarm has roughly 1,050ms before the auto-send timer fires. At
// 7,000 chars of evidence plus the system prompt the request lands near
// the top row, comfortably inside it — where the whole-document version
// sat on the edge and missed its own window twice in fifteen questions.
export const COVER_EVIDENCE_CHARS = 7_000;

// ── The budget is measurable, not just declared ─────────────────────────
// This number trades two things against each other and you cannot see the
// trade from the code: a bigger slice carries more of the candidate's
// material (accuracy), and a bigger prompt is slower to answer, which is
// paid out of the ~1,050ms the cover has before the question is sent
// (availability). Picking it by reasoning is how it ended up at a value
// that measured 8/12 covers delivered when 3k measured 12/12.
//
// So the benchmark sweeps it. Production always reads the constant —
// the override is null unless a bench sets it, and nothing in the app
// ever calls the setter.
let _budgetOverride: number | null = null;
export function _setCoverEvidenceBudget(n: number | null): void { _budgetOverride = n; }
export function coverEvidenceBudget(): number { return _budgetOverride ?? COVER_EVIDENCE_CHARS; }

// Below this there is nothing to select: an ordinary résumé is 5-7K and
// the model reads all of it. Selection is for knowledge bases big enough
// that ATTENTION is the scarce resource, which is where it was measured.
export const COVER_SELECT_FROM = 9_000;

// ── THE OPENING BLOCK ALWAYS TRAVELS ──
//
// Retrieval answers "which passages match this question". It does not
// answer "who is this person", and on a topical question nothing in the
// header scores at all — so without this the model can be handed three
// paragraphs about lyophilisation and no name, employer or current role.
//
// The first block of the first document is where every document format
// puts that: a résumé header, a prep document's identity section.
const LEAD_CHARS = 900;

// ── …BUT A HEADING IS NOT AN IDENTITY ──────────────────────────────────
//
// The block travels on EVERY question, so whatever is in it is what the
// model believes about this person all day. Measured on a real 166 KB prep
// dossier, the first 900 characters were:
//
//   # DEEP KNOWLEDGE — CQV Lead (Laboratory Instruments) @ Eli Lilly
//   ### Panel-round preparation dossier for Venu Pentala
//   **Compiled:** … **Source inputs:** `Venu_Resume.docx` …
//   # PART 0 — SOURCE DOCUMENTS (VERBATIM)
//   ## 0.A — RESUME: `Venu_Resume.docx` (full text)
//
// — document scaffolding, and one line naming the company the candidate is
// INTERVIEWING WITH. Their actual résumé header began at character 901 and
// never travelled. The cover then said, live, "I worked at Eli Lilly as CQV
// Lead for laboratory instruments" — to a Lilly panel. Telling the model in
// the system prompt not to do that did not hold: the fabrication came back
// as soon as the rule was shortened, because the evidence in front of it
// still said Lilly and the prompt was arguing with the evidence.
//
// So the fix is on the evidence. Heading lines are STRUCTURE — a title, a
// section number, a "PART 0" — not facts about a person, and a title is the
// one place a document names what it is ABOUT rather than who it is BY.
// Dropping them lets the lead reach the identity that follows.
//
// Scale-free and format-free: an ordinary .docx résumé carries no markdown
// headings at all, so for the common case by a wide margin this changes
// nothing. It only bites on documents that have chapters — which are
// exactly the documents written about a target role.
function stripScaffolding(text: string): string {
  const kept = String(text || '')
    .split('\n')
    .filter((ln) => !/^\s{0,3}#{1,6}\s/.test(ln))   // markdown headings
    .filter((ln) => !/^\s*-{3,}\s*$/.test(ln))       // horizontal rules
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // If a document is nothing BUT headings, fall back to the raw text rather
  // than travelling with nothing — imperfect evidence beats none.
  return kept || String(text || '');
}

function identityLead(text: string): string {
  return stripScaffolding(text).slice(0, LEAD_CHARS);
}

/**
 * Split on Markdown headings, keeping each heading with its body.
 *
 * A document with no headings — the ordinary .docx résumé, the common case
 * by a wide margin — comes back as ONE section and passes through
 * untouched.
 */
function sectionsOf(text: string): string[] {
  const parts = text.split(/\n(?=\s{0,3}#{1,6}\s)/);
  return parts.length > 1 ? parts : [text];
}

/** Heading line of a section, or '' when the block has none. */
function headingOf(section: string): string {
  const first = section.split('\n', 1)[0] || '';
  return /^\s{0,3}#{1,6}\s/.test(first) ? first : '';
}

export interface CoverSourcePart { name: string; text: string; }

export interface CoverSourceBuild {
  /** Everything the candidate uploaded that is about the candidate. */
  text: string;
  /** The same, per document — what retrieval indexes, so labels survive. */
  parts: CoverSourcePart[];
  /** Human-readable, for the log. Never silently truncate — see below. */
  dropped: string[];
  truncatedChars: number;
}

/**
 * The candidate's own documents, verbatim, plus what had to be left out.
 *
 * ⚠️ NO SILENT CAPS. Both an excluded file and a truncation are reported,
 * because "the cover did not know that" is indistinguishable from "the
 * cover ignored that" once it reaches a user, and this codebase has lost
 * hours to exactly that shape twice (OPENER_MAX_CHARS at 400, and the
 * 1,200-char cap that cut off every employer).
 */
export function buildCoverSourceDetailed(contextFiles: ContextFile[]): CoverSourceBuild {
  const dropped: string[] = [];
  const empty: CoverSourceBuild = { text: '', parts: [], dropped, truncatedChars: 0 };
  if (!contextFiles || contextFiles.length === 0) return empty;

  // ── THE ONE EXCLUSION, AND IT IS NOT ABOUT CONTENT ──
  //
  // A job posting describes the company on the OTHER side of the table.
  // Read as the candidate's history it produces the Halo Pharma failure —
  // the app once spoke a hiring company's own overview back to them as the
  // candidate's own career. This is the whole correctness condition here
  // and it predates this module.
  //
  // isJobDescription now judges by MARKER DENSITY rather than by markers
  // present in the first 3,000 characters, which is what lets a prep
  // document that OPENS by quoting the posting survive. See
  // looksLikeJobPosting in factLedger for the measurement.
  const usable = contextFiles.filter((f) => {
    if (f.base64 || !(f.content || '').trim()) return false;
    if (isJobDescription(f)) { dropped.push(f.name + ': job posting'); return false; }
    return true;
  });

  // Deterministic order: a named résumé first, then the longest. Stable
  // ordering matters for the lead block above.
  const ordered = [...usable].sort((a, b) => {
    const ra = /resume|cv|c\.v\./i.test(a.name || '') ? 0 : 1;
    const rb = /resume|cv|c\.v\./i.test(b.name || '') ? 0 : 1;
    return ra !== rb ? ra - rb : (b.content || '').length - (a.content || '').length;
  });

  const parts: CoverSourcePart[] = ordered.map(f => ({
    name: f.name || 'document',
    text: (f.content || '').trim(),
  }));

  const joined = parts.map(p => '===== ' + p.name + ' =====\n' + p.text).join('\n\n');
  if (joined.length <= COVER_SOURCE_MAX_CHARS) {
    return { text: joined, parts, dropped, truncatedChars: 0 };
  }

  // Over budget. Cut at a section boundary rather than mid-sentence, and
  // NAME WHAT WENT: truncation takes the TAIL, and in a prep document the
  // tail is the Q&A — the section that says "Do not claim:". Losing that
  // silently is the same defect as the 9,000-char cut, at a larger number.
  const cut = joined.slice(0, COVER_SOURCE_MAX_CHARS);
  const lastBreak = cut.lastIndexOf('\n#');
  const text = lastBreak > COVER_SOURCE_MAX_CHARS * 0.6 ? cut.slice(0, lastBreak) : cut;
  for (const s of sectionsOf(joined.slice(text.length))) {
    const h = headingOf(s.trim());
    if (h) dropped.push('OVER BUDGET, not sent: "' + h.replace(/^#+\s*/, '').slice(0, 50) + '"');
  }
  let acc = 0;
  const keptParts: CoverSourcePart[] = [];
  for (const p of parts) {
    const block = '===== ' + p.name + ' =====\n' + p.text;
    if (acc >= text.length) break;
    keptParts.push(acc + block.length <= text.length
      ? p
      : { name: p.name, text: p.text.slice(0, text.length - acc) });
    acc += block.length + 2;
  }
  return { text, parts: keptParts, dropped, truncatedChars: joined.length - text.length };
}

// ── Memo. The build only changes when the FILES change, which happens at
// upload time, not at question time. The SELECTION changes per question
// and is deliberately not memoised — it is a BM25 pass over an index the
// retrieval module already caches, measured well under a millisecond.
let fp = '';
let built: CoverSourceBuild = { text: '', parts: [], dropped: [], truncatedChars: 0 };
let derivations = 0;

function fingerprint(contextFiles: ContextFile[]): string {
  let h = 0;
  let chars = 0;
  for (const f of contextFiles) {
    if (f.base64) continue;
    const s = f.name + ':' + (f.content || '').length;
    chars += (f.content || '').length;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  }
  return contextFiles.length + ':' + chars + ':' + h.toString(36);
}

/** Everything the cover is allowed to know, unselected. */
export function buildCoverSource(contextFiles: ContextFile[]): string {
  const f = fingerprint(contextFiles);
  if (f !== fp) {
    fp = f;
    built = buildCoverSourceDetailed(contextFiles);
    derivations++;
    if (built.dropped.length || built.truncatedChars) {
      console.log(
        '[cover-source] ' + built.text.length + ' chars'
        + (built.dropped.length ? ' | excluded ' + built.dropped.length + ': ' + built.dropped.join('; ') : '')
        + (built.truncatedChars ? ' | TRUNCATED ' + built.truncatedChars + ' chars over the ' + COVER_SOURCE_MAX_CHARS + ' budget' : '')
      );
    }
  }
  return built.text;
}

/**
 * The passages of the candidate's own documents that bear on THIS
 * question, verbatim, with the identity block in front.
 *
 * This is what goes on the wire as `coverContext`, and it is also what the
 * server checks a cover's citation against — so a passage that was not
 * selected is a passage the cover may not speak from. That is the point:
 * the model answers from evidence it was shown, not from a document it was
 * waved at.
 */
export function selectCoverEvidence(contextFiles: ContextFile[], question: string): string {
  const whole = buildCoverSource(contextFiles);
  if (!whole) return '';
  if (whole.length <= COVER_SELECT_FROM) return whole;

  const lead = built.parts.length ? identityLead(built.parts[0].text) : '';
  const q = String(question || '').trim();
  let evidence = '';
  try {
    // Indexed over the FILTERED text, not the raw uploads — a posting that
    // buildCoverSourceDetailed excluded must not come back through
    // retrieval. Synthetic ids keep kbRetrieval's own index memo stable.
    evidence = retrieveEvidence(
      q || (built.parts[0] ? built.parts[0].name : ''),
      built.parts.map((p, i) => (
        { id: 'cover-' + i, name: p.name, type: 'custom', content: p.text } as ContextFile
      )),
      Math.max(1_000, coverEvidenceBudget() - lead.length),
    );
  } catch {
    // Retrieval is an optimisation, never a gate. If it throws, the model
    // gets the head of the document rather than nothing.
    evidence = coverEvidenceBudget() >= whole.length ? whole : whole.slice(0, coverEvidenceBudget());
  }
  if (!evidence) evidence = whole.slice(0, coverEvidenceBudget());

  // ── A QUESTION WITH NOTHING TO MATCH ON STILL DESERVES THE BUDGET ──
  //
  // "Tell me about yourself" is every interview's first question and every
  // one of its words is a stopword, so BM25 scores every passage at zero
  // and retrieval returns ONE opening chunk. Measured on the fill/finish
  // document: 631 characters, against a 7,000-character budget, for the
  // single question where the model most needs the whole career in front
  // of it.
  //
  // Ranking said nothing here, so document order decides instead — which
  // is the right default, because a document leads with what matters.
  if (evidence.length < coverEvidenceBudget() * 0.6) {
    const room = coverEvidenceBudget() - evidence.length;
    // ⚠️ STRIPPED, for the same reason the lead is.
    //
    // This fallback fires exactly when ranking said nothing — "tell me about
    // yourself", every word a stopword — and it takes the HEAD of the
    // document. In a prep dossier the head is the title, and the title names
    // the company being interviewed WITH. Measured: at a 9,000-char budget
    // this path produced "I worked at Eli Lilly as CQV Lead" on the opening
    // question of the interview, to that company's own panel, while the
    // candidate's real employers (Evonik, Cook MyoSite, MSN, Sciegen) sat
    // further down the same document.
    //
    // Fixing the lead alone was not enough because this is a SECOND door to
    // the same bytes. Headings are structure, not evidence, on both paths.
    const head = stripScaffolding(whole).slice(0, room);
    if (!evidence || head.indexOf(evidence.slice(0, 120)) !== -1) evidence = head;
    else evidence = `${head}\n\n${evidence}`;
  }

  if (!lead) return evidence;
  // The lead is usually also the top-ranked passage on an identity
  // question; sending it twice wastes budget and reads oddly.
  if (evidence.indexOf(lead.slice(0, 120)) !== -1) return evidence;
  return lead + '\n\n' + evidence;
}

/** New conversation: the previous upload's documents must leave memory. */
export function resetCoverSource(): void {
  fp = '';
  built = { text: '', parts: [], dropped: [], truncatedChars: 0 };
}

/** Test seam — how many times the source was actually re-derived. */
export function _coverSourceDerivations(): number { return derivations; }
