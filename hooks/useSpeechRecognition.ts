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

    if (!apiKey) {
        const msg = "Deepgram API Key missing. Check Settings.";
        setError(msg);
        onError?.(msg);
        return;
    }

    try {
      // 1. Request System Audio via Screen Share
      // Note: Video is required to get the prompt, but we will ignore the video track.
      const stream = await navigator.mediaDevices.getDisplayMedia({ 
          video: true, 
          audio: true 
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
      // Using Nova-2 model for speed and accuracy
      const socket = new WebSocket('wss://api.deepgram.com/v1/listen?tier=nova-2&smart_format=true&interim_results=true&encoding=linear16&sample_rate=48000', [
         'token',
         apiKey
      ]);

      socket.onopen = () => {
         console.log('Deepgram Connected');
         setIsListening(true);
         
         // 4. Start Recording & Streaming
         // We use MediaRecorder to get chunks. Deepgram supports raw or containerized audio.
         // Simpler to just send the MediaRecorder blob chunks.
         // Note: For lowest latency, we'd use AudioContext and ScriptProcessor/AudioWorklet to send raw PCM,
         // but MediaRecorder with small timeslice is robust and compatible.
         
         // However, Deepgram WebSocket with 'encoding=webm' (default if not specified) works well with MediaRecorder.
         // Let's rely on browser default mime type or force webm.
         let mimeType = 'audio/webm';
         if (!MediaRecorder.isTypeSupported(mimeType)) {
             mimeType = 'audio/mp4'; // Safari fallback
         }
         
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

      socket.onclose = () => {
         console.log('Deepgram Closed');
         stopListening(); // Ensure cleanup
      };

      socket.onerror = (e) => {
          console.error("Deepgram Error", e);
          setError("Transcription Connection Error");
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
          const msg = `Error: ${err.message || 'Could not start audio capture'}`;
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
    if (socketRef.current && socketRef.current.readyState === 1) {
        // Send generic close frame
        socketRef.current.close();
    }

    // Stop all tracks (Video and Audio) to release the "Sharing" indicator
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
  }, []);

  return { isListening, error, startListening, stopListening };
};