export interface Message {
  id: string;
  role: 'user' | 'model' | 'system';
  content: string;
  timestamp: number;
}

export interface AppSettings {
  apiKey: string; // Gemini Key
  deepgramApiKey: string; // Deepgram Key
  groqApiKey: string; // Groq Key
  selectedModel: 'gemini' | 'groq'; // Model Selection
  autoSend: boolean;
  contextFiles: ContextFile[];
  theme: 'light' | 'dark';
  fontSize: 'small' | 'medium' | 'large';
  generalMode: boolean; // Smart General Mode toggle
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