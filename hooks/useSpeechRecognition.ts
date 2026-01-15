import { useState, useEffect, useCallback, useRef } from 'react';

// Extend Window interface for Web Speech API support
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

interface SpeechResult {
  final: string;
  interim: string;
}

interface UseSpeechRecognitionProps {
  onResult: (result: SpeechResult) => void;
  onError?: (error: string) => void;
}

export const useSpeechRecognition = ({ 
  onResult,
  onError
}: UseSpeechRecognitionProps) => {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const recognitionRef = useRef<any>(null);
  const shouldBeListeningRef = useRef(false);

  // Store callback in ref
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      const msg = "Browser does not support Speech Recognition.";
      setError(msg);
      onErrorRef.current?.(msg);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1; // Limit alternatives to stabilize result
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onerror = (event: any) => {
      // Ignore 'no-speech' as it just means silence
      if (event.error === 'no-speech') return;

      console.warn("Speech recognition error:", event.error);

      // If it's a network error or aborted, we might want to restart if we should be listening
      if (event.error === 'network' || event.error === 'aborted') {
          if (shouldBeListeningRef.current) {
             // Restart logic handled in onend
          }
      } else {
         const msg = `Error: ${event.error}`;
         setError(msg);
         onErrorRef.current?.(msg);
      }
    };

    recognition.onend = () => {
      // Vital: If we expect to be listening, restart immediately.
      // This creates the "Always On" effect.
      if (shouldBeListeningRef.current) {
        try {
          recognition.start();
        } catch (e) {
            // Already started or busy
        }
      } else {
        setIsListening(false);
      }
    };

    recognition.onresult = (event: any) => {
      let finalChunk = '';
      let interimChunk = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalChunk += event.results[i][0].transcript;
        } else {
          interimChunk += event.results[i][0].transcript;
        }
      }

      onResultRef.current({
          final: finalChunk,
          interim: interimChunk
      });
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
          recognitionRef.current.onend = null; // Prevent auto-restart on unmount
          recognitionRef.current.stop();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    shouldBeListeningRef.current = true;
    setError(null);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch (e) {
        console.warn("Recognition already started");
      }
    }
  }, []);

  const stopListening = useCallback(() => {
    shouldBeListeningRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      // isListening will be set to false in onend
    }
  }, []);

  return { isListening, error, startListening, stopListening };
};