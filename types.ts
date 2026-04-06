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
  selectedModel: 'gemini' | 'groq' | 'openai' | 'xai';
  autoSend: boolean;
  contextFiles: ContextFile[];
  theme: 'light' | 'dark';
  fontSize: 'small' | 'medium' | 'large';
  generalMode: boolean;
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