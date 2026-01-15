export interface Message {
  id: string;
  role: 'user' | 'model' | 'system';
  content: string;
  timestamp: number;
}

export interface AppSettings {
  apiKey: string;
  autoSend: boolean;
  contextFiles: ContextFile[];
}

export interface ContextFile {
  id: string;
  name: string;
  content: string;
  type: 'resume' | 'jd' | 'custom';
}

export interface SpeechState {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  error: string | null;
}
