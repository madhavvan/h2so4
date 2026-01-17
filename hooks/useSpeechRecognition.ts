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
      // 1. Request System Audio via Screen Share
      // We explicitly request audio options for high fidelity
      const stream = await navigator.mediaDevices.getDisplayMedia({ 
          video: true, 
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
      });

      // 2. Validate Audio Track
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
          // User didn't check "Share Audio"
          stream.getTracks().forEach(t => t.stop());
          const msg = "No audio shared. Please check 'Share tab audio' in the popup.";
          setError(msg);
          onError?.(msg);
          return;
      }

      streamRef.current = stream;

      // 3. Connect to Deepgram WebSocket
      // Fixed: 'tier' param is deprecated/incorrect for model selection. Used 'model=nova-2'.
      const socket = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=true&punctuate=true', [
         'token',
         cleanKey
      ]);

      socket.onopen = () => {
         console.log('Deepgram Connected');
         setIsListening(true);
         
         // 4. Start Recording & Streaming
         // Detect supported mimeType
         let mimeType = 'audio/webm';
         if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
             mimeType = 'audio/webm;codecs=opus';
         } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
             mimeType = 'audio/mp4'; // Safari fallback
         }
         
         console.log('Using MimeType:', mimeType);

         const mediaRecorder = new MediaRecorder(stream, { mimeType });
         mediaRecorderRef.current = mediaRecorder;

         mediaRecorder.addEventListener('dataavailable', (event) => {
             if (event.data.size > 0 && socket.readyState === 1) {
                 socket.send(event.data);
             }
         });

         mediaRecorder.start(250); // Send chunks every 250ms
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
         if (event.code === 1006) {
             // Abnormal closure often implies auth error or 400 Bad Request during handshake
             // But usually on handshake fail we get onerror first.
         }
      };

      socket.onerror = (e) => {
          console.error("Deepgram Error", e);
          // If the socket isn't open yet, it's likely a connection/handshake error (Auth or Params)
          if (socket.readyState !== 1) {
               setError("Connection Error: Check API Key & Network.");
          } else {
               setError("Transcription Stream Error");
          }
          // We don't automatically stopListening here to allow potential recovery or manual stop, 
          // but for handshake errors, we should probably cleanup.
          if (socket.readyState === 3) { // CLOSED
             stopListening();
          }
      };
      
      socketRef.current = socket;

      // Handle user clicking "Stop Sharing" on the browser UI
      stream.getVideoTracks()[0].onended = () => {
          stopListening();
      };

    } catch (err: any) {
      console.error("Capture Error:", err);
      // 'NotAllowedError' means user cancelled the dialog
      if (err.name !== 'NotAllowedError') {
          const msg = `Capture Error: ${err.message || 'Could not start audio capture'}`;
          setError(msg);
          onError?.(msg);
      }
    }
  }, [apiKey, onResult, onError]);

  const stopListening = useCallback(() => {
    setIsListening(false);
    
    // Stop Recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
    }
    
    // Close Socket
    if (socketRef.current) {
        if (socketRef.current.readyState === 1 || socketRef.current.readyState === 0) {
             socketRef.current.close();
        }
    }

    // Stop all tracks (Video and Audio) to release the "Sharing" indicator
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
  }, []);

  return { isListening, error, startListening, stopListening };
};