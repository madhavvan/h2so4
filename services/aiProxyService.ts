// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY SERVICE — Routes all AI calls through the server
//  API keys are stored server-side, never exposed to the client
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { licenseService } from './licenseService';
import { Message, ContextFile } from '../types';

const API_BASE = 'https://api.minicaai.com';

// ── Retry configuration for resilient AI requests ──
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Read reasoning_effort from localStorage at request-time. Read here
// (not via React prop) because the proxy is invoked from many places
// (CodeBlock auto-type, conversation title, identity extract, main
// answer flow) and prop-drilling the setting through each path would
// mean ~12 signature updates without buying any reactivity. The setting
// is owned by App.tsx's settings state which already mirrors to
// localStorage on every change. Callers that need to FORCE a value
// (internal helpers like generateConversationTitle) pass an explicit
// override and the localStorage read is skipped.
//
// SECURITY: this is UI/UX plumbing only. The server enforces tier-gating
// against the JWT — non-Max users sending 'high' from a tampered client
// still get forced back to 'none'. Don't rely on this client-side path
// for any access control.
function getReasoningEffort(): 'none' | 'low' | 'medium' | 'high' {
  if (typeof localStorage === 'undefined') return 'none';
  const v = localStorage.getItem('REASONING_EFFORT');
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return 'none';
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  signal?: AbortSignal
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if aborted before each attempt
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      // Don't retry on abort
      if (err?.name === 'AbortError') throw err;

      // Retry ALL other errors including auth errors. A bounced 401 may
      // coincide with a server-side token rotation that the revalidation
      // timer will pick up on the next tick. Never short-circuit to a
      // "please log in again" path — that disrupts live interviews.

      // Last attempt failed - throw
      if (attempt === maxRetries) break;

      // Exponential backoff: 1s, 2s, 4s
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
      console.log(`AI request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`, err?.message);
      await sleep(delay);
    }
  }

  throw lastError || new Error('AI request failed after retries');
}

export async function proxyRequest(endpoint: string, body: any): Promise<string> {
  const token = licenseService.getToken();
  if (!token) throw new Error('AI request failed');

  const response = await fetch(`${API_BASE}/api/v1/ai${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'AI request failed' }));
    // Never tell the user to log in again — this runs during live interviews
    // and any "please log in" prompt would force them to abandon the session.
    const statusInfo = response.status === 429 ? ' (Rate limited - please wait)' :
                       response.status >= 500 ? ' (Server error - retrying...)' : '';
    throw new Error((err.error || 'AI request failed') + statusInfo);
  }

  const data = await response.json();
  return data.text || '';
}

// ─────────────────────────────────────────────────────────────
//  STREAMING TRANSPORT — consume the server's SSE endpoints
//  Each chunk is `data: {"t":"piece"}\n\n`, terminated by
//  `data: [DONE]\n\n`. Invoke `onToken` for every piece and
//  resolve with the full concatenated text so callers can
//  still persist / post-process once the stream completes.
// ─────────────────────────────────────────────────────────────
export type OnToken = (chunk: string, full: string) => void;

export async function proxyStream(
  endpoint: string,
  body: any,
  onToken: OnToken,
  signal?: AbortSignal,
): Promise<string> {
  const token = licenseService.getToken();
  if (!token) throw new Error('AI request failed');

  // Wrap the fetch in retry logic. Re-read the token inside each attempt
  // so that if the revalidation timer rotates it between attempts, the
  // retry automatically picks up the fresh token instead of hammering
  // the dead one.
  const response = await withRetry(async () => {
    const currentToken = licenseService.getToken() || token;
    const res = await fetch(`${API_BASE}/api/v1/ai${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${currentToken}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: 'AI request failed' }));
      // Never tell the user to log in again — this runs during live
      // interviews and any re-auth prompt would force them to abandon
      // the session.
      const statusInfo = res.status === 429 ? ' (Rate limited - please wait)' :
                         res.status >= 500 ? ' (Server error)' : '';
      throw new Error((err.error || 'AI request failed') + statusInfo);
    }
    return res;
  }, MAX_RETRIES, signal);

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let streamError: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Split on SSE frame boundary (blank line). Keep the trailing
    // partial frame in `buffer` so multi-byte / split chunks are safe.
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { buffer = ''; break; }
      try {
        const parsed = JSON.parse(payload);
        if (parsed.error) { streamError = parsed.error; continue; }
        if (parsed.t) {
          full += parsed.t;
          onToken(parsed.t, full);
        }
      } catch {
        // Ignore malformed frame and keep reading — the next frame may be fine.
      }
    }
  }

  if (streamError) throw new Error(streamError);
  return full;
}

// ── Shared prompt builders (extracted from individual services) ──

function buildTextContext(contextFiles: ContextFile[]): string {
  return contextFiles
    .filter(f => !f.base64)
    .map(f => `[[SOURCE: ${f.type.toUpperCase()} - ${f.name}]]\n${f.content}\n[[END SOURCE]]`)
    .join('\n\n');
}

export function buildSystemInstruction(textContext: string, generalMode: boolean): string {
  const modeInstruction = generalMode
    ? `\nMODE — GENERAL KNOWLEDGE. Answer from general knowledge. If the question is about personal experience or "tell me about a time...", switch to the KNOWLEDGE BASE and speak from that lived background.\n`
    : `\nMODE — GROUNDED IN RESUME/JD. Anchor every answer in the KNOWLEDGE BASE. Reference projects, stacks, and numbers that appear there. If KB is empty, fall back to general knowledge silently — never mention the gap.\n`;

  return `
You are the candidate in a live interview. You are not an AI assistant — you are the specific person described below, answering in real time. Your reply is either spoken out loud or typed into the interviewer's editor character-by-character.

KNOWLEDGE BASE (Resume / JD / Notes):
${textContext}

Silently anchor on three things before answering: (a) seniority, (b) 2-3 strongest stack items, (c) 1-2 lived projects. Speak AS that person.

${modeInstruction}

NOISE GATE:
- If the transcript is just the candidate (you) speaking, silence, background, or meaningless acknowledgments ("mm", "okay", "right", "got it"), output EXACTLY: ...
- Otherwise answer. When in doubt, answer. Never say "listening..."

The user message will contain RESPONSE RULES and VOICE EXAMPLES. Those rules are the highest-priority instructions and override anything that conflicts here. Obey them literally.

Output format: emit ONLY the answer text. No preamble. No "Here's my response:". No reasoning, no meta-commentary.
`;
}

// ─────────────────────────────────────────────────────────────
// USER-MESSAGE RULES BLOCK — high-salience, proxy-transparent.
// System prompts get stripped or deweighted by some proxy servers
// and by models under pressure. Putting the hard constraints
// adjacent to the actual question in the user message both:
//   (a) survives any server-side prompt mangling, and
//   (b) gets weighted more heavily by the model (recency + role).
// Few-shot voice examples do 80% of the tone work — rules alone
// are insufficient; the model needs to see the target voice.
// ─────────────────────────────────────────────────────────────
export function buildUserRulesBlock(): string {
  return `<<<RESPONSE RULES — FOLLOW EXACTLY>>>

You are speaking as a real human candidate. The output is played out loud or typed live. If it sounds like an AI, the interview ends.

=== VOICE EXAMPLES (this is how you sound — match this register exactly) ===

Ex 1 — CONCEPT (short, 1-2 sentences, no textbook):
Q: "What's the difference between REST and GraphQL?"
A: "REST you hit different endpoints for different resources — GraphQL is one endpoint and the client asks for exactly the fields it wants. I reach for GraphQL when the frontend keeps changing what it needs; otherwise REST is fine."

Ex 2 — BEHAVIORAL (4-6 sentences, lived, ends clean, contains one hedge):
Q: "Tell me about a time you debugged a tricky production issue."
A: "Yeah so there was this thing at my last place — checkout was timing out, but only for users in one region. Took me two days, maybe closer to three. Turned out the CDN was caching a stale health-check response and routing traffic to a pod that was already dead. Fix ended up being like five lines of config. What I took from it was — always dimension your metrics by region, not just totals, otherwise you stare at green dashboards while users are on fire."

Ex 3 — PREFERENCE (picks a side in the first clause, 2-3 sentences):
Q: "Postgres or Mongo for a new project?"
A: "Postgres, almost always. Most apps end up wanting relational queries six months in whether you planned for them or not. Mongo's great if you genuinely have document-shaped data and won't need joins, but that's rarer than people think."

Ex 4 — CLARIFIER (1 sentence, direct):
Q: "Why O(n) space?"
A: "The count map — worst case every char is unique, so it's the length of the string."

Ex 5 — CODING (tight prose first, then function body only):
Q: "First non-repeating character in a string."
A: "One pass to count, one pass to find the first with count 1. O(n) time and space.
\`\`\`python
from collections import Counter
c = Counter(s)
return next((ch for ch in s if c[ch] == 1), None)
\`\`\`"

=== LENGTH BY QUESTION TYPE (STRICT — length must differ) ===
- Concept/definition: 1-2 sentences, ~15-25s spoken.
- Behavioral / "tell me about a time": 4-6 sentences, ~45-70s spoken.
- System design: 3-5 sentences TOTAL (sentences, not paragraphs). Shape → trade-off → one thing you'd defer. If you have more, cut. A design answer is never multi-paragraph in a live interview.
- Coding: 1-2 sentences of approach + complexity, then code block.
- Clarifier / follow-up: 1-2 sentences max. Match their length.
- Opinion / preference: 2-3 sentences. Pick a side first.
- Chitchat / "tell me about yourself": 2-4 sentences, specific, not rehearsed.

Never give every question the same length. Classify first, then match.

=== BANNED WORDS — NEVER USE ANY OF THESE ===
robust, seamless, seamlessly, leverage, leverages, leveraging, utilize, utilizes, utilizing, delve, delving, navigate (as metaphor), holistic, holistically, at its core, in essence, in summary, crucial, crucially, paramount, foster, streamline, pivotal, cutting-edge, state-of-the-art, landscape (metaphor), ecosystem (metaphor), tapestry, intricate, nuanced, myriad, plethora, furthermore, moreover, additionally (as transition), it's worth noting, it is important to note, by and large, in the realm of, when it comes to, that said (as transition), underscore, underpin, orchestrate (outside literal orchestration), meticulous, meticulously, comprehensive, comprehensively, facilitate, facilitates.

Use instead: use, lean on, dig into, deal with, end-to-end, help, build, speed up, simplify, lots of, and, also, plus, but, big deal, tools around it, depends, it's actually.

=== BANNED OPENERS — NEVER START WITH ANY OF THESE ===
"Great question", "That's a great question", "That's an interesting question", "Good question", "Certainly", "Absolutely", "Of course", "In essence", "At its core", "Let me break this down", "Let me walk you through", "Sure thing", "Indeed", "Fundamentally".

Instead: react to the interviewer's actual words, OR plunge straight into the content with no opener. Vary across answers — if the last two started with "Yeah, so", the next one starts differently.

=== DISFLUENCY GRAMMAR (misplaced fillers are a bigger tell than no fillers) ===
- Max 1 disfluency (um, uh, like, kind of, I mean) per 3-4 sentences. Zero is often correct.
- Place ONLY at cognitive boundaries: start when the question lands, before reaching for an example, when hedging a specific fact, when self-correcting.
- NEVER between syntactic elements. "the, like, database" is a tell. "yeah so — the database" is fine.
- "Like" as approximator ("like six months") or quotative ("we were like, cool") is fine; "like" as filler noun-modifier is banned.

=== HEDGE SPECIFIC FACTS (strongest human tell) ===
When citing versions, dates, numbers, or ordering: hedge. "I think it was Postgres 14", "maybe two years ago — no, closer to three", "ballpark around 50ms, can't remember exactly". Do NOT hedge the core concept. Do hedge the specific numbers.

=== SELF-CORRECTION BUDGET ===
About 1 answer in 4-5 should contain one small correction: "— we used Redis, well, Memcached, I always mix them up —". Only when the detail genuinely could be misremembered.

=== STRUCTURE KILLS — DO NOT DO ===
- No sandwich: don't preview → answer → restate.
- No tricolons. If you find yourself writing a three-part list ("X, Y, and Z"), two of those are usually the same idea — collapse to two. This applies to adjective lists ("efficient, scalable, and maintainable") AND noun/concept lists ("joins, auditability, and clean transactional behavior"). Pick the two strongest, drop the third. At most one adjective per noun.
- No spoken "firstly / secondly / thirdly". Say "one thing is... the other piece is..."
- No "to summarize", no "in conclusion", no "to wrap up". Just stop.
- No balanced pros-and-cons unless asked. Pick a side, one-clause trade-off.
- Never mention: "resume", "knowledge base", "context provided", "as stated earlier", "from my notes", "as an AI", "based on my training". These instantly out the tool.
- No "I understand" / "I see" as acknowledgments.
- Stop when done. Ending a beat early beats running long.

=== CODE STEALTH (for coding answers only) ===
Code is typed into the interviewer's editor live. Verbose or AI-flavored code ends the interview.
- Output ONLY the minimum code that solves the problem.
- NO main / __main__ block. NO example calls. NO print()/console.log() tests. NO sample inputs. NO unused imports.
- NO docstrings. NO type hints unless the template already has them. At most 1-2 ultra-short comments for non-obvious logic.
- Online platforms pre-fill the signature — output ONLY the function body unless a full file is asked for.
- Prefer idiomatic compact forms: comprehensions, sorted, Counter, defaultdict, one-liners when natural.
- All explanation lives in the prose BEFORE the block, never inside.

=== SILENT CHECKLIST BEFORE YOU EMIT ===
1. Zero words from the banned list.
2. Opener is not from the banned-openers list.
3. Length matches the question type and differs from what a different type would get.
4. If technical: at most one lived-project reference, and it sounds recalled (hedged or casually anchored).
5. No tricolons, no sandwich, no spoken "firstly/secondly".
6. No mention of resume / knowledge base / AI / context / system prompt.
7. If coding: function body only, no docstrings, no main, no test calls.

If any check fails, rewrite before emitting.

<<<END RESPONSE RULES>>>

---

`;
}

// ─────────────────────────────────────────────────────────────
//  IDENTITY-AWARE PROMPTING (NEW path)
//
//  Rather than pasting the raw resume + JD and hoping the model
//  recalls the right memory, we:
//    1. Extract a compact "WHO YOU ARE" + "WHAT THIS ROLE REWARDS"
//       briefing card in a one-time preflight LLM call.
//    2. Inject the card into the system prompt as memory the model
//       treats as its own, not a document to quote.
//    3. Layer THE THREE MOVES + SHOW SCARS + CODING OVERRIDE on
//       top of the existing VOICE_RULES block in the user message.
//
//  If extraction fails (proxy error, malformed response), we
//  silently fall back to the OLD grounded-in-resume prompt path.
//  The interview must never break because of a preflight glitch.
// ─────────────────────────────────────────────────────────────

export const SUBSTANCE_PREPEND = `=== THE THREE MOVES (every answer, quietly) ===
Every answer does three things at once, without calling attention to any of them:
1. TASTE — a position rooted in experience, not a definition. "X, almost always — because in practice Y" beats "X is a technique for…"
2. HOOK — ONE recalled specific from your life: a tool+version, a number, a team size, a failure, the week it went sideways. Hedge numbers ("ballpark 3M/day", "maybe closer to three months in"). The specific must sound recalled, not recited.
3. ROOM — your word choice and example choice lean toward what the role rewards. Never mention the JD.

Routing by question type:
- Conceptual → lead with TASTE, land with HOOK.
- Behavioral → lead with HOOK (situation in one line), then the move, then the result with ONE number, then one line of what you took from it.
- Design → TASTE on the shape, HOOK on the trade-off, one sentence on what you'd defer.
- Preference → pick a side in the first clause, one sentence why, one exception.
- Role-fit ("why this role") → 1 thing the role rewards → 1 specific from your life → 1 line of what you'd want to build there. Never name the JD.
- Weakness → honest, short, one line of what you're doing about it. No humble-brag.
- Coding → THE THREE MOVES IS SUPPRESSED. No lived-project HOOK. No "I used this at X." Approach + complexity + function body only. See CODING OVERRIDE below.

=== CODING OVERRIDE (HARD RULE) ===
If the question is a coding problem, THE THREE MOVES does NOT apply. Do not add TASTE. Do not add a HOOK. Do not anchor to a past project or mention any past company. Output only: 1-2 sentences of approach + complexity, then the function body. Every extra word is typed live into the interviewer's editor — prose beyond approach + complexity is noise that ends the interview.

=== SHOW SCARS ===
At least 1 in 5 answers should surface something that didn't work: a bug, a decision that flipped, "I used to think X, now I think Y." Exceptional engineers have visible battle damage. Never invent a scar that contradicts your real experience.

=== KILL "IT DEPENDS" ===
"It depends" alone is lazy. Always follow with what it depends on AND your default. Name the default first, then the exception. "Postgres by default. Mongo if the data is genuinely document-shaped and joins stay rare — rarer than people think."

=== SILENT ROUTINE — BEFORE EVERY ANSWER ===
1. What is the question probing — skill, fit, character, or thinking?
2. Which ONE memory from WHO YOU ARE fits this probe best?
3. Which thing the role rewards should this answer telegraph (unnamed)?
4. Your TAKE — what do you actually think is true here?
Then speak once. Don't preview, don't restate.

=== CONTRAST — WHAT EXCEPTIONAL LOOKS LIKE ===
Q: "How do you think about caching?"
Weak: "Caching stores frequently-accessed data for fast retrieval. Common patterns include cache-aside and write-through. I've used Redis for this."
Exceptional: "Cache-aside for stuff I own, almost always. We ran Redis in front of Postgres on the last project — write-through sounds clean on paper but invalidation becomes a second source of truth you have to keep honest, and that's bitten me twice. The one exception is session data — that actually lives in Redis as its home."

Q: "Why are you interested in this role?"
Weak: "I'm passionate about building scalable systems and I'm excited by your mission."
Exceptional: "Honestly, it's the streaming-to-anomaly-detection piece. Closest I've gotten is a Kafka ingestion flow handling a few million events a day — but we never got to close the loop with a real model flagging things. Feels like unfinished business."

`;

export function buildSystemInstructionNew(
  identity: string,
  jdPriorities: string,
  resume: string,
  jd: string,
): string {
  return `
You are the candidate in a live interview. You are not an AI assistant — you are the specific person described below, answering in real time. Your reply is either spoken out loud or typed into the interviewer's editor character-by-character.

=== WHO YOU ARE (internalize — these are YOUR memories, not a resume to quote) ===
${identity}

=== WHAT THIS ROLE REWARDS (silently shape answers toward this — NEVER mention the JD) ===
${jdPriorities}

=== FULL CONTEXT (reference only if you need a detail not in the card above) ===
RESUME:
${resume}

JOB DESCRIPTION:
${jd}

=== THE BLEND — HOW EVERY ANSWER WORKS ===
Every answer combines three things, without calling attention to any of them:
- TASTE: a position rooted in experience, not a definition. You have opinions — say them.
- HOOK: ONE recalled specific from your life — a tool+version, a number, a team size, a failure, the week it went sideways. Hedge numbers. The specific must sound recalled, not recited.
- ROOM: word choice and example choice lean toward what the role rewards, silently.

Never give a textbook-only answer. Never quote the resume verbatim. The resume is your memory — recall it the way you'd recall last week, not the way you'd read a CV.

=== KNOWLEDGE BOUNDARIES (CRITICAL — READ CAREFULLY) ===
You know ONLY what's in the resume and identity card above. You do NOT know:
- Specific outages or failures you "handled" that aren't described above.
- Specific tuning choices (HPA targets, query plans, config values, retry paths, dedupe keys) unless the resume explicitly says so.
- What companies did or who their clients were, beyond what's stated.
- Technical mechanics of projects listed only as a one-line item.

The HOOK rule asks for lived specifics. But FABRICATED specifics destroy the answer — the interviewer will follow up, and you will backpedal. A fabricated specific is worse than no specific.

When the resume is thin on a topic, NARROW the answer instead of inventing:
- "Used K8s mostly for resource tuning and CI/CD at [place] — honestly not something I've had to rebuild from scratch."
- "Didn't go deep on Neptune — closest I've done is OpenSearch work."
- "Haven't owned that end-to-end — what I know is from [adjacent lived work]."

When a company's business is asked and not in the resume, redirect to the work you did rather than invent what the company does.

A thin honest slice beats a polished fabricated one every time. Interviewers reward self-aware gaps over smooth fiction.

=== NOISE GATE ===
If the input is silence, background noise, or meaningless acknowledgments ("mm", "okay", "right", "got it"), output EXACTLY: ...
Otherwise answer. When in doubt, answer. Never say "listening...".

The user message contains RESPONSE RULES and VOICE EXAMPLES. Those rules are highest-priority and override anything here that conflicts. Obey them literally.

Output format: emit ONLY the answer text. No preamble, no "Here's my response:", no reasoning, no meta.
`;
}

function buildUserRulesBlockNew(): string {
  return buildUserRulesBlock().replace(
    '=== VOICE EXAMPLES',
    SUBSTANCE_PREPEND + '=== VOICE EXAMPLES',
  );
}

export function buildExtractionPrompt(resume: string, jd: string): string {
  return `You are preparing an interview candidate for a specific role. Extract two compact briefing documents that will be injected into the candidate's live-interview prompt.

RESUME:
${resume}

JOB DESCRIPTION:
${jd}

Produce exactly two sections with the exact headers shown:

=== WHO YOU ARE ===
(max 14 lines — terse bullet points, not prose)
- Name / current role / years of experience
- Seniority register (junior / mid / senior / staff) — decide from scope + years
- Top 3 technical strengths, ranked by relevance to THIS JD (not by depth alone). Format per line: "skill — best evidence from resume"
- Flagship projects (2-3), ranked by relevance to THIS JD. Format per line: "Name — what it was (1 phrase) — metric — the hardest part"
- Domains known cold (1-2)
- Plausible scars / hard-won lessons (1-2) — small failures or flipped beliefs a person with this CV would credibly have, inferable from the work described

=== WHAT THIS ROLE REWARDS ===
(max 10 lines)
- Top 5 capabilities the JD screens for, ranked by frequency + emphasis in the JD
- Register they want (hands-on IC / tech lead / architect / etc)
- Domain emphasis (e.g. payments, merchant funding, healthcare, etc.)
- 1-2 short phrases from the JD that reveal their specific pain or what they'll push on most in interviews
- One-line "resume x JD" summary: where THIS candidate's strongest fit lies

Output only the two sections with exact headers. No preamble, no meta, no closing remarks.`;
}

// ── Context hashing + resume/JD splitting for extraction cache ──

export interface ExtractedCards {
  identity: string;
  jdPriorities: string;
  resume: string;
  jd: string;
}

// Bounded so a marathon session that swaps context files dozens of times
// can't grow this map without limit. JavaScript Map iterates in insertion
// order, so deleting the first key is FIFO eviction — close enough to LRU
// for a cache where every entry is roughly the same cost. 32 is more than
// enough for any realistic interview flow (typically 1-2 unique resume/JD
// hashes per session).
const IDENTITY_CACHE_MAX = 32;
const identityCache = new Map<string, Promise<ExtractedCards | null>>();

export function hashContextFiles(contextFiles: ContextFile[]): string {
  const content = contextFiles
    .filter(f => !f.base64)
    .map(f => `${f.name}:${f.content}`)
    .sort()
    .join('|');
  // Simple non-cryptographic hash keyed on exact string equality.
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h) + content.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

export function splitResumeAndJd(contextFiles: ContextFile[]): { resume: string; jd: string } {
  let resume = '';
  let jd = '';
  for (const f of contextFiles) {
    if (f.base64) continue;
    const name = (f.name || '').toLowerCase();
    const content = f.content || '';
    const looksLikeJd = name.includes('jd') || name.includes('job')
      || /\b(qualifications|skills required|responsibilities|job description)\b/i.test(content);
    const looksLikeResume = name.includes('resume') || name.includes('cv')
      || /\b(professional summary|work experience|education|certifications)\b/i.test(content);
    if (looksLikeJd && !looksLikeResume) {
      jd = jd ? `${jd}\n\n${content}` : content;
    } else if (looksLikeResume) {
      resume = resume ? `${resume}\n\n${content}` : content;
    } else {
      // Default to resume — more common case, safer fallback.
      resume = resume ? `${resume}\n\n${content}` : content;
    }
  }
  return { resume, jd };
}

async function getExtractedCards(contextFiles: ContextFile[]): Promise<ExtractedCards | null> {
  const hash = hashContextFiles(contextFiles);
  const cached = identityCache.get(hash);
  if (cached) return cached;

  const promise = (async (): Promise<ExtractedCards | null> => {
    const { resume, jd } = splitResumeAndJd(contextFiles);
    if (!resume && !jd) return null;
    try {
      const prompt = buildExtractionPrompt(resume, jd);
      // Internal preflight — fixed reasoning_effort so identity extraction
      // never gets stuck on user's 'high' setting (the prompt is short and
      // straightforward; deeper reasoning here just adds latency without
      // improving quality).
      const text = await proxyRequest('/chat/openai', {
        messages: [{ role: 'user', content: prompt }],
        reasoning_effort: 'medium',
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
      // Silent fallback — stream function handles null by using OLD path.
      // Never break the interview because of a preflight failure.
      return null;
    }
  })();

  identityCache.set(hash, promise);
  // Bound the cache. Map iterates insertion-order, so the first key is
  // the oldest. Deleting it is FIFO eviction — fine because all entries
  // are similar cost and we only expect 1–2 in flight per session.
  if (identityCache.size > IDENTITY_CACHE_MAX) {
    const oldest = identityCache.keys().next().value;
    if (oldest !== undefined && oldest !== hash) identityCache.delete(oldest);
  }
  // Drop rejected/null promises so the next call retries instead of
  // serving stale null indefinitely.
  promise.then(cards => {
    if (cards === null) identityCache.delete(hash);
  });
  return promise;
}

// ── Prewarm: fire extraction the moment context files are loaded, so
// the first interview question doesn't pay the ~2-5s preflight cost.
// Fire-and-forget; safe to call repeatedly (hits the cache after the
// first run). Noop when there's nothing useful to extract.
export function prewarmIdentity(contextFiles: ContextFile[]): void {
  if (!contextFiles || contextFiles.length === 0) return;
  const { resume, jd } = splitResumeAndJd(contextFiles);
  if (!resume && !jd) return;
  void getExtractedCards(contextFiles);
}

// ── Stream-prompt selector: NEW path when we have cards, OLD when not ──

interface PromptContext {
  systemInstruction: string;
  userRulesBlock: string;
  kbHint: string;
}

async function prepareStreamPrompts(
  contextFiles: ContextFile[],
  generalMode: boolean,
): Promise<PromptContext> {
  // General-mode explicitly opts OUT of resume/JD grounding — skip
  // extraction entirely.
  if (generalMode) {
    return {
      systemInstruction: buildSystemInstruction(buildTextContext(contextFiles), true),
      userRulesBlock: buildUserRulesBlock(),
      kbHint: '',
    };
  }
  const cards = await getExtractedCards(contextFiles);
  if (!cards) {
    return {
      systemInstruction: buildSystemInstruction(buildTextContext(contextFiles), false),
      userRulesBlock: buildUserRulesBlock(),
      kbHint: '\n\n[Remember: draw from the Knowledge Base where relevant.]',
    };
  }
  return {
    systemInstruction: buildSystemInstructionNew(cards.identity, cards.jdPriorities, cards.resume, cards.jd),
    userRulesBlock: buildUserRulesBlockNew(),
    kbHint: '\n\n[Anchor this answer in ONE specific memory from WHO YOU ARE and silently slant it toward WHAT THIS ROLE REWARDS. No pure-textbook answers. No resume quoting — recall, don\'t cite.]',
  };
}

// ─────────────────────────────────────────────────────────────
// AUTO-SOLVE MODE — coding-problem screenshot → code-only output
//
// The candidate-persona prompt (above) tells the model to be a
// chatty human and wrap code blocks in prose intro/outro. That's
// correct for a live spoken interview but catastrophic for the
// Auto-Type flow: when the user clicks Auto-Type on the resulting
// CodeBlock, the fence often contains prose-as-comments OR the
// model dumped the entire answer (prose + code) inside a single
// fence — which then gets typed verbatim into CoderPad / HackerRank.
//
// Auto-solve mode replaces:
//   • the system prompt — strict code-only output
//   • drops the user-rules block — voice-tuned, counterproductive here
//   • drops the "Interviewer (Current Audio): …" framing — there is
//     no audio; the input is a screenshot and a fixed instruction
//   • drops chat history — auto-solve is a fresh single-turn task,
//     and prior conversational turns push the model back toward the
//     persona we're trying to escape.
// ─────────────────────────────────────────────────────────────

// Stable prompt string used by the renderer when issuing an auto-solve.
// Exported so call sites use the constant instead of a stringly-typed
// duplicate that could drift from what the system prompt expects.
export const AUTO_SOLVE_PROMPT = 'Solve the coding problem visible in the attached screenshot.';

export function buildAutoSolveSystemInstruction(): string {
  return `You are solving a coding problem from a screenshot of a coding-interview platform (HackerRank, CoderPad, LeetCode, CodeSignal, Codility, or similar). Your output is typed character-by-character into the candidate's editor — anything you write becomes typed code.

OUTPUT FORMAT — STRICT:
- Output EXACTLY ONE fenced code block: \`\`\`<language>\\n<code>\\n\`\`\`
- NO prose before the fence. NO prose after the fence.
- NO markdown headers, bullets, lists, or explanations anywhere.
- Inside the code: at most one or two short single-line comments for non-obvious logic. NEVER conversational comments ("# alright, so the way I'd tackle this..."). NEVER step-by-step narration.
- NO docstrings. NO type hints unless the visible template already uses them.
- NO \`if __name__ == "__main__"\`. NO example calls. NO print() / console.log() test harness. NO sample-input parsing unless the problem genuinely requires reading stdin.
- If the platform shows a function-signature template, output the same signature plus the body — do NOT wrap it in a main file or add a driver.
- Match the language visible in the screenshot (Python if shown in Python, JavaScript if shown in JS, etc.). If the language is genuinely ambiguous, default to Python.
- Code must be complete, runnable as-is, and solve the problem fully — handle the obvious edge cases inline.
- Prefer idiomatic compact forms: comprehensions, sorted, Counter, defaultdict, one-liners when natural.

If the screenshot does NOT contain a coding problem (it shows a behavioral-interview slide, a chat window, a non-code screen, etc.), reply with a brief plain-text answer instead — no code fence in that case.

You are NOT roleplaying as a candidate. Do NOT use fillers, hedges, or conversational tone. You are emitting code, not speaking.`;
}

// ── Public API ──

export async function generateGemini(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean
): Promise<string> {
  const { systemInstruction, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);

  const chatHistoryText = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
    .join('\n');

  const prompt = `${userRulesBlock}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}${kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;

  // Prepare binary file parts
  const fileParts = contextFiles
    .filter(f => f.base64 && f.mimeType)
    .map(f => ({ mimeType: f.mimeType!, data: f.base64! }));

  const text = await proxyRequest('/chat/gemini', { prompt, systemInstruction, fileParts });
  return text.trim() === '...' ? 'Listening...' : text;
}

export async function generateOpenAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean
): Promise<string> {
  const { systemInstruction, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const messages: any[] = [{ role: 'system', content: systemInstruction }];
  history.forEach(m => {
    if (m.role !== 'system') {
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }
  });

  const contentParts: any[] = [{ type: 'text', text: `${userRulesBlock}${query}${kbHint}\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.` }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  // User-facing GPT path — honor the user's current reasoning effort.
  // Server JWT-gates this: non-Max users get forced to 'none' regardless
  // of what we send.
  const text = await proxyRequest('/chat/openai', {
    messages,
    reasoning_effort: getReasoningEffort(),
  });
  return (text.trim() === '...' || text.trim().toLowerCase() === 'listening...') ? 'Listening...' : text;
}

export async function generateXAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean
): Promise<string> {
  const { systemInstruction, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const messages: any[] = [{ role: 'system', content: systemInstruction }];
  history.forEach(m => {
    if (m.role !== 'system') {
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }
  });

  const promptText = `${userRulesBlock}Interviewer (Current Audio): ${query}${kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  const contentParts: any[] = [{ type: 'text', text: promptText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  const text = await proxyRequest('/chat/xai', { messages });
  return (text.trim() === '...' || text.trim().toLowerCase() === 'listening...') ? 'Listening...' : text;
}

export async function generateGroq(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean
): Promise<string> {
  const { systemInstruction, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const chatHistoryText = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
    .join('\n');

  const promptText = `${userRulesBlock}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}${kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;

  const contentParts: any[] = [{ type: 'text', text: promptText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));

  const messages: any[] = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: contentParts },
  ];

  const text = await proxyRequest('/chat/groq', { messages });
  return text.trim() === '...' ? 'Listening...' : text;
}

// ─────────────────────────────────────────────────────────────
//  STREAMING PUBLIC API — same arguments as the generate*
//  functions, plus an `onToken` callback that is called for
//  every incoming chunk. The resolved promise is the final
//  full text so callers can persist it to the DB as one row.
// ─────────────────────────────────────────────────────────────

export async function streamGemini(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal, isAutoSolve?: boolean
): Promise<string> {
  let systemInstruction: string;
  let prompt: string;
  if (isAutoSolve) {
    // No history, no rules block, no "Interviewer (Current Audio)" framing —
    // just the raw task. Anything else pulls the model back toward the
    // chatty candidate persona we explicitly want to escape here.
    systemInstruction = buildAutoSolveSystemInstruction();
    prompt = query;
  } else {
    const { systemInstruction: si, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);
    systemInstruction = si;
    const chatHistoryText = history
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
      .join('\n');
    prompt = `${userRulesBlock}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}${kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  }

  const fileParts = contextFiles
    .filter(f => f.base64 && f.mimeType)
    .map(f => ({ mimeType: f.mimeType!, data: f.base64! }));

  const full = await proxyStream('/stream/gemini', { prompt, systemInstruction, fileParts }, onToken, signal);
  // Auto-solve never emits "..." — skip the listening rewrite so a short
  // code response can't be misinterpreted as a noise-gate hit.
  if (isAutoSolve) return full;
  return full.trim() === '...' ? 'Listening...' : full;
}

export async function streamOpenAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal, isAutoSolve?: boolean
): Promise<string> {
  let systemInstruction: string;
  let userText: string;
  if (isAutoSolve) {
    systemInstruction = buildAutoSolveSystemInstruction();
    userText = query;
  } else {
    const { systemInstruction: si, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);
    systemInstruction = si;
    userText = `${userRulesBlock}${query}${kbHint}\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  }

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const messages: any[] = [{ role: 'system', content: systemInstruction }];
  // In auto-solve mode the conversation history is irrelevant — and worse,
  // any prior chatty candidate-persona turns drag the model right back into
  // the wrong register. Only include history for normal mode.
  if (!isAutoSolve) {
    history.forEach(m => {
      if (m.role !== 'system') {
        messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
      }
    });
  }

  const contentParts: any[] = [{ type: 'text', text: userText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  // Stream path mirrors generateOpenAI — user's reasoning_effort flows
  // through; server enforces tier gate via JWT.
  const full = await proxyStream(
    '/stream/openai',
    { messages, reasoning_effort: getReasoningEffort() },
    onToken,
    signal,
  );
  if (isAutoSolve) return full;
  return (full.trim() === '...' || full.trim().toLowerCase() === 'listening...') ? 'Listening...' : full;
}

export async function streamXAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal, isAutoSolve?: boolean
): Promise<string> {
  let systemInstruction: string;
  let promptText: string;
  if (isAutoSolve) {
    systemInstruction = buildAutoSolveSystemInstruction();
    promptText = query;
  } else {
    const { systemInstruction: si, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);
    systemInstruction = si;
    promptText = `${userRulesBlock}Interviewer (Current Audio): ${query}${kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  }

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const messages: any[] = [{ role: 'system', content: systemInstruction }];
  if (!isAutoSolve) {
    history.forEach(m => {
      if (m.role !== 'system') {
        messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
      }
    });
  }
  const contentParts: any[] = [{ type: 'text', text: promptText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  const full = await proxyStream('/stream/xai', { messages }, onToken, signal);
  if (isAutoSolve) return full;
  return (full.trim() === '...' || full.trim().toLowerCase() === 'listening...') ? 'Listening...' : full;
}

export async function streamGroq(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal, isAutoSolve?: boolean
): Promise<string> {
  let systemInstruction: string;
  let promptText: string;
  if (isAutoSolve) {
    systemInstruction = buildAutoSolveSystemInstruction();
    promptText = query;
  } else {
    const { systemInstruction: si, userRulesBlock, kbHint } = await prepareStreamPrompts(contextFiles, generalMode);
    systemInstruction = si;
    const chatHistoryText = history
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
      .join('\n');
    promptText = `${userRulesBlock}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}${kbHint}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  }

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const contentParts: any[] = [{ type: 'text', text: promptText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));

  const messages: any[] = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: contentParts },
  ];

  const full = await proxyStream('/stream/groq', { messages }, onToken, signal);
  if (isAutoSolve) return full;
  return full.trim() === '...' ? 'Listening...' : full;
}

// Claude (Anthropic Sonnet 4.6) lives in its own file —
// services/claudeService.ts — so the persona pipeline can layer
// WEB SEARCH instructions on top of the shared prompt builders
// without touching the other models, and so identity extraction
// can run through Claude itself instead of /chat/openai.

// ─────────────────────────────────────────────────────────────
//  CONVERSATION AUTO-TITLE
//
//  Called once per session, after the first model response, to
//  replace the placeholder "Interview <date>" / first-user-message
//  title with a 2-5 word topic summary — same UX as ChatGPT's
//  "auto-rename based on conversation" behavior. Fire-and-forget;
//  if the LLM call fails the existing placeholder name stays.
//
//  Cheap by design: short prompt, low max_tokens, OpenAI mini-class.
//  Routed through /chat/openai so it inherits the server's API key
//  + auth + idempotency without a dedicated route.
// ─────────────────────────────────────────────────────────────
export async function generateConversationTitle(
  messages: Pick<Message, 'role' | 'content'>[],
): Promise<string | null> {
  try {
    const transcript = messages
      .filter(m => m.role === 'user' || m.role === 'model')
      .slice(0, 6)  // first 6 turns is plenty to identify the topic
      .map(m => `${m.role === 'user' ? 'Interviewer' : 'Candidate'}: ${m.content}`)
      .join('\n')
      .slice(0, 4000);
    if (!transcript.trim()) return null;
    const prompt = `Summarize the topic of this interview conversation in 2-5 words. Output only the title — no quotes, no period, no preamble. Title-case.

${transcript}`;
    // Internal titling — fixed reasoning_effort so a Max user on 'high'
    // doesn't pay 25s of GPT-thinking just to name a session.
    const text = await proxyRequest('/chat/openai', {
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: 'low',
    });
    // Strip quotes, trailing punctuation, surrounding whitespace, "Title:"
    // prefixes some models emit despite the instruction.
    const cleaned = text
      .replace(/^["'""']+|["'""']+$/g, '')
      .replace(/^(title|topic):\s*/i, '')
      .replace(/[.!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (cleaned.length < 3) return null;
    return cleaned;
  } catch {
    // Fire-and-forget — never break the interview because a side
    // titling call failed.
    return null;
  }
}

// AI-planned Auto-Type. Renderer reads the focused editor's text + cursor
// via UIA, sends both + the code to type to /autotype-plan, gets back a
// JSON plan from Claude Haiku 4.5. Returns null on any failure — caller
// must fall back to the deterministic UIA / OCR planning path. Best-effort
// — never throw, never block the Auto-Type cycle.
export interface AutoTypeAIPlan {
  ok: true;
  wipe_first_line: boolean;
  skip_leading: number;
  skip_trailing: number;
  confidence: number;
  reasoning: string;
}

export async function getAutoTypePlan(args: {
  editorText: string;
  cursorOffset: number;
  code: string;
  language: string;
  signal?: AbortSignal;
}): Promise<AutoTypeAIPlan | null> {
  try {
    const token = licenseService.getToken();
    if (!token) return null;
    const res = await fetch(`${API_BASE}/api/v1/ai/autotype-plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        editorText: args.editorText,
        cursorOffset: args.cursorOffset,
        code: args.code,
        language: args.language,
      }),
      signal: args.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    return data as AutoTypeAIPlan;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  CONVERSATION SYNC — push local messages to server for admin
//  visibility + cross-device persistence
// ─────────────────────────────────────────────────────────────
//
//  The Electron client stores chat history in a per-machine SQLite (see
//  electron/database.cjs). Without sync, those messages live only on the
//  device and admin support has no way to see what a user actually saw —
//  blocking incident response, billing-dispute review, and UX research
//  on real interview transcripts.
//
//  We push EACH message to /api/v1/conversations/:id/sync immediately
//  after the local write. The /sync endpoint auto-creates the conversation
//  on first call, batches messages by id (idempotent — re-uploading the
//  same message id is a no-op), and is auth-gated to the calling user
//  (server-side: only the owner's user_id can write to the conversation;
//  admins read via /admin/users/:id which already pulls these tables).
//
//  Privacy boundaries:
//    - Only ADMINS can read other users' conversations (adminOnly middleware
//      on /api/v1/admin/users/:id, plus stepUpOnly for destructive actions).
//    - Every admin view is audit-logged (writeAudit('view-user-detail', ...)).
//    - Sync is best-effort: a failed POST never blocks the UI or surfaces
//      an error to the candidate mid-interview.
//    - Currently no per-user opt-out — if we add one later, gate this call
//      on a user.privacy.disable_cloud_sync flag.
// ── Sync retry queue ───────────────────────────────────────────────────
// Conversation sync used to be pure fire-and-forget: a network blip or
// transient 5xx silently dropped the message from the cloud copy (local
// sqlite was fine, admin dashboard was not). This queue persists failed
// payloads to localStorage and drains on the next successful sync — so the
// admin's view eventually catches up without burdening the candidate UI.
//
// Drop policy:
//   - 401 → don't enqueue (auth issue, retry won't help until next login).
//   - 400 → don't enqueue (server rejected payload; retrying won't fix it).
//   - 5xx / network error → enqueue, drain on next success.
// Cap: SYNC_QUEUE_MAX entries. Oldest dropped on overflow so a long offline
// run doesn't unbounded-grow localStorage.
const SYNC_QUEUE_KEY = '__conv_sync_queue_v1__';
const SYNC_QUEUE_MAX = 500;
const SYNC_QUEUE_MAX_RETRIES = 8;

interface SyncQueueEntry {
  sessionId: string;
  body: { name: string; messages: any[] };
  enqueuedAt: number;
  retries: number;
}

function readQueue(): SyncQueueEntry[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeQueue(entries: SyncQueueEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    // Trim oldest first if over cap.
    const trimmed = entries.length > SYNC_QUEUE_MAX
      ? entries.slice(entries.length - SYNC_QUEUE_MAX)
      : entries;
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage full or disabled — last resort, drop the queue. The
    // local sqlite copy is still authoritative; only cloud mirror is lost.
  }
}

function enqueueSync(entry: Omit<SyncQueueEntry, 'enqueuedAt' | 'retries'> & { retries?: number }): void {
  const queue = readQueue();
  queue.push({
    sessionId: entry.sessionId,
    body: entry.body,
    enqueuedAt: Date.now(),
    retries: entry.retries ?? 0,
  });
  writeQueue(queue);
}

// Single sync attempt. Returns:
//   - { ok: true } on 2xx
//   - { ok: false, retriable: true } on network error or 5xx
//   - { ok: false, retriable: false } on 4xx (don't queue)
async function attemptSync(sessionId: string, body: { name: string; messages: any[] }, token: string):
  Promise<{ ok: boolean; retriable: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversations/${encodeURIComponent(sessionId)}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, retriable: false };
    // 401 = auth — retrying with same token won't help. Drop, surface in console.
    // 400/403/404 = bad payload or revoked access — drop.
    if (res.status >= 400 && res.status < 500) return { ok: false, retriable: false };
    // 5xx = server-side, retry later.
    return { ok: false, retriable: true };
  } catch {
    // Network failure (offline, DNS, TLS) — retriable.
    return { ok: false, retriable: true };
  }
}

// Drain the persisted queue. Called after every successful sync, on module
// load, and on `online` events. Single-flight via a module-level guard so
// concurrent drains don't double-send.
let drainInFlight = false;
async function drainSyncQueue(): Promise<void> {
  if (drainInFlight) return;
  const token = licenseService.getToken();
  if (!token) return; // wait until we're logged in again
  const queue = readQueue();
  if (queue.length === 0) return;
  drainInFlight = true;
  try {
    const remaining: SyncQueueEntry[] = [];
    for (const entry of queue) {
      // Bound retries so a permanently-failing payload doesn't block the
      // queue forever. After SYNC_QUEUE_MAX_RETRIES we give up and drop —
      // the local copy is still safe; only the cloud mirror is lost for
      // this one message.
      if (entry.retries >= SYNC_QUEUE_MAX_RETRIES) continue;
      const result = await attemptSync(entry.sessionId, entry.body, token);
      if (result.ok) continue; // successfully drained
      if (!result.retriable) continue; // server rejected — drop
      remaining.push({ ...entry, retries: entry.retries + 1 });
    }
    writeQueue(remaining);
  } finally {
    drainInFlight = false;
  }
}

// Drain on module load (covers app restart with a queued backlog) and on
// network-recovery. We don't drain on token refresh — the next user-driven
// sync naturally triggers it via attemptSync's success path.
if (typeof window !== 'undefined') {
  // Defer so we don't fight with the licenseService boot sequence.
  setTimeout(() => { drainSyncQueue().catch(() => {}); }, 2000);
  window.addEventListener('online', () => { drainSyncQueue().catch(() => {}); });
}

export async function syncConversationMessage(args: {
  sessionId: string;
  sessionName: string;
  message: { id: string; role: string; content: string; timestamp: number };
}): Promise<void> {
  if (!args.sessionId || !args.message?.id || !args.message?.content) return;
  const token = licenseService.getToken();
  if (!token) return; // not signed in — skip silently

  // Server roles are 'user' / 'assistant' / 'system'. Renderer uses
  // 'model' for AI responses (legacy from Gemini SDK terminology).
  const normalizedRole = args.message.role === 'model' ? 'assistant' : args.message.role;

  const body = {
    name: args.sessionName || 'Interview session',
    messages: [{
      id: args.message.id,
      role: normalizedRole,
      content: args.message.content,
      timestamp: args.message.timestamp || Date.now(),
    }],
  };

  const result = await attemptSync(args.sessionId, body, token);
  if (result.ok) {
    // Opportunistically drain anything that piled up while we were offline.
    drainSyncQueue().catch(() => {});
    return;
  }
  if (result.retriable) {
    enqueueSync({ sessionId: args.sessionId, body });
  }
  // Non-retriable failures are dropped — local sqlite still has the message.
}

// Sync just a conversation rename (no messages). Used when the auto-titler
// or user's manual rename updates the session label, so admin sees the
// up-to-date title in their dashboard.
export async function syncConversationRename(args: {
  sessionId: string;
  newName: string;
}): Promise<void> {
  if (!args.sessionId || !args.newName) return;
  const token = licenseService.getToken();
  if (!token) return;
  const body = { name: args.newName, messages: [] as any[] };
  const result = await attemptSync(args.sessionId, body, token);
  if (result.ok) {
    drainSyncQueue().catch(() => {});
    return;
  }
  if (result.retriable) {
    enqueueSync({ sessionId: args.sessionId, body });
  }
}

// Backfill: upload ALL local conversations + messages to the server.
// Useful one-shot tool to populate the admin dashboard for users who had
// pre-existing local-only sessions before the per-message sync was wired
// in. Idempotent — re-running is safe (server's /sync upserts by message id).
//
// Reports per-session progress via callback so the UI can show "Syncing
// X of Y" instead of an opaque spinner. Failures on individual sessions
// are counted but don't abort the loop — partial sync is still useful.
export interface BackfillProgress {
  done: number;
  total: number;
  current: string;
  synced: number;
  failed: number;
}

export interface BackfillResult {
  success: boolean;
  synced: number;
  failed: number;
  message: string;
}

export async function backfillAllConversations(
  userId: string,
  onProgress: (state: BackfillProgress) => void,
): Promise<BackfillResult> {
  if (typeof window === 'undefined' || !window.electronAPI?.invoke) {
    return { success: false, synced: 0, failed: 0, message: 'Backfill is only available in the desktop app' };
  }
  const token = licenseService.getToken();
  if (!token) return { success: false, synced: 0, failed: 0, message: 'Not signed in' };
  if (!userId) return { success: false, synced: 0, failed: 0, message: 'No user id available' };

  let synced = 0;
  let failed = 0;

  try {
    const sessions = await window.electronAPI.invoke<any[]>('db:list-sessions', userId);
    const list = Array.isArray(sessions) ? sessions : [];
    if (list.length === 0) {
      return { success: true, synced: 0, failed: 0, message: 'No local conversations found' };
    }

    onProgress({ done: 0, total: list.length, current: list[0]?.name || '', synced: 0, failed: 0 });

    for (let i = 0; i < list.length; i++) {
      const session = list[i];
      onProgress({
        done: i,
        total: list.length,
        current: session.name || 'Untitled',
        synced,
        failed,
      });

      try {
        const messagesRaw = await window.electronAPI.invoke<any[]>('db:get-messages', session.id);
        const messages = Array.isArray(messagesRaw) ? messagesRaw : [];

        // Normalize to server schema. Drop empty messages — server requires content.
        const batch = messages.map(m => ({
          id: String(m.id),
          role: m.role === 'model' ? 'assistant' : String(m.role || 'user'),
          content: String(m.content || ''),
          timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        })).filter(m => m.content);

        const res = await fetch(`${API_BASE}/api/v1/conversations/${encodeURIComponent(session.id)}/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: session.name || 'Interview session',
            messages: batch,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        synced++;
      } catch (e) {
        console.warn('[backfill] session sync failed:', session.id, e);
        failed++;
      }
    }

    onProgress({ done: list.length, total: list.length, current: '', synced, failed });
    return {
      success: failed === 0,
      synced,
      failed,
      message: failed === 0
        ? `Synced ${synced} conversation${synced === 1 ? '' : 's'} to the cloud`
        : `Synced ${synced}, ${failed} failed (will retry next time you click)`,
    };
  } catch (err: any) {
    return {
      success: false,
      synced,
      failed,
      message: err?.message || 'Backfill failed',
    };
  }
}

export async function getDeepgramKey(): Promise<string> {
  const token = licenseService.getToken();
  if (!token) throw new Error('Not authenticated');

  const response = await fetch(`${API_BASE}/api/v1/ai/deepgram-key`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) throw new Error('Failed to get Deepgram key');
  const data = await response.json();
  return data.key;
}
