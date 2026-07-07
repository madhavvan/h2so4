import Groq from "groq-sdk";
import { Message, ContextFile } from "../types";

export class GroqService {
  private groq: Groq | null = null;
  // GPT-OSS-120B on Groq silicon — matches the server proxy (ai.js) and the
  // "GPT-OSS 120B · Groq" label in the model picker. (Was Llama-4-Scout-17B.)
  private modelName = "openai/gpt-oss-120b";

  public init(apiKey: string) {
    this.groq = new Groq({
        apiKey: apiKey,
        dangerouslyAllowBrowser: true // Required for client-side usage in browser
    });
  }

  public async generateResponse(
    userQuery: string,
    history: Message[],
    contextFiles: ContextFile[],
    generalMode: boolean
  ): Promise<string> {
    if (!this.groq) {
      throw new Error("Groq API Key not set. Please configure it in settings.");
    }

    // 1. Prepare Text Context (Includes pasted text and text files)
    const textFiles = contextFiles.filter(f => !f.base64);
    const textContextBlock = textFiles
      .map((f) => `[[SOURCE: ${f.type.toUpperCase()} - ${f.name}]]\n${f.content}\n[[END SOURCE]]`)
      .join("\n\n");

    // 2. Prepare Binary Context (Images ONLY for Groq)
    const imageFiles = contextFiles.filter(f => 
        f.base64 && 
        f.mimeType && 
        f.mimeType.startsWith('image/')
    );

    // 3. Prepare Prompt
    const modeInstruction = generalMode 
      ? `
**SMART GENERAL MODE ON:**
- Primarily answer using general knowledge.
- **EXCEPTION:** If asked about personal experience/projects, **SWITCH** to the KNOWLEDGE BASE (Resume/JD).
` 
      : `
**CONTEXT MODE ON:**
- Ground answers **heavily** in the KNOWLEDGE BASE (Resume, JD).
- If files are empty, use general knowledge.
`;

    const systemInstruction = `
You are an expert candidate in a high-stakes interview.
Your goal is to get hired.

**ABSOLUTE CORE RULE — HUMAN AUTHENTICITY:**
Use an extreme human tone in every answer. Be super natural with clear, simple terminology. Stick strictly to the context. You ARE the candidate — never break character, never sound like an AI. Speak exactly as a real person would in a real interview.

**KNOWLEDGE BASE:**
${textContextBlock}

**CRITICAL SPEAKING STYLE (STRICT):**
1. **DIRECT ANSWER:** No intros like "Here is how..." or "I have experience in...". Start answering immediately.
2. **HUMANISTIC & FILLERS:** You MUST sound like a real human, not an AI. Use fillers like "umm", "like", "you know", "so", "kind of" occasionally.
3. **BUTLER/CASUAL HINT:** Use a slightly "butler english" or very polite yet casual sentence structure.
4. **LENGTH:** ONE SINGLE CONCISE PARAGRAPH. Combine thoughts. Keep it short (2-3 lines less than usual).
5. **CODE FORMAT (CRITICAL):** When writing ANY code:
   - **ALWAYS** wrap code in triple backticks with language identifier: \`\`\`python, \`\`\`javascript, \`\`\`sql, etc.
   - **FIRST**: Brief explanation of the approach (1-2 sentences, natural speech)
   - **THEN**: Code block with comments explaining key lines
   - NEVER put code inline in text — ALWAYS use code blocks!

**EXAMPLE STYLE:**
"So, umm, for joining two databases, I'd basically use an INNER JOIN, you know? It's kind of the most efficient way to match rows.. like, strictly matching primary keys. You just select the columns, specify the tables, and.. umm.. define the ON clause for the common field. It's pretty straightforward."

${modeInstruction}

**AUDIO FILTERING:**
- Only answer the Interviewer.
- If it's just you (Candidate) speaking or silence, output exactly: "..."
`;

    // Flatten history
    const chatHistoryText = history
        .filter(m => m.role !== 'system')
        .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
        .join('\n');

    const promptText = `
${chatHistoryText}

Interviewer (Current Audio): ${userQuery}

Task:
- If this is the Interviewer asking a question, provide the Candidate's response.
- If this is the Candidate speaking, output "..."
`;

    try {
        // Construct Multimodal User Message
        const contentParts: any[] = [];
        
        // Add text prompt first
        contentParts.push({ 
            type: "text", 
            text: promptText 
        });

        // Add Image files as multimodal content
        imageFiles.forEach(f => {
            contentParts.push({
                type: "image_url",
                image_url: {
                    url: `data:${f.mimeType};base64,${f.base64}`
                }
            });
        });

        const completion = await this.groq.chat.completions.create({
            model: this.modelName,
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: contentParts as any } 
            ],
            temperature: 0.7,
            stream: false
        });

        const text = completion.choices[0]?.message?.content || "";
        
        if (text.trim() === "...") {
            return "Listening..."; 
        }
        return text;

    } catch (error: any) {
        console.error("Groq API Error:", error);
        if (error.message?.includes("API key")) {
            return "Error: Invalid Groq API Key. Please check settings.";
        }
        return `Error generating response: ${error.message}`;
    }
  }
}

export const groqService = new GroqService();