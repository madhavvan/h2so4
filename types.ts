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
  // GPT-5.x reasoning_effort knob. Manual levels are Max-tier only — the
  // server enforces this via JWT (non-Max users get forced back to 'none'
  // regardless of what they send). Free/Basic/Pro see the bar in the UI
  // but only the first notch is enabled for them.
  //   'none'   — the "Auto" notch (the stored value stays 'none' for
  //              backward compat; the request layer sends 'auto'). The
  //              server classifies the live question: deep analytical
  //              shapes (coding, system design, ML, quant, cases) get
  //              'low' — measured TTFT ≤~3.2s on gpt-5.6, inside the ≤4s
  //              live budget — and everything else runs at 'none'
  //              (~1-3s). Non-Max tiers always resolve to 'none'.
  //   'low'    — light reasoning; ~3-6s answers, modest depth bump.
  //   'medium' — balanced; ~5-10s answers. Never auto-picked (too slow
  //              for live) — explicit choice only.
  //   'high'   — deep reasoning; ~10-25s answers, best for complex
  //              system-design / multi-step coding questions.
  // Defaults to 'none'/Auto for all tiers. Max users opt up per-session.
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  // Free-form user-supplied directives that prepend to the system prompt
  // for every model call. Examples: "Use the STAR method on behavioral
  // questions", "Cite tool versions in code answers", "Keep responses
  // under 200 words". The server wraps these in a
  // ━━━ USER INSTRUCTIONS — FOLLOW STRICTLY ━━━ block ahead of the
  // existing system prompt so the model treats them as high-priority
  // directives. Stored in localStorage (key: CUSTOM_INSTRUCTIONS) to
  // match the persistence pattern of generalMode/theme/fontSize.
  // No hard char limit — but the modal warns above 3000 chars that
  // long instructions slow first-token-out on every call. Empty string
  // when unused (the server skips the wrapper block in that case).
  customInstructions: string;
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