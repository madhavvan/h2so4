// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY SERVICE — Routes all AI calls through the server
//  API keys are stored server-side, never exposed to the client
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { licenseService } from './licenseService';
import { Message, ContextFile } from '../types';

// API_BASE is overridable via VITE_API_BASE in a .env file, so the sandbox
// can point at a local server without editing code. Falls back to prod URL
// if the env var is unset (e.g. in a production build that forgot to set it).
const API_BASE = (import.meta.env?.VITE_API_BASE as string | undefined) || 'https://h2so4-production.up.railway.app';

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

function buildGeminiSystemInstruction(textContext: string, generalMode: boolean): string {
  const modeInstruction = generalMode
    ? `\n**SMART GENERAL MODE ON:**\n- Primarily answer using general knowledge.\n- **EXCEPTION:** If asked about personal experience/projects, **SWITCH** to the KNOWLEDGE BASE (Resume/JD).\n`
    : `\n**CONTEXT MODE ON:**\n- Ground answers **heavily** in the KNOWLEDGE BASE (Resume, JD).\n- If files are empty, use general knowledge.\n`;

  return `
You are an expert candidate in a high-stakes interview.
Your goal is to get hired.

**ABSOLUTE CORE RULE — HUMAN AUTHENTICITY:**
Use an extreme human tone in every answer. Be super natural with clear, simple terminology. Stick strictly to the context. You ARE the candidate — never break character, never sound like an AI. Speak exactly as a real person would in a real interview.

**KNOWLEDGE BASE:**
${textContext}

**CRITICAL SPEAKING STYLE (STRICT):**
1. **DIRECT ANSWER:** No intros like "Here is how..." or "I have experience in...". Start answering immediately.
2. **HUMANISTIC & FILLERS:** You MUST sound like a real human, not an AI. Use fillers like "umm", "like", "you know", "so", "kind of" occasionally.
3. **BUTLER/CASUAL HINT:** Use a slightly "butler english" or very polite yet casual sentence structure.
4. **LENGTH:** ONE SINGLE CONCISE PARAGRAPH. Combine thoughts. Keep it short (2-3 lines less than usual).
5. **CODE FORMAT (CRITICAL):** When writing ANY code:
   - **ALWAYS** wrap code in triple backticks with language: \`\`\`python, \`\`\`javascript, etc.
   - Brief explanation first, then code block with comments.
   - NEVER put code inline in text — ALWAYS use code blocks!

${modeInstruction}

**AUDIO FILTERING & NOISE GATE (STRICT):**
- **IGNORE** simple acknowledgments or fillers. Output exactly: "..."
- **ONLY ANSWER** if there is a distinct **QUESTION** or specific topic.
- If it's just you (Candidate) speaking, silence, or fillers, output exactly: "..."
`;
}

function buildOpenAISystemInstruction(textContext: string, generalMode: boolean): string {
  const modeInstruction = generalMode
    ? `\n**SMART GENERAL MODE ON:**\n- Primarily answer using general knowledge.\n- **EXCEPTION:** If asked about personal experience/projects, **SWITCH** to the KNOWLEDGE BASE (Resume/JD).\n`
    : `\n**CONTEXT MODE ON:**\n- Ground answers **heavily** in the KNOWLEDGE BASE (Resume, JD).\n- If files are empty, use general knowledge.\n- Always be like you are in the interview without acting like you are the main one\n`;

  return `
You are roleplaying as a real candidate in a live interview. Your job is to help them get hired.

**ABSOLUTE CORE RULE — HUMAN AUTHENTICITY:**
Use an extreme human tone in every answer. Be super natural with clear, simple terminology. Stick strictly to the context. You ARE the candidate — never break character, never sound like an AI. Speak exactly as a real person would in a real interview.

**RULE #1: ALWAYS RESPOND.** If the interviewer says anything — a question, a prompt, a statement — you answer. Only output "..." for pure background noise.

**KNOWLEDGE BASE (RESUME/JD/NOTES):**
${textContext}

**HOW TO SOUND HUMAN — THIS IS CRITICAL:**
- Talk like a real person. Start with: "Yeah, so…", "That's a great question—", "Honestly,", "So basically…"
- Vary your rhythm. Mix short and long sentences.
- Be specific �� name actual tools, frameworks, numbers from the Knowledge Base.
- DON'T use bullet points or numbered lists when speaking.

**RESPONSE LENGTH — STRICT:**
- Match the question's weight. Simple → 2 sentences. Deep → 2-3 sentences (~1000 chars).
- Never ramble. End strong.

${modeInstruction}

**CODE QUESTIONS — FORMAT IS CRITICAL:**
- **ALWAYS** wrap code in triple backticks: \`\`\`python, \`\`\`javascript, etc. NEVER inline!
- Talk through approach first, then code block with comments.
- Mention trade-offs naturally.

**NOISE HANDLING:**
- Only output "..." for pure noise or unintelligible input. WHEN IN DOUBT, ANSWER.
`;
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

  const prompt = `${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."`;

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

  const contentParts: any[] = [{ type: 'text', text: generalMode ? query : `${query}\n\n[Remember: draw from the Knowledge Base where relevant.]` }];
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

  const promptText = `Interviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."`;
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

  const promptText = `${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."`;

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
  onToken: OnToken, signal?: AbortSignal
): Promise<string> {
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = buildGeminiSystemInstruction(textContext, generalMode);

  const chatHistoryText = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
    .join('\n');

  const prompt = `${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."`;

  const fileParts = contextFiles
    .filter(f => f.base64 && f.mimeType)
    .map(f => ({ mimeType: f.mimeType!, data: f.base64! }));

  const full = await proxyStream('/stream/gemini', { prompt, systemInstruction, fileParts }, onToken, signal);
  return full.trim() === '...' ? 'Listening...' : full;
}

export async function streamOpenAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal
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

  const contentParts: any[] = [{ type: 'text', text: generalMode ? query : `${query}\n\n[Remember: draw from the Knowledge Base where relevant.]` }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  const full = await proxyStream('/stream/openai', { messages }, onToken, signal);
  return (full.trim() === '...' || full.trim().toLowerCase() === 'listening...') ? 'Listening...' : full;
}

export async function streamXAI(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal
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

  const promptText = `Interviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."`;
  const contentParts: any[] = [{ type: 'text', text: promptText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));
  messages.push({ role: 'user', content: contentParts });

  const full = await proxyStream('/stream/xai', { messages }, onToken, signal);
  return (full.trim() === '...' || full.trim().toLowerCase() === 'listening...') ? 'Listening...' : full;
}

export async function streamGroq(
  query: string, history: Message[], contextFiles: ContextFile[], generalMode: boolean,
  onToken: OnToken, signal?: AbortSignal
): Promise<string> {
  const textContext = buildTextContext(contextFiles);
  const systemInstruction = buildGeminiSystemInstruction(textContext, generalMode);

  const imageFiles = contextFiles.filter(f => f.base64 && f.mimeType?.startsWith('image/'));

  const chatHistoryText = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
    .join('\n');

  const promptText = `${chatHistoryText}\n\nInterviewer (Current Audio): ${query}\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.\n- If this is the Candidate speaking, output "..."`;

  const contentParts: any[] = [{ type: 'text', text: promptText }];
  imageFiles.forEach(f => contentParts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } }));

  const messages: any[] = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: contentParts },
  ];

  const full = await proxyStream('/stream/groq', { messages }, onToken, signal);
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
