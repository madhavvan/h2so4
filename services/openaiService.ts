import OpenAI from "openai";
import { Message, ContextFile } from "../types";

export class OpenAIService {
  private openai: OpenAI | null = null;
  
  private modelName = "gpt-5.4-mini";

  public init(apiKey: string) {
    this.openai = new OpenAI({
        apiKey: apiKey,
        dangerouslyAllowBrowser: true // Required for client-side usage
    });
  }

  public async generateResponse(
    userQuery: string,
    history: Message[],
    contextFiles: ContextFile[],
    generalMode: boolean
  ): Promise<string> {
    if (!this.openai) {
      throw new Error("OpenAI API Key not set. Please configure it in settings.");
    }

    // 1. Prepare Text Context (Includes uploaded TEXT files now)
    const textFiles = contextFiles.filter(f => !f.base64);
    const textContextBlock = textFiles
      .map((f) => `[[SOURCE: ${f.type.toUpperCase()} - ${f.name}]]\n${f.content}\n[[END SOURCE]]`)
      .join("\n\n");

    // 2. Prepare Binary Context (Images)
    // Filter to keep ONLY images for Vision capabilities.
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

    // SIMPLIFIED PROMPT FOR ROBUSTNESS
    const systemInstruction = `
You are an expert candidate in a high-stakes interview.
Your goal is to get hired.

**KNOWLEDGE BASE (RESUME/JD/NOTES):**
${textContextBlock}

**CORE INSTRUCTIONS:**
1. **ALWAYS ANSWER:** If the input is a question, statement, or request (even short ones like "tell me about yourself"), YOU MUST PROVIDE A RESPONSE.
2. **STYLE:** Natural, conversational, expert. Use fillers ("umm", "like", "you know") to sound human.
3. **LENGTH:** Concise paragraph (2-3 sentences).
4. **NOISE HANDLING:** Only output "..." if the input is explicitly purely background noise, a standalone filler (like just "ok" with no other text), or something you cannot respond to (like static). WHEN IN DOUBT, ANSWER.

${modeInstruction}

**CODE QUESTIONS:**
- Explain logic first ("So, basically we need to...").
- Then provide code with comments.
`;

    // Flatten history
    const messages: any[] = [
        { role: "system", content: systemInstruction }
    ];

    history.forEach(m => {
        if (m.role !== 'system') {
            messages.push({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content
            });
        }
    });

    // Construct Current Message
    const contentParts: any[] = [];
    
    // REINFORCE CONTEXT IN USER PROMPT FOR ATTENTION
    const promptWithReinforcement = `Interviewer asked: "${userQuery}"\n(Answer as the Candidate using the Knowledge Base)`;
    
    contentParts.push({ type: "text", text: promptWithReinforcement });

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
            max_completion_tokens: 16000,
            temperature: 0.6,
            stream: false
        });

        const text = completion.choices[0]?.message?.content || "";
        
        // Strict check for "..." response
        if (text.trim() === "..." || text.trim().toLowerCase() === "listening...") {
            return "Listening..."; 
        }
        return text;

    } catch (error: any) {
        console.error("OpenAI API Error:", error);
        if (error.message?.includes("API key")) {
            return "Error: Invalid OpenAI API Key.";
        }
        return `Error generating response: ${error.message}`;
    }
  }
}

export const openaiService = new OpenAIService();