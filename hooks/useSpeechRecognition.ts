import { useState, useCallback, useRef, useEffect } from 'react';
import { getDeepgramKey } from '../services/aiProxyService';

interface SpeechResult {
  final: string;
  interim: string;
}

interface UseSpeechRecognitionProps {
  onResult: (result: SpeechResult) => void;
  onError?: (error: string) => void;
}

// Detect Electron via the contextBridge surface (window.electronAPI is set
// by electron/preload.cjs). The old `process.versions.electron` check no
// longer works under contextIsolation:true + nodeIntegration:false.
const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;

/**
 * Get audio stream — handles both Browser (getDisplayMedia) and Electron (desktopCapturer)
 */
async function getAudioStream(): Promise<{ stream: MediaStream; audioStream: MediaStream }> {
  if (isElectron) {
    // ── ELECTRON PATH ──
    // desktopCapturer is only available in main process (Electron 17+).
    // Reach it through the contextBridge surface — see electron/preload.cjs.
    if (!window.electronAPI) {
      throw new Error('Electron API not available');
    }
    const sources = await window.electronAPI.invoke<any[]>('get-desktop-sources');

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
  // ── Recovery state (mid-interview resilience) ──
  // reacquiring: a fresh-stream re-acquire is in flight (dedupe).
  // fastFailStreak: consecutive connects that closed without ever
  //   delivering data — the signal for an auth/config problem, which we
  //   use to break an otherwise-infinite reconnect storm.
  // gotData: this socket delivered at least one message (so a later close
  //   is a normal drop, not a fast-fail).
  // recover: late-bound pointer to reacquireStream so connectDeepgram's
  //   onclose can reach it without a declaration cycle.
  const reacquiringRef = useRef(false);
  const fastFailStreakRef = useRef(0);
  const gotDataRef = useRef(false);
  const recoverRef = useRef<(() => void) | null>(null);

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
    // Reset recovery state so a later start() isn't blocked or biased by a
    // previous session's fast-fail streak / in-flight re-acquire flag.
    reacquiringRef.current = false;
    fastFailStreakRef.current = 0;

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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  no_delay=true — THE 3-SECOND WAIT THIS URL USED TO CARRY.
    //
    //  `smart_format` does not just format: while an utterance ends on an
    //  ENTITY it holds the transcript back, and Deepgram's own docs say it
    //  will "wait until the speaker continues to non-entity speech, OR
    //  finalize the transcript after 3 seconds of silence."
    //
    //  Interview speech is entity-dense in exactly that position — "...from
    //  2023", "...70 plus systems", "...at Evonik" — so the utterance that
    //  ENDS a question is the one most likely to be held. And is_final is
    //  load-bearing here: handleSpeechResult only arms the auto-send timer
    //  inside `if (final)`, so a held final delays the send by up to 3s,
    //  and the 1,200ms silence timer starts only after that. The user sees
    //  it twice — "the voice is getting transcribed late" AND "sometimes
    //  taking time to give the answer" — from one cause.
    //
    //  no_delay=true drops that wait. The documented cost is that entity
    //  formatting is skipped "in many cases": "2023" may arrive unformatted,
    //  a phone number unhyphenated. That text is read by a model and shown
    //  as a live transcript — neither cares — and up to 3 seconds in front
    //  of every answer is not a formatting trade, it is the product.
    //
    //  endpointing is left at its default (10ms) — already the fast end.
    //  Pinned by hooks/__tests__ / deepgram-params so a future edit cannot
    //  quietly reintroduce the wait.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const socket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=true&punctuate=true&no_delay=true',
      ['token', cleanKey]
    );

    // Store socket ref immediately so event handlers can check if they're stale
    socketRef.current = socket;
    gotDataRef.current = false; // reset per-socket; set true on first message

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

        // Recorder failure = audio pipeline broken while the socket looks
        // fine. Without this the mic would appear "on" but send nothing.
        // Bounce the socket (its onclose reconnect recreates the recorder);
        // if the underlying audio track is dead, the reconnect path
        // re-acquires a fresh stream. Only act on the CURRENT socket.
        mediaRecorder.addEventListener('error', (ev: any) => {
          if (socketRef.current !== socket) return;
          console.warn('[mic] MediaRecorder error — bouncing capture:', ev?.error?.message || ev);
          if (!intentionalStopRef.current) {
            try { socket.close(); } catch {} // triggers onclose → reconnect/re-acquire
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

      // This connection is delivering — a later close is a normal drop,
      // not a fast-fail, and the auth/config storm-breaker resets.
      gotDataRef.current = true;
      fastFailStreakRef.current = 0;

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

      if (intentionalStopRef.current) return; // user stopped — nothing to recover

      // ── Auth/config storm-breaker (#7) ──
      // A socket that closes WITHOUT ever delivering data is a "fast-fail":
      // almost always a bad/expired key, quota, or a policy close (1008 /
      // Deepgram 4xxx). A few in a row means reconnecting won't help — stop
      // and surface a clear error instead of hammering every ≤5s forever.
      if (gotDataRef.current) {
        fastFailStreakRef.current = 0;
      } else {
        fastFailStreakRef.current += 1;
      }
      if (fastFailStreakRef.current >= 5) {
        console.error('[mic] giving up after repeated fast-fail closes (auth/config?) code=', event.code);
        setError('Voice service could not stay connected. Please stop and start the mic again.');
        return;
      }

      // ── Dead audio track → re-acquire a fresh stream (#4) ──
      // The old code simply GAVE UP when the audio track wasn't live —
      // the silent-death path (a device change ended the track). Now we
      // recover: on desktop the system-audio loopback re-acquires with no
      // prompt; in the browser a dead audio track means the user ended the
      // screen-share, so we stop cleanly (their intent).
      const audioLive = !!audioStreamRef.current &&
        audioStreamRef.current.getAudioTracks().some(t => t.readyState === 'live');
      if (!audioLive) {
        if (isElectron && recoverRef.current) {
          console.warn('[mic] audio track dead on close — re-acquiring stream');
          recoverRef.current();
        } else {
          console.warn('[mic] capture ended (share stopped) — stopping');
          stopListening();
        }
        return;
      }

      // ── Normal reconnect with the still-live stream ──
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

  // Wire failure handlers onto a freshly-acquired stream.
  // Video loss is DECOUPLED from audio (#3): the video track exists only
  // for Auto-Solve screenshots, so losing it must NOT kill the mic.
  // Audio-track loss triggers recovery (#4).
  const wireTracks = useCallback((stream: MediaStream, audioStream: MediaStream) => {
    const vTracks = stream.getVideoTracks();
    if (vTracks.length > 0) {
      vTracks[0].onended = () => {
        // Keep the mic alive. captureScreenshot re-acquires its own
        // one-shot video in Electron, so no persistent video track is
        // required for screenshots.
        console.warn('[mic] video track ended — screenshot capture paused; mic stays live');
      };
    }
    audioStream.getAudioTracks().forEach(track => {
      track.onended = () => {
        if (intentionalStopRef.current) return;
        if (isElectron && recoverRef.current) {
          // System-audio loopback re-acquires with no prompt on desktop.
          console.warn('[mic] audio track ended — re-acquiring stream');
          recoverRef.current();
        } else {
          // Browser: no separate mic — a dead audio track means the user
          // ended the screen-share. Treat as an intentional stop.
          console.warn('[mic] audio ended (share stopped) — stopping');
          stopListening();
        }
      };
      // onmute fires transiently (brief glitch) then unmutes — do NOT
      // recover on it, only log. Permanent loss arrives via onended.
      track.onmute = () => console.log('[mic] audio track muted (transient?)');
      track.onunmute = () => console.log('[mic] audio track unmuted');
    });
  }, [stopListening]);

  // Re-acquire a fresh capture stream and reconnect — the recovery path
  // for a dead audio track (device change) on desktop. Deduped so a burst
  // of close/onended events can't spawn parallel captures.
  const reacquireStream = useCallback(async () => {
    if (intentionalStopRef.current || reacquiringRef.current) return;
    reacquiringRef.current = true;
    setError('Reconnecting...');
    try {
      // Drop the dead stream's tracks before re-acquiring.
      audioStreamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch {} });
      streamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch {} });
      const { stream, audioStream } = await getAudioStream();
      if (intentionalStopRef.current) {
        stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        return;
      }
      streamRef.current = stream;
      setCurrentStream(stream);
      audioStreamRef.current = audioStream;
      wireTracks(stream, audioStream);
      let keyToUse = deepgramKeyRef.current || '';
      try {
        keyToUse = await getDeepgramKey();
        deepgramKeyRef.current = keyToUse;
      } catch { /* keep old key */ }
      if (!keyToUse) { setError('Voice service unavailable. Please restart the mic.'); return; }
      connectDeepgram(audioStream, keyToUse);
    } catch (e: any) {
      console.error('[mic] re-acquire failed:', e?.message || e);
      setError('Lost the microphone and could not recover. Please stop and start again.');
    } finally {
      reacquiringRef.current = false;
    }
  }, [connectDeepgram, wireTracks]);

  // Late-bind recover so connectDeepgram's onclose can reach reacquireStream
  // without a declaration cycle.
  useEffect(() => { recoverRef.current = reacquireStream; }, [reacquireStream]);

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

      // 3. Wire failure handlers (video decoupled from audio; audio loss
      //    recovers) then connect to Deepgram.
      wireTracks(stream, audioStream);
      connectDeepgram(audioStream, cleanKey);

    } catch (err: any) {
      console.error("Capture Error:", err);
      if (err.name !== 'NotAllowedError') {
        const msg = `Capture Error: ${err.message || 'Could not start audio capture'}`;
        setError(msg);
        onError?.(msg);
      }
    }
  }, [onResult, onError, stopListening, connectDeepgram, wireTracks]);

  // ── Unmount cleanup ────────────────────────────────────────────────
  // The hook used to depend entirely on its consumer calling stopListening
  // before unmount. If MainApp ever unmounted with a session live (hot
  // reload during recording, future code path that tears down on tier
  // change, or a user-triggered logout while listening), the MediaRecorder,
  // WebSocket, audioStream, and reconnect timer all leaked. The browser
  // would keep the screen-share / mic indicator on indefinitely. Adding
  // this once-only effect with a stable cleanup means the hook
  // self-cleans regardless of caller behavior.
  useEffect(() => {
    return () => {
      try { stopListening(); } catch { /* never throw on unmount */ }
    };
    // Intentionally empty deps — we only want the cleanup to run on the
    // FINAL unmount, not on every stopListening identity change. The
    // reference to stopListening is captured fresh each cleanup tick
    // because React closes over the most recent render's value at unmount
    // time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isListening, error, startListening, stopListening, stream: currentStream };
};