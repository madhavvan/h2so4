import { useState, useCallback, useRef } from 'react';

interface SpeechResult {
  final: string;
  interim: string;
}

interface UseSpeechRecognitionProps {
  onResult: (result: SpeechResult) => void;
  onError?: (error: string) => void;
  apiKey: string; // Deepgram API Key
}

// Detect Electron
const isElectron = typeof window !== 'undefined' && !!(window as any).process?.versions?.electron;

/**
 * Get audio stream — handles both Browser (getDisplayMedia) and Electron (desktopCapturer)
 */
async function getAudioStream(): Promise<{ stream: MediaStream; audioStream: MediaStream }> {
  if (isElectron) {
    // ── ELECTRON PATH ──
    // desktopCapturer is only available in main process (Electron 17+)
    // Use IPC to get sources from main process
    const { ipcRenderer } = (window as any).require('electron');

    const sources = await ipcRenderer.invoke('get-desktop-sources');

    if (!sources || sources.length === 0) {
      throw new Error('No capture sources found');
    }

    // Try to find "Entire Screen" first, fall back to first source
    const screenSource = sources.find((s: any) =>
      s.name === 'Entire Screen' || s.name === 'Screen 1' || s.name.toLowerCase().includes('screen')
    ) || sources[0];

    // In Electron, we use getUserMedia with chromeMediaSource constraints
    // This captures system audio on Windows. macOS has limitations (see notes below).
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screenSource.id,
        }
      } as any,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screenSource.id,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 5, // Low FPS since we only need occasional screenshots
        }
      } as any,
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('No system audio detected. On macOS you may need a virtual audio driver (e.g. BlackHole).');
    }

    const audioStream = new MediaStream(audioTracks);
    return { stream, audioStream };

  } else {
    // ── BROWSER PATH ──
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error("No audio shared. Please check 'Share tab audio' in the popup.");
    }

    const audioStream = new MediaStream(audioTracks);
    return { stream, audioStream };
  }
}

export const useSpeechRecognition = ({
  onResult,
  onError,
  apiKey
}: UseSpeechRecognitionProps) => {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [currentStream, setCurrentStream] = useState<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  const stopListening = useCallback(() => {
    setIsListening(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    if (socketRef.current) {
      if (socketRef.current.readyState === 1 || socketRef.current.readyState === 0) {
        socketRef.current.close();
      }
    }

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
      audioStreamRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      setCurrentStream(null);
    }
  }, []);

  const startListening = useCallback(async () => {
    setError(null);

    const cleanKey = apiKey?.trim();
    if (!cleanKey) {
      const msg = "Deepgram API Key missing. Check Settings.";
      setError(msg);
      onError?.(msg);
      return;
    }

    try {
      // 1. Get audio stream (handles both Browser and Electron)
      const { stream, audioStream } = await getAudioStream();

      streamRef.current = stream;
      setCurrentStream(stream);
      audioStreamRef.current = audioStream;

      // 2. Connect to Deepgram WebSocket
      const socket = new WebSocket(
        'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=true&punctuate=true',
        ['token', cleanKey]
      );

      socket.onopen = () => {
        console.log('Deepgram Connected');
        setIsListening(true);

        // 3. Start Recording & Streaming
        let mimeType = 'audio/webm';
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        }

        console.log('Using MimeType:', mimeType);

        try {
          const mediaRecorder = new MediaRecorder(audioStream, { mimeType });
          mediaRecorderRef.current = mediaRecorder;

          mediaRecorder.addEventListener('dataavailable', (event) => {
            if (event.data.size > 0 && socket.readyState === 1) {
              socket.send(event.data);
            }
          });

          mediaRecorder.start(250);
        } catch (recErr: any) {
          console.error("MediaRecorder Start Error:", recErr);
          setError(`Recorder Error: ${recErr.message}`);
          stopListening();
        }
      };

      socket.onmessage = (message) => {
        try {
          const received = JSON.parse(message.data);
          const transcript = received.channel?.alternatives?.[0]?.transcript;
          if (transcript && received.is_final) {
            onResult({ final: transcript, interim: '' });
          } else if (transcript) {
            onResult({ final: '', interim: transcript });
          }
        } catch (e) {
          console.error("Deepgram Parse Error", e);
        }
      };

      socket.onclose = (event) => {
        console.log('Deepgram Closed', event.code, event.reason);
        setIsListening(false);
      };

      socket.onerror = (e) => {
        console.error("Deepgram Error", e);
        if (socket.readyState !== 1) {
          setError("Connection Error: Check API Key & Network.");
        } else {
          setError("Transcription Stream Error");
        }
      };

      socketRef.current = socket;

      // Handle stream ending
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0) {
        videoTracks[0].onended = () => {
          stopListening();
        };
      }

    } catch (err: any) {
      console.error("Capture Error:", err);
      if (err.name !== 'NotAllowedError') {
        const msg = `Capture Error: ${err.message || 'Could not start audio capture'}`;
        setError(msg);
        onError?.(msg);
      }
    }
  }, [apiKey, onResult, onError, stopListening]);

  return { isListening, error, startListening, stopListening, stream: currentStream };
};