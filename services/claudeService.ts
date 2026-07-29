// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CLAUDE SERVICE — Self-contained Anthropic Sonnet 5 module
//
//  Sibling of aiProxyService.ts but Claude-only. Imports shared
//  HTTP plumbing + persona builders from aiProxyService.ts; owns
//  everything that's Claude-specific:
//    • WEB SEARCH instructions in the system prompt — without
//      these the candidate-persona framing makes Claude refuse
//      to invoke its hosted web_search tool ("real candidates
//      don't Google during interviews"), and you get cutoff-
//      bound dumb answers instead of fresh ones.
//    • Identity extraction via /chat/claude — so Claude doesn't
//      depend on OpenAI being configured to get its briefing
//      cards. Separate cache from the OpenAI-extraction one in
//      aiProxyService.ts so the two can diverge in style without
//      cross-contaminating.
//    • buildClaudeMessages — Anthropic's image content shape is
//      { type: 'image', source: { type: 'base64', media_type, data } },
//      not OpenAI's image_url shape. Live here, not in App.tsx.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { Message, ContextFile } from '../types';
import {
  proxyRequest,
  proxyStream,
  splitResumeAndJd,
  hashContextFiles,
  buildExtractionPrompt,
  buildUserRulesBlock,
  buildSystemInstruction,
  buildSystemInstructionNew,
  buildAutoSolveSystemInstruction,
  assembleEvidence,
  buildCoverContext,
  SUBSTANCE_PREPEND,
  type ExtractedCards,
  type OnToken,
} from './aiProxyService';
import {
  readTechStateCache,
  writeTechStateCache,
  hasTechStateCache,
} from './techStateCache';

// ─────────────────────────────────────────────────────────────
//  WEB SEARCH — silent prep, invisible to the interviewer
//
//  The candidate-persona system prompt is heavy on "you ARE a
//  human, never break character, never sound like an AI". A
//  human candidate doesn't pull out a phone and Google answers
//  during an interview, so Claude — correctly following the
//  persona — refuses to invoke the web_search tool even when it
//  would help. Fix: tell Claude the tool is silent, frame using
//  it as "I've been keeping up with the field" instead of "let
//  me check", and explicitly forbid the give-away phrases.
// ─────────────────────────────────────────────────────────────
const WEB_SEARCH_INSTRUCTIONS = `
=== WEB SEARCH (silent — interviewer never sees it) ===

SEARCH IMMEDIATELY (before drafting your answer) when the question contains ANY of these signals:
- A version question: "what version", "current version", "latest version", "which version", "what's X at now"
- A present-tense anchor: "now", "currently", "today", "right now", "these days", "recently", "as of"
- A price / number / statistic question: "how much does X cost", "how many", "what's the latency / throughput / pricing of"
- A "what's new in X" / "what did X release" / "is X out yet" question
- A current-options comparison: "X vs Y in 2026", "right now what's better", "which is the standard now"

When the question has BOTH past and present parts (e.g. "what version were you using, and what is it now?"):
- Answer the past from your own context (resume / experience).
- SEARCH the present part — do not guess. Do not hedge with "I think" on a current version.
- Stitch into one natural sentence: "Back then we were on X. Right now it's around Y."

DO NOT search for:
- Behavioral questions ("tell me about a time")
- Pure conceptual fundamentals (theory, definitions, big-O, CAP)
- Questions about your own resume / past projects (answer from context)
- Pure design / architecture questions ("how would you design X")
- Opinions on approaches you have lived experience with

MAXIMUM 1 search per question. After one search call, commit to the answer.

Weave findings naturally — never narrate the search:
- "Right now it's around v3.5, give or take a patch"
- "Last I checked, ~$0.20 per million calls"
- "Currently most teams are on X..."

NEVER say: "I searched", "let me check", "according to", "based on the search results", "as of my knowledge cutoff", "I read that".
`;

// ─────────────────────────────────────────────────────────────
//  CLAUDE-ONLY DEPTH + VOICE + ADAPTATION + TIME LAYER
//
//  Claude is positioned as the smartest model in the lineup —
//  Sonnet 5 with web_search, no token budget concerns. The base
//  persona prompt (shared across all 5 providers) gets the candidate
//  framing right but doesn't push for the senior-engineer voice or
//  interview-type adaptation that differentiates Claude's answers
//  from Gemini/Groq/GPT/Grok. This layer adds:
//    • DEPTH & VOICE — opinion-first, war-story-flavored, taste-driven
//    • INTERVIEW-TYPE READING — adapt to behavioral / system-design /
//      coding / domain / leadership questions inferred from history
//    • TIME AWARENESS — answer past-tense questions in their era's
//      stack, not today's. Plus inject TODAY's date so the model
//      knows what "recent" means without guessing from training.
// ─────────────────────────────────────────────────────────────
function buildClaudeDepthLayer(): string {
  const today = new Date().toISOString().split('T')[0];
  return `
=== CLAUDE OVERRIDES ===

Today is ${today}.

ANSWER EVERY input — including "okay", "mm", "right", "got it", "yeah". For acknowledgments, give a brief 1-2 sentence elaboration of the previous turn. NEVER output "..." or "Listening..." — that rule is OFF for Claude only.

If the interviewer anchors to a past time ("back in 2020", "at your last job"), answer in that era's stack — not today's.

HUMAN FILLERS (rare, sparing): About 1 in 6 answers, open with ONE short natural filler before diving into substance: "Hmm,", "Uh,", "Um,", "So,", "Yeah,", "You know,", "Like,", "Right,", "I mean,". Pick ONE and use it sparingly — never twice in a row, never more than the first 1-3 syllables. The default is to start with substance. Fillers are the exception that make you sound human, not the norm.
`;
}

// ─────────────────────────────────────────────────────────────
//  CLAUDE "TRAIN MODEL" — pre-research current tech state
//
//  Runtime web_search adds 3-5s per searched question. Fine for an
//  unprepared assistant; lethal in a live interview where the
//  candidate needs sub-4s answers. The fix: pre-research everything
//  the resume + JD reference UP FRONT via Claude's hosted web_search,
//  cache it (services/techStateCache.ts), and inject into the system
//  prompt of WHATEVER model the user is on — Claude/Gemini/GPT/Grok/
//  Groq all share the same cached card. Pay once via Claude, benefit
//  on every model.
//
//  Cache primitives live in techStateCache.ts so aiProxyService.ts
//  can read them too without a circular dep.
// ─────────────────────────────────────────────────────────────

// ── Where Train Model's Claude calls go ──────────────────────────────
// NOT /chat/claude. That route is the live-answer path: gated Pro+ and
// behind requireActiveSession, i.e. "the interview clock is running".
// Training is the opposite of that on both counts —
//   · it is the Max/Ultra differentiator, so the SERVER has to enforce
//     Max+ (FEATURE_GATES.trainModel is a render gate; it stops honest
//     clients, not a hand-written request), and
//   · it runs BEFORE the interview, which is the entire feature. Routing
//     it through the live-answer gate meant every pre-interview train
//     came back 428 and surfaced as "Couldn't read resume — try again",
//     and the only workaround was starting the clock the user paid for.
// /chat/claude-train is the same Claude handler with requireTier(max,
// ultra) + requireTimeRemaining and no session requirement. See
// server/src/routes/ai.js.
const TRAIN_ENDPOINT = '/chat/claude-train';

// Public: tells the UI whether a session already has a cached tech state.
export function hasCachedTechState(contextFiles: ContextFile[]): boolean {
  if (!contextFiles || contextFiles.length === 0) return false;
  return hasTechStateCache(hashContextFiles(contextFiles));
}

// Stage 1 — pull the 15 most-relevant concrete technologies mentioned in
// resume + JD. No web search; LLM-driven keyword extraction. Capped low
// (15, not 25) because Anthropic rate-limits web_search aggressively when
// you fan out — fewer keywords = fewer 429s + faster wall clock.
async function extractTechKeywords(contextFiles: ContextFile[]): Promise<string[]> {
  const { resume, jd } = splitResumeAndJd(contextFiles);
  if (!resume && !jd) return [];

  const prompt = `Extract the 15 most relevant specific technologies, frameworks, libraries, platforms, databases, cloud services, or DevOps tools mentioned in the RESUME and JOB DESCRIPTION below.

Return ONLY a JSON array of strings. No commentary. No markdown fences. Prioritize tools that appear in BOTH resume and JD — those are the highest-leverage ones for the interview.

Use canonical names (e.g. "PySpark", "PostgreSQL", "Apache Airflow", "AWS Lambda", "Kubernetes"). Do NOT include generic terms like "SQL", "REST API", "Python" alone — only specific named tools/products/frameworks/services.

RESUME:
${resume}

JOB DESCRIPTION:
${jd}

Output ONLY the JSON array of 15 items.`;

  const text = await proxyRequest(TRAIN_ENDPOINT, {
    messages: [{ role: 'user', content: prompt }],
    systemInstruction: undefined,
    enableWebSearch: false,
  });

  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map(s => s.trim())
      .slice(0, 15);
  } catch {
    return [];
  }
}

// Strip Claude's meta-narration leakage. Even with strict prompts, web_search
// answers sometimes prepend "Based on the search results..." / "Let me..." /
// "Here's the factsheet" before the actual line. We hunt for the canonical
// "{tech}:" pattern and take from there, dropping everything before.
function sanitizeResearchLine(tech: string, raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\s+/g, ' ').replace(/\*+/g, '');
  const re = new RegExp(`${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'gi');
  const matches = [...s.matchAll(re)];
  if (matches.length === 0) return `${tech}: ${s}`.slice(0, 800);
  const last = matches[matches.length - 1];
  s = s.slice(last.index!).split(' --- ')[0].trim();
  return s.slice(0, 800);
}

// Sleep helper for retry backoff.
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// COST-CRITICAL: batched research. Sends N technologies in ONE Claude call
// instead of N calls. The dominant cost in v1 was input tokens: each
// web_search returned 5-10 results × ~1K tokens that all landed in Sonnet's
// context. Per-call overhead was ~15K input tokens × 15 calls = ~225K
// input × $3/M = $0.68 per training, plus searches and retries — easily
// $1-2 per click and the user paid $7 across multiple test clicks.
//
// Batching to 5-per-call collapses that to 3 calls × ~17K input ≈ 51K
// total input — 4× cheaper. Search-invocation count also drops from
// 15-45 to 6-9 since one call's tool-uses are shared across 5 techs.
//
// Quality risk: model has to research 5 techs in one response. Sonnet
// handles this fine if we give it explicit JSON schema to fill out.
async function researchBatch(
  techs: string[],
  today: string,
): Promise<Record<string, string>> {
  const numbered = techs.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const techList = techs.map(t => `"${t}"`).join(', ');

  const prompt = `Research the current state of these ${techs.length} technologies as of ${today}:
${numbered}

Use web_search to verify CURRENT facts (latest version, recent releases, pricing, breaking changes). You don't need to search every one — for stable foundational tech where your training data is current, skip the search. Prioritize searches on fast-moving tech (cloud services, AI/ML, container orchestration, modern data formats).

Output ONLY a JSON object keyed by EXACT tech name (one entry per tech listed above). Each value is ONE factsheet sentence — no markdown, no preamble, no "Based on...", no quotes inside the value. Format each value as:

"<tech>: latest stable version is X (date if known). <one notable recent change in last ~12 months>. <pricing or 'pricing n/a'>. Gotcha: <one specific issue experienced engineers hit>."

Required output format (start with { end with }, NO markdown fences, NO other text):

{
  ${techs.map(t => `"${t}": "..."`).join(',\n  ')}
}

Tech names in keys must EXACTLY match: ${techList}.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await proxyRequest(TRAIN_ENDPOINT, {
        messages: [{ role: 'user', content: prompt }],
        systemInstruction: undefined,
        enableWebSearch: true,
      });
      // Find the JSON object — model occasionally wraps in prose despite
      // instructions, so we scan for the largest {...} block.
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        if (attempt === 0) { await sleep(2500); continue; }
        return {};
      }
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // Sanitize each value just in case the model leaked preambles.
          const out: Record<string, string> = {};
          for (const tech of techs) {
            const raw = parsed[tech];
            if (typeof raw === 'string' && raw.trim()) {
              out[tech] = sanitizeResearchLine(tech, raw) || `${tech}: ${raw}`.slice(0, 800);
            }
          }
          return out;
        }
      } catch {
        if (attempt === 0) { await sleep(2500); continue; }
      }
      return {};
    } catch {
      if (attempt === 0) { await sleep(2500); continue; }
      return {};
    }
  }
  return {};
}

// Stage 2 orchestrator — split keywords into batches of 5, run batches with
// concurrency 2 (so 15 keywords = 3 batches = ~2 batches of wall-clock).
const BATCH_SIZE = 5;

async function batchResearch(
  keywords: string[],
  concurrency: number,
  onTick: (done: number, total: number, current: string) => void,
): Promise<string[]> {
  const today = new Date().toISOString().split('T')[0];
  // Split into chunks of BATCH_SIZE
  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += BATCH_SIZE) {
    batches.push(keywords.slice(i, i + BATCH_SIZE));
  }

  const out: string[] = [];
  let nextBatch = 0;
  let completedTechs = 0;

  const worker = async () => {
    while (nextBatch < batches.length) {
      const idx = nextBatch++;
      const batch = batches[idx];
      onTick(completedTechs, keywords.length, batch.join(', '));
      const results = await researchBatch(batch, today);
      // Push each tech result; missing entries (failed batch) are skipped.
      for (const tech of batch) {
        if (results[tech]) out.push(results[tech]);
        completedTechs++;
        onTick(completedTechs, keywords.length, tech);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return out;
}

export interface TrainingProgress {
  stage: 'extracting' | 'researching' | 'finalizing' | 'done' | 'error';
  done: number;
  total: number;
  pct: number;
  current?: string;
  message: string;
}

export interface TrainingResult {
  success: boolean;
  techCount: number;
  cardLength: number;
  cached: boolean;
  message: string;
}

// ─── BEAST MODE (admin-only) ────────────────────────────────
// Standard training is batched-of-5 for cost (~$0.30). Beast mode is
// for admin: individual per-tech research with longer, richer prompts,
// up to 25 keywords, and a final synthesis pass that builds inter-tech
// connections (e.g., "your K8s + Iceberg + Spark experience reads as
// X to a JPMC interviewer"). Cost: ~$3-6 per run. Wall-clock: 3-5min.
async function researchOneTechBeast(tech: string, today: string): Promise<string | null> {
  const prompt = `You are a senior research analyst preparing an interview-ready briefing on ${tech} for a candidate.

Use web_search aggressively (multiple searches if needed) to verify CURRENT facts as of ${today}.

Output a RICH paragraph (3-5 sentences) on ONE line in this exact format — no markdown, no preamble:

${tech}: latest stable version is X (release date if known). <2 sentences on the most important changes in the last 12-18 months — what shipped, what got removed, what changed architecturally>. Pricing: <specific dollar amount or 'open-source / pricing n/a'>. Senior-engineer gotchas: <2 specific operational issues experienced engineers hit in production — be concrete with version numbers, config flags, or failure modes>.

START with "${tech}:" — no other prefix. Output ONLY the paragraph.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await proxyRequest(TRAIN_ENDPOINT, {
        messages: [{ role: 'user', content: prompt }],
        systemInstruction: undefined,
        enableWebSearch: true,
      });
      const cleaned = sanitizeResearchLine(tech, text);
      if (!cleaned || /research failed/i.test(cleaned)) {
        if (attempt === 0) { await sleep(3000); continue; }
        return null;
      }
      // Beast factsheets can be longer — bump cap to 1500 chars.
      return cleaned.slice(0, 1500);
    } catch {
      if (attempt === 0) { await sleep(3000); continue; }
      return null;
    }
  }
  return null;
}

// Beast mode: extract up to 25 keywords (vs 15 standard).
async function extractTechKeywordsBeast(contextFiles: ContextFile[]): Promise<string[]> {
  const { resume, jd } = splitResumeAndJd(contextFiles);
  if (!resume && !jd) return [];

  const prompt = `Extract the 25 most relevant specific technologies, frameworks, libraries, platforms, databases, cloud services, or DevOps tools mentioned in the RESUME and JOB DESCRIPTION below.

Return ONLY a JSON array of strings. No commentary. No markdown fences. Prioritize tools that appear in BOTH resume and JD, then tools that are recently moving / interview-popular (cloud-native, AI/ML, data platforms).

Use canonical names (e.g. "PySpark", "PostgreSQL", "Apache Airflow", "AWS Lambda", "Kubernetes"). Skip generic terms ("SQL", "REST API") — only specific named tools/products/frameworks/services.

RESUME:
${resume}

JOB DESCRIPTION:
${jd}

Output ONLY the JSON array of up to 25 items.`;

  const text = await proxyRequest(TRAIN_ENDPOINT, {
    messages: [{ role: 'user', content: prompt }],
    systemInstruction: undefined,
    enableWebSearch: false,
  });

  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map(s => s.trim())
      .slice(0, 25);
  } catch {
    return [];
  }
}

// Synthesis pass — takes all factsheets and asks Claude to build
// connections / interview-relevant patterns the candidate should know.
// One extra call, adds ~$0.30, but produces the "this is how your
// stack reads to an interviewer" framing that makes beast mode beastly.
async function synthesizeTechConnections(
  factsheets: string[],
  contextFiles: ContextFile[],
): Promise<string> {
  const { jd } = splitResumeAndJd(contextFiles);
  const techList = factsheets.map(f => f.split(':')[0]).join(', ');

  const prompt = `Below are current-state factsheets on the technologies in a senior data/software engineer's resume. Read them, then write a short SYNTHESIS section (4-6 sentences, ONE paragraph) that an interview prep coach would tell this candidate:

1. Which 2-3 technologies are the strongest interview leverage given the role they're targeting?
2. What's a concrete cross-tech pattern this candidate's experience demonstrates? (e.g., "they've done CDC + lakehouse + orchestration end-to-end").
3. What interview question should they expect to come up that pulls multiple of these together?

JOB DESCRIPTION (for targeting):
${jd || '(not provided)'}

FACTSHEETS:
${factsheets.join('\n')}

Output ONE paragraph starting with "INTERVIEW LEVERAGE:" — no markdown, no preamble.`;

  try {
    const text = await proxyRequest(TRAIN_ENDPOINT, {
      messages: [{ role: 'user', content: prompt }],
      systemInstruction: undefined,
      enableWebSearch: false,
    });
    return text.trim().replace(/\*+/g, '').slice(0, 1500);
  } catch {
    return '';
  }
}

export async function trainClaudeModelBeast(
  contextFiles: ContextFile[],
  onProgress: (p: TrainingProgress) => void,
): Promise<TrainingResult> {
  if (!contextFiles || contextFiles.length === 0) {
    onProgress({ stage: 'error', done: 0, total: 0, pct: 0, message: 'No context files attached' });
    return { success: false, techCount: 0, cardLength: 0, cached: false, message: 'No context files' };
  }

  const hash = hashContextFiles(contextFiles);

  // Stage 1: extract up to 25 keywords
  onProgress({ stage: 'extracting', done: 0, total: 100, pct: 3, message: 'Beast mode — reading resume + JD...' });
  let keywords: string[];
  try {
    keywords = await extractTechKeywordsBeast(contextFiles);
  } catch (e: any) {
    onProgress({ stage: 'error', done: 0, total: 0, pct: 0, message: 'Couldn\'t read resume — try again' });
    return { success: false, techCount: 0, cardLength: 0, cached: false, message: e?.message || 'Extraction failed' };
  }

  if (keywords.length === 0) {
    onProgress({ stage: 'error', done: 0, total: 0, pct: 0, message: 'No technologies detected.' });
    return { success: false, techCount: 0, cardLength: 0, cached: false, message: 'No tech keywords' };
  }

  onProgress({
    stage: 'researching',
    done: 0,
    total: keywords.length,
    pct: 8,
    message: `Found ${keywords.length} technologies — deep-researching each one...`,
  });

  // Stage 2: individual per-tech research with concurrency 3
  const today = new Date().toISOString().split('T')[0];
  const results: string[] = [];
  let nextIdx = 0;
  let done = 0;

  const worker = async () => {
    while (nextIdx < keywords.length) {
      const idx = nextIdx++;
      const tech = keywords[idx];
      onProgress({
        stage: 'researching',
        done,
        total: keywords.length,
        pct: 8 + Math.round((done / keywords.length) * 80),
        current: tech,
        message: `${done}/${keywords.length} — ${tech}`,
      });
      const card = await researchOneTechBeast(tech, today);
      if (card) results.push(card);
      done++;
      onProgress({
        stage: 'researching',
        done,
        total: keywords.length,
        pct: 8 + Math.round((done / keywords.length) * 80),
        current: tech,
        message: `${done}/${keywords.length} — ${tech}`,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(3, keywords.length) }, worker));

  // Stage 3: synthesis pass
  onProgress({
    stage: 'finalizing',
    done: keywords.length,
    total: keywords.length,
    pct: 92,
    message: 'Synthesizing interview leverage...',
  });
  const synthesis = await synthesizeTechConnections(results, contextFiles);

  // Stage 4: assemble + cache
  onProgress({ stage: 'finalizing', done: keywords.length, total: keywords.length, pct: 98, message: 'Caching...' });

  const card = `=== CURRENT TECH STATE — BEAST EDITION (researched ${today}) ===
Deep, web-researched intel on every technology in your resume + JD with rich version detail, recent changes, pricing, and senior-engineer gotchas. Use these CURRENT facts when answering — they override your training data. Stay silent about HOW you know — these are things you've "been keeping up with".

${results.join('\n\n')}

${synthesis ? `\n=== INTERVIEW LEVERAGE (silent — shape answers toward this) ===\n${synthesis}\n` : ''}`;

  writeTechStateCache(hash, card, results.length);

  onProgress({
    stage: 'done',
    done: keywords.length,
    total: keywords.length,
    pct: 100,
    message: `Beast trained on ${results.length} technologies — interview-grade ready`,
  });

  return {
    success: true,
    techCount: results.length,
    cardLength: card.length,
    cached: true,
    message: `Beast trained on ${results.length} technologies`,
  };
}

// Public entry point — runs the full STANDARD training pipeline end-to-end.
export async function trainClaudeModel(
  contextFiles: ContextFile[],
  onProgress: (p: TrainingProgress) => void,
): Promise<TrainingResult> {
  if (!contextFiles || contextFiles.length === 0) {
    onProgress({ stage: 'error', done: 0, total: 0, pct: 0, message: 'No context files attached' });
    return { success: false, techCount: 0, cardLength: 0, cached: false, message: 'No context files' };
  }

  const hash = hashContextFiles(contextFiles);

  onProgress({ stage: 'extracting', done: 0, total: 100, pct: 5, message: 'Reading resume + JD...' });
  let keywords: string[];
  try {
    keywords = await extractTechKeywords(contextFiles);
  } catch (e: any) {
    onProgress({ stage: 'error', done: 0, total: 0, pct: 0, message: 'Couldn\'t read resume — try again' });
    return { success: false, techCount: 0, cardLength: 0, cached: false, message: e?.message || 'Extraction failed' };
  }

  if (keywords.length === 0) {
    onProgress({ stage: 'error', done: 0, total: 0, pct: 0, message: 'No technologies detected. Add a richer resume.' });
    return { success: false, techCount: 0, cardLength: 0, cached: false, message: 'No tech keywords' };
  }

  onProgress({
    stage: 'researching',
    done: 0,
    total: keywords.length,
    pct: 10,
    message: `Found ${keywords.length} technologies — researching...`,
  });

  const cards = await batchResearch(keywords, 2, (done, total, current) => {
    const pct = 10 + Math.round((done / total) * 85);
    onProgress({
      stage: 'researching',
      done,
      total,
      pct,
      current,
      message: `${done}/${total} — ${current}`,
    });
  });

  onProgress({
    stage: 'finalizing',
    done: keywords.length,
    total: keywords.length,
    pct: 97,
    message: 'Caching...',
  });

  const today = new Date().toISOString().split('T')[0];
  const card = `=== CURRENT TECH STATE (researched ${today}) ===
Fresh, web-researched intel on the technologies in your resume + JD. Use these CURRENT facts when answering — they override your training data. Stay silent about how you know — these are things you've "been keeping up with".

${cards.join('\n')}`;

  writeTechStateCache(hash, card, cards.length);

  onProgress({
    stage: 'done',
    done: keywords.length,
    total: keywords.length,
    pct: 100,
    message: `Trained on ${cards.length} technologies — interview-ready`,
  });

  return {
    success: true,
    techCount: cards.length,
    cardLength: card.length,
    cached: true,
    message: `Trained on ${cards.length} technologies`,
  };
}

// ─────────────────────────────────────────────────────────────
//  CLAUDE-AUGMENTED PROMPT BUILDERS
//
//  Wrap the shared OLD/NEW system-prompt builders to inject the
//  cached tech state (if any) + WEB SEARCH section + depth layer
//  right before the NOISE GATE — so Claude reads "current facts",
//  "don't fabricate", and "use search if needed" together as a
//  coherent instruction set.
//
//  We splice on a known anchor string from each builder rather
//  than appending blindly, so a future edit to the base prompts
//  in aiProxyService.ts moves these augments with the anchor
//  rather than dropping them at the wrong end of the prompt.
// ─────────────────────────────────────────────────────────────
const NEW_PROMPT_ANCHOR = '=== NOISE GATE ===';
const OLD_PROMPT_ANCHOR = 'NOISE GATE:';

function injectClaudeAugments(
  systemPrompt: string,
  anchor: string,
  contextFiles?: ContextFile[],
): string {
  // Tech state goes FIRST among augments — it's the most authoritative
  // factual layer. Web-search rules + depth/voice come after so the
  // model knows what to do when the cached card doesn't cover something.
  const techState = contextFiles ? readTechStateCache(hashContextFiles(contextFiles)) : null;
  const parts = [techState, WEB_SEARCH_INSTRUCTIONS, buildClaudeDepthLayer()].filter(Boolean) as string[];
  const augments = parts.join('\n\n');
  if (!systemPrompt.includes(anchor)) {
    // Anchor moved or was removed — append at end as a defensive
    // fallback rather than silently dropping the instructions.
    return `${systemPrompt}\n\n${augments}`;
  }
  return systemPrompt.replace(anchor, `${augments}\n\n${anchor}`);
}

function buildClaudeSystemInstruction(
  textContext: string,
  generalMode: boolean,
  contextFiles?: ContextFile[],
): string {
  return injectClaudeAugments(buildSystemInstruction(textContext, generalMode), OLD_PROMPT_ANCHOR, contextFiles);
}

function buildClaudeSystemInstructionNew(
  identity: string,
  jdPriorities: string,
  evidence: string,
  contextFiles?: ContextFile[],
): string {
  return injectClaudeAugments(
    buildSystemInstructionNew(identity, jdPriorities, evidence),
    NEW_PROMPT_ANCHOR,
    contextFiles,
  );
}

// ─────────────────────────────────────────────────────────────
//  CLAUDE-NATIVE IDENTITY EXTRACTION
//
//  Same buildExtractionPrompt as the other models, but routed
//  through /chat/claude so this service has zero runtime
//  dependency on OpenAI. Separate cache from aiProxyService's
//  identityCache — Claude's extraction may differ in style or
//  emphasis, and we don't want either provider's stale entry
//  shadowing the other.
//
//  Bounded LRU (FIFO eviction via Map insertion order); 32 is
//  plenty for any realistic interview flow (typically 1–2 unique
//  resume/JD hashes per session).
// ─────────────────────────────────────────────────────────────
const IDENTITY_CACHE_MAX = 32;
const claudeIdentityCache = new Map<string, Promise<ExtractedCards | null>>();
// Synchronously-readable resolved cards (see aiProxyService's resolvedCards)
// so the answer path never awaits the ~3-9s extraction preflight.
const claudeResolvedCards = new Map<string, ExtractedCards>();

function ensureClaudeExtraction(
  contextFiles: ContextFile[],
  knownHash?: string,
): Promise<ExtractedCards | null> {
  const hash = knownHash || hashContextFiles(contextFiles);
  const cached = claudeIdentityCache.get(hash);
  if (cached) return cached;

  const promise = (async (): Promise<ExtractedCards | null> => {
    const { resume, jd } = splitResumeAndJd(contextFiles);
    if (!resume && !jd) return null;
    try {
      const prompt = buildExtractionPrompt(resume, jd);
      // Extraction is a one-off task: no system prompt, no chat
      // history, no web search (it doesn't need recent info — it
      // just summarizes the resume + JD). enableWebSearch:false
      // also avoids burning a tool slot on every prewarm.
      const text = await proxyRequest('/chat/claude', {
        messages: [{ role: 'user', content: prompt }],
        systemInstruction: undefined,
        enableWebSearch: false,
      });
      const splitIdx = text.indexOf('=== WHAT THIS ROLE REWARDS ===');
      if (splitIdx === -1) return null;
      const identity = text
        .slice(0, splitIdx)
        .replace(/^===\s*WHO YOU ARE\s*===/m, '')
        .trim();
      const jdPriorities = text
        .slice(splitIdx)
        .replace(/^===\s*WHAT THIS ROLE REWARDS\s*===/m, '')
        .trim();
      if (!identity || !jdPriorities) return null;
      return { identity, jdPriorities, resume, jd };
    } catch {
      // Silent fallback — the streaming code path checks for null
      // and uses the OLD prompt path (no extracted cards) instead.
      // Never break the interview because a preflight failed.
      return null;
    }
  })();

  claudeIdentityCache.set(hash, promise);
  if (claudeIdentityCache.size > IDENTITY_CACHE_MAX) {
    const oldest = claudeIdentityCache.keys().next().value;
    if (oldest !== undefined && oldest !== hash) claudeIdentityCache.delete(oldest);
  }
  // On settle: drop null/rejected (retry next time); publish a non-null
  // card to the synchronous map for answer-time pickup.
  promise.then(cards => {
    if (cards === null) { claudeIdentityCache.delete(hash); return; }
    claudeResolvedCards.set(hash, cards);
    if (claudeResolvedCards.size > IDENTITY_CACHE_MAX) {
      const oldest = claudeResolvedCards.keys().next().value;
      if (oldest !== undefined && oldest !== hash) claudeResolvedCards.delete(oldest);
    }
  });
  return promise;
}

// Background/blocking accessor — for the prewarm path only.
async function getClaudeExtractedCards(
  contextFiles: ContextFile[],
): Promise<ExtractedCards | null> {
  return ensureClaudeExtraction(contextFiles);
}

// ANSWER-TIME accessor — NON-BLOCKING (see aiProxyService's
// getResolvedCardsOrKickoff). Returns the card only if ready; otherwise
// kicks off extraction and returns null so this turn uses the raw-KB path.
function getClaudeResolvedCardsOrKickoff(contextFiles: ContextFile[]): ExtractedCards | null {
  const hash = hashContextFiles(contextFiles);
  const ready = claudeResolvedCards.get(hash);
  if (ready) return ready;
  void ensureClaudeExtraction(contextFiles, hash);
  return null;
}

// Build the user rules block, optionally substance-augmented for
// the NEW prompt path. Same shape as aiProxyService's variants.
function buildClaudeUserRulesBlock(useSubstance: boolean): string {
  const base = buildUserRulesBlock();
  if (!useSubstance) return base;
  return base.replace('=== VOICE EXAMPLES', SUBSTANCE_PREPEND + '=== VOICE EXAMPLES');
}

interface PromptContext {
  systemInstruction: string;
  userRulesBlock: string;
  kbHint: string;
}

// Mirrors getCustomInstructionsBlock() in aiProxyService.ts. Inlined here
// (not imported) so claudeService stays standalone — see file-header
// comment for the deliberate non-import policy on cross-service helpers.
// Both implementations must stay byte-identical: any future tweak to the
// strict-follow framing has to land in BOTH places or Claude responses
// drift from how Gemini/OpenAI/Groq/xAI handle the same instructions.
function getClaudeCustomInstructionsBlock(): string {
  if (typeof localStorage === 'undefined') return '';
  const raw = (localStorage.getItem('CUSTOM_INSTRUCTIONS') || '').trim();
  if (!raw) return '';
  return `━━━━━━ USER INSTRUCTIONS — FOLLOW STRICTLY ━━━━━━
The user has supplied the following directives. Treat them as the highest-priority rules for this response. They override conflicting style guidance from other parts of the system prompt unless that other guidance is about safety or factual accuracy.

${raw}

━━━━━━ END USER INSTRUCTIONS ━━━━━━

`;
}

async function prepareClaudeStreamPrompts(
  query: string,
  contextFiles: ContextFile[],
  generalMode: boolean,
): Promise<PromptContext> {
  // Custom instructions read once and prepended in every branch below.
  // Empty string when none — cheap no-op concat.
  const customBlock = getClaudeCustomInstructionsBlock();

  // assembleEvidence is the shared ADAPTIVE KB layer from aiProxyService:
  // whole KB when small (offloaded, byte-stable), or only the BM25-retrieved
  // passages relevant to THIS question when large — the cost fix that stops
  // a 100-file session shipping ~100K tokens per turn. See
  // services/kbRetrieval.ts.
  if (generalMode) {
    const textContext = await assembleEvidence(query, contextFiles);
    return {
      systemInstruction: customBlock + buildClaudeSystemInstruction(textContext, true, contextFiles),
      userRulesBlock: buildClaudeUserRulesBlock(false),
      kbHint: '',
    };
  }
  // NON-BLOCKING at answer time — see aiProxyService.prepareStreamPrompts.
  const cards = getClaudeResolvedCardsOrKickoff(contextFiles);
  if (!cards) {
    const textContext = await assembleEvidence(query, contextFiles);
    return {
      systemInstruction: customBlock + buildClaudeSystemInstruction(textContext, false, contextFiles),
      userRulesBlock: buildClaudeUserRulesBlock(false),
      kbHint: '\n\n[Remember: draw from the Knowledge Base where relevant.]',
    };
  }
  return {
    systemInstruction: customBlock + buildClaudeSystemInstructionNew(
      cards.identity,
      cards.jdPriorities,
      await assembleEvidence(query, contextFiles),
      contextFiles,
    ),
    userRulesBlock: buildClaudeUserRulesBlock(true),
    kbHint:
      "\n\n[Anchor this answer in ONE specific memory from WHO YOU ARE and silently slant it toward WHAT THIS ROLE REWARDS. No pure-textbook answers. No resume quoting — recall, don't cite. If the question hinges on a current/recent fact, USE THE WEB SEARCH TOOL silently before answering — never narrate the search. If the CURRENT TECH STATE block above already covers the fact, prefer that — no live search needed.]",
  };
}

// ─────────────────────────────────────────────────────────────
//  CLAUDE MESSAGE CONSTRUCTION
//
//  Anthropic's image-content shape is different from OpenAI's:
//    Anthropic: { type: 'image', source: { type: 'base64', ... } }
//    OpenAI:    { type: 'image_url', image_url: { url: 'data:...' } }
//  The proxy passes our messages array straight through to the
//  SDK, so the shape has to be Anthropic-flavored on this side.
// ─────────────────────────────────────────────────────────────
function buildClaudeMessages(
  history: Message[],
  userText: string,
  imageFiles: ContextFile[],
  isAutoSolve: boolean,
): any[] {
  const messages: any[] = [];
  if (!isAutoSolve) {
    history.forEach(m => {
      if (m.role !== 'system') {
        messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
      }
    });
  }
  const contentBlocks: any[] = [{ type: 'text', text: userText }];
  imageFiles.forEach(f =>
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: f.mimeType, data: f.base64 },
    }),
  );
  messages.push({ role: 'user', content: contentBlocks });
  return messages;
}

// ─────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────

export async function generateClaude(
  query: string,
  history: Message[],
  contextFiles: ContextFile[],
  generalMode: boolean,
): Promise<string> {
  const { systemInstruction, userRulesBlock, kbHint } = await prepareClaudeStreamPrompts(
    query,
    contextFiles,
    generalMode,
  );

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));
  const userText = `${userRulesBlock}Interviewer (Current Audio): ${query}${kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;

  const messages = buildClaudeMessages(history, userText, imageFiles, false);

  const text = await proxyRequest('/chat/claude', {
    messages,
    systemInstruction,
    enableWebSearch: true,
  });
  return text.trim() === '...' || text.trim().toLowerCase() === 'listening...'
    ? 'Listening...'
    : text;
}

export async function streamClaude(
  query: string,
  history: Message[],
  contextFiles: ContextFile[],
  generalMode: boolean,
  onToken: OnToken,
  signal?: AbortSignal,
  isAutoSolve?: boolean,
): Promise<string> {
  let systemInstruction: string;
  let userText: string;
  if (isAutoSolve) {
    // Auto-solve replaces the persona with strict code-only output
    // and drops history. Web search is also disabled at the call
    // site below — the screenshot has the answer; searching would
    // just steal latency.
    systemInstruction = buildAutoSolveSystemInstruction();
    userText = query;
  } else {
    const prompts = await prepareClaudeStreamPrompts(query, contextFiles, generalMode);
    systemInstruction = prompts.systemInstruction;
    userText = `${prompts.userRulesBlock}Interviewer (Current Audio): ${query}${prompts.kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  }

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));
  const messages = buildClaudeMessages(history, userText, imageFiles, !!isAutoSolve);

  const enableWebSearch = !isAutoSolve;

  const full = await proxyStream(
    '/stream/claude',
    { messages, systemInstruction, enableWebSearch, coverContext: isAutoSolve ? '' : buildCoverContext(contextFiles) },
    onToken,
    signal,
  );
  if (isAutoSolve) return full;
  return full.trim() === '...' || full.trim().toLowerCase() === 'listening...'
    ? 'Listening...'
    : full;
}

// Kick off Claude-side identity extraction the moment context
// files load, so the first interview question doesn't pay the
// ~2-5s preflight cost. Fire-and-forget; safe to call repeatedly
// (hits the cache after the first run). Noop when there's nothing
// useful to extract.
export function prewarmClaudeIdentity(contextFiles: ContextFile[]): void {
  if (!contextFiles || contextFiles.length === 0) return;
  const { resume, jd } = splitResumeAndJd(contextFiles);
  if (!resume && !jd) return;
  void getClaudeExtractedCards(contextFiles);
}
