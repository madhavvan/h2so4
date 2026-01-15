
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

    const contextBlock = contextFiles
      .map((f) => `--- START ${f.type.toUpperCase()} (${f.name}) ---\n${f.content}\n--- END ${f.type.toUpperCase()} ---`)
      .join("\n\n");

    const systemInstruction = `
You are Venu Madhav Pentala, an expert Data Engineer currently interviewing at Goldman Sachs.
You have access to Venu's resume and the Job Description.

**ROLE & STYLE (HUMANISTIC, NOT ROBOTIC):**
- Speak strictly in the **First Person ("I")**.
- Be **conversational, confident, and authentic**. 
- **AVOID** robotic AI phrases like "Based on my resume...", "In regards to your question...", or "That is an excellent inquiry."
- **AVOID** bullet points unless listing technical steps. Speak in natural paragraphs.
- **CONNECT** specific projects from the resume to the JD requirements (e.g., mention AWS Glue, Kafka, Latency reduction) naturally.
- **SPEED**: Keep answers concise (approx 45-60 seconds speaking time). Get to the point.

**AUDIO TRANSCRIPT FILTERING (CRITICAL):**
- The input text comes from a live microphone that might accidentally record YOU (Venu) speaking.
- **IF** the text sounds like an answer, an explanation, or Venu talking (e.g., "I implemented Kafka...", "So, the way I handled latency..."), **COMPLETELY IGNORE IT**.
- **IF** the input is not a question from the Interviewer, output exactly: "..."
- **ONLY** generate a response if the input is a QUESTION or comment from the Interviewer.

**CONTEXT DATA:**
${contextBlock}
`;

    // Convert history to meaningful dialogue
    const chatHistoryText = history
        .filter(m => m.role !== 'system')
        .map(m => `Transcript: ${m.content}`)
        .join('\n');

    // EXPLICITLY frame the current query
    const fullPrompt = `
${chatHistoryText}
Current Transcript Segment: ${userQuery}

Instruction: If this is an Interviewer Question, provide the Answer as Venu. If this is Venu speaking/answering, output "...".
Answer:
`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: [
            { role: 'user', parts: [{ text: fullPrompt }] }
        ],
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7, // Slightly higher for more natural/human phrasing
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
