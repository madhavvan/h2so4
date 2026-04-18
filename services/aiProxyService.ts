// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY SERVICE — Routes all AI calls through the server
//  API keys are stored server-side, never exposed to the client
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { licenseService } from './licenseService';
import { Message, ContextFile } from '../types';

const API_BASE = 'https://h2so4-production.up.railway.app';

// ── Retry configuration for resilient AI requests ──
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function proxyRequest(endpoint: string, body: any): Promise<string> {
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

async function proxyStream(
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

function buildSystemInstruction(textContext: string, generalMode: boolean): string {
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
function buildUserRulesBlock(): string {
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
- System design: 3-5 sentences. Shape → trade-off → one thing you'd defer.
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
- No tricolons ("efficient, scalable, and maintainable"). At most one adjective per noun.
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

function buildGeminiSystemInstruction(textContext: string, generalMode: boolean): string {
  return buildSystemInstruction(textContext, generalMode);
}

function buildOpenAISystemInstruction(textContext: string, generalMode: boolean): string {
  return buildSystemInstruction(textContext, generalMode);
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

function buildAutoSolveSystemInstruction(): string {
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
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = buildGeminiSystemInstruction(textContext, generalMode);

  const chatHistoryText = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
    .join('\n');

  const prompt = `${buildUserRulesBlock()}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;

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
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = buildOpenAISystemInstruction(textContext, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const messages: any[] = [{ role: 'system', content: systemInstruction }];
  history.forEach(m => {
    if (m.role !== 'system') {
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }
  });

  const contentParts: any[] = [{ type: 'text', text: `${buildUserRulesBlock()}` + (generalMode ? query : `${query}\n\n[Remember: draw from the Knowledge Base where relevant.]`) + `\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.` }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  const text = await proxyRequest('/chat/openai', { messages });
  return (text.trim() === '...' || text.trim().toLowerCase() === 'listening...') ? 'Listening...' : text;
}

export async function generateXAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean
): Promise<string> {
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = buildGeminiSystemInstruction(textContext, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const messages: any[] = [{ role: 'system', content: systemInstruction }];
  history.forEach(m => {
    if (m.role !== 'system') {
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }
  });

  const promptText = `${buildUserRulesBlock()}Interviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  const contentParts: any[] = [{ type: 'text', text: promptText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  const text = await proxyRequest('/chat/xai', { messages });
  return (text.trim() === '...' || text.trim().toLowerCase() === 'listening...') ? 'Listening...' : text;
}

export async function generateGroq(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean
): Promise<string> {
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = buildGeminiSystemInstruction(textContext, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const chatHistoryText = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
    .join('\n');

  const promptText = `${buildUserRulesBlock()}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;

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
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = isAutoSolve
    ? buildAutoSolveSystemInstruction()
    : buildGeminiSystemInstruction(textContext, generalMode);

  let prompt: string;
  if (isAutoSolve) {
    // No history, no rules block, no "Interviewer (Current Audio)" framing —
    // just the raw task. Anything else pulls the model back toward the
    // chatty candidate persona we explicitly want to escape here.
    prompt = query;
  } else {
    const chatHistoryText = history
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
      .join('\n');
    prompt = `${buildUserRulesBlock()}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
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
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = isAutoSolve
    ? buildAutoSolveSystemInstruction()
    : buildOpenAISystemInstruction(textContext, generalMode);

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

  const userText = isAutoSolve
    ? query
    : `${buildUserRulesBlock()}` + (generalMode ? query : `${query}\n\n[Remember: draw from the Knowledge Base where relevant.]`) + `\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  const contentParts: any[] = [{ type: 'text', text: userText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  const full = await proxyStream('/stream/openai', { messages }, onToken, signal);
  if (isAutoSolve) return full;
  return (full.trim() === '...' || full.trim().toLowerCase() === 'listening...') ? 'Listening...' : full;
}

export async function streamXAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal, isAutoSolve?: boolean
): Promise<string> {
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = isAutoSolve
    ? buildAutoSolveSystemInstruction()
    : buildGeminiSystemInstruction(textContext, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const messages: any[] = [{ role: 'system', content: systemInstruction }];
  if (!isAutoSolve) {
    history.forEach(m => {
      if (m.role !== 'system') {
        messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
      }
    });
  }

  const promptText = isAutoSolve
    ? query
    : `${buildUserRulesBlock()}Interviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
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
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = isAutoSolve
    ? buildAutoSolveSystemInstruction()
    : buildGeminiSystemInstruction(textContext, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  let promptText: string;
  if (isAutoSolve) {
    promptText = query;
  } else {
    const chatHistoryText = history
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
      .join('\n');
    promptText = `${buildUserRulesBlock()}${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
  }

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
