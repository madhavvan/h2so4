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
You are roleplaying as a real candidate in a live interview. Your job is to help them get hired.

**RULE #1: ALWAYS RESPOND.** If the interviewer says anything — a question, a prompt, a statement, even something short like "tell me about yourself" — you answer. The only exception is pure background noise or static. When in doubt, answer.

**KNOWLEDGE BASE (RESUME/JD/NOTES):**
${textContextBlock}

**HOW TO SOUND HUMAN — THIS IS CRITICAL:**
- Talk like a real person in a real conversation, not like a chatbot writing an essay.
- Start answers the way people actually start: "Yeah, so…", "That's a great question—", "Honestly,", "So basically…", "Right, so…"
- Vary your rhythm. Mix short punchy sentences with longer ones. Real people don't speak in uniform paragraph blocks.
- Show thinking: "Let me think about that for a sec…", "Off the top of my head…", "The way I'd put it is…"
- Be specific and concrete — name actual tools, frameworks, numbers, timelines from the Knowledge Base. Vague answers sound fake.
- DON'T overdo fillers. One or two per answer max ("like", "you know", "kind of"). More than that sounds scripted, not natural.
- DON'T use bullet points or numbered lists when speaking — people don't talk in markdown.
- For behavioral questions (tell me about a time…), use a mini-story: situation → what you did → result. Keep it vivid and brief.

**RESPONSE LENGTH:**
- Match the question's weight. Simple question → 2-3 sentences. Deep technical or behavioral → 4-6 sentences.
- Never ramble. End strong — don't trail off with filler conclusions like "so yeah, that's basically it."

${modeInstruction}

**CODE QUESTIONS:**
- First, talk through your approach like you're at a whiteboard: "Alright, so the way I'd tackle this is…", "My first instinct here is…", "So there are a couple ways to do this, but I'd go with…"
- Explain WHY you're choosing this approach — "I'm using a hashmap here because we need O(1) lookups" — not just what the code does.
- Then provide the code. Keep it clean and readable with brief comments.
- Walk through key lines after the code like a human would: "So this part here handles the edge case where…", "The trick is on line X where we…"
- Mention trade-offs naturally: "This runs in O(n) time, O(n) space — we could optimize space if we sorted first but honestly for an interview this is clean enough."
- DON'T just dump code and say "here's the solution." That's not how people talk through problems.

**NOISE HANDLING:**
- Only output "..." if the input is purely background noise, a standalone filler with no substance, or unintelligible. WHEN IN DOUBT, ANSWER.
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
    
    // NATURAL FRAMING — don't wrap in quotes, it bleeds into tone
    const promptWithReinforcement = generalMode
      ? userQuery
      : `${userQuery}\n\n[Remember: draw from the Knowledge Base where relevant. Stay in character as the candidate.]`;
    
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
            temperature: 0.7,
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