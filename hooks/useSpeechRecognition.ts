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

  // Keepalive interval to prevent timeout during silence (sends ping every 8s)
  const keepaliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-reconnect state - unlimited attempts, connection stays alive until user stops
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalStopRef = useRef(false); // true when user clicks stop
  const deepgramKeyRef = useRef<string | null>(null); // Cache key for reconnects

  const stopListening = useCallback(() => {
    intentionalStopRef.current = true;
    setIsListening(false);

    // Clear keepalive interval
    if (keepaliveIntervalRef.current) {
      clearInterval(keepaliveIntervalRef.current);
      keepaliveIntervalRef.current = null;
    }

    // Clear any pending reconnect
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    deepgramKeyRef.current = null; // Clear cached key so next start gets fresh one

    // Stop and clear mediaRecorder
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch (_) {}
      }
      mediaRecorderRef.current = null;
    }

    // Close and clear socket
    if (socketRef.current) {
      if (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING) {
        try { socketRef.current.close(); } catch (_) {}
      }
      socketRef.current = null;
    }

    // Stop audio tracks
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
    // Tear down previous socket/recorder/keepalive without touching the media streams
    if (keepaliveIntervalRef.current) {
      clearInterval(keepaliveIntervalRef.current);
      keepaliveIntervalRef.current = null;
    }
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

    // Store socket ref immediately so event handlers can check if they're stale
    socketRef.current = socket;

    socket.onopen = () => {
      // Ignore if this socket is no longer current (user stopped/restarted)
      if (socketRef.current !== socket) return;

      console.log('Deepgram Connected', reconnectAttemptsRef.current > 0 ? `(reconnect #${reconnectAttemptsRef.current})` : '');
      reconnectAttemptsRef.current = 0; // reset on successful connect
      setIsListening(true);
      setError(null);

      // ── KEEPALIVE: Send ping every 8 seconds to prevent timeout during silence ──
      // Deepgram closes idle connections after ~10-60s. This keeps it alive for hours.
      keepaliveIntervalRef.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8000);

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
      // Ignore if this socket is no longer current
      if (socketRef.current !== socket) return;

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
      // Ignore if this socket is no longer current (prevents race condition on restart)
      if (socketRef.current !== socket) return;

      console.log('Deepgram Closed', event.code, event.reason);
      setIsListening(false);

      // Clear keepalive on close
      if (keepaliveIntervalRef.current) {
        clearInterval(keepaliveIntervalRef.current);
        keepaliveIntervalRef.current = null;
      }

      // Auto-reconnect if not intentionally stopped and audio stream is still alive
      // No limit on reconnect attempts - keep trying until user stops
      if (
        !intentionalStopRef.current &&
        audioStreamRef.current &&
        audioStreamRef.current.getAudioTracks().some(t => t.readyState === 'live')
      ) {
        reconnectAttemptsRef.current += 1;
        // Quick reconnect: 1s, then 2s, then cap at 5s for fast recovery
        const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttemptsRef.current - 1, 2)), 5000);
        console.log(`Deepgram auto-reconnect #${reconnectAttemptsRef.current} in ${delay}ms`);
        setError(`Reconnecting...`);

        reconnectTimerRef.current = setTimeout(async () => {
          if (!intentionalStopRef.current && audioStreamRef.current) {
            // Get fresh Deepgram key for reconnect (keys may expire)
            let keyToUse = cleanKey;
            try {
              keyToUse = await getDeepgramKey();
              deepgramKeyRef.current = keyToUse;
            } catch (e) {
              console.error('Failed to refresh Deepgram key:', e);
              // Continue with old key
            }
            connectDeepgram(audioStreamRef.current, keyToUse);
          }
        }, delay);
      }
    };

    socket.onerror = (e) => {
      // Ignore if this socket is no longer current
      if (socketRef.current !== socket) return;

      console.error("Deepgram Error", e);
      // Don't set a permanent error here — onclose will handle reconnect
      if (socket.readyState !== 1 && reconnectAttemptsRef.current === 0) {
        setError("Connection Error: Check API Key & Network.");
      }
    };
  }, [onResult, stopListening]);

  const startListening = useCallback(async () => {
    setError(null);
    intentionalStopRef.current = false;
    reconnectAttemptsRef.current = 0;

    try {
      // 1. Fetch Deepgram key from server (or use cached)
      let cleanKey = deepgramKeyRef.current;
      if (!cleanKey) {
        cleanKey = await getDeepgramKey();
        deepgramKeyRef.current = cleanKey;
      }
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