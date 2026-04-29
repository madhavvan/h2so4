export interface Message {
  id: string;
  role: 'user' | 'model' | 'system';
  content: string;
  timestamp: number;
}

declare global {
  interface Window {
    documentPictureInPicture: any;
  }
}

export interface AppSettings {
  selectedModel: 'gemini' | 'groq' | 'openai' | 'xai' | 'claude';
  autoSend: boolean;
  contextFiles: ContextFile[];
  theme: 'light' | 'dark';
  fontSize: 'small' | 'medium' | 'large';
  generalMode: boolean;
  // When true, Auto-Type runs entirely on-device: the deterministic UIA
  // planner still fires, but the cloud fallback (Haiku planner over
  // Railway) is skipped — no editor-text leaves the machine. Targets
  // network-monitored interview environments (corporate VPN, big-finance
  // panel rounds) where an unfamiliar outbound to a Railway domain in
  // the middle of a coding round is itself an anomaly, regardless of
  // whether the planner improves outcomes.
  localOnlyAutoType: boolean;
  // GPT-5.x reasoning_effort knob. Max-tier only — the server enforces
  // this via JWT (non-Max users get forced back to 'none' regardless of
  // what they send). Free/Basic/Pro see the bar in the UI but only
  // 'none' is enabled for them.
  //   'none'   — skip chain-of-thought; ~1-3s answers. Best paired with
  //              a freshly trained tech-state cache (Train Model) — the
  //              pre-researched context fills the gap that reasoning
  //              would otherwise compute on the fly.
  //   'low'    — light reasoning; ~3-6s answers, modest depth bump.
  //   'medium' — balanced (matches OpenAI's own default); ~5-10s answers.
  //   'high'   — deep reasoning; ~10-25s answers, best for complex
  //              system-design / multi-step coding questions.
  // Defaults to 'none' for all tiers — fastest baseline, and non-Max are
  // stuck there anyway. Max users opt up per-session as needed.
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
}

export interface ContextFile {
  id: string;
  name: string;
  content: string; // Used for text placeholders or raw text files
  type: 'resume' | 'jd' | 'custom';
  mimeType?: string; // e.g., 'application/pdf', 'image/png'
  base64?: string; // The raw base64 data for binary files
}

export interface SpeechState {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  error: string | null;
}