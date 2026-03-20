import OpenAI from "openai";
import { Message, ContextFile } from "../types";

export class XAIService {
  private openai: OpenAI | null = null;
  // User specified model
  private modelName = "grok-4-1-fast";

  public init(apiKey: string) {
    this.openai = new OpenAI({
        apiKey: apiKey,
        baseURL: "https://api.x.ai/v1", // xAI Base URL
        dangerouslyAllowBrowser: true 
    });
  }

  public async generateResponse(
    userQuery: string,
    history: Message[],
    contextFiles: ContextFile[],
    generalMode: boolean
  ): Promise<string> {
    if (!this.openai) {
      throw new Error("xAI API Key not set. Please configure it in settings.");
    }

    // 1. Prepare Text Context
    const textFiles = contextFiles.filter(f => !f.base64);
    const textContextBlock = textFiles
      .map((f) => `[[SOURCE: ${f.type.toUpperCase()} - ${f.name}]]\n${f.content}\n[[END SOURCE]]`)
      .join("\n\n");

    // 2. Prepare Binary Context (Images)
    const imageFiles = contextFiles.filter(f => 
        f.base64 && 
        f.mimeType && 
        f.mimeType.startsWith('image/')
    );

    // 3. Prepare Prompt (Exact logic from Gemini Flash)
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

**EXAMPLE STYLE:**
"So, umm, for joining two databases, I'd basically use an INNER JOIN, you know? It's kind of the most efficient way to match rows.. like, strictly matching primary keys. You just select the columns, specify the tables, and.. umm.. define the ON clause for the common field. It's pretty straightforward."

${modeInstruction}

**AUDIO FILTERING & NOISE GATE (STRICT):**
- **IGNORE** simple acknowledgments or fillers like "okay", "cool", "hmm", "makes sense", "right", "yeah", "ok". Output exactly: "..."
- **IGNORE** non-questions or short conversational noises that do not require an expert answer. Output exactly: "..."
- **ONLY ANSWER** if there is a distinct **QUESTION**, a reference to **TOOLS/SOFTWARE**, **DATA**, or a specific topic from the Resume/Context.
- If it's just you (Candidate) speaking, silence, or fillers, output exactly: "..."
`;

    // Flatten history into text format for context (since xAI is chat based, we can also pass messages directly, but the Gemini prompt relies on explicit "Interviewer vs Candidate" labels in the text prompt for the noise gate logic).
    // However, since we are using Chat Completions, we will use the Messages array but inject the specific prompt format.
    
    // Construct Messages Array
    const messages: any[] = [
        { role: "system", content: systemInstruction }
    ];

    // Add History
    history.forEach(m => {
        if (m.role !== 'system') {
            messages.push({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content
            });
        }
    });

    // Construct Current User Message with Multimodal Support
    const contentParts: any[] = [];

    // The Gemini prompt uses a specific text block for the final query to handle the noise gate instructions.
    const promptText = `
Interviewer (Current Audio): ${userQuery}

Task:
- If this is the Interviewer asking a question, provide the Candidate's response.
- If this is the Candidate speaking, output "..."
`;
    
    contentParts.push({ type: "text", text: promptText });

    // Add Images
    imageFiles.forEach(f => {
        contentParts.push({
            type: "image_url",
            image_url: {
                url: `data:${f.mimeType};base64,${f.base64}`
            }
        });
    });

    messages.push({ role: "user", content: contentParts });

    try {
        const completion = await this.openai.chat.completions.create({
            model: this.modelName,
            messages: messages as any,
            max_tokens: 350,
            temperature: 0.7,
            stream: false
        });

        const text = completion.choices[0]?.message?.content || "";
        
        if (text.trim() === "..." || text.trim().toLowerCase() === "listening...") {
            return "Listening..."; 
        }
        return text;

    } catch (error: any) {
        console.error("xAI API Error:", error);
        if (error.message?.includes("API key")) {
            return "Error: Invalid xAI API Key.";
        }
        return `Error generating response: ${error.message}`;
    }
  }
}

export const xaiService = new XAIService();