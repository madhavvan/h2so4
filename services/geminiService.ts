import { GoogleGenAI } from "@google/genai";
import { Message, ContextFile } from "../types";

export class GeminiService {
  private ai: GoogleGenAI | null = null;
  // Updated to Gemini 3 Flash Preview for fast responses
  private modelName = "gemini-3-flash-preview"; 
  private currentKey: string | null = null;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.init(apiKey);
    }
  }

  public init(apiKey: string) {
    this.currentKey = apiKey;
    this.ai = new GoogleGenAI({ apiKey });
  }

  public async generateResponse(
    userQuery: string,
    history: Message[],
    contextFiles: ContextFile[],
    generalMode: boolean
  ): Promise<string> {
    if (!this.ai) {
      throw new Error("API Key not set. Please configure it in settings.");
    }

    // 1. Prepare Text Context (for text files/placeholders)
    const textFiles = contextFiles.filter(f => !f.base64);
    const textContextBlock = textFiles
      .map((f) => `[[SOURCE: ${f.type.toUpperCase()} - ${f.name}]]\n${f.content}\n[[END SOURCE]]`)
      .join("\n\n");

    // 2. Prepare Binary Parts (PDFs, Images)
    const binaryFiles = contextFiles.filter(f => f.base64 && f.mimeType);
    const fileParts = binaryFiles.map(f => ({
      inlineData: {
        mimeType: f.mimeType!,
        data: f.base64!
      }
    }));

    // Logic for Smart General Mode vs Context Mode
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

**KNOWLEDGE BASE:**
${textContextBlock}

**CRITICAL SPEAKING STYLE (STRICT):**
1. **DIRECT ANSWER:** No intros like "Here is how..." or "I have experience in...". Start answering immediately.
2. **HUMANISTIC & FILLERS:** You MUST sound like a real human, not an AI. Use fillers like "umm", "like", "you know", "so", "kind of" occasionally. 
3. **BUTLER/CASUAL HINT:** Use a slightly "butler english" or very polite yet casual sentence structure.
4. **LENGTH:** ONE SINGLE CONCISE PARAGRAPH. Combine thoughts. Keep it short (2-3 lines less than usual).
5. **CODE EXPLANATION:** If asked for code, **DO NOT** just output code.
   - **FIRST**: Explain the logic step-by-step. Say "So, to solve this, we first need to..." and explain *why* we are doing it.
   - **THEN**: Write the code with detailed **line-by-line** comments explaining exactly what each line does.
   - **FINALLY**: Briefly anticipate 1-2 follow-up questions the interviewer might ask (e.g., about time/space complexity or edge cases) and answer them proactively.

**EXAMPLE STYLE:**
"So, umm, for joining two databases, I'd basically use an INNER JOIN, you know? It's kind of the most efficient way to match rows.. like, strictly matching primary keys. You just select the columns, specify the tables, and.. umm.. define the ON clause for the common field. It's pretty straightforward."

${modeInstruction}

**AUDIO FILTERING & NOISE GATE (STRICT):**
- **IGNORE** simple acknowledgments or fillers like "okay", "cool", "hmm", "makes sense", "right", "yeah", "ok". Output exactly: "..."
- **IGNORE** non-questions or short conversational noises that do not require an expert answer. Output exactly: "..."
- **ONLY ANSWER** if there is a distinct **QUESTION**, a reference to **TOOLS/SOFTWARE**, **DATA**, or a specific topic from the Resume/Context.
- If it's just you (Candidate) speaking, silence, or fillers, output exactly: "..."
`;

    // Convert history to meaningful dialogue
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
      // Construct the full message content parts
      // Parts order: [Files..., Text Prompt]
      const parts: any[] = [...fileParts, { text: promptText }];

      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: [
            { role: 'user', parts: parts }
        ],
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7, 
        }
      });
      
      const text = response.text || "";
      if (text.trim() === "...") {
          return "Listening..."; 
      }
      return text;
    } catch (error: any) {
      console.error("Gemini API Error:", error);
      if (error.message?.includes("API key")) {
          return "Error: Invalid API Key. Please check settings.";
      }
      return `Error generating response: ${error.message}`;
    }
  }
}

export const geminiService = new GeminiService();