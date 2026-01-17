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
  const streamRef = useRef<MediaStream | null>(null); // Keeps the original Display Media stream (Video+Audio)
  const audioStreamRef = useRef<MediaStream | null>(null); // Keeps the Audio-only stream
  
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
          stream.getTracks().forEach(t => t.stop());
          const msg = "No audio shared. Please check 'Share tab audio' in the popup.";
          setError(msg);
          onError?.(msg);
          return;
      }

      streamRef.current = stream;

      // CRITICAL FIX: Create a new MediaStream with ONLY the audio track.
      // Passing a stream with Video+Audio to a MediaRecorder set to 'audio/webm' causes NotSupportedError in Chrome.
      const audioStream = new MediaStream(audioTracks);
      audioStreamRef.current = audioStream;

      // 3. Connect to Deepgram WebSocket
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
             mimeType = 'audio/mp4';
         }
         
         console.log('Using MimeType:', mimeType);

         try {
             // Use the AUDIO-ONLY stream here
             const mediaRecorder = new MediaRecorder(audioStream, { mimeType });
             mediaRecorderRef.current = mediaRecorder;

             mediaRecorder.addEventListener('dataavailable', (event) => {
                 if (event.data.size > 0 && socket.readyState === 1) {
                     socket.send(event.data);
                 }
             });

             mediaRecorder.start(250); // Send chunks every 250ms
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

      // Handle user clicking "Stop Sharing" on the browser UI
      // We listen to the video track ending because that's what controls the UI indicator
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

    // Stop Audio-Only Stream Tracks
    if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
        audioStreamRef.current = null;
    }

    // Stop Original Display Stream Tracks (Video+Audio)
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
  }, []);

  return { isListening, error, startListening, stopListening };
};