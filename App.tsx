import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Mic, MicOff, FileText, Upload, Trash2, Cpu, FileCheck, RefreshCw, HelpCircle, AlertTriangle, Zap, MessageSquare, Edit3, X, ChevronDown, Menu, ExternalLink, Moon, Sun, Copy, Check, Save, ToggleLeft, ToggleRight, Info, ScreenShare, ScreenShareOff, Plus, FilePlus, Download, Monitor, Laptop, Terminal, LogOut, Crown, Sparkles, Loader2, EyeOff, ScanSearch, Headphones, Keyboard, Gauge } from 'lucide-react';
// Minica support chat — mounted as a Help → Support modal inside MainApp so
// signed-in users can talk to the bot (or escalate to a human) without
// leaving the app. The component is shared with SubscriptionGate's
// landing-page floating bubble + full-screen view; here we use mode="panel"
// to fill the modal body and inherit the user's light/dark theme.
import SupportBot from './SupportBot';
import { WizardHat } from './WizardHat';
import { PaperAirplane } from './GitHubIcons';
import { GeminiIcon, OpenAIIcon, ClaudeIcon, GrokIcon, GroqIcon } from './ProviderIcons';
import { ErrorBoundary } from './ErrorBoundary';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { generateGemini, generateOpenAI, generateXAI, generateGroq, streamGemini, streamOpenAI, streamXAI, streamGroq, AUTO_SOLVE_PROMPT, prewarmIdentity, generateConversationTitle } from './services/aiProxyService';
import { generateClaude, streamClaude, prewarmClaudeIdentity, trainClaudeModel, trainClaudeModelBeast, hasCachedTechState, type TrainingProgress } from './services/claudeService';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { usePrefetchContext } from './hooks/usePrefetchContext';
import { extractTextFromPdf } from './services/pdfService';
import { extractTextFromDocx } from './services/docxService';
import { useDatabase, SessionSummary } from './hooks/useDatabase';
import { Message, AppSettings, ContextFile } from './types';
import { SubscriptionGate } from './SubscriptionGate';
import { Tutorial, shouldShowTutorial, markTutorialCompleted, clearTutorialCompletion } from './Tutorial';
import { ManageSubscription } from './ManageSubscription';
import { licenseService, UserProfile, LicenseData, TIME_CONSTANTS, fetchUsageSummary, UsageSummary } from './services/licenseService';
import { creditTimerService } from './services/creditTimerService';
import { pricingService, getExtensionPacks } from './services/pricingService';
import './pip-styles.css';

// --- Electron Helpers ---
// Electron detection now reads window.electronAPI (set by preload.cjs)
// instead of the old `process.versions.electron`, which isn't exposed
// when contextIsolation:true + nodeIntegration:false.
const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
// Electron popout is a second BrowserWindow with ?mode=popout. In a plain
// browser the web popout is Document-PiP, not a second tab — ignore/strip
// a stray ?mode=popout so authenticated web users land in normal MainApp.
const isPopoutMode = isElectron
  && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('mode') === 'popout';
if (!isElectron && typeof window !== 'undefined') {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'popout') {
      params.delete('mode');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    }
  } catch { /* ignore */ }
}

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
type AutoTypePhase = 'idle' | 'preparing' | 'thinking' | 'countdown' | 'typing' | 'done' | 'verify-mismatch';

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
    // Captured reasoning from the Sonnet agent's plan. Populated by the
    // 'plan-ready' phase event so the user can see WHY the agent chose
    // its plan. Surfaced as a tooltip on the auto-type button while the
    // cycle is running. Cleared at the start of each click.
    const agentReasoningRef = useRef<string>('');
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
            if (data.phase === 'thinking') {
                // Sonnet agent is running — chain-of-thought reasoning
                // takes 3-8s; show explicit feedback so the gap doesn't
                // feel like a hang. Stays in this phase until 'plan-ready'
                // (agent decided) or 'countdown' (planner skipped/failed).
                setAtPhase('thinking');
            } else if (data.phase === 'plan-ready') {
                // Agent finished. Stash the reasoning preview if provided
                // — it's surfaced in the button label so the user sees
                // what the model decided. We don't change phase here;
                // 'countdown' or 'typing' will land next.
                if (typeof data.reasoning === 'string' && data.reasoning.trim()) {
                    agentReasoningRef.current = data.reasoning.trim();
                }
            } else if (data.phase === 'countdown') {
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
        if (atPhase === 'countdown' || atPhase === 'typing' || atPhase === 'thinking') {
            // Second click during countdown / typing / agent-thinking = abort via main.
            // (Aborting during 'thinking' just stops main's auto-type:send loop;
            // the in-flight Sonnet call resolves into the void without affecting
            // the typing engine.)
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
            // localOnlyAutoType is read from localStorage rather than prop-
            // drilled through MessageRenderer/CodeBlock. The setting only
            // matters at click-time, so reading at the event boundary keeps
            // CodeBlock's React.memo behavior intact (a settings flip
            // shouldn't invalidate every code block in a long conversation).
            const localOnly = localStorage.getItem('LOCAL_ONLY_AUTO_TYPE') === 'true';
            const result = await electronIPC.invoke('auto-type:send', {
                code,
                skipLines,
                authToken,
                language: language || 'unknown',
                localOnly,
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
        // 'thinking' is the new agentic phase — Sonnet 4.6 is reasoning
        // about the editor state via tool_use. Takes 3-8s on hard cases
        // (HackerRank templates with __main__ blocks, mid-file inserts).
        atPhase === 'thinking'        ? 'Thinking…  (click to cancel)' :
        atPhase === 'countdown'       ? `Typing in ${atCountdown}…  (click to cancel)` :
        atPhase === 'typing'          ? 'Typing…  (click to cancel)' :
        atPhase === 'done'            ? 'Done' :
        atPhase === 'verify-mismatch' ? 'Done — please verify editor' :
                                        'Auto-Type';
    const autoTypeClass =
        atPhase === 'done'            ? 'text-green-400'
      : atPhase === 'verify-mismatch' ? 'text-amber-400'
      // 'thinking' uses blue to telegraph "AI is working" vs the amber
      // "system is acting on your behalf" used for countdown/typing.
      : atPhase === 'thinking'        ? 'text-blue-400'
      : atPhase !== 'idle'            ? 'text-amber-400'
      :                                 'text-gray-400 hover:text-white';

    return (
        <div className="my-3 rounded-lg overflow-hidden border border-gray-700/50 bg-black/20 backdrop-blur-sm shadow-lg">
            <div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-gray-700/50">
                <span className="text-xs font-mono text-gray-400 lowercase">{language || 'code'}</span>
                <div className="flex items-center gap-3">
                    {isElectron ? (
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
                                : atPhase === 'thinking'
                                // Loader2 (spinner) telegraphs "AI is reasoning"
                                // — distinct from Zap (system action) so the
                                // user can tell the difference between "the
                                // agent is thinking" and "keystrokes incoming".
                                ? <Loader2 size={12} className="animate-spin" />
                                : <Zap size={12} className={atPhase !== 'idle' ? 'animate-pulse' : ''} />}
                            <span>{autoTypeLabel}</span>
                            {!canAutoType && atPhase === 'idle' && <WizardHat size={10} className="text-amber-400" />}
                        </button>
                    ) : (
                        // Web: never invoke auto-type:* IPC — upsell desktop instead.
                        <button
                            type="button"
                            onClick={() => window.dispatchEvent(new CustomEvent('app:open-download'))}
                            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-amber-300 transition-colors"
                            title="Auto-Type types code into your editor — desktop app only"
                            aria-label="Auto-Type — Desktop only. Download the desktop app."
                        >
                            <Keyboard size={12} />
                            <span>Auto-Type — Desktop only</span>
                            <Download size={10} className="text-blue-400" />
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

    // Memoize the components map so its identity is stable across renders
    // — without this hoist, ReactMarkdown sees a new `components` object
    // every render and treats it as "props changed" for reconciliation.
    // canAutoType + isStreaming are the only render-relevant props the
    // child handlers close over, so the dep array reflects exactly what
    // would actually require a fresh closure.
    const markdownComponents = useMemo(() => ({
        code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            return !inline && match ? (
                <CodeBlock code={String(children).replace(/\n$/, '')} language={match[1]} canAutoType={canAutoType} isStreaming={isStreaming} />
            ) : (
                <code className="bg-gray-200 dark:bg-gray-800 rounded px-1 py-0.5 font-mono text-sm" {...props}>
                    {children}
                </code>
            );
        },
        a({ href, children, ...props }: any) {
            // Intercept the in-app `[Label](upgrade)` link the AI emits
            // when a feature is gated behind a paid tier (see the Auto-
            // Solve gate message). Without this it would render as plain
            // <a href="upgrade"> and a click would navigate the renderer
            // to a broken relative URL — "http://localhost:3005/upgrade"
            // in dev or "file:///.../upgrade" packaged — stranding the
            // user on a 404 inside the desktop window. We dispatch a
            // window event the App wrapper picks up to open
            // ManageSubscription; using an event keeps this memoized
            // component free of new props that would bust its React.memo
            // on every render.
            if (href === 'upgrade') {
                return (
                    <a
                        href="#upgrade"
                        onClick={(e) => {
                            e.preventDefault();
                            window.dispatchEvent(new CustomEvent('app:open-manage-subscription'));
                        }}
                        className="text-blue-400 hover:text-blue-300 font-bold underline cursor-pointer"
                    >
                        {children}
                    </a>
                );
            }
            return <a href={href} {...props}>{children}</a>;
        }
    }), [canAutoType, isStreaming]);

    return (
        <div className={`markdown-body prose dark:prose-invert max-w-none ${sizeClass} prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
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
  // Hold onClose in a ref so the focus-trap effect below does NOT depend on
  // its identity. Call sites pass an inline arrow (onClose={() => setX(false)})
  // which is a NEW function on every parent render. If the effect depended on
  // onClose it would tear down + re-run on EVERY parent render — and its
  // re-run calls focusables[0].focus(), yanking focus to the ✕ button out of
  // whatever input the user is typing in. THAT is the Custom Instructions
  // "can't type" bug: that textarea is bound directly to a parent state that
  // updates on every keystroke, so each keystroke re-rendered the parent,
  // re-ran this effect, and stole focus back to the close button after a
  // single character.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Escape closes; Tab cycles focus inside the dialog (focus trap). Without
  // these, keyboard users had no way out of the modal and could tab into the
  // dimmed background. Depends ONLY on isOpen — see onCloseRef above for why
  // onClose must NOT be a dependency (it would re-run on every parent render
  // and steal focus from inputs mid-typing).
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
        onCloseRef.current?.();
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
  }, [isOpen]);

  if (!isOpen) return null;
  const inElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
  // In the transparent pop-out, a full-bleed opaque-black backdrop turns the
  // rounded floating window into a hard black square. Use a themed obsidian
  // tint rounded to the window's radius so the pop-out keeps its shape and the
  // overlay reads as part of the same premium surface.
  const inPopout = typeof document !== 'undefined' && document.documentElement.classList.contains('electron-transparent');
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{
        background: inPopout ? 'rgba(11,10,8,0.82)' : (inElectron ? 'rgba(0,0,0,0.92)' : 'rgba(0,0,0,0.5)'),
        borderRadius: inPopout ? '18px' : undefined,
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
        style={{ background: 'var(--surface-color)' }}
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
    onOpenSupport,
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
    sidebarOpen,
    handlePlaySampleQuestion,
    onClosePip,
}: any) => {

    // Document PiP renders ChatInterface into a separate window. Portals must
    // target that window's body or menus open on the main "Safe to Share" tab.
    const getOverlayPortalRoot = (): HTMLElement => {
        try {
            const pipWin = (window as any).documentPictureInPicture?.window as Window | null | undefined;
            if (isPipMode && !isElectron && pipWin?.document?.body) {
                return pipWin.document.body;
            }
        } catch { /* ignore */ }
        return document.body;
    };

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
    // Display data lives in MODEL_REGISTRY (top of file); compact rows are
    // rendered via <ModelPickerCard variant="compact" />.
    const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
    // Either top OR bottom is set (not both) — top means "popover hangs
    // below the button", bottom means "popover floats above the button".
    // We flip when there isn't enough room below (the input-area picker
    // sits near the bottom of the chat window, so the down-opening default
    // would clip the lower rows off-screen).
    const [modelMenuPos, setModelMenuPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
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
        // In the web pop-out the menu + trigger live in the Document-PiP
        // window, so outside-clicks / Esc / resize fire on THAT window's
        // document — the main-document listeners above never see them and
        // the menu would get "stuck" open. Mirror the listeners onto the
        // PiP window too.
        const pipWin = (isPipMode && !isElectron)
            ? ((window as any).documentPictureInPicture?.window as Window | null | undefined)
            : null;
        if (pipWin) {
            pipWin.document.addEventListener('mousedown', closeOnOutside);
            pipWin.document.addEventListener('keydown', closeOnEsc);
            pipWin.addEventListener('resize', closeOnResize);
        }
        return () => {
            document.removeEventListener('mousedown', closeOnOutside);
            document.removeEventListener('keydown', closeOnEsc);
            window.removeEventListener('resize', closeOnResize);
            if (pipWin) {
                pipWin.document.removeEventListener('mousedown', closeOnOutside);
                pipWin.document.removeEventListener('keydown', closeOnEsc);
                pipWin.removeEventListener('resize', closeOnResize);
            }
        };
    }, [isModelMenuOpen]);

    const toggleModelMenu = () => {
        if (isModelMenuOpen) { setIsModelMenuOpen(false); return; }
        const btn = modelButtonRef.current;
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        // In the WEB pop-out the menu is portaled into the Document-PiP
        // window (see getOverlayPortalRoot), so its `position: fixed`
        // coordinates resolve against the PIP window's viewport — NOT the
        // main tab's. The trigger button also lives in the PiP document, so
        // its getBoundingClientRect() is already PiP-relative. We therefore
        // must read innerWidth/innerHeight from the PiP window too, or the
        // right/bottom offsets are computed against the wrong (main-window)
        // dimensions and the menu lands off-screen — which is exactly why
        // the model list "didn't work" in the web pop-out.
        let viewW = window.innerWidth;
        let viewH = window.innerHeight;
        if (isPipMode && !isElectron) {
            const pipWin = (window as any).documentPictureInPicture?.window as Window | null | undefined;
            if (pipWin) { viewW = pipWin.innerWidth; viewH = pipWin.innerHeight; }
        }
        // Flip up when there isn't enough room below the trigger. The
        // input-area picker sits near the bottom of the chat window, so a
        // down-opening popover would clip the lower rows. 5 rows × ~30px
        // + ~16px padding ≈ 170px; we use 200 as a safety margin so the
        // last row doesn't graze the viewport edge.
        const POPOVER_H = 200;
        const GAP = 4;
        const spaceBelow = viewH - rect.bottom;
        const spaceAbove = rect.top;
        const openUpward = spaceBelow < POPOVER_H + GAP && spaceAbove > spaceBelow;
        setModelMenuPos(
            openUpward
                ? {
                    bottom: viewH - rect.top + GAP,
                    right: viewW - rect.right,
                  }
                : {
                    top: rect.bottom + GAP,
                    right: viewW - rect.right,
                  }
        );
        setIsModelMenuOpen(true);
    };

    if (isPipMode) {
        // Detect Electron for window controls
        const inElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
        const overlayRoot = getOverlayPortalRoot();

        const cycleSize = () => {
            const next = (sizeIndex + 1) % sizePresets.length;
            setSizeIndex(next);
            electronIPC.send('resize-popout', { width: sizePresets[next].w, height: sizePresets[next].h });
        };

        // Shared button style for glass look
        // Header controls: transparent at rest, glass on hover (via each
        // button's hover:bg-* class) — matches the main-app header. No fill
        // box, no border.
        const glassBtn = {
            background: 'transparent',
            border: 'none',
            color: 'var(--text-main)',
        };

        // Web PiP now carries the `electron-transparent` class (set in
        // PiPWindow.initPip), so `.popup` is transparent in both modes and the
        // obsidian base painted on the PiP <html> shows through — the header/
        // footer render as the same floating rounded glass bands as the
        // Electron pop-out.
        return (
            <div className="popup open" style={{ background: 'transparent' }}>
                <div className="bg-layer"></div>
                
                {/* ── HEADER ── */}
                <div
                    className="popup-header"
                    id="dragHandle"
                    style={inElectron ? { WebkitAppRegion: 'drag', padding: '10px 12px' } as any : { padding: '10px 12px' }}
                >
                    {/* Left: empty flex spacer keeps controls right-aligned and the
                        header band draggable (matches the Electron pop-out, which
                        also shows no brand text). */}
                    <div style={{ flex: 1, minWidth: 0 }} />

                    {/* Right: Controls row */}
                    <div
                        className="ml-auto flex items-center"
                        style={inElectron ? { WebkitAppRegion: 'no-drag', gap: '6px' } as any : { gap: '6px' }}
                    >
                        {/* Live indicator for web (compact) */}
                        {!inElectron && (
                          <div
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold ${
                              isListening ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.04] text-gray-500'
                            }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${isListening ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'}`} />
                            {isListening ? 'LIVE' : 'OFF'}
                          </div>
                        )}
                        {/* Tier & credit chips — only at M/L sizes so the S preset
                            (340px) doesn't wrap the controls onto two rows.
                            Web PiP always shows tier (no size cycle). */}
                        {(sizeIndex >= 1 || !inElectron) && effectiveTier === 'max' && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-gradient-to-r from-amber-500/15 to-purple-500/10 text-amber-400">
                            <WizardHat size={9} /> MAX
                          </div>
                        )}
                        {(sizeIndex >= 1 || !inElectron) && effectiveTier === 'pro' && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-blue-500/10 text-blue-400">
                            <Crown size={9} /> PRO
                          </div>
                        )}
                        {(sizeIndex >= 1 || !inElectron) && effectiveTier === 'basic' && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-400">
                            <Zap size={9} /> BASIC
                          </div>
                        )}
                        {(sizeIndex >= 1 || !inElectron) && creditTimer && (creditTimer.source === 'credits' || creditTimer.source === 'trial') && creditTimer.remaining > 0 && (
                          <div
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold ${
                              creditTimer.remaining <= TIME_CONSTANTS.LOW_WARNING_SECONDS
                                ? 'bg-red-500/15 text-red-400'
                                : creditTimer.source === 'trial'
                                  ? 'bg-cyan-500/15 text-cyan-400'
                                  : 'bg-emerald-500/15 text-emerald-300'
                            }`}
                            aria-label={creditTimer.source === 'trial' ? 'Free trial time remaining' : 'Plan time remaining'}
                          >
                            {creditTimer.source === 'trial' ? 'TRIAL' : ''} {formatTimeRemaining(creditTimer.remaining)}
                            {/* Used-vs-granted tube — renders only when the plan
                                grant is known (fail-soft: unknown/unlimited keeps
                                the chip exactly as before). */}
                            <TimeTubeGauge granted={creditTimer.granted} remaining={creditTimer.remaining} width={26} />
                          </div>
                        )}
                        {/* Model selector — custom popover (not native <select>) so the
                            options list lives inside the popout's compositor surface.
                            Web: portal into Document-PiP document, not main tab. */}
                        <div className="relative flex items-center">
                          <button
                              ref={modelButtonRef}
                              type="button"
                              onClick={toggleModelMenu}
                              className="appearance-none text-[10px] rounded-md pl-1.5 pr-5 py-0.5 outline-none cursor-pointer hover:bg-white/[0.07] transition-colors"
                              style={glassBtn}
                              aria-haspopup="listbox"
                              aria-expanded={isModelMenuOpen}
                          >
                              {MODEL_REGISTRY[settings.selectedModel as ModelKey]?.short ?? 'Gemini'}
                          </button>
                          <ChevronDown size={10} className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none opacity-70" />
                          {isModelMenuOpen && modelMenuPos && createPortal(
                            <div
                              ref={modelMenuRef}
                              role="listbox"
                              className="fixed z-[9999] py-2 px-1.5 rounded-2xl min-w-[160px] overflow-y-auto custom-scrollbar border"
                              style={{
                                  top: modelMenuPos.top,
                                  bottom: modelMenuPos.bottom,
                                  right: modelMenuPos.right,
                                  maxHeight: 'calc(100vh - 24px)',
                                  background: 'var(--model-menu-bg, rgba(18,16,11,0.96))',
                                  borderColor: 'var(--model-menu-border, rgba(255,255,255,0.12))',
                                  boxShadow: 'var(--model-menu-shadow, 0 12px 40px rgba(0,0,0,0.45))',
                                  backdropFilter: 'blur(20px) saturate(1.2)',
                                  WebkitAppRegion: 'no-drag',
                              } as any}
                            >
                              {MODEL_ORDER.map(key => (
                                <ModelPickerCard
                                  key={key}
                                  modelKey={key}
                                  selected={key === settings.selectedModel}
                                  allowed={gate.canUseModel(key)}
                                  variant="compact"
                                  onSelect={() => {
                                    setSelectedModel(key);
                                    setIsModelMenuOpen(false);
                                  }}
                                  onLockedClick={() => {
                                    setIsModelMenuOpen(false);
                                    onOpenManageSub?.();
                                  }}
                                />
                              ))}
                            </div>,
                            overlayRoot
                          )}
                        </div>

                        {/* Settings */}
                        <button onClick={onOpenSettings} className="p-1 rounded transition-colors hover:bg-white/10" aria-label="Settings" style={glassBtn}>
                            <Settings size={13} strokeWidth={1.5} />
                        </button>

                        {/* Web: download + close (Electron has native window controls) */}
                        {!inElectron && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => onOpenDownload?.()}
                                    className="p-1 rounded transition-colors hover:bg-white/10 text-blue-300"
                                    aria-label="Download desktop app"
                                    title="Download desktop app — invisible always-on-top popout"
                                    style={glassBtn}
                                >
                                    <Download size={13} strokeWidth={1.5} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onClosePip?.()}
                                    className="p-1 rounded transition-colors hover:bg-red-500/30"
                                    aria-label="Close pop-out"
                                    title="Bring back to tab"
                                    style={glassBtn}
                                >
                                    <X size={13} strokeWidth={1.5} />
                                </button>
                            </>
                        )}

                        {/* ── Electron-only controls ── */}
                        {inElectron && (
                            <>
                                {/* Divider */}
                                <div style={{ width: 1, height: 16, background: 'rgba(211,172,99,0.20)', margin: '0 2px' }} />

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

                {/* Web Document-PiP: desktop upsell (Electron popout is already invisible). */}
                {!inElectron && (
                    <button
                        type="button"
                        onClick={() => onOpenDownload?.()}
                        className="shrink-0 px-3 py-1.5 text-[10px] leading-snug text-amber-200/90 bg-amber-500/10 border-b border-amber-500/20 hover:bg-amber-500/15 text-left transition-colors w-full"
                    >
                        Download the desktop app for the invisible, always-on-top version.
                    </button>
                )}

                <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div
                    className="messages"
                    id="messages"
                    ref={chatContainerRef}
                    onScroll={handleScroll}
                >
                    {/* Empty state — web: tab-audio copy + sample question; Electron: mic hint */}
                    {messages.length === 0 && !isListening && (
                        <div className="h-full flex flex-col items-center justify-center gap-3 px-4 animate-in fade-in duration-1000">
                            <p
                              className="text-center text-sm leading-relaxed select-none pointer-events-none"
                              style={{ fontFamily: 'var(--serif)', color: 'var(--text-muted)', opacity: 0.9 }}
                            >
                                {!inElectron
                                  ? <>Share the meeting tab's audio, or try a sample below</>
                                  : <>Turn on the mic and set <span style={{ color: '#d3ac63' }}>Manual → Auto</span> for the best experience</>
                                }
                            </p>
                            {!inElectron && handlePlaySampleQuestion && (
                                <button
                                    type="button"
                                    onClick={handlePlaySampleQuestion}
                                    disabled={isProcessing}
                                    className="pointer-events-auto flex items-center gap-2 pl-1 pr-3 py-1 rounded-full text-[11px] font-bold bg-gradient-to-r from-blue-500/20 to-purple-500/20 text-blue-200 border border-blue-500/30 hover:from-blue-500/30 hover:to-purple-500/30 transition-all disabled:opacity-50"
                                    aria-label="Play a sample question"
                                >
                                    <span
                                        className="relative inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0 shadow-[0_2px_8px_rgba(0,0,0,0.45)] ring-1 ring-white/10"
                                        style={{ background: 'linear-gradient(160deg, #2a2a2e 0%, #0a0a0c 55%, #000 100%)' }}
                                        aria-hidden
                                    >
                                        {isProcessing ? (
                                            <Loader2 size={12} className="text-white/90 animate-spin" strokeWidth={2.25} />
                                        ) : (
                                            <svg width="9" height="10" viewBox="0 0 11 12" fill="none" className="ml-0.5">
                                                <path d="M1.2 0.85C1.2 0.28 1.82 -0.07 2.3 0.22l8.1 4.85c.46.28.46.94 0 1.21l-8.1 4.85c-.48.29-1.1-.06-1.1-.63V0.85z" fill="white" fillOpacity="0.95" />
                                            </svg>
                                        )}
                                    </span>
                                    Play a sample question
                                </button>
                            )}
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

                    {/* Regenerate — surfaced in the transparent pop-out too, not
                        just the main composer. Shows under the last answer when
                        idle; reuses the same handleRegenerate the main window uses. */}
                    {messages.length > 0 && !isProcessing && !streamingMsg && messages[messages.length - 1].role !== 'user' && (
                        <div className="pip-regen-row">
                            <button className="pip-regen" onClick={handleRegenerate} aria-label="Regenerate answer">
                                <RefreshCw size={13} strokeWidth={2} />
                                <span>Regenerate</span>
                            </button>
                        </div>
                    )}

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
                            background: 'rgba(18,16,11,0.92)',
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

                {/* The `.input-area` CSS uses `align-items: flex-end` (for the
                    Electron send-button alignment), so with our `flex-direction:
                    column` override the direct children DON'T stretch — they
                    shrink-wrap to the right. That collapsed the textarea to its
                    content width (~130px) instead of filling the shell. Force
                    each child to full width so the composer spans the whole
                    pop-out, exactly like the main-app composer. */}
                <div className="input-area" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0' }}>
                    {/* ── Textarea — spans the FULL width of the shell so there's
                         maximum room to type; auto-grows then scrolls (see the
                         styled scrollbar + max-height in pip-styles.css). ── */}
                    <div style={{ position: 'relative', width: '100%' }}>
                        {interimText && (
                            <div
                                className="pointer-events-none absolute left-2.5 top-2 right-2.5 text-[12px] italic truncate z-0"
                                style={{ color: 'var(--text-muted)', opacity: 0.7 }}
                            >
                                {inputText}{interimText}
                            </div>
                        )}
                        <textarea
                            id="inputBox"
                            className="pip-textarea relative z-10"
                            placeholder={
                              !inElectron
                                ? (settings.autoSend ? "Listening for interviewer (tab audio)…" : "Type a message…")
                                : (settings.autoSend ? "Listening for interviewer..." : "Type a message…")
                            }
                            rows={1}
                            value={inputText}
                            // Explicit `width: 100%` fills the shell; `field-sizing:
                            // content` then drives only the HEIGHT auto-grow (an
                            // explicit width disables field-sizing's width axis).
                            // max-height in pip-styles.css caps the grow region,
                            // with the styled scrollbar taking over past it. Without
                            // the explicit width, field-sizing:content collapsed the
                            // box to its text width.
                            style={{ fieldSizing: 'content', width: '100%', maxHeight: 80 } as React.CSSProperties}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleManualSend();
                                }
                            }}
                        />
                    </div>

                    {/* ── Controls row: AUTO / LIVE on the left, Send + Auto-Solve
                         on the right — sits BELOW the full-width textarea. ── */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingTop: '6px', flexWrap: 'wrap' }}>
                        <button
                            onClick={toggleAutoSend}
                            className={`pip-toggle ${settings.autoSend ? 'active-gold' : ''}`}
                        >
                            <Zap size={10} /> {settings.autoSend ? 'AUTO' : 'MANUAL'}
                        </button>

                        <button
                            onClick={isListening ? stopListening : startListening}
                            className={`pip-toggle ${isListening ? 'active-green' : ''}`}
                            title={!inElectron ? "Share the meeting tab's audio — never your mic" : undefined}
                        >
                            {isListening ? <Mic size={10} /> : <MicOff size={10} />}
                            {isListening ? 'LIVE' : (!inElectron ? 'LISTEN' : 'MIC OFF')}
                        </button>

                        {speechError && (
                            <span style={{ fontSize: '9px', color: '#ef4444', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {speechError}
                            </span>
                        )}

                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                            <button
                                className="send-btn"
                                id="sendBtn"
                                aria-label="Send message"
                                onClick={handleManualSend}
                                disabled={!inputText.trim() || isProcessing}
                                style={{ opacity: (!inputText.trim() || isProcessing) ? 0.5 : 1 }}
                            >
                                <PaperAirplane size={18} />
                            </button>

                            <button
                                className="send-btn ml-2"
                                aria-label={gate.canAutoSolve ? "Auto-Solve" : "Auto-Solve — available on every paid plan"}
                                onClick={handleAutoSolve}
                                disabled={isProcessing || !gate.canAutoSolve}
                                style={{ opacity: (isProcessing || !gate.canAutoSolve) ? 0.4 : 1, position: 'relative' }}
                            >
                                <ScanSearch size={18} strokeWidth={1.5} />
                                {!gate.canAutoSolve && (
                                    <span
                                        className="absolute -top-1 -right-1 text-[7px] font-bold tracking-wider bg-amber-400/15 text-amber-300 px-1 py-px rounded border border-amber-400/40"
                                        style={{ letterSpacing: '0.05em', lineHeight: 1 }}
                                    >PRO</span>
                                )}
                            </button>
                        </div>
                    </div>
                    {/* Web privacy line — interviewer-only transcription */}
                    {!inElectron && (
                        <p style={{ fontSize: 9, lineHeight: 1.35, color: 'var(--text-muted)', marginTop: 6, opacity: 0.85 }}>
                            We only transcribe the interviewer's questions — never your voice.
                        </p>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className={`flex-1 flex flex-col h-full overflow-hidden relative bg-transparent text-text transition-colors duration-300 ${settings.theme === 'dark' ? 'dark' : ''}`}>
             {/* --- RESPONSIVE HEADER --- */}
            <header className={`h-14 md:h-16 bg-transparent flex items-center justify-between px-4 shrink-0 z-20 sticky top-0`}>
                {/* When the sidebar is closed, the floating hamburger
                    (fixed top-3 left-3, ends at x≈48px) overlaps the header's
                    left edge — indent the wordmark clear of it. */}
                <div className={`flex items-center gap-2 md:gap-3${sidebarOpen ? '' : ' ml-10'}`}>
                <h1 className="font-bold text-base md:text-lg tracking-tight hidden xs:block">minica<span className="text-blue-500">ai</span></h1>
                </div>

                <div className="flex items-center gap-2 md:gap-3">
                    {/* User tier badge — clickable, opens Manage Subscription.
                        Sparkles (not Crown) so Max reads as a different rank
                        than Pro. Matches the existing in-app Max gradient
                        (amber-500/10 → purple-500/10) the rest of the app
                        uses everywhere else for Max. */}
                    {/* Tier badge — single subscription entry-point in the
                        header. Doubles as status indicator (shows current
                        plan: MAX / PRO / BASIC / Upgrade) AND action (click
                        opens ManageSubscription). The previous header had a
                        SECOND identical entry-point (a standalone Crown icon
                        next to Settings) which was redundant and confusing —
                        now removed. The badge itself is always visible
                        regardless of breakpoint so users on narrow widths
                        still see and can click it. */}
                    {userLicense && userLicense.tier === 'max' ? (
                      <button onClick={onOpenManageSub} title="Manage subscription" className="flex px-2.5 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 bg-gradient-to-r from-amber-500/15 to-purple-500/10 text-amber-400 hover:from-amber-500/25 hover:to-purple-500/20 transition-all cursor-pointer">
                        <WizardHat size={10} /> MAX
                      </button>
                    ) : userLicense && userLicense.tier === 'pro' ? (
                      <button onClick={onOpenManageSub} title="Manage subscription" className="flex px-2.5 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all cursor-pointer">
                        <Crown size={10} /> PRO
                      </button>
                    ) : userLicense && userLicense.tier === 'basic' ? (
                      <button onClick={onOpenManageSub} title="Manage subscription" className="flex px-2.5 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-all cursor-pointer">
                        <Zap size={10} /> BASIC
                      </button>
                    ) : userLicense ? (
                      <button onClick={onOpenManageSub} title="Manage subscription" className="flex px-3 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 bg-gradient-to-r from-blue-500/10 to-purple-500/10 text-blue-400 hover:from-blue-500/20 hover:to-purple-500/20 transition-all cursor-pointer">
                        <Crown size={10} /> Upgrade
                      </button>
                    ) : null}

                    {/* Live credit / trial countdown chip (Basic users + Free on trial) */}
                    {creditTimer && (creditTimer.source === 'credits' || creditTimer.source === 'trial') && creditTimer.remaining > 0 && (
                      <div
                        className={`hidden md:flex px-2.5 py-1 rounded-full text-[10px] font-semibold items-center gap-1.5 transition-all duration-300 ${
                          creditTimer.remaining <= TIME_CONSTANTS.LOW_WARNING_SECONDS
                            ? 'bg-red-500/15 text-red-400'
                            : creditTimer.source === 'trial'
                              ? 'bg-cyan-500/15 text-cyan-400'
                              : 'bg-emerald-500/15 text-emerald-300'
                        }`}
                        aria-label={creditTimer.source === 'trial' ? 'Free trial time remaining' : 'Basic plan time remaining'}
                      >
                        {creditTimer.source === 'trial' ? 'TRIAL' : ''} {formatTimeRemaining(creditTimer.remaining)}
                        {/* Used-vs-granted tube — renders only when the plan
                            grant is known (fail-soft: unknown/unlimited keeps
                            the chip exactly as before). */}
                        <TimeTubeGauge granted={creditTimer.granted} remaining={creditTimer.remaining} width={36} />
                      </div>
                    )}
                    <div className={`hidden md:flex px-3 py-1 rounded-full text-xs font-medium items-center gap-2 transition-all duration-300 ${isListening ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.04] text-gray-400'}`}>
                        <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`}></div>
                        {isListening ? 'LIVE' : 'OFF'}
                    </div>
                    
                    {/* Hide — Electron: close-window IPC (smoothHide + hotkey).
                        Web: dead control — upsell desktop download instead. */}
                    {isElectron ? (
                      <button
                          onClick={() => electronIPC.send('close-window')}
                          className="p-2 rounded-lg text-gray-400 hover:text-[#d3ac63] hover:bg-white/[0.06] transition-all"
                          title={`Hide from screen share (${/(Mac|iPhone|iPad)/i.test(typeof navigator !== 'undefined' ? navigator.platform : '') ? '⌘' : 'Ctrl'}+Alt+Space to bring back)`}
                          aria-label="Hide app (screen-share safety)"
                      >
                          <EyeOff size={20} />
                      </button>
                    ) : (
                      <button
                          onClick={() => onOpenDownload?.()}
                          className="p-2 rounded-lg text-gray-500 hover:text-amber-300 hover:bg-white/[0.06] transition-all"
                          title="Desktop only — invisible hide + global hotkey. Download the desktop app."
                          aria-label="Hide from screen share — Desktop only. Download the desktop app."
                      >
                          <EyeOff size={20} />
                      </button>
                    )}

                    {/* Web: prominent download CTA for desktop-only powers */}
                    {!isElectron && onOpenDownload && (
                      <button
                          onClick={onOpenDownload}
                          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] md:text-xs font-bold bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border border-blue-500/20 transition-all"
                          title="Download desktop app — invisible popout, Auto-Type, system audio"
                          aria-label="Download desktop app"
                      >
                          <Download size={14} />
                          Download desktop app
                      </button>
                    )}

                    {!isPipMode && (
                        <button
                            onClick={togglePip}
                            className={`p-2 rounded-lg transition-all relative ${
                              gate.canPopout
                                ? 'text-[#d3ac63] hover:bg-white/[0.06]'
                                : 'text-gray-500 cursor-not-allowed opacity-60'
                            }`}
                            aria-label={gate.canPopout ? "Pop Out (Hide from Screen Share)" : "Pop-out Mode — available on every paid plan"}
                        >
                            <ExternalLink size={20} />
                            {!gate.canPopout && <Crown size={8} className="absolute top-1 right-1 text-amber-400" />}
                        </button>
                    )}

                    {onNewSession && (
                        <button onClick={onNewSession} className="p-2 rounded-lg text-gray-400 hover:text-[#d3ac63] hover:bg-white/[0.06] transition-all" aria-label="New Interview Session"><Plus size={20} /></button>
                    )}
                    {onOpenSupport && (
                        <button onClick={onOpenSupport} className="p-2 rounded-lg text-gray-400 hover:text-[#d3ac63] hover:bg-white/[0.06] transition-all" aria-label="Chat with Minica (Support)"><Headphones size={20} /></button>
                    )}
                    <button onClick={onOpenContext} className="p-2 rounded-lg text-gray-400 hover:text-[#d3ac63] hover:bg-white/[0.06] transition-all" aria-label="Files (Knowledge Base)"><FileText size={20} /></button>
                    <button onClick={onOpenSettings} className="p-2 rounded-lg transition-all text-gray-400 hover:text-[#d3ac63] hover:bg-white/[0.06]" aria-label="Settings"><Settings size={20} /></button>
                    <button onClick={onLogout} className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all" aria-label="Logout"><LogOut size={20} /></button>
                </div>
            </header>

            <main className="flex-1 flex overflow-hidden relative w-full">
                <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full relative">
                
                <div 
                    ref={chatContainerRef} 
                    onScroll={handleScroll}
                    className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6 pb-40 md:pb-48 custom-scrollbar"
                >
                    {/* Watermark — setup hint while chat is empty. Web adds a
                        sample-question control so users can try streaming without
                        a live interviewer. */}
                    {messages.length === 0 && !isListening && (
                        <div className="h-[60%] mt-10 flex flex-col items-center justify-center gap-4 animate-in fade-in duration-1000">
                            <p className="text-center text-lg md:text-xl px-8 leading-relaxed select-none pointer-events-none" style={{ fontFamily: 'var(--serif)', letterSpacing: '0.01em', color: 'var(--text-color)', opacity: 0.22 }}>
                                {!isElectron
                                  ? <>Share the meeting tab's audio, or play a sample question below</>
                                  : <>Turn on the mic and set <span style={{ color: '#d3ac63' }}>Manual → Auto</span> for the best experience</>
                                }
                            </p>
                            {!isElectron && handlePlaySampleQuestion && (
                                <button
                                    type="button"
                                    onClick={handlePlaySampleQuestion}
                                    disabled={isProcessing}
                                    className="pointer-events-auto flex items-center gap-2.5 pl-1.5 pr-4 py-1.5 rounded-full text-sm font-bold bg-gradient-to-r from-blue-500/20 to-purple-500/20 text-blue-200 border border-blue-500/30 hover:from-blue-500/30 hover:to-purple-500/30 transition-all disabled:opacity-50"
                                    aria-label="Play a sample question"
                                >
                                    {/* Premium black play disc — solid circle + crisp triangle, not a unicode glyph */}
                                    <span
                                        className="relative inline-flex items-center justify-center w-8 h-8 rounded-full shrink-0 shadow-[0_2px_8px_rgba(0,0,0,0.45)] ring-1 ring-white/10"
                                        style={{ background: 'linear-gradient(160deg, #2a2a2e 0%, #0a0a0c 55%, #000 100%)' }}
                                        aria-hidden
                                    >
                                        {isProcessing ? (
                                            <Loader2 size={14} className="text-white/90 animate-spin" strokeWidth={2.25} />
                                        ) : (
                                            <svg width="11" height="12" viewBox="0 0 11 12" fill="none" className="ml-0.5">
                                                <path d="M1.2 0.85C1.2 0.28 1.82 -0.07 2.3 0.22l8.1 4.85c.46.28.46.94 0 1.21l-8.1 4.85c-.48.29-1.1-.06-1.1-.63V0.85z" fill="white" fillOpacity="0.95" />
                                            </svg>
                                        )}
                                    </span>
                                    Play a sample question
                                </button>
                            )}
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

                        <div className="composer-shell relative flex flex-col mx-2 rounded-[1.5rem] transition-all duration-300">

                            <div className="flex items-center justify-between px-3 pt-2 pb-1">
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={toggleAutoSend}
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] md:text-xs font-bold transition-all ${
                                            settings.autoSend
                                            ? 'bg-blue-500/20 text-blue-500'
                                            : 'bg-white/[0.04] text-gray-400 hover:bg-white/[0.07]'
                                        }`}
                                    >
                                        <Zap size={12} className={settings.autoSend ? "fill-blue-500" : ""} />
                                        {settings.autoSend ? 'AUTO' : 'MANUAL'}
                                    </button>

                                    <button
                                        onClick={isListening ? stopListening : startListening}
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] md:text-xs font-bold transition-all ${
                                            isListening
                                            ? 'bg-emerald-500/20 text-emerald-400'
                                            : 'bg-white/[0.04] text-gray-400 hover:bg-white/[0.07]'
                                        }`}
                                        title={!isElectron ? "Share the meeting tab's audio — we never capture your mic" : undefined}
                                    >
                                        {isListening ? <Mic size={12} /> : <MicOff size={12} />}
                                        {isListening ? 'ON' : 'OFF'}
                                    </button>
                                    {!isElectron && (
                                        <span className="text-[9px] md:text-[10px] text-gray-500 max-w-[140px] md:max-w-[220px] leading-tight" title="Privacy">
                                            We only transcribe the interviewer's questions — never your voice.
                                        </span>
                                    )}

                                    {/* --- QUICK MODEL SWITCHER ---
                                        Custom popover instead of native <select>.
                                        Stealth fix: a native <select> dropdown
                                        opens its own Win32 HWND that is NOT
                                        covered by setContentProtection, so it
                                        could leak the option list on screen
                                        share. The portal'd popover lives in the
                                        same compositor surface as the rest of
                                        the renderer and inherits content
                                        protection. */}
                                    <div className="h-4 w-[1px] bg-white/[0.06] mx-1"></div>
                                    <div className="relative">
                                        <button
                                            ref={modelButtonRef}
                                            type="button"
                                            onClick={toggleModelMenu}
                                            className="appearance-none bg-white/[0.04] text-text text-[10px] md:text-xs font-bold px-2.5 py-1 pr-6 rounded-lg hover:bg-white/[0.07] focus:outline-none transition-all cursor-pointer"
                                            aria-haspopup="listbox"
                                            aria-expanded={isModelMenuOpen}
                                        >
                                            {MODEL_REGISTRY[settings.selectedModel as ModelKey]?.label ?? 'Gemini 3.1 Flash'}
                                        </button>
                                        <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500" />
                                        {isModelMenuOpen && modelMenuPos && createPortal(
                                            <div
                                                ref={modelMenuRef}
                                                role="listbox"
                                                className="fixed z-[9999] py-2 px-1.5 rounded-2xl min-w-[200px] overflow-y-auto custom-scrollbar"
                                                style={{
                                                    top: modelMenuPos.top,
                                                    bottom: modelMenuPos.bottom,
                                                    right: modelMenuPos.right,
                                                    maxHeight: 'calc(100vh - 24px)',
                                                    background: 'var(--model-menu-bg)',
                                                    borderColor: 'var(--model-menu-border)',
                                                    boxShadow: 'var(--model-menu-shadow)',
                                                    backdropFilter: 'blur(20px) saturate(1.2)',
                                                } as React.CSSProperties}
                                            >
                                                {MODEL_ORDER.map(key => (
                                                    <ModelPickerCard
                                                        key={key}
                                                        modelKey={key}
                                                        selected={key === settings.selectedModel}
                                                        allowed={gate.canUseModel(key)}
                                                        variant="compact"
                                                        onSelect={() => {
                                                            setSelectedModel(key);
                                                            setIsModelMenuOpen(false);
                                                        }}
                                                        onLockedClick={() => {
                                                            setIsModelMenuOpen(false);
                                                            onOpenManageSub?.();
                                                        }}
                                                    />
                                                ))}
                                            </div>,
                                            document.body
                                        )}
                                    </div>
                                </div>
                                
                                {!isProcessing && messages.length > 0 && (
                                    <button onClick={handleRegenerate} className="text-gray-500 hover:text-primary transition-colors p-1" aria-label="Regenerate last answer">
                                        <RefreshCw size={14} />
                                    </button>
                                )}
                            </div>

                            {/* iOS-flavored composer — see index.html `.composer-shell` /
                                `.btn-ios-send` / `.btn-ios-violet` rules for the visual
                                language. focus-within lifts the whole row when the user
                                engages the textarea (parent container glows, not the box). */}
                            <div className="relative flex items-end gap-2.5 px-2 pb-2 pt-0.5">
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

                                <div className="flex items-end gap-1.5 pb-0.5">
                                    {inputText && (
                                        <button
                                            onClick={handleClear}
                                            aria-label="Clear input"
                                            className="w-8 h-8 rounded-full bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center text-gray-400 hover:text-red-400 transition-colors"
                                        >
                                            <X size={14} strokeWidth={2.25} />
                                        </button>
                                    )}
                                    <button
                                        onClick={handleAutoSolve}
                                        disabled={isProcessing || !gate.canAutoSolve}
                                        aria-label={gate.canAutoSolve ? "Auto-Solve Screen" : "Auto-Solve — available on every paid plan"}
                                        className="btn-ios-violet relative w-10 h-10 rounded-full flex items-center justify-center text-white"
                                    >
                                        <ScanSearch size={18} strokeWidth={2} />
                                        {!gate.canAutoSolve && (
                                            <span
                                                className="absolute -top-1 -right-1 text-[8px] font-bold tracking-wider bg-amber-400 text-amber-950 px-1 py-px rounded shadow-sm"
                                                style={{ letterSpacing: '0.04em', lineHeight: 1 }}
                                            >
                                                PRO
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        onClick={handleManualSend}
                                        disabled={!inputText.trim() || isProcessing}
                                        aria-label="Send message"
                                        className="btn-ios-send w-10 h-10 rounded-full flex items-center justify-center text-white"
                                    >
                                        <PaperAirplane size={18} />
                                    </button>
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
// Module-scope singleton for the Document-PiP setup. React 18 StrictMode
// double-mounts effects in dev (mount → unmount → remount), so two
// concurrent initPip runs both called requestWindow: the first succeeded
// and consumed the user activation, the second threw NotAllowedError and
// its catch onClose()'d the feature — leaving an orphaned empty PiP window
// while the main tab snapped back out of "Safe to Share". Both effect runs
// must share ONE requestWindow call.
let pipSetupPromise: Promise<{ pipWindow: Window; div: HTMLDivElement }> | null = null;

const PiPWindow: React.FC<{ children: React.ReactNode; onClose: () => void }> = ({ children, onClose }) => {
    const [container, setContainer] = useState<HTMLElement | null>(null);
    // Set only once this instance has adopted the PiP window — distinguishes
    // a real unmount (must close the OS window) from StrictMode's synchronous
    // fake unmount (fires before the async setup resolves; must NOT close).
    const adoptedWindowRef = useRef<Window | null>(null);

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

        let disposed = false;

        async function initPip(): Promise<{ pipWindow: Window; div: HTMLDivElement }> {
                // Request a vertical phone-like window
                const pipWindow = await window.documentPictureInPicture.requestWindow({
                    width: 450,
                    height: 700,
                });

                // Copy EVERY stylesheet from the main document into the PiP
                // window — this includes pip-styles.css (imported in App.tsx),
                // index.css, and the Tailwind utility layer. Copying them all
                // is what lets the pop-out render with the exact same obsidian+
                // gold glass theme as the Electron pop-out: the ChatInterface
                // markup uses .popup/.messages/.bubble/.input-area, and the
                // `html.electron-transparent …` rules in pip-styles.css style
                // them — we activate those rules by adding the class below.
                [...document.styleSheets].forEach((styleSheet) => {
                    try {
                        const cssRules = [...styleSheet.cssRules]
                        .map((rule) => rule.cssText)
                        .join("");
                        const style = document.createElement("style");
                        style.textContent = cssRules;
                        pipWindow.document.head.appendChild(style);
                    } catch (e) {
                    // Cross-origin sheet (e.g. Google Fonts): .cssRules throws,
                    // so re-attach it as a <link> instead of inlining.
                    const link = document.createElement("link");
                    link.rel = "stylesheet";
                    link.type = styleSheet.type;
                    link.media = styleSheet.media.mediaText;
                    if (styleSheet.href) link.href = styleSheet.href;
                    pipWindow.document.head.appendChild(link);
                    }
                });

                // ── Activate the exact Electron pop-out theme ──
                // pip-styles.css keys its obsidian+gold glass on
                // `html.electron-transparent` (dark) / `:not(.dark)` (light).
                // Adding these classes to the PiP <html> makes the copied
                // rules apply, so the web pop-out looks identical to the
                // Electron transparent pop-out. We mirror the parent's dark/
                // light choice so the pop-out follows Settings → Theme.
                const parentIsDark = document.documentElement.classList.contains('dark');
                pipWindow.document.documentElement.classList.add('electron-transparent');
                if (parentIsDark) {
                    pipWindow.document.documentElement.classList.add('dark');
                } else {
                    pipWindow.document.documentElement.classList.remove('dark');
                }

                // The one intentional divergence from Electron: an Electron
                // pop-out is an OS-transparent window floating over the live
                // desktop, so its glass plates sit on whatever is behind it. A
                // browser Document-PiP window is NOT OS-transparent — it needs
                // its own opaque base, or the translucent gold/obsidian plates
                // would render against the browser's default white and look
                // wrong. So we paint the PiP root the app's deep obsidian; the
                // gold glass then reads exactly as it does in Electron, just on
                // its own dark surface instead of the desktop wallpaper.
                const baseStyle = pipWindow.document.createElement('style');
                baseStyle.textContent = parentIsDark
                    ? `html, body { background: #0a0a0b !important; }
                       html.electron-transparent, html.electron-transparent body,
                       html.electron-transparent .pip-body { background: #0a0a0b !important; }`
                    : `html, body { background: #f4f1ea !important; }
                       html.electron-transparent, html.electron-transparent body,
                       html.electron-transparent .pip-body { background: #f4f1ea !important; }`;
                pipWindow.document.head.appendChild(baseStyle);

                pipWindow.document.body.className = 'pip-body';

                const div = pipWindow.document.createElement('div');
                div.style.height = '100%';
                div.style.display = 'flex';
                div.style.flexDirection = 'column';
                if (parentIsDark) div.classList.add('dark');
                pipWindow.document.body.appendChild(div);
                return { pipWindow, div };
        }

        // First mount (or reopen after close) starts the setup; StrictMode's
        // remount reuses the same in-flight promise instead of issuing a
        // second requestWindow.
        if (!pipSetupPromise) {
            pipSetupPromise = initPip();
            pipSetupPromise.catch(() => { pipSetupPromise = null; });
        }

        pipSetupPromise
            .then(({ pipWindow, div }) => {
                if (disposed) return; // StrictMode throwaway instance — the live remount adopts instead
                adoptedWindowRef.current = pipWindow;
                pipWindow.addEventListener('pagehide', () => {
                    pipSetupPromise = null;
                    onClose();
                });
                setContainer(div);
            })
            .catch((err) => {
                if (disposed) return;
                console.error('PiP Error:', err);
                onClose();
            });

        return () => {
            disposed = true;
            // Real unmount (e.g. "Restore here" flips isPipMode off): close the
            // OS PiP window too, or it lingers as an orphaned empty window.
            // StrictMode's fake unmount runs before the async setup resolves,
            // so adoptedWindowRef is still null there and this no-ops.
            if (adoptedWindowRef.current) {
                pipSetupPromise = null;
                try { adoptedWindowRef.current.close(); } catch { /* already closed */ }
                adoptedWindowRef.current = null;
            }
        };
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
  const actualTier = (license?.tier ?? 'free') as 'free' | 'basic' | 'pro' | 'max' | 'ultra';
  const gates = FEATURE_GATES[tier];
  const onTrial = licenseService.isTrialActive(license);
  // Plan state for MESSAGING (licenseService.getPlanState):
  //   timeExhausted — plan valid, live balance 0. Paid tiers KEEP every
  //                   feature (models, Pop-out); only live use is blocked,
  //                   with a "top up" prompt — never "upgrade".
  //   planLapsed    — calendar expiry / cancel / refund / revoke. Features
  //                   revert to Free (tier above resolves 'free'); prompts
  //                   say "renew", never mislabeling a paying customer.
  const planState = licenseService.getPlanState(license);

  return {
    tier,
    actualTier,
    planLapsed: planState === 'lapsed',
    timeExhausted: planState === 'time_exhausted',
    isMax: tier === 'max',
    isPro: tier === 'pro',
    isBasic: tier === 'basic',
    isFree: tier === 'free',
    onTrial,
    allowedModels: gates.models,
    canScreenCapture: gates.screenCapture,
    canAutoSolve: gates.autoSolve,
    canAutoType: gates.autoType,
    // Whether the user can choose anything other than 'none' reasoning effort
    // for GPT. Server enforces tier-gating regardless (JWT check), so this
    // flag drives UI affordance only — no security weight on its own.
    canChooseReasoningEffort: gates.reasoningEffortControl,
    canPopout: gates.popout,
    maxContextFiles: gates.contextFiles,
    maxSessions: gates.sessionsPerMonth,
    canExportHistory: gates.exportHistory,
    canUseModel: (model: string) => gates.models.includes(model),
    getDefaultModel: () => gates.models[0] || 'gemini',
  };
}

// ── MODEL_REGISTRY ──
// Single source of truth for model display metadata across all three pickers
// (popout header dropdown, input-area chip popover, settings panel cards).
// Previously each surface drifted its own copy/colors — popout said "GPT",
// input said "GPT-5.5", settings said something else again.
//
// `tier` here is the MINIMUM tier that can use the model — gates
// (FEATURE_GATES.models in licenseService) remain authoritative for the
// can-use check; this is purely display: which lock badge to show, how
// rich a treatment the card gets, and which upgrade tier to point users
// at when they click a locked card.
type ModelKey = 'gemini' | 'groq' | 'openai' | 'xai' | 'claude';

interface ModelMeta {
  short: string;          // Compact label for popout header (≤7 chars)
  label: string;          // Full label for settings cards
  monogram: string;       // 1-char glyph — kept as accessibility/fallback text
                          // for the icon's aria-label / screen-reader audiences,
                          // and as a last-resort visual if the SVG ever fails
                          // to load. Not rendered visually anymore.
  Icon: React.ComponentType<{ size?: number | string }>;
                          // Provider brand mark — replaces the prior
                          // monogram-letter render. See ProviderIcons.tsx
                          // for the SVG components and design notes.
  tier: 'free' | 'basic' | 'pro' | 'max';
  brand: { fg: string; chip: string; accent: string };
  tagline: string;        // One-line description on the rich card
  badge?: { text: string; kind: 'recommended' | 'flagship' };
}

const MODEL_REGISTRY: Record<ModelKey, ModelMeta> = {
  gemini: {
    short: 'Gemini',
    label: 'Gemini 3.5 Flash',
    monogram: 'G',
    Icon: GeminiIcon,
    tier: 'free',
    brand: { fg: '#60a5fa', chip: 'rgba(59, 130, 246, 0.18)', accent: '#3b82f6' },
    tagline: 'Google’s frontier Flash — fast, free on every plan.',
  },
  groq: {
    short: 'Groq',
    label: 'GPT-OSS 120B · Groq',
    monogram: 'Q',
    Icon: GroqIcon,
    tier: 'basic',
    brand: { fg: '#fb923c', chip: 'rgba(249, 115, 22, 0.18)', accent: '#f97316' },
    tagline: 'OpenAI’s open model on Groq silicon — sub-second answers.',
  },
  openai: {
    short: 'GPT',
    label: 'GPT-5.5',
    monogram: '5',
    Icon: OpenAIIcon,
    tier: 'basic',
    brand: { fg: '#34d399', chip: 'rgba(16, 185, 129, 0.18)', accent: '#10b981' },
    tagline: 'OpenAI flagship — best for code and system design.',
    badge: { text: 'Recommended', kind: 'recommended' },
  },
  xai: {
    short: 'Grok',
    label: 'Grok 4.3',
    monogram: 'X',
    Icon: GrokIcon,
    tier: 'basic',
    brand: { fg: '#e4e4e7', chip: 'rgba(228, 228, 231, 0.16)', accent: '#a1a1aa' },
    tagline: 'xAI’s flagship — real-time knowledge, fastest Grok yet.',
  },
  claude: {
    short: 'Claude',
    label: 'Claude Sonnet 5',
    monogram: 'C',
    Icon: ClaudeIcon,
    // 2026-07 pricing: Claude unlocks at Pro (Basic is the only paid tier
    // without it). The flagship CARD treatment is keyed on the model key,
    // not this tier — see isFlagship in ModelPickerCard.
    tier: 'pro',
    // Flagship card uses CSS-driven gold/cream tokens (see .mp-card-max in
    // index.html); these brand fields are kept for any non-card surface
    // that still references them inline.
    brand: { fg: '#e9c876', chip: 'rgba(201, 165, 92, 0.16)', accent: '#c9a55c' },
    tagline: 'Live web search mid-answer — the flagship, from Pro up.',
    badge: { text: 'Flagship', kind: 'flagship' },
  },
};

const MODEL_ORDER: ModelKey[] = ['gemini', 'groq', 'openai', 'xai', 'claude'];

// ── Provider-outage detection + model fallback ──
// When a model's UPSTREAM provider is having a problem (Google/OpenAI/xAI/Groq
// returning 403 "denied access", 5xx, or a rate-limit) the user shouldn't see a
// raw JSON error mid-interview. Instead we detect an outage, switch to another
// model the user is allowed to use, and silently retry the same question.
//
// This is deliberately NARROW: it must NOT swallow paywall/tier/auth problems
// (those need the existing upgrade/paywall UX, not a model swap) or user aborts.
// It only fires for transient upstream provider failures.
function looksLikeProviderOutage(rawMessage: string | undefined): boolean {
  if (!rawMessage) return false;
  const m = rawMessage.toLowerCase();
  // Never treat these as outages — they have their own handled paths.
  if (m.includes('tier_required') || m.includes('requires') ||
      m.includes('upgrade') || m.includes('trial') ||
      m.includes('used up') || m.includes('paywall') ||
      m.includes('no active license') || m.includes('not active') ||
      m.includes('expired') || m.includes('time is used')) {
    return false;
  }
  return (
    // Google Gemini "project denied access" (the exact error seen in prod).
    m.includes('denied access') ||
    m.includes('permission_denied') ||
    // Generic upstream signatures the proxy surfaces.
    m.includes('service error') ||
    m.includes('server error') ||
    m.includes('rate limit') || m.includes('rate-limit') || m.includes('rate limited') ||
    m.includes('overloaded') ||
    m.includes('unavailable') ||
    m.includes('forbidden') ||
    m.includes('request too large') ||
    m.includes('service problem') ||
    m.includes('quota')
  );
}

// Pick the best alternative model to fall back to after `failed` errored.
// Preference order favors the most reliable general-purpose models first, and
// is filtered to what THIS user is allowed to use (trial/Basic get the four
// non-Claude models; Pro+ can also land on Claude). Returns null if there's no
// other usable model (caller then shows the plain error).
const FALLBACK_PREFERENCE: ModelKey[] = ['openai', 'xai', 'gemini', 'groq', 'claude'];
function pickFallbackModel(failed: string, allowedModels: string[]): ModelKey | null {
  for (const cand of FALLBACK_PREFERENCE) {
    if (cand === failed) continue;
    if (allowedModels.includes(cand)) return cand;
  }
  return null;
}

// Lock-badge text shown on a model the current user cannot access. We
// collapse Basic/Pro into a single "PRO" prompt because Pro is the
// headline upgrade — Basic is the cheap credit-pack and rarely the path
// most Free users want when they see a locked model.
function lockBadgeFor(modelTier: ModelMeta['tier']): 'PRO' | 'MAX' | null {
  if (modelTier === 'max') return 'MAX';
  if (modelTier === 'basic' || modelTier === 'pro') return 'PRO';
  return null;
}

// ── UsagePanel (Settings → Usage tab) ──
// Consumption TUBE: empty at 0% used, fills left→right with exact used time
// as a % of the plan grant. Math:
//   granted  = summary.granted_seconds  (server: plan window / FREE_TRIAL)
//   remaining = live clock when available, else summary.remaining_seconds
//   used     = clamp(granted - remaining, 0, granted)
//   usedPct  = used / granted * 100
// Same ledger as the interview clock (GET /usage/summary + creditTimerService).

function formatUsageDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s === 0) return '0s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatUsageExpire(ts?: number): string | null {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return null;
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return null;
  }
}

function UsagePanel({ tier, onRenew }: { tier: string; onRenew: () => void }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Live remaining from creditTimerService / cached license. Always seeded on
  // mount (works even when the session clock is idle).
  const [liveRemaining, setLiveRemaining] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchUsageSummary().then(s => { if (alive) { setSummary(s); setLoading(false); } });
    };
    setLoading(true);
    load();
    // Re-fetch periodically so a mid-tab renewal/top-up updates the grant.
    const poll = window.setInterval(load, 20_000);

    const readClock = () => {
      const v = creditTimerService.getRemainingSeconds();
      // Infinity (unlimited) must not drive the tube.
      if (Number.isFinite(v) && v >= 0) setLiveRemaining(v);
      else if (v === Infinity) setLiveRemaining(null);
    };
    readClock();
    const offs = [
      creditTimerService.on('tick', readClock),
      creditTimerService.on('started', (p: any) => {
        readClock();
        // Fresh grant/remaining after a new session opens.
        if (typeof p?.remainingSeconds === 'number' && Number.isFinite(p.remainingSeconds)) {
          setLiveRemaining(Math.max(0, p.remainingSeconds));
        }
        load();
      }),
      creditTimerService.on('stopped', () => { readClock(); load(); }),
      creditTimerService.on('exhausted', () => { setLiveRemaining(0); load(); }),
    ];
    return () => {
      alive = false;
      window.clearInterval(poll);
      offs.forEach(off => off());
    };
  }, []);

  const pillTier = (summary?.tier || tier || 'free').toUpperCase();
  const unlimited = !!summary?.unlimited;

  // ── Exact consumption math (metered only) ──
  const granted = !summary || unlimited ? 0 : Math.max(0, summary.granted_seconds ?? 0);
  const remainingRaw = !summary || unlimited
    ? 0
    : (liveRemaining !== null ? liveRemaining : (summary.remaining_seconds ?? 0));
  const remaining = Math.max(0, Math.min(granted > 0 ? granted : remainingRaw, remainingRaw));
  // used fills the tube: empty when unused, full at 100% of plan.
  const used = granted > 0
    ? Math.max(0, Math.min(granted, granted - remaining))
    : Math.max(0, summary?.used_seconds ?? 0);
  const usedPct = granted > 0
    ? Math.min(100, Math.round((used / granted) * 1000) / 10)
    : 0;
  // Prefer server percent only when idle and no live override yet (same math).
  const displayPct = liveRemaining === null && typeof summary?.used_percent === 'number'
    ? summary.used_percent
    : usedPct;

  const high = displayPct >= 92;
  const mid = displayPct >= 75 && !high;
  const expireLabel = formatUsageExpire(summary?.credits_expire_at);
  const windowLabel = summary?.source === 'trial'
    ? 'Free trial window'
    : summary?.source === 'credits'
      ? 'Current plan window'
      : 'Plan window';

  const liquid = high
    ? 'linear-gradient(90deg, #f87171 0%, #ef4444 55%, #dc2626 100%)'
    : mid
      ? 'linear-gradient(90deg, #fbbf24 0%, #d3ac63 60%, #b58f45 100%)'
      : 'linear-gradient(90deg, #f6e4b0 0%, #d3ac63 50%, #b58f45 100%)';

  return (
    <div className="space-y-4">
      <div
        className="rounded-[16px] overflow-hidden border border-black/[0.06] dark:border-white/[0.08]"
        style={{ background: 'var(--surface-color, rgba(255,255,255,0.04))' }}
      >
        <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-8 h-8 rounded-[9px] flex items-center justify-center shrink-0"
              style={{
                background: 'linear-gradient(160deg, #f6e4b0 0%, #d3ac63 50%, #b58f45 100%)',
                boxShadow: '0 1px 0 rgba(255,255,255,0.35) inset, 0 4px 12px rgba(211,172,99,0.22)',
              }}
            >
              <Gauge size={15} className="text-[#241b08]" strokeWidth={2.25} />
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-text tracking-tight">Interview time</div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{windowLabel}</div>
            </div>
          </div>
          <span className="shrink-0 text-[10px] font-semibold tracking-[0.1em] uppercase text-gray-500 dark:text-gray-300 bg-black/[0.05] dark:bg-white/[0.06] px-2.5 py-1 rounded-full border border-black/[0.06] dark:border-white/10">
            {pillTier === 'ADMIN' ? 'ADMIN' : pillTier}
          </span>
        </div>

        <div className="px-4 pb-5">
          {loading ? (
            <div className="space-y-4 animate-pulse py-2" aria-hidden="true">
              <div className="flex flex-col items-center gap-2 py-3">
                <div className="h-10 w-28 rounded-xl bg-black/10 dark:bg-white/10" />
                <div className="h-3 w-20 rounded bg-black/[0.06] dark:bg-white/[0.06]" />
              </div>
              <div className="h-5 w-full rounded-full bg-black/10 dark:bg-white/10" />
            </div>
          ) : !summary ? (
            <p className="text-center text-[13px] text-gray-500 py-8">
              Usage is unavailable right now.
            </p>
          ) : unlimited ? (
            <div className="pt-1 space-y-4">
              <div className="text-center py-2">
                <div className="text-[34px] font-semibold tracking-tight text-text leading-none" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  Unlimited
                </div>
                <div className="text-[13px] text-gray-500 dark:text-gray-400 mt-1.5">No time cap on this plan</div>
              </div>
              <div
                className="relative h-5 rounded-full overflow-hidden"
                style={{
                  background: 'linear-gradient(90deg, #f6e4b0 0%, #d3ac63 50%, #b58f45 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1px 2px rgba(0,0,0,0.15)',
                }}
              >
                <div className="absolute inset-x-0 top-0 h-[45%] rounded-full bg-gradient-to-b from-white/50 to-transparent pointer-events-none" />
              </div>
            </div>
          ) : (
            <div className="pt-1 space-y-4">
              {/* Hero = USED (what fills the tube) */}
              <div className="text-center py-1">
                <div
                  className={`text-[40px] font-semibold tracking-tight leading-none ${
                    high ? 'text-red-400' : mid ? 'text-amber-400' : 'text-text'
                  }`}
                  style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}
                >
                  {formatUsageDuration(used)}
                </div>
                <div className="text-[13px] text-gray-500 dark:text-gray-400 mt-1.5 font-medium">
                  used of {formatUsageDuration(granted)}
                </div>
                <div
                  className={`mt-1 text-[12px] font-semibold tabular-nums ${
                    high ? 'text-red-400/90' : mid ? 'text-amber-400/90' : 'text-[#d3ac63]'
                  }`}
                >
                  {displayPct % 1 === 0 ? `${displayPct}%` : `${displayPct.toFixed(1)}%`} of plan
                </div>
              </div>

              {/* ── Consumption TUBE ──
                  Hollow track when unused; liquid fills left→right with used %. */}
              <div className="space-y-2">
                <div
                  className="relative h-5 rounded-full overflow-hidden"
                  role="progressbar"
                  aria-valuenow={displayPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${displayPct} percent of plan used`}
                  style={{
                    // Empty glass tube
                    background:
                      'linear-gradient(180deg, rgba(0,0,0,0.22) 0%, rgba(120,120,128,0.14) 40%, rgba(120,120,128,0.20) 100%)',
                    boxShadow:
                      'inset 0 2px 4px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(255,255,255,0.06)',
                  }}
                >
                  {/* Inner bore highlight (empty tube lip) */}
                  <div
                    className="absolute inset-[2px] rounded-full pointer-events-none"
                    style={{
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
                      background: displayPct <= 0
                        ? 'linear-gradient(180deg, rgba(255,255,255,0.04), transparent 50%)'
                        : 'transparent',
                    }}
                  />

                  {/* Liquid fill — exact used % */}
                  <div
                    className="absolute inset-y-[2px] left-[2px] rounded-full transition-[width] duration-500 ease-out"
                    style={{
                      width: displayPct <= 0 ? 0 : `calc(${displayPct}% - 4px)`,
                      maxWidth: 'calc(100% - 4px)',
                      background: liquid,
                      boxShadow:
                        displayPct > 0
                          ? 'inset 0 1px 0 rgba(255,255,255,0.45), 0 0 8px rgba(211,172,99,0.25)'
                          : undefined,
                    }}
                  >
                    {/* Surface gloss */}
                    <div className="absolute inset-x-0 top-0 h-[48%] rounded-full bg-gradient-to-b from-white/55 to-transparent pointer-events-none" />
                    {/* Meniscus at the fill edge */}
                    {displayPct > 2 && displayPct < 99.5 && (
                      <div
                        className="absolute right-0 top-0 bottom-0 w-2.5 rounded-r-full pointer-events-none"
                        style={{
                          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.28))',
                        }}
                      />
                    )}
                  </div>

                  {/* Centered % chip on the tube when there's room */}
                  {displayPct >= 18 && (
                    <div
                      className="absolute inset-0 flex items-center justify-center pointer-events-none"
                      style={{ fontSize: 10, fontWeight: 700, color: 'rgba(36,27,8,0.85)', letterSpacing: '0.02em' }}
                    >
                      {displayPct % 1 === 0 ? `${displayPct}%` : `${displayPct.toFixed(1)}%`}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between text-[11px] tabular-nums text-gray-500">
                  <span>{displayPct <= 0 ? 'Empty · nothing used yet' : `${formatUsageDuration(used)} used`}</span>
                  <span>{formatUsageDuration(remaining)} left</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {!loading && summary && (
        <div
          className="rounded-[16px] overflow-hidden border border-black/[0.06] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.08]"
          style={{ background: 'var(--surface-color, rgba(255,255,255,0.04))' }}
        >
          {!unlimited && (
            <>
              <div className="flex items-center justify-between px-4 py-3.5">
                <span className="text-[15px] text-text">Plan grant</span>
                <span className="text-[15px] text-gray-500 tabular-nums">{formatUsageDuration(granted)}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3.5">
                <span className="text-[15px] text-text">Used</span>
                <span className="text-[15px] text-gray-500 tabular-nums">
                  {formatUsageDuration(used)}
                  <span className="text-gray-600 ml-1.5">
                    ({displayPct % 1 === 0 ? `${displayPct}%` : `${displayPct.toFixed(1)}%`})
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between px-4 py-3.5">
                <span className="text-[15px] text-text">Remaining</span>
                <span className="text-[15px] text-gray-500 tabular-nums">{formatUsageDuration(remaining)}</span>
              </div>
            </>
          )}
          <div className="flex items-center justify-between px-4 py-3.5">
            <span className="text-[15px] text-text">Interviews</span>
            <span className="text-[15px] text-gray-500 tabular-nums">{summary.session_count}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3.5">
            <span className="text-[15px] text-text">All-time use</span>
            <span className="text-[15px] text-gray-500 tabular-nums">
              {formatUsageDuration(summary.lifetime_used_seconds)}
            </span>
          </div>
          {expireLabel && !unlimited && (
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-[15px] text-text">Credits expire</span>
              <span className="text-[15px] text-gray-500 tabular-nums">{expireLabel}</span>
            </div>
          )}
          {summary.source === 'trial' && !unlimited && (
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-[15px] text-text">Window</span>
              <span className="text-[15px] text-gray-500">10-min free trial</span>
            </div>
          )}
        </div>
      )}

      {!loading && summary && !unlimited && (
        <button
          type="button"
          onClick={onRenew}
          className="w-full py-3.5 rounded-[14px] text-[15px] font-semibold text-[#241b08] transition-transform active:scale-[0.98]"
          style={{
            background: 'linear-gradient(180deg, #f0d78a 0%, #d3ac63 48%, #b8963f 100%)',
            boxShadow: '0 1px 0 rgba(255,255,255,0.35) inset, 0 6px 16px rgba(211,172,99,0.28)',
          }}
        >
          {summary.source === 'trial' ? 'Get more time' : 'Renew to add time'}
        </button>
      )}

      <p className="text-center text-[11px] text-gray-500 px-2 leading-relaxed">
        Tube fills only when interview time is charged (listening or generating).
      </p>
    </div>
  );
}

// ── ModelPickerCard ──
// Unified card used by all three model pickers. variant='compact' is the
// dense row in the popout/input popover; variant='full' is the rich card
// in the settings panel. The `compact` prop on the full variant shrinks
// padding + monogram + hides the tagline, so four non-Max cards fit in a
// 2x2 grid above Claude's full-width showcase without overflowing the
// settings modal. Locked cards stay visible (so the user can see what's
// gated) but click-through to onLockedClick — caller wires that to the
// ManageSubscription modal so the picker doubles as a sales surface,
// instead of being silently inert for non-subscribers.
function ModelPickerCard({
  modelKey,
  selected,
  allowed,
  variant,
  compact = false,
  onSelect,
  onLockedClick,
}: {
  modelKey: ModelKey;
  selected: boolean;
  allowed: boolean;
  variant: 'compact' | 'full';
  /** Only meaningful when variant='full' — renders a denser 2-col-grid
   *  card (smaller monogram, no tagline). Used for non-Max models in the
   *  settings panel so the full-width Claude card stays the showcase. */
  compact?: boolean;
  onSelect: () => void;
  onLockedClick?: () => void;
}) {
  const meta = MODEL_REGISTRY[modelKey];
  // Flagship (gold) card treatment is keyed on the MODEL, not its gate tier —
  // Claude unlocks at Pro (2026-07 pricing) but stays the visual flagship.
  const isMax = modelKey === 'claude';
  const lockBadge = !allowed ? lockBadgeFor(meta.tier) : null;
  const handleClick = () => {
    if (allowed) onSelect();
    else onLockedClick?.();
  };

  if (variant === 'compact') {
    return (
      <div
        role="option"
        aria-selected={selected}
        aria-disabled={!allowed}
        onClick={handleClick}
        className={`mp-row${isMax ? ' mp-row-max' : ''}${selected ? ' is-selected' : ''}${!allowed ? ' is-locked' : ''}`}
      >
        <span
          className={`mp-mono${isMax ? ' mp-mono-max' : ''}`}
          style={!isMax ? {
            background: meta.brand.chip,
            color: meta.brand.fg,
            borderColor: meta.brand.accent,
          } : undefined}
          aria-label={meta.short}
          role="img"
        >
          <meta.Icon size={12} />
        </span>
        <span className="mp-name">{meta.short}</span>
        {selected && <Check size={9} className="mp-check" aria-hidden="true" />}
        {lockBadge && (
          <span className={`mp-locked${isMax ? ' mp-locked-max' : ''}`}>{lockBadge}</span>
        )}
      </div>
    );
  }

  // variant === 'full' — settings panel rich card
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`mp-card${isMax ? ' mp-card-max' : ''}${compact ? ' is-compact' : ''}${selected ? ' is-selected' : ''}${!allowed ? ' is-locked' : ''}`}
      style={!isMax ? {
        // Brand-color hairline left rail + accent on selected
        ['--mp-accent' as any]: meta.brand.accent,
        ['--mp-fg' as any]: meta.brand.fg,
        ['--mp-chip' as any]: meta.brand.chip,
      } : undefined}
      aria-pressed={selected}
    >
      <span className={`mp-card-mono${isMax ? ' mp-card-mono-max' : ''}`} aria-label={meta.short} role="img">
        <meta.Icon size={compact ? 18 : 22} />
      </span>
      <span className="mp-card-body">
        <span className="mp-card-title">
          <span className="mp-card-name">{meta.label}</span>
          {meta.badge && allowed && (
            <span className={`mp-card-badge mp-card-badge-${meta.badge.kind}`}>
              {meta.badge.kind === 'flagship' && <span aria-hidden="true">✦</span>}
              {meta.badge.text}
            </span>
          )}
        </span>
        <span className="mp-card-tag">{meta.tagline}</span>
      </span>
      <span className="mp-card-right">
        {selected ? (
          <span className={`mp-card-active${isMax ? ' mp-card-active-max' : ''}`}>
            <span className="mp-live-dot" aria-hidden="true" /> Active
          </span>
        ) : !allowed ? (
          <span className={`mp-card-lock${isMax ? ' mp-card-lock-max' : ''}`}>
            {isMax ? <span aria-hidden="true">✦</span> : null}
            {lockBadge}
          </span>
        ) : null}
      </span>
    </button>
  );
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

// ── TimeTubeGauge ──
// Miniature of the Settings Usage card's iOS consumption tube, sized for
// the live interview-time chips: inset glass groove, glossy gold liquid
// that fills left→right with USED time (empty when unused). Math mirrors
// the Usage card exactly: used = clamp(granted - remaining, 0, granted).
//
// FAIL-SOFT BY CONTRACT (live-interview product): renders NOTHING unless
// both bounds are known finite positives. Unknown grant (summary offline /
// null), unlimited plans (granted=Infinity or remaining=Infinity), and any
// malformed value all fall through to null — the chip then renders exactly
// as it did before this gauge existed. Never a spinner, never an error.
function TimeTubeGauge({ granted, remaining, width = 34 }: {
  granted: number | null | undefined;
  remaining: number;
  width?: number;
}) {
  if (typeof granted !== 'number' || !Number.isFinite(granted) || granted <= 0) return null;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) return null;
  const used = Math.max(0, Math.min(granted, granted - remaining));
  const pct = Math.max(0, Math.min(100, (used / granted) * 100));
  return (
    <span
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${Math.round(pct)} percent of interview time used`}
      className="relative inline-block rounded-full overflow-hidden shrink-0"
      style={{
        width,
        height: 5,
        // Empty glass groove — same inset treatment as the Usage card tube.
        background: 'linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(120,120,128,0.16) 100%)',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.07)',
      }}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
        style={{
          width: pct <= 0 ? 0 : `${pct}%`,
          background: 'linear-gradient(90deg, #f6e4b0 0%, #d3ac63 50%, #b58f45 100%)',
          boxShadow: pct > 0 ? 'inset 0 1px 0 rgba(255,255,255,0.45), 0 0 6px rgba(211,172,99,0.25)' : undefined,
        }}
      >
        {/* Top-half white gloss — the liquid's surface highlight */}
        <span className="absolute inset-x-0 top-0 h-1/2 rounded-full bg-gradient-to-b from-white/55 to-transparent pointer-events-none" />
      </span>
    </span>
  );
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
  // ── Plan-window grant (drives the interview-time tube gauge) ──
  // granted_seconds from GET /usage/summary — the SAME plan-window anchor
  // the Settings Usage card renders, so the header tube and the card can
  // never disagree. null = unknown (offline / summary unavailable / not
  // fetched yet); Infinity = unlimited plan. Consumers MUST fail soft on
  // null: render the plain chip exactly as before, no tube.
  const [granted, setGranted] = useState<number | null>(null);

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

  // Fetch the plan-window grant once per session boundary (started/stopped)
  // plus one seed on mount, and cache it in state — NOT on every tick. The
  // grant only moves on purchase/top-up, so this stays cheap. FAIL-SOFT BY
  // CONTRACT: fetchUsageSummary never throws and returns null on any
  // failure; on null we KEEP the last known value (or stay null) so a
  // network blip mid-interview can never blank or break the timer chip —
  // the tube simply doesn't render until the grant is known.
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void fetchUsageSummary().then(s => {
        if (!alive || !s) return; // fail-soft: keep last known grant
        if (s.unlimited) { setGranted(Infinity); return; }
        setGranted(
          typeof s.granted_seconds === 'number' && Number.isFinite(s.granted_seconds) && s.granted_seconds > 0
            ? s.granted_seconds
            : null
        );
      });
    };
    refresh(); // seed before the first session so the tube can show pre-interview
    const offs = [
      creditTimerService.on('started', refresh),
      creditTimerService.on('stopped', refresh),
    ];
    return () => { alive = false; offs.forEach(off => off()); };
  }, []);

  // Start/stop mirror the mic — DEBOUNCED on the stop side. `isListening` is
  // Deepgram's raw socket state, which flickers false→true on every reconnect
  // (network blip). Without debouncing, each flicker would cycle
  // creditTimerService.start()/stop() — churning the server billing session
  // and re-firing the low-time toast. Start immediately; defer the stop ~8s so
  // a quick reconnect cancels it (start() then no-ops since the timer's still
  // running → continuous session). A real user-stop still settles within 8s,
  // and the server's stale-session sweeper backstops anything longer.
  const stopDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isListening) {
      if (stopDebounceRef.current) { clearTimeout(stopDebounceRef.current); stopDebounceRef.current = null; }
      void creditTimerService.start();
    } else {
      if (stopDebounceRef.current) clearTimeout(stopDebounceRef.current);
      stopDebounceRef.current = setTimeout(() => {
        stopDebounceRef.current = null;
        creditTimerService.stop();
      }, 8000);
    }
  }, [isListening]);
  // Settle the timer on FINAL unmount only (empty deps → cleanup runs once).
  // Kept separate from the effect above so a reconnect's dep-change cleanup
  // can't fire an immediate stop and defeat the debounce.
  useEffect(() => () => {
    if (stopDebounceRef.current) { clearTimeout(stopDebounceRef.current); stopDebounceRef.current = null; }
    creditTimerService.stop();
  }, []);

  const acknowledgeHourBoundary = useCallback((decision: 'continue' | 'stop') => {
    creditTimerService.acknowledgeHourBoundary(decision);
    setHourBoundary(false);
    if (decision === 'stop') forceStopRef.current();
  }, []);

  return {
    remaining,
    source,
    granted,
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
        You've been live for 60 minutes. You have <span className="text-emerald-400 font-semibold">{formatTimeRemaining(remainingSeconds)}</span> of interview time left on your plan. Continuing will start your next interview hour.
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

// ── Low-warning toast — fires at T-2 minutes with a one-click extend.
// The lead time (owner spec 2026-07: "a min or 2 before" expiry —
// LOW_WARNING_SECONDS=120) exists exactly so a running-long interview
// can be extended BEFORE the clock dies: one click charges the card on
// file and the timer jumps by the PLAN'S unit (Basic +30 min · $25,
// Pro/Max +1 hour · $45) without leaving the call. Renders on whichever
// window the user is on: main mounts it directly; the popout mirrors it
// via the credit-sync IPC push and relays Extend/Dismiss back to main
// (see the isPopoutElectron render path + cmd-credit-* handlers).
const LowWarningToast = ({ remainingSeconds, actualTier, countryCode, onDismiss, onExtend }: {
  remainingSeconds: number;
  actualTier: 'free' | 'basic' | 'pro' | 'max' | 'ultra';
  countryCode: string;
  onDismiss: () => void;
  onExtend?: (packId?: string) => void;
}) => {
  const [selectedPack, setSelectedPack] = React.useState('m30');
  useEffect(() => {
    const t = setTimeout(onDismiss, 20000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  const packs = getExtensionPacks(countryCode);
  return (
    <div className="fixed top-20 right-6 z-[95] max-w-xs px-4 py-3 rounded-xl bg-amber-500/[0.12] border border-amber-500/40 text-amber-300 text-sm font-medium shadow-xl backdrop-blur-sm">
      <div className="flex items-center gap-3 mb-2">
        <AlertTriangle size={16} className="shrink-0" />
        <span><b>{formatTimeRemaining(remainingSeconds)}</b> left. Running long?</span>
        <button onClick={onDismiss} className="text-amber-400 hover:text-amber-200 ml-auto"><X size={14} /></button>
      </div>
      {onExtend && (
        <>
          <div className="flex gap-1 mb-2">
            {packs.map(p => (
              <button key={p.id} onClick={() => setSelectedPack(p.id)}
                className={"flex-1 px-1 py-1 rounded text-[10px] font-bold border transition-all " + (selectedPack === p.id ? "bg-emerald-500/30 border-emerald-500/60 text-emerald-200" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20")}>
                {p.label}
              </button>
            ))}
          </div>
          <button onClick={() => { onExtend(selectedPack); onDismiss(); }}
            className="w-full px-2 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/30 transition-all">
            {(() => { const p = packs.find(x => x.id === selectedPack) || packs[0]; return p.label + ' · ' + p.currencySymbol + p.price; })()}
          </button>
        </>
      )}
    </div>
  );
};

// ── Plan / trial expiry notice (2026-07) ──
// Non-blocking, dismissible toast shown ONCE per distinct expiry state.
// Four states, computed from the license row the same way the gates are:
//   trial_used_up  — free tier, trial bucket at 0 (post-trial paywall)
//   expiring_soon  — paid tier, soonest of expires_at / credits_expire_at
//                    lands within EXPIRY_WARNING_DAYS (covers the Ultra
//                    monthly sub and every dated one-time plan)
//   time_used_up   — metered paid tier (Basic/Pro/Max), plan window still
//                    VALID but the interview clock is at 0 → TOP-UP copy.
//                    The tier's features persist; only live use is blocked.
//   plan_ended     — plan LAPSED (past expires_at, or a dead status:
//                    expired/refunded/revoked/paused/disputed) → RENEW
//                    copy. This — never mere time exhaustion — is what
//                    reverts features to Free.
// Fingerprints embed the license key + deadline so a renewal (new
// expires_at) or a top-up (new credits_expire_at) re-arms the warning
// while the SAME state never re-nags.
// -1 sentinels (never-expires / comp licenses) produce no notice.
const EXPIRY_WARNING_DAYS = 3;

type PlanNotice = {
  kind: 'trial_used_up' | 'expiring_soon' | 'plan_ended' | 'time_used_up';
  fingerprint: string;
  message: string;
  cta: string;
};

function computePlanNotice(license: LicenseData | null): PlanNotice | null {
  if (!license) return null;
  // Admins never get plan/expiry nags. They resolve to full Ultra access via
  // getEffectiveTier's is_admin short-circuit (before any license check), so a
  // placeholder admin license row that happens to be an EXPIRED ultra/paid tier
  // must not surface a "plan ended / expiring" toast. The tier heuristic below
  // (effectiveTier==='ultra' && tier!=='ultra') only catches admins whose row
  // tier isn't 'ultra'; this closes the gap when the row IS an expired ultra.
  try { if (licenseService.loadAuth().user?.is_admin) return null; } catch { /* localStorage unavailable */ }
  const now = Date.now();
  const tier = license.tier;
  const effectiveTier = licenseService.getEffectiveTier(license);
  // Admins resolve to 'ultra' (or their explicit test-tier override) —
  // never nag an admin about a placeholder license row.
  if (effectiveTier === 'ultra' && tier !== 'ultra') return null;

  if (tier === 'basic' || tier === 'pro' || tier === 'max' || tier === 'ultra') {
    const label = tier.charAt(0).toUpperCase() + tier.slice(1);
    // Ended = plan LAPSE only (calendar expiry, cancel completion, refund,
    // revoke — the same predicate the tier gates use, so this toast can
    // never call a still-valid plan "ended"). This is how the Ultra
    // monthly shows up once it lapses. The copy says RENEW — the user
    // already bought this plan; "upgrade" would mislabel them.
    if (licenseService.isPlanLapsed(license)) {
      return {
        kind: 'plan_ended',
        fingerprint: `plan_ended:${license.key}:${license.expires_at || 0}`,
        message: `Your ${label} plan has ended — renew to continue.`,
        cta: 'Renew',
      };
    }
    // Metered tiers (Basic/Pro/Max) with the interview clock at 0 while
    // the plan window is still VALID: top-up prompt. Features persist —
    // this is deliberately NOT "plan ended". Fingerprint keys on
    // credits_expire_at, which every top-up pushes forward, so a
    // re-exhaustion after a top-up re-arms while the same empty state
    // never re-nags. (Unlimited/comp licenses report Infinity and never
    // land here; admins resolve out at the effectiveTier guard above.)
    if (tier !== 'ultra') {
      const bal = licenseService.getLiveTimeBalance(license);
      if (bal.source === 'credits' && bal.seconds <= 0) {
        return {
          kind: 'time_used_up',
          fingerprint: `time_used_up:${license.key}:${license.credits_expire_at || 0}`,
          message: `Your ${label} interview time is used up — top up minutes to keep going. Your plan keeps its models and Pop-out.`,
          cta: 'Top up',
        };
      }
    }
    // Nearing expiry: soonest applicable deadline within the window.
    // Ultra has no credit window; metered tiers warn on whichever of
    // expires_at / credits_expire_at comes first. -1 sentinels and 0
    // (unset) are filtered by the `> now` guard.
    const candidates = [
      license.expires_at,
      tier !== 'ultra' ? (license.credits_expire_at ?? 0) : 0,
    ].filter((t): t is number => typeof t === 'number' && t > now);
    const deadline = candidates.length ? Math.min(...candidates) : 0;
    if (deadline > 0 && deadline - now <= EXPIRY_WARNING_DAYS * 86400000) {
      const days = Math.max(1, Math.ceil((deadline - now) / 86400000));
      return {
        kind: 'expiring_soon',
        fingerprint: `expiring_soon:${license.key}:${deadline}`,
        message: days === 1
          ? `Your ${label} plan expires within a day — renew to continue.`
          : `Your ${label} plan expires in ${days} days — renew to continue.`,
        cta: 'Renew',
      };
    }
    return null;
  }

  // Free tier: post-trial paywall state (trial bucket at 0; undefined on
  // a legacy row also reads as 0 — either way there is nothing usable).
  if (tier === 'free' && effectiveTier === 'free'
      && licenseService.getTrialRemainingSeconds(license) <= 0) {
    return {
      kind: 'trial_used_up',
      fingerprint: `trial_used_up:${license.key}`,
      message: 'Your free 10-minute trial is used up — upgrade to keep going.',
      cta: 'See plans',
    };
  }
  return null;
}

// Toast shell — same anchor + capsule language as LowWarningToast (amber
// obsidian card, top-right, backdrop blur), with the gold CTA treatment
// from the Usage card. Non-blocking by design: it never traps focus and
// never times anything out on its own.
const PlanExpiryNotice = ({ message, cta, onCta, onDismiss }: {
  message: string;
  cta: string;
  onCta: () => void;
  onDismiss: () => void;
}) => (
  <div
    role="status"
    className="fixed top-20 right-6 z-[94] max-w-xs px-4 py-3 rounded-xl bg-amber-500/[0.12] border border-amber-500/40 text-amber-200 text-sm font-medium shadow-xl backdrop-blur-sm"
  >
    <div className="flex items-start gap-3">
      <Crown size={16} className="shrink-0 mt-0.5 text-[#d3ac63]" />
      <span className="leading-snug">{message}</span>
      <button onClick={onDismiss} className="text-amber-400 hover:text-amber-200 ml-auto shrink-0" aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
    <button
      onClick={onCta}
      className="mt-2.5 w-full px-2 py-1.5 rounded-lg text-[11px] font-bold text-[#241b08] transition-transform active:scale-[0.98]"
      style={{
        background: 'linear-gradient(180deg, #f0d78a 0%, #d3ac63 48%, #b8963f 100%)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.35) inset, 0 4px 10px rgba(211,172,99,0.25)',
      }}
    >
      {cta}
    </button>
  </div>
);

// ── Exhausted modal — blocking; offers the PLAN-SPECIFIC extension for
// Basic/Pro/Max (Basic +30 min · $25, Pro/Max +1 hour · $45 — see
// pricingService.getRenewalPrice), plan picker for everyone (2026-07
// model: Basic/Pro/Max are one-time interviews, Ultra is the unlimited
// monthly subscription and never reaches this modal).
const ExhaustedModal = ({
  source, actualTier, countryCode, onRenew, onUpgrade, onDismiss,
}: {
  source: 'trial' | 'credits' | 'unlimited' | 'none';
  actualTier: 'free' | 'basic' | 'pro' | 'max' | 'ultra';
  countryCode: string;
  onRenew: (packId?: string) => void;
  onUpgrade: () => void;
  onDismiss: () => void;
}) => {
  const [selectedPack, setSelectedPack] = React.useState('m30');
  const wasTrial = source === 'trial' || actualTier === 'free';
  const packs = getExtensionPacks(countryCode);
  const chosenPack = packs.find(p => p.id === selectedPack) || packs[0];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-2xl border border-red-500/30 bg-[#0a0a0f] shadow-2xl shadow-red-500/10 p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">{wasTrial ? 'Trial complete' : "You're out of interview time"}</h3>
            <p className="text-xs text-gray-500">{wasTrial ? 'Your 10-minute trial just ended.' : 'This interview\'s time has been used.'}</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 mb-5 leading-relaxed">
          {wasTrial
            ? 'Buy the interview that\'s ahead of you — a 30-minute Basic, a 1-hour Pro with all five models, or go unlimited with Ultra.'
            : ['basic', 'pro', 'max'].includes(actualTier)
              ? 'Interview running long? Pick a time pack — your card on file is charged instantly.'
              : 'Grab another interview pass, or go unlimited with Ultra.'}
        </p>
        <div className="flex flex-col gap-2">
          {!wasTrial && ['basic', 'pro', 'max'].includes(actualTier) && (
            <>
              <div className="flex gap-2 mb-1">
                {packs.map(p => (
                  <button key={p.id} onClick={() => setSelectedPack(p.id)}
                    className={"flex-1 px-2 py-2 rounded-lg text-xs font-bold border transition-all " + (selectedPack === p.id ? "bg-emerald-500/25 border-emerald-500/60 text-emerald-200" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20")}>
                    <div>{p.label}</div>
                    <div className="text-[10px] opacity-80">{p.currencySymbol}{p.price}</div>
                  </button>
                ))}
              </div>
              <button onClick={() => onRenew(selectedPack)} className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white text-sm font-bold transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2">
                <Zap size={14} />
                Extend {chosenPack.label} · {chosenPack.currencySymbol}{chosenPack.price}
              </button>
            </>
          )}
          <button onClick={onUpgrade} className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-400 hover:to-purple-400 text-white text-sm font-bold transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2">
            <Crown size={14} /> See plans
          </button>
          <button onClick={onDismiss} className="px-4 py-2 rounded-xl text-gray-500 text-xs font-medium hover:text-gray-300 transition-all">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};

// Module-scope polling state to dedupe concurrent post-checkout polls.
// Without this, a user clicking Upgrade twice (or both Renew and Upgrade
// in quick succession) would fire two simultaneous validateWithServer
// loops — wasteful, and the second would race the first to fire onSuccess.
let externalCheckoutPollActive = false;

// ── Post-checkout polling for the external-browser flow ─────────────
// When openProUpgrade hands the Stripe URL to the system browser via
// electronAPI.openExternal, the renderer never receives Stripe's
// success_url redirect — that URL loads in the user's browser, not the
// app. So we poll license/validate (the same endpoint the periodic
// revalidation tick uses) until the server reflects the new tier, then
// fire onSuccess so the caller can refresh React state from localStorage
// (validateWithServer already wrote there).
//
// 10-minute cap: most webhooks land in <30s. After that either the user
// abandoned the browser flow, the webhook stalled, or there's a routing
// mismatch (rare). Falling back to the next periodic revalidation tick
// (or app restart) reconciles regardless.
//
// Fire-and-forget — the caller doesn't await this. Buttons close their
// modals immediately; the tier badge in the chat header flips when the
// poll detects the upgrade.
async function pollForExternalUpgrade(
  targetTier: 'basic' | 'pro' | 'max' | 'ultra',
  onSuccess?: (info: { tier: string }) => void,
) {
  if (externalCheckoutPollActive) return;
  externalCheckoutPollActive = true;
  const POLL_INTERVAL_MS = 4000;
  const POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const startedAt = Date.now();
  try {
    // Initial wait — Stripe's webhook needs a moment after payment.
    await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      try {
        const updated = await licenseService.validateWithServer();
        if (updated && updated.tier === targetTier && updated.status === 'active') {
          // validateWithServer already wrote to localStorage. Mark the
          // just-purchased tier so the post-checkout welcome banner
          // surfaces, then notify the caller to refresh React state.
          try { localStorage.setItem('justPurchasedTier', updated.tier); } catch {}
          onSuccess?.({ tier: updated.tier });
          emitCheckoutStatus({
            kind: 'completed',
            tier: updated.tier,
            mode: 'subscription',
            message: `${updated.tier.toUpperCase()} activated — your plan is live.`,
          });
          return;
        }
      } catch { /* network blip — keep polling */ }
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.warn(`[openProUpgrade] poll timed out after ${POLL_TIMEOUT_MS/1000}s waiting for tier=${targetTier}`);
    emitCheckoutStatus({
      kind: 'timeout',
      tier: targetTier,
      mode: 'subscription',
      message: `Still waiting for ${targetTier.toUpperCase()} payment confirmation. If you finished checkout in your browser, restart the app to sync.`,
    });
  } finally {
    externalCheckoutPollActive = false;
  }
}

// Extensions don't change `tier` — they extend `expires_at` by the plan's
// unit (Basic +30 min, Pro/Max +1 hour) via grantTimeExtension on the
// server. We watch for a forward delta on the license's expires_at;
// validateWithServer's extension-credit propagation path lands the
// tier-sized credit locally as soon as the matching delta is detected.
// 15-min lower bound on the delta absorbs clock skew but stays well
// below the smallest unit (30 min) and well above non-extension noise.
async function pollForExternalRenewal(onSuccess?: () => void) {
  if (externalCheckoutPollActive) return;
  externalCheckoutPollActive = true;
  const POLL_INTERVAL_MS = 4000;
  const POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const RENEWAL_THRESHOLD_MS = 15 * 60 * 1000;
  const startedAt = Date.now();
  const baselineExpires = licenseService.loadAuth().license?.expires_at || 0;
  try {
    await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      try {
        const updated = await licenseService.validateWithServer();
        if (updated && (updated.expires_at || 0) >= baselineExpires + RENEWAL_THRESHOLD_MS) {
          onSuccess?.();
          emitCheckoutStatus({
            kind: 'completed',
            mode: 'renewal',
            // Amount-neutral: this poll only sees the expires_at delta, and
            // the granted unit is plan-specific (30 or 60 min).
            message: 'Extension added — your extra interview time is now available.',
          });
          return;
        }
      } catch { /* network blip */ }
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.warn(`[openProRenewal] poll timed out after ${POLL_TIMEOUT_MS/1000}s`);
    emitCheckoutStatus({
      kind: 'timeout',
      mode: 'renewal',
      message: 'Still waiting for renewal confirmation. If you finished checkout in your browser, restart the app to sync.',
    });
  } finally {
    externalCheckoutPollActive = false;
  }
}

// ── Upgrade plan — opens Stripe/Razorpay checkout in browser ──
// No native alerts inside — alert()/confirm() are OS dialogs that bypass
// setContentProtection and leak on screen share. Failures log to console;
// the Upgrade button itself is already tier-gated in render so the
// no-token branch is a defensive no-op in practice.
//
// targetTier: which plan the user clicked. Defaults to 'pro' so existing
// callers that don't pass an arg keep their behavior. Critically, this
// fixes a long-standing bug where `ManageSubscription`'s "Upgrade to Max"
// button went through here and silently fell back to Pro because the tier
// wasn't passed through to /create-checkout.
//
// For paid users already on Pro/Max who pick the OTHER recurring tier,
// route to /upgrade-tier instead — same logic SubscriptionGate's
// initiateCheckout uses. Without this, a Pro user clicking "Upgrade to Max"
// from ManageSubscription would create a SECOND Stripe subscription
// alongside the existing one and double-bill until support intervened.
//
// onSuccess: callback fired AFTER the upgrade lands. Two firing paths:
//   - Synthetic-grant (admin-grant, stripe-upgrade, razorpay-upgrade) —
//     fires immediately because the server completed the swap inline.
//   - External-browser checkout (provider='stripe' for new subs) —
//     fires from pollForExternalUpgrade once the server reflects the new
//     tier. Without this, a free user clicking "Upgrade to Pro" from
//     ManageSubscription pays in their browser, the renderer never sees
//     the redirect, and the chat-header tier badge stays "Free" until the
//     next periodic revalidation tick (or app restart).
// Surface checkout status to the user via a window event picked up by the
// CheckoutToast in the App component. Without these events, every step of
// the flow (fetch start, fetch error, browser-opened, sync-grant, polling
// success/timeout) was silent — when something failed the user only saw
// the modal close and was left staring at the chat interface, which is
// exactly the "why am I being directed to chat?" symptom users hit.
//
// `url` is included on 'opened' and on 'error'-with-URL events so the
// toast can render a Copy-URL button. shell.openExternal can claim
// success and yet not actually surface a window (default-browser
// registration corrupted, AV blocking, OS shell process busy) — when
// that happens the user has no way to recover unless we hand them the
// URL to paste manually. Cheap belt-and-suspenders.
function emitCheckoutStatus(detail: {
  kind: 'connecting' | 'opened' | 'sync-grant' | 'completed' | 'timeout' | 'error' | 'no-token';
  tier?: string;
  message?: string;
  mode?: 'subscription' | 'renewal';
  url?: string;
}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:checkout-status', { detail }));
}

// Open an external URL with full diagnostic visibility. Prefers the IPC
// 'open-external-robust' channel (shell.openExternal with 6s timeout +
// child_process spawn fallback — see electron/main.cjs ipcMain.handle
// for the rationale). Falls back to the legacy openExternal or window.open
// only when the robust channel isn't available.
async function tryOpenCheckoutUrl(url: string): Promise<{
  ok: boolean;
  method: string;
  error?: string;
  attempts?: Array<{ method: string; ok: boolean; error?: string }>;
}> {
  if (typeof window === 'undefined') {
    return { ok: false, method: 'none', error: 'No window context' };
  }
  if (window.electronAPI?.openExternalRobust) {
    try {
      const result = await window.electronAPI.openExternalRobust(url);
      return result;
    } catch (e: any) {
      return { ok: false, method: 'invoke-failed', error: e?.message || String(e) };
    }
  }
  if (window.electronAPI?.openExternal) {
    try {
      await window.electronAPI.openExternal(url);
      return { ok: true, method: 'shell.openExternal-legacy' };
    } catch (e: any) {
      return { ok: false, method: 'shell.openExternal-legacy', error: e?.message || String(e) };
    }
  }
  // Web fallback — popup blocker may return null.
  const w = window.open(url, '_blank');
  return w ? { ok: true, method: 'window.open' } : { ok: false, method: 'window.open', error: 'Popup blocked' };
}

async function openProUpgrade(
  targetTier: 'basic' | 'pro' | 'max' | 'ultra' = 'pro',
  onSuccess?: (info: { tier: string; message?: string }) => void,
) {
  const { licenseService } = await import('./services/licenseService');
  const token = licenseService.getToken();
  if (!token) {
    console.warn('[openProUpgrade] No auth token — aborting.');
    emitCheckoutStatus({ kind: 'no-token', mode: 'subscription', message: 'Please sign in first to start a subscription.' });
    return;
  }

  const tierLabel = targetTier.toUpperCase();
  emitCheckoutStatus({ kind: 'connecting', tier: targetTier, mode: 'subscription', message: `Connecting to checkout for ${tierLabel}…` });

  try {
    const saved = licenseService.loadAuth();
    const countryCode = saved.user?.country_code || 'US';

    // In-place tier swap detection — mirror SubscriptionGate.initiateCheckout.
    // 2026-07 model: only Ultra is a recurring subscription. Basic/Pro/Max are
    // one-time purchases, so they never qualify for an in-place /upgrade-tier
    // swap — picking a different one is always a fresh /create-checkout.
    const liveTier = saved.license?.tier;
    const isLiveActive = saved.license?.status === 'active';
    const isRecurringTier = (t: string | undefined): boolean => t === 'ultra';
    const isInPlaceUpgrade =
      isLiveActive &&
      isRecurringTier(liveTier) &&
      isRecurringTier(targetTier) &&
      liveTier !== targetTier;

    const endpointPath = isInPlaceUpgrade
      ? '/api/v1/payments/upgrade-tier'
      : '/api/v1/payments/create-checkout';
    const requestBody = isInPlaceUpgrade
      ? { tier: targetTier }
      : { country_code: countryCode, tier: targetTier };

    const response = await fetch(`${licenseService.getApiBase()}${endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(requestBody),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to start checkout');

    // Synthetic-grant providers (admin-grant, stripe-upgrade, razorpay-upgrade)
    // don't redirect — they've already mutated the subscription server-side
    // and returned the new license inline. Update local auth optimistically
    // and let the caller know.
    const SYNC_GRANT_PROVIDERS = ['admin-grant', 'stripe-upgrade', 'razorpay-upgrade'];
    if (SYNC_GRANT_PROVIDERS.includes(data.provider)) {
      const grantedTier = data.tier || targetTier;
      if (saved.user) {
        const updatedUser = { ...saved.user, tier: grantedTier };
        const updatedLicense = data.license
          ? { ...data.license, last_validated: Date.now() }
          : { ...saved.license!, tier: grantedTier, last_validated: Date.now() };
        licenseService.saveAuth(updatedUser, updatedLicense);
      }
      try { localStorage.setItem('justPurchasedTier', grantedTier); } catch {}
      onSuccess?.({ tier: grantedTier, message: data.message });
      emitCheckoutStatus({
        kind: 'sync-grant',
        tier: grantedTier,
        mode: 'subscription',
        message: data.message || `${grantedTier.toUpperCase()} activated.`,
      });
      return;
    }

    if (data.checkout_url) {
      // Try the robust opener (shell.openExternal w/ 6s timeout, then
      // child_process `cmd /c start` fallback). The legacy openExternal
      // can silently fail on Windows when default-browser registration
      // is corrupted, when ShellExecuteW hangs, or when AV interferes —
      // openExternalRobust survives those. Either way we surface the URL
      // in the toast so the user always has a Copy-URL fallback in case
      // openExternalRobust thinks it succeeded but no window appears.
      const opened = await tryOpenCheckoutUrl(data.checkout_url);
      if (!opened.ok) {
        const detail = opened.attempts?.length
          ? ` Tried: ${opened.attempts.map(a => `${a.method}${a.ok ? ' ok' : ` failed (${a.error})`}`).join('; ')}`
          : opened.error ? ` (${opened.error})` : '';
        emitCheckoutStatus({
          kind: 'error',
          tier: targetTier,
          mode: 'subscription',
          message: `Couldn't open the browser automatically.${detail} Use the Copy URL button to open it yourself.`,
          url: data.checkout_url,
        });
        // Don't return — still poll, since the user might paste the URL
        // and complete payment manually.
      } else {
        emitCheckoutStatus({
          kind: 'opened',
          tier: targetTier,
          mode: 'subscription',
          message: `Stripe checkout opened in your browser for ${tierLabel} (${opened.method}). Switch to your browser to complete payment — your plan will update here automatically. If you don't see a browser window, use Copy URL.`,
          url: data.checkout_url,
        });
      }
      // Fire-and-forget poll — the renderer never sees Stripe's success
      // redirect (it lands in the user's browser), so we have to learn
      // about the upgrade from the server. See pollForExternalUpgrade
      // for the rationale and timing.
      pollForExternalUpgrade(targetTier, onSuccess);
    } else {
      // Server returned 200 but with neither a sync-grant provider nor a
      // checkout_url. Without this branch the user would see no feedback
      // at all — looking exactly like "nothing happened". Most likely a
      // server-side misconfiguration (e.g. unknown provider field).
      emitCheckoutStatus({
        kind: 'error',
        tier: targetTier,
        mode: 'subscription',
        message: 'Checkout response was missing a payment URL. Please try again or contact support.',
      });
    }
  } catch (err: any) {
    console.error('[openProUpgrade] Checkout failed:', err?.message || err);
    emitCheckoutStatus({
      kind: 'error',
      tier: targetTier,
      mode: 'subscription',
      message: err?.message || 'Failed to start checkout. Please try again.',
    });
  }
}

// ── Razorpay in-app sheet loader (mid-interview top-up, India) ──
// RBI rules forbid charging a saved card silently on one-time payments,
// so the Indian top-up opens Razorpay's own modal INSIDE the app — one
// tap on UPI/card, no browser round-trip. checkout.js is allowed by the
// CSP (script-src includes checkout.razorpay.com) and cached after the
// first load.
let razorpayScriptPromise: Promise<boolean> | null = null;
function loadRazorpayScript(): Promise<boolean> {
  if ((window as any).Razorpay) return Promise.resolve(true);
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = () => resolve(true);
      s.onerror = () => { razorpayScriptPromise = null; resolve(false); };
      document.head.appendChild(s);
    });
  }
  return razorpayScriptPromise;
}

async function openRazorpaySheetInApp(payload: any, token: string, onSuccess?: () => void): Promise<boolean> {
  const ok = await loadRazorpayScript();
  if (!ok || !(window as any).Razorpay) return false;
  const { licenseService } = await import('./services/licenseService');
  try {
    const rzp = new (window as any).Razorpay({
      key: payload.key_id,
      amount: payload.amount,
      currency: payload.currency,
      name: payload.name,
      description: payload.description,
      order_id: payload.order_id,
      prefill: { email: payload.user_email, name: payload.user_name },
      theme: { color: '#10b981' },
      handler: async (resp: any) => {
        try {
          const v = await fetch(`${licenseService.getApiBase()}/api/v1/payments/verify-razorpay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(resp),
          });
          const vd = await v.json().catch(() => null);
          if (v.ok && vd?.success) {
            // Server message names the tier-correct amount ("+30 minutes"
            // / "+1 hour"); the fallback stays amount-neutral so it can
            // never state the wrong figure.
            await licenseService.validateWithServer().catch(() => {});
            emitCheckoutStatus({ kind: 'completed', mode: 'renewal', message: vd.message || 'Extra time added. Keep going.' });
            onSuccess?.();
          } else {
            emitCheckoutStatus({
              kind: 'error', mode: 'renewal',
              message: vd?.error || 'Payment verification is pending — if you were charged, the time will land automatically in a moment.',
            });
          }
        } catch {
          emitCheckoutStatus({
            kind: 'error', mode: 'renewal',
            message: 'Payment made — verification will complete automatically in a moment.',
          });
        }
      },
      modal: { ondismiss: () => { /* user closed the sheet — no status noise */ } },
    });
    rzp.open();
    return true;
  } catch {
    return false;
  }
}

// Open a top-up checkout URL in the system browser + poll for the grant.
// Shared by the legacy /create-renewal path and /extend-now's degraded
// responses (no card on file yet, or the bank demanded 3DS).
async function openRenewalCheckoutUrl(checkoutUrl: string, onSuccess?: () => void) {
  const opened = await tryOpenCheckoutUrl(checkoutUrl);
  if (!opened.ok) {
    const detail = opened.attempts?.length
      ? ` Tried: ${opened.attempts.map(a => `${a.method}${a.ok ? ' ok' : ` failed (${a.error})`}`).join('; ')}`
      : opened.error ? ` (${opened.error})` : '';
    emitCheckoutStatus({
      kind: 'error',
      mode: 'renewal',
      message: `Couldn't open the browser automatically.${detail} Use the Copy URL button to open it yourself.`,
      url: checkoutUrl,
    });
    // Still poll — the user may complete via the copied URL.
  } else {
    emitCheckoutStatus({
      kind: 'opened',
      mode: 'renewal',
      message: `Top-up checkout opened in your browser (${opened.method}). Complete the payment there — your time will land here automatically. If you don't see a browser window, use Copy URL.`,
      url: checkoutUrl,
    });
  }
  pollForExternalRenewal(onSuccess);
}

// ── Plan-specific top-up — ONE CLICK first, checkout only as fallback ──
// 2026-07 flow: /extend-now charges the card Stripe saved at the first
// purchase (off-session) and grants the PLAN'S unit server-side in the
// same transaction (Basic +30 min · $25, Pro/Max +1 hour · $45) — the
// user never leaves the interview. Fallbacks, in order:
//   · India → Razorpay's in-app sheet (RBI forbids silent one-time charges)
//   · no saved card / bank demands 3DS → browser checkout (which saves
//     the card via setup_future_usage, so NEXT time is one-click)
//   · /extend-now unreachable (older server) → legacy /create-renewal
async function openProRenewal(onSuccess?: () => void, packId?: string) {
  const { licenseService } = await import('./services/licenseService');
  const token = licenseService.getToken();
  if (!token) {
    console.warn('[openProRenewal] No auth token — aborting.');
    emitCheckoutStatus({ kind: 'no-token', mode: 'renewal', message: 'Please sign in first to extend.' });
    return;
  }
  // Tier-correct progress copy. The AMOUNTS are authoritative server-side
  // (payments.js RENEWAL_BY_TIER keyed to the live license); this label is
  // the client's mirror of the same table for user-facing status text.
  const savedForLabel = licenseService.loadAuth();
  const renewalInfo = pricingService.getRenewalPrice(
    savedForLabel.user?.country_code || 'US',
    savedForLabel.license?.tier || 'basic',
  );
  emitCheckoutStatus({ kind: 'connecting', mode: 'renewal', message: `Adding ${renewalInfo.minutes} minutes…` });
  try {
    const saved = savedForLabel;
    const countryCode = saved.user?.country_code || 'US';

    // ── One-click path ──
    try {
      const attemptId = (globalThis.crypto as any)?.randomUUID?.()
        || `a_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const ext = await fetch(`${licenseService.getApiBase()}/api/v1/payments/extend-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ attempt_id: attemptId, pack: packId || 'm30' }),
      });
      const extendData: any = await ext.json().catch(() => null);

      if (ext.ok && extendData?.success && extendData?.flow === 'off_session') {
        // Charged the card on file; time already landed server-side. Pull
        // the authoritative balance into local state and refresh the UI.
        // Server message carries the tier-correct amount; the fallback
        // mirrors it from the client-side renewal table.
        await licenseService.validateWithServer().catch(() => {});
        emitCheckoutStatus({ kind: 'completed', mode: 'renewal', message: extendData.message || `${renewalInfo.label} added. Keep going.` });
        onSuccess?.();
        return;
      }
      if (extendData?.already_unlimited) {
        onSuccess?.();
        return;
      }
      if (extendData?.provider === 'razorpay' && extendData?.flow === 'in_app_sheet') {
        const openedSheet = await openRazorpaySheetInApp(extendData, token, onSuccess);
        if (openedSheet) return; // the sheet's handler completes the flow
        // checkout.js unavailable — fall through to the browser path below.
      }
      if (ext.ok && extendData?.checkout_url) {
        // extend-now degraded itself to a checkout session (first purchase
        // pre-dates card saving, or the bank wants 3DS).
        return await openRenewalCheckoutUrl(extendData.checkout_url, onSuccess);
      }
      if (ext.status === 402 && extendData?.error === 'charge_failed') {
        emitCheckoutStatus({ kind: 'error', mode: 'renewal', message: extendData.message || 'Your card was declined.' });
        return;
      }
      if (ext.status === 403 && extendData?.error === 'not_interview_day') {
        emitCheckoutStatus({ kind: 'error', mode: 'renewal', message: extendData.message });
        return;
      }
      // Any other non-OK: fall through to the legacy endpoint below.
    } catch { /* network / older server — legacy path below */ }

    // ── Legacy fallback: /create-renewal browser checkout ──
    const response = await fetch(`${licenseService.getApiBase()}/api/v1/payments/create-renewal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ country_code: countryCode, pack: packId || 'm30' }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to start renewal');
    if (data.checkout_url) {
      await openRenewalCheckoutUrl(data.checkout_url, onSuccess);
    } else {
      emitCheckoutStatus({
        kind: 'error',
        mode: 'renewal',
        message: 'Renewal response was missing a payment URL. Please try again or contact support.',
      });
    }
  } catch (err: any) {
    console.error('[openProRenewal] Renewal failed:', err?.message || err);
    emitCheckoutStatus({
      kind: 'error',
      mode: 'renewal',
      message: err?.message || 'Failed to start renewal. Please try again.',
    });
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
      // Clear the auto-titled flag so the App-side re-titler doesn't
      // overwrite this deliberate user choice on the next 10-message
      // milestone. Wrapping in try/catch because some sandboxes restrict
      // localStorage and we never want a rename to throw.
      try { localStorage.removeItem(`auto_titled_${editingId}`); } catch {}
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
      const idToClean = deleteConfirmId;
      await db.deleteSession(idToClean);
      // Clean up the auto-titled flag — otherwise localStorage slowly
      // accumulates orphan entries for every deleted session, and a
      // brand-new session that happens to reuse a Date.now()-collision
      // id would inherit the old flag.
      try { localStorage.removeItem(`auto_titled_${idToClean}`); } catch {}
    }
    setDeleteConfirmId(null);
  };

  // Web: sessions are Electron/sqlite-backed — show desktop upsell instead of empty no-ops.
  const webHistoryUpsell = !db.isElectron;

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

        {webHistoryUpsell ? (
          <div className="flex-1 flex flex-col px-4 py-6 gap-4">
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 text-center space-y-3">
              <Download size={22} className="mx-auto text-blue-400" />
              <p className="text-sm text-white/90 font-medium leading-snug">
                Conversation history lives in the desktop app
              </p>
              <p className="text-xs text-gray-500 leading-relaxed">
                Your current chat still works in this tab. Download the desktop app to keep sessions across interviews.
              </p>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('app:open-download'))}
                className="w-full px-3 py-2 rounded-lg text-xs font-bold bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:opacity-90 transition-opacity"
              >
                Download desktop app
              </button>
            </div>
          </div>
        ) : (
        <>
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
        </>
        )}
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

function MainApp({ userProfile, userLicense, onLogout, setUserProfile, setUserLicense }: { userProfile: UserProfile | null; userLicense: LicenseData | null; onLogout: () => void; setUserProfile: (u: UserProfile | null) => void; setUserLicense: (l: LicenseData | null) => void }) {
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

  // ── Auto-title state ──────────────────────────────────────────────
  // Track per-session auto-titler activity so we can:
  //   1. Prevent two streams ending close together from firing two
  //      titler calls for the same session (would cost double API spend
  //      and risk a race where the older call wins after the newer).
  //   2. Cap retries at 3 per session — the v1 code's <=4 turn gate
  //      was too restrictive (gave up after 4 messages even if the
  //      first 4 attempts all failed) but unbounded retry would also
  //      hammer the API for sessions where the model just won't title
  //      cleanly. 3 attempts at fresh-placeholder titling, then we
  //      stop trying for a while.
  //   3. Track when we last re-titled so we re-evaluate at message-
  //      count milestones (handles topic shift mid-conversation).
  const titleAttemptsRef = useRef<Map<string, number>>(new Map());
  const titlingInFlightRef = useRef<Set<string>>(new Set());
  const lastRetitleAtRef = useRef<Map<string, number>>(new Map());

  // ── Retroactive title pass ─────────────────────────────────────────
  // One-shot scan on app startup: find every session with a placeholder
  // name ("Interview <date>") that has at least one user+model exchange,
  // and auto-title it from its existing transcript. This catches all the
  // historical sessions stuck on placeholder titles — either because they
  // pre-date the auto-titler, or because they fell into v1's broken
  // <=4-turn gate after the first attempts failed.
  //
  // Per-session bookkeeping in localStorage:
  //   auto_titled_<sid>    set on success (live OR retro path)
  //   retro_skipped_<sid>  set when the retro pass tried and gave up
  //                        (either no usable transcript or LLM kept
  //                        rejecting the output). Without this we'd
  //                        re-attempt on every app launch forever.
  //
  // Polite to the API: 1.2s gap between sessions, single in-flight call,
  // and uses the same titlingInFlightRef as the live path so a session
  // currently being titled by an active chat doesn't double-fire here.
  const retroactivePassStartedRef = useRef(false);
  useEffect(() => {
    if (retroactivePassStartedRef.current) return;
    if (!db.isElectron || !db.ready) return;
    if (!userProfile?.id) return;
    if (!Array.isArray(db.sessions) || db.sessions.length === 0) return;

    // Catches BOTH stuck placeholder titles ("Interview 5/4/2026") AND
    // the generic outputs of the v1 prompt ("Coding Help", "Discussion",
    // "Interview Conversation"). The v1 prompt had "interview conversation"
    // baked in plus Interviewer:/Candidate: framing, so it routinely
    // produced low-info titles even on rich, specific conversations —
    // those titles deserve re-titling too. Risk of overwriting a real
    // user-chosen title that happens to match these patterns is low:
    // anyone deliberately naming a session "Coding Help" is unlikely.
    const GENERIC_PATTERN = /^(coding|programming|interview|conversation|chat|discussion|question|help|topic|untitled)(\s(help|chat|session|discussion|question|conversation))?$/i;
    const isPlaceholderName = (name: string): boolean => {
      if (!name) return true;
      if (/^Interview\s/.test(name)) return true;
      if (GENERIC_PATTERN.test(name.trim())) return true;
      return false;
    };

    const placeholderSessions = (db.sessions as any[]).filter((s) => {
      if (!isPlaceholderName(s.name)) return false;
      try {
        if (localStorage.getItem(`auto_titled_${s.id}`) === '1') return false;
        if (localStorage.getItem(`retro_skipped_${s.id}`) === '1') return false;
      } catch {}
      // Skip sessions with no real conversation. The sidebar's
      // listSessionsForUser projection includes message_count, but it's
      // approximate here — we re-check below by fetching messages.
      if ((s.message_count || 0) < 2) return false;
      return true;
    });

    if (placeholderSessions.length === 0) {
      retroactivePassStartedRef.current = true;
      return;
    }
    retroactivePassStartedRef.current = true;
    console.log(`[auto-title] retroactive pass: ${placeholderSessions.length} placeholder session(s) queued`);

    let cancelled = false;
    (async () => {
      let succeeded = 0;
      let skipped = 0;
      for (const session of placeholderSessions) {
        if (cancelled) return;
        const sid: string = session.id;
        // If the live titler grabbed this session in the meantime
        // (active chat fired the placeholder-retry path), skip — let
        // them finish their work, retry on next app launch if needed.
        if (titlingInFlightRef.current.has(sid)) { skipped++; continue; }
        titlingInFlightRef.current.add(sid);
        try {
          const messages = await electronIPC.invoke('db:get-messages', sid);
          if (!Array.isArray(messages) || messages.length < 2) {
            try { localStorage.setItem(`retro_skipped_${sid}`, '1'); } catch {}
            skipped++;
            continue;
          }
          const hasUser = messages.some((m: any) => m.role === 'user');
          const hasModel = messages.some((m: any) => m.role === 'model');
          if (!hasUser || !hasModel) {
            try { localStorage.setItem(`retro_skipped_${sid}`, '1'); } catch {}
            skipped++;
            continue;
          }
          const title = await generateConversationTitle(
            messages.map((m: any) => ({ role: m.role, content: m.content }))
          );
          if (title) {
            await db.renameSession(sid, title);
            try { localStorage.setItem(`auto_titled_${sid}`, '1'); } catch {}
            succeeded++;
          } else {
            // Title generation returned null — either the model produced
            // a rejected generic title, or the API call failed. Mark as
            // retro-skipped so we don't re-hit on every launch; the live
            // titler will still try if the user opens the session.
            try { localStorage.setItem(`retro_skipped_${sid}`, '1'); } catch {}
            skipped++;
          }
        } catch (err: any) {
          console.warn('[auto-title] retro failed for', sid, err?.message || err);
          try { localStorage.setItem(`retro_skipped_${sid}`, '1'); } catch {}
          skipped++;
        } finally {
          titlingInFlightRef.current.delete(sid);
        }
        // 1.2s pause between sessions — keeps the API friendly even
        // when a user has 50+ stuck placeholder sessions. Total cap on
        // a 50-session backfill: ~60s in background, no UI block.
        if (!cancelled) await new Promise(r => setTimeout(r, 1200));
      }
      console.log(`[auto-title] retroactive pass complete: ${succeeded} titled, ${skipped} skipped`);
    })();

    return () => { cancelled = true; };
  }, [db.isElectron, db.ready, db.sessions, userProfile?.id]);

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
  // Open the billing surface in response to the in-app upgrade link the
  // AI emits in feature-gate messages (see MessageRenderer's custom `a`
  // component). Without this listener those links would do nothing — the
  // renderer can't reach setManageSubOpen through React.memo'd children
  // without plumbing the setter through props and busting memoization.
  useEffect(() => {
    const handler = () => setManageSubOpen(true);
    window.addEventListener('app:open-manage-subscription', handler);
    return () => window.removeEventListener('app:open-manage-subscription', handler);
  }, []);

  // ── Plan/trial expiry notice (see computePlanNotice) ──
  // Evaluated on license changes + a slow 60s cadence; NEVER while a live
  // session is running (creditTimerService.isActive()) — mid-interview the
  // low-warning/exhausted surfaces own that moment and a billing nag would
  // be exactly the wrong thing to show. Reads the freshest license straight
  // from storage (heartbeats mirror balances there ahead of React state).
  // "Shown once per state": a fingerprint is persisted per-user on dismiss
  // or CTA click; the same state never re-nags, while a renewal (new
  // expires_at ⇒ new fingerprint) re-arms the warning. Entirely fail-soft —
  // any error here just means no notice.
  const [planNotice, setPlanNotice] = useState<PlanNotice | null>(null);
  const planNoticeStoreKey = `minicaai_plan_notice_shown_${userProfile?.id || 'anon'}`;
  useEffect(() => {
    if (isElectron && isPopoutMode) return; // popout never hosts the notice
    let alive = true;
    const evaluate = () => {
      try {
        if (!alive) return;
        if (creditTimerService.isActive()) return; // never mid-interview
        const freshLicense = licenseService.loadAuth().license || userLicense;
        const notice = computePlanNotice(freshLicense);
        if (!notice) { setPlanNotice(null); return; }
        let shown: string[] = [];
        try { shown = JSON.parse(localStorage.getItem(planNoticeStoreKey) || '[]'); } catch { /* corrupt entry → treat as unshown */ }
        if (!Array.isArray(shown)) shown = [];
        if (shown.includes(notice.fingerprint)) return;
        setPlanNotice(prev => (prev && prev.fingerprint === notice.fingerprint) ? prev : notice);
      } catch { /* fail-soft: a notice bug must never touch the interview UI */ }
    };
    evaluate();
    const t = window.setInterval(evaluate, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [userLicense, planNoticeStoreKey]);

  const dismissPlanNotice = useCallback((fingerprint: string) => {
    setPlanNotice(null);
    try {
      let shown: string[] = [];
      try { shown = JSON.parse(localStorage.getItem(planNoticeStoreKey) || '[]'); } catch { /* start fresh */ }
      if (!Array.isArray(shown)) shown = [];
      if (!shown.includes(fingerprint)) shown.push(fingerprint);
      // Cap the history — old fingerprints from long-gone plan windows
      // have no future matches and would only grow the key forever.
      localStorage.setItem(planNoticeStoreKey, JSON.stringify(shown.slice(-12)));
    } catch { /* localStorage unavailable — worst case it shows again next boot */ }
  }, [planNoticeStoreKey]);

  // Web-only: Auto-Type / sidebar / EyeOff / PiP upsells open the Download modal
  // via CustomEvent so deeply nested components stay memo-friendly.
  useEffect(() => {
    if (isElectron) return;
    const handler = () => setShowDownloadModal(true);
    window.addEventListener('app:open-download', handler);
    return () => window.removeEventListener('app:open-download', handler);
  }, []);

  // ── Checkout-status toast ─────────────────────────────────────────
  // Visible feedback for every step of the upgrade/renewal flow. Without
  // this the user clicked a plan, the modal closed, and nothing visible
  // happened — they'd describe it as "directing me to the chat interface"
  // because the chat is what's behind the closed modal. Sources of the
  // silence: browser opens but in the background (Focus Assist), fetch
  // fails silently (no token / network error / server validator rejecting
  // a misconfigured price), or admin-grant short-circuits without a
  // browser open at all. Each of those now dispatches an event the toast
  // surfaces with a clear message so the user can see what happened.
  type CheckoutToast = {
    kind: 'connecting' | 'opened' | 'sync-grant' | 'completed' | 'timeout' | 'error' | 'no-token';
    tier?: string;
    message?: string;
    mode?: 'subscription' | 'renewal';
    url?: string;
    expiresAt: number;
  };
  const [checkoutToast, setCheckoutToast] = useState<CheckoutToast | null>(null);
  const [checkoutUrlCopied, setCheckoutUrlCopied] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      // 'opened' stays visible the longest because the user is supposed to
      // alt-tab to their browser to pay — disappearing in 4s would lose
      // the breadcrumb. 'error' / 'timeout' stay long enough to be read
      // and acted on. Transient steps decay quickly.
      const dismissAfterMs =
        detail.kind === 'opened' ? 45000 :
        detail.kind === 'connecting' ? 10000 :
        detail.kind === 'error' ? 12000 :
        detail.kind === 'no-token' ? 8000 :
        detail.kind === 'timeout' ? 15000 :
        detail.kind === 'sync-grant' || detail.kind === 'completed' ? 6000 :
        6000;
      setCheckoutToast({ ...detail, expiresAt: Date.now() + dismissAfterMs });
    };
    window.addEventListener('app:checkout-status', handler);
    return () => window.removeEventListener('app:checkout-status', handler);
  }, []);
  // Auto-dismiss when expiresAt passes. Separate effect so each new toast
  // resets the timer cleanly rather than racing the previous one's stale
  // setTimeout closure.
  useEffect(() => {
    if (!checkoutToast) return;
    const remaining = checkoutToast.expiresAt - Date.now();
    if (remaining <= 0) { setCheckoutToast(null); return; }
    const t = window.setTimeout(() => setCheckoutToast(null), remaining);
    return () => window.clearTimeout(t);
  }, [checkoutToast]);
  // Pending-upgrade state — drives the inline spinner on ManageSubscription's
  // upgrade buttons AND keeps the modal open until the external browser
  // has actually opened (or sync-grant has landed). Without this, the
  // modal closed instantly on click and the user was thrown into a
  // dim app waiting for a toast that hadn't surfaced yet — the exact
  // "thrown to chat interface" symptom.
  const [upgradePending, setUpgradePending] = useState<'basic' | 'pro' | 'max' | 'ultra' | null>(null);
  const [renewPending, setRenewPending] = useState(false);

  const handleSubscriptionUpgrade = useCallback(async (targetTier: 'basic' | 'pro' | 'max' | 'ultra') => {
      // Reuse the checkout flow in openProUpgrade. The checkout happens in
      // the browser via openExternal for /create-checkout, or completes
      // server-side and updates local state for /upgrade-tier. The
      // onSuccess callback fires for synthetic-grant providers (admin-grant,
      // stripe-upgrade, razorpay-upgrade) — without it the chat-header tier
      // badge would stay on the old tier until the next 30-min revalidation
      // tick because openProUpgrade only updates localStorage.
      //
      // New choreography (replaces the instant-close that felt like a
      // "throw"): keep the modal mounted until openProUpgrade resolves.
      // openProUpgrade is async — returns once /create-checkout responds AND
      // tryOpenCheckoutUrl has either succeeded or surfaced a fallback toast.
      // Then we wait an additional 600ms so the CheckoutToast at the top
      // ("Stripe checkout opened in your browser") has time to land in
      // the user's eyeline BEFORE the modal animates away. The result is
      // a continuous gesture: click → button spins → toast appears → modal
      // smoothly fades, revealing the toast.
      setUpgradePending(targetTier);
      try {
          await openProUpgrade(targetTier, () => {
              const saved = licenseService.loadAuth();
              if (saved.user) setUserProfile(saved.user);
              if (saved.license) setUserLicense(saved.license);
          });
          // Grace period: let the user register the toast appearing on
          // top of the modal (z-100000 vs z-99999) before the modal
          // dissolves. 600ms is short enough not to feel laggy, long
          // enough for the eye to track the new visual.
          await new Promise(r => setTimeout(r, 600));
          setManageSubOpen(false);
      } finally {
          // Reset pending state regardless of success/failure so the
          // buttons re-enable. On error the toast already surfaced the
          // failure; user can retry from the same modal (we don't close
          // on error).
          setUpgradePending(null);
      }
  }, [setUserProfile, setUserLicense]);

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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SUPPORT AGENT BACKGROUND CHANNEL (admins only)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Root WebSocket to /ws/support that survives the SupportBot panel
  //  being closed. Replaces the previous SupportBot-owned WS which died
  //  on panel close — that bug made customer 'Talk to human' clicks
  //  vanish unless the admin had the inbox open at that exact moment.
  //
  //  Event-bus pattern (see SupportBot.tsx lines 1707-1818 + 2144):
  //   • Inbound: WS frame → dispatch CustomEvent('minicaai-support-event')
  //   • Outbound: SupportBot dispatches 'minicaai-support-send' → forward to WS
  //   • Status: dispatch 'minicaai-support-status' on open/close
  //   • IPC bridge: main.cjs `support:open-inbox` (fired when admin
  //     clicks a native notification) → dispatch 'minicaai-support-deeplink'
  //     so the inbox auto-selects that thread.
  //
  //  Gated on isAdmin AND isElectron — browser tabs don't get the WS
  //  because the IPC bridge doesn't exist there and the tray badge
  //  wouldn't fire anyway. Non-admin users' SupportBot panel uses REST
  //  (/api/v1/support/chat) which needs none of this plumbing.
  useEffect(() => {
    if (!isAdmin) return;
    const email = userProfile?.email;
    if (!email) return;

    // Same env-aware base as licenseService / SupportBot / admin dashboard
    // — see note on App.tsx:589.
    const viteEnv = (import.meta as any).env || {};
    const httpBase = viteEnv.PROD
      ? 'https://api.minicaai.com'
      : (viteEnv.VITE_SERVER_URL || 'https://api.minicaai.com');
    const wsBase = httpBase.replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/ws/support`;

    let ws: WebSocket | null = null;
    let pingTimer: number | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;
    let backoffMs = 1000;

    const dispatchStatus = (status: 'connecting' | 'online' | 'offline') => {
      try { window.dispatchEvent(new CustomEvent('minicaai-support-status', { detail: { status } })); }
      catch { /* SSR / window stripped */ }
    };

    // Outbound: SupportBot's inbox sends 'minicaai-support-send' → forward over WS.
    const onSendRequest = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !ws || ws.readyState !== 1 /* OPEN */) return;
      try { ws.send(JSON.stringify(detail)); }
      catch (err) { console.warn('[support-ws] send failed:', err); }
    };

    // IPC: main.cjs deeplink from a clicked tray notification.
    let unsubscribeIPC: (() => void) | null = null;
    if (isElectron) {
      try {
        const electronApi = (window as any).electronAPI;
        if (electronApi?.on) {
          const handler = (payload: any) => {
            try { window.dispatchEvent(new CustomEvent('minicaai-support-deeplink', { detail: payload })); }
            catch { /* SSR / window stripped */ }
            // Auto-open the support modal so the admin lands in the inbox.
            setShowSupport(true);
          };
          unsubscribeIPC = electronApi.on('support:open-inbox', handler);
        }
      } catch (err) {
        console.warn('[support-ws] IPC subscribe failed:', err);
      }
    }

    const connect = () => {
      if (cancelled) return;
      dispatchStatus('connecting');
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        console.warn('[support-ws] construct failed:', err);
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        if (cancelled) return;
        backoffMs = 1000;
        try {
          ws!.send(JSON.stringify({
            type: 'join',
            role: 'agent',
            user: email,
            name: userProfile?.name || null,
            // Admin JWT — the server rejects agent joins unless this token's
            // email is in ADMIN_EMAILS (closes the open-inbox/impersonation
            // hole). Omitted-if-null → server rejects, which is correct.
            token: licenseService.getToken() || undefined,
          }));
          dispatchStatus('online');
        } catch (err) {
          console.warn('[support-ws] join failed:', err);
        }
        // Heartbeat — server's idle sweep is 30 min but NAT can drop earlier.
        // 30s ping matches SupportBot's old internal cadence.
        if (pingTimer) window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => {
          if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'heartbeat' })); } catch {}
          }
        }, 30000);
      };

      ws.onmessage = (ev) => {
        let data: any;
        try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); }
        catch { return; }
        if (!data || typeof data !== 'object') return;

        // Dispatch to SupportBot inbox listener (always — even when
        // panel is closed — so opening it doesn't show a blank state).
        try { window.dispatchEvent(new CustomEvent('minicaai-support-event', { detail: data })); }
        catch { /* SSR / window stripped */ }

        // Tray badge / OS notification: fire IPC for customer-originated
        // events. Suppressed by main.cjs during sessionActive, so we
        // always send and let main decide whether to surface.
        if (isElectron && (data.type === 'customer_joined' || (data.type === 'message' && data.outbound !== true))) {
          try {
            const electronApi = (window as any).electronAPI;
            if (electronApi?.send) {
              electronApi.send('support:alert', {
                threadId: data.threadId || null,
                title: data.type === 'message' ? `New message from ${data.name || data.from || 'a customer'}` : `New support request from ${data.name || data.email || 'a customer'}`,
                body: data.type === 'message' ? String(data.text || '').slice(0, 140) : (data.initialQuestion || data.question || 'Click to open the inbox'),
                kind: data.type,
                customerEmail: String(data.from || data.email || '').toLowerCase(),
                customerName: data.name || null,
              });
            }
          } catch (err) {
            console.warn('[support-ws] support:alert IPC failed:', err);
          }
        }
      };

      ws.onclose = () => {
        dispatchStatus('offline');
        if (pingTimer) { window.clearInterval(pingTimer); pingTimer = null; }
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire next; let it own the reconnect.
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      const jitter = Math.floor(Math.random() * 500);
      reconnectTimer = window.setTimeout(connect, backoffMs + jitter);
      backoffMs = Math.min(backoffMs * 2, 30000);
    };

    window.addEventListener('minicaai-support-send', onSendRequest as EventListener);
    connect();

    return () => {
      cancelled = true;
      window.removeEventListener('minicaai-support-send', onSendRequest as EventListener);
      if (pingTimer) window.clearInterval(pingTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) {
        try { ws.close(1000, 'unmount'); } catch {}
      }
      if (unsubscribeIPC) { try { unsubscribeIPC(); } catch {} }
      dispatchStatus('offline');
    };
  }, [isAdmin, userProfile?.email, userProfile?.name]);
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
  // Settings modal tabs — General (prefs/models) vs Usage (iOS time meter).
  const [settingsTab, setSettingsTab] = useState<'general' | 'usage'>('general');
  useEffect(() => {
    if (!showSettings) setSettingsTab('general');
  }, [showSettings]);
  const [showContext, setShowContext] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  // Minica support modal — separate from the audio Help modal so opening
  // "Chat with Minica" doesn't collide with the existing first-launch
  // tutorial trigger.
  const [showSupport, setShowSupport] = useState(false);
  
  // Local state for Quick Paste in Context Modal
  const [pasteContent, setPasteContent] = useState("");
  // Drop-zone drag-active flag — toggles the visual treatment when a file
  // is being dragged over the Knowledge drop zone in the Files modal.
  // Reset to false on dragLeave + drop + modal close so the highlight
  // doesn't get stuck if the user drags out of the modal.
  const [dragActive, setDragActive] = useState(false);

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
        const res = await fetch(`https://api.minicaai.com/api/v1/app-version?v=${APP_VERSION}`);
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
    // Default: cloud planner allowed (most users benefit from it). User
    // toggles to true on monitored networks where outbound traffic to
    // an unfamiliar Railway domain mid-interview is risky.
    localOnlyAutoType: localStorage.getItem("LOCAL_ONLY_AUTO_TYPE") === 'true',
    // GPT reasoning effort. Default 'none' for everyone — fastest baseline.
    // Non-Max users can't change it (UI locked, server forces 'none' via
    // JWT regardless). Max users opt up per-session as needed.
    reasoningEffort: (() => {
      const v = localStorage.getItem("REASONING_EFFORT");
      return v === 'low' || v === 'medium' || v === 'high' ? v : 'none';
    })(),
    // User-supplied custom instructions that prepend to every model's
    // system prompt. Empty string by default (no wrapper block sent
    // server-side). Persisted to localStorage on blur (debounced)
    // matching the rest of this useState's localStorage-only pattern;
    // no IPC / SQLite involvement until we add multi-device sync.
    customInstructions: localStorage.getItem("CUSTOM_INSTRUCTIONS") || '',
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

  // Persist Local-Only Auto-Type so the user doesn't have to re-toggle
  // it on every app launch when sitting on a monitored network.
  useEffect(() => {
      localStorage.setItem("LOCAL_ONLY_AUTO_TYPE", String(settings.localOnlyAutoType));
  }, [settings.localOnlyAutoType]);

  // Persist reasoning effort. Only persist values the server will accept
  // — guards against a future enum tightening shipping a bad string into
  // localStorage that then poisons every request.
  useEffect(() => {
      const v = settings.reasoningEffort;
      if (v === 'none' || v === 'low' || v === 'medium' || v === 'high') {
          localStorage.setItem("REASONING_EFFORT", v);
      }
  }, [settings.reasoningEffort]);

  // Apply Custom Instructions persistence — same pattern as the rest of
  // this useState block. The save is unconditional (no validation) so
  // empty strings clear the key, and there's no debouncing here because
  // the textarea uses an onBlur handler (not onChange) to update the
  // setting, so this effect already only fires on blur transitions.
  useEffect(() => {
      localStorage.setItem("CUSTOM_INSTRUCTIONS", settings.customInstructions || '');
  }, [settings.customInstructions]);

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
  const executeSend = useCallback(async (textToSend: string, imageBase64?: string, isAutoSolve?: boolean, _fallbackAttempt?: number) => {
      if (!textToSend.trim()) return;

      // ── Live-time preflight (2026-07 plan-handling fix) ──
      // Tier FEATURES persist at a 0 balance (a time-exhausted Pro is
      // still Pro: models selectable, Pop-out open) — only live USE is
      // blocked, here, before any server call. This mirrors the server's
      // requireTimeRemaining (402) / requireTier-lapse (403) split with
      // the matching copy: TOP-UP for a paid plan whose clock ran out,
      // RENEW for a lapsed plan, plans for a used-up free trial. Reads
      // fresh auth state (not the render-time gate closure) so a top-up
      // that landed mid-session unblocks the very next send, and so the
      // user never sees the server's raw 402/403 mid-interview.
      {
        const { license: liveLicense } = licenseService.loadAuth();
        const planState = licenseService.getPlanState(liveLicense);
        if (planState !== 'ok') {
          const rawTier = liveLicense?.tier ?? 'free';
          const tierLabel = rawTier.charAt(0).toUpperCase() + rawTier.slice(1);
          const isPaidPlan = rawTier !== 'free';
          const wallMsg: Message = {
            id: Date.now().toString(),
            role: 'model',
            content: planState === 'lapsed'
              ? `Your **${tierLabel} plan** has ended. [Renew your plan](upgrade) to continue.`
              : isPaidPlan
                ? `Your **interview time** is used up — your ${tierLabel} plan and its models are still yours. [Top up minutes](upgrade) to keep going.`
                : 'Your **10-minute free trial** is used up — pick a plan to keep going. [See plans](upgrade)',
            timestamp: Date.now()
          };
          if (db.isElectron) { db.addMessage(wallMsg); } else { setMessages(prev => [...prev, wallMsg]); }
          return;
        }
      }

      // ── Feature Gate: Block disallowed models ──
      const currentModel = settingsRef.current.selectedModel;
      if (!gate.canUseModel(currentModel)) {
        // Post-trial free users have NO usable models —
        // FEATURE_GATES.free.models is empty under the 2026-07 policy and
        // the server 402s every model route. (Time-exhausted paid users
        // no longer land here — their tier persists and the preflight
        // above already returned with top-up/renew copy; this branch is
        // the belt-and-braces fallback for auth-state races.) Show the
        // paywall message instead of "switching" to a model that's just
        // as locked (and would error server-side mid-interview).
        if (gate.allowedModels.length === 0) {
          const wallMsg: Message = {
            id: Date.now().toString(),
            role: 'model',
            content: gate.actualTier === 'free'
              ? 'Your **10-minute free trial** is used up — pick a plan to keep going. [See plans](upgrade)'
              : `Your **${gate.actualTier.charAt(0).toUpperCase() + gate.actualTier.slice(1)} plan** has ended. [Renew your plan](upgrade) to continue.`,
            timestamp: Date.now()
          };
          if (db.isElectron) { db.addMessage(wallMsg); } else { setMessages(prev => [...prev, wallMsg]); }
          return;
        }
        const fallback = gate.getDefaultModel();
        setSettings(prev => ({ ...prev, selectedModel: fallback as any }));
        localStorage.setItem("SELECTED_MODEL", fallback);
        // Notify user — tier-aware so we don't promise the wrong upgrade.
        // 2026-07 gate map (FEATURE_GATES / server CLAUDE_TIERS): Claude
        // unlocks at PRO (pro/max/ultra); the other four models are
        // Basic+. In practice this branch only fires for a Basic user who
        // picked Claude — every no-models tier (post-trial free, expired
        // paid) already returned via the paywall branch above.
        const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        const requiredTier = currentModel === 'claude' ? 'Pro' : 'Basic';
        const reasonClause = currentModel === 'claude'
          ? `is available from the Pro plan up`
          : `requires a paid plan`;
        const gateMsg: Message = {
          id: Date.now().toString(),
          role: 'model',
          content: `**${cap(currentModel)}** ${reasonClause}. Switched to **${cap(fallback)}**. [Upgrade to ${requiredTier}](upgrade) to use it.`,
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

      // On a fallback retry the user's question is already in the transcript —
      // re-adding it would duplicate the bubble. Only add it on the first try.
      if (!_fallbackAttempt) {
        if (db.isElectron) {
          db.addMessage(userMsg);
        } else {
          setMessages(prev => [...prev, userMsg]);
        }
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
            // Auto-title the session — ChatGPT/Grok-style content-aware
            // topic summary. Fire-and-forget; if the LLM call fails the
            // placeholder "Interview <date>" stays put.
            //
            // Three trigger paths (handled by the helper, gated below):
            //   A. PLACEHOLDER PATH: title still matches "Interview <date>".
            //      Try titling on every model response, max 3 attempts.
            //      Replaces v1's broken `<=4 turns` gate which gave up
            //      forever after 4 messages even if all 4 attempts failed.
            //   B. RE-TITLE PATH: title was AI-generated and the
            //      conversation has grown by 10+ model responses since
            //      the last titling. Topic may have shifted; regenerate
            //      and update if the new title is meaningfully different.
            //      Skipped if user has manually renamed (we track that
            //      in localStorage via the saveEdit handler).
            //   C. SKIP PATH: user has set a name (not placeholder, not
            //      AI-generated), or the session is mid-titling already,
            //      or attempts have been exhausted.
            //
            // Skip in non-Electron / popout — only main owns the rename.
            if (db.isElectron && !inPopout && db.sessionId) {
              const sid = db.sessionId;
              const currentSession = (db.sessions || []).find((s: any) => s.id === sid);
              const currentName: string = currentSession?.name || '';
              const isPlaceholder = !currentName || /^Interview\s/.test(currentName);
              // localStorage flag — set when our auto-titler succeeds,
              // cleared when user manually renames. Lets us re-title
              // on topic shift without overwriting a deliberate rename.
              let isAutoTitled = false;
              try { isAutoTitled = localStorage.getItem(`auto_titled_${sid}`) === '1'; } catch {}
              const totalMessages = (messagesRef.current?.length || 0) + 1; // includes this aiMsg
              const lastRetitleAt = lastRetitleAtRef.current.get(sid) || 0;
              const messagesSinceRetitle = totalMessages - lastRetitleAt;
              const attemptsSoFar = titleAttemptsRef.current.get(sid) || 0;
              const inFlight = titlingInFlightRef.current.has(sid);

              const shouldTitlePlaceholder =
                isPlaceholder && totalMessages >= 2 && attemptsSoFar < 3 && !inFlight;
              const shouldRetitle =
                !isPlaceholder && isAutoTitled && messagesSinceRetitle >= 10 && !inFlight;

              if (shouldTitlePlaceholder || shouldRetitle) {
                titlingInFlightRef.current.add(sid);
                if (shouldTitlePlaceholder) {
                  titleAttemptsRef.current.set(sid, attemptsSoFar + 1);
                }
                const transcript = [...(messagesRef.current || []), aiMsg]
                  .map(m => ({ role: m.role, content: m.content }));
                generateConversationTitle(transcript)
                  .then(title => {
                    if (!title || !db.sessionId) return;
                    // For re-titling: skip the rename if the new title is
                    // basically the same as the existing one (case/whitespace
                    // normalization). Avoids spurious "renamed to same thing"
                    // updates that flicker the sidebar and hit the server.
                    if (shouldRetitle) {
                      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
                      if (norm(title) === norm(currentName)) return;
                    }
                    try {
                      db.renameSession(sid, title);
                      // Mark as auto-titled so re-title path can find it.
                      try { localStorage.setItem(`auto_titled_${sid}`, '1'); } catch {}
                      lastRetitleAtRef.current.set(sid, totalMessages);
                    } catch {}
                  })
                  .catch((err) => {
                    console.warn('[auto-title] caller-side error:', err?.message || err);
                  })
                  .finally(() => {
                    titlingInFlightRef.current.delete(sid);
                  });
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

        const actualError = err?.message || 'Unknown error';

        // ── Auto-fallback on upstream provider outage ──
        // If the model's provider is having a temporary problem (e.g. Gemini
        // "project denied access", a 5xx, or a rate-limit) don't dump a raw
        // error into a live interview. Switch to another model the user can
        // use and silently retry the SAME question. Only once (guarded by
        // _fallbackAttempt) so we never loop across a full provider outage.
        const failedModel = settingsRef.current.selectedModel;
        if (!_fallbackAttempt && looksLikeProviderOutage(actualError)) {
          const next = pickFallbackModel(failedModel, gate.allowedModels);
          if (next) {
            const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
            const failedLabel = MODEL_REGISTRY[failedModel as ModelKey]?.short ?? cap(failedModel);
            const nextLabel = MODEL_REGISTRY[next]?.short ?? cap(next);
            // Persist + reflect the switch so the picker + subsequent sends
            // use the working model too (not just this one retry). The
            // existing state-sync effect (keyed on settings.selectedModel)
            // relays the change to the Electron popout automatically.
            setSettings(prev => ({ ...prev, selectedModel: next }));
            try { localStorage.setItem('SELECTED_MODEL', next); } catch { /* quota */ }
            const noticeMsg: Message = {
              id: Date.now().toString(),
              role: 'model',
              content: `⚠️ **${failedLabel}** is having a temporary service problem. Switched to **${nextLabel}** and retried your question.`,
              timestamp: Date.now(),
            };
            if (db.isElectron) { db.addMessage(noticeMsg); } else { setMessages(prev => [...prev, noticeMsg]); }
            // settingsRef updates on the next render; pass the model explicitly
            // is unnecessary because we re-read settingsRef inside the retry,
            // but React may not have flushed setSettings yet — so mutate the
            // ref directly for this immediate retry.
            settingsRef.current = { ...settingsRef.current, selectedModel: next };
            // Clear processing for THIS attempt's controller before recursing;
            // the retry seeds its own controller + isProcessing.
            if (streamAbortRef.current === abort) { streamAbortRef.current = null; }
            void executeSend(textToSend, imageBase64, isAutoSolve, (_fallbackAttempt || 0) + 1);
            return;
          }
        }

        // No fallback available (or already retried) — show a friendly error.
        // For a known provider outage with no alternative model, phrase it as a
        // service problem rather than a raw JSON dump; otherwise show the
        // message as-is. Never suggest logging out (catastrophic mid-interview).
        const errorContent = looksLikeProviderOutage(actualError)
          ? `⚠️ ${MODEL_REGISTRY[failedModel as ModelKey]?.short ?? failedModel} is having a temporary service problem. Please try again in a moment, or pick another model.`
          : `Error: ${actualError}`;

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

  // ── Speculative cache warming during transcription ──
  // As inputText / interimText updates (from speech OR typing), fire
  // /prefetch-context with a 500ms debounce. The server classifies
  // (tool+specificity OR update-signal) and runs enrichTranscript() in
  // the background, populating the Brave + page-content caches. By the
  // time the user clicks Send, the chat call's enrichTranscript hits
  // warm caches (~10ms) instead of paying the cold ~1500ms cost.
  //
  // Enabled in BOTH main AND popout windows. Server-side dedup (30s TTL,
  // keyed by lowercased query) catches the duplicate when both windows
  // have synced state for the same transcript. The cost is one extra
  // ~5ms server-side dedup check, which is negligible.
  //
  // Disabled while processing — the model is already generating; another
  // prefetch in-flight would be a waste of Brave quota.
  usePrefetchContext({
    transcript: `${inputText} ${interimText}`,
    enabled: !isProcessing,
  });

  // ── Clean-close listener ─────────────────────────────────────────────
  // Main process broadcasts 'cmd-end-session' on the user's "I'm done"
  // signals: X-close when popout is NOT in use, and tray Quit (always).
  // We react by stopping the mic and turning off Auto so the next launch
  // (or the next show-from-tray) starts in a clean state.
  //
  // Conversation switch is NOT done here — main's endSessionCleanly also
  // emits the existing db:active-session-changed broadcast, which
  // useDatabase.ts already handles by reloading messages/files for the
  // newly-active (fresh empty) session.
  //
  // Main window only — popout mirrors mic/Auto state via the existing
  // state-sync effect, no separate listener needed there.
  //
  // _rawStopListening is idempotent — it checks mediaRecorderRef / socketRef
  // before doing anything, so calling it when not listening is a no-op.
  // setSettings function-updater form reads latest state so we never write
  // a stale autoSend. Result: this handler is mount-once, stale-closure-safe.
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;
    return electronIPC.on('cmd-end-session', () => {
      try { _rawStopListening(); } catch (err) { console.warn('[end-session] stopListening threw:', err); }
      setSettings(prev => prev.autoSend ? { ...prev, autoSend: false } : prev);
    });
  }, [_rawStopListening]);

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
  // Plan-window grant for the popout's tube gauge. null = unknown/unlimited
  // → the popout chip renders with no tube (fail-soft), same as main.
  const [remoteCreditGrantedSeconds, setRemoteCreditGrantedSeconds] = useState<number | null>(null);
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
    granted: number | null;
  }>({ hourBoundary: false, lowWarning: false, exhausted: false, remaining: 0, source: 'none', granted: null });
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
  // Main window → pop-out: relay state whenever it changes.
  //
  // Send directly on every state change. An earlier version coalesced via
  // requestAnimationFrame to reduce IPC pressure during transcription,
  // but Chromium pauses rAF callbacks entirely when a window is hidden
  // or occluded — and main is exactly that during an interview (popout
  // is always-on-top, main is skipTaskbar + behind the interview app).
  // The pending rAF never fired, so the LIVE/AUTO chips and input
  // textbox in the popout stayed frozen at their last-known state.
  // Direct send works regardless of main's visibility; IPC pressure at
  // ~5Hz interim ticks + keystrokes is well within Electron's headroom.
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
        // Tube grant: only finite positives count; anything else (absent
        // field from an older main build, unlimited, malformed) → null →
        // no tube. Fail-soft by construction.
        setRemoteCreditGrantedSeconds(
          typeof data.grantedSeconds === 'number' && Number.isFinite(data.grantedSeconds) && data.grantedSeconds > 0
            ? data.grantedSeconds
            : null
        );
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
      granted: creditTimer.granted,
    };
  }, [creditTimer.hourBoundary, creditTimer.lowWarning, creditTimer.exhausted, creditTimer.remaining, creditTimer.source, creditTimer.granted]);

  // Main → popout: push credit-timer state so the popout can render its own
  // copy of the modals. The first state-sync effect above is declared before
  // `creditTimer` exists, so we keep this as a separate effect (no TDZ).
  //
  // `remaining` IS in the dep list below so this fires every tick. The popout
  // is a separate renderer whose local timer is a no-op, so its countdown chip
  // + tube only stay in lockstep with main if we re-push on each tick. (Owner
  // ask: the popout timer must sync exactly.) Cost is one small IPC + setState
  // per second; every field except `remaining` is unchanged tick-to-tick, so
  // the popout's setState calls bail out of re-render via React's Object.is
  // check and only the countdown/tube repaint. During an hour-boundary the
  // tick loop is paused, so `remaining` stops changing and this goes quiet.
  // (We still read the value from the ref, kept fresh by the effect above,
  // which runs first on the same commit.)
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;
    electronIPC.send('relay-to-popout', {
      type: 'credit-sync',
      hourBoundary: creditTimer.hourBoundary,
      lowWarning: creditTimer.lowWarning,
      exhausted: creditTimer.exhausted,
      remaining: creditTimerRef.current.remaining,
      source: creditTimer.source,
      // Tube grant for the popout gauge. Infinity (unlimited) is sent as
      // null on purpose — "no fraction" is the unlimited treatment and
      // null survives any IPC serialization; Infinity might not.
      grantedSeconds: Number.isFinite(creditTimer.granted as number) ? creditTimer.granted : null,
      actualTier: gate.actualTier,
      countryCode: userProfile?.country_code || 'US',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditTimer.remaining, creditTimer.hourBoundary, creditTimer.lowWarning, creditTimer.exhausted, creditTimer.source, creditTimer.granted, gate.actualTier, userProfile?.country_code]);

  // Refresh React state from the localStorage that licenseService just
  // updated. Used as the onSuccess callback for the post-checkout polling
  // helpers below — without this, the chat-header tier badge and other
  // userLicense consumers stay on the OLD tier until the next periodic
  // revalidation tick fires (or the user restarts the app).
  const refreshAuthFromStorage = useCallback(() => {
    const saved = licenseService.loadAuth();
    if (saved.user) setUserProfile(saved.user);
    if (saved.license) setUserLicense(saved.license);
  }, [setUserProfile, setUserLicense]);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  SUPPORT-BOT ACTION DISPATCHER
  //
  //  The in-app "Chat with Minica" panel runs SupportBot in mode="panel",
  //  which gives Minica renderer-side tools (set theme, swap model, open
  //  Manage Subscription, cancel/reactivate subscription, sign out…).
  //  The server executes the tool, emits an SSE `tool_call`
  //  { payload: { action, args } }, and synthesizes an optimistic ok:true
  //  back into the model loop. SupportBot.tsx forwards that payload here
  //  via its onBotAction prop. Without this wiring every client-side tool
  //  is a silent no-op — the bot claims "done" and nothing changes.
  //  `open_handoff_form` is intentionally NOT handled here: SupportBot
  //  owns the handoff form and dispatches it internally.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const botActionDispatcher = useCallback(async ({ action, args }: { action: string; args?: any }) => {
    const a = args || {};
    try {
      switch (action) {
        case 'set_theme':
          if (a.theme === 'light' || a.theme === 'dark') {
            setSettings(prev => ({ ...prev, theme: a.theme }));
          }
          break;
        case 'set_font_size':
          if (a.size === 'small' || a.size === 'medium' || a.size === 'large') {
            setSettings(prev => ({ ...prev, fontSize: a.size }));
            try { localStorage.setItem('FONT_SIZE', a.size); } catch { /* quota */ }
          }
          break;
        case 'set_ai_model':
          if (['gemini', 'groq', 'openai', 'xai', 'claude'].includes(a.model)) {
            setSettings(prev => ({ ...prev, selectedModel: a.model }));
            try { localStorage.setItem('SELECTED_MODEL', a.model); } catch { /* quota */ }
          }
          break;
        case 'set_reasoning_effort':
          if (['none', 'low', 'medium', 'high'].includes(a.effort)) {
            setSettings(prev => ({ ...prev, reasoningEffort: a.effort }));
          }
          break;
        case 'toggle_auto_send':
          setSettings(prev => ({ ...prev, autoSend: !!a.enabled }));
          break;
        case 'toggle_general_mode':
          setSettings(prev => ({ ...prev, generalMode: !!a.enabled }));
          break;
        case 'set_custom_instructions':
          setSettings(prev => ({ ...prev, customInstructions: String(a.instructions || '') }));
          break;
        case 'open_popout':
          if (isElectron) electronIPC.send('open-popout', { width: 450, height: 700 });
          break;
        case 'replay_tutorial':
          handleReplayTutorial();
          break;
        case 'sign_out':
          onLogout();
          break;
        // No standalone password dialog exists in-app; account management
        // (incl. the route to change credentials) lives in Manage Subscription.
        case 'open_password_change_dialog':
        case 'open_manage_subscription':
          setManageSubOpen(true);
          break;
        case 'refresh_user_profile':
          refreshAuthFromStorage();
          break;
        case 'open_external_url':
          if (typeof a.url === 'string' && /^https?:\/\//i.test(a.url)) {
            const api = (window as any).electronAPI;
            if (isElectron && api?.openExternalRobust) {
              api.openExternalRobust(a.url).catch(() => { /* swallow */ });
            } else {
              window.open(a.url, '_blank', 'noopener,noreferrer');
            }
          }
          break;
        case 'call_authed_endpoint': {
          // Used by cancel_subscription / reactivate_subscription — the bot
          // routes the mutation through the renderer so it carries the live
          // JWT and the licenseService cache refreshes in one path.
          const path = String(a.path || '');
          if (!path.startsWith('/api/')) break;
          const method = String(a.method || 'POST').toUpperCase();
          const viteEnv = (import.meta as any).env || {};
          const httpBase = viteEnv.PROD
            ? 'https://api.minicaai.com'
            : (viteEnv.VITE_SERVER_URL || 'https://api.minicaai.com');
          const token = licenseService.getToken();
          try {
            await fetch(`${httpBase}${path}`, {
              method,
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
            });
          } catch { /* never bubble — server already synthesized ok */ }
          // Re-pull license state after the mutation lands. The periodic
          // revalidation tick will catch the authoritative tier; this just
          // refreshes from whatever the payment flow persisted.
          if (a.refresh_license) {
            window.setTimeout(() => { try { refreshAuthFromStorage(); } catch { /* */ } }, 800);
          }
          break;
        }
        case 'download_json': {
          // emit_to_client.args = { content: <JSON string>, filename }
          const blob = new Blob([String(a.content ?? '{}')], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = String(a.filename || 'minicaai-export.json');
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 4000);
          break;
        }
        default:
          console.warn('[botActionDispatcher] unhandled bot action:', action);
      }
    } catch (err) {
      // Fire-and-forget contract: the server already told the model the
      // action succeeded. Swallow renderer-side failures; the user can
      // re-ask and the next turn surfaces any real problem.
      console.warn('[botActionDispatcher] action failed:', action, err);
    }
  }, [setSettings, setManageSubOpen, handleReplayTutorial, refreshAuthFromStorage, onLogout]);

  const handleRenewCredit = useCallback(async (packId?: string) => {
    // Routes to /extend-now (one-click, graduated top-up: m30 $25 / h1 $45 / h3 $80)
    // with checkout fallbacks. Pack determines price+seconds; server re-derives
    // the amount from the id. Also the target of the popout's cmd-credit-renew relay.
    try { await openProRenewal(refreshAuthFromStorage, packId); } catch (e) { console.warn('renew failed:', e); }
  }, [refreshAuthFromStorage]);

  const handleOpenUpgrade = useCallback(async () => {
    // The ExhaustedModal button reads "See plans" for every tier (2026-07
    // model: Basic/Pro/Max are one-time interview passes, Ultra is the
    // unlimited subscription — there's no single obvious "next tier" to
    // pre-pick for the user). Open the plan picker so they can compare
    // and choose; every row there routes through the same checkout flow.
    setManageSubOpen(true);
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
    // ── Feature Gate: Screen capture ships with every paid plan ──
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
            grantedSeconds: Number.isFinite(creditTimerRef.current.granted as number)
              ? creditTimerRef.current.granted
              : null,
            actualTier: gateRef.current.actualTier,
            countryCode: userProfileRef.current?.country_code || 'US',
          });
          break;
      }
    };
    return electronIPC.on('from-popout', handler);
  }, [executeSend, captureScreenshot, _rawStartListening, _rawStopListening]);

  const handleAutoSolve = async () => {
    // ── Feature Gate: Auto-Solve ships with every paid plan ──
    if (!gate.canAutoSolve) {
      // Auto-Solve ships with every paid plan (FEATURE_GATES.*.autoSolve).
      // Only post-trial Free and lapsed plans land here — tier-aware copy
      // so a lapsed paying customer is told to RENEW, not to "upgrade".
      const autoSolveTierLabel = gate.actualTier.charAt(0).toUpperCase() + gate.actualTier.slice(1);
      const gateMsg: Message = {
        id: Date.now().toString(),
        role: 'model',
        content: gate.planLapsed && gate.actualTier !== 'free'
          ? `**Auto-Solve** comes with your plan, but your **${autoSolveTierLabel} plan** has ended. [Renew your plan](upgrade) to keep using it.`
          : '**Auto-Solve** comes with every paid plan. [See plans](upgrade) to capture your screen and get instant AI solutions.',
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

  // ── Knowledge drop-zone helpers ──
  // Three input modes — drag-drop a file, click to open the picker, or
  // Cmd/Ctrl+V paste anywhere in the modal. The paste handler delegates
  // to either the file pipeline (if clipboard has files / images) or the
  // text snippet helper (if clipboard has plain text). Single mental
  // model for the user — "drop, click, or paste" — replacing the prior
  // "Add File button + Quick Paste textarea" split that confused users.

  const addTextSnippet = (text: string, label?: string) => {
      if (!text.trim()) return;
      if (gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles) return;
      const newFile: ContextFile = {
          id: Date.now().toString(),
          name: label || `Pasted Snippet ${db.contextFiles.length + 1}`,
          content: text,
          type: 'custom'
      };
      db.addContextFile(newFile);
  };

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
  };
  const handleDragEnter = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
  };
  const handleFilesDrop = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      // Same mic-listening guard as the click-to-browse path: native file
      // pickers / drop-handlers aren't covered by setContentProtection,
      // so dragged filenames could leak on screen-share. Silent return
      // matches the click-disabled UX above.
      if (_rawIsListening) return;
      const files = e.dataTransfer.files;
      if (!files?.length) return;
      // Reuse handleFileUpload's full processing pipeline (PDF/DOCX
      // extraction, text decoding, base64 for images, gate enforcement)
      // by synthesizing the change-event shape it expects.
      const fakeEvent = { target: { files, value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>;
      handleFileUpload(fakeEvent);
  };

  const handleModalPaste = (e: React.ClipboardEvent) => {
      // Native paste should keep working inside textareas / inputs —
      // typing the resume into the paste-fallback textarea or pasting
      // into Custom Instructions both need this. Only intercept paste
      // when the focus is on a non-editable element (the modal frame
      // or the drop-zone itself), so the snippet auto-add fires there.
      const target = e.target as HTMLElement;
      const isEditable = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;
      if (isEditable) return;
      // Files in clipboard (Cmd+V'd a file from Finder, or copied an
      // image from a browser screenshot tool) → upload pipeline.
      if (e.clipboardData.files.length > 0) {
          e.preventDefault();
          const fakeEvent = { target: { files: e.clipboardData.files, value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>;
          handleFileUpload(fakeEvent);
          return;
      }
      // Plain text → unified files list as a "Pasted Snippet" entry.
      // 500K-char ceiling defends against accidental dumps (e.g. user
      // copies a whole book / a 50MB log file). Above that, React state
      // updates start to choke and the modal hangs visibly. We
      // deliberately don't truncate — better to refuse loudly than to
      // silently drop content the user thinks they added.
      const text = e.clipboardData.getData('text');
      if (text.trim()) {
          e.preventDefault();
          if (text.length > 500_000) {
              alert(
                  `That's a large paste (${text.length.toLocaleString()} chars). ` +
                  `For reliability, please paste under ~500,000 characters or ` +
                  `upload as a file instead.`
              );
              return;
          }
          addTextSnippet(text);
      }
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
    isPinned, newSinceUnpin, handleJumpToLatest, sidebarOpen,
    onOpenSettings: () => setShowSettings(true),
    onOpenContext: () => setShowContext(true),
    onOpenHelp: () => setShowHelp(true),
    onOpenSupport: () => setShowSupport(true),
    onOpenDownload: () => { if (!isElectron) setShowDownloadModal(true); },
    handlePlaySampleQuestion: !isElectron ? () => {
      const sample =
        'Tell me about a time you had to debug a production incident under pressure.';
      void executeSend(sample);
    } : undefined,
    onClosePip: () => {
      if (isElectron) {
        electronIPC.send('close-popout');
      }
      setIsPipMode(false);
    },
    isPipMode,
    togglePip: () => {
      // ── Feature Gate: Pop-out ships with EVERY paid plan (Basic and up —
      // FEATURE_GATES.*.popout). Only post-trial Free users and LAPSED
      // plans land here; a time-exhausted Basic/Pro/Max keeps canPopout
      // (their tier persists — see getEffectiveTier) and never hits this
      // block. Copy is tier-aware so a lapsed Pro is told to RENEW the
      // plan they already bought — never to "upgrade" to it.
      if (!gate.canPopout) {
        const tierLabel = gate.actualTier.charAt(0).toUpperCase() + gate.actualTier.slice(1);
        const gateMsg: Message = {
          id: Date.now().toString(),
          role: 'model',
          content: gate.planLapsed && gate.actualTier !== 'free'
            ? `**Pop-out Mode** comes with your plan, but your **${tierLabel} plan** has ended. [Renew your plan](upgrade) to keep using the invisible overlay.`
            : '**Pop-out Mode** comes with every paid plan. [See plans](upgrade) to use the invisible overlay during interviews.',
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
      granted: remoteCreditGrantedSeconds,
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
            className="fixed top-3 left-3 z-40 w-9 h-9 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] flex items-center justify-center text-gray-400 hover:text-[#d3ac63] transition-all backdrop-blur-md"
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
                          : <>This tab is now "Safe to Share".<br/>The AI interface has moved to a Picture-in-Picture window.</>
                        }
                    </p>
                    {!isElectron && (
                      <p className="text-xs text-amber-300/90 max-w-md mx-auto mt-3 leading-relaxed">
                        Download the desktop app for the invisible, always-on-top version.{' '}
                        <button
                          type="button"
                          onClick={() => window.dispatchEvent(new CustomEvent('app:open-download'))}
                          className="underline font-semibold text-blue-300 hover:text-blue-200"
                        >
                          Download desktop app
                        </button>
                      </p>
                    )}
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
         <div className="space-y-5">

            {/* iOS segmented control — General | Usage */}
            <div
              className="flex p-0.5 rounded-[10px]"
              role="tablist"
              aria-label="Settings sections"
              style={{ background: 'rgba(120,120,128,0.16)' }}
            >
              {([
                { id: 'general' as const, label: 'General' },
                { id: 'usage' as const, label: 'Usage' },
              ]).map(tab => {
                const active = settingsTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSettingsTab(tab.id)}
                    className={`flex-1 py-1.5 rounded-[8px] text-[13px] font-semibold transition-all ${
                      active
                        ? 'bg-white dark:bg-[#3a3a3c] text-text shadow-sm'
                        : 'text-gray-500 dark:text-gray-400 hover:text-text'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {settingsTab === 'usage' ? (
              /* Usage tab — iOS-style interview-time meter (server ledger + live clock) */
              <UsagePanel
                tier={userLicense?.tier || 'free'}
                onRenew={() => { setShowSettings(false); setManageSubOpen(true); }}
              />
            ) : (
            <>
            {/* Subscription / Billing — dedicated, always-visible entry so web
                users (and admins on ultra) have an obvious, named place to view
                their plan, update payment, or cancel, instead of only the small
                header tier badge. Opens the same ManageSubscription surface via
                the existing setShowSettings(false)+setManageSubOpen(true) pattern
                used by the model-picker locked-card handler below. */}
            <div className="bg-black/[0.04] dark:bg-white/[0.025] p-4 rounded-2xl space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <label className="text-sm font-bold text-text flex items-center gap-2">
                        <Crown size={16} /> Subscription &amp; Billing
                    </label>
                    <span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-gray-300 bg-white/[0.06] px-2.5 py-0.5 rounded-full border border-white/10">
                        {(userLicense?.tier || 'free').toUpperCase()} plan
                    </span>
                </div>
                <p className="text-xs text-gray-400">
                    View your current plan, update your payment method, upgrade, or cancel — all in one place.
                </p>
                <button
                    onClick={() => { setShowSettings(false); setManageSubOpen(true); }}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-blue-500/15 to-purple-500/10 text-blue-300 hover:from-blue-500/25 hover:to-purple-500/20 border border-blue-500/25 transition-all flex items-center justify-center gap-2"
                >
                    <ExternalLink size={14} /> Manage subscription
                </button>
            </div>

            {/* Model Selection */}
            <div className="bg-black/[0.04] dark:bg-white/[0.025] p-4 rounded-2xl space-y-3.5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <label className="text-sm font-bold text-text flex items-center gap-2">
                        {/* Faceted-gem mark (gold hairline) — premium, and
                            echoes the landing's crystal orb. Replaces the
                            generic Sparkles glyph. */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                          <defs>
                            <linearGradient id="pl-modelmark" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
                              <stop stopColor="#f6e4b0" />
                              <stop offset="1" stopColor="#b58f45" />
                            </linearGradient>
                          </defs>
                          <path d="M12 2.6 20.4 7.5v9L12 21.4 3.6 16.5v-9L12 2.6Z" stroke="url(#pl-modelmark)" strokeWidth="1.3" strokeLinejoin="round" />
                          <path d="M12 8.1 15.5 10.15v3.7L12 15.9 8.5 13.85v-3.7L12 8.1Z" stroke="url(#pl-modelmark)" strokeWidth="1" strokeLinejoin="round" opacity="0.6" />
                        </svg>
                        AI Model Selection
                    </label>
                    {/* Tier-aware upgrade prompt. Max → "Full access" pill (no
                        nag, just confirmation). Pro → Claude path. Basic → both
                        paths (Pro for unlimited time, Max for Claude). Free →
                        same dual hint, framed for a brand-new user. Replaces
                        the old single-pill "Upgrade to Max for all models"
                        which was misleading because Pro also has 4 models —
                        the only model going from Pro→Max unlocks is Claude. */}
                    {gate.isMax ? (
                      <span className="mp-hint"><WizardHat size={9} /> Full access</span>
                    ) : gate.isPro ? (
                      <span className="mp-hint"><Crown size={9} /> Max adds Train Model + reasoning</span>
                    ) : gate.isBasic ? (
                      <span className="mp-hint"><Crown size={9} /> Pro adds Claude · Max adds Train Model</span>
                    ) : (
                      <span className="mp-hint"><Crown size={9} /> Basic: 4 models · Pro adds Claude</span>
                    )}
                </div>
                {/* Layout — 2x2 grid for Gemini / Groq / GPT / Grok in
                    compact form, then Claude full-width below as the
                    showcase Max card. Keeps every model visible without
                    scrolling the settings modal, while preserving the
                    visual climax: Claude alone occupies a full row with
                    the metallic rim and serif name. CSS lives in
                    index.html under .mp-card / .mp-card.is-compact /
                    .mp-card-max. Locked cards open ManageSubscription so
                    the picker doubles as a sales path. */}
                <div className="space-y-2.5">
                    <div className="grid grid-cols-2 gap-2">
                        {(['gemini', 'groq', 'openai', 'xai'] as ModelKey[]).map(key => (
                            <ModelPickerCard
                                key={key}
                                modelKey={key}
                                selected={tempModel === key}
                                allowed={gate.canUseModel(key)}
                                variant="full"
                                compact
                                onSelect={() => setTempModel(key)}
                                onLockedClick={() => {
                                    setShowSettings(false);
                                    setManageSubOpen(true);
                                }}
                            />
                        ))}
                    </div>
                    <ModelPickerCard
                        modelKey="claude"
                        selected={tempModel === 'claude'}
                        allowed={gate.canUseModel('claude')}
                        variant="full"
                        onSelect={() => setTempModel('claude')}
                        onLockedClick={() => {
                            setShowSettings(false);
                            setManageSubOpen(true);
                        }}
                    />
                </div>
            </div>

            <button
                onClick={saveSettings}
                className={`w-full px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all ${
                    saveStatus === 'saved'
                    ? 'bg-emerald-500/90 text-white'
                    : 'btn-gold-glass'
                }`}
            >
                {saveStatus === 'saved' ? <Check size={16} /> : <Save size={16} />}
                {saveStatus === 'saved' ? 'Settings Saved' : 'Save Settings'}
            </button>

            <div className="bg-black/[0.04] dark:bg-white/[0.025] p-4 rounded-2xl space-y-4">
                <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-[#8a6d2f] dark:text-[#c9a86a]/80">Preferences</p>

                {/* Theme Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text">App Theme</span>
                    <div className="flex items-center gap-0.5 bg-black/25 rounded-lg p-0.5">
                        <button
                            onClick={() => setSettings(s => ({...s, theme: 'light'}))}
                            className={`p-1.5 rounded-md transition-all ${settings.theme === 'light' ? 'bg-[#d3ac63] text-[#241b08]' : 'text-gray-400 hover:text-gray-200'}`}
                        >
                            <Sun size={15} />
                        </button>
                        <button
                            onClick={() => setSettings(s => ({...s, theme: 'dark'}))}
                            className={`p-1.5 rounded-md transition-all ${settings.theme === 'dark' ? 'bg-[#d3ac63] text-[#241b08]' : 'text-gray-400 hover:text-gray-200'}`}
                        >
                            <Moon size={15} />
                        </button>
                    </div>
                </div>

                {/* Font Size Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text">Text Size</span>
                    <div className="flex items-center gap-0.5 bg-black/25 rounded-lg p-0.5">
                        {(['small', 'medium', 'large'] as const).map((size) => (
                            <button
                                key={size}
                                onClick={() => setSettings(s => ({...s, fontSize: size}))}
                                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                                    settings.fontSize === size
                                    ? 'bg-[#d3ac63] text-[#241b08]'
                                    : 'text-gray-400 hover:text-gray-200'
                                }`}
                            >
                                {size.charAt(0).toUpperCase() + size.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Local-Only Auto-Type — Electron only (Auto-Type itself
                    only exists in the desktop build, so the toggle is
                    meaningless on web). Keeps editor text on-device by
                    suppressing the Haiku planner Railway call when the
                    deterministic UIA planner returns low confidence. */}
                {isElectron && (
                  <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                          <span className="text-sm font-medium text-text">Local-Only Auto-Type</span>
                          <span className="text-xs text-gray-500 mt-0.5">No editor text leaves your device. Use on monitored networks.</span>
                      </div>
                      <button
                          role="switch"
                          aria-checked={settings.localOnlyAutoType}
                          onClick={() => setSettings(s => ({ ...s, localOnlyAutoType: !s.localOnlyAutoType }))}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                              settings.localOnlyAutoType ? 'bg-[#d3ac63]' : 'bg-white/15'
                          }`}
                      >
                          <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                  settings.localOnlyAutoType ? 'translate-x-6' : 'translate-x-1'
                              }`}
                          />
                      </button>
                  </div>
                )}

                {/* ── GPT Reasoning Speed ──
                    Switch bar: None / Low / Medium / High. Max-tier only —
                    lower tiers see the bar but only None is enabled, with
                    Crown badges on the locked levels.
                    Server enforces tier-gating via JWT regardless of what
                    the client sends, so this UI is affordance-only. The
                    contextual help below adapts to (a) tier and (b) whether
                    the user has trained their model — explaining how
                    Train Model + None gives instant high-quality answers. */}
                <div className="flex flex-col gap-2 pt-1">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-text">GPT Reasoning Speed</span>
                        {!gate.canChooseReasoningEffort && (
                            <span className="text-[9px] font-bold tracking-wider bg-amber-400/10 text-amber-400 px-1.5 py-0.5 rounded border border-amber-400/30 flex items-center gap-1">
                                <WizardHat size={9} /> MAX
                            </span>
                        )}
                    </div>
                    <div className="grid grid-cols-4 gap-0.5 bg-black/25 rounded-lg p-0.5">
                        {(['none', 'low', 'medium', 'high'] as const).map((level) => {
                            const isActive = settings.reasoningEffort === level;
                            const isLockedForTier = !gate.canChooseReasoningEffort && level !== 'none';
                            return (
                                <button
                                    key={level}
                                    onClick={() => {
                                        if (isLockedForTier) return;
                                        setSettings(s => ({ ...s, reasoningEffort: level }));
                                    }}
                                    disabled={isLockedForTier}
                                    title={
                                        level === 'none' ? 'Skip chain-of-thought · ~1-3s answers' :
                                        level === 'low' ? 'Light reasoning · ~3-6s answers' :
                                        level === 'medium' ? 'Balanced reasoning · ~5-10s answers' :
                                        'Deep reasoning · ~10-25s answers'
                                    }
                                    className={`relative px-2 py-1.5 rounded-md text-xs font-semibold transition-all ${
                                        isLockedForTier
                                            ? 'text-gray-600 cursor-not-allowed opacity-70'
                                            : isActive
                                                ? 'bg-[#d3ac63] text-[#241b08]'
                                                : 'text-gray-400 hover:text-gray-200'
                                    }`}
                                >
                                    {level.charAt(0).toUpperCase() + level.slice(1)}
                                    {isLockedForTier && (
                                        <WizardHat size={8} className="absolute top-0.5 right-0.5 text-amber-400/70" />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    {/* Contextual help — adapts to tier + training status */}
                    <div className={`text-[10px] leading-relaxed mt-0.5 px-2.5 py-2 rounded-lg ${
                        !gate.canChooseReasoningEffort
                            ? 'bg-amber-400/[0.12] text-amber-800 dark:bg-amber-400/[0.07] dark:text-amber-200/75'
                            : hasTrainedCache && settings.reasoningEffort === 'none'
                                ? 'bg-emerald-500/[0.12] text-emerald-800 dark:bg-emerald-500/[0.09] dark:text-emerald-300/90'
                                : !hasTrainedCache && settings.reasoningEffort === 'none'
                                    ? 'bg-orange-500/[0.12] text-orange-800 dark:bg-orange-500/[0.09] dark:text-orange-300/80'
                                    : 'bg-blue-500/[0.12] text-blue-800 dark:bg-blue-500/[0.07] dark:text-blue-300/80'
                    }`}>
                        {!gate.canChooseReasoningEffort ? (
                            <>
                                <span className="font-semibold">Locked to None.</span>{' '}
                                Upgrade to Max to control reasoning depth and unlock Train Model — pre-research your resume + JD for instant high-quality answers on None.
                            </>
                        ) : hasTrainedCache && settings.reasoningEffort === 'none' ? (
                            <>
                                <span className="font-semibold">⚡ Instant mode active.</span>{' '}
                                Your trained tech-state card supplies the depth GPT skips — answers in ~1-3s with full grounding from your researched stack.
                            </>
                        ) : !hasTrainedCache && settings.reasoningEffort === 'none' ? (
                            <>
                                <span className="font-semibold">Fast but shallow.</span>{' '}
                                You haven't trained yet — answers come back quickly but only from GPT's base knowledge. Train your model (above) to get instant <em>and</em> deeply-grounded answers, or pick a higher reasoning level for live deeper thinking (slower).
                            </>
                        ) : settings.reasoningEffort === 'high' ? (
                            <>
                                <span className="font-semibold">Deep reasoning · slowest.</span>{' '}
                                GPT will think for ~10-25s before answering. Best for system-design or multi-step coding questions. {!hasTrainedCache && 'Tip: Train Model gets you instant answers without the wait.'}
                            </>
                        ) : (
                            <>
                                <span className="font-semibold">{settings.reasoningEffort === 'low' ? 'Light reasoning' : 'Balanced reasoning'}.</span>{' '}
                                {settings.reasoningEffort === 'low' ? '~3-6s' : '~5-10s'} answers — GPT thinks before responding. {!hasTrainedCache && 'Train Model to skip the wait while keeping quality.'}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* ── App Updates (Electron only) ── */}
            {isElectron && (
              <div className="bg-black/[0.04] dark:bg-white/[0.025] p-4 rounded-2xl">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-text">App Updates</span>
                    <p className="text-xs text-gray-500 mt-0.5">v{APP_VERSION}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {updateStatus.status === 'idle' || updateStatus.status === 'up-to-date' || updateStatus.status === 'error' ? (
                      <button
                        onClick={() => electronIPC.send('check-for-updates')}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-black/[0.05] hover:bg-black/[0.09] text-gray-600 hover:text-[#a07d2f] dark:bg-white/[0.05] dark:hover:bg-white/[0.09] dark:text-gray-300 dark:hover:text-[#d3ac63] transition-all flex items-center gap-1.5"
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
            </>
            )}

         </div>
      </Modal>

      {/* --- First-launch Tutorial (auto on first login per account, replayable from Help) --- */}
      <Tutorial
        isOpen={tutorialOpen}
        onClose={handleTutorialClose}
        onOpenDownload={!isElectron ? () => setShowDownloadModal(true) : undefined}
      />

      {/* --- Manage Subscription full-screen overlay (opened from tier badge) --- */}
      <ManageSubscription
          isOpen={manageSubOpen}
          onClose={() => setManageSubOpen(false)}
          userProfile={userProfile}
          userLicense={userLicense}
          onUpgradeRequested={handleSubscriptionUpgrade}
          onProfileUpdated={(updated) => setUserProfile(updated)}
          onLicenseUpdated={(updated) => setUserLicense(updated)}
          onRenewRequested={async () => {
              // Mirror handleSubscriptionUpgrade's choreography for the
              // +1h Basic renewal. Without this, the modal closed instantly
              // on click and the renewal happened "somewhere offstage".
              setRenewPending(true);
              try {
                  await openProRenewal(refreshAuthFromStorage);
                  await new Promise(r => setTimeout(r, 600));
                  setManageSubOpen(false);
              } finally {
                  setRenewPending(false);
              }
          }}
          upgradePending={upgradePending}
          renewPending={renewPending}
      />

      {/* --- Checkout-status toast — visible feedback for the upgrade flow ---
          Z-index above ManageSubscription's z-99999 so the user sees status
          regardless of which surface they clicked from. Without this, the
          modal closing was the only visible signal that anything happened.

          When a URL is attached we render Copy URL + Open in browser
          buttons so the user always has a manual fallback — shell.openExternal
          can claim success and yet not surface a browser window (default-
          browser registration corrupted, AV blocking, OS shell process
          busy). The user can copy the URL into the browser of their
          choice instead of being stranded. */}
      {checkoutToast && (
        <div
          className="fixed left-1/2 top-4 -translate-x-1/2 z-[100000] max-w-lg w-[92vw] sm:w-auto pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <div
            className={`pointer-events-auto rounded-xl shadow-2xl px-4 py-3 text-sm font-medium border backdrop-blur-md ${
              checkoutToast.kind === 'error' || checkoutToast.kind === 'no-token'
                ? 'bg-red-600/95 border-red-400 text-white shadow-red-500/30'
              : checkoutToast.kind === 'sync-grant' || checkoutToast.kind === 'completed'
                ? 'bg-emerald-600/95 border-emerald-400 text-white shadow-emerald-500/30'
              : checkoutToast.kind === 'timeout'
                ? 'bg-amber-600/95 border-amber-400 text-white shadow-amber-500/30'
              : 'bg-blue-600/95 border-blue-400 text-white shadow-blue-500/30'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                {checkoutToast.kind === 'connecting' || checkoutToast.kind === 'opened' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : checkoutToast.kind === 'error' || checkoutToast.kind === 'no-token' || checkoutToast.kind === 'timeout' ? (
                  <AlertTriangle size={16} />
                ) : (
                  <Check size={16} />
                )}
              </div>
              <span className="flex-1 leading-snug break-words">{checkoutToast.message}</span>
              <button
                onClick={() => setCheckoutToast(null)}
                className="shrink-0 -mr-1 -mt-0.5 p-1 rounded hover:bg-white/15 transition-colors"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
            {checkoutToast.url && (
              <div className="mt-3 pt-3 border-t border-white/20 flex items-center gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(checkoutToast.url!);
                      setCheckoutUrlCopied(true);
                      window.setTimeout(() => setCheckoutUrlCopied(false), 2200);
                    } catch (e) {
                      console.warn('[checkout-toast] clipboard write failed:', e);
                    }
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-bold bg-white/15 hover:bg-white/25 transition-colors flex items-center gap-1.5"
                >
                  {checkoutUrlCopied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy URL</>}
                </button>
                <button
                  onClick={async () => {
                    const result = await tryOpenCheckoutUrl(checkoutToast.url!);
                    if (!result.ok) {
                      console.warn('[checkout-toast] retry openExternalRobust failed:', result);
                    }
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-bold bg-white/15 hover:bg-white/25 transition-colors flex items-center gap-1.5"
                >
                  <ExternalLink size={12} /> Try again
                </button>
              </div>
            )}
          </div>
        </div>
      )}

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
      <Modal isOpen={showContext} onClose={() => setShowContext(false)} title="Knowledge & Instructions">
        <div className="space-y-6" onPaste={handleModalPaste}>
           {/* ── Custom Instructions ──
               User-supplied directives that prepend to every model call's
               system prompt as a high-priority, "follow-strictly" block.
               Bound directly to settings.customInstructions (no temp state)
               so localStorage persistence runs on every keystroke — cheap,
               simple, no debounce risk. No hard char limit. Once content
               crosses 3,000 chars an orange advisory appears warning that
               long instructions slow first-token-out; we still pass them
               through verbatim because customer satisfaction beats token
               cost (per 2026-05-08 user direction). */}
           <div className="space-y-2">
               <div className="flex items-center justify-between">
                   <h3 className="text-sm font-bold text-text">Custom Instructions</h3>
                   {settings.customInstructions.trim() && (
                       <span className="text-[10px] font-semibold tracking-wider bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1.5">
                           <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Active in chat
                       </span>
                   )}
               </div>
               <p className="text-[10px] text-gray-500 leading-relaxed">
                   Tell the AI how to respond. These run before every model call as strict-follow directives. <span className="text-gray-600">Saved on this device only — set them again on each device you use.</span>
               </p>
               <textarea
                   value={settings.customInstructions}
                   onChange={(e) => setSettings(s => ({ ...s, customInstructions: e.target.value }))}
                   placeholder='e.g. "Use the STAR method for behavioral questions. Cite tool versions in code answers. Keep responses under 200 words unless I ask for more detail."'
                   className="w-full h-28 bg-black/[0.04] dark:bg-white/[0.03] rounded-xl p-3 text-xs outline-none resize-y custom-scrollbar leading-relaxed transition-all focus:bg-black/[0.055] dark:focus:bg-white/[0.05] focus:shadow-[inset_0_0_20px_-6px_rgba(211,172,99,0.28)]"
               />
               <div className="flex items-center justify-between text-[10px]">
                   <span className={settings.customInstructions.length > 3000 ? 'text-orange-400 font-medium' : 'text-gray-500'}>
                       {settings.customInstructions.length.toLocaleString()} chars
                   </span>
                   <span className="text-gray-600">
                       recommended 2,000–3,000 for fastest responses
                   </span>
               </div>
               {settings.customInstructions.length > 3000 && (
                   <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/30 text-[10.5px] text-orange-300/90 leading-snug">
                       <AlertTriangle size={12} className="text-orange-400 mt-0.5 shrink-0" />
                       <span>
                           <strong className="text-orange-400">Long instructions detected.</strong>
                           {' '}Models will follow them, but responses may take a few extra seconds to start. Consider tightening to under 3,000 characters for the fastest experience.
                       </span>
                   </div>
               )}
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
                               <WizardHat size={14} className="text-orange-400" />
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

           {/* ── Knowledge — files + pasted snippets, unified list ──
               One drop zone replaces the prior "Add File button + Quick
               Paste textarea" split that confused users (where do I put
               my resume?). The zone accepts: (1) drag-drop a file, (2)
               click to open native picker, (3) Cmd/Ctrl+V paste — adds
               files via upload pipeline OR plain text as a snippet via
               addTextSnippet. Pasted snippets land in the same files
               list as uploads with a CUSTOM type-badge so users see all
               their context as one mental unit. The textarea still
               exists as a collapsed paste-fallback for users who'd
               rather type than paste. */}
           <div className="space-y-3 pt-4 border-t border-border">
               <div className="flex items-center justify-between">
                   <h3 className="text-sm font-bold text-text">Knowledge</h3>
                   <span className="text-[10px] text-gray-500">
                       {db.contextFiles.length}{gate.maxContextFiles !== -1 ? ` / ${gate.maxContextFiles}` : ' files'}
                   </span>
               </div>

               {/* Drop zone — three input modes (drag, click, paste).
                   The mic-listening guard mirrors the prior "Add File"
                   disabled state: native file pickers / drag-drop UI
                   aren't covered by setContentProtection, so a dragged
                   filename would leak on screen-share otherwise. */}
               {(() => {
                 const limitHit = gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles;
                 const blockedForSession = _rawIsListening;
                 const disabled = limitHit || blockedForSession;
                 return (
                   <div
                     onClick={() => !disabled && triggerFileUpload()}
                     onDragEnter={!disabled ? handleDragEnter : undefined}
                     onDragOver={!disabled ? handleDragOver : undefined}
                     onDragLeave={!disabled ? handleDragLeave : undefined}
                     onDrop={!disabled ? handleFilesDrop : undefined}
                     className={`group/drop relative flex flex-col items-center justify-center gap-2.5 px-6 py-9 rounded-2xl transition-all overflow-hidden ${
                       disabled
                         ? 'bg-black/[0.02] dark:bg-white/[0.01] cursor-not-allowed'
                         : dragActive
                           ? 'bg-[#d3ac63]/[0.12] cursor-copy'
                           : 'bg-black/[0.03] dark:bg-white/[0.03] hover:bg-[#d3ac63]/[0.06] cursor-pointer'
                     }`}
                     style={{ boxShadow: dragActive ? 'inset 0 0 0 1.5px rgba(211,172,99,0.5), inset 0 0 40px -8px rgba(211,172,99,0.22)' : 'inset 0 0 0 1px rgba(211,172,99,0.16), inset 0 1px 0 rgba(255,255,255,0.05)' }}
                     title={blockedForSession ? 'File picker is paused during a live interview to keep filenames off your screen-share. Stop the mic to add files.' : undefined}
                   >
                     <div className="w-12 h-12 rounded-2xl flex items-center justify-center transition-all" style={{ background: dragActive ? 'rgba(211,172,99,0.16)' : 'rgba(211,172,99,0.08)', boxShadow: 'inset 0 0 0 1px rgba(211,172,99,0.15)' }}>
                       <Upload size={22} strokeWidth={1.6} className="transition-all" style={{ color: dragActive ? '#f6e4b0' : disabled ? '#6a6355' : 'rgba(211,172,99,0.7)' }} />
                     </div>
                     <div className="text-center">
                       <p className="text-sm font-medium text-text">
                         {blockedForSession ? 'Paused — stop the mic to add files' :
                          limitHit ? 'File limit reached' :
                          dragActive ? 'Release to upload' :
                          'Drop files or click to browse'}
                       </p>
                       <p className="text-[10px] text-gray-500 mt-1">
                         PDF · DOCX · TXT · MD · Code · Images
                       </p>
                     </div>
                   </div>
                 );
               })()}

               {/* Hidden file input — click target for the drop zone */}
               <input
                   type="file"
                   ref={fileInputRef}
                   className="hidden"
                   onChange={handleFileUpload}
                   accept=".pdf,.docx,.txt,.md,.json,.js,.ts,.py,.html,.css,.csv,.png,.jpg,.jpeg"
                   multiple={gate.maxContextFiles === -1}
               />

               {/* Uploaded files + pasted snippets — sit DIRECTLY under the drop
                   zone so an added file appears exactly where you dropped it,
                   not buried below the paste box. Borderless glass rows. */}
               {db.contextFiles.length > 0 && (
                   <div className="space-y-2 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
                       {db.contextFiles.map(file => (
                           <div key={file.id} className="flex items-center justify-between p-2.5 bg-black/[0.04] dark:bg-white/[0.03] rounded-xl group hover:bg-black/[0.06] dark:hover:bg-white/[0.05] transition-colors">
                               <div className="flex items-center gap-3 overflow-hidden">
                                   <div className="w-8 h-8 rounded-lg bg-[#d3ac63]/12 flex items-center justify-center shrink-0">
                                       <FileText size={14} className="text-[#c9a86a]" />
                                   </div>
                                   <div className="min-w-0">
                                       <p className="text-xs font-medium text-text truncate max-w-[220px]">{file.name}</p>
                                       <p className="text-[10px] text-gray-500 uppercase tracking-wider">{file.type}</p>
                                   </div>
                               </div>
                               <button onClick={() => removeFile(file.id)} className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                                   <Trash2 size={14} />
                               </button>
                           </div>
                       ))}
                   </div>
               )}

               {/* ── Paste text directly — parallel input method ──
                   Always-visible section (replaces the prior collapsed
                   <details> that was too easy to miss; user feedback
                   2026-05-09). Equal visual weight to the drop zone
                   above so users see two real ways to add knowledge,
                   not "drop zone + hidden fallback". The amber chip +
                   helper line surface a non-obvious truth: text-only
                   models like Groq do best with directly-pasted text,
                   since PDF→text extraction can drop formatting cues
                   that a live interviewer might quote back. */}
               <div className="space-y-2 pt-1">
                   <div className="flex items-center justify-between flex-wrap gap-2">
                       <div className="flex items-center gap-1.5">
                           <FileText size={12} className="text-gray-400" />
                           <h4 className="text-[12px] font-semibold text-text">Paste text directly</h4>
                       </div>
                       <span
                           className="inline-flex items-center gap-1 text-[9.5px] font-semibold tracking-wider uppercase bg-amber-500/10 text-amber-300 px-2 py-0.5 rounded-full border border-amber-500/30"
                           title="Groq is a text-only model with no PDF / image vision — pasting text directly bypasses any extraction loss."
                       >
                           <Info size={9} className="opacity-90" /> Best for Groq
                       </span>
                   </div>
                   <p className="text-[10.5px] text-gray-500 leading-relaxed">
                       Groq is text-only — pasting your resume / JD here is more reliable than uploading a PDF. We extract text from PDFs / DOCX automatically, but formatting cues can drop during extraction.
                   </p>
                   <div className="relative">
                       <textarea
                           value={pasteContent}
                           onChange={(e) => setPasteContent(e.target.value)}
                           placeholder="Paste resume, job description, or interview notes here…"
                           className="w-full h-28 bg-black/[0.04] dark:bg-white/[0.03] rounded-xl p-3 pr-12 text-xs outline-none resize-none custom-scrollbar leading-relaxed transition-all focus:bg-black/[0.055] dark:focus:bg-white/[0.05] focus:shadow-[inset_0_0_20px_-6px_rgba(211,172,99,0.28)]"
                       />
                       <div className="absolute bottom-2 right-2">
                           <button
                               onClick={handleAddPasteText}
                               disabled={!pasteContent.trim() || (gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles)}
                               className={`p-2 rounded-lg transition-all ${pasteContent.trim() && !(gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles) ? 'btn-gold-glass' : 'bg-black/[0.05] dark:bg-white/[0.04] text-gray-500 cursor-not-allowed'}`}
                               aria-label="Add pasted text as context"
                               title="Add as context"
                           >
                               <Plus size={16} />
                           </button>
                       </div>
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

      {/* --- Support Modal (Chat with Minica) ---
          Panel mode fills the modal body. SupportBot uses bg-surface/text-text
          tokens so it auto-themes with the user's light/dark choice. Pinning
          a fixed height keeps the chat scrollable inside the modal instead of
          letting the modal grow with the conversation. */}
      <Modal isOpen={showSupport} onClose={() => setShowSupport(false)} title="Chat with Minica">
        <div className="h-[min(70vh,720px)] -mx-6 -mb-6 -mt-2 border-t border-border">
          <SupportBot
            mode="panel"
            currentUser={userProfile ? { email: userProfile.email, name: userProfile.name, id: (userProfile as any).id } : null}
            tier={userLicense?.tier ?? null}
            authToken={licenseService.getToken() || null}
            onBotAction={botActionDispatcher}
            onClose={() => setShowSupport(false)}
          />
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
                      <li>Click <strong>Share</strong>. The status will turn to <span className="text-emerald-400 font-bold">LIVE</span>.</li>
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
                    <a href="https://get.minicaai.com/windows" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-blue-500 hover:bg-blue-500/5 transition-all group">
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

                    <a href="https://get.minicaai.com/mac" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-purple-500 hover:bg-purple-500/5 transition-all group">
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

                    <a href="https://get.minicaai.com/linux" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-orange-500 hover:bg-orange-500/5 transition-all group">
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
          actualTier={gate.actualTier}
          countryCode={userProfile?.country_code || 'US'}
          onDismiss={creditTimer.dismissLowWarning}
          onExtend={['basic', 'pro', 'max'].includes(gate.actualTier) ? handleRenewCredit : undefined}
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
      {/* Plan/trial expiry notice — main window only, and it yields the
          top-right anchor to the live credit surfaces (low-warning toast /
          exhausted modal) so two billing prompts never stack. */}
      {!isPopoutElectron && planNotice && !creditTimer.lowWarning && !creditTimer.exhausted && !manageSubOpen && (
        <PlanExpiryNotice
          message={planNotice.message}
          cta={planNotice.cta}
          onCta={() => { dismissPlanNotice(planNotice.fingerprint); setManageSubOpen(true); }}
          onDismiss={() => dismissPlanNotice(planNotice.fingerprint)}
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
          actualTier={remoteCreditActualTier}
          countryCode={remoteCreditCountryCode}
          onDismiss={() => electronIPC.send('relay-to-main', { type: 'cmd-credit-low-dismiss' })}
          onExtend={['basic', 'pro', 'max'].includes(remoteCreditActualTier)
            ? () => electronIPC.send('relay-to-main', { type: 'cmd-credit-renew' })
            : undefined}
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
  // Web checkout return (?payment=success) must stay on SubscriptionGate so
  // the success banner + justPurchasedTier path still runs. Cleared when the
  // user enters MainApp via onAuthenticated (e.g. "Open web app").
  const [webPaymentReturn, setWebPaymentReturn] = useState(() => {
    if (typeof window === 'undefined' || isElectron) return false;
    try { return new URLSearchParams(window.location.search).get('payment') === 'success'; }
    catch { return false; }
  });
  // Guards the focus-revalidation handler from firing concurrently. Fast
  // alt-tab in/out (common when paying in an external browser window and
  // bouncing back) otherwise queues multiple validateWithServer calls; if
  // they resolve out of order the earlier (stale) response can overwrite
  // the newer one and snap the user's tier back to its pre-upgrade value.
  const focusRevalidatingRef = useRef(false);

  useEffect(() => {
    // Don't auto-enter MainApp while handling a checkout return — gate owns that.
    if (webPaymentReturn) return;
    const saved = licenseService.loadAuth();
    if (saved.user && saved.license && licenseService.isLicenseValid(saved.license)) {
      setUser(saved.user);
      setLicense(saved.license);
      setAuthenticated(true);
      licenseService.startRevalidation();
    }
  }, [webPaymentReturn]);

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

  if (!authenticated || webPaymentReturn) {
    return (
      <SubscriptionGate
        onAuthenticated={(u, l) => {
          setUser(u);
          setLicense(l);
          setAuthenticated(true);
          setWebPaymentReturn(false);
          licenseService.startRevalidation();
        }}
      />
    );
  }

  // Authenticated users (Electron or browser) enter MainApp. Unauthenticated
  // users already returned SubscriptionGate above. Web popout is Document-PiP
  // inside MainApp; Electron popout still uses ?mode=popout BrowserWindow.
  return (
    <ErrorBoundary>
      <MainApp userProfile={user} userLicense={license} onLogout={handleLogout} setUserProfile={setUser} setUserLicense={setLicense} />
    </ErrorBoundary>
  );
}