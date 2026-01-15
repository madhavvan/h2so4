import { GoogleGenAI } from "@google/genai";
import { Message, ContextFile } from "../types";

export class GeminiService {
  private ai: GoogleGenAI | null = null;
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
    contextFiles: ContextFile[]
  ): Promise<string> {
    if (!this.ai) {
      throw new Error("API Key not set. Please configure it in settings.");
    }

    // Prioritize Custom files, then Resume, then JD
    const sortedFiles = [...contextFiles].sort((a, b) => {
        if (a.type === 'custom') return -1;
        if (b.type === 'custom') return 1;
        return 0;
    });

    const contextBlock = sortedFiles
      .map((f) => `[[SOURCE: ${f.type.toUpperCase()} - ${f.name}]]\n${f.content}\n[[END SOURCE]]`)
      .join("\n\n");

    const systemInstruction = `
You are an expert candidate currently in a high-stakes job interview.
Your goal is to get hired by providing impressive, accurate, and context-aware answers.

**KNOWLEDGE BASE (CRITICAL):**
You have access to the following documents. You MUST use them to ground your answers.
${contextBlock}

**INSTRUCTIONS:**
1. **USE THE DOCUMENTS**: If the user asks about a project, skill, or experience found in the "RESUME" or "CUSTOM" files, refer to specific details from there. If they ask about the role, refer to the "JD".
2. **FIRST PERSON**: Speak as "I". You are the candidate.
3. **STYLE**: Conversational, professional, confident. No robotic fillers.
4. **LENGTH**: Concise answers (3-5 sentences usually, unless a deep dive is requested).

**AUDIO FILTERING RULE:**
- The input stream contains ALL audio from the device.
- **IGNORE** text that appears to be YOU (the candidate) speaking (e.g., "I worked on...", "My experience is...").
- **ONLY RESPOND** to questions or comments directed AT you by the Interviewer.
- If the input is just you talking or silence, output exactly: "..."
`;

    // Convert history to meaningful dialogue
    const chatHistoryText = history
        .filter(m => m.role !== 'system')
        .map(m => `${m.role === 'user' ? 'Interviewer (Transcript)' : 'Candidate (You)'}: ${m.content}`)
        .join('\n');

    const fullPrompt = `
${chatHistoryText}

Interviewer (Current Audio): ${userQuery}

Task:
- If this is the Interviewer asking a question, provide the Candidate's response based on the Knowledge Base.
- If this is the Candidate speaking, output "..."
`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: [
            { role: 'user', parts: [{ text: fullPrompt }] }
        ],
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.6, 
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
