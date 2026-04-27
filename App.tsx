import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Mic, MicOff, Send, FileText, Upload, Trash2, Cpu, FileCheck, RefreshCw, HelpCircle, AlertTriangle, Zap, MessageSquare, Edit3, X, ChevronDown, Menu, ExternalLink, Moon, Sun, Copy, Check, Save, ToggleLeft, ToggleRight, Info, ScreenShare, ScreenShareOff, Plus, FilePlus, Wand2, Download, Monitor, Laptop, Terminal, LogOut, Crown, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { generateGemini, generateOpenAI, generateXAI, generateGroq, streamGemini, streamOpenAI, streamXAI, streamGroq, AUTO_SOLVE_PROMPT, prewarmIdentity, generateConversationTitle } from './services/aiProxyService';
import { generateClaude, streamClaude, prewarmClaudeIdentity, trainClaudeModel, trainClaudeModelBeast, hasCachedTechState, type TrainingProgress } from './services/claudeService';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { extractTextFromPdf } from './services/pdfService';
import { extractTextFromDocx } from './services/docxService';
import { useDatabase, SessionSummary } from './hooks/useDatabase';
import { Message, AppSettings, ContextFile } from './types';
import { SubscriptionGate } from './SubscriptionGate';
import { Tutorial, shouldShowTutorial, markTutorialCompleted, clearTutorialCompletion } from './Tutorial';
import { ManageSubscription } from './ManageSubscription';
import { licenseService, UserProfile, LicenseData, TIME_CONSTANTS } from './services/licenseService';
import { creditTimerService } from './services/creditTimerService';
import { pricingService } from './services/pricingService';
import './pip-styles.css';

// --- Electron Helpers ---
// Electron detection now reads window.electronAPI (set by preload.cjs)
// instead of the old `process.versions.electron`, which isn't exposed
// when contextIsolation:true + nodeIntegration:false.
const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
const isPopoutMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'popout';

// Add popout-mode class to HTML for CSS targeting (cursor override for screen share)
if (isPopoutMode && typeof document !== 'undefined') {
  document.documentElement.classList.add('popout-mode');
}

// Thin wrapper over the contextBridge surface in electron/preload.cjs.
// The bridge already enforces channel allowlists + returns disposers from
// on(), so this layer mostly just guards the non-Electron (browser) case.
const electronIPC = {
  send: (channel: string, data?: any) => {
    if (!isElectron) return;
    try { window.electronAPI?.send(channel, data); }
    catch (e) { console.warn('IPC send failed:', e); }
  },
  on: (channel: string, callback: (data: any) => void): (() => void) => {
    if (!isElectron) return () => {};
    try { return window.electronAPI?.on(channel, callback) || (() => {}); }
    catch (e) { console.warn('IPC on failed:', e); return () => {}; }
  },
  invoke: async (channel: string, ...args: any[]): Promise<any> => {
    if (!isElectron) return null;
    try { return await window.electronAPI?.invoke(channel, ...args); }
    catch (e) { console.warn('IPC invoke failed:', e); return null; }
  }
};

// ────────────────────────────────────────────────────────────────
// AUTO-TYPE SMART SKIP — OCR the target editor before typing so
// we can drop any leading lines that are already on screen (e.g.
// the platform's starter function signature / imports). Passive:
// no Ctrl+A, no Ctrl+C, no clipboard touch — just a screenshot.
//
// OCR is inherently fuzzy on code fonts. When the signal is weak
// or noisy we return 0 (skip nothing) and let the full block type.
// ────────────────────────────────────────────────────────────────

async function captureScreenBase64ForOCR(): Promise<string | null> {
  if (!isElectron) return null;
  let tempStream: MediaStream | null = null;
  try {
    const sources = await electronIPC.invoke('get-desktop-sources');
    if (!sources || sources.length === 0) return null;
    const screenSource = sources.find((s: any) =>
      s.name === 'Entire Screen' || s.name === 'Screen 1' || s.name.toLowerCase().includes('screen')
    ) || sources[0];

    tempStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screenSource.id,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 5,
        }
      } as any,
    });
    const videoTrack = tempStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') return null;

    const video = document.createElement('video');
    video.srcObject = new MediaStream([videoTrack]);
    await video.play();

    // Upscale for OCR — tesseract struggles on small monospace glyphs at
    // 1:1. 1.5x bump trades bytes for noticeably better code-font accuracy.
    const scale = 1.5;
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = 'high';
      ctx.drawImage(video, 0, 0, width, height);
    }
    const dataUrl = canvas.toDataURL('image/png');

    video.pause();
    video.srcObject = null;
    video.remove();
    canvas.remove();
    return dataUrl;
  } catch (e) {
    console.warn('[auto-type-ocr] capture failed:', e);
    return null;
  } finally {
    if (tempStream) tempStream.getTracks().forEach(t => t.stop());
  }
}

// Normalize a line for fuzzy comparison: strip whitespace, lowercase,
// fold the most common OCR confusables on code fonts (0/O, 1/l/I/|).
// rn→m isn't folded because it causes more false positives than it fixes.
function normalizeForOCRCompare(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[o]/g, '0')
    .replace(/[li|]/g, '1');
}

function levenshteinRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j - 1], dp[j]);
      prev = temp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

async function computeAutoTypeSkipLines(
  code: string,
  isCancelled: () => boolean = () => false,
): Promise<number> {
  try {
    if (isCancelled()) return 0;
    const dataUrl = await captureScreenBase64ForOCR();
    if (isCancelled()) return 0;
    if (!dataUrl) return 0;

    // Lazy-load tesseract — it's ~3MB of WASM, don't block app startup.
    const Tesseract: any = await import('tesseract.js');
    if (isCancelled()) return 0;
    const recognize = Tesseract.recognize || Tesseract.default?.recognize;
    if (!recognize) return 0;

    const { data } = await recognize(dataUrl, 'eng', {
      // PSM 6: uniform block of text — best for dense code regions.
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });
    if (isCancelled()) return 0;
    const ocrText: string = (data && data.text) || '';
    if (!ocrText.trim()) return 0;

    const ocrLines = ocrText.split('\n').map(normalizeForOCRCompare).filter(Boolean);
    if (ocrLines.length === 0) return 0;

    const codeLines = code.split('\n');
    let skip = 0;
    let substantiveMatched = 0;

    for (const rawLine of codeLines) {
      const norm = normalizeForOCRCompare(rawLine);
      // Blank / near-blank lines: advance the skip without counting as a
      // real match signal. Otherwise a code block starting with a blank
      // line would "match" trivially and we'd skip real content below.
      if (norm.length < 3) { skip++; continue; }

      let found = false;
      for (const ol of ocrLines) {
        if (ol.includes(norm)) { found = true; break; }
        if (norm.length >= 6 && levenshteinRatio(norm, ol) >= 0.82) { found = true; break; }
      }
      if (!found) break;
      skip++;
      substantiveMatched++;
    }

    // Trust threshold: need at least one substantive match, and if the skip
    // would eat the entire block we bail (OCR almost certainly over-fired).
    if (substantiveMatched < 1) return 0;
    if (skip >= codeLines.length) return 0;
    return skip;
  } catch (e) {
    console.warn('[auto-type-ocr] OCR/skip compute failed, typing full block:', e);
    return 0;
  }
}

// --- Helper: Code Block Renderer ---

// Auto-type phases drive the button UI while nut-js drives keystrokes in main.
// 'idle' = default, 'countdown' = waiting for user to alt-tab to target editor,
// 'preparing' = OCR running before countdown, 'typing' = keystrokes in flight,
// 'done' = brief success flash, 'verify-mismatch' = typed but UIA read-back
// disagreed with what we typed (editor may have stripped/reformatted or we
// dropped input) — surfaced so the user can eyeball the result.
type AutoTypePhase = 'idle' | 'preparing' | 'countdown' | 'typing' | 'done' | 'verify-mismatch';

const CodeBlock: React.FC<{
    code: string;
    language: string;
    canAutoType?: boolean;
    // True while the parent message is still streaming. In that case we
    // skip the Prism syntax highlighter (which re-tokenizes the entire
    // code block every render — easily 10-20ms per frame on long blocks
    // at 60fps, enough to stall textarea input on the main thread) and
    // render plain <pre><code> instead. The block re-renders ONCE with
    // full highlighting at commit time — the user sees a single pleasant
    // "flash to colored" when their answer is complete, not a gradual
    // jank.
    isStreaming?: boolean;
}> = React.memo(({ code, language, canAutoType, isStreaming }) => {
    const [copied, setCopied] = useState(false);
    const [atPhase, setAtPhase] = useState<AutoTypePhase>('idle');
    const [atCountdown, setAtCountdown] = useState(0);
    // Transient error banner for the Auto-Type flow. We can't use an OS
    // alert() — it paints outside setContentProtection and leaks on screen
    // share. Renders inline under the header and self-clears after 8s.
    const [atError, setAtError] = useState<string | null>(null);
    const atErrorTimerRef = useRef<number | null>(null);
    const surfaceAtError = (msg: string) => {
        setAtError(msg);
        if (atErrorTimerRef.current !== null) window.clearTimeout(atErrorTimerRef.current);
        atErrorTimerRef.current = window.setTimeout(() => {
            atErrorTimerRef.current = null;
            setAtError(null);
        }, 8000);
    };
    // Cancel flag for the 'preparing' (OCR) phase. Main doesn't know about
    // Auto-Type yet during OCR, so the usual auto-type:abort IPC is a no-op
    // — we cancel locally and short-circuit before invoking the typing IPC.
    const prepCancelledRef = useRef(false);
    // Latches whether the most recent type cycle ended with a UIA verify
    // mismatch. Written by the status listener when 'verify-mismatch' fires,
    // read when 'done' fires (verify signals always arrive before 'done').
    // Cleared at the start of each cycle so stale verdicts don't bleed across.
    const verifyMismatchRef = useRef(false);
    // Diagnostics from the most recent verify-mismatch — what we expected to
    // find in the editor vs. what was actually there. Surfaced in the error
    // toast so the user can tell focus-loss from autocomplete-collision from
    // a genuine race, instead of seeing an opaque "interrupted" message.
    const verifyDiagnosticsRef = useRef<{ expected?: string; actual?: string; lineIndex?: number; hint?: string } | null>(null);
    // Timer id for the post-'done' flash revert. Tracked so we can cancel it
    // on unmount (stops setState-on-unmounted warnings when the CodeBlock is
    // torn down mid-flash) and on a fresh click (stops a stale revert from
    // kicking us back to idle just after we queued a new cycle).
    const flashTimerRef = useRef<number | null>(null);
    // Synchronous double-click guard. State updates are batched, so two rapid
    // clicks both observe atPhase==='idle' and both try to start a cycle —
    // the ref flips synchronously and blocks the second entry.
    const clickInFlightRef = useRef(false);
    const copyTimerRef = useRef<number | null>(null);

    const clearFlashTimer = () => {
        if (flashTimerRef.current !== null) {
            window.clearTimeout(flashTimerRef.current);
            flashTimerRef.current = null;
        }
    };
    const scheduleFlashRevert = (ms: number) => {
        clearFlashTimer();
        flashTimerRef.current = window.setTimeout(() => {
            flashTimerRef.current = null;
            setAtPhase('idle');
        }, ms);
    };

    // Cancel any pending timers if the CodeBlock unmounts mid-flash / mid-copy-reset.
    useEffect(() => () => {
        clearFlashTimer();
        if (copyTimerRef.current !== null) {
            window.clearTimeout(copyTimerRef.current);
            copyTimerRef.current = null;
        }
        if (atErrorTimerRef.current !== null) {
            window.clearTimeout(atErrorTimerRef.current);
            atErrorTimerRef.current = null;
        }
    }, []);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
            copyTimerRef.current = null;
            setCopied(false);
        }, 2000);
    };

    // Listen for status events from main while a type is in flight.
    // Registered only while button is in non-idle state to avoid stale listeners.
    // Event ordering from main: countdown* → typing → [verify-ok | verify-mismatch]? → done
    // The verify signal (when present) arrives right before 'done'; we latch
    // any mismatch into a ref and consult it when 'done' lands so the user
    // actually sees the warning — otherwise 'done' would clobber it.
    useEffect(() => {
        if (atPhase === 'idle') return;
        const handler = (data: any) => {
            if (!data || typeof data !== 'object') return;
            if (data.phase === 'countdown') {
                setAtPhase('countdown');
                setAtCountdown(data.n);
            } else if (data.phase === 'typing') {
                // Fresh cycle: clear last cycle's verdict.
                verifyMismatchRef.current = false;
                setAtPhase('typing');
            } else if (data.phase === 'verify-mismatch') {
                verifyMismatchRef.current = true;
                // Capture the diagnostic payload so the toast can show
                // expected vs. actual + a likely-cause hint when 'done' lands.
                verifyDiagnosticsRef.current = {
                    expected: typeof data.expected === 'string' ? data.expected : undefined,
                    actual: typeof data.actual === 'string' ? data.actual : undefined,
                    lineIndex: typeof data.lineIndex === 'number' ? data.lineIndex : undefined,
                    hint: typeof data.hint === 'string' ? data.hint : undefined,
                };
            } else if (data.phase === 'verify-ok') {
                verifyMismatchRef.current = false;
                verifyDiagnosticsRef.current = null;
            } else if (data.phase === 'done') {
                if (data.aborted) {
                    // Aborted run — surface a toast that explains WHY. Order
                    // of preference (most specific first):
                    //   1. SID drift mid-flight (verifyMismatchRef + diagnostic on either ref or broadcast)
                    //   2. Reason field on the broadcast (preflight, native module, typing loop throw)
                    //   3. Hint field on the broadcast
                    //   4. Generic "stopped early" so user never sees a silent reset
                    clearFlashTimer();
                    setAtPhase('idle');

                    // Build the diagnostic string from whichever source has data.
                    // The 'done' broadcast now mirrors the diagnostic fields from
                    // verify-mismatch, so we can pull from `data` directly even
                    // if the verify-mismatch event was missed during a phase
                    // transition (the listener is re-registered on every atPhase
                    // change and could lose an in-flight event).
                    const diag = verifyDiagnosticsRef.current || {
                        expected: typeof data.expected === 'string' ? data.expected : undefined,
                        actual: typeof data.actual === 'string' ? data.actual : undefined,
                        lineIndex: typeof data.lineIndex === 'number' ? data.lineIndex : undefined,
                        hint: typeof data.hint === 'string' ? data.hint : undefined,
                    };
                    const reason = typeof data.reason === 'string' ? data.reason : '';

                    if (reason === 'user_abort') {
                        // Explicit user cancel — no toast, that's expected behavior.
                    } else if (verifyMismatchRef.current || reason === 'sid_drift_during_typing') {
                        const where = diag.lineIndex ? ` after line ${diag.lineIndex}` : '';
                        const expected = diag.expected ? `Expected near cursor: ${JSON.stringify(diag.expected)}` : '';
                        const actual = diag.actual ? `Editor tail: ${JSON.stringify(diag.actual)}` : '';
                        const hint = diag.hint || 'Likely cause: editor lost focus, autocomplete inserted text, or you typed manually during the run.';
                        const lines = [`Auto-Type stopped${where} — typed text is not in the editor.`, expected, actual, hint].filter(Boolean);
                        surfaceAtError(lines.join('\n'));
                    } else if (diag.hint) {
                        surfaceAtError(diag.hint);
                    } else if (reason) {
                        surfaceAtError(`Auto-Type stopped: ${reason.replace(/_/g, ' ')}.`);
                    } else {
                        // Last-resort generic — silent reset is the bug we just fixed.
                        surfaceAtError('Auto-Type stopped early. Try again — if it keeps happening, restart the app.');
                    }
                } else if (verifyMismatchRef.current) {
                    // Actionable warning — linger longer so the user notices.
                    setAtPhase('verify-mismatch');
                    scheduleFlashRevert(3500);
                    // Push the diagnostic into the persistent error toast as
                    // well, so the user sees concrete evidence (expected vs
                    // actual snippet + a likely-cause hint) and can tell why
                    // it stopped — focus loss, autocomplete, or manual typing
                    // during the run all surface different actuals.
                    const diag = verifyDiagnosticsRef.current;
                    if (diag) {
                        const where = diag.lineIndex ? ` after line ${diag.lineIndex}` : '';
                        const expected = diag.expected ? `Expected near cursor: ${JSON.stringify(diag.expected)}` : '';
                        const actual = diag.actual ? `Editor tail: ${JSON.stringify(diag.actual)}` : '';
                        const hint = diag.hint || '';
                        const lines = [`Auto-Type stopped${where} — typed text is not in the editor.`, expected, actual, hint].filter(Boolean);
                        surfaceAtError(lines.join('\n'));
                    }
                } else {
                    setAtPhase('done');
                    scheduleFlashRevert(1500);
                }
            }
        };
        const dispose = electronIPC.on('auto-type:status', handler);
        return dispose;
    }, [atPhase]);

    const handleAutoType = async () => {
        // Web mode can't drive OS keyboard events, so the button is hidden in
        // render below. Kept as a defensive guard in case the hide condition
        // ever regresses.
        if (!isElectron) return;
        if (atPhase === 'preparing') {
            // Abort during OCR: main isn't involved yet, cancel locally.
            prepCancelledRef.current = true;
            clearFlashTimer();
            setAtPhase('idle');
            return;
        }
        if (atPhase === 'countdown' || atPhase === 'typing') {
            // Second click during countdown / typing = abort via main.
            electronIPC.send('auto-type:abort');
            return;
        }
        // Fresh start — reachable from 'idle' and from the brief 'done' /
        // 'verify-mismatch' flash windows. Treating the flash phases as
        // re-entry points means a user who wants to immediately retry isn't
        // blocked by the 1.5s/3.5s setTimeout.
        if (clickInFlightRef.current) return;
        clickInFlightRef.current = true;
        // Kill any pending flash revert so it can't stomp the phase transitions
        // we're about to queue.
        clearFlashTimer();

        try {
            // macOS requires Accessibility permission. Check before countdown so we
            // don't strand the user mid-flow with a silent failure.
            const perm = await electronIPC.invoke('auto-type:check-permission');
            if (perm && perm.ok === false) {
                surfaceAtError(perm.message || 'Auto-Type needs Accessibility permission. Grant it in System Settings → Privacy & Security → Accessibility, then restart the app.');
                setAtPhase('idle');
                return;
            }

            // Smart skip planning. Two paths:
            //
            //   (A) Windows w/ UIA — main does ALL planning AFTER the countdown,
            //       once the user has alt-tabbed to the target editor. Main
            //       reads the focused editor via UIA, runs the deterministic
            //       prefix-matcher, and if confidence is low it calls the
            //       Claude Haiku 4.5 planner over Railway using the auth token
            //       we pass through. Putting the snapshot AFTER countdown is
            //       critical — pre-countdown the focus is still on our app
            //       (we'd snapshot the wrong control).
            //
            //   (B) Everything else — fall back to screen OCR (Tesseract) as
            //       the preparing step before countdown. Slower but portable.
            //
            // Degrades to 0 (type everything) on any failure.
            prepCancelledRef.current = false;
            let skipLines = 0;
            let useMainPlanner = false;
            try {
                const caps = await electronIPC.invoke('auto-type:capabilities');
                if (caps && caps.hasA11y === true) {
                    useMainPlanner = true;
                }
            } catch (_) {
                // Old main without capabilities handler — fall through to OCR.
            }

            if (!useMainPlanner) {
                setAtPhase('preparing');
                skipLines = await computeAutoTypeSkipLines(code, () => prepCancelledRef.current);
                if (prepCancelledRef.current) {
                    setAtPhase('idle');
                    return;
                }
            }

            setAtPhase('countdown');
            setAtCountdown(3);
            // Auth token piggybacks on the payload so main can call the Railway
            // /autotype-plan endpoint directly post-countdown without needing
            // its own credential. Empty string if not signed in (Haiku planner
            // won't fire; deterministic UIA still runs).
            const authToken = licenseService.getToken() || '';
            const result = await electronIPC.invoke('auto-type:send', {
                code,
                skipLines,
                authToken,
                language: language || 'unknown',
            });
            if (result && result.error) {
                surfaceAtError(`Auto-Type failed: ${result.error}`);
                setAtPhase('idle');
            }
        } finally {
            clickInFlightRef.current = false;
        }
    };

    const autoTypeLabel =
        atPhase === 'preparing'       ? 'Scanning editor…' :
        atPhase === 'countdown'       ? `Typing in ${atCountdown}…  (click to cancel)` :
        atPhase === 'typing'          ? 'Typing…  (click to cancel)' :
        atPhase === 'done'            ? 'Done' :
        atPhase === 'verify-mismatch' ? 'Done — please verify editor' :
                                        'Auto-Type';
    const autoTypeClass =
        atPhase === 'done'            ? 'text-green-400'
      : atPhase === 'verify-mismatch' ? 'text-amber-400'
      : atPhase !== 'idle'            ? 'text-amber-400'
      :                                 'text-gray-400 hover:text-white';

    return (
        <div className="my-3 rounded-lg overflow-hidden border border-gray-700/50 bg-black/20 backdrop-blur-sm shadow-lg">
            <div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-gray-700/50">
                <span className="text-xs font-mono text-gray-400 lowercase">{language || 'code'}</span>
                <div className="flex items-center gap-3">
                    {isElectron && (
                        <button
                            onClick={handleAutoType}
                            disabled={!canAutoType && atPhase === 'idle'}
                            className={`flex items-center gap-1.5 text-xs transition-colors ${canAutoType || atPhase !== 'idle' ? autoTypeClass : 'text-gray-600 cursor-not-allowed'}`}
                            aria-label={canAutoType ? 'Types this code into the currently focused editor (HackerRank, CoderPad, etc.)' : 'Auto-Type — Max only'}
                        >
                            {atPhase === 'done'
                                ? <Check size={12} />
                                : atPhase === 'verify-mismatch'
                                ? <AlertTriangle size={12} />
                                : <Zap size={12} className={atPhase !== 'idle' ? 'animate-pulse' : ''} />}
                            <span>{autoTypeLabel}</span>
                            {!canAutoType && atPhase === 'idle' && <Crown size={10} className="text-amber-400" />}
                        </button>
                    )}
                    <button
                        onClick={handleCopy}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                    >
                        {copied ? <Check size={12} className="text-green-400"/> : <Copy size={12} />}
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
            </div>
            {atError && (
                <div
                    role="alert"
                    className="flex items-start gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-200"
                >
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-400" />
                    <span className="flex-1 leading-snug whitespace-pre-line">{atError}</span>
                    <button
                        onClick={() => {
                            if (atErrorTimerRef.current !== null) {
                                window.clearTimeout(atErrorTimerRef.current);
                                atErrorTimerRef.current = null;
                            }
                            setAtError(null);
                        }}
                        aria-label="Dismiss"
                        className="shrink-0 text-amber-400/70 hover:text-amber-200 transition-colors"
                    >
                        <X size={12} />
                    </button>
                </div>
            )}
            <div className="p-4 overflow-x-auto bg-transparent">
                {isStreaming ? (
                    // Cheap plain-text render during streaming. Styles MUST
                    // match vscDarkPlus's pre/code rules exactly (font,
                    // size, line-height, tab-size, whitespace) so the block
                    // has the same pixel height whether this lightweight
                    // renderer or the real SyntaxHighlighter is drawing it.
                    // If heights differ, the stream→commit swap shifts the
                    // scroll position, which the user feels as a "jerk" at
                    // the end of the answer.
                    //
                    // Source of truth:
                    //   node_modules/react-syntax-highlighter/dist/esm/
                    //   styles/prism/vsc-dark-plus.js
                    <pre
                        style={{
                            margin: 0,
                            padding: 0,
                            background: 'transparent',
                            color: '#d4d4d4',
                            fontSize: '13px',
                            fontFamily: 'Menlo, Monaco, Consolas, "Andale Mono", "Ubuntu Mono", "Courier New", monospace',
                            lineHeight: '1.5',
                            tabSize: 4,
                            MozTabSize: 4,
                            whiteSpace: 'pre',
                            textAlign: 'left',
                            direction: 'ltr',
                            wordSpacing: 'normal',
                            wordBreak: 'normal',
                            textShadow: 'none',
                            overflow: 'auto',
                        } as React.CSSProperties}
                    >
                        <code
                            style={{
                                color: '#d4d4d4',
                                fontSize: '13px',
                                fontFamily: 'Menlo, Monaco, Consolas, "Andale Mono", "Ubuntu Mono", "Courier New", monospace',
                                lineHeight: '1.5',
                                tabSize: 4,
                                MozTabSize: 4,
                                whiteSpace: 'pre',
                                textShadow: 'none',
                            } as React.CSSProperties}
                        >{code.trim()}</code>
                    </pre>
                ) : (
                    <SyntaxHighlighter
                        language={language || 'text'}
                        style={vscDarkPlus}
                        customStyle={{ margin: 0, padding: 0, background: 'transparent' }}
                        wrapLines={true}
                    >
                        {code.trim()}
                    </SyntaxHighlighter>
                )}
            </div>
        </div>
    );
});

// Memoized so that when a streaming bubble updates its content, React
// can bail on re-rendering every committed message above it. Without this
// memoization, typing into the textarea stalls behind a full ReactMarkdown
// + Prism reconciliation pass for N messages × 60fps.
const MessageRenderer = React.memo(({ content, fontSize, canAutoType, isStreaming }: { content: string, fontSize: string, canAutoType?: boolean, isStreaming?: boolean }) => {
    // Font size mapping
    const sizeClass =
        fontSize === 'small' ? 'prose-sm' :
        fontSize === 'large' ? 'prose-lg' :
        'prose-base';

    return (
        <div className={`markdown-body prose dark:prose-invert max-w-none ${sizeClass} prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        return !inline && match ? (
                            <CodeBlock code={String(children).replace(/\n$/, '')} language={match[1]} canAutoType={canAutoType} isStreaming={isStreaming} />
                        ) : (
                            <code className="bg-gray-200 dark:bg-gray-800 rounded px-1 py-0.5 font-mono text-sm" {...props}>
                                {children}
                            </code>
                        );
                    }
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
});

// --- Components ---

const Modal = ({ isOpen, onClose, title, children, dismissOnBackdrop = true }: any) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  // Escape closes; Tab cycles focus inside the dialog (focus trap). Without
  // these, keyboard users had no way out of the modal and could tab into the
  // dimmed background.
  useEffect(() => {
    if (!isOpen) return;
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    const dlg = dialogRef.current;
    // Focus the first focusable element inside the dialog so screen-readers
    // and keyboard users land in the right place.
    const focusables = dlg?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    focusables?.[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      // Only respond to keys that originated INSIDE the dialog (or have no
      // target like programmatic dispatches). Without this, an Escape press
      // in an OAuth popup, sidebar, popout, or anywhere else in the app
      // could close THIS modal — and worse, our stopPropagation could hide
      // the Escape from auth callbacks / page-level handlers.
      const target = e.target as Node | null;
      if (target && dlg && !dlg.contains(target)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key === 'Tab' && dlg) {
        const items = dlg.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        // Skip the trap entirely when there's nothing to cycle between —
        // a single-button modal doesn't need (or want) Tab to loop on itself.
        if (items.length <= 1) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Bubbling phase (no `true`) — let page-level handlers run first. The
    // capture-phase version we shipped briefly was stealing keys destined
    // for inputs, focus traps inside iframes, and OS auth popups.
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to whatever opened the modal so the user lands back
      // where they were before.
      try { lastFocusRef.current?.focus(); } catch {}
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  const inElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{
        background: inElectron ? 'rgba(0,0,0,0.92)' : 'rgba(0,0,0,0.5)',
        zIndex: 99999,
        WebkitAppRegion: 'no-drag',
      } as any}
      onClick={dismissOnBackdrop ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={dialogRef}
        className="border border-border rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl overflow-hidden text-text"
        style={{ background: inElectron ? '#1a1a2e' : 'var(--surface-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex justify-between items-center bg-gray-500/5">
          <h2 className="text-lg font-bold flex items-center gap-2">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-primary transition-colors p-1 rounded-full hover:bg-gray-500/10 focus-visible:ring-2 focus-visible:ring-primary outline-none"
            aria-label="Close"
          >
             <X size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto custom-scrollbar flex-1">
          {children}
        </div>
      </div>
    </div>
  );
};

// Extracted for re-use between Main Window and PiP Window
const ChatInterface = ({
    messages,
    streamingMsg,
    settings,
    setSettings, // Added to allow model switching from main UI
    isListening, 
    isProcessing, 
    inputText, 
    setInputText, 
    interimText, 
    speechError, 
    toggleAutoSend, 
    startListening, 
    stopListening, 
    handleManualSend, 
    handleAutoSolve,
    handleClear,
    handleRegenerate,
    chatContainerRef,
    textareaRef,
    handleScroll,
    isPinned,
    newSinceUnpin,
    handleJumpToLatest,
    onOpenSettings,
    onOpenContext,
    onOpenHelp,
    onOpenDownload,
    isPipMode,
    togglePip,
    onNewSession,
    userProfile,
    userLicense,
    onLogout,
    onOpenManageSub,
    gate,
    creditTimer,
    effectiveTier,
    markPendingPopoutModel,
}: any) => {

    const setSelectedModel = (newModel: 'gemini' | 'groq' | 'openai' | 'xai' | 'claude') => {
        // ── Feature Gate: Block model switch for free users ──
        if (!gate.canUseModel(newModel)) return;
        // Immediate optimistic update in whichever window this runs in
        const newSettings = {
            ...settings,
            selectedModel: newModel
        };
        setSettings(newSettings);
        // Persist immediately
        localStorage.setItem("SELECTED_MODEL", newModel);
        // When this runs inside the Electron pop-out, also tell the main window
        // — main is the one that actually calls executeSend, so its own
        // settings.selectedModel has to flip too or the popout selector is
        // purely cosmetic. Main echoes the change back via the state-sync push.
        if (isElectron && isPopoutMode) {
            // Mark as pending BEFORE the IPC so any stale state-sync that
            // happens to cross paths with our request is ignored by the
            // popout's state-sync handler.
            markPendingPopoutModel?.(newModel);
            electronIPC.send('relay-to-main', { type: 'cmd-set-model', model: newModel });
        }
    };

    const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSelectedModel(e.target.value as 'gemini' | 'groq' | 'openai' | 'xai' | 'claude');
    };

    // Pop-out size presets: S → M → L cycle
    const sizePresets = [
        { label: 'S', w: 340, h: 480 },
        { label: 'M', w: 450, h: 700 },
        { label: 'L', w: 580, h: 850 },
    ];
    const [sizeIndex, setSizeIndex] = useState(1); // Start at M

    // Pop-out model selector — custom DOM popover replaces the native <select>.
    // Native <select> opens a separate Win32 HWND that can't survive
    // enforceAlwaysOnTop's 2s reassertion (electron/main.cjs:239) — the popup
    // ends up z-buried under the popout window. A portal'd DOM popover lives
    // inside the BrowserWindow's compositor surface, so it inherits
    // setContentProtection (invisible to screen share) and can't be z-buried.
    const MODEL_OPTIONS = [
        { value: 'gemini' as const, label: 'Gemini' },
        { value: 'groq' as const, label: 'Groq' },
        { value: 'openai' as const, label: 'GPT' },
        { value: 'xai' as const, label: 'Grok' },
        { value: 'claude' as const, label: 'Claude' },
    ];
    const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
    const [modelMenuPos, setModelMenuPos] = useState<{ top: number; right: number } | null>(null);
    const modelButtonRef = useRef<HTMLButtonElement>(null);
    const modelMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isModelMenuOpen) return;
        const closeOnOutside = (e: MouseEvent) => {
            const t = e.target as Node;
            if (modelMenuRef.current?.contains(t)) return;
            if (modelButtonRef.current?.contains(t)) return;
            setIsModelMenuOpen(false);
        };
        const closeOnEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsModelMenuOpen(false);
        };
        const closeOnResize = () => setIsModelMenuOpen(false);
        document.addEventListener('mousedown', closeOnOutside);
        document.addEventListener('keydown', closeOnEsc);
        window.addEventListener('resize', closeOnResize);
        return () => {
            document.removeEventListener('mousedown', closeOnOutside);
            document.removeEventListener('keydown', closeOnEsc);
            window.removeEventListener('resize', closeOnResize);
        };
    }, [isModelMenuOpen]);

    const toggleModelMenu = () => {
        if (isModelMenuOpen) { setIsModelMenuOpen(false); return; }
        const btn = modelButtonRef.current;
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        setModelMenuPos({
            top: rect.bottom + 4,
            right: window.innerWidth - rect.right,
        });
        setIsModelMenuOpen(true);
    };

    if (isPipMode) {
        // Detect Electron for window controls
        const inElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;

        const cycleSize = () => {
            const next = (sizeIndex + 1) % sizePresets.length;
            setSizeIndex(next);
            electronIPC.send('resize-popout', { width: sizePresets[next].w, height: sizePresets[next].h });
        };

        // Shared button style for glass look
        const glassBtn = {
            background: 'transparent',
            border: '1px solid var(--glass-border)',
            color: 'var(--text-main)',
        };

        return (
            <div className="popup open" style={inElectron ? { background: 'transparent' } : undefined}>
                <div className="bg-layer"></div>
                
                {/* ── HEADER ── */}
                <div
                    className="popup-header"
                    id="dragHandle"
                    style={inElectron ? { WebkitAppRegion: 'drag', padding: '10px 12px' } as any : undefined}
                >
                    {/* Left: Name (avatar removed — name is the only identity element) */}
                    <div className="header-info" style={{ minWidth: 0 }}>
                        <h4>minicaai</h4>
                        <span><span className="dot"></span> Online</span>
                    </div>

                    {/* Right: Controls row */}
                    <div
                        className="ml-auto flex items-center"
                        style={inElectron ? { WebkitAppRegion: 'no-drag', gap: '6px' } as any : { gap: '6px' }}
                    >
                        {/* Tier & credit chips — only at M/L sizes so the S preset
                            (340px) doesn't wrap the controls onto two rows. */}
                        {sizeIndex >= 1 && effectiveTier === 'max' && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border bg-gradient-to-r from-amber-500/10 to-purple-500/10 border-amber-500/40 text-amber-400">
                            <Crown size={9} /> MAX
                          </div>
                        )}
                        {sizeIndex >= 1 && effectiveTier === 'pro' && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border bg-blue-500/10 border-blue-500/30 text-blue-400">
                            <Crown size={9} /> PRO
                          </div>
                        )}
                        {sizeIndex >= 1 && effectiveTier === 'basic' && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border bg-emerald-500/10 border-emerald-500/30 text-emerald-400">
                            <Zap size={9} /> BASIC
                          </div>
                        )}
                        {sizeIndex >= 1 && creditTimer && (creditTimer.source === 'credits' || creditTimer.source === 'trial') && creditTimer.remaining > 0 && (
                          <div
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold border ${
                              creditTimer.remaining <= TIME_CONSTANTS.LOW_WARNING_SECONDS
                                ? 'bg-red-500/10 border-red-500/40 text-red-400'
                                : creditTimer.source === 'trial'
                                  ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                            }`}
                            aria-label={creditTimer.source === 'trial' ? 'Free trial time remaining' : 'Plan time remaining'}
                          >
                            {creditTimer.source === 'trial' ? 'TRIAL' : ''} {formatTimeRemaining(creditTimer.remaining)}
                          </div>
                        )}
                        {/* Model selector — custom popover (not native <select>) so the
                            options list lives inside the popout's compositor surface.
                            See comment block above on `MODEL_OPTIONS` for the rationale. */}
                        <div className="relative flex items-center">
                          <button
                              ref={modelButtonRef}
                              type="button"
                              onClick={toggleModelMenu}
                              className="appearance-none text-[10px] rounded pl-1.5 pr-5 py-0.5 outline-none cursor-pointer"
                              style={glassBtn}
                              aria-haspopup="listbox"
                              aria-expanded={isModelMenuOpen}
                          >
                              {(MODEL_OPTIONS.find(o => o.value === settings.selectedModel)?.label) ?? 'Gemini'}
                          </button>
                          <ChevronDown size={10} className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none opacity-70" />
                          {isModelMenuOpen && modelMenuPos && createPortal(
                            <div
                              ref={modelMenuRef}
                              role="listbox"
                              className="fixed z-[9999] py-1 rounded-md border text-[10px] min-w-[110px]"
                              style={{
                                  top: modelMenuPos.top,
                                  right: modelMenuPos.right,
                                  background: 'rgba(10, 10, 30, 0.92)',
                                  borderColor: 'var(--glass-border)',
                                  boxShadow: '0 6px 24px rgba(0, 0, 0, 0.55)',
                                  WebkitAppRegion: 'no-drag',
                              } as any}
                            >
                              {MODEL_OPTIONS.map(opt => {
                                  const allowed = gate.canUseModel(opt.value);
                                  const selected = opt.value === settings.selectedModel;
                                  return (
                                      <div
                                          key={opt.value}
                                          role="option"
                                          aria-selected={selected}
                                          aria-disabled={!allowed}
                                          onClick={() => {
                                              if (!allowed) return;
                                              setSelectedModel(opt.value);
                                              setIsModelMenuOpen(false);
                                          }}
                                          className={`px-2 py-1 flex items-center justify-between gap-2 ${
                                              allowed
                                                  ? 'hover:bg-white/10 cursor-pointer text-white'
                                                  : 'text-white/40 cursor-not-allowed'
                                          }`}
                                      >
                                          <span className="flex items-center gap-1">
                                              <Check size={9} className={selected ? 'opacity-90' : 'opacity-0'} />
                                              <span>{opt.label}</span>
                                          </span>
                                          {!allowed && (
                                              <span className={`text-[8px] font-bold tracking-wider ${opt.value === 'claude' ? 'text-orange-400/90' : 'text-amber-400/80'}`}>
                                                  {opt.value === 'claude' ? 'MAX' : 'PRO'}
                                              </span>
                                          )}
                                      </div>
                                  );
                              })}
                            </div>,
                            document.body
                          )}
                        </div>

                        {/* Settings */}
                        <button onClick={onOpenSettings} className="p-1 rounded transition-colors hover:bg-white/10" aria-label="Settings" style={glassBtn}>
                            <Settings size={13} strokeWidth={1.5} />
                        </button>

                        {/* ── Electron-only controls ── */}
                        {inElectron && (
                            <>
                                {/* Divider */}
                                <div style={{ width: 1, height: 16, background: 'var(--glass-border)', margin: '0 2px' }} />

                                {/* Size cycle: S → M → L */}
                                <button
                                    onClick={cycleSize}
                                    className="rounded transition-colors hover:bg-white/10"
                                    aria-label={`Resize (now ${sizePresets[sizeIndex].label})`}
                                    style={{ ...glassBtn, padding: '2px 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}
                                >
                                    {sizePresets[sizeIndex].label}
                                </button>

                                {/* Minimize */}
                                <button
                                    onClick={() => electronIPC.send('minimize-window')}
                                    className="p-1 rounded transition-colors hover:bg-white/10"
                                    aria-label="Minimize"
                                    style={glassBtn}
                                >
                                    <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                </button>

                                {/* Close */}
                                <button
                                    onClick={() => electronIPC.send('close-window')}
                                    className="p-1 rounded transition-colors hover:bg-red-500/30"
                                    aria-label="Close"
                                    style={glassBtn}
                                >
                                    <X size={13} strokeWidth={1.5} />
                                </button>
                            </>
                        )}
                    </div>
                </div>

                <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div
                    className="messages"
                    id="messages"
                    ref={chatContainerRef}
                    onScroll={handleScroll}
                >
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full space-y-4 opacity-80 mt-10" style={{ color: 'var(--text-muted)' }}>
                            <div className="w-16 h-16 rounded-full flex items-center justify-center relative border border-current" style={{ background: 'var(--bubble-user)' }}>
                                {isListening ? <Mic size={24} strokeWidth={1.5} className="animate-pulse" style={{ color: 'var(--text-main)' }} /> : <MicOff size={24} strokeWidth={1.5} />}
                                {settings.autoSend && <div className="absolute top-0 right-0 w-3 h-3 rounded-full border-2" style={{ background: 'var(--text-main)', borderColor: 'var(--glass-bg)' }}></div>}
                            </div>
                            <div className="text-center px-4">
                                <p className="font-medium mb-1 text-sm" style={{ color: 'var(--text-main)' }}>System Audio Copilot</p>
                                <p className="text-xs leading-relaxed max-w-xs mx-auto">
                                    {isListening ? 'Listening to system audio — speak or wait for the interviewer.' : 'Press Mic to start capturing system audio.'}
                                </p>
                            </div>
                        </div>
                    )}

                    {messages.map((msg: Message) => (
                        <div key={msg.id} className={`msg ${msg.role === 'user' ? 'user' : 'ai'}`}>
                            <span className="msg-name">{msg.role === 'user' ? 'You' : 'minicaai'}</span>
                            <div className="bubble">
                                <MessageRenderer content={msg.content} fontSize={settings.fontSize} canAutoType={gate.canAutoType} />
                            </div>
                            <span className="msg-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                    ))}

                    {streamingMsg && (
                        <div key={streamingMsg.id} className="msg ai streaming">
                            <span className="msg-name">minicaai</span>
                            <div className="bubble">
                                {streamingMsg.content
                                    ? <MessageRenderer content={streamingMsg.content} fontSize={settings.fontSize} canAutoType={gate.canAutoType} isStreaming />
                                    : <span className="typing-bubble"><span className="typing-dot"></span><span className="typing-dot"></span><span className="typing-dot"></span></span>}
                                <span className="stream-caret" aria-hidden="true" />
                            </div>
                        </div>
                    )}

                    {isProcessing && !streamingMsg && (
                        <div className="msg ai" id="typing">
                            <span className="msg-name">minicaai</span>
                            <div className="bubble typing-bubble">
                                <span className="typing-dot"></span>
                                <span className="typing-dot"></span>
                                <span className="typing-dot"></span>
                            </div>
                        </div>
                    )}
                </div>
                {!isPinned && (
                    <button
                        onClick={handleJumpToLatest}
                        aria-label="Jump to latest messages"
                        style={{
                            position: 'absolute',
                            bottom: 12,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 12px',
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'var(--text-main)',
                            // Bumped opacity from glass-bg's 0.78 to 0.92 because
                            // backdrop-filter is forbidden in the transparent popout
                            // (pip-styles.css line 312 — would crash the window),
                            // so the pill needs higher opacity to read against any
                            // desktop background behind it.
                            background: 'rgba(20,20,28,0.92)',
                            border: '1px solid var(--glass-border, rgba(255,255,255,0.14))',
                            boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
                            cursor: 'pointer',
                            zIndex: 5,
                        }}
                    >
                        <ChevronDown size={12} strokeWidth={2} />
                        {newSinceUnpin > 0 ? `${newSinceUnpin} new` : 'Latest'}
                    </button>
                )}
                </div>

                <div className="input-area" style={{ flexDirection: 'column', gap: '0' }}>
                    {/* ── Control strip: AUTO, MIC, LIVE status ── */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderBottom: '1px solid var(--glass-border)' }}>
                        <button
                            onClick={toggleAutoSend}
                            style={{
                                background: settings.autoSend ? 'rgba(59,130,246,0.2)' : 'transparent',
                                border: `1px solid ${settings.autoSend ? 'rgba(59,130,246,0.4)' : 'var(--glass-border)'}`,
                                color: settings.autoSend ? '#3b82f6' : 'var(--text-muted)',
                                padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '4px'
                            }}
                        >
                            <Zap size={10} /> {settings.autoSend ? 'AUTO' : 'MANUAL'}
                        </button>

                        <button
                            onClick={isListening ? stopListening : startListening}
                            style={{
                                background: isListening ? 'rgba(239,68,68,0.2)' : 'transparent',
                                border: `1px solid ${isListening ? 'rgba(239,68,68,0.4)' : 'var(--glass-border)'}`,
                                color: isListening ? '#ef4444' : 'var(--text-muted)',
                                padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '4px'
                            }}
                        >
                            {isListening ? <Mic size={10} /> : <MicOff size={10} />}
                            {isListening ? 'LIVE' : 'MIC OFF'}
                        </button>

                        {speechError && (
                            <span style={{ fontSize: '9px', color: '#ef4444', marginLeft: 'auto', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {speechError}
                            </span>
                        )}
                    </div>

                    {/* ── Input row ── */}
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', padding: '8px' }}>
                    <div className="input-wrap">
                        <textarea
                            id="inputBox"
                            className="pip-textarea"
                            placeholder={settings.autoSend ? "Listening for interviewer..." : "Type a message…"}
                            rows={1}
                            value={inputText}
                            // `field-sizing: content` delegates auto-grow to the browser and
                            // avoids the JS-triggered layout recomputation that caused
                            // per-keystroke typing lag. max-height (110px) in pip-styles.css
                            // continues to cap the grow region, with overflow scrolling past.
                            style={{ fieldSizing: 'content', maxHeight: 110 } as React.CSSProperties}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleManualSend();
                                }
                            }}
                        />
                    </div>
                    
                    <button 
                        className="send-btn" 
                        id="sendBtn" 
                        aria-label="Send message"
                        onClick={handleManualSend}
                        disabled={!inputText.trim() || isProcessing}
                        style={{ opacity: (!inputText.trim() || isProcessing) ? 0.5 : 1 }}
                    >
                        <Send size={18} strokeWidth={1.5} />
                    </button>
                    
                    <button
                        className="send-btn ml-2"
                        aria-label={gate.canAutoSolve ? "Auto-Solve" : "Auto-Solve — Pro only"}
                        onClick={handleAutoSolve}
                        disabled={isProcessing || !gate.canAutoSolve}
                        style={{ opacity: (isProcessing || !gate.canAutoSolve) ? 0.4 : 1, position: 'relative' }}
                    >
                        <Wand2 size={18} strokeWidth={1.5} />
                        {!gate.canAutoSolve && (
                            <span
                                className="absolute -top-1 -right-1 text-[7px] font-bold tracking-wider bg-amber-400/15 text-amber-300 px-1 py-px rounded border border-amber-400/40"
                                style={{ letterSpacing: '0.05em', lineHeight: 1 }}
                            >PRO</span>
                        )}
                    </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`flex-1 flex flex-col h-full overflow-hidden relative bg-transparent text-text transition-colors duration-300 ${settings.theme === 'dark' ? 'dark' : ''}`}>
             {/* --- RESPONSIVE HEADER --- */}
            <header className={`h-14 md:h-16 border-b border-white/15 bg-transparent flex items-center justify-between px-4 shrink-0 z-20 sticky top-0`}>
                <div className="flex items-center gap-2 md:gap-3">
                <h1 className="font-bold text-base md:text-lg tracking-tight hidden xs:block">minica<span className="text-blue-500">ai</span></h1>
                </div>

                <div className="flex items-center gap-2 md:gap-3">
                    {/* User tier badge — clickable, opens Manage Subscription */}
                    {userLicense && userLicense.tier === 'max' ? (
                      <button onClick={onOpenManageSub} title="Manage subscription" className="hidden md:flex px-2.5 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 border bg-gradient-to-r from-amber-500/10 to-purple-500/10 border-amber-500/40 text-amber-400 hover:from-amber-500/20 hover:to-purple-500/20 transition-all cursor-pointer">
                        <Crown size={10} /> MAX
                      </button>
                    ) : userLicense && userLicense.tier === 'pro' ? (
                      <button onClick={onOpenManageSub} title="Manage subscription" className="hidden md:flex px-2.5 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 border bg-blue-500/10 border-blue-500/30 text-blue-400 hover:bg-blue-500/20 transition-all cursor-pointer">
                        <Crown size={10} /> PRO
                      </button>
                    ) : userLicense && userLicense.tier === 'basic' ? (
                      <button onClick={onOpenManageSub} title="Manage subscription" className="hidden md:flex px-2.5 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 border bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all cursor-pointer">
                        <Zap size={10} /> BASIC
                      </button>
                    ) : userLicense ? (
                      <button onClick={onOpenManageSub} className="hidden md:flex px-3 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 border bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/30 text-blue-400 hover:from-blue-500/20 hover:to-purple-500/20 transition-all cursor-pointer">
                        <Crown size={10} /> Upgrade
                      </button>
                    ) : null}

                    {/* Live credit / trial countdown chip (Basic users + Free on trial) */}
                    {creditTimer && (creditTimer.source === 'credits' || creditTimer.source === 'trial') && creditTimer.remaining > 0 && (
                      <div
                        className={`hidden md:flex px-2.5 py-1 rounded-full text-[10px] font-semibold items-center gap-1.5 border transition-all duration-300 ${
                          creditTimer.remaining <= TIME_CONSTANTS.LOW_WARNING_SECONDS
                            ? 'bg-red-500/10 border-red-500/40 text-red-400'
                            : creditTimer.source === 'trial'
                              ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                        }`}
                        aria-label={creditTimer.source === 'trial' ? 'Free trial time remaining' : 'Basic plan time remaining'}
                      >
                        {creditTimer.source === 'trial' ? 'TRIAL' : ''} {formatTimeRemaining(creditTimer.remaining)}
                      </div>
                    )}
                    <div className={`hidden md:flex px-3 py-1 rounded-full text-xs font-medium items-center gap-2 border transition-all duration-300 ${isListening ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-surface border-border text-gray-500'}`}>
                        <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`}></div>
                        {isListening ? 'LIVE' : 'OFF'}
                    </div>
                    
                    {!isPipMode && (
                        <button
                            onClick={togglePip}
                            className={`p-2 rounded-lg transition-all border relative ${
                              gate.canPopout
                                ? 'text-primary hover:bg-blue-500/10 border-blue-500/20'
                                : 'text-gray-500 border-gray-500/20 cursor-not-allowed opacity-60'
                            }`}
                            aria-label={gate.canPopout ? "Pop Out (Hide from Screen Share)" : "Pop-out Mode — Pro only"}
                        >
                            <ExternalLink size={20} />
                            {!gate.canPopout && <Crown size={8} className="absolute top-1 right-1 text-amber-400" />}
                        </button>
                    )}

                    {onNewSession && (
                        <button onClick={onNewSession} className="p-2 text-gray-400 hover:text-green-400 hover:bg-green-500/10 border border-transparent hover:border-green-500/20 rounded-lg transition-all" aria-label="New Interview Session"><Plus size={20} /></button>
                    )}
                    <button onClick={onOpenHelp} className="p-2 text-gray-400 hover:text-text hover:bg-surface border border-transparent hover:border-border rounded-lg transition-all" aria-label="Audio Help"><HelpCircle size={20} /></button>
                    <button onClick={onOpenContext} className="p-2 text-gray-400 hover:text-text hover:bg-surface border border-transparent hover:border-border rounded-lg transition-all" aria-label="Files (Knowledge Base)"><FileText size={20} /></button>
                    <button onClick={onOpenSettings} className={`p-2 rounded-lg transition-all border border-transparent hover:border-border text-gray-400 hover:text-text hover:bg-surface`} aria-label="Settings"><Settings size={20} /></button>
                    <button onClick={onLogout} className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 rounded-lg transition-all" aria-label="Logout"><LogOut size={20} /></button>
                </div>
            </header>

            <main className="flex-1 flex overflow-hidden relative w-full">
                <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full relative">
                
                <div 
                    ref={chatContainerRef} 
                    onScroll={handleScroll}
                    className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6 pb-40 md:pb-48 custom-scrollbar"
                >
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-[60%] text-gray-400 space-y-6 opacity-60 mt-10">
                            <div className="w-24 h-24 rounded-full bg-surface flex items-center justify-center relative ring-1 ring-border">
                                {isListening ? <ScreenShare size={40} className="text-red-500 animate-pulse" /> : <ScreenShareOff size={40} className="text-gray-500" />}
                                {settings.autoSend && <div className="absolute top-1 right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-background shadow-[0_0_10px_rgba(34,197,94,0.5)]"></div>}
                            </div>
                            <div className="text-center px-6">
                                <p className="font-medium text-text mb-2 text-lg">System Audio Copilot</p>
                                <p className="text-sm leading-relaxed max-w-xs mx-auto text-gray-500">
                                    Click the Mic button to share your screen tab.<br/>
                                    <strong>Remember to check "Share tab audio"</strong>.
                                </p>
                            </div>
                        </div>
                    )}
                    
                    {messages.map((msg: Message) => (
                    <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end animate-in slide-in-from-bottom-2 duration-300' : 'justify-start'}`}>
                        <div className={`max-w-[95%] md:max-w-[85%] rounded-2xl p-3 md:p-5 shadow-lg ${
                        msg.role === 'user'
                            ? 'bg-transparent text-text border border-white/20 rounded-tr-sm'
                            : msg.role === 'system'
                            ? 'bg-transparent border border-red-500/50 text-red-500'
                            : 'bg-transparent border border-white/15 text-text rounded-tl-sm'
                        }`}>
                        <div className="text-[10px] font-bold mb-2 opacity-60 uppercase tracking-wider flex items-center gap-1">
                            {msg.role === 'user' ? <MessageSquare size={10} /> : <Zap size={10} />}
                            {msg.role === 'user' ? 'Transcript' : msg.role === 'system' ? 'System' : 'Answer'}
                        </div>
                        {/* Use Custom Message Renderer */}
                        <MessageRenderer content={msg.content} fontSize={settings.fontSize} canAutoType={gate.canAutoType} />
                        </div>
                    </div>
                    ))}

                    {streamingMsg && (
                    <div key={streamingMsg.id} className="flex justify-start animate-in slide-in-from-bottom-2 duration-300">
                        <div className="max-w-[95%] md:max-w-[85%] rounded-2xl p-3 md:p-5 shadow-lg bg-transparent border border-white/15 text-text rounded-tl-sm">
                            <div className="text-[10px] font-bold mb-2 opacity-60 uppercase tracking-wider flex items-center gap-1">
                                <Zap size={10} /> Answer
                            </div>
                            {streamingMsg.content ? (
                                <>
                                    <MessageRenderer content={streamingMsg.content} fontSize={settings.fontSize} canAutoType={gate.canAutoType} isStreaming />
                                    <span className="stream-caret" aria-hidden="true" />
                                </>
                            ) : (
                                <div className="flex gap-1 items-center text-xs text-gray-500">
                                    <span className="font-semibold text-primary tracking-wider">THINKING ({settings.selectedModel.toUpperCase()})</span>
                                    <div className="flex gap-1">
                                        <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms'}}></div>
                                        <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms'}}></div>
                                        <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms'}}></div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    )}

                    {isProcessing && !streamingMsg && (
                    <div className="flex justify-start">
                        <div className="bg-transparent border border-white/15 rounded-2xl px-4 py-3 rounded-tl-sm flex items-center gap-2 text-gray-500 text-xs shadow-lg">
                            <span className="font-semibold text-primary tracking-wider">THINKING ({settings.selectedModel.toUpperCase()})</span>
                            <div className="flex gap-1">
                                <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms'}}></div>
                                <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms'}}></div>
                                <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms'}}></div>
                            </div>
                        </div>
                    </div>
                    )}
                </div>

                {!isPinned && (
                    <button
                        onClick={handleJumpToLatest}
                        aria-label="Jump to latest messages"
                        className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-text bg-black/60 border border-white/15 backdrop-blur-md shadow-lg hover:bg-black/75 hover:border-white/25 transition-all z-30"
                        style={{ bottom: '11rem' }}
                    >
                        <ChevronDown size={13} strokeWidth={2.2} />
                        {newSinceUnpin > 0 ? `${newSinceUnpin} new` : 'Latest'}
                    </button>
                )}

                {/* --- INPUT BAR --- */}
                <div className="absolute bottom-0 left-0 right-0 bg-transparent pt-4 pb-4 px-2 md:px-6 z-20">
                    <div className="max-w-3xl mx-auto flex flex-col gap-2">
                        
                        {speechError && (
                            <div className="mx-auto bg-red-500/90 text-white px-3 py-1 rounded-full text-xs border border-red-400 flex items-center gap-2 shadow-lg backdrop-blur">
                                <AlertTriangle size={10} /> {speechError}
                            </div>
                        )}

                        <div className={`bg-transparent border rounded-2xl shadow-lg transition-all duration-300 flex flex-col ${isListening ? 'border-white/30' : 'border-white/15'}`}>
                            
                            <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-500/10">
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={toggleAutoSend}
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] md:text-xs font-bold transition-all border ${
                                            settings.autoSend 
                                            ? 'bg-blue-500/20 text-blue-500 border-blue-500/30' 
                                            : 'bg-gray-500/10 text-gray-500 border-transparent'
                                        }`}
                                    >
                                        <Zap size={12} className={settings.autoSend ? "fill-blue-500" : ""} />
                                        {settings.autoSend ? 'AUTO' : 'MANUAL'}
                                    </button>

                                    <button
                                        onClick={isListening ? stopListening : startListening}
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] md:text-xs font-bold transition-all border ${
                                            isListening 
                                            ? 'bg-red-500/20 text-red-500 border-red-500/30' 
                                            : 'bg-gray-500/10 text-gray-500 border-transparent'
                                        }`}
                                    >
                                        {isListening ? <Mic size={12} /> : <MicOff size={12} />}
                                        {isListening ? 'ON' : 'OFF'}
                                    </button>

                                    {/* --- QUICK MODEL SWITCHER --- */}
                                    <div className="h-5 w-[1px] bg-gray-500/20 mx-1"></div>
                                    <div className="relative group">
                                        <select
                                            value={settings.selectedModel}
                                            onChange={handleModelChange}
                                            className="appearance-none bg-surface text-text text-[10px] md:text-xs font-bold px-2.5 py-1 pr-6 rounded-md border border-border hover:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all cursor-pointer"
                                        >
                                            <option value="gemini" className="bg-white dark:bg-gray-800 text-black dark:text-white">Gemini 3.1 Flash</option>
                                            <option value="groq" disabled={!gate.canUseModel('groq')} className="bg-white dark:bg-gray-800 text-black dark:text-white">Groq{!gate.canUseModel('groq') ? ' — PRO' : ''}</option>
                                            <option value="openai" disabled={!gate.canUseModel('openai')} className="bg-white dark:bg-gray-800 text-black dark:text-white">GPT-5.5{!gate.canUseModel('openai') ? ' — PRO' : ''}</option>
                                            <option value="xai" disabled={!gate.canUseModel('xai')} className="bg-white dark:bg-gray-800 text-black dark:text-white">Grok (xAI){!gate.canUseModel('xai') ? ' — PRO' : ''}</option>
                                            <option value="claude" disabled={!gate.canUseModel('claude')} className="bg-white dark:bg-gray-800 text-black dark:text-white">Claude Sonnet 4.6{!gate.canUseModel('claude') ? ' — MAX' : ''}</option>
                                        </select>
                                        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                                            <ChevronDown size={10} />
                                        </div>
                                    </div>
                                </div>
                                
                                {!isProcessing && messages.length > 0 && (
                                    <button onClick={handleRegenerate} className="text-gray-500 hover:text-primary transition-colors p-1" aria-label="Regenerate last answer">
                                        <RefreshCw size={14} />
                                    </button>
                                )}
                            </div>

                            <div className="relative p-2 flex items-end gap-2">
                                <div className="relative flex-1 min-w-0">
                                    {interimText && (
                                        <div className="absolute top-2.5 left-3 text-gray-400 pointer-events-none text-sm md:text-base whitespace-pre-wrap truncate w-full opacity-60 italic z-0">
                                            {inputText}{interimText}
                                        </div>
                                    )}
                                    <textarea
                                        ref={textareaRef}
                                        value={inputText}
                                        onChange={(e) => setInputText(e.target.value)}
                                        placeholder={settings.autoSend ? "Listening for interviewer..." : "Type or speak context..."}
                                        className="w-full bg-transparent text-text placeholder-gray-500 px-3 py-2.5 focus:outline-none rounded-xl text-sm md:text-base leading-relaxed resize-none z-10 relative custom-scrollbar max-h-[150px] overflow-y-auto"
                                        // Native CSS auto-grow — avoids the JS layout-thrash that
                                        // caused per-keystroke typing lag. Browsers without support
                                        // fall back to the rAF-batched resize effect in MainApp.
                                        style={{ fieldSizing: 'content' } as React.CSSProperties}
                                        rows={1}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleManualSend();
                                            }
                                        }}
                                    />
                                </div>

                                <div className="flex flex-col gap-1 pb-1">
                                    {inputText && (
                                        <button onClick={handleClear} className="p-2 text-gray-400 hover:text-red-400 rounded-lg hover:bg-gray-500/10 transition-colors">
                                            <X size={18} />
                                        </button>
                                    )}
                                    <div className="flex gap-1">
                                        <button
                                            onClick={handleAutoSolve}
                                            disabled={isProcessing || !gate.canAutoSolve}
                                            aria-label={gate.canAutoSolve ? "Auto-Solve Screen" : "Auto-Solve — Pro only"}
                                            className={`p-2 rounded-xl transition-all shadow-lg relative ${
                                                !gate.canAutoSolve
                                                ? 'bg-gray-600/30 text-gray-500 cursor-not-allowed border border-gray-500/20'
                                                : !isProcessing
                                                ? 'bg-purple-600 text-white hover:bg-purple-700'
                                                : 'bg-surface text-gray-500 cursor-not-allowed border border-border'
                                            }`}
                                        >
                                            <Wand2 size={18} />
                                            {!gate.canAutoSolve && <Crown size={8} className="absolute top-1 right-1 text-amber-400" />}
                                        </button>
                                        <button 
                                            onClick={handleManualSend}
                                            disabled={!inputText.trim() || isProcessing}
                                            className={`p-2 rounded-xl transition-all shadow-lg ${
                                                inputText.trim() && !isProcessing
                                                ? 'bg-primary text-white hover:bg-blue-600' 
                                                : 'bg-surface text-gray-500 cursor-not-allowed border border-border'
                                            }`}
                                        >
                                            <Send size={18} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                </div>
            </main>
        </div>
    );
};

// PiP Window Logic
const PiPWindow: React.FC<{ children: React.ReactNode; onClose: () => void }> = ({ children, onClose }) => {
    const [container, setContainer] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!window.documentPictureInPicture) {
            // Defensive fallback — togglePip already pre-checks support and
            // shows a chat message before mounting this component. If we
            // somehow still land here, close silently rather than popping a
            // native alert (alerts paint outside content protection and leak
            // on screen share).
            onClose();
            return;
        }

        async function initPip() {
            try {
                // Request a vertical phone-like window
                const pipWindow = await window.documentPictureInPicture.requestWindow({
                    width: 450,
                    height: 700,
                });

                // Copy styles from main document to PiP
                [...document.styleSheets].forEach((styleSheet) => {
                    try {
                        const cssRules = [...styleSheet.cssRules]
                        .map((rule) => rule.cssText)
                        .join("");
                        const style = document.createElement("style");
                        style.textContent = cssRules;
                        pipWindow.document.head.appendChild(style);
                    } catch (e) {
                    const link = document.createElement("link");
                    link.rel = "stylesheet";
                    link.type = styleSheet.type;
                    link.media = styleSheet.media.mediaText;
                    link.href = styleSheet.href;
                    pipWindow.document.head.appendChild(link);
                    }
                });
                
                // Add Tailwind CDN directly to be sure
                const twScript = pipWindow.document.createElement('script');
                twScript.src = "https://cdn.tailwindcss.com";
                twScript.onload = () => {
                     // Re-inject config
                     const configScript = pipWindow.document.createElement('script');
                     configScript.innerHTML = `
                      tailwind.config = {
                        darkMode: 'class',
                        theme: {
                          extend: {
                            colors: {
                              background: 'var(--bg-color)',
                              surface: 'var(--surface-color)',
                              border: 'var(--border-color)',
                              text: 'var(--text-color)',
                              primary: '#3b82f6',
                              accent: '#f59e0b',
                            },
                          },
                        },
                      }
                   `;
                   pipWindow.document.head.appendChild(configScript);
                };
                pipWindow.document.head.appendChild(twScript);

                // Inject CSS Vars + Cursor overrides for screen share
                 const style = pipWindow.document.createElement('style');
                style.textContent = `
                 :root { --bg-color: #000000; --surface-color: rgba(25, 25, 25, 0.5); --border-color: rgba(255, 255, 255, 0.1); --text-color: #ffffff; }
                 .dark { --bg-color: #000000; --surface-color: rgba(25, 25, 25, 0.5); --border-color: rgba(255, 255, 255, 0.1); --text-color: #ffffff; }
                 body { background-color: var(--bg-color); color: var(--text-color); }
                 .pip-body { background: #000000; cursor: default !important; }
                 /* Force default cursor everywhere in popout - looks natural on screen share */
                 .pip-body *, .pip-body *::before, .pip-body *::after { cursor: default !important; }
                 /* Text cursor only for actual inputs */
                 .pip-body textarea, .pip-body input[type="text"], .pip-body input[type="email"], .pip-body input[type="password"] { cursor: text !important; }
                 /* Code blocks and message bubbles - default cursor, text still selectable */
                 .pip-body code, .pip-body pre, .pip-body .bubble { cursor: default !important; user-select: text; }
                `;
                pipWindow.document.head.appendChild(style);

                pipWindow.document.body.className = 'pip-body';

                const div = pipWindow.document.createElement('div');
                div.style.height = '100%';
                div.style.display = 'flex';
                div.style.flexDirection = 'column';
                // Force dark mode if main app is dark, else light
                if (document.documentElement.classList.contains('dark')) {
                    div.classList.add('dark');
                }
                pipWindow.document.body.appendChild(div);
                setContainer(div);

                pipWindow.addEventListener("pagehide", () => {
                    onClose();
                });
            } catch (err) {
                console.error("PiP Error:", err);
                onClose();
            }
        }
        initPip();
    }, []);

    if (!container) return null;
    return createPortal(children, container);
};


import { FEATURE_GATES } from './services/licenseService';

// ── Feature Gate Helper ──
// Resolves effective tier: Max ⊃ Pro ⊃ Basic ⊃ Free. A Free user with
// trial_remaining_seconds > 0 gets boosted to Basic features for the taste-test
// window (see licenseService.getEffectiveTier). Keep `actualTier` around
// separately for billing/upgrade UI that should ignore the trial boost.
function useFeatureGate(license: LicenseData | null) {
  const tier = licenseService.getEffectiveTier(license);
  const actualTier = (license?.tier ?? 'free') as 'free' | 'basic' | 'pro' | 'max';
  const gates = FEATURE_GATES[tier];
  const onTrial = licenseService.isTrialActive(license);

  return {
    tier,
    actualTier,
    isMax: tier === 'max',
    isPro: tier === 'pro',
    isBasic: tier === 'basic',
    isFree: tier === 'free',
    onTrial,
    allowedModels: gates.models,
    canScreenCapture: gates.screenCapture,
    canAutoSolve: gates.autoSolve,
    canAutoType: gates.autoType,
    canPopout: gates.popout,
    maxContextFiles: gates.contextFiles,
    maxSessions: gates.sessionsPerMonth,
    canExportHistory: gates.exportHistory,
    canUseModel: (model: string) => gates.models.includes(model),
    getDefaultModel: () => gates.models[0] || 'gemini',
  };
}

// Format seconds as "1h 23m" / "23m 05s" / "45s" for chips and modals
function formatTimeRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${ss.toString().padStart(2, '0')}s`;
  return `${ss}s`;
}

// ── useCreditTimer ──
// Drives the ticking session clock for Basic users and Free-tier trial users.
// Pro/Max = unlimited; creditTimerService.start() silently no-ops for them so
// this hook is safe to mount for everyone and just stays dormant.
function useCreditTimer(params: {
  isListening: boolean;
  license: LicenseData | null;
  onForceStop: () => void;
}) {
  const { isListening, license, onForceStop } = params;
  const [remaining, setRemaining] = useState<number>(() => licenseService.getLiveTimeBalance(license).seconds);
  const [source, setSource] = useState<'trial' | 'credits' | 'unlimited' | 'none'>(() => licenseService.getLiveTimeBalance(license).source);
  const [hourBoundary, setHourBoundary] = useState(false);
  const [lowWarning, setLowWarning] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  // onForceStop may be a fresh arrow every render (e.g. Electron popout path).
  // Pin it to a ref so the listener-subscription effect runs exactly once.
  const forceStopRef = useRef(onForceStop);
  useEffect(() => { forceStopRef.current = onForceStop; }, [onForceStop]);

  // Re-read balance when license changes (e.g. after renewal purchase)
  useEffect(() => {
    const bal = licenseService.getLiveTimeBalance(license);
    setRemaining(bal.seconds);
    setSource(bal.source);
  }, [license]);

  // Subscribe to timer events — mount once, stable identity.
  useEffect(() => {
    const offStarted = creditTimerService.on('started', (p: any) => {
      setRemaining(p.remainingSeconds);
      setSource(p.source);
    });
    const offTick = creditTimerService.on('tick', (p: any) => {
      setRemaining(p.remainingSeconds);
      setSource(p.source);
    });
    const offHour = creditTimerService.on('hour-boundary', (p: any) => {
      setRemaining(p.remainingSeconds);
      setHourBoundary(true);
    });
    const offLow = creditTimerService.on('low-warning', () => setLowWarning(true));
    const offOut = creditTimerService.on('exhausted', () => {
      setExhausted(true);
      forceStopRef.current();
    });
    return () => { offStarted(); offTick(); offHour(); offLow(); offOut(); };
  }, []);

  // Start/stop mirror the mic. Pro/Max = unlimited → start() no-ops internally.
  useEffect(() => {
    if (isListening) creditTimerService.start();
    else creditTimerService.stop();
  }, [isListening]);

  const acknowledgeHourBoundary = useCallback((decision: 'continue' | 'stop') => {
    creditTimerService.acknowledgeHourBoundary(decision);
    setHourBoundary(false);
    if (decision === 'stop') forceStopRef.current();
  }, []);

  return {
    remaining,
    source,
    hourBoundary,
    lowWarning,
    exhausted,
    acknowledgeHourBoundary,
    dismissLowWarning: () => setLowWarning(false),
    dismissExhausted: () => setExhausted(false),
  };
}

// ── Hour-boundary modal — gentle prompt before dipping into the next credit
const HourBoundaryModal = ({ remainingSeconds, onDecision }: { remainingSeconds: number; onDecision: (d: 'continue' | 'stop') => void }) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
    <div className="max-w-md w-full mx-4 rounded-2xl border border-emerald-500/30 bg-[#0a0a0f] shadow-2xl shadow-emerald-500/10 p-6">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
          <Zap size={20} className="text-emerald-400" />
        </div>
        <div>
          <h3 className="text-base font-bold text-white">One hour down</h3>
          <p className="text-xs text-gray-500">Use your next interview credit to keep going?</p>
        </div>
      </div>
      <p className="text-sm text-gray-400 mb-5 leading-relaxed">
        You've been live for 60 minutes. You have <span className="text-emerald-400 font-semibold">{formatTimeRemaining(remainingSeconds)}</span> left on your Basic plan. Continuing will use your next credit.
      </p>
      <div className="flex gap-3">
        <button onClick={() => onDecision('stop')} className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-300 text-sm font-semibold hover:bg-white/[0.08] transition-all">
          Stop session
        </button>
        <button onClick={() => onDecision('continue')} className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white text-sm font-bold transition-all shadow-lg shadow-emerald-500/20">
          Continue with next credit
        </button>
      </div>
    </div>
  </div>
);

// ── Low-warning toast — 2-minute warning, auto-dismiss after 8s
const LowWarningToast = ({ remainingSeconds, onDismiss }: { remainingSeconds: number; onDismiss: () => void }) => {
  useEffect(() => {
    const t = setTimeout(onDismiss, 8000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div className="fixed top-20 right-6 z-[95] max-w-sm px-4 py-3 rounded-xl bg-amber-500/[0.12] border border-amber-500/40 text-amber-300 text-sm font-medium shadow-xl backdrop-blur-sm flex items-center gap-3 animate-pulse">
      <AlertTriangle size={16} className="shrink-0" />
      <span>Only <b>{formatTimeRemaining(remainingSeconds)}</b> left on your plan. Wrap up or renew soon.</span>
      <button onClick={onDismiss} className="text-amber-400 hover:text-amber-200 ml-1"><X size={14} /></button>
    </div>
  );
};

// ── Exhausted modal — blocking; offers renew CTA for Basic, upgrade for Free
const ExhaustedModal = ({
  source, actualTier, countryCode, onRenew, onUpgrade, onDismiss,
}: {
  source: 'trial' | 'credits' | 'unlimited' | 'none';
  actualTier: 'free' | 'basic' | 'pro' | 'max';
  countryCode: string;
  onRenew: () => void;
  onUpgrade: () => void;
  onDismiss: () => void;
}) => {
  const wasTrial = source === 'trial' || actualTier === 'free';
  const renewal = pricingService.getBasicRenewalPrice(countryCode);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-2xl border border-red-500/30 bg-[#0a0a0f] shadow-2xl shadow-red-500/10 p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">{wasTrial ? 'Trial complete' : "You're out of interview time"}</h3>
            <p className="text-xs text-gray-500">{wasTrial ? 'Your 30-minute trial just ended.' : 'All credits have been used.'}</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 mb-5 leading-relaxed">
          {wasTrial
            ? 'Grab the Basic plan to keep using the full feature set — 3 interview credits (3 hours) valid for 14 days.'
            : 'Add another hour for a single renewal, or upgrade to Pro for unlimited sessions.'}
        </p>
        <div className="flex flex-col gap-2">
          {!wasTrial && actualTier === 'basic' && (
            <button onClick={onRenew} className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white text-sm font-bold transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2">
              <Zap size={14} />
              Renew +1 hour · {pricingService.formatPrice(renewal.price, renewal.currencySymbol, renewal.currency)}
            </button>
          )}
          <button onClick={onUpgrade} className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-400 hover:to-purple-400 text-white text-sm font-bold transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2">
            <Crown size={14} /> {wasTrial ? 'See plans' : 'Upgrade to Pro (Unlimited)'}
          </button>
          <button onClick={onDismiss} className="px-4 py-2 rounded-xl text-gray-500 text-xs font-medium hover:text-gray-300 transition-all">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Upgrade to Pro — opens Stripe checkout in browser ──
// No native alerts inside — alert()/confirm() are OS dialogs that bypass
// setContentProtection and leak on screen share. Failures log to console;
// the Upgrade button itself is already tier-gated in render so the
// no-token branch is a defensive no-op in practice.
async function openProUpgrade() {
  const { licenseService } = await import('./services/licenseService');
  const token = licenseService.getToken();
  if (!token) {
    console.warn('[openProUpgrade] No auth token — aborting.');
    return;
  }
  try {
    // Use the user's actual country code for geo-routed payments (Stripe vs Razorpay)
    const saved = licenseService.loadAuth();
    const countryCode = saved.user?.country_code || 'US';

    const response = await fetch('https://h2so4-production.up.railway.app/api/v1/payments/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ country_code: countryCode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to start checkout');
    if (data.checkout_url) {
      // Open in default browser (works in Electron and web)
      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(data.checkout_url);
      } else {
        window.open(data.checkout_url, '_blank');
      }
    }
  } catch (err: any) {
    console.error('[openProUpgrade] Checkout failed:', err?.message || err);
  }
}

// ── Pro Feature Locked Overlay ──
const ProFeatureLocked = ({ feature, compact }: { feature: string; compact?: boolean }) => (
  <div className={`flex items-center gap-1.5 ${compact ? 'text-[10px]' : 'text-xs'} text-amber-400/80`}>
    <Crown size={compact ? 10 : 12} />
    <span>Pro only{!compact && ` — ${feature}`}</span>
  </div>
);

// ── Conversation sidebar (Electron main window only) ──
// Buckets sessions into Today / Yesterday / Previous 7 days / Previous 30 days / Older
// so long histories stay scannable.
function groupSessionsByDate(sessions: SessionSummary[]): Array<{ label: string; items: SessionSummary[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = startOfToday - 30 * 24 * 60 * 60 * 1000;

  const groups: Record<string, SessionSummary[]> = {
    'Today': [],
    'Yesterday': [],
    'Previous 7 days': [],
    'Previous 30 days': [],
    'Older': [],
  };
  for (const s of sessions) {
    if (s.created_at >= startOfToday) groups['Today'].push(s);
    else if (s.created_at >= startOfYesterday) groups['Yesterday'].push(s);
    else if (s.created_at >= sevenDaysAgo) groups['Previous 7 days'].push(s);
    else if (s.created_at >= thirtyDaysAgo) groups['Previous 30 days'].push(s);
    else groups['Older'].push(s);
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

const ConversationSidebar = ({
  db,
  onClose,
}: {
  db: ReturnType<typeof useDatabase>;
  onClose: () => void;
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const groups = groupSessionsByDate(db.sessions);

  const startEdit = (s: SessionSummary) => {
    setEditingId(s.id);
    setEditName(s.name);
  };

  const saveEdit = async () => {
    if (editingId && editName.trim()) {
      await db.renameSession(editingId, editName.trim());
    }
    setEditingId(null);
    setEditName('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const confirmDelete = async () => {
    if (deleteConfirmId) {
      await db.deleteSession(deleteConfirmId);
    }
    setDeleteConfirmId(null);
  };

  return (
    <>
      <aside className="w-64 shrink-0 h-full flex flex-col bg-[#0a0a0d] border-r border-white/[0.06]">
        <div className="p-3 flex items-center justify-between border-b border-white/[0.06]">
          <div className="flex items-center gap-2 text-sm font-semibold text-white/90">
            <MessageSquare size={14} className="text-blue-400" />
            Conversations
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-white/[0.06] flex items-center justify-center text-gray-500 hover:text-white transition-colors"
            aria-label="Close sidebar"
          >
            <X size={14} />
          </button>
        </div>

        <button
          onClick={() => db.newSession()}
          className="mx-3 mt-3 px-3 py-2.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-sm text-white/90 font-medium transition-all flex items-center justify-center gap-2"
        >
          <Plus size={14} /> New chat
        </button>

        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {db.sessions.length === 0 ? (
            <div className="text-center text-xs text-gray-600 px-4 py-8">
              No conversations yet. Start chatting to create one.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.label}>
                <div className="text-[10px] uppercase tracking-wider text-gray-600 px-2 mb-1 font-medium">
                  {g.label}
                </div>
                <div className="space-y-0.5">
                  {g.items.map((s) => {
                    const isActive = s.id === db.sessionId;
                    const isEditing = editingId === s.id;
                    return (
                      <div
                        key={s.id}
                        className={`group relative rounded-lg transition-colors ${
                          isActive
                            ? 'bg-blue-500/15 border border-blue-500/20'
                            : 'hover:bg-white/[0.04] border border-transparent'
                        }`}
                      >
                        {isEditing ? (
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            autoFocus
                            maxLength={100}
                            className="w-full px-2.5 py-2 rounded-lg bg-white/[0.08] border border-blue-500/40 text-sm text-white outline-none"
                          />
                        ) : (
                          <div
                            onClick={() => db.switchSession(s.id)}
                            className="cursor-pointer px-2.5 py-2 flex items-center gap-2 min-w-0"
                            aria-label={s.name}
                          >
                            <MessageSquare
                              size={12}
                              className={`shrink-0 ${isActive ? 'text-blue-400' : 'text-gray-600'}`}
                            />
                            <span
                              className={`truncate text-sm flex-1 ${
                                isActive ? 'text-white' : 'text-gray-300'
                              }`}
                            >
                              {s.name}
                            </span>
                            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEdit(s);
                                }}
                                className="w-6 h-6 rounded hover:bg-white/[0.1] flex items-center justify-center text-gray-500 hover:text-white"
                                aria-label="Rename"
                              >
                                <Edit3 size={11} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteConfirmId(s.id);
                                }}
                                className="w-6 h-6 rounded hover:bg-red-500/20 flex items-center justify-center text-gray-500 hover:text-red-400"
                                aria-label="Delete"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[100]">
          <div className="bg-[#111116] border border-white/[0.08] rounded-xl p-5 max-w-xs w-full">
            <h3 className="text-sm font-semibold text-white mb-2">Delete conversation?</h3>
            <p className="text-xs text-gray-400 mb-4">
              This conversation and all its messages will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 px-3 py-2 rounded-lg bg-red-500/90 hover:bg-red-500 text-xs font-semibold text-white transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ─── Popout resize handles ────────────────────────────────────────────
// Native OS resize is disabled on the popout BrowserWindow (resizable:false)
// so the OS doesn't draw resize cursors on the side edges during a
// screen-share — when the user moves their cursor from the popout to a
// browser-based code editor, the cursor never flashes from arrow to ↔.
// Reviewers watching the share have nothing to question.
//
// Resize is re-added here on the four shapes the user actually needs and
// where the cursor doesn't normally pass during left-right traversal:
//   • top edge (full width strip, 6px tall)
//   • bottom edge (full width strip, 6px tall)
//   • four corners (10x10 each)
// The side edges (left, right) deliberately have no handle → no cursor
// change at all on horizontal cursor paths.
//
// Each handle uses pointermove + setPointerCapture so the drag continues
// even if the cursor leaves the popout window mid-resize. Coordinates
// are sent in screen pixels (e.screenX/Y) so the popout's own coords
// don't drift as the window moves under the cursor.
const PopoutResizeHandles: React.FC = () => {
  const startResize = (edge: 'top' | 'bottom' | 'tl' | 'tr' | 'bl' | 'br') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      try { target.setPointerCapture(e.pointerId); } catch {}

      try {
        window.electronAPI?.send('popout:resize-start', {
          edge,
          screenX: e.screenX,
          screenY: e.screenY,
        });
      } catch {}

      // Coalesce pointermove → setBounds via requestAnimationFrame so we
      // fire AT MOST one IPC per frame (~60Hz). pointermove naturally
      // streams at 120Hz+ on high-refresh displays — without this, every
      // move fires a setBounds, and on transparent BrowserWindows the
      // accumulated setBounds calls visibly flicker (the transparent
      // background goes black between resizes; see electron/electron
      // issue #29661). Latest position wins.
      let rafPending = false;
      let lastMoveEv: { screenX: number; screenY: number } | null = null;
      const flushMove = () => {
        rafPending = false;
        if (!lastMoveEv) return;
        const ev = lastMoveEv;
        lastMoveEv = null;
        try {
          window.electronAPI?.send('popout:resize-move', {
            screenX: ev.screenX,
            screenY: ev.screenY,
          });
        } catch {}
      };
      const onMove = (ev: PointerEvent) => {
        lastMoveEv = { screenX: ev.screenX, screenY: ev.screenY };
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(flushMove);
      };
      const onUp = () => {
        try { target.releasePointerCapture(e.pointerId); } catch {}
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        // Flush any pending move BEFORE telling main we're done — without
        // this the very last few pixels of drag are lost on slow setBounds
        // paths (the user lifts fingers right as the rAF was about to fire).
        if (rafPending) flushMove();
        try { window.electronAPI?.send('popout:resize-end'); } catch {}
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    };

  // Inline styles — Tailwind classes don't reliably handle the small
  // pixel dimensions / positioning we need at sub-pixel-perfect edges.
  // zIndex puts handles above ChatInterface content but below modals.
  const edgeBase: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    background: 'transparent',
    touchAction: 'none',
  };
  const cornerBase: React.CSSProperties = {
    ...edgeBase,
    width: 10,
    height: 10,
  };

  return (
    <>
      {/* Top edge — leaves 10px on each end for corners */}
      <div
        onPointerDown={startResize('top')}
        style={{ ...edgeBase, top: 0, left: 10, right: 10, height: 6, cursor: 'ns-resize' }}
        aria-hidden
      />
      {/* Bottom edge */}
      <div
        onPointerDown={startResize('bottom')}
        style={{ ...edgeBase, bottom: 0, left: 10, right: 10, height: 6, cursor: 'ns-resize' }}
        aria-hidden
      />
      {/* Top-left corner */}
      <div
        onPointerDown={startResize('tl')}
        style={{ ...cornerBase, top: 0, left: 0, cursor: 'nwse-resize' }}
        aria-hidden
      />
      {/* Top-right corner */}
      <div
        onPointerDown={startResize('tr')}
        style={{ ...cornerBase, top: 0, right: 0, cursor: 'nesw-resize' }}
        aria-hidden
      />
      {/* Bottom-left corner */}
      <div
        onPointerDown={startResize('bl')}
        style={{ ...cornerBase, bottom: 0, left: 0, cursor: 'nesw-resize' }}
        aria-hidden
      />
      {/* Bottom-right corner */}
      <div
        onPointerDown={startResize('br')}
        style={{ ...cornerBase, bottom: 0, right: 0, cursor: 'nwse-resize' }}
        aria-hidden
      />
    </>
  );
};

function MainApp({ userProfile, userLicense, onLogout }: { userProfile: UserProfile | null; userLicense: LicenseData | null; onLogout: () => void }) {
  // --- Feature Gates ---
  const gate = useFeatureGate(userLicense);

  // --- Database-backed state (Electron) / local fallback (browser) ---
  // Pass the signed-in user's id so SQLite sessions are scoped per account
  // and one user's conversation history never appears under another login.
  const db = useDatabase(userProfile?.id || null);
  const messages = db.messages;
  const setMessages = db.setMessages;
  const messagesRef = useRef<Message[]>([]);
  const contextFilesRef = useRef<ContextFile[]>([]);

  // Keep messagesRef in sync with messages
  useEffect(() => {
      messagesRef.current = messages;
  }, [messages]);

  // Keep contextFilesRef in sync with db.contextFiles. Also fire the
  // identity-extraction preflight here so the first interview question
  // doesn't pay the ~2-5s round-trip — by the time the user starts, the
  // WHO-YOU-ARE + WHAT-THIS-ROLE-REWARDS cards are already cached.
  useEffect(() => {
      contextFilesRef.current = db.contextFiles;
      prewarmIdentity(db.contextFiles);
      prewarmClaudeIdentity(db.contextFiles);
  }, [db.contextFiles]);

  // --- "Train Model" pipeline state (Max-tier only) ---
  // Pre-researches every tech in resume + JD via parallel web_search calls,
  // caches the result for 24h, and injects it into Claude's system prompt
  // so version/pricing/comparison questions answer in 2-3s instead of
  // triggering 12-25s live searches mid-interview.
  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgress | null>(null);
  const [hasTrainedCache, setHasTrainedCache] = useState(false);
  // Recompute "is there a fresh cache?" whenever files change — different
  // resume/JD = different hash key, so old cache is invalid.
  useEffect(() => {
      setHasTrainedCache(hasCachedTechState(db.contextFiles));
  }, [db.contextFiles]);
  // ── First-launch Tutorial ──
  // One-time per account walkthrough. Auto-shows the first time we have a
  // userProfile.id and no completion flag. Replayable from Settings.
  const [tutorialOpen, setTutorialOpen] = useState(false);
  useEffect(() => {
      if (!userProfile?.id) return;
      // Slight defer so the main UI has paint-time to show the empty chat
      // first — opening on top of a still-loading background looks janky.
      const t = window.setTimeout(() => {
          if (shouldShowTutorial(userProfile.id)) setTutorialOpen(true);
      }, 600);
      return () => window.clearTimeout(t);
  }, [userProfile?.id]);
  const handleTutorialClose = useCallback(() => {
      setTutorialOpen(false);
      markTutorialCompleted(userProfile?.id);
  }, [userProfile?.id]);
  const handleReplayTutorial = useCallback(() => {
      // Clear completion flag and re-open. Clearing means a fresh launch
      // would show it again until they finish/dismiss this replay.
      clearTutorialCompletion(userProfile?.id);
      setTutorialOpen(true);
  }, [userProfile?.id]);

  // ── Manage Subscription page (full-screen overlay) ──
  // Opened by clicking the tier badge in the chat header. Hosts the
  // unified billing UI: current plan + actions + comparison + account.
  const [manageSubOpen, setManageSubOpen] = useState(false);
  const handleSubscriptionUpgrade = useCallback((targetTier: 'basic' | 'pro' | 'max') => {
      // Reuse the existing checkout flow exposed by SubscriptionGate via
      // openProUpgrade. The checkout happens in browser via openExternal.
      // The 'targetTier' is informational — server flow always picks the
      // configured plan for the user's region. Future: pass targetTier
      // through to /create-checkout for per-tier selection.
      setManageSubOpen(false);
      openProUpgrade();
  }, []);

  // ── In-app update-on-close prompt ──
  // Replaces electron/main.cjs's native dialog.showMessageBox (which leaks
  // on screen-share). When user closes the main window AND a pending update
  // is downloaded, main sends 'show-update-prompt' and we render an in-app
  // modal. Choice flows back via the existing 'install-update' / 'close-window'
  // channels — no new wiring on main.
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [updatePromptVersion, setUpdatePromptVersion] = useState<string>('');
  useEffect(() => {
      if (!isElectron) return;
      return electronIPC.on('show-update-prompt', (data: any) => {
          setUpdatePromptVersion(data?.version || '');
          setUpdatePromptOpen(true);
      });
  }, []);

  // ── First-time tray-hide toast ──
  // When the user hits the close button on the main window for the very first
  // time per account, we surface an in-app toast (NOT a native dialog — that'd
  // leak on screen-share) explaining the app went to the system tray. The
  // tutorial's tray step covers this in detail; the toast is a one-shot
  // breadcrumb in case the user skipped the tutorial.
  const [trayToastOpen, setTrayToastOpen] = useState(false);
  useEffect(() => {
      if (!isElectron || !userProfile?.id) return;
      const key = `tray_hide_toast_shown_${userProfile.id}`;
      return electronIPC.on('app-hidden-to-tray', () => {
          try {
              if (localStorage.getItem(key) === 'true') return;
              localStorage.setItem(key, 'true');
          } catch {}
          setTrayToastOpen(true);
          // Auto-dismiss after 12s — long enough to read, short enough not
          // to occupy the popout indefinitely if user is mid-interview.
          window.setTimeout(() => setTrayToastOpen(false), 12000);
      });
  }, [userProfile?.id]);

  // Admin gets unlimited re-trains AND beast mode (deep individual research,
  // ~$3-6 per run). Non-admin is locked to one standard training per 24h
  // (no re-train button — the cache lockout enforces it).
  const isAdmin = !!userProfile?.is_admin;
  // Admin re-train opens an in-app confirm modal. We can't use window.confirm()
  // — that's a native OS dialog that bypasses setContentProtection and would
  // leak on screen-share during a live interview.
  const [retrainConfirmOpen, setRetrainConfirmOpen] = useState(false);
  const runTrainingNow = useCallback(async () => {
      setIsTraining(true);
      setTrainingProgress({ stage: 'extracting', done: 0, total: 0, pct: 0, message: 'Starting...' });
      try {
          const trainer = isAdmin ? trainClaudeModelBeast : trainClaudeModel;
          const result = await trainer(db.contextFiles, (p) => setTrainingProgress(p));
          if (result.success) {
              setHasTrainedCache(true);
              setTimeout(() => setTrainingProgress(null), 6000);
          } else {
              setTimeout(() => setTrainingProgress(null), 4000);
          }
      } catch (e: any) {
          setTrainingProgress({ stage: 'error', done: 0, total: 0, pct: 0, message: e?.message || 'Training failed' });
          setTimeout(() => setTrainingProgress(null), 4000);
      } finally {
          setIsTraining(false);
      }
  }, [db.contextFiles, isAdmin]);
  const handleTrainModel = useCallback(() => {
      if (isTraining || db.contextFiles.length === 0) return;
      // Non-admin: silently bail if there's a fresh cache. The button is
      // hidden in this case anyway, but defense-in-depth.
      if (!isAdmin && hasTrainedCache) return;
      // Admin re-train opens the confirm modal (cost warning, screen-share-safe).
      if (isAdmin && hasTrainedCache) {
          setRetrainConfirmOpen(true);
          return;
      }
      runTrainingNow();
  }, [db.contextFiles.length, isTraining, hasTrainedCache, isAdmin, runTrainingNow]);
  const [inputText, setInputText] = useState("");
  const [interimText, setInterimText] = useState("");
  
  const [isProcessing, setIsProcessing] = useState(false);
  // Transient message shown while the current AI response streams in.
  // It's rendered after the committed `messages` list and cleared the
  // moment the full text lands in the DB, so we never double-show it.
  const [streamingMsg, setStreamingMsg] = useState<Message | null>(null);
  // Controller for the in-flight AI stream. We abort it whenever a new
  // stream starts, the session is cleared/switched, or the component
  // unmounts — so a stale `onToken` from a dead request can never
  // land on the new session's state, and the server-side `req.on(
  // 'close')` stops paying for tokens no one will ever see.
  const streamAbortRef = useRef<AbortController | null>(null);
  const cancelActiveStream = useCallback(() => {
    const ctrl = streamAbortRef.current;
    if (ctrl) {
      streamAbortRef.current = null;
      try { ctrl.abort(); } catch {}
    }
  }, []);

  // ─────────────────────────────────────────────────────────────
  //  STREAM CHUNK COALESCING
  // ─────────────────────────────────────────────────────────────
  //  MessageRenderer parses markdown (+ syntax-highlights code) on every
  //  content change. At 100 tokens/sec (Groq), that would be 100 parses/sec
  //  — enough to jank the popout during fast answers. We coalesce bursts of
  //  stream chunks to at most one React commit per animation frame. The
  //  final string of each frame is what lands; intermediate tokens inside
  //  the same frame are invisible to the user anyway.
  //
  //  Used by main's streaming callback AND by the popout's IPC chunk
  //  handler so both windows get the same smooth rendering regardless of
  //  how fast the upstream model is pushing tokens.
  // ─────────────────────────────────────────────────────────────
  const pendingChunkRAFRef = useRef<number | null>(null);
  const latestChunkRef = useRef<{ id: string; content: string } | null>(null);

  const applyStreamChunk = useCallback((id: string, full: string) => {
    latestChunkRef.current = { id, content: full };
    if (pendingChunkRAFRef.current !== null) return;
    pendingChunkRAFRef.current = requestAnimationFrame(() => {
      pendingChunkRAFRef.current = null;
      const latest = latestChunkRef.current;
      latestChunkRef.current = null;
      if (!latest) return;
      // `prev.id === latest.id` guards against out-of-order or late frames
      // from a cancelled run landing in a newer stream's bubble.
      setStreamingMsg(prev => prev && prev.id === latest.id ? { ...prev, content: latest.content } : prev);
    });
  }, []);

  const flushStreamChunk = useCallback(() => {
    if (pendingChunkRAFRef.current !== null) {
      cancelAnimationFrame(pendingChunkRAFRef.current);
      pendingChunkRAFRef.current = null;
    }
    latestChunkRef.current = null;
  }, []);
  const streamRef = useRef<MediaStream | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  
  // Local state for Quick Paste in Context Modal
  const [pasteContent, setPasteContent] = useState("");

  // ── Auto-Update State (Electron only) ──
  const [updateStatus, setUpdateStatus] = useState<{
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
    version?: string;
    percent?: number;
    message?: string;
  }>({ status: 'idle' });

  // Server-side version check (fallback when Electron updater fails)
  const [serverVersionInfo, setServerVersionInfo] = useState<{
    latest: string;
    isOutdated: boolean;
    mustUpdate: boolean;
    releaseNotes?: string;
    downloadUrl?: { windows: string; mac: string; linux: string };
  } | null>(null);

  // Injected by Vite from package.json (see vite.config.ts). Single source
  // of truth — no more version drift between manifest and the server check.
  const APP_VERSION = __APP_VERSION__;

  useEffect(() => {
    if (!isElectron) return;
    return electronIPC.on('update-status', (data: any) => {
      setUpdateStatus(data);
    });
  }, []);

  // Check server for updates (works even when Electron updater fails)
  useEffect(() => {
    const checkServerVersion = async () => {
      try {
        const res = await fetch(`https://h2so4-production.up.railway.app/api/v1/app-version?v=${APP_VERSION}`);
        if (res.ok) {
          const data = await res.json();
          setServerVersionInfo(data);
        }
      } catch {
        // Silently fail — server check is a fallback
      }
    };
    checkServerVersion();
    // Re-check every 30 minutes
    const interval = setInterval(checkServerVersion, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // PiP State — auto-enter if this is the Electron pop-out window
  const [isPipMode, setIsPipMode] = useState(isPopoutMode);

  // Conversation sidebar open/closed, persisted so users don't have to
  // re-open it every launch. Default open on first use for discoverability.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('sidebar_open');
      if (saved === null) return true;
      return saved === '1';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('sidebar_open', sidebarOpen ? '1' : '0'); } catch {}
  }, [sidebarOpen]);

  // Electron pop-out window: make transparent + set up cross-window sync
  useEffect(() => {
    if (isElectron && isPopoutMode) {
      document.documentElement.classList.add('electron-transparent');
      document.body.style.background = 'transparent';
    }
    // Listen for popout closed (main window gets notified)
    let disposeClosed: (() => void) | null = null;
    let disposeOpened: (() => void) | null = null;
    if (isElectron && !isPopoutMode) {
      disposeClosed = electronIPC.on('popout-closed', () => { setIsPipMode(false); });
      disposeOpened = electronIPC.on('popout-opened', () => { setIsPipMode(true); });
    }
    return () => {
      document.documentElement.classList.remove('electron-transparent');
      if (disposeClosed) disposeClosed();
      if (disposeOpened) disposeOpened();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Popout focus management for proctored-assessment stealth ──
  // The popout window is created with focusable:false so that a click on
  // an Auto-Solve / model / "Type it" button does not steal focus from
  // whatever the user is working in (e.g., a Ropes.ai browser tab whose
  // proctoring listens for window.onblur). That makes button clicks
  // invisible to focus-loss detection — but it also breaks keyboard input
  // for textareas/inputs in the popout, since a non-focusable window
  // can't receive OS keystrokes.
  //
  // This effect bridges the gap: when the user clicks (or otherwise
  // focuses) a text input inside the popout, we ask main to flip the
  // window to focusable=true so typing works. When the input blurs we
  // flip it back to false (debounced 200ms so rapid input-to-input
  // transitions don't toggle).
  //
  // Trade-off: typing in the popout DOES cause one focus-loss event,
  // which a strict proctor will see. That's acceptable because typing in
  // the popout is rare + user-initiated. Button clicks (the common case)
  // remain invisible.
  useEffect(() => {
    if (!isElectron || !isPopoutMode) return;

    const isTypingTarget = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelRelease = () => {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (isTypingTarget(e.target)) {
        cancelRelease();
        try { window.electronAPI?.send('popout:set-focusable', true); } catch {}
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (isTypingTarget(e.target)) {
        cancelRelease();
        try { window.electronAPI?.send('popout:set-focusable', true); } catch {}
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (isTypingTarget(e.target)) {
        cancelRelease();
        // Debounce — focus rapidly bouncing between two inputs (or
        // between an input and a contenteditable) shouldn't churn the
        // window's focusable state. 200ms covers normal click-from-A-to-B.
        releaseTimer = setTimeout(() => {
          try { window.electronAPI?.send('popout:set-focusable', false); } catch {}
        }, 200);
      }
    };

    // Capture phase — we want to see these events even if a child
    // handler calls stopPropagation.
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);

    return () => {
      cancelRelease();
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      // Best-effort reset on unmount — leaves the window in a known state
      // if something tears down mid-input-focus.
      try { window.electronAPI?.send('popout:set-focusable', false); } catch {}
    };
  }, []);

  // Settings State
  const [settings, setSettings] = useState<AppSettings>({
    selectedModel: (() => {
      const saved = (localStorage.getItem("SELECTED_MODEL") as 'gemini'|'groq'|'openai'|'xai'|'claude') || 'gemini';
      if (!gate.canUseModel(saved)) return gate.getDefaultModel() as 'gemini'|'groq'|'openai'|'xai'|'claude';
      return saved;
    })(),
    autoSend: false,
    contextFiles: [],
    theme: (localStorage.getItem("THEME") as 'light'|'dark') || 'dark',
    fontSize: (localStorage.getItem("FONT_SIZE") as 'small'|'medium'|'large') || 'medium',
    generalMode: localStorage.getItem("GENERAL_MODE") === 'true',
  });

  // Settings Modal Local State
  const [tempModel, setTempModel] = useState<'gemini'|'groq'|'openai'|'xai'|'claude'>('gemini');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');
  // Timer for the post-save "saved" → "idle" flash; cleared on unmount so a
  // pending revert can't fire into a torn-down component (and cancelled on
  // re-save so back-to-back saves don't leave a stale revert in flight).
  const saveStatusTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (saveStatusTimerRef.current !== null) {
      window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
  }, []);

  // Ref for file input to ensure reliable click
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ref pattern to fix closure staleness in callbacks
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Apply Theme to HTML root
  useEffect(() => {
      const root = document.documentElement;
      if (settings.theme === 'dark') {
          root.classList.add('dark');
      } else {
          root.classList.remove('dark');
      }
      localStorage.setItem("THEME", settings.theme);
  }, [settings.theme]);

  // Apply General Mode persistence
  useEffect(() => {
      localStorage.setItem("GENERAL_MODE", String(settings.generalMode));
  }, [settings.generalMode]);

  // Sync temp state when settings open
  useEffect(() => {
      if (showSettings) {
          setTempModel(settings.selectedModel);
          setSaveStatus('idle');
      }
  }, [showSettings, settings.selectedModel]);


  // ─────────────────────────────────────────────────────────────
  //  SCROLL / PIN — single source of truth
  // ─────────────────────────────────────────────────────────────
  //  isPinned = true  → view is locked to bottom, new content auto-follows.
  //  isPinned = false → user scrolled up; content does NOT yank their view,
  //                     a floating "N new ↓" pill surfaces.
  //
  //  Every scroll event updates the pinned state uniformly, regardless of
  //  source (wheel, touch, scrollbar drag, keyboard, arrow keys, End, etc.)
  //  — so scrollbar dragging and keyboard navigation behave correctly.
  //
  //  Programmatic scrolls are flagged via programmaticScrollRef so the
  //  handler doesn't interpret them as user intent.
  // ─────────────────────────────────────────────────────────────
  const PIN_THRESHOLD_PX = 32;
  const [isPinned, setIsPinned] = useState(true);
  const isPinnedRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollClearRef = useRef<number | null>(null);
  // Records how to detach a `scrollend` listener at guard-clear time —
  // captures the element at add-time so a subsequent chatContainerRef
  // change (e.g. between popout and regular layouts) can't orphan it.
  const programmaticScrollEndCleanupRef = useRef<(() => void) | null>(null);
  // Last observed distance-from-bottom, used to detect a user interrupting
  // a programmatic smooth-scroll: distance converges to 0 from above during
  // our animation, and grows when the user wheels/touches up against it.
  const lastScrollDistanceRef = useRef(0);
  const scrollRAFRef = useRef<number | null>(null);
  const [newSinceUnpin, setNewSinceUnpin] = useState(0);
  const newSinceUnpinRef = useRef(0);
  // When unpinned, a streaming draft contributes +1 to the pill counter.
  // We store the stream's id here as a "claim" so the eventual committed
  // message (same id — see executeSend's `pendingId`) can be recognized
  // and the commit-effect can skip its normal +1 increment. Without this,
  // a single AI response counts twice (once while streaming, once on
  // commit) and the pill reads "1 new ↓" → "2 new ↓".
  //
  // If the stream ENDS without a matching commit landing immediately, we
  // set claimFailedRef to mark "this claim is probably orphaned". The next
  // message that commits (typically the error/system replacement main
  // pushes on failure) then consumes the claim regardless of id match, so
  // the pill glides straight from 1 to 1 instead of briefly showing 2.
  const pendingStreamClaimIdRef = useRef<string | null>(null);
  const claimFailedRef = useRef(false);
  const claimReleaseTimerRef = useRef<number | null>(null);

  // Popout-only: stream-end arrives as an IPC event, and the matching
  // db:messages-updated arrives as a SEPARATE IPC event moments later.
  // Those two handlers run in different tasks so React cannot batch them.
  // If we null streamingMsg on stream-end, the streaming bubble unmounts
  // one frame before the committed bubble mounts — the user sees a gap
  // (the "flash/blink" at the end of every answer).
  //
  // Instead, on stream-end we record the ids here and let a messages-
  // watching effect null streamingMsg atomically with the messages
  // update. Fallback timer covers the degenerate case where no commit
  // ever lands (main crashed, IPC dropped).
  const pendingStreamEndIdRef = useRef<string | null>(null);
  const pendingStreamEndCountRef = useRef(0);
  const streamEndFallbackTimerRef = useRef<number | null>(null);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const silenceTimerRef = useRef<any>(null);
  const inputTextRef = useRef(inputText);

  // Track whether the browser natively supports CSS `field-sizing: content`
  // (Chromium 123+, which Electron 41 satisfies). When available, we skip the
  // JS-driven auto-resize entirely because every `style.height = 'auto'` +
  // `scrollHeight` read forces a full synchronous layout recomputation, and
  // doing that on every keystroke causes perceptible typing lag on pages
  // with large message lists / syntax-highlighted code blocks.
  const supportsFieldSizing = useMemo(
    () => typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('field-sizing', 'content'),
    []
  );

  useEffect(() => {
    inputTextRef.current = inputText;
    if (supportsFieldSizing) return; // CSS handles growth — no layout thrash
    const ta = textareaRef.current;
    if (!ta) return;
    // Defer to rAF so the write doesn't block the keystroke's paint.
    const id = requestAnimationFrame(() => {
      ta.style.height = 'auto';
      const newHeight = Math.min(ta.scrollHeight, 150);
      ta.style.height = newHeight + 'px';
    });
    return () => cancelAnimationFrame(id);
  }, [inputText, supportsFieldSizing]);

  // API keys are now managed server-side — no client init needed

  // Always read the latest streaming message from a ref inside rAF
  // callbacks — closure-captured `streamingMsg` could be stale by the
  // time the frame fires (e.g. regenerate started a new stream one tick
  // after this effect was scheduled).
  const streamingMsgRef = useRef<Message | null>(null);
  useEffect(() => { streamingMsgRef.current = streamingMsg; }, [streamingMsg]);

  // Tear down any active programmatic-scroll guard. Removes the `scrollend`
  // listener (via the saved element-aware cleanup), clears the safety
  // timeout, and drops the flag so the next scroll event is treated as
  // user intent.
  const clearProgrammaticGuard = useCallback(() => {
    programmaticScrollRef.current = false;
    if (programmaticScrollEndCleanupRef.current) {
      programmaticScrollEndCleanupRef.current();
      programmaticScrollEndCleanupRef.current = null;
    }
    if (programmaticScrollClearRef.current !== null) {
      window.clearTimeout(programmaticScrollClearRef.current);
      programmaticScrollClearRef.current = null;
    }
  }, []);

  // Keep ref + react state synchronized so that the render path reads
  // a stable value while the imperative scroll code reads the ref.
  // On repin, clear BOTH the pill counter and any outstanding stream
  // claim — the view is fresh from here.
  const setPinned = useCallback((next: boolean) => {
    if (isPinnedRef.current === next) return;
    isPinnedRef.current = next;
    setIsPinned(next);
    if (next) {
      newSinceUnpinRef.current = 0;
      setNewSinceUnpin(0);
      pendingStreamClaimIdRef.current = null;
      claimFailedRef.current = false;
      if (claimReleaseTimerRef.current !== null) {
        window.clearTimeout(claimReleaseTimerRef.current);
        claimReleaseTimerRef.current = null;
      }
    } else {
      // Unpinning mid-stream: cancel any auto-scroll frame already
      // queued by the streaming effect. Otherwise it fires one frame
      // after the user wheeled up and slaps scrollTop back to the
      // bottom (the "jerk/slap"). The rAF also re-checks isPinnedRef
      // so this is belt-and-suspenders — but when token rate is high
      // the rAF can fire before React processes the unpin, so cancel
      // explicitly.
      if (scrollRAFRef.current !== null) {
        cancelAnimationFrame(scrollRAFRef.current);
        scrollRAFRef.current = null;
      }
    }
  }, []);

  // Programmatic scroll — sets a flag so the scroll handler can tell
  // the difference between "we fired this" and "user fired this". The
  // flag clears on the native `scrollend` event (fires exactly when the
  // animation finishes, regardless of distance/device speed); a 1200ms
  // hard-safety timeout covers the rare case where the container is
  // remounted mid-animation so `scrollend` never lands. This replaces
  // a previous fixed 450ms window that could clip early on slow machines
  // (tail scroll events arriving after the flag cleared were misread as
  // user intent, flickering the pin state).
  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = chatContainerRef.current;
    if (!el) return;
    clearProgrammaticGuard();
    programmaticScrollRef.current = true;
    lastScrollDistanceRef.current = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);

    if (smooth) {
      const onEnd = () => clearProgrammaticGuard();
      el.addEventListener('scrollend', onEnd, { once: true });
      programmaticScrollEndCleanupRef.current = () => {
        el.removeEventListener('scrollend', onEnd);
      };
      programmaticScrollClearRef.current = window.setTimeout(onEnd, 1200);
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
      // Instant scroll dispatches exactly one `scroll` event on the next
      // microtask; setTimeout(0) reliably outlives it on every browser.
      programmaticScrollClearRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
        programmaticScrollClearRef.current = null;
      }, 0);
    }
  }, [clearProgrammaticGuard]);

  // Single scroll handler — wheel, touchmove, scrollbar drag, keyboard
  // (PageUp/PageDown/Arrow/Home/End) all dispatch `scroll` events on
  // the container, so one handler covers every intent source.
  //
  // During a programmatic smooth-scroll, the guard blocks pin-state
  // updates — distance is converging toward 0 from above, so intermediate
  // positions aren't user intent. BUT if the user wheels up against the
  // animation, distance grows again — that's user intent beating our
  // motion, and the guard must yield immediately or their input gets
  // silently ignored. The +4px tolerance absorbs fractional-pixel jitter
  // in Chromium's smooth interpolation.
  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const distance = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    if (programmaticScrollRef.current) {
      if (distance > lastScrollDistanceRef.current + 4) {
        clearProgrammaticGuard();
      } else {
        lastScrollDistanceRef.current = distance;
        return;
      }
    }
    lastScrollDistanceRef.current = distance;
    // During streaming, auto-scroll holds the view AT the bottom
    // (distance ≈ 0). Any user-initiated upward movement creates
    // distance > 0 — unambiguous "let me read this" intent, and we
    // must unpin on even a tiny motion. The 32px default threshold
    // is generous on purpose (absorbs bounce, rounding, inertial
    // overshoot) but during a stream it's too generous: a 10px
    // wheel flick would stay "pinned" and the next auto-scroll frame
    // would slap the view back down. Use a tight 4px during streams.
    const threshold = streamingMsgRef.current ? 4 : PIN_THRESHOLD_PX;
    setPinned(distance < threshold);
  }, [setPinned, clearProgrammaticGuard]);

  // Pill click: smooth-scroll to bottom and re-pin in one motion.
  const handleJumpToLatest = useCallback(() => {
    scrollToBottom(true);
    setPinned(true);
  }, [scrollToBottom, setPinned]);

  // Streaming: coalesces rapid content updates to one rAF per frame.
  // While pinned, each frame scrolls to the latest scrollHeight (instant,
  // not smooth — smooth-per-token queues stack into jitter). While
  // unpinned, set the pill to "1 new" exactly once for the whole stream
  // and record the stream's id as a pending claim; the commit-effect
  // will consume that claim when the matching message lands, so the
  // pill stays at 1 through the stream→commit transition (no flicker,
  // no double-count). Stream ids == committed message ids (same
  // `pendingId` — see executeSend:1842/1893), so id-based matching is
  // reliable. rAF reads streamingMsgRef (not a closure) so a mid-frame
  // regenerate doesn't operate on a stale id.
  useEffect(() => {
    if (!streamingMsg) return;
    if (scrollRAFRef.current !== null) return;
    scrollRAFRef.current = requestAnimationFrame(() => {
      scrollRAFRef.current = null;
      const current = streamingMsgRef.current;
      if (!current) return;
      if (isPinnedRef.current) {
        scrollToBottom(false);
      } else {
        if (newSinceUnpinRef.current < 1) {
          newSinceUnpinRef.current = 1;
          setNewSinceUnpin(1);
        }
        // A fresh stream establishes a new claim — any stale "failed"
        // state from a prior stream is no longer relevant.
        claimFailedRef.current = false;
        pendingStreamClaimIdRef.current = current.id;
      }
    });
  }, [streamingMsg?.content, scrollToBottom]);

  // Commit events (user sends / AI response lands / cross-window sync in
  // popout). If pinned → follow the bottom. If unpinned → increment
  // unread count on the pill, but CONSUME any pending stream claim whose
  // id appears among the newly-committed messages. That message was
  // already counted as the +1 draft during streaming, so counting it
  // again would be a double-count. First non-empty render (initial load)
  // pins instantly without animation; subsequent user sends use smooth
  // scroll because the motion feels intentional.
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    const prevLen = prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;
    if (messages.length === 0 || messages.length <= prevLen) return;

    const lastMsg = messages[messages.length - 1];

    if (isPinnedRef.current) {
      const isInitialLoad = prevLen === 0;
      const isUserSend = !isInitialLoad && lastMsg.role === 'user';
      // Defer one frame so the newly-committed message has rendered
      // and scrollHeight reflects its actual size before we scroll.
      requestAnimationFrame(() => scrollToBottom(isUserSend));
      return;
    }

    let added = messages.length - prevLen;
    const claimId = pendingStreamClaimIdRef.current;
    if (claimId !== null) {
      const newMsgs = messages.slice(prevLen);
      const matchById = newMsgs.some(m => m.id === claimId);
      // If the stream ended without a matching commit landing immediately,
      // claimFailedRef was set — meaning the response errored and main
      // is about to push a replacement system/error message with a
      // *different* id. Consume the claim on that next message too, so
      // the pill glides 1 → 1 instead of briefly flashing 2 → 1 while
      // the 1.5s release timer runs.
      const consumable = matchById || (claimFailedRef.current && newMsgs.length > 0);
      if (consumable) {
        pendingStreamClaimIdRef.current = null;
        claimFailedRef.current = false;
        if (claimReleaseTimerRef.current !== null) {
          window.clearTimeout(claimReleaseTimerRef.current);
          claimReleaseTimerRef.current = null;
        }
        added -= 1;
      }
    }
    if (added > 0) {
      newSinceUnpinRef.current += added;
      setNewSinceUnpin(newSinceUnpinRef.current);
    }
  }, [messages.length, scrollToBottom]);

  // When the streaming draft clears, its matching commit is expected
  // within one tick (main calls db.addMessage() before relaying
  // stream-end — see executeSend). If no match arrives within a grace
  // window, the stream errored out and the +1 we added during streaming
  // is now an orphan — release it so the pill doesn't stay one unit too
  // high. The commit-effect's claim-consumption clears the timer for the
  // success case; this handler only fires in the error/abort path.
  useEffect(() => {
    if (streamingMsg !== null) {
      // New stream is live — any prior failure flag no longer applies.
      claimFailedRef.current = false;
      if (claimReleaseTimerRef.current !== null) {
        window.clearTimeout(claimReleaseTimerRef.current);
        claimReleaseTimerRef.current = null;
      }
      return;
    }
    const claimId = pendingStreamClaimIdRef.current;
    if (claimId === null) return;
    // Already-committed fast path: if the DB update raced ahead and the
    // claim was satisfied before this effect ran, there's nothing to do.
    if (messagesRef.current.some(m => m.id === claimId)) return;
    // Stream ended with an outstanding claim and no matching commit yet.
    // Mark the claim as probably-failed so the commit-effect can consume
    // it against whatever different-id replacement lands next. The 1.5s
    // timer below is the fallback for the "nothing ever commits" case.
    claimFailedRef.current = true;
    if (claimReleaseTimerRef.current !== null) {
      window.clearTimeout(claimReleaseTimerRef.current);
    }
    claimReleaseTimerRef.current = window.setTimeout(() => {
      claimReleaseTimerRef.current = null;
      const id = pendingStreamClaimIdRef.current;
      if (id === null) {
        claimFailedRef.current = false;
        return;
      }
      if (messagesRef.current.some(m => m.id === id)) {
        claimFailedRef.current = false;
        return;
      }
      pendingStreamClaimIdRef.current = null;
      claimFailedRef.current = false;
      if (newSinceUnpinRef.current > 0) {
        newSinceUnpinRef.current -= 1;
        setNewSinceUnpin(newSinceUnpinRef.current);
      }
    }, 1500);
  }, [streamingMsg]);

  // Popout flash fix: when a new message lands after stream-end, null
  // streamingMsg in the SAME render that adds the committed bubble.
  // Success path: messages gains a message with id === pendingStreamEnd
  // (user's answer committed). Error path: messages grew by any amount
  // (system error message with different id committed). Either way the
  // streaming bubble's purpose has been served and we can unmount it
  // atomically with the commit — no gap frame, no flash.
  useEffect(() => {
    if (pendingStreamEndIdRef.current === null) return;
    if (messages.length <= pendingStreamEndCountRef.current) return;
    const endId = pendingStreamEndIdRef.current;
    pendingStreamEndIdRef.current = null;
    if (streamEndFallbackTimerRef.current !== null) {
      window.clearTimeout(streamEndFallbackTimerRef.current);
      streamEndFallbackTimerRef.current = null;
    }
    setStreamingMsg(prev => prev && prev.id === endId ? null : prev);
  }, [messages.length]);

  // Session switch: abort any in-flight stream (tokens would land on the
  // wrong conversation), flush any coalesced chunk (same reason — a late
  // rAF could otherwise re-populate streamingMsg after we null it), then
  // re-pin and jump to the bottom of whatever the new session shows.
  // Double-RAF waits for React to commit the new message list before
  // measuring scrollHeight.
  useEffect(() => {
    cancelActiveStream();
    flushStreamChunk();
    setStreamingMsg(null);
    // Reset any pending stream-end bookkeeping — a stale id + length
    // snapshot from the previous session could otherwise fire spuriously
    // against the new session's messages.
    pendingStreamEndIdRef.current = null;
    pendingStreamEndCountRef.current = 0;
    if (streamEndFallbackTimerRef.current !== null) {
      window.clearTimeout(streamEndFallbackTimerRef.current);
      streamEndFallbackTimerRef.current = null;
    }
    setPinned(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToBottom(false));
    });
  }, [db.sessionId, cancelActiveStream, flushStreamChunk, setPinned, scrollToBottom]);

  // Abort any in-flight stream on unmount so tokens don't keep
  // costing money after the window closes.
  useEffect(() => () => { cancelActiveStream(); }, [cancelActiveStream]);

  // Cleanup RAFs + timers + scrollend listener on unmount.
  useEffect(() => {
    return () => {
      if (scrollRAFRef.current !== null) {
        cancelAnimationFrame(scrollRAFRef.current);
        scrollRAFRef.current = null;
      }
      if (programmaticScrollEndCleanupRef.current) {
        programmaticScrollEndCleanupRef.current();
        programmaticScrollEndCleanupRef.current = null;
      }
      if (programmaticScrollClearRef.current !== null) {
        window.clearTimeout(programmaticScrollClearRef.current);
        programmaticScrollClearRef.current = null;
      }
      if (claimReleaseTimerRef.current !== null) {
        window.clearTimeout(claimReleaseTimerRef.current);
        claimReleaseTimerRef.current = null;
      }
      if (streamEndFallbackTimerRef.current !== null) {
        window.clearTimeout(streamEndFallbackTimerRef.current);
        streamEndFallbackTimerRef.current = null;
      }
      if (pendingChunkRAFRef.current !== null) {
        cancelAnimationFrame(pendingChunkRAFRef.current);
        pendingChunkRAFRef.current = null;
      }
    };
  }, []);

  // --- Core Logic ---
  const executeSend = useCallback(async (textToSend: string, imageBase64?: string, isAutoSolve?: boolean) => {
      if (!textToSend.trim()) return;

      // ── Feature Gate: Block disallowed models ──
      const currentModel = settingsRef.current.selectedModel;
      if (!gate.canUseModel(currentModel)) {
        const fallback = gate.getDefaultModel();
        setSettings(prev => ({ ...prev, selectedModel: fallback as any }));
        localStorage.setItem("SELECTED_MODEL", fallback);
        // Notify user
        const gateMsg: Message = {
          id: Date.now().toString(),
          role: 'model',
          content: `**${currentModel.charAt(0).toUpperCase() + currentModel.slice(1)}** is a Pro-only model. Switched to **${fallback.charAt(0).toUpperCase() + fallback.slice(1)}**. Upgrade to Pro to unlock all AI models.`,
          timestamp: Date.now()
        };
        if (db.isElectron) { db.addMessage(gateMsg); } else { setMessages(prev => [...prev, gateMsg]); }
        return;
      }

      const userMsg: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: textToSend,
        timestamp: Date.now()
      };

      if (db.isElectron) {
        db.addMessage(userMsg);
      } else {
        setMessages(prev => [...prev, userMsg]);
      }
      setIsProcessing(true);
      setInterimText("");
      setInputText("");
      setPinned(true);

      // Kill any previous in-flight stream before starting this one.
      // Two back-to-back sends must never both be running against
      // the same `streamingMsg` — the late one would win and the
      // earlier one would commit a truncated answer to the DB.
      cancelActiveStream();
      const abort = new AbortController();
      streamAbortRef.current = abort;

      const pendingId = (Date.now() + 1).toString();
      const inPopout = isElectron && isPopoutMode;

      try {
        const currentSettings = settingsRef.current;
        let contextFiles = contextFilesRef.current;

        // Only include a screen capture if one was explicitly passed (e.g. from Auto-Solve)
        if (imageBase64) {
            contextFiles = [...contextFiles, {
                id: 'temp-screen-capture',
                name: 'Screen Capture',
                content: '[Binary File]',
                type: 'custom',
                mimeType: 'image/jpeg',
                base64: imageBase64
            }];
        }
        let responseText = "";

        // Route request through the streaming proxy based on selected model.
        // Every token arriving from the server is appended to `streamingMsg`
        // AND relayed to the popout so BOTH windows render character-by-
        // character instead of the popout seeing one final pop.
        const streamers: Record<string, Function> = { groq: streamGroq, openai: streamOpenAI, xai: streamXAI, gemini: streamGemini, claude: streamClaude };
        const gen = streamers[currentSettings.selectedModel] || streamGemini;
        setStreamingMsg({ id: pendingId, role: 'model', content: '', timestamp: Date.now() });
        if (!inPopout) {
          electronIPC.send('relay-to-popout', { type: 'stream-start', id: pendingId });
        }
        responseText = await gen(
          userMsg.content,
          messagesRef.current,
          contextFiles,
          currentSettings.generalMode,
          (_chunk: string, full: string) => {
            // Guard against a late callback from an already-aborted
            // stream — without this check, a cancelled run could stomp
            // the new stream's state a frame or two after abort().
            if (streamAbortRef.current !== abort) return;
            // rAF-coalesced so a 100 tok/s burst still only re-renders
            // MessageRenderer (markdown + syntax-highlight) at frame rate.
            applyStreamChunk(pendingId, full);
            if (!inPopout) {
              electronIPC.send('relay-to-popout', { type: 'stream-chunk', id: pendingId, full });
            }
          },
          abort.signal,
          isAutoSolve
        );
        // Commit the final text to the DB/state once — the transient
        // streaming bubble is cleared in the same tick to avoid a flash.
        if (responseText !== "Listening...") {
            const aiMsg: Message = {
              id: pendingId,
              role: 'model',
              content: responseText,
              timestamp: Date.now()
            };
            if (db.isElectron) {
              db.addMessage(aiMsg);
            } else {
              setMessages(prev => [...prev, aiMsg]);
            }
            // Auto-title the session once the first model response lands
            // (ChatGPT-style topic summary). Fire-and-forget; if the LLM
            // call fails the placeholder "Interview <date>" stays put.
            // Skip in non-Electron / popout — only main owns the rename.
            if (db.isElectron && !inPopout && db.sessionId) {
              const currentSession = (db.sessions || []).find((s: any) => s.id === db.sessionId);
              const currentName: string = currentSession?.name || '';
              const isPlaceholder = !currentName || /^Interview\s/.test(currentName);
              const turnsSoFar = (messagesRef.current?.length || 0) + 1; // user + this AI msg
              if (isPlaceholder && turnsSoFar >= 2 && turnsSoFar <= 4) {
                const transcript = [...(messagesRef.current || []), aiMsg].map(m => ({ role: m.role, content: m.content }));
                generateConversationTitle(transcript)
                  .then(title => {
                    if (title && db.sessionId) {
                      try { db.renameSession(db.sessionId, title); } catch {}
                    }
                  })
                  .catch(() => {});
              }
            }
        }
        // Cancel any queued chunk rAF before clearing — otherwise a late
        // frame could re-populate the bubble we're about to null.
        flushStreamChunk();
        setStreamingMsg(null);
        if (!inPopout) {
          electronIPC.send('relay-to-popout', { type: 'stream-end', id: pendingId });
        }
      } catch (err: any) {
        // Swallow aborts: they're user-initiated cancellations, not
        // real failures. The new executeSend call has already seeded
        // its own streamingMsg, so we must NOT clobber it here.
        if (err?.name === 'AbortError' || streamAbortRef.current !== abort) {
          return;
        }
        console.error(err);
        flushStreamChunk();
        setStreamingMsg(null);
        if (!inPopout) {
          electronIPC.send('relay-to-popout', { type: 'stream-end', id: pendingId });
        }
        // Show a generic error — never suggest the user log out / log in again.
        // Mid-interview re-auth prompts are catastrophic, and the previous
        // "Session expired. Please log out and log back in." message was
        // effectively telling the user to abandon the interview.
        const actualError = err?.message || 'Unknown error';
        const errorContent = `Error: ${actualError}`;

        const errorMsg: Message = {
          id: Date.now().toString(),
          role: 'system',
          content: errorContent,
          timestamp: Date.now()
        };
        if (db.isElectron) {
          db.addMessage(errorMsg);
        } else {
          setMessages(prev => [...prev, errorMsg]);
        }
      } finally {
        // Only the owner of the current controller should flip
        // isProcessing/ref back off. A cancelled run losing the race
        // to a newer one must NOT reset state the newer run set.
        if (streamAbortRef.current === abort) {
          streamAbortRef.current = null;
          setIsProcessing(false);
        }
      }
  }, [cancelActiveStream]);

  // --- Speech Handling ---
  const handleSpeechResult = useCallback(({ final, interim }: { final: string, interim: string }) => {
    setInterimText(interim);
    if (interim && silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
    }
    if (final) {
        setInputText(prev => {
            const separator = prev.length > 0 && !prev.endsWith(' ') ? " " : "";
            return prev + separator + final;
        });
        if (settingsRef.current.autoSend) {
            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = setTimeout(() => {
                const currentBuffer = inputTextRef.current;
                if (currentBuffer && currentBuffer.trim().length > 0) {
                     executeSend(currentBuffer);
                }
            }, 1200); 
        }
    }
  }, [executeSend]);

  // ── Speech recognition — only runs in the main window, NOT the pop-out ──
  // Pop-out is a thin UI client: it relays actions to main and receives state via IPC.
  const isPopoutThinClient = isElectron && isPopoutMode;

  const { isListening: _rawIsListening, error: _rawSpeechError, startListening: _rawStartListening, stopListening: _rawStopListening, stream } = useSpeechRecognition({
    onResult: isPopoutThinClient ? () => {} : handleSpeechResult,
    onError: (err) => console.error("Speech Error:", err),
  });

  // Pop-out: shadow state received from main window via IPC
  const [remoteIsListening, setRemoteIsListening] = useState(false);
  const [remoteIsProcessing, setRemoteIsProcessing] = useState(false);
  const [remoteSpeechError, setRemoteSpeechError] = useState<string | null>(null);

  // Pop-out: shadow credit-timer state — main is authoritative, popout mirrors
  // so it can render the hour-boundary / low-warning / exhausted modals while
  // main is backgrounded (the common case during an interview).
  const [remoteCreditHourBoundary, setRemoteCreditHourBoundary] = useState(false);
  const [remoteCreditLowWarning, setRemoteCreditLowWarning] = useState(false);
  const [remoteCreditExhausted, setRemoteCreditExhausted] = useState(false);
  const [remoteCreditRemaining, setRemoteCreditRemaining] = useState(0);
  const [remoteCreditSource, setRemoteCreditSource] = useState<'trial' | 'credits' | 'unlimited' | 'none'>('none');
  const [remoteCreditActualTier, setRemoteCreditActualTier] = useState<'free' | 'basic' | 'pro' | 'max'>('free');
  const [remoteCreditCountryCode, setRemoteCreditCountryCode] = useState('US');

  // Expose unified state — pop-out reads from remote, main reads from local
  const isListening = isPopoutThinClient ? remoteIsListening : _rawIsListening;
  const speechError = isPopoutThinClient ? remoteSpeechError : _rawSpeechError;

  useEffect(() => {
      streamRef.current = stream;
  }, [stream]);

  // Refs used by the main-side popout command handler so request-state reads
  // current values instead of stale closure snapshots. Without these, the first
  // sync right after popout opens would echo whatever state main had when the
  // handler was last registered.
  const rawIsListeningRef = useRef(_rawIsListening);
  const isProcessingRef = useRef(isProcessing);
  const interimTextRef = useRef(interimText);
  const rawSpeechErrorRef = useRef(_rawSpeechError);
  const gateRef = useRef(gate);
  useEffect(() => { rawIsListeningRef.current = _rawIsListening; }, [_rawIsListening]);
  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { interimTextRef.current = interimText; }, [interimText]);

  // Tell the Electron main process when an interview is live so it can
  // tear down the system-tray icon and any other OS-shell surface that
  // sits outside setContentProtection. The tray icon is rendered by
  // the OS, not by us, so it leaks on screen-share even though every
  // BrowserWindow we own is content-protected. Fired only from the
  // main window — popouts shouldn't double-fire (they're a thin client
  // mirroring main's state).
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;
    electronIPC.send('session-active', { active: !!_rawIsListening });
  }, [_rawIsListening]);
  useEffect(() => { rawSpeechErrorRef.current = _rawSpeechError; }, [_rawSpeechError]);
  useEffect(() => { gateRef.current = gate; }, [gate]);

  // Credit-timer refs — populated below once `creditTimer` is defined. Used by
  // the main-side `request-state` reply so popout's first sync carries the
  // current credit-modal state instead of stale boot-time values.
  const creditTimerRef = useRef<{
    hourBoundary: boolean; lowWarning: boolean; exhausted: boolean;
    remaining: number; source: 'trial' | 'credits' | 'unlimited' | 'none';
  }>({ hourBoundary: false, lowWarning: false, exhausted: false, remaining: 0, source: 'none' });
  const userProfileRef = useRef(userProfile);
  useEffect(() => { userProfileRef.current = userProfile; }, [userProfile]);

  // Popout-side pending-model guard. When the popout user picks a model we
  // update popout state optimistically AND send cmd-set-model to main. But
  // main's state-sync push fires on every interim/input/isListening tick,
  // so if the user is speaking, main can emit several syncs carrying the
  // OLD selectedModel before it has processed our IPC. Without this guard
  // the dropdown flickers back to the old value and then forward again,
  // which the user sees as "the model selection keeps falling back."
  //
  // Rule: while pendingPopoutModelRef is set, ignore inbound selectedModel
  // that doesn't match it. Clear once main echoes the requested value.
  const pendingPopoutModelRef = useRef<string | null>(null);

  // ── Cross-window state sync (Electron only) ──
  // Main window → pop-out: relay state whenever it changes
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;
    electronIPC.send('relay-to-popout', {
      type: 'state-sync',
      isListening: _rawIsListening,
      isProcessing,
      interimText,
      inputText,
      autoSend: settings.autoSend,
      speechError: _rawSpeechError,
      selectedModel: settings.selectedModel,
    });
  }, [_rawIsListening, isProcessing, interimText, inputText, settings.autoSend, _rawSpeechError, settings.selectedModel]);

  // Pop-out: receive state from main window
  useEffect(() => {
    if (!isPopoutThinClient) return;

    const handler = (data: any) => {
      if (data?.type === 'state-sync') {
        setRemoteIsListening(data.isListening);
        setRemoteIsProcessing(data.isProcessing);
        setInterimText(data.interimText ?? '');
        setInputText(data.inputText ?? '');
        setRemoteSpeechError(data.speechError ?? null);
        setIsProcessing(data.isProcessing);
        // Echo-confirmation for a user's in-flight model pick. If main has
        // caught up and sent back the model we were waiting for, drop the
        // pending marker so future pushes from main are accepted normally.
        if (data.selectedModel && pendingPopoutModelRef.current === data.selectedModel) {
          pendingPopoutModelRef.current = null;
        }
        setSettings(prev => {
          const needsAutoSend = prev.autoSend !== data.autoSend;
          let needsModel = data.selectedModel && prev.selectedModel !== data.selectedModel;
          // Discard stale selectedModel pushes while a local pick is
          // unconfirmed — otherwise the dropdown bounces: user → groq,
          // main pushes gemini (stale), popout flips back, then main
          // catches up and flips forward again.
          if (needsModel && pendingPopoutModelRef.current && pendingPopoutModelRef.current !== data.selectedModel) {
            needsModel = false;
          }
          if (!needsAutoSend && !needsModel) return prev;
          return {
            ...prev,
            ...(needsAutoSend ? { autoSend: data.autoSend } : {}),
            ...(needsModel ? { selectedModel: data.selectedModel } : {}),
          };
        });
      } else if (data?.type === 'credit-sync') {
        setRemoteCreditHourBoundary(!!data.hourBoundary);
        setRemoteCreditLowWarning(!!data.lowWarning);
        setRemoteCreditExhausted(!!data.exhausted);
        setRemoteCreditRemaining(typeof data.remaining === 'number' ? data.remaining : 0);
        setRemoteCreditSource(data.source ?? 'none');
        setRemoteCreditActualTier(data.actualTier ?? 'free');
        setRemoteCreditCountryCode(data.countryCode ?? 'US');
      } else if (data?.type === 'stream-start') {
        // Main is about to begin a stream. Mint a transient bubble
        // here too so the popout renders tokens as they arrive. Discard
        // any stale coalesced chunk from a previous stream that hasn't
        // flushed yet — its id won't match this new stream and would
        // otherwise be a dead letter sitting in the ref.
        flushStreamChunk();
        setStreamingMsg({ id: data.id, role: 'model', content: '', timestamp: Date.now() });
      } else if (data?.type === 'stream-chunk') {
        // rAF-coalesce to one React commit per frame. MessageRenderer
        // re-parses markdown on every content change, so at upstream
        // rates of 100 tok/s this is the difference between a smooth
        // stream and a janky popout. The inner reducer guards id
        // equality to drop out-of-order frames from a cancelled run.
        applyStreamChunk(data.id, data.full);
      } else if (data?.type === 'stream-end') {
        // DO NOT clear streamingMsg here — the commit arrives as a
        // separate IPC (`db:messages-updated`) moments later and React
        // cannot batch the two. Clearing now unmounts the streaming
        // bubble one frame before the committed bubble mounts, which
        // the user sees as a flash/blink. Instead, record the commit
        // expectation and let the messages-watching effect below clear
        // streamingMsg atomically with the messages update. The
        // fallback timer handles "no commit ever arrived" (error path
        // that failed to broadcast, crashed main, etc).
        flushStreamChunk();
        pendingStreamEndIdRef.current = data.id;
        pendingStreamEndCountRef.current = messagesRef.current.length;
        if (streamEndFallbackTimerRef.current !== null) {
          window.clearTimeout(streamEndFallbackTimerRef.current);
        }
        streamEndFallbackTimerRef.current = window.setTimeout(() => {
          streamEndFallbackTimerRef.current = null;
          pendingStreamEndIdRef.current = null;
          setStreamingMsg(prev => prev && prev.id === data.id ? null : prev);
        }, 1500);
      }
    };
    const dispose = electronIPC.on('from-main', handler);
    electronIPC.send('relay-to-main', { type: 'request-state' });
    return dispose;
  }, []);

  // --- UI Actions (pop-out relays to main, main executes locally) ---
  const startListening = isPopoutThinClient
    ? () => electronIPC.send('relay-to-main', { type: 'cmd-start-listening' })
    : _rawStartListening;

  const stopListening = isPopoutThinClient
    ? () => electronIPC.send('relay-to-main', { type: 'cmd-stop-listening' })
    : _rawStopListening;

  // ── Credit timer — only drives session time for Basic users + trial.
  // Pro/Max get balance.source='unlimited' and the service auto no-ops.
  // Popout is a thin UI client — the main window owns the authoritative timer,
  // so skip mounting on popout to avoid double-ticking against localStorage.
  const creditTimer = useCreditTimer({
    isListening: isPopoutThinClient ? false : isListening,
    license: userLicense,
    onForceStop: stopListening,
  });

  // Keep the ref in sync so the `request-state` popout handler reads fresh values
  // from any render — without this, the first IPC reply after popout-open would
  // snapshot whatever state existed when the main-side IPC handler registered.
  useEffect(() => {
    creditTimerRef.current = {
      hourBoundary: creditTimer.hourBoundary,
      lowWarning: creditTimer.lowWarning,
      exhausted: creditTimer.exhausted,
      remaining: creditTimer.remaining,
      source: creditTimer.source,
    };
  }, [creditTimer.hourBoundary, creditTimer.lowWarning, creditTimer.exhausted, creditTimer.remaining, creditTimer.source]);

  // Main → popout: push credit-timer state so the popout can render its own
  // copy of the modals. The first state-sync effect above is declared before
  // `creditTimer` exists, so we keep this as a separate effect (no TDZ).
  //
  // `creditTimer.remaining` ticks every second, but the popout only reads it
  // when a boolean (hourBoundary / lowWarning / exhausted) flips — and during
  // hour-boundary the tick loop is paused anyway. So we deliberately leave
  // `remaining` OUT of the dep list and read the latest value from the ref
  // (which the effect above keeps fresh). This stops the IPC from firing
  // every second during a session.
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;
    electronIPC.send('relay-to-popout', {
      type: 'credit-sync',
      hourBoundary: creditTimer.hourBoundary,
      lowWarning: creditTimer.lowWarning,
      exhausted: creditTimer.exhausted,
      remaining: creditTimerRef.current.remaining,
      source: creditTimer.source,
      actualTier: gate.actualTier,
      countryCode: userProfile?.country_code || 'US',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditTimer.hourBoundary, creditTimer.lowWarning, creditTimer.exhausted, creditTimer.source, gate.actualTier, userProfile?.country_code]);

  const handleRenewCredit = useCallback(async () => {
    // v1: reuse the same checkout entry point. Server-side will eventually
    // differentiate renewal charges from full-plan purchases.
    try { await openProUpgrade(); } catch (e) { console.warn('renew failed:', e); }
  }, []);

  const handleOpenUpgrade = useCallback(async () => {
    try { await openProUpgrade(); } catch (e) { console.warn('upgrade failed:', e); }
  }, []);

  const handleManualSend = () => {
    if (isPopoutThinClient) {
      if (!inputText.trim()) return;
      electronIPC.send('relay-to-main', { type: 'cmd-manual-send', text: inputText });
      setInputText('');
      return;
    }
    if (!inputText.trim() || isProcessing) return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    executeSend(inputText);
  };

  /**
   * One-shot screen capture — grabs a single frame and immediately releases resources.
   * Electron: fresh getUserMedia (video only), screenshot, stop tracks.
   * Browser: uses the existing display stream if video track is still alive.
   */
  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    // ── Feature Gate: Screen capture is Pro only ──
    if (!gate.canScreenCapture) {
      console.warn('[FeatureGate] Screen capture blocked — free tier');
      return null;
    }

    let tempStream: MediaStream | null = null;
    try {
      let videoTrack: MediaStreamTrack | null = null;

      if (isElectron) {
        // Fresh one-shot capture in Electron
        const sources = await electronIPC.invoke('get-desktop-sources');
        if (!sources || sources.length === 0) return null;

        const screenSource = sources.find((s: any) =>
          s.name === 'Entire Screen' || s.name === 'Screen 1' || s.name.toLowerCase().includes('screen')
        ) || sources[0];

        tempStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 5,
            }
          } as any,
        });
        videoTrack = tempStream.getVideoTracks()[0] || null;
      } else {
        // Browser: reuse existing stream's video track
        videoTrack = streamRef.current?.getVideoTracks()[0] || null;
      }

      if (!videoTrack || videoTrack.readyState !== 'live') return null;

      const video = document.createElement('video');
      video.srcObject = new MediaStream([videoTrack]);
      await video.play();

      let width = video.videoWidth;
      let height = video.videoHeight;
      const MAX_WIDTH = 1920;
      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width);
        width = MAX_WIDTH;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(video, 0, 0, width, height);

      const base64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];

      // Cleanup DOM elements to prevent memory leaks
      video.pause();
      video.srcObject = null;
      video.remove();
      canvas.remove();

      return base64;
    } catch (err) {
      console.error("Screen capture failed:", err);
      return null;
    } finally {
      // Release the one-shot stream in Electron (don't touch the browser's ongoing stream)
      if (tempStream) {
        tempStream.getTracks().forEach(t => t.stop());
      }
    }
  }, []);

  // Main window: listen for commands from pop-out
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;

    const handler = (data: any) => {
      if (!data?.type) return;
      switch (data.type) {
        case 'cmd-start-listening':
          _rawStartListening();
          break;
        case 'cmd-stop-listening':
          _rawStopListening();
          break;
        case 'cmd-toggle-auto-send':
          setSettings(prev => ({ ...prev, autoSend: !prev.autoSend }));
          break;
        case 'cmd-manual-send':
          if (data.text?.trim()) executeSend(data.text);
          break;
        case 'cmd-auto-solve':
          captureScreenshot().then(screenshot => {
            // isAutoSolve=true swaps the system prompt to code-only output
            // and skips the candidate-persona voice rules, so CodeBlock's
            // auto-type receives pure code instead of prose-as-comments.
            executeSend(AUTO_SOLVE_PROMPT, screenshot || undefined, true);
          });
          break;
        case 'cmd-clear':
          setInputText('');
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          break;
        case 'cmd-set-input':
          setInputText(data.text ?? '');
          break;
        case 'cmd-set-model': {
          // Popout picked a model — validate against main's gate, persist, and
          // let the push effect echo selectedModel back to popout for confirmation.
          const requested = data.model as 'gemini' | 'groq' | 'openai' | 'xai' | 'claude';
          if (!requested || !gateRef.current.canUseModel(requested)) break;
          setSettings(prev => prev.selectedModel === requested ? prev : { ...prev, selectedModel: requested });
          localStorage.setItem("SELECTED_MODEL", requested);
          break;
        }
        // Credit-timer relays from popout. Main owns the authoritative state —
        // these cases forward the popout's decision into local handlers, which
        // update state, which re-broadcasts via the credit-sync effect and
        // unmounts the popout modal. Self-consistent round-trip.
        case 'cmd-credit-boundary-ack':
          if (data.decision === 'continue' || data.decision === 'stop') {
            creditTimer.acknowledgeHourBoundary(data.decision);
          }
          break;
        case 'cmd-credit-low-dismiss':
          creditTimer.dismissLowWarning();
          break;
        case 'cmd-credit-exhausted-dismiss':
          creditTimer.dismissExhausted();
          break;
        case 'cmd-credit-renew':
          handleRenewCredit();
          break;
        case 'cmd-credit-upgrade':
          handleOpenUpgrade();
          break;
        case 'request-state':
          // Read via refs so the first sync after popout opens reflects current
          // state, not whatever was closed over when this handler was registered.
          electronIPC.send('relay-to-popout', {
            type: 'state-sync',
            isListening: rawIsListeningRef.current,
            isProcessing: isProcessingRef.current,
            interimText: interimTextRef.current,
            inputText: inputTextRef.current,
            autoSend: settingsRef.current.autoSend,
            speechError: rawSpeechErrorRef.current,
            selectedModel: settingsRef.current.selectedModel,
          });
          // Piggy-back the current credit-timer state so the popout can render
          // modals it missed (e.g. user opened popout AFTER an hour-boundary
          // fired on main). Without this, popout starts with all-false modals
          // and only learns about subsequent transitions.
          electronIPC.send('relay-to-popout', {
            type: 'credit-sync',
            hourBoundary: creditTimerRef.current.hourBoundary,
            lowWarning: creditTimerRef.current.lowWarning,
            exhausted: creditTimerRef.current.exhausted,
            remaining: creditTimerRef.current.remaining,
            source: creditTimerRef.current.source,
            actualTier: gateRef.current.actualTier,
            countryCode: userProfileRef.current?.country_code || 'US',
          });
          break;
      }
    };
    return electronIPC.on('from-popout', handler);
  }, [executeSend, captureScreenshot, _rawStartListening, _rawStopListening]);

  const handleAutoSolve = async () => {
    // ── Feature Gate: Auto-Solve is Pro only ──
    if (!gate.canAutoSolve) {
      const gateMsg: Message = {
        id: Date.now().toString(),
        role: 'model',
        content: '**Auto-Solve** is a Pro feature. [Upgrade to Pro](upgrade) to capture your screen and get instant AI solutions.',
        timestamp: Date.now()
      };
      if (db.isElectron) { db.addMessage(gateMsg); } else { setMessages(prev => [...prev, gateMsg]); }
      return;
    }

    if (isPopoutThinClient) {
      electronIPC.send('relay-to-main', { type: 'cmd-auto-solve' });
      return;
    }
    if (isProcessing) return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    // One-shot screen capture, then send with the image.
    // isAutoSolve=true swaps the system prompt to code-only output and
    // skips the candidate-persona voice rules, so CodeBlock's auto-type
    // receives pure code instead of prose-as-comments.
    const screenshot = await captureScreenshot();
    executeSend(AUTO_SOLVE_PROMPT, screenshot || undefined, true);
  };

  const handleClear = () => {
      if (isPopoutThinClient) {
        electronIPC.send('relay-to-main', { type: 'cmd-clear' });
        return;
      }
      setInputText("");
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
  };

  const handleRegenerate = async () => {
    if (isProcessing) return;
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;

    // Auto-solve regenerate needs special handling: the screenshot was never
    // persisted on the user message, so naively re-streaming AUTO_SOLVE_PROMPT
    // as plain text would reach the model with no image and produce garbage.
    // Delegate back to handleAutoSolve so a fresh screenshot is captured and
    // isAutoSolve=true gets set on the request.
    if (lastUserMsg.content === AUTO_SOLVE_PROMPT) {
      return handleAutoSolve();
    }

    cancelActiveStream();
    const abort = new AbortController();
    streamAbortRef.current = abort;

    setIsProcessing(true);
    const pendingId = Date.now().toString();
    const inPopout = isElectron && isPopoutMode;

    try {
        const historyForService = messages.filter(m => m.id !== lastUserMsg.id && m.role !== 'system');
        const currentSettings = settingsRef.current;
        const contextFiles = contextFilesRef.current;
        let responseText = "";

        const streamers: Record<string, Function> = { groq: streamGroq, openai: streamOpenAI, xai: streamXAI, gemini: streamGemini, claude: streamClaude };
        const gen = streamers[currentSettings.selectedModel] || streamGemini;
        setStreamingMsg({ id: pendingId, role: 'model', content: '', timestamp: Date.now() });
        if (!inPopout) {
          electronIPC.send('relay-to-popout', { type: 'stream-start', id: pendingId });
        }
        responseText = await gen(
          lastUserMsg.content,
          historyForService,
          contextFiles,
          currentSettings.generalMode,
          (_chunk: string, full: string) => {
            if (streamAbortRef.current !== abort) return;
            applyStreamChunk(pendingId, full);
            if (!inPopout) {
              electronIPC.send('relay-to-popout', { type: 'stream-chunk', id: pendingId, full });
            }
          },
          abort.signal
        );

        if (responseText !== "Listening...") {
            const aiMsg: Message = {
                id: pendingId,
                role: 'model',
                content: responseText,
                timestamp: Date.now()
            };
            if (db.isElectron) { db.addMessage(aiMsg); } else { setMessages(prev => [...prev, aiMsg]); }
        }
        flushStreamChunk();
        setStreamingMsg(null);
        if (!inPopout) {
          electronIPC.send('relay-to-popout', { type: 'stream-end', id: pendingId });
        }
    } catch (err: any) {
        if (err?.name === 'AbortError' || streamAbortRef.current !== abort) return;
        console.error(err);
        flushStreamChunk();
        setStreamingMsg(null);
        if (!inPopout) {
          electronIPC.send('relay-to-popout', { type: 'stream-end', id: pendingId });
        }
    } finally {
        if (streamAbortRef.current === abort) {
          streamAbortRef.current = null;
          setIsProcessing(false);
        }
    }
  };

  const triggerFileUpload = () => {
    // The OS file picker is a native dialog and is NOT covered by
    // setContentProtection. If a screen-share is on while this opens,
    // the picker contents (filenames in the chosen folder, recents
    // sidebar) leak to viewers. The button is disabled while listening
    // (see render site) — this is a defense-in-depth check in case the
    // disabled state ever gets bypassed (keyboard shortcut, etc.).
    if (rawIsListeningRef.current) return;
    fileInputRef.current?.click();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Copy files to array BEFORE resetting (FileList can become invalid after reset)
    const fileArray = Array.from(files);

    // Reset input so same file can be selected again
    e.target.value = '';

    // ── Feature Gate: Context file limit ──
    // Silent return — the "Add File" button is already disabled + shows
    // "Limit reached" in the modal (see line ~3829). A native confirm()
    // here would pop an OS-level dialog that bypasses setContentProtection
    // and leak the upgrade prompt on a screen share.
    if (gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles) {
      return;
    }

    // Process each file
    const processFile = async (file: File, index: number) => {
      const isText = file.type.startsWith('text/') ||
                     file.name.endsWith('.txt') ||
                     file.name.endsWith('.md') ||
                     file.name.endsWith('.js') ||
                     file.name.endsWith('.ts') ||
                     file.name.endsWith('.py') ||
                     file.name.endsWith('.json') ||
                     file.name.endsWith('.html') ||
                     file.name.endsWith('.css') ||
                     file.name.endsWith('.csv');

      const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');
      const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.endsWith('.docx');

      if (isPdf) {
        setIsProcessing(true);
        try {
          const text = await extractTextFromPdf(file);
          db.addContextFile({
            id: `${Date.now()}-${index}`,
            name: file.name,
            content: text,
            type: 'custom',
            mimeType: 'text/plain',
            base64: undefined
          });
        } catch (err) {
          // Silent skip on extraction failure — a native alert() showing
          // the filename would leak a resume/JD filename to screen-share.
          // The file simply is not attached; user sees it is absent from
          // the Attached Files list.
          console.error('[context] PDF extract failed:', err);
        } finally {
          setIsProcessing(false);
        }
      } else if (isDocx) {
        setIsProcessing(true);
        try {
          const text = await extractTextFromDocx(file);
          db.addContextFile({
            id: `${Date.now()}-${index}`,
            name: file.name,
            content: text,
            type: 'custom',
            mimeType: 'text/plain',
            base64: undefined
          });
        } catch (err) {
          console.error('[context] DOCX extract failed:', err);
        } finally {
          setIsProcessing(false);
        }
      } else if (isText) {
        await new Promise<void>((resolve) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            const text = event.target?.result as string;
            db.addContextFile({
              id: `${Date.now()}-${index}`,
              name: file.name,
              content: text,
              type: 'custom',
              mimeType: file.type || 'text/plain',
              base64: undefined
            });
            resolve();
          };
          reader.onerror = () => resolve();
          reader.readAsText(file);
        });
      } else {
        // Binary (Image)
        await new Promise<void>((resolve) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            const result = event.target?.result as string;
            const base64Data = result.split(',')[1];
            const mimeType = result.split(':')[1].split(';')[0];
            db.addContextFile({
              id: `${Date.now()}-${index}`,
              name: file.name,
              content: '[Binary File]',
              type: 'custom',
              mimeType: mimeType,
              base64: base64Data
            });
            resolve();
          };
          reader.onerror = () => resolve();
          reader.readAsDataURL(file);
        });
      }
    };

    // Process all selected files (Pro users can select multiple)
    let filesProcessed = 0;
    for (let i = 0; i < fileArray.length; i++) {
      // For free users, check limit before each file
      if (gate.maxContextFiles !== -1 && db.contextFiles.length + filesProcessed >= gate.maxContextFiles) {
        break;
      }
      await processFile(fileArray[i], i);
      filesProcessed++;
    }
  };
  
  const handleAddPasteText = () => {
      if (!pasteContent.trim()) return;
      // ── Feature Gate: Context file limit ──
      // Silent return — paste button is gated by the same limit check in
      // the render tree. See handleFileUpload above for the rationale on
      // avoiding native confirm() dialogs on screen-share leaks.
      if (gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles) {
        return;
      }
      const newFile: ContextFile = {
          id: Date.now().toString(),
          name: `Pasted Context ${db.contextFiles.length + 1}`,
          content: pasteContent,
          type: 'custom'
      };
      db.addContextFile(newFile);
      setPasteContent("");
  };

  const removeFile = (id: string) => {
    db.removeContextFile(id);
  };

  const toggleAutoSend = () => {
    if (isPopoutThinClient) {
      electronIPC.send('relay-to-main', { type: 'cmd-toggle-auto-send' });
      return;
    }
    setSettings(prev => ({ ...prev, autoSend: !prev.autoSend }));
  };
  
  const toggleGeneralMode = () => {
      setSettings(prev => ({ ...prev, generalMode: !prev.generalMode }));
  };

  const saveSettings = () => {
      const safeModel = gate.canUseModel(tempModel) ? tempModel : gate.getDefaultModel() as any;

      localStorage.setItem("SELECTED_MODEL", safeModel);
      localStorage.setItem("THEME", settings.theme);
      localStorage.setItem("FONT_SIZE", settings.fontSize);

      const newSettings: AppSettings = {
          ...settings,
          selectedModel: safeModel,
      };

      setSettings(newSettings);
      settingsRef.current = newSettings;

      setSaveStatus('saved');
      if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = window.setTimeout(() => {
          saveStatusTimerRef.current = null;
          setSaveStatus('idle');
      }, 2000);
  };

  // --- RENDER HELPERS ---

  // Flash-prevention: in the popout, `stream-end` IPC and
  // `db:messages-updated` IPC arrive as separate events and can't be
  // batched. If we show the streaming bubble until its own state clears,
  // we get a gap frame between unmount and the commit's mount. Instead
  // we derive the effective streaming message here: the bubble is hidden
  // the moment `messages` already contains the committed version (success,
  // same id) OR the moment `messages` has grown at all after `stream-end`
  // arrived (error path, different-id system message). In both cases the
  // next render swaps directly from streaming bubble → committed bubble
  // with no visible intermediate state.
  const effectiveStreamingMsg = !streamingMsg
    ? null
    : messages.some(m => m.id === streamingMsg.id)
    ? null
    : (pendingStreamEndIdRef.current === streamingMsg.id
        && messages.length > pendingStreamEndCountRef.current)
    ? null
    : streamingMsg;

  const sharedProps = {
    messages, streamingMsg: effectiveStreamingMsg, settings, setSettings, isListening, isProcessing, inputText, setInputText, interimText,
    speechError, toggleAutoSend, startListening, stopListening, handleManualSend, handleAutoSolve,
    handleClear, handleRegenerate, chatContainerRef, textareaRef, handleScroll,
    isPinned, newSinceUnpin, handleJumpToLatest,
    onOpenSettings: () => setShowSettings(true),
    onOpenContext: () => setShowContext(true),
    onOpenHelp: () => setShowHelp(true),
    onOpenDownload: () => { if (!isElectron) setShowDownloadModal(true); },
    isPipMode,
    togglePip: () => {
      // ── Feature Gate: Popout is Pro only ──
      if (!gate.canPopout) {
        const gateMsg: Message = {
          id: Date.now().toString(),
          role: 'model',
          content: '**Pop-out Mode** is a Pro feature. Upgrade to Pro to use the invisible overlay during interviews.',
          timestamp: Date.now()
        };
        if (db.isElectron) { db.addMessage(gateMsg); } else { setMessages(prev => [...prev, gateMsg]); }
        return;
      }
      if (isElectron) {
        // In Electron: open a real transparent pop-out window
        electronIPC.send('open-popout', { width: 450, height: 700 });
      } else {
        // Browser PiP requires Document Picture-in-Picture. Pre-check here so
        // we surface the message in-app (chat) rather than via a native
        // alert() from PiPWindow — alerts paint outside content protection
        // and leak on screen share.
        if (!('documentPictureInPicture' in window)) {
          const unsupportedMsg: Message = {
            id: Date.now().toString(),
            role: 'model',
            content: 'Pop-out Mode requires Chrome 111+ or Edge with Document Picture-in-Picture support. Please update your browser or use the desktop app.',
            timestamp: Date.now()
          };
          if (db.isElectron) { db.addMessage(unsupportedMsg); } else { setMessages(prev => [...prev, unsupportedMsg]); }
          return;
        }
        setIsPipMode(true);
      }
    },
    isElectron,
    onNewSession: db.isElectron ? () => db.newSession() : null,
    userProfile,
    userLicense,
    onLogout,
    onOpenManageSub: () => setManageSubOpen(true),
    gate,
    // In popout, the local useCreditTimer is a no-op (see isListening override
    // at useCreditTimer call site). Main owns the authoritative timer and
    // pushes ticks via credit-sync. Expose those values under the same shape
    // so the header chip works transparently in both windows.
    creditTimer: (isElectron && isPopoutMode) ? {
      hourBoundary: remoteCreditHourBoundary,
      lowWarning: remoteCreditLowWarning,
      exhausted: remoteCreditExhausted,
      remaining: remoteCreditRemaining,
      source: remoteCreditSource,
      acknowledgeHourBoundary: creditTimer.acknowledgeHourBoundary,
      dismissLowWarning: creditTimer.dismissLowWarning,
      dismissExhausted: creditTimer.dismissExhausted,
    } : creditTimer,
    // Effective tier for the header chip. In popout we trust the value main
    // pushed via credit-sync (remoteCreditActualTier) because the popout's
    // own userLicense may be stale until its first revalidation.
    effectiveTier: (isElectron && isPopoutMode) ? remoteCreditActualTier : (userLicense?.tier ?? 'free'),
    // Popout calls this right before IPC-ing main, so the state-sync listener
    // knows to ignore stale inbound `selectedModel` values until main echoes
    // the chosen one. See pendingPopoutModelRef for the full rationale.
    markPendingPopoutModel: (model: string) => { pendingPopoutModelRef.current = model; },
  };

  // Sync is now handled by useDatabase hook (Electron) — no localStorage sync needed

  // ── RENDER ──
  const isPopoutElectron = isElectron && isPopoutMode;

  return (
    <div
      className={`h-[100dvh] flex font-sans overflow-hidden transition-colors duration-300 ${
        isPopoutElectron ? '' : settings.theme === 'dark' ? 'dark bg-[#09090b]' : 'bg-slate-50'
      }`}
      style={isPopoutElectron ? { background: 'transparent' } : undefined}
    >
        {/* Conversation sidebar — main Electron window only (hidden in pop-out and PiP) */}
        {!isPopoutElectron && !isPipMode && sidebarOpen && (
          <ConversationSidebar db={db} onClose={() => setSidebarOpen(false)} />
        )}

        {/* Floating toggle when sidebar is closed (main window only) */}
        {!isPopoutElectron && !isPipMode && !sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="fixed top-3 left-3 z-40 w-9 h-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] flex items-center justify-center text-gray-400 hover:text-white transition-all backdrop-blur-sm"
            aria-label="Open conversations"
          >
            <Menu size={16} />
          </button>
        )}

        <div className="flex-1 flex flex-col relative min-w-0">
        {/* Restored-conversations toast (shown once after upgrade/first-login) */}
        {!isPopoutElectron && db.restoredCount > 0 && (
          <div className="fixed top-4 right-4 z-[9999] max-w-sm animate-in fade-in slide-in-from-top-2">
            <div className="flex items-start gap-3 bg-emerald-500/10 border border-emerald-500/30 backdrop-blur-sm rounded-lg px-4 py-3 shadow-lg">
              <div className="flex-1 text-sm">
                <div className="font-semibold text-emerald-300">
                  Restored {db.restoredCount} conversation{db.restoredCount === 1 ? '' : 's'}
                </div>
                <div className="text-xs text-emerald-200/80 mt-0.5">
                  Your history from before this update is now linked to your account.
                </div>
              </div>
              <button
                onClick={db.dismissRestoredToast}
                className="text-emerald-300/80 hover:text-emerald-100 text-lg leading-none"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* ── Update ready banner ── */}
        {!isPopoutElectron && isElectron && updateStatus.status === 'ready' && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/30 backdrop-blur-sm rounded-lg px-4 py-2.5 shadow-lg">
              <Download size={14} className="text-blue-400 shrink-0" />
              <span className="text-sm text-blue-300">v{updateStatus.version} is ready</span>
              <button
                onClick={() => electronIPC.send('install-update')}
                className="px-3 py-1 rounded-md text-xs font-bold bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                Restart & Update
              </button>
              <button
                onClick={() => setUpdateStatus({ status: 'idle' })}
                className="text-blue-300/60 hover:text-blue-100 text-lg leading-none ml-1"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* ── CONTENT AREA ── */}
        {isPopoutElectron ? (
            /* Electron pop-out: always show compact chat + custom
               resize handles (top/bottom/corners only — sides are
               deliberately omitted so the OS resize cursor never
               flashes when the user moves their mouse from the
               popout to a code editor during a screen-share). */
            <>
              <ChatInterface {...sharedProps} />
              <PopoutResizeHandles />
            </>
        ) : !isPipMode ? (
            /* Main window: full app */
            <ChatInterface {...sharedProps} />
        ) : (
            /* Main window when pop-out is active: safe placeholder */
            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-surface/50 text-center space-y-6 animate-in fade-in">
                <div className="w-24 h-24 rounded-full bg-blue-500/10 flex items-center justify-center animate-pulse-slow">
                    <ExternalLink size={40} className="text-blue-500" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold text-text mb-2">Copilot Active in Pop-out Window</h2>
                    <p className="text-gray-500 max-w-md mx-auto">
                        {isElectron 
                          ? <>The AI copilot is running in a transparent overlay.<br/>It is <strong className="text-green-400">invisible to screen share</strong>.</>
                          : <>This tab is now "Safe to Share".<br/>The AI interface has moved to a separate window that is hidden from screen share.</>
                        }
                    </p>
                </div>
                <div className="p-4 bg-surface rounded-lg border border-border text-left w-full max-w-lg shadow-sm">
                    <p className="text-xs text-gray-400 uppercase tracking-wider font-bold mb-2">Safe View Placeholder</p>
                    <div className="space-y-2 opacity-50">
                         <div className="h-4 bg-gray-500 rounded w-3/4"></div>
                         <div className="h-4 bg-gray-500 rounded w-1/2"></div>
                         <div className="h-4 bg-gray-500 rounded w-5/6"></div>
                    </div>
                </div>
                <button 
                    onClick={() => {
                      if (isElectron) {
                        electronIPC.send('close-popout');
                      }
                      setIsPipMode(false);
                    }}
                    className="px-6 py-3 bg-primary hover:bg-blue-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
                >
                    <ExternalLink size={18} className="rotate-180" /> Bring Back to Tab
                </button>
            </div>
        )}

        {/* PiP Portal — only used in web browser, NOT in Electron */}
        {isPipMode && !isElectron && (
            <PiPWindow onClose={() => setIsPipMode(false)}>
                <ChatInterface {...sharedProps} />
            </PiPWindow>
        )}
        </div>

      {/* --- MODALS --- */}
      
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="Settings">
         <div className="space-y-6">
            
            {/* Model Selection */}
            <div className="bg-surface/50 border border-border p-3 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                    <label className="text-sm font-bold text-text flex items-center gap-2">
                        <Cpu size={16} /> AI Model Selection
                    </label>
                    {/* Max users get no upgrade-nag label — they have everything.
                        Pro users get a soft suggestion. Free/Basic get the upgrade prompt. */}
                    {gate.isMax ? null : gate.isPro ? (
                      <span className="text-[10px] text-green-400 font-medium bg-green-400/10 px-2 py-0.5 rounded-full border border-green-400/20">
                        For better experience choose GPT-5.5
                      </span>
                    ) : (
                      <span className="text-[10px] text-amber-400 font-medium bg-amber-400/10 px-2 py-0.5 rounded-full border border-amber-400/20 flex items-center gap-1">
                        <Crown size={8} /> Upgrade to Pro for all models
                      </span>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => setTempModel('gemini')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all hover:shadow-md flex items-center gap-2 ${
                            tempModel === 'gemini' 
                            ? 'bg-blue-500/10 border-blue-500 shadow-sm' 
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'gemini' ? 'bg-blue-500' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'gemini' ? 'text-blue-500' : 'text-text'}`}>
                            Gemini 3.1 Flash
                        </span>
                    </button>

                    <button
                        onClick={() => gate.canUseModel('groq') && setTempModel('groq')}
                        disabled={!gate.canUseModel('groq')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all flex items-center gap-2 ${
                            !gate.canUseModel('groq')
                            ? 'bg-background border-border opacity-40 cursor-not-allowed'
                            : tempModel === 'groq'
                            ? 'bg-orange-500/10 border-orange-500 shadow-sm'
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100 hover:shadow-md'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'groq' ? 'bg-orange-500' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'groq' ? 'text-orange-500' : 'text-text'}`}>
                            Groq
                        </span>
                        {!gate.canUseModel('groq') && <span className="ml-1 text-[9px] font-bold tracking-wider bg-amber-400/10 text-amber-400 px-1.5 py-0.5 rounded border border-amber-400/30">PRO</span>}
                    </button>

                    <button
                        onClick={() => gate.canUseModel('openai') && setTempModel('openai')}
                        disabled={!gate.canUseModel('openai')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all flex items-center gap-2 ${
                            !gate.canUseModel('openai')
                            ? 'bg-background border-border opacity-40 cursor-not-allowed'
                            : tempModel === 'openai'
                            ? 'bg-green-500/10 border-green-500 shadow-sm'
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100 hover:shadow-md'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'openai' ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'openai' ? 'text-green-500' : 'text-text'}`}>
                            GPT-5.5 {gate.canUseModel('openai') && <span className="ml-1 text-[9px] bg-green-500 text-white px-1.5 py-0.5 rounded-full">Recommended</span>}
                        </span>
                        {!gate.canUseModel('openai') && <span className="ml-1 text-[9px] font-bold tracking-wider bg-amber-400/10 text-amber-400 px-1.5 py-0.5 rounded border border-amber-400/30">PRO</span>}
                    </button>

                    <button
                        onClick={() => gate.canUseModel('xai') && setTempModel('xai')}
                        disabled={!gate.canUseModel('xai')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all flex items-center gap-2 ${
                            !gate.canUseModel('xai')
                            ? 'bg-background border-border opacity-40 cursor-not-allowed'
                            : tempModel === 'xai'
                            ? 'bg-gray-500/10 border-gray-500 shadow-sm'
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100 hover:shadow-md'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'xai' ? 'bg-white' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'xai' ? 'text-text' : 'text-text'}`}>
                            Grok (xAI)
                        </span>
                        {!gate.canUseModel('xai') && <span className="ml-1 text-[9px] font-bold tracking-wider bg-amber-400/10 text-amber-400 px-1.5 py-0.5 rounded border border-amber-400/30">PRO</span>}
                    </button>

                    <button
                        onClick={() => gate.canUseModel('claude') && setTempModel('claude')}
                        disabled={!gate.canUseModel('claude')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all flex items-center gap-2 ${
                            !gate.canUseModel('claude')
                            ? 'bg-background border-border opacity-40 cursor-not-allowed'
                            : tempModel === 'claude'
                            ? 'bg-purple-500/10 border-purple-500 shadow-sm'
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100 hover:shadow-md'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'claude' ? 'bg-purple-500' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'claude' ? 'text-purple-500' : 'text-text'}`}>
                            Claude Sonnet 4.6 {gate.canUseModel('claude') && <span className="ml-1 text-[9px] bg-purple-500 text-white px-1.5 py-0.5 rounded-full">Web Search</span>}
                        </span>
                        {!gate.canUseModel('claude') && <span className="ml-1 text-[9px] font-bold tracking-wider bg-amber-400/10 text-amber-400 px-1.5 py-0.5 rounded border border-amber-400/30">PRO</span>}
                    </button>
                </div>
            </div>

            <button
                onClick={saveSettings}
                className={`w-full px-4 py-2 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-all ${
                    saveStatus === 'saved'
                    ? 'bg-green-500 text-white'
                    : 'bg-primary text-white hover:bg-blue-600'
                }`}
            >
                {saveStatus === 'saved' ? <Check size={16} /> : <Save size={16} />}
                {saveStatus === 'saved' ? 'Settings Saved' : 'Save Settings'}
            </button>

            <div className="border-t border-border pt-4 space-y-4">
                {/* Theme Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text">App Theme</span>
                    <div className="flex items-center bg-background border border-border rounded-lg p-1">
                        <button 
                            onClick={() => setSettings(s => ({...s, theme: 'light'}))}
                            className={`p-2 rounded-md transition-all ${settings.theme === 'light' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-200'}`}
                        >
                            <Sun size={16} />
                        </button>
                        <button 
                            onClick={() => setSettings(s => ({...s, theme: 'dark'}))}
                            className={`p-2 rounded-md transition-all ${settings.theme === 'dark' ? 'bg-gray-700 shadow text-white' : 'text-gray-400 hover:text-gray-600'}`}
                        >
                            <Moon size={16} />
                        </button>
                    </div>
                </div>

                {/* Font Size Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text">Text Size</span>
                    <div className="flex items-center gap-2">
                        {(['small', 'medium', 'large'] as const).map((size) => (
                            <button
                                key={size}
                                onClick={() => setSettings(s => ({...s, fontSize: size}))}
                                className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-all ${
                                    settings.fontSize === size 
                                    ? 'bg-primary text-white border-primary' 
                                    : 'bg-transparent text-gray-500 border-border hover:border-gray-400'
                                }`}
                            >
                                {size.charAt(0).toUpperCase() + size.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── App Updates (Electron only) ── */}
            {isElectron && (
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-text">App Updates</span>
                    <p className="text-xs text-gray-500 mt-0.5">v{APP_VERSION}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {updateStatus.status === 'idle' || updateStatus.status === 'up-to-date' || updateStatus.status === 'error' ? (
                      <button
                        onClick={() => electronIPC.send('check-for-updates')}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border border-border hover:border-primary text-gray-400 hover:text-primary transition-all flex items-center gap-1.5"
                      >
                        <RefreshCw size={12} /> Check for Updates
                      </button>
                    ) : updateStatus.status === 'checking' ? (
                      <span className="text-xs text-gray-500 flex items-center gap-1.5">
                        <RefreshCw size={12} className="animate-spin" /> Checking...
                      </span>
                    ) : updateStatus.status === 'available' ? (
                      <span className="text-xs text-blue-400 flex items-center gap-1.5">
                        <Download size={12} /> v{updateStatus.version} downloading...
                      </span>
                    ) : updateStatus.status === 'downloading' ? (
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${updateStatus.percent || 0}%` }} />
                        </div>
                        <span className="text-xs text-blue-400">{updateStatus.percent}%</span>
                      </div>
                    ) : updateStatus.status === 'ready' ? (
                      <button
                        onClick={() => electronIPC.send('install-update')}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-500/20 border border-green-500/40 text-green-400 hover:bg-green-500/30 transition-all flex items-center gap-1.5"
                      >
                        <Download size={12} /> Restart & Update to v{updateStatus.version}
                      </button>
                    ) : null}
                  </div>
                </div>
                {updateStatus.status === 'up-to-date' && !serverVersionInfo?.isOutdated && (
                  <p className="text-xs text-green-400/70 mt-1.5 flex items-center gap-1"><Check size={10} /> You're on the latest version</p>
                )}
                {/* Fallback: Show server-detected update when Electron updater fails or says up-to-date but server disagrees */}
                {(updateStatus.status === 'error' || updateStatus.status === 'up-to-date' || updateStatus.status === 'idle') && serverVersionInfo?.isOutdated && (
                  <div className="mt-2 p-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                    <p className="text-xs text-blue-300 mb-2">
                      <span className="font-medium">v{serverVersionInfo.latest}</span> is available! {serverVersionInfo.releaseNotes}
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      {serverVersionInfo.downloadUrl?.windows && (
                        <a href={serverVersionInfo.downloadUrl.windows} target="_blank" rel="noopener noreferrer"
                          className="px-2.5 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors">
                          Windows
                        </a>
                      )}
                      {serverVersionInfo.downloadUrl?.mac && (
                        <a href={serverVersionInfo.downloadUrl.mac} target="_blank" rel="noopener noreferrer"
                          className="px-2.5 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors">
                          macOS
                        </a>
                      )}
                      {serverVersionInfo.downloadUrl?.linux && (
                        <a href={serverVersionInfo.downloadUrl.linux} target="_blank" rel="noopener noreferrer"
                          className="px-2.5 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors">
                          Linux
                        </a>
                      )}
                    </div>
                  </div>
                )}
                {updateStatus.status === 'error' && !serverVersionInfo?.isOutdated && (
                  <p className="text-xs text-red-400/70 mt-1.5">Update check failed. Try again later.</p>
                )}
              </div>
            )}

         </div>
      </Modal>

      {/* --- First-launch Tutorial (auto on first login per account, replayable from Help) --- */}
      <Tutorial isOpen={tutorialOpen} onClose={handleTutorialClose} />

      {/* --- Manage Subscription full-screen overlay (opened from tier badge) --- */}
      <ManageSubscription
          isOpen={manageSubOpen}
          onClose={() => setManageSubOpen(false)}
          userProfile={userProfile}
          userLicense={userLicense}
          onUpgradeRequested={handleSubscriptionUpgrade}
      />

      {/* --- Update-on-close prompt — replaces native dialog.showMessageBox so it doesn't leak on screen-share ---
          Backdrop click + Esc + X button all dismiss as "stay in tray" — no
          modal trap. Install requires explicit click on the install button. */}
      <Modal
          isOpen={updatePromptOpen}
          onClose={() => { setUpdatePromptOpen(false); electronIPC.send('update-prompt-decision', { decision: 'dismiss' }); }}
          title="Update ready"
      >
          <div className="space-y-4">
              <p className="text-sm text-text">
                  minicaai {updatePromptVersion ? <span className="font-bold">{updatePromptVersion}</span> : 'a new version'} is ready to install.
              </p>
              <p className="text-xs text-gray-400 leading-relaxed">
                  Install now to upgrade — the app will quit and relaunch on the new version. Or stay in the tray and install later.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                  <button
                      onClick={() => { setUpdatePromptOpen(false); electronIPC.send('update-prompt-decision', { decision: 'dismiss' }); }}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-500/10 text-gray-300 hover:bg-gray-500/20 transition-colors"
                  >
                      Stay in tray
                  </button>
                  <button
                      onClick={() => { setUpdatePromptOpen(false); electronIPC.send('update-prompt-decision', { decision: 'install' }); }}
                      className="px-4 py-2 rounded-lg text-sm font-bold bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-lg shadow-blue-500/30 hover:shadow-blue-400/50 transition-all"
                  >
                      Install update & quit
                  </button>
              </div>
          </div>
      </Modal>

      {/* --- Tray-hidden toast — shown ONCE per account, the first time the user closes the main window --- */}
      {trayToastOpen && (
          <div
              className="fixed bottom-6 right-6 z-[100000] max-w-sm rounded-xl border border-blue-500/30 bg-gradient-to-br from-slate-900 to-slate-800 shadow-2xl shadow-blue-500/10 p-4 animate-in slide-in-from-bottom"
              role="status"
              aria-live="polite"
          >
              <div className="flex items-start gap-3">
                  <div className="shrink-0 w-9 h-9 rounded-lg bg-blue-500/20 flex items-center justify-center">
                      <Info size={18} className="text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-bold text-text mb-1">App moved to system tray</h4>
                      <p className="text-xs text-gray-400 leading-relaxed">
                          minicaai is still running in the background. Right-click the small slot near your clock (bottom-right) to bring it back or quit.
                      </p>
                      <p className="text-[10px] text-blue-300/80 mt-2">
                          To hide it during screen-share, click the up-arrow <span className="font-mono bg-gray-700/50 px-1 rounded">^</span> in your taskbar and drag the slot into the overflow popup. <button onClick={() => { setTrayToastOpen(false); handleReplayTutorial(); }} className="underline hover:text-blue-200 transition-colors">See tutorial</button>.
                      </p>
                  </div>
                  <button
                      onClick={() => setTrayToastOpen(false)}
                      className="shrink-0 text-gray-500 hover:text-white p-1 rounded transition-colors"
                      aria-label="Dismiss"
                  >
                      <X size={14} />
                  </button>
              </div>
          </div>
      )}

      {/* --- Re-train confirmation modal (admin Beast mode) ---
          Replaces window.confirm() which would leak on screen-share. */}
      <Modal
          isOpen={retrainConfirmOpen}
          onClose={() => setRetrainConfirmOpen(false)}
          title="Re-train Claude (Beast)"
      >
          <div className="space-y-4">
              <p className="text-sm leading-relaxed text-text">
                  This re-runs deep individual web research on up to 25 technologies plus a synthesis pass that builds interview-leverage framing.
              </p>
              <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 space-y-1">
                  <p className="text-xs font-bold text-orange-300">Estimated cost: ~$3-6 in API tokens</p>
                  <p className="text-xs text-orange-200/80">Time: ~3-5 minutes</p>
              </div>
              <p className="text-xs text-gray-400">
                  Your previous training is still cached and valid for 24h — only re-train if your resume/JD changed or you want fresher research.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                  <button
                      onClick={() => setRetrainConfirmOpen(false)}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-500/10 text-gray-300 hover:bg-gray-500/20 transition-colors"
                  >
                      Cancel
                  </button>
                  <button
                      onClick={() => { setRetrainConfirmOpen(false); runTrainingNow(); }}
                      className="px-4 py-2 rounded-lg text-sm font-bold bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-lg shadow-orange-500/30 hover:shadow-orange-400/50 transition-all"
                  >
                      Re-train
                  </button>
              </div>
          </div>
      </Modal>

      {/* --- Context Files Modal --- */}
      <Modal isOpen={showContext} onClose={() => setShowContext(false)} title="Knowledge Base">
        <div className="space-y-6">
           {/* Info Banner */}
           <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
               <div className="flex items-start gap-3">
                   <Info size={18} className="text-blue-500 mt-0.5" />
                   <div className="text-xs text-blue-200/80 leading-relaxed">
                       <strong className="text-blue-400 block mb-1">How Context Works</strong>
                       Files uploaded here are sent to the AI with every message.
                       Use "Context Mode" to force the AI to rely on these files.
                   </div>
               </div>
           </div>

           {/* ── Train Model — Max-tier only ──
               Pre-researches every tech in resume + JD via parallel web_search,
               caches it for 24h, and injects into Claude's system prompt. Runtime
               version/pricing/comparison questions then answer in 2-3s instead
               of triggering 12-25s live searches mid-interview. */}
           {gate.canUseModel('claude') && (
               <div className="relative overflow-hidden rounded-xl border border-orange-500/25 bg-gradient-to-br from-orange-950/50 via-orange-900/25 to-amber-900/20 p-4">
                   {/* Top-edge accent glow */}
                   <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-orange-400/50 to-transparent" />

                   <div className="flex items-start justify-between gap-4 mb-3">
                       <div className="flex-1 min-w-0">
                           <div className="flex items-center gap-2 mb-1">
                               <Crown size={14} className="text-orange-400" />
                               <h3 className="text-sm font-bold text-orange-100">
                                   {isAdmin ? 'Train Claude (Beast)' : 'Train Claude'}
                               </h3>
                               {isAdmin && (
                                   <span className="text-[9px] font-bold tracking-wider bg-purple-500/25 text-purple-300 px-1.5 py-0.5 rounded border border-purple-400/40">
                                       ADMIN
                                   </span>
                               )}
                               {hasTrainedCache && !isTraining && (
                                   <span className="text-[9px] font-bold tracking-wider bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">
                                       READY
                                   </span>
                               )}
                           </div>
                           <p className="text-[10px] text-orange-200/60 leading-relaxed">
                               {isAdmin ? (
                                   <>
                                       Beast mode — deep individual web research on up to 25 techs + synthesis pass building interview-leverage framing. <span className="text-orange-300/80">~$3-6 · ~3-5min · re-train any time</span>
                                   </>
                               ) : (
                                   <>
                                       Pre-researches every tech in your resume + JD on the live web. Interview answers come back in 2–3s instead of waiting on a mid-question search. <span className="text-orange-300/80">~$0.30 · ~60s · one train per 24h</span>
                                   </>
                               )}
                           </p>
                       </div>
                       {/* Non-admin: button hidden once trained (24h lockout enforced).
                           Admin: button always visible, re-train confirm dialog handles intent. */}
                       {(isAdmin || !hasTrainedCache) && (
                           <button
                               onClick={handleTrainModel}
                               disabled={isTraining || db.contextFiles.length === 0}
                               className="shrink-0 px-4 py-2 rounded-lg text-xs font-bold whitespace-nowrap bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-lg shadow-orange-500/30 hover:shadow-orange-400/50 hover:from-orange-400 hover:to-orange-500 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-all"
                           >
                               {isTraining
                                   ? `Training… ${trainingProgress?.pct ?? 0}%`
                                   : hasTrainedCache
                                       ? 'Re-train'
                                       : (isAdmin ? 'Train (Beast)' : 'Train Model')}
                           </button>
                       )}
                       {/* Non-admin trained state: replace button with locked status pill */}
                       {!isAdmin && hasTrainedCache && !isTraining && (
                           <div className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                               Trained · 24h
                           </div>
                       )}
                   </div>

                   {/* Progress bar — visible during training and a beat after */}
                   {trainingProgress && (
                       <div className="space-y-1.5">
                           <div className="h-1.5 rounded-full bg-orange-950/60 overflow-hidden">
                               <div
                                   className={`h-full transition-all duration-300 ease-out ${
                                       trainingProgress.stage === 'error'
                                           ? 'bg-red-500'
                                           : trainingProgress.stage === 'done'
                                               ? 'bg-gradient-to-r from-emerald-400 to-orange-400 shadow-[0_0_12px_rgba(251,146,60,0.7)]'
                                               : 'bg-gradient-to-r from-orange-400 via-orange-500 to-amber-400'
                                   }`}
                                   style={{ width: `${trainingProgress.pct}%` }}
                               />
                           </div>
                           <p className={`text-[10px] truncate ${
                               trainingProgress.stage === 'error' ? 'text-red-400/80' :
                               trainingProgress.stage === 'done' ? 'text-emerald-400/90 font-semibold' :
                               'text-orange-300/80'
                           }`}>
                               {trainingProgress.message}
                           </p>
                       </div>
                   )}

                   {db.contextFiles.length === 0 && !isTraining && !trainingProgress && (
                       <p className="text-[10px] text-orange-300/50 italic">
                           Add a resume + JD below to enable training.
                       </p>
                   )}
               </div>
           )}

           {/* File List */}
           <div className="space-y-3">
               <div className="flex items-center justify-between">
                   <h3 className="text-sm font-bold text-text">
                     Attached Files ({db.contextFiles.length}{gate.maxContextFiles !== -1 ? `/${gate.maxContextFiles}` : ''})
                   </h3>
                   {(() => {
                     const limitHit = gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles;
                     // Disable while listening: the OS file picker isn't
                     // covered by setContentProtection and would leak on
                     // screen-share. Stop the mic, upload, then resume.
                     const blockedForSession = _rawIsListening;
                     const disabled = limitHit || blockedForSession;
                     const label = blockedForSession ? 'Paused (live)' : limitHit ? 'Limit reached' : 'Add File';
                     const title = blockedForSession ? 'File picker is paused during a live interview to keep filenames off your screen-share. Stop the mic to add files.' : undefined;
                     return (
                       <button onClick={triggerFileUpload} disabled={disabled} title={title} className={`text-xs flex items-center gap-1 ${disabled ? 'text-gray-500 cursor-not-allowed' : 'text-primary hover:underline'}`}>
                         <Plus size={12} /> {label}
                       </button>
                     );
                   })()}
                   {/* HIDDEN INPUT */}
                   <input
                       type="file"
                       ref={fileInputRef}
                       className="hidden"
                       onChange={handleFileUpload}
                       accept=".pdf,.docx,.txt,.md,.json,.js,.ts,.py,.html,.css,.csv,.png,.jpg,.jpeg"
                       multiple={gate.maxContextFiles === -1}
                   />
               </div>
               
               <div className="space-y-2 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
                   {db.contextFiles.length === 0 && (
                       <div className="text-center py-6 border border-dashed border-border rounded-xl text-gray-500">
                           <FilePlus size={24} className="mx-auto mb-2 opacity-50" />
                           <p className="text-xs">No files added.</p>
                       </div>
                   )}
                   {db.contextFiles.map(file => (
                       <div key={file.id} className="flex items-center justify-between p-2.5 bg-background border border-border rounded-lg group hover:border-primary/30 transition-colors">
                           <div className="flex items-center gap-3 overflow-hidden">
                               <div className="w-8 h-8 rounded bg-gray-500/10 flex items-center justify-center shrink-0">
                                   <FileText size={14} className="text-gray-400" />
                               </div>
                               <div className="min-w-0">
                                   <p className="text-xs font-medium text-text truncate max-w-[180px]">{file.name}</p>
                                   <p className="text-[10px] text-gray-500 uppercase">{file.type}</p>
                               </div>
                           </div>
                           <button onClick={() => removeFile(file.id)} className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors opacity-0 group-hover:opacity-100">
                               <Trash2 size={14} />
                           </button>
                       </div>
                   ))}
               </div>
           </div>

           {/* Paste Text Section */}
           <div className="space-y-3 pt-4 border-t border-border">
               <h3 className="text-sm font-bold text-text">Quick Paste</h3>
               <div className="relative">
                   <textarea
                        value={pasteContent}
                        onChange={(e) => setPasteContent(e.target.value)}
                        placeholder="Paste Resume text, Job Description, or Notes here..."
                        className="w-full h-32 bg-background border border-border rounded-xl p-3 text-xs focus:ring-1 focus:ring-primary outline-none resize-none custom-scrollbar"
                   />
                   <div className="absolute bottom-2 right-2">
                       <button
                            onClick={handleAddPasteText}
                            disabled={!pasteContent.trim() || (gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles)}
                            className={`p-2 rounded-lg transition-all ${pasteContent.trim() && !(gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles) ? 'bg-primary text-white shadow-lg hover:bg-blue-600' : 'bg-surface text-gray-500 cursor-not-allowed border border-border'}`}
                            aria-label="Add as Context"
                       >
                           <Plus size={16} />
                       </button>
                   </div>
               </div>
           </div>

           {/* General Mode Toggle within Context */}
           <div className="flex items-center justify-between pt-2">
               <div className="flex flex-col">
                   <span className="text-sm font-medium text-text">General Knowledge Mode</span>
                   <span className="text-[10px] text-gray-500">
                       {settings.generalMode ? "AI uses broad knowledge (Wikipedia-style)." : "AI relies strictly on your files."}
                   </span>
               </div>
               <button 
                   onClick={toggleGeneralMode}
                   className={`text-2xl transition-colors ${settings.generalMode ? 'text-green-500' : 'text-gray-500'}`}
               >
                   {settings.generalMode ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
               </button>
           </div>
        </div>
      </Modal>

      {/* --- Help Modal --- */}
      <Modal isOpen={showHelp} onClose={() => setShowHelp(false)} title="Audio Setup Help">
          <div className="space-y-4 text-sm text-text">
              <div className="p-4 bg-surface border border-border rounded-xl space-y-3">
                  <h3 className="font-bold flex items-center gap-2"><Mic size={16} className="text-red-500" /> How to Capture Audio</h3>
                  <ol className="list-decimal list-inside space-y-2 text-gray-400 ml-1">
                      <li>Click the <span className="text-text font-bold">MIC (OFF)</span> button in the bottom bar.</li>
                      <li>A browser popup will ask to share your screen.</li>
                      <li>Select the <span className="text-text font-bold">Chrome Tab</span> where your meeting is running (e.g., Google Meet, Zoom Web).</li>
                      <li><span className="text-red-400 font-bold underline decoration-wavy">CRITICAL:</span> Check the box <strong>"Also share tab audio"</strong> in the bottom left of the popup.</li>
                      <li>Click <strong>Share</strong>. The status will turn to <span className="text-red-500 font-bold">LIVE</span>.</li>
                  </ol>
              </div>
              <div className="p-4 bg-surface border border-border rounded-xl space-y-2">
                  <h3 className="font-bold flex items-center gap-2"><ExternalLink size={16} className="text-blue-500" /> Pop-out Mode</h3>
                  <p className="text-gray-400 leading-relaxed">
                      If you are sharing your <strong>Entire Screen</strong>, the interviewer will see this AI overlay.
                      To hide it, click the <span className="text-blue-500 font-bold">Pop-out Icon</span> in the top right.
                      This moves the AI to a separate window that is <em>not</em> visible in screen share.
                  </p>
              </div>
              {/* Replay tutorial — opens the same first-launch walkthrough. */}
              <button
                  onClick={() => { setShowHelp(false); handleReplayTutorial(); }}
                  className="w-full p-3 rounded-xl border border-border bg-gradient-to-r from-blue-500/10 to-purple-500/10 hover:from-blue-500/15 hover:to-purple-500/15 text-text font-semibold flex items-center justify-center gap-2 transition-all"
              >
                  <Sparkles size={16} className="text-blue-400" />
                  Replay first-time tutorial
              </button>
          </div>
      </Modal>

      {/* Download modal — web only, never shown in Electron */}
      {!isElectron && (
        <Modal isOpen={showDownloadModal} onClose={() => setShowDownloadModal(false)} title="Download Interview Copilot">
            <div className="space-y-6 text-center">
                <div className="w-16 h-16 bg-gradient-to-br from-blue-500/20 to-purple-600/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-blue-500/30">
                    <Download size={32} className="text-blue-500" />
                </div>
                <h3 className="text-xl font-bold text-text">Experience Stealth Mode</h3>
                <p className="text-sm text-gray-400 max-w-sm mx-auto leading-relaxed">
                    The desktop app runs natively on your system and is <strong className="text-white">completely invisible to screen sharing apps</strong> like Zoom, Google Meet, and MS Teams.
                </p>

                <div className="grid grid-cols-1 gap-3 pt-4">
                    <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Setup.exe" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-blue-500 hover:bg-blue-500/5 transition-all group">
                        <div className="flex items-center gap-4">
                            <div className="p-2 bg-blue-500/10 rounded-lg group-hover:bg-blue-500/20 transition-colors">
                                <Monitor size={24} className="text-blue-400 group-hover:text-blue-500" />
                            </div>
                            <div className="text-left">
                                <div className="font-bold text-text group-hover:text-blue-400 transition-colors">Download for Windows</div>
                                <div className="text-xs text-gray-500">Windows 10/11 (.exe)</div>
                            </div>
                        </div>
                        <Download size={18} className="text-gray-500 group-hover:text-blue-500 transition-colors" />
                    </a>

                    <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Mac.dmg" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-purple-500 hover:bg-purple-500/5 transition-all group">
                        <div className="flex items-center gap-4">
                            <div className="p-2 bg-purple-500/10 rounded-lg group-hover:bg-purple-500/20 transition-colors">
                                <Laptop size={24} className="text-purple-400 group-hover:text-purple-500" />
                            </div>
                            <div className="text-left">
                                <div className="font-bold text-text group-hover:text-purple-400 transition-colors">Download for Mac</div>
                                <div className="text-xs text-gray-500">macOS 10.15+ (.dmg)</div>
                            </div>
                        </div>
                        <Download size={18} className="text-gray-500 group-hover:text-purple-500 transition-colors" />
                    </a>

                    <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Linux.AppImage" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-orange-500 hover:bg-orange-500/5 transition-all group">
                        <div className="flex items-center gap-4">
                            <div className="p-2 bg-orange-500/10 rounded-lg group-hover:bg-orange-500/20 transition-colors">
                                <Terminal size={24} className="text-orange-400 group-hover:text-orange-500" />
                            </div>
                            <div className="text-left">
                                <div className="font-bold text-text group-hover:text-orange-400 transition-colors">Download for Linux</div>
                                <div className="text-xs text-gray-500">Any distro (.AppImage)</div>
                            </div>
                        </div>
                        <Download size={18} className="text-gray-500 group-hover:text-orange-500 transition-colors" />
                    </a>
                </div>
            </div>
        </Modal>
      )}

      {/* ── Credit-timer modals/toasts ── */}
      {/* Main-window path: local creditTimer is authoritative. */}
      {!isPopoutElectron && creditTimer.hourBoundary && (
        <HourBoundaryModal
          remainingSeconds={creditTimer.remaining}
          onDecision={creditTimer.acknowledgeHourBoundary}
        />
      )}
      {!isPopoutElectron && creditTimer.lowWarning && (
        <LowWarningToast
          remainingSeconds={creditTimer.remaining}
          onDismiss={creditTimer.dismissLowWarning}
        />
      )}
      {!isPopoutElectron && creditTimer.exhausted && (
        <ExhaustedModal
          source={creditTimer.source}
          actualTier={gate.actualTier}
          countryCode={userProfile?.country_code || 'US'}
          onRenew={handleRenewCredit}
          onUpgrade={handleOpenUpgrade}
          onDismiss={creditTimer.dismissExhausted}
        />
      )}
      {/* Popout path: mirror main's state via IPC and relay user actions back. */}
      {/* Without this, main is typically backgrounded during a live interview so the user */}
      {/* would hit the hour boundary / exhausted state with no visible prompt anywhere. */}
      {isPopoutElectron && remoteCreditHourBoundary && (
        <HourBoundaryModal
          remainingSeconds={remoteCreditRemaining}
          onDecision={(d) => electronIPC.send('relay-to-main', { type: 'cmd-credit-boundary-ack', decision: d })}
        />
      )}
      {isPopoutElectron && remoteCreditLowWarning && (
        <LowWarningToast
          remainingSeconds={remoteCreditRemaining}
          onDismiss={() => electronIPC.send('relay-to-main', { type: 'cmd-credit-low-dismiss' })}
        />
      )}
      {isPopoutElectron && remoteCreditExhausted && (
        <ExhaustedModal
          source={remoteCreditSource}
          actualTier={remoteCreditActualTier}
          countryCode={remoteCreditCountryCode}
          onRenew={() => electronIPC.send('relay-to-main', { type: 'cmd-credit-renew' })}
          onUpgrade={() => electronIPC.send('relay-to-main', { type: 'cmd-credit-upgrade' })}
          onDismiss={() => electronIPC.send('relay-to-main', { type: 'cmd-credit-exhausted-dismiss' })}
        />
      )}

    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  APP WRAPPER — Subscription gate + feature enforcement
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [license, setLicense] = useState<LicenseData | null>(null);
  // Guards the focus-revalidation handler from firing concurrently. Fast
  // alt-tab in/out (common when paying in an external browser window and
  // bouncing back) otherwise queues multiple validateWithServer calls; if
  // they resolve out of order the earlier (stale) response can overwrite
  // the newer one and snap the user's tier back to its pre-upgrade value.
  const focusRevalidatingRef = useRef(false);

  useEffect(() => {
    const saved = licenseService.loadAuth();
    if (saved.user && saved.license && licenseService.isLicenseValid(saved.license)) {
      setUser(saved.user);
      setLicense(saved.license);
      setAuthenticated(true);
      licenseService.startRevalidation();
    }
  }, []);

  // Revalidate license when app regains focus (e.g. after paying in browser)
  useEffect(() => {
    const handleFocus = async () => {
      if (focusRevalidatingRef.current) return;
      const saved = licenseService.loadAuth();
      if (!saved.user || !saved.token) return;
      focusRevalidatingRef.current = true;
      try {
        const updated = await licenseService.validateWithServer();
        if (updated) {
          const refreshedUser = { ...saved.user, tier: updated.tier };
          setUser(refreshedUser);
          setLicense(updated);
          // Read the token AFTER validateWithServer — it may have rotated
          // the token and persisted a fresh one. Using saved.token (captured
          // before validation) would overwrite the fresh token with the stale
          // one and force expiry mid-interview. This was a real bug.
          const currentToken = licenseService.getToken() || saved.token;
          licenseService.saveAuth(refreshedUser, updated, currentToken);
          if (!authenticated && licenseService.isLicenseValid(updated)) {
            setAuthenticated(true);
          }
        }
      } finally {
        focusRevalidatingRef.current = false;
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [authenticated]);

  const handleLogout = () => {
    licenseService.logout();
    setAuthenticated(false);
    setUser(null);
    setLicense(null);
  };

  if (!authenticated) {
    return (
      <SubscriptionGate
        onAuthenticated={(u, l) => {
          setUser(u);
          setLicense(l);
          setAuthenticated(true);
          licenseService.startRevalidation();
        }}
      />
    );
  }

  // Web is not an official surface — authenticated web users see the download page
  // inside SubscriptionGate, not MainApp. The app itself is Electron-only.
  if (!isElectron && !isPopoutMode) {
    return (
      <SubscriptionGate
        onAuthenticated={(u, l) => {
          setUser(u);
          setLicense(l);
          setAuthenticated(true);
        }}
      />
    );
  }

  return <MainApp userProfile={user} userLicense={license} onLogout={handleLogout} />;
}