// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Tutorial — first-launch walkthrough modal sequence
//
//  Triggered automatically the first time a user signs in (per account,
//  keyed by user_id in localStorage). Replayable from Settings → Help.
//
//  We render illustrative icon-blocks rather than live screenshots — the
//  app's UI shifts often enough that screenshots would rot fast, and
//  taking + bundling them adds a build step. Lucide icons + Tailwind do
//  the job and stay in sync with the rest of the UI.
//
//  Bumped the version key (TUTORIAL_VERSION) when major UI changes warrant
//  re-showing existing users — they'll see it again on next launch.
//
//  Web users get WEB_STEPS (tab-audio capture, no "mic" language) with a
//  separate localStorage key so desktop completion does not skip web
//  onboarding and vice versa.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React, { useEffect, useRef, useState } from 'react';
import {
    X, Crown, Cpu, Mic, Camera, Keyboard, Monitor, FileText,
    EyeOff, Sparkles, ChevronLeft, ChevronRight, Check, ScreenShare, Download,
    Command, Clock, MousePointerClick, ExternalLink, MessageCircle,
} from 'lucide-react';
import { WizardHat } from './WizardHat';

// Bumped v1 → v2 (2026-07-16): the desktop walkthrough is now OS-aware and
// spoon-feeds pop-out click-by-click + adds the "save your minutes" and
// per-OS hide/restore precautions. Existing users see the refreshed tour once.
const TUTORIAL_VERSION = 'v2';
const WEB_ONBOARDING_VERSION = 'v1';

const isElectronEnv = () =>
    typeof window !== 'undefined' && !!window.electronAPI?.isElectron;

// ── OS detection (desktop walkthrough) ──
// The hide/restore shortcut and the tray wording differ per platform, and the
// owner wants Mac / Windows / Linux users each told the RIGHT keys. Mirrors
// licenseService.getPlatform() but kept local so Tutorial has no service dep.
type DesktopOS = 'mac' | 'windows' | 'linux' | 'other';
function detectOS(): DesktopOS {
    if (typeof navigator === 'undefined') return 'other';
    const ua = (navigator.userAgent || '').toLowerCase();
    const plat = ((navigator as any).platform || '').toLowerCase();
    if (/mac/.test(plat) || /mac os x/.test(ua)) return 'mac';
    if (/win/.test(plat) || /windows/.test(ua)) return 'windows';
    if (/linux/.test(plat) || /linux/.test(ua)) return 'linux';
    return 'other';
}

/** The global hide/restore chord, per OS — matches electron/main.cjs TOGGLE_ACCELERATOR. */
function toggleChord(os: DesktopOS): string {
    return os === 'mac' ? 'Cmd + Alt + Space' : 'Ctrl + Alt + Space';
}

/** Where the app lives after you close its window, per OS. */
function trayLocationLabel(os: DesktopOS): string {
    if (os === 'mac') return 'menu bar (top-right of your screen, near the clock)';
    if (os === 'linux') return 'system tray / top bar (varies by desktop environment)';
    return 'system tray (bottom-right, near the clock)';
}

/** A small monospace keycap. */
function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-white/10 border border-white/15 text-white whitespace-nowrap">
            {children}
        </span>
    );
}

export function tutorialKey(userId: string | null | undefined): string | null {
    if (!userId) return null;
    return `tutorial_${TUTORIAL_VERSION}_completed_${userId}`;
}

/** Web-only onboarding key — independent of desktop tutorial completion. */
export function webOnboardingKey(userId: string | null | undefined): string | null {
    if (!userId) return null;
    return `web_onboarding_${WEB_ONBOARDING_VERSION}_${userId}`;
}

export function shouldShowTutorial(userId: string | null | undefined): boolean {
    if (!userId) return false;
    if (!isElectronEnv()) {
        const key = webOnboardingKey(userId);
        if (!key) return false;
        try { return localStorage.getItem(key) !== 'true'; }
        catch { return false; }
    }
    const key = tutorialKey(userId);
    if (!key) return false;
    try { return localStorage.getItem(key) !== 'true'; }
    catch { return false; }
}

export function markTutorialCompleted(userId: string | null | undefined): void {
    if (!userId) return;
    if (!isElectronEnv()) {
        const key = webOnboardingKey(userId);
        if (!key) return;
        try { localStorage.setItem(key, 'true'); } catch {}
        return;
    }
    const key = tutorialKey(userId);
    if (!key) return;
    try { localStorage.setItem(key, 'true'); } catch {}
}

export function clearTutorialCompletion(userId: string | null | undefined): void {
    if (!userId) return;
    if (!isElectronEnv()) {
        const key = webOnboardingKey(userId);
        if (!key) return;
        try { localStorage.removeItem(key); } catch {}
        return;
    }
    const key = tutorialKey(userId);
    if (!key) return;
    try { localStorage.removeItem(key); } catch {}
}

// ── [PENDING-WEB-REQ] ────────────────────────────────────────────────
// Owner has one more web-version requirement coming. Extend here without
// rework: add copy/flags to WEB_ONBOARDING, or new steps via WEB_STEPS.
// App.tsx mounts Tutorial; download CTA uses onOpenDownload when provided.
export const WEB_ONBOARDING = {
    version: WEB_ONBOARDING_VERSION,
    storageKeyPrefix: 'web_onboarding_v1_',
    // [PENDING-WEB-REQ]: plug next owner requirement (flag, step, CTA) here.
    pendingOwnerRequirement: null as null | {
        id: string;
        title?: string;
        body?: string;
        enabled?: boolean;
    },
    upsell: {
        downloadLabel: 'Download the desktop app',
        downloadBlurb:
            'for the invisible always-on-top popout, Auto-Type into coding editors, and screen-share-proof mode.',
    },
} as const;
// ── end [PENDING-WEB-REQ] ────────────────────────────────────────────

interface TutorialStep {
    icon: React.ComponentType<{ size?: number; className?: string }>;
    accent: string; // tailwind color class for icon background
    title: string;
    body: React.ReactNode;
}

function buildDesktopSteps(os: DesktopOS): TutorialStep[] {
  const chord = toggleChord(os);
  return [
    {
        icon: Sparkles,
        accent: 'from-blue-500 to-purple-500',
        title: 'Welcome to minicaai',
        body: (
            <>
                Your real-time AI copilot for <span className="text-purple-300 font-semibold">interviews and meetings</span>. It listens
                to your interview through system audio, suggests answers in your voice, and stays <span className="text-purple-300 font-semibold">invisible to screen-share</span> so
                no one on the call knows it's there.
                <div className="mt-3 text-xs text-gray-400">
                    Quick tour — about 2 minutes. You can replay this anytime from Settings → Help.
                </div>
            </>
        ),
    },
    {
        icon: Cpu,
        accent: 'from-blue-500 to-cyan-500',
        title: 'Pick your AI model',
        body: (
            <>
                Switch models from the dropdown in the top-right. Each model has different strengths:
                <ul className="mt-2 text-sm space-y-1 list-disc list-inside text-gray-300">
                    <li><span className="font-semibold text-white">Gemini, GPT-5.6, Grok, Groq</span> — on every plan (your free trial includes all four)</li>
                    <li><span className="font-semibold text-orange-400">Claude (Pro & up)</span> — smartest, web-search-aware, most human-sounding</li>
                </ul>
            </>
        ),
    },
    {
        icon: WizardHat,
        accent: 'from-orange-400 to-amber-500',
        title: 'Train Claude (Max & Ultra)',
        body: (
            <>
                Open the <span className="font-semibold">Knowledge Base</span> (file icon in the toolbar), upload your
                resume + the JD, then click <span className="font-bold text-orange-400">Train Model</span>. Claude pre-researches every tech
                in your stack so version/pricing/comparison questions answer in 2-3s instead of 12-25s.
                <div className="mt-3 text-xs text-orange-200/80 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1">
                    ~$0.30 per training · cached 24h · only run once per resume + JD pair
                </div>
            </>
        ),
    },
    {
        icon: Mic,
        accent: 'from-emerald-500 to-teal-500',
        title: 'Voice mode — listen to the interviewer',
        body: (
            <>
                Click the <span className="font-semibold">microphone icon</span> in the toolbar to start listening. The app
                captures system audio (the interviewer's voice from your meeting app), transcribes it live,
                and the AI responds.
                <div className="mt-2 text-xs text-gray-400">
                    First launch will ask for microphone + screen-capture permission — required for system audio capture.
                </div>
            </>
        ),
    },
    {
        icon: Camera,
        accent: 'from-purple-500 to-pink-500',
        title: 'Auto-Solve — screenshot a question',
        body: (
            <>
                For coding questions on a different window (HackerRank, CoderPad, etc.), click the
                <span className="font-semibold"> camera icon</span>. The app captures your screen, sends the image to the AI,
                and gets a complete solution.
            </>
        ),
    },
    {
        icon: Keyboard,
        accent: 'from-indigo-500 to-blue-500',
        title: 'Auto-Type — type the answer for you',
        body: (
            <>
                After getting a code answer, click the <span className="font-semibold">keyboard icon</span> on the code block.
                A 3-second countdown starts — switch to your editor window, and the answer types itself in
                naturally, character by character.
                <div className="mt-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                    Ultra-exclusive feature. Click into your editor before the countdown ends.
                </div>
            </>
        ),
    },
    {
        icon: ExternalLink,
        accent: 'from-cyan-500 to-blue-500',
        title: 'Pop-out — the floating answer window',
        body: (
            <>
                The pop-out is the small floating panel you'll actually watch during a live call. Here's exactly how to use it:
                <ol className="mt-3 space-y-2 text-sm text-gray-200">
                    <li className="flex gap-2.5">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-bold flex items-center justify-center">1</span>
                        <span>Click the <span className="inline-flex items-center gap-1 font-semibold text-[#d3ac63]"><ExternalLink size={13} /> pop-out icon</span> in the toolbar (the gold arrow-out-of-a-box — exactly this glyph). A small always-on-top window appears.</span>
                    </li>
                    <li className="flex gap-2.5">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-bold flex items-center justify-center">2</span>
                        <span>Drag it by its <span className="font-semibold text-white">top bar</span> to a corner near your video window, so your eyes barely move.</span>
                    </li>
                    <li className="flex gap-2.5">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-bold flex items-center justify-center">3</span>
                        <span>Resize with the <span className="font-semibold text-white">S / M / L</span> buttons in its header — S for a discreet glance, L to read long code.</span>
                    </li>
                    <li className="flex gap-2.5">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-bold flex items-center justify-center">4</span>
                        <span>Answers stream in live — the <span className="text-[#d3ac63] font-semibold">gold bubble</span> is your suggested reply; just read it in your own words.</span>
                    </li>
                </ol>
                <div className="mt-3 text-xs text-cyan-200/90 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-2.5 py-2">
                    <span className="font-bold">Invisible on screen-share.</span> When you share your screen, the pop-out (and the main window) don't appear in the shared image — content-protection hides them from the capture.
                </div>
            </>
        ),
    },
    {
        icon: FileText,
        accent: 'from-blue-500 to-indigo-500',
        title: 'Knowledge Base — your resume + JD',
        body: (
            <>
                Open the <span className="font-semibold">file icon</span> in the toolbar to attach your resume, the job description,
                and any context files (PDF, DOCX, plain text). The AI uses these to answer in YOUR voice with YOUR
                experience — not generic textbook responses.
            </>
        ),
    },
    {
        icon: os === 'mac' ? Command : EyeOff,
        accent: 'from-slate-500 to-gray-600',
        title: 'Hide & bring it back instantly',
        body: (
            <>
                If someone walks over or asks you to share your whole screen, hide the app in one keystroke:
                <div className="mt-3 flex items-center justify-center gap-2 py-3 rounded-lg bg-white/[0.04] border border-white/10">
                    <MousePointerClick size={15} className="text-slate-300" />
                    <span className="text-sm text-gray-200">Press</span>
                    <Kbd>{chord}</Kbd>
                    <span className="text-sm text-gray-200">to hide — press it again to bring it back.</span>
                </div>
                <div className="mt-2 text-xs text-gray-400">
                    Same chord on {os === 'mac' ? 'macOS' : os === 'linux' ? 'Linux' : 'Windows'}: {os === 'mac'
                        ? <>hold <Kbd>Cmd</Kbd> <Kbd>Alt</Kbd> and tap <Kbd>Space</Kbd>.</>
                        : <>hold <Kbd>Ctrl</Kbd> <Kbd>Alt</Kbd> and tap <Kbd>Space</Kbd>.</>}
                </div>
                <div className="mt-3 p-3 bg-slate-500/10 border border-slate-400/25 rounded-lg text-xs text-gray-300">
                    Closing the window doesn't quit — the app keeps running in your <span className="font-semibold text-white">{trayLocationLabel(os)}</span>.
                    {os === 'mac'
                        ? ' Click the menu-bar icon to reopen it, or right-click it to quit.'
                        : os === 'linux'
                            ? ' Click the tray icon to reopen, or right-click to quit (if your desktop shows tray icons).'
                            : ' Click the tray icon to reopen it, or right-click to quit. Tip: drag the icon into the ^ overflow to hide it from the always-visible strip.'}
                </div>
            </>
        ),
    },
    {
        icon: Clock,
        accent: 'from-amber-500 to-yellow-500',
        title: 'When the interview ends — save your minutes',
        body: (
            <>
                Your interview time is metered <span className="font-semibold text-white">only while the mic is listening</span>. The moment
                your call is over:
                <ol className="mt-3 space-y-2 text-sm text-gray-200">
                    <li className="flex gap-2.5">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 text-[11px] font-bold flex items-center justify-center">1</span>
                        <span>Click the <span className="inline-flex items-center gap-1 font-semibold text-white"><Mic size={13} /> mic icon</span> to <span className="font-semibold text-amber-300">stop listening</span>. The clock stops within a few seconds and your remaining minutes are kept.</span>
                    </li>
                    <li className="flex gap-2.5">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 text-[11px] font-bold flex items-center justify-center">2</span>
                        <span>Your balance lives on your account — it's the <span className="font-semibold text-white">same across every device</span> you sign in on, so it's safe if you close the app or switch machines.</span>
                    </li>
                </ol>
                <div className="mt-3 text-xs text-amber-200/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-2">
                    Leaving the mic on after the call keeps burning time. If you forget, we auto-settle a stalled session shortly after your last activity — but stopping the mic is the clean way to bank what's left. See your balance any time in <span className="font-semibold">Settings → Usage</span>.
                </div>
            </>
        ),
    },
    {
        icon: Crown,
        accent: 'from-rose-500 to-pink-500',
        title: 'Extensions, history & the reasoning dial',
        body: (
            <>
                Three power tools people miss:
                <ul className="mt-3 text-sm space-y-2 text-gray-300">
                    <li className="flex gap-2"><span className="text-rose-400">→</span> <span><span className="font-semibold text-white">Running low mid-interview?</span> Top up from Settings → Manage plan — +30 min / +1 h / +3 h packs apply instantly, no restart.</span></li>
                    <li className="flex gap-2"><span className="text-rose-400">→</span> <span>Every session's transcript and answers save to your <span className="font-semibold text-white">History</span> — review or export them after the call.</span></li>
                    <li className="flex gap-2"><span className="text-rose-400">→</span> <span>On <span className="font-semibold text-white">Max &amp; Ultra</span>, the GPT-5.6 <span className="font-semibold text-white">reasoning dial</span> trades answer speed for depth, per question.</span></li>
                </ul>
            </>
        ),
    },
    {
        icon: MessageCircle,
        accent: 'from-sky-500 to-blue-500',
        title: 'Stuck? Ask Minica',
        body: (
            <>
                The built-in assistant handles <span className="font-semibold text-white">billing, refunds, troubleshooting and how-tos</span> —
                click the chat bubble any time, before or during an interview. Full written guides live under
                <span className="font-semibold text-white"> Documentation</span>, and every doc page has a feedback button if something's unclear.
            </>
        ),
    },
    {
        icon: Check,
        accent: 'from-emerald-500 to-green-500',
        title: 'You\'re all set',
        body: (
            <>
                That's the tour. A few last things:
                <ul className="mt-3 text-sm space-y-2 text-gray-300">
                    <li className="flex gap-2"><span className="text-emerald-400">→</span> <span><span className="font-semibold text-white">Replay this tutorial</span> any time from Settings → Help</span></li>
                    <li className="flex gap-2"><span className="text-emerald-400">→</span> <span>Hide/show instantly with <Kbd>{chord}</Kbd></span></li>
                    <li className="flex gap-2"><span className="text-emerald-400">→</span> <span><span className="font-semibold text-white">Stop the mic</span> when you're done to save your minutes</span></li>
                    <li className="flex gap-2"><span className="text-emerald-400">→</span> <span>Works for <span className="font-semibold text-white">interviews and meetings</span> alike</span></li>
                </ul>
                <div className="mt-4 text-xs text-gray-400 italic">
                    Good luck — go nail it.
                </div>
            </>
        ),
    },
  ];
}

/** Web-only walkthrough — tab audio, never microphone; ends with desktop upsell. */
function buildWebSteps(onOpenDownload?: () => void): TutorialStep[] {
    return [
        {
            icon: ScreenShare,
            accent: 'from-emerald-500 to-teal-500',
            title: 'Share the interviewer\'s audio',
            body: (
                <>
                    When you hit listen, pick the <span className="font-semibold text-white">meeting tab</span> when prompted
                    and check <span className="font-semibold">Share tab audio</span>. We capture only that stream —
                    never your microphone.
                </>
            ),
        },
        {
            icon: Mic,
            accent: 'from-blue-500 to-cyan-500',
            title: 'They ask → it transcribes live',
            body: (
                <>
                    Questions appear as a live transcript of the interviewer's voice only —
                    <span className="font-semibold text-emerald-300"> never yours</span>.
                </>
            ),
        },
        {
            icon: Cpu,
            accent: 'from-purple-500 to-pink-500',
            title: 'Pick a model → perfect answer',
            body: (
                <>
                    Choose a model from the picker. A polished answer streams to your screen in seconds —
                    tailored to your knowledge base when you've uploaded a résumé + JD.
                </>
            ),
        },
        {
            icon: Download,
            accent: 'from-amber-500 to-orange-500',
            title: 'Read it naturally',
            body: (
                <>
                    Deliver the answer in your own voice. On the desktop app, that answer floats
                    <span className="font-semibold text-cyan-300"> invisibly</span> — hidden from screen-share.
                    <div className="mt-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm">
                        <div className="font-semibold text-blue-200 mb-1">
                            ⬇️ {WEB_ONBOARDING.upsell.downloadLabel}
                        </div>
                        <p className="text-xs text-gray-300 leading-relaxed mb-2">
                            {WEB_ONBOARDING.upsell.downloadBlurb}
                        </p>
                        {onOpenDownload && (
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onOpenDownload(); }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:opacity-90 transition-opacity"
                            >
                                <Download size={12} /> Download desktop app
                            </button>
                        )}
                    </div>
                    {/* [PENDING-WEB-REQ]: extra owner step / CTA can mount below this block. */}
                </>
            ),
        },
    ];
}

export function Tutorial({
    isOpen,
    onClose,
    onOpenDownload,
}: {
    isOpen: boolean;
    onClose: () => void;
    /** Web only — opens MainApp Download modal from onboarding CTA. */
    onOpenDownload?: () => void;
}) {
    const [step, setStep] = useState(0);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inElectron = isElectronEnv();
    // Detect OS once per mount — the desktop walkthrough shows the right
    // hide/restore chord + tray wording for Mac / Windows / Linux.
    const osRef = useRef<DesktopOS>(detectOS());
    const steps = inElectron ? buildDesktopSteps(osRef.current) : buildWebSteps(onOpenDownload);

    // Reset to step 0 every time the tutorial opens — so a re-launch from
    // Settings starts fresh, not at wherever the user left off.
    useEffect(() => {
        if (isOpen) setStep(0);
    }, [isOpen]);

    // Keyboard nav: ←/→ to step, Esc to close
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
            if (e.key === 'ArrowRight' || e.key === 'Enter') {
                e.preventDefault();
                if (step < steps.length - 1) setStep(s => s + 1);
                else onClose();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (step > 0) setStep(s => s - 1);
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [isOpen, step, onClose, steps.length]);

    if (!isOpen) return null;

    const current = steps[step];
    const Icon = current.icon;
    const isLast = step === steps.length - 1;
    const isFirst = step === 0;

    return (
        <div
            className="fixed inset-0 flex items-center justify-center p-4"
            style={{
                background: inElectron ? 'rgba(0,0,0,0.94)' : 'rgba(0,0,0,0.65)',
                zIndex: 99999,
                WebkitAppRegion: 'no-drag',
            } as any}
            role="dialog"
            aria-modal="true"
            aria-label="Tutorial"
        >
            <div
                ref={dialogRef}
                className="relative w-full max-w-md rounded-2xl border border-border shadow-2xl overflow-hidden flex flex-col"
                style={{ background: inElectron ? '#13131e' : 'var(--surface-color)' }}
            >
                {/* Skip button — top-right, always visible */}
                <button
                    onClick={onClose}
                    className="absolute top-3 right-3 z-10 text-gray-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-primary outline-none transition-colors"
                    aria-label="Skip tutorial"
                    title="Skip tutorial"
                >
                    <X size={18} />
                </button>

                {/* Icon header */}
                <div className="flex items-center justify-center pt-10 pb-4">
                    <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${current.accent} flex items-center justify-center shadow-xl`}>
                        <Icon size={38} className="text-white" />
                    </div>
                </div>

                {/* Title + body */}
                <div className="px-6 pb-4">
                    <h2 className="text-xl font-bold text-text text-center mb-3">{current.title}</h2>
                    <div className="text-sm text-gray-300 leading-relaxed">{current.body}</div>
                </div>

                {/* Step dots */}
                <div className="flex items-center justify-center gap-1.5 px-6 py-3">
                    {steps.map((_, i) => (
                        <button
                            key={i}
                            onClick={() => setStep(i)}
                            className={`transition-all rounded-full ${
                                i === step
                                    ? 'w-6 h-1.5 bg-primary'
                                    : i < step
                                        ? 'w-1.5 h-1.5 bg-primary/60'
                                        : 'w-1.5 h-1.5 bg-gray-600 hover:bg-gray-500'
                            }`}
                            aria-label={`Go to step ${i + 1}`}
                        />
                    ))}
                </div>

                {/* Footer — back / counter / next */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-black/20">
                    <button
                        onClick={() => setStep(s => Math.max(0, s - 1))}
                        disabled={isFirst}
                        className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                        <ChevronLeft size={16} /> Back
                    </button>
                    <span className="text-xs text-gray-500 font-medium">{step + 1} / {steps.length}</span>
                    <button
                        onClick={() => isLast ? onClose() : setStep(s => s + 1)}
                        className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-bold bg-gradient-to-r from-primary to-blue-500 text-white shadow-lg hover:shadow-primary/30 transition-all"
                    >
                        {isLast ? 'Get Started' : 'Next'} {!isLast && <ChevronRight size={16} />}
                    </button>
                </div>
            </div>
        </div>
    );
}
