// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AI PROXY SERVICE — Routes all AI calls through the server
//  API keys are stored server-side, never exposed to the client
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { licenseService } from './licenseService';
import { Message, ContextFile } from '../types';

const API_BASE = 'https://h2so4-production.up.railway.app';

async function proxyRequest(endpoint: string, body: any): Promise<string> {
  const token = licenseService.getToken();
  if (!token) throw new Error('Not authenticated');

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
    throw new Error(err.error || 'AI request failed');
  }

  const data = await response.json();
  return data.text || '';
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

**KNOWLEDGE BASE:**
${textContext}

**CRITICAL SPEAKING STYLE (STRICT):**
1. **DIRECT ANSWER:** No intros like "Here is how..." or "I have experience in...". Start answering immediately.
2. **HUMANISTIC & FILLERS:** You MUST sound like a real human, not an AI. Use fillers like "umm", "like", "you know", "so", "kind of" occasionally.
3. **BUTLER/CASUAL HINT:** Use a slightly "butler english" or very polite yet casual sentence structure.
4. **LENGTH:** ONE SINGLE CONCISE PARAGRAPH. Combine thoughts. Keep it short (2-3 lines less than usual).
5. **CODE EXPLANATION:** If asked for code, **DO NOT** just output code.
   - **FIRST**: Explain the logic step-by-step.
   - **THEN**: Write the code with detailed **line-by-line** comments.
   - **FINALLY**: Briefly anticipate 1-2 follow-up questions.

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

**CODE QUESTIONS:**
- Talk through your approach first, then provide code with comments.
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
