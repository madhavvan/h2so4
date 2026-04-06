import { useState, useCallback, useRef } from 'react';
import { getDeepgramKey } from '../services/aiProxyService';

interface SpeechResult {
  final: string;
  interim: string;
}

interface UseSpeechRecognitionProps {
  onResult: (result: SpeechResult) => void;
  onError?: (error: string) => void;
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
}: UseSpeechRecognitionProps) => {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [currentStream, setCurrentStream] = useState<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  // Auto-reconnect state
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalStopRef = useRef(false); // true when user clicks stop
  const MAX_RECONNECT_ATTEMPTS = 5;

  const stopListening = useCallback(() => {
    intentionalStopRef.current = true;
    setIsListening(false);

    // Clear any pending reconnect
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;

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

  // Connect (or reconnect) the Deepgram WebSocket using the existing audio stream
  const connectDeepgram = useCallback((audioStream: MediaStream, cleanKey: string) => {
    // Tear down previous socket/recorder without touching the media streams
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch (_) {}
    }
    if (socketRef.current) {
      try { socketRef.current.close(); } catch (_) {}
    }

    const socket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=true&punctuate=true',
      ['token', cleanKey]
    );

    socket.onopen = () => {
      console.log('Deepgram Connected', reconnectAttemptsRef.current > 0 ? `(reconnect #${reconnectAttemptsRef.current})` : '');
      reconnectAttemptsRef.current = 0; // reset on successful connect
      setIsListening(true);
      setError(null);

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

      // Auto-reconnect if not intentionally stopped and audio stream is still alive
      if (
        !intentionalStopRef.current &&
        audioStreamRef.current &&
        audioStreamRef.current.getAudioTracks().some(t => t.readyState === 'live') &&
        reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS
      ) {
        reconnectAttemptsRef.current += 1;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 16000); // 1s, 2s, 4s, 8s, 16s
        console.log(`Deepgram auto-reconnect #${reconnectAttemptsRef.current} in ${delay}ms`);
        setError(`Reconnecting... (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`);

        reconnectTimerRef.current = setTimeout(() => {
          if (!intentionalStopRef.current && audioStreamRef.current) {
            connectDeepgram(audioStreamRef.current, cleanKey);
          }
        }, delay);
      } else if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setError("Connection lost. Please restart listening.");
      }
    };

    socket.onerror = (e) => {
      console.error("Deepgram Error", e);
      // Don't set a permanent error here — onclose will handle reconnect
      if (socket.readyState !== 1 && reconnectAttemptsRef.current === 0) {
        setError("Connection Error: Check API Key & Network.");
      }
    };

    socketRef.current = socket;
  }, [onResult, stopListening]);

  const startListening = useCallback(async () => {
    setError(null);
    intentionalStopRef.current = false;
    reconnectAttemptsRef.current = 0;

    try {
      // 1. Fetch Deepgram key from server
      const cleanKey = await getDeepgramKey();
      if (!cleanKey) {
        const msg = "Could not get Deepgram key. Please try again.";
        setError(msg);
        onError?.(msg);
        return;
      }

      // 2. Get audio stream (handles both Browser and Electron)
      const { stream, audioStream } = await getAudioStream();

      streamRef.current = stream;
      setCurrentStream(stream);
      audioStreamRef.current = audioStream;

      // 3. Connect to Deepgram WebSocket
      connectDeepgram(audioStream, cleanKey);

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
  }, [onResult, onError, stopListening, connectDeepgram]);

  return { isListening, error, startListening, stopListening, stream: currentStream };
};