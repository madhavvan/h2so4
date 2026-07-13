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
} from 'lucide-react';
import { WizardHat } from './WizardHat';

const TUTORIAL_VERSION = 'v1';
const WEB_ONBOARDING_VERSION = 'v1';

const isElectronEnv = () =>
    typeof window !== 'undefined' && !!window.electronAPI?.isElectron;

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

const STEPS: TutorialStep[] = [
    {
        icon: Sparkles,
        accent: 'from-blue-500 to-purple-500',
        title: 'Welcome to minicaai',
        body: (
            <>
                Your real-time AI interview copilot. It listens to the interviewer through your mic,
                suggests answers in your voice, and stays <span className="text-purple-300 font-semibold">invisible to screen-share</span> so
                the interviewer never knows it's there.
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
                    <li><span className="font-semibold text-white">Gemini</span> — fast, free for everyone</li>
                    <li><span className="font-semibold text-white">GPT, Grok, Groq</span> — Pro tier (more depth)</li>
                    <li><span className="font-semibold text-orange-400">Claude (Max only)</span> — smartest, web-search-aware, most human-sounding</li>
                </ul>
            </>
        ),
    },
    {
        icon: WizardHat,
        accent: 'from-orange-400 to-amber-500',
        title: 'Train Claude (Max only)',
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
                    Max-tier feature. Click into your editor before the countdown ends.
                </div>
            </>
        ),
    },
    {
        icon: Monitor,
        accent: 'from-cyan-500 to-blue-500',
        title: 'Pop-out window — invisible to screen-share',
        body: (
            <>
                Click the <span className="font-semibold">pop-out icon</span> in the toolbar to open a small floating window.
                It stays on top of everything, can be resized (S/M/L), and is <span className="font-bold text-cyan-300">completely
                invisible during screen-share</span> — meeting attendees don't see it.
                <div className="mt-2 text-xs text-gray-400">
                    The main window also stays invisible to screen-share. Both windows use Windows content protection.
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
        icon: EyeOff,
        accent: 'from-slate-500 to-gray-600',
        title: 'Hiding the app from view',
        body: (
            <>
                When you close the main window, the app stays running in the <span className="font-semibold">system tray</span>
                {' '}(bottom-right corner of your screen, near the clock). Right-click that area to bring it back or quit.
                <div className="mt-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm">
                    <div className="font-bold text-blue-300 mb-1">Pro tip — fully hide the icon:</div>
                    <ol className="space-y-1 text-xs text-gray-300 list-decimal list-inside">
                        <li>Click the up-arrow <span className="font-mono bg-gray-700 px-1 rounded">^</span> in your taskbar</li>
                        <li>Drag the minicaai icon into the overflow popup (the small window that opens)</li>
                        <li>The icon disappears from the always-visible tray strip — but right-click in the overflow still works</li>
                    </ol>
                    <div className="mt-2 text-[10px] text-gray-400">
                        Keeps minicaai out of view during screen-share even when your taskbar is shared.
                    </div>
                </div>
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
                    <li className="flex gap-2"><span className="text-emerald-400">→</span> <span><span className="font-semibold text-white">Switch tiers</span> from the Upgrade button to unlock Claude + Auto-Type</span></li>
                    <li className="flex gap-2"><span className="text-emerald-400">→</span> <span>Need help? Hit the <span className="font-semibold text-white">Help icon</span> for support</span></li>
                </ul>
                <div className="mt-4 text-xs text-gray-400 italic">
                    Good luck — go nail your interview.
                </div>
            </>
        ),
    },
];

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
    const steps = inElectron ? STEPS : buildWebSteps(onOpenDownload);

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
