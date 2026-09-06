import { useState, useCallback, useRef, useEffect } from 'react';
import { getDeepgramKeyCached, invalidateDeepgramKey } from '../services/deepgramKey';

interface SpeechResult {
  final: string;
  interim: string;
}

interface UseSpeechRecognitionProps {
  onResult: (result: SpeechResult) => void;
  onError?: (error: string) => void;
  /** Listening started, but in a reduced mode (microphone only) — and why. */
  onNotice?: (notice: string) => void;
}

// Detect Electron via the contextBridge surface (window.electronAPI is set
// by electron/preload.cjs). The old `process.versions.electron` check no
// longer works under contextIsolation:true + nodeIntegration:false.
const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
// Windows is the one platform where Electron can hand the renderer OS
// loopback audio through getDisplayMedia (main.cjs
// setDisplayMediaRequestHandler answers with audio: 'loopback').
const isWindows = typeof navigator !== 'undefined'
  && (/^Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || ''));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHY THE MIC TOOK 4-5 SECONDS TO SHOW ON (2026-09-05), and what changed
//
//  startListening ran five steps strictly one after another and the button
//  only changed when the LAST one finished: fetch a key (the server minted a
//  brand-new Deepgram key every time — p50 623 ms, p90 908 ms server-side in
//  production, plus the round trip), ask Electron for every desktop source
//  WITH a 150×150 thumbnail of every open window (230 ms on a 4-window
//  desktop, seconds on an interviewee's), open a desktop capture that also
//  pulled a 1080p video track the mic never uses, connect the Deepgram
//  socket, then paint. On stop the key was thrown away; on every reconnect
//  another was minted — 21 mints for 7 interview starts in one week of logs.
//
//  Now: the button shows STARTING… on the click itself (isStarting); the key
//  and the capture are fetched in parallel; the key is cached for its
//  lifetime and prefetched when the interview screen mounts
//  (services/deepgramKey.ts); the source lookup is screen-only with no
//  thumbnails (6–8 ms measured); on Windows the capture is one getDisplayMedia
//  call answered by main.cjs with OS loopback audio, and the unused video
//  track is stopped immediately (verified: loopback audio keeps flowing);
//  reconnects retry at once with the cached key and keep the button ON with a
//  "reconnecting" hint instead of flipping it OFF.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface CaptureResult {
  stream: MediaStream;
  audioStream: MediaStream;
  /** Set when listening started in a reduced mode the user should know about. */
  notice?: string;
}

// ── MICROPHONE-ONLY FALLBACK ──
// Used when meeting-audio capture is unavailable in Electron: the permission
// is off, the platform offers no system-audio track (macOS without a virtual
// audio device), or desktopCapturer simply failed. Through the mic the
// interviewer is still heard as long as they play through speakers, which
// is strictly better than a red error over an OFF button. The notice says
// what happened and, for the permission case, exactly what to turn on.
async function micOnlyCapture(cause: any): Promise<CaptureResult> {
  const raw = String(cause?.message || cause || 'meeting audio capture failed');
  const why = raw.replace(/^Error invoking remote method '[^']+': /, '').replace(/\.$/, '');
  console.warn('[mic] meeting-audio capture unavailable — listening through the microphone only:', why);
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (micErr: any) {
    throw new Error(`${why} — and the microphone could not be opened either (${micErr?.message || micErr}).`);
  }
  if (mic.getAudioTracks().length === 0) {
    mic.getTracks().forEach(t => { try { t.stop(); } catch { /* already ended */ } });
    throw new Error(`${why} — and the microphone produced no audio track.`);
  }
  const permission = /screen recording/i.test(why);
  const notice = permission
    ? 'Microphone only — meeting audio needs Screen Recording permission. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen the app.'
    : `Microphone only — meeting audio capture is unavailable (${why.slice(0, 140)}). The interviewer is heard through your speakers.`;
  return { stream: mic, audioStream: mic, notice };
}

/**
 * Get audio stream — handles both Browser (getDisplayMedia) and Electron (desktopCapturer)
 */
async function getAudioStream(): Promise<CaptureResult> {
  if (isElectron) {
    // ── ELECTRON PATH ──
    if (!window.electronAPI) {
      throw new Error('Electron API not available');
    }

    // ── Fast path (Windows): one call, answered by main.cjs with the screen
    //    source plus OS loopback audio. No thumbnail of every open window, no
    //    source-id round trip, and the desktop VIDEO track — which the mic
    //    never uses (screenshots re-acquire their own one-shot stream) — is
    //    stopped at once so nothing paints desktop frames for the whole
    //    interview. Measured 2026-09-05: 160–210 ms end to end, against
    //    230 ms (sources) + 280 ms (capture) for the path below.
    if (isWindows && navigator.mediaDevices?.getDisplayMedia) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: { frameRate: { ideal: 1, max: 2 } },
        });
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          // Verified with a standalone probe (2026-09-05): the loopback audio
          // track stays live and keeps delivering after the video track stops.
          stream.getVideoTracks().forEach(v => { try { v.stop(); } catch { /* already ended */ } });
          return { stream, audioStream: new MediaStream(audioTracks) };
        }
        stream.getTracks().forEach(t => t.stop());
        console.warn('[mic] loopback capture returned no audio — falling back to desktop capture');
      } catch (e: any) {
        console.warn('[mic] loopback capture unavailable — falling back to desktop capture:', e?.message || e);
      }
    }

    // ── Legacy path (macOS, or the Windows fallback) ──
    // desktopCapturer is only available in main process (Electron 17+).
    // Reach it through the contextBridge surface — see electron/preload.cjs.
    // Screen only, no thumbnails: we pick "Entire Screen" by name anyway, and
    // thumbnails of every open window were the expensive part.
    //
    // ── AND IF IT FAILS, THE MIC STILL STARTS ──
    // Field report 2026-09-06, macOS: "Capture Error: Error invoking remote
    // method 'get-desktop-sources': Failed to get sources" — Screen Recording
    // was off for the app, so this call threw, the throw reached
    // startListening, and the button stayed OFF. A user who could not hear
    // the interviewer THROUGH THE APP was left unable to hear them at all.
    // Any failure below — no permission, no sources, no system-audio track
    // (the normal case on macOS without a virtual audio device) — now falls
    // back to the microphone, and the reason is surfaced as a notice, not
    // an error: the mic is ON, and the user is told what would make it
    // better.
    try {
      const sources = await window.electronAPI.invoke<any[]>('get-desktop-sources', { screenOnly: true, thumbnails: false });

      if (!sources || sources.length === 0) {
        throw new Error('No capture sources found');
      }

      // Try to find "Entire Screen" first, fall back to first source
      const screenSource = sources.find((s: any) =>
        s.name === 'Entire Screen' || s.name === 'Screen 1' || s.name.toLowerCase().includes('screen')
      ) || sources[0];

      // In Electron, we use getUserMedia with chromeMediaSource constraints.
      // This captures system audio on Windows. macOS has limitations (see notes below).
      // ⚠️ The video constraint is REQUIRED on this API: asking for desktop audio
      // alone terminates the renderer (Chromium bad-message 263, reproduced
      // 2026-09-05). That is why the Windows fast path above exists.
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
    } catch (captureErr: any) {
      return micOnlyCapture(captureErr);
    }

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
  onNotice,
}: UseSpeechRecognitionProps) => {
  const [isListening, setIsListening] = useState(false);
  // A reduced listening mode the user should know about (microphone only,
  // and why). Distinct from `error`: the mic is ON when this is set.
  const [notice, setNotice] = useState<string | null>(null);
  // True from the click until the Deepgram socket opens (or the start fails).
  // The button renders STARTING… on it — the user sees the click land.
  const [isStarting, setIsStarting] = useState(false);
  // True while a live session's socket is being re-established. isListening
  // stays true meanwhile: the user's intent is ON, and flipping the button
  // OFF for a one-second Deepgram idle close read as "the mic died".
  const [isReconnecting, setIsReconnecting] = useState(false);
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
  const startingRef = useRef(false); // a start is in flight (dedupe double-clicks / IPC echoes)
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
    startingRef.current = false;
    setIsListening(false);
    setIsStarting(false);
    setIsReconnecting(false);
    setNotice(null);

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
    // The Deepgram key is NOT dropped here: it is good for its whole
    // lifetime (services/deepgramKey.ts), and re-fetching it on every
    // restart was one of the seconds the user waited.
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
      startingRef.current = false;
      setIsListening(true);
      setIsStarting(false);
      setIsReconnecting(false);
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

      // Clear keepalive on close
      if (keepaliveIntervalRef.current) {
        clearInterval(keepaliveIntervalRef.current);
        keepaliveIntervalRef.current = null;
      }

      if (intentionalStopRef.current) {
        // user stopped — nothing to recover
        setIsListening(false);
        setIsStarting(false);
        setIsReconnecting(false);
        return;
      }

      // A close before ANY data is the signature of a rejected key (1008
      // policy close, 4xxx application codes) or a config problem. Whatever
      // the reason, that key is not reused — the next connect fetches fresh.
      const fastFail = !gotDataRef.current;
      if (fastFail || event.code === 1008 || (event.code >= 4000 && event.code < 5000)) {
        invalidateDeepgramKey();
      }

      // ── Auth/config storm-breaker (#7) ──
      // A few fast-fails in a row means reconnecting won't help — stop and
      // surface a clear error instead of hammering forever.
      if (fastFail) {
        fastFailStreakRef.current += 1;
      } else {
        fastFailStreakRef.current = 0;
      }
      if (fastFailStreakRef.current >= 5) {
        console.error('[mic] giving up after repeated fast-fail closes (auth/config?) code=', event.code);
        startingRef.current = false;
        setIsListening(false);
        setIsStarting(false);
        setIsReconnecting(false);
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
          setIsReconnecting(true);
          recoverRef.current();
        } else {
          console.warn('[mic] capture ended (share stopped) — stopping');
          stopListening();
        }
        return;
      }

      // ── Reconnect WITHOUT flipping the button off ──
      // The first retry is immediate: most drops are a Deepgram idle close
      // or a WiFi handover, and a second of backoff was a second of the
      // interview unheard. Then 1 s, 2 s, 4 s, capped at 5 s. The key is
      // the cached one unless this close just invalidated it.
      reconnectAttemptsRef.current += 1;
      const n = reconnectAttemptsRef.current;
      const delay = n <= 1 ? 0 : Math.min(1000 * Math.pow(2, n - 2), 5000);
      console.log(`Deepgram auto-reconnect #${n} in ${delay}ms`);
      setIsReconnecting(true);
      setError('Reconnecting…');

      reconnectTimerRef.current = setTimeout(async () => {
        if (intentionalStopRef.current || !audioStreamRef.current) return;
        let keyToUse = cleanKey;
        try {
          keyToUse = await getDeepgramKeyCached({ force: fastFail });
        } catch (e) {
          console.error('Failed to refresh Deepgram key:', e);
          // Continue with the old key
        }
        if (intentionalStopRef.current || !audioStreamRef.current) return;
        connectDeepgram(audioStreamRef.current, keyToUse);
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
    // The Windows fast path stops its video track on purpose — nothing to wire.
    if (vTracks.length > 0 && vTracks[0].readyState === 'live') {
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
          setIsReconnecting(true);
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
    setIsReconnecting(true);
    setError('Reconnecting…');
    try {
      // Drop the dead stream's tracks before re-acquiring.
      audioStreamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch {} });
      streamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch {} });
      const { stream, audioStream, notice: reNotice } = await getAudioStream();
      setNotice(reNotice || null);
      if (intentionalStopRef.current) {
        stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        return;
      }
      streamRef.current = stream;
      setCurrentStream(stream);
      audioStreamRef.current = audioStream;
      wireTracks(stream, audioStream);
      let keyToUse = '';
      try {
        keyToUse = await getDeepgramKeyCached();
      } catch { /* reported below */ }
      if (!keyToUse) {
        setIsListening(false);
        setIsReconnecting(false);
        setError('Voice service unavailable. Please restart the mic.');
        return;
      }
      connectDeepgram(audioStream, keyToUse);
    } catch (e: any) {
      console.error('[mic] re-acquire failed:', e?.message || e);
      setIsListening(false);
      setIsReconnecting(false);
      setError('Lost the microphone and could not recover. Please stop and start again.');
    } finally {
      reacquiringRef.current = false;
    }
  }, [connectDeepgram, wireTracks]);

  // Late-bind recover so connectDeepgram's onclose can reach reacquireStream
  // without a declaration cycle.
  useEffect(() => { recoverRef.current = reacquireStream; }, [reacquireStream]);

  const startListening = useCallback(async () => {
    // Already starting, or already live — a double click / IPC echo must not
    // open a second capture or a second socket.
    if (startingRef.current) return;
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) return;

    setError(null);
    intentionalStopRef.current = false;
    reconnectAttemptsRef.current = 0;
    startingRef.current = true;
    setIsStarting(true);

    try {
      // The key round trip and the capture share nothing, so they run at the
      // same time. allSettled, because a capture that succeeded while the key
      // failed must be released, not leaked.
      const [keyResult, captureResult] = await Promise.allSettled([getDeepgramKeyCached(), getAudioStream()]);

      if (intentionalStopRef.current) {
        // The user hit stop while we were starting — release what we got.
        if (captureResult.status === 'fulfilled') {
          captureResult.value.stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        }
        return;
      }
      if (captureResult.status === 'rejected') throw captureResult.reason;
      const { stream, audioStream, notice: captureNotice } = captureResult.value;
      // A reduced mode is not an error: the mic is about to be ON. Tell the
      // user what they are getting, and keep the red error bar for failures.
      setNotice(captureNotice || null);
      if (captureNotice) onNotice?.(captureNotice);

      if (keyResult.status === 'rejected' || !keyResult.value) {
        stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        const msg = keyResult.status === 'rejected'
          ? String((keyResult.reason && keyResult.reason.message) || 'Could not get Deepgram key. Please try again.')
          : 'Could not get Deepgram key. Please try again.';
        setError(msg);
        onError?.(msg);
        return;
      }

      streamRef.current = stream;
      setCurrentStream(stream);
      audioStreamRef.current = audioStream;

      // Wire failure handlers (video decoupled from audio; audio loss
      // recovers) then connect to Deepgram. isStarting clears in onopen.
      wireTracks(stream, audioStream);
      connectDeepgram(audioStream, keyResult.value);

    } catch (err: any) {
      console.error("Capture Error:", err);
      if (err?.name !== 'NotAllowedError') {
        const msg = `Capture Error: ${err?.message || 'Could not start audio capture'}`;
        setError(msg);
        onError?.(msg);
      }
    } finally {
      // Nothing connecting → the start is over (failed or abandoned). While a
      // socket is CONNECTING the button keeps saying STARTING… until onopen.
      const s = socketRef.current;
      if (!s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
        startingRef.current = false;
        setIsStarting(false);
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

  return { isListening, isStarting, isReconnecting, error, notice, startListening, stopListening, stream: currentStream };
};
