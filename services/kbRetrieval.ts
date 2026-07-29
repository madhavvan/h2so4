// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  KB RETRIEVAL — send only the RELEVANT slice of the knowledge base
//
//  The cost problem: the old prompt builders dumped the ENTIRE uploaded
//  KB (resume + JD + up to ~100 notes files ≈ 100K tokens) into the
//  system prompt of EVERY question. Provider caching only DISCOUNTS
//  those tokens — you still pay to ship ~100K of them per turn. With
//  many files that is real money per answer.
//
//  The fix: the identity card already DISTILLS the whole resume into
//  ~2K tokens. So for a large KB we send the card plus only the top-K
//  passages relevant to THIS question — retrieved with BM25, which is
//  lexical, client-side, and completely free (no embedding API). Interview
//  KBs are keyword-dense (tools, companies, projects, versions), so BM25
//  is a strong fit. Result: a 200-file KB costs the same per question as a
//  1-file KB — only the handful of relevant chunks are ever sent.
//
//  Adaptive: below RETRIEVAL_MIN_CHARS the whole KB is small enough to
//  send in full (cheapest AND best quality), so retrieval only kicks in
//  once the KB is genuinely large.
//
//  Everything here is pure, synchronous, and cached by KB fingerprint —
//  chunking a 400K KB + one retrieval is ~a few ms, off the network path.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { ContextFile } from '../types';

// Below this total KB size, skip retrieval and send the whole thing — it's
// already cheap (~5K tokens) and full context gives the best answer. Only
// larger KBs (many files) pay the per-question dump we want to avoid.
export const RETRIEVAL_MIN_CHARS = 20_000;
// Char budget for the retrieved evidence block. ~7K chars ≈ 1.7K tokens —
// enough for 8-10 focused passages, tiny next to a 100K-token full dump.
export const RETRIEVAL_CHAR_BUDGET = 7_000;
// How much of that budget pure relevance may claim before coverage gets a
// turn. The remainder is not wasted — anything coverage does not need is
// spent on the next-best passages anyway (pass 3), so on a question about
// one thing this changes nothing at all.
const COVERAGE_RESERVE_FROM = 0.75;
// Target passage size. Small enough for precision, large enough to carry a
// self-contained fact (a bullet, a project blurb, a paragraph).
const CHUNK_CHARS = 700;
const CHUNK_OVERLAP = 120;

// BM25 params (standard defaults).
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we',
  'they', 'my', 'your', 'our', 'their', 'me', 'him', 'her', 'us', 'them', 'do',
  'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'what', 'which', 'who', 'how', 'when', 'where', 'why', 'about', 'so', 'if',
  'then', 'than', 'into', 'out', 'up', 'down', 'over', 'about', 'tell', 'me',
]);

function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = String(text || '').toLowerCase().split(/[^a-z0-9+#.]+/);
  for (let w of raw) {
    // Trim trailing dots that aren't part of a version (e.g. "kafka." → "kafka",
    // but keep "3.13" and "node.js").
    w = w.replace(/^\.+|\.+$/g, '');
    if (w.length < 2 || w.length > 40) continue;
    if (STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

interface Chunk {
  text: string;
  source: string;      // file name (for the [from X] tag)
  tf: Map<string, number>;
  len: number;         // token count
}

interface KbIndex {
  chunks: Chunk[];
  df: Map<string, number>;   // document frequency per term
  avgdl: number;             // average chunk length in tokens
  n: number;                 // number of chunks
  totalChars: number;
}

// Split one file's text into overlapping passages on natural boundaries.
function splitIntoPassages(text: string): string[] {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= CHUNK_CHARS) return [t];

  const passages: string[] = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + CHUNK_CHARS, t.length);
    if (end < t.length) {
      // Prefer to break on a paragraph, then newline, then sentence, then space,
      // searching backward within the last ~40% of the window.
      const windowStart = i + Math.floor(CHUNK_CHARS * 0.6);
      const candidates = [
        t.lastIndexOf('\n\n', end),
        t.lastIndexOf('\n', end),
        t.lastIndexOf('. ', end),
        t.lastIndexOf(' ', end),
      ];
      for (const c of candidates) {
        if (c > windowStart) { end = c + 1; break; }
      }
    }
    const piece = t.slice(i, end).trim();
    if (piece) passages.push(piece);
    if (end >= t.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return passages;
}

function buildIndex(contextFiles: ContextFile[]): KbIndex {
  const chunks: Chunk[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  let totalChars = 0;

  for (const f of contextFiles) {
    if (f.base64) continue; // binary/image — not text-retrievable
    const content = f.content || '';
    if (!content.trim()) continue;
    totalChars += content.length;
    const source = f.name || (f.type ? f.type.toUpperCase() : 'source');
    for (const passage of splitIntoPassages(content)) {
      const tokens = tokenize(passage);
      if (tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
      for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
      chunks.push({ text: passage, source, tf, len: tokens.length });
      totalLen += tokens.length;
    }
  }

  return {
    chunks,
    df,
    avgdl: chunks.length ? totalLen / chunks.length : 0,
    n: chunks.length,
    totalChars,
  };
}

// ── Index cache, keyed by a cheap fingerprint of the KB text ──
// Chunking is O(KB size); we only redo it when the files actually change.
function fingerprint(contextFiles: ContextFile[]): string {
  let h = 0;
  let chars = 0;
  for (const f of contextFiles) {
    if (f.base64) continue;
    const s = `${f.name}:${(f.content || '').length}`;
    chars += (f.content || '').length;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  }
  return `${chars}:${h.toString(36)}`;
}

let cachedFp = '';
let cachedIndex: KbIndex | null = null;
// How many times the index has actually been BUILT. The readiness contract
// ("after prewarm, question one does no build work") used to be checked by
// timing retrieveEvidence against a 15ms bound — but a warm retrieval is
// ~0.6ms while its FIRST call in a fresh process is ~4ms (V8 compiling the
// scorer and the sort comparator), so the bound had only ~3x headroom and
// tripped under parallel test load. This counter lets the test assert the
// actual claim — zero rebuilds — instead of a symptom of it.
let indexBuilds = 0;

function getIndex(contextFiles: ContextFile[]): KbIndex {
  const fp = fingerprint(contextFiles);
  if (fp === cachedFp && cachedIndex) return cachedIndex;
  cachedIndex = buildIndex(contextFiles);
  cachedFp = fp;
  indexBuilds++;
  return cachedIndex;
}

// Test/diagnostic: total index builds this process. Reading it never
// touches the cache, so a test can bracket a call with it safely.
export function _indexBuildCount(): number { return indexBuilds; }

function idf(index: KbIndex, term: string): number {
  const nT = index.df.get(term) || 0;
  // BM25 IDF with +1 to stay non-negative for common terms.
  return Math.log(1 + (index.n - nT + 0.5) / (nT + 0.5));
}

function scoreChunk(index: KbIndex, chunk: Chunk, queryTerms: string[]): number {
  let score = 0;
  for (const term of queryTerms) {
    const f = chunk.tf.get(term);
    if (!f) continue;
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (chunk.len / (index.avgdl || 1)));
    score += idf(index, term) * ((f * (BM25_K1 + 1)) / denom);
  }
  return score;
}

// Build the index NOW, at upload time, instead of inside the first
// question's retrieval call.
//
// "Immediately after uploading, everything should be ready to serve" is
// the actual product promise here, and the index was the one part of it
// still being built lazily — on the critical path of question one, the
// question the user is most impatient about. Measured cold-build cost:
// 4ms at 21 files, 21ms at 201, 71ms at 801. Small, but it is 71ms spent
// in the worst possible place, and it is free to spend it while the user
// is still reading their upload list.
//
// Idempotent and fingerprint-cached: calling it repeatedly during a
// multi-file upload rebuilds only when the files actually changed.
export function warmIndex(contextFiles: ContextFile[]): void {
  if (!contextFiles || contextFiles.length === 0) return;
  try { getIndex(contextFiles); } catch { /* fail open — retrieval rebuilds */ }
}

// Total text length of the (non-binary) KB, for the adaptive threshold.
export function kbTextLength(contextFiles: ContextFile[]): number {
  let n = 0;
  for (const f of contextFiles) if (!f.base64) n += (f.content || '').length;
  return n;
}

// Retrieve the passages most relevant to `query` (optionally augmented with
// recent conversation text for short follow-ups), formatted as an evidence
// block. Returns '' if there's nothing text-retrievable. Deterministic and
// fast; safe to call on every question.
export function retrieveEvidence(
  query: string,
  contextFiles: ContextFile[],
  budgetChars: number = RETRIEVAL_CHAR_BUDGET,
): string {
  const index = getIndex(contextFiles);
  if (index.n === 0) return '';

  const queryTerms = tokenize(query);
  // If the query has no usable terms (e.g. "and then?"), fall back to the
  // opening chunks of each source so the model still has an anchor.
  const scored = index.chunks
    .map((c, i) => ({ c, i, s: queryTerms.length ? scoreChunk(index, c, queryTerms) : 0 }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i));

  const picked: Chunk[] = [];
  const taken = new Set<number>();
  let used = 0;

  const take = (c: Chunk, i: number) => {
    if (taken.has(i)) return false;
    if (used + c.text.length > budgetChars && picked.length > 0) return false;
    taken.add(i);
    picked.push(c);
    used += c.text.length;
    return true;
  };

  // ── Pass 1: the best passages, but not the whole budget ──
  //
  // Top-N by score alone has a failure mode worth spending a few lines
  // on. Ask "design an exactly-once Kafka to Snowflake pipeline" against
  // a knowledge base of per-technology notes, and every Kafka chunk
  // outscores every Snowflake chunk — so the budget fills with Kafka and
  // the model never sees that this candidate has touched Snowflake at
  // all. The answer is then confident, relevant, and silent about half
  // of what was asked.
  //
  // Measured: with topic-siloed notes the Snowflake evidence disappeared
  // entirely; with mixed-topic notes it did not. Real knowledge bases are
  // both shapes — a folder of per-tool notes is an ordinary thing to have
  // — so the budget is capped here and the remainder used to guarantee
  // each named system gets a look-in.
  const primaryBudget = Math.floor(budgetChars * COVERAGE_RESERVE_FROM);
  for (const { c, i, s } of scored) {
    if (picked.length > 0 && s <= 0) break;   // nothing relevant left
    if (used >= primaryBudget) break;
    take(c, i);
  }

  // ── Pass 2: one passage per query term nobody covered ──
  //
  // Rarest terms first: "snowflake" is far more informative about what to
  // retrieve than "pipeline", and if the budget runs out mid-pass it
  // should run out on the vague words.
  if (queryTerms.length > 1) {
    const covered = (term: string) => picked.some(c => c.tf.has(term));
    const informative = [...new Set(queryTerms)]
      .filter(t => (index.df.get(t) || 0) > 0)
      .sort((a, b) => idf(index, b) - idf(index, a));
    for (const term of informative) {
      if (used >= budgetChars) break;
      if (covered(term)) continue;
      const best = scored.find(({ c, i, s }) => s > 0 && !taken.has(i) && c.tf.has(term));
      if (best) take(best.c, best.i);
    }
  }

  // ── Pass 3: spend whatever is left on the next-best passages ──
  for (const { c, i, s } of scored) {
    if (used >= budgetChars) break;
    if (picked.length > 0 && s <= 0) break;
    take(c, i);
  }

  if (picked.length === 0) picked.push(index.chunks[0]);

  return picked
    .map(c => `[from ${c.source}]\n${c.text}`)
    .join('\n\n');
}

// Test/diagnostic: how many chunks a KB produces and its index size.
export function _retrievalStats(contextFiles: ContextFile[]) {
  const index = getIndex(contextFiles);
  return { chunks: index.n, avgTokens: Math.round(index.avgdl), terms: index.df.size, totalChars: index.totalChars };
}
