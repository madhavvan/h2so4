import { GoogleGenAI } from "@google/genai";
import { Message, ContextFile } from "../types";

export class GeminiService {
  private ai: GoogleGenAI | null = null;
  // Updated to Gemini 3 Flash Preview as requested and per guidelines
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
**SMART GENERAL MODE IS ON:**
- Primarily answer questions using general industry knowledge, best practices, and standard engineering principles.
- **EXCEPTION (SMART SWITCH):** If the user asks a question SPECIFICALLY about the candidate's personal experience, past projects, or resume details (e.g., "Tell me about your time at X", "What did you do in project Y?"), you **MUST** switch context and use the provided KNOWLEDGE BASE (Resume/JD) to answer accurately.
` 
      : `
**CONTEXT MODE IS ON:**
- Ground your answers **heavily** in the provided KNOWLEDGE BASE (Resume, JD).
- Always relate general concepts back to the candidate's specific experience found in the files.
- If the files are empty, fall back to general knowledge.
`;

    const systemInstruction = `
You are an expert candidate currently in a high-stakes job interview.
Your goal is to get hired by providing impressive, accurate, and context-aware answers.

**KNOWLEDGE BASE:**
You have access to attached files (PDFs, Images, Text).
${textContextBlock}

**INSTRUCTIONS:**
1. **ROLE**: Speak as "I". You are the candidate. Be professional, confident, and natural.
2. **TONE**: Human-like and conversational. **NEVER** start with meta-commentary like "I am assuming you mean..." or "Here is an answer...". Just answer the question directly.
3. **LENGTH**: Provide detailed, substantial answers. Aim for a paragraph or two (approx 4-6 sentences). **Do not** be overly concise. Explain your reasoning clearly.
4. **CODE**: If asked for code, provide it in a clean format with a brief explanation.

${modeInstruction}

**AUDIO FILTERING RULE:**
- The input stream contains ALL audio from the device.
- **IGNORE** text that appears to be YOU (the candidate) speaking (e.g., "I worked on...", "My experience is...").
- **ONLY RESPOND** to questions or comments directed AT you by the Interviewer.
- If the input is clearly just you talking to yourself or silence, output exactly: "..."
- **WHEN IN DOUBT, ANSWER.** If it looks like a question or a topic starter, provide a response.
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
          temperature: 0.7, // Slightly higher for more "human" variance
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