// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DownloadGuide — "after you click Download, here's what you might see"
//
//  New apps without millions of prior downloads trip the browsers' and
//  OSes' reputation checks — SmartScreen's blue banner, Chrome/Edge's
//  "isn't commonly downloaded" bar, Firefox's shield. Users who aren't
//  warned bail at that moment and file "the download is broken" tickets.
//  This module sits DIRECTLY under every download button and walks each
//  prompt click-by-click, with CSS-drawn mockups (never screenshots —
//  they rot with every browser update; schematic mocks stay truthful).
//
//  Verified against current flows (2026-07, web-checked):
//   · SmartScreen: "Windows protected your PC" → More info → Run anyway
//   · Edge bar: hover download → ⋯ → Keep → Show more → Keep anyway
//   · Chrome bubble/bar: ⋯ (or ∨) → Keep → Keep anyway
//   · Downloads panel variant (Ctrl+J / toolbar arrow): ⋯ on the file → Keep
//   · Firefox: downloads arrow → right-click file → Allow download
//   · macOS: builds are Developer-ID signed + NOTARIZED → normally only
//     the standard "downloaded from the internet" Open prompt. Sequoia
//     removed the Control-click bypass; the last-resort path is
//     System Settings → Privacy & Security → Open Anyway.
//
//  Theme: the app's obsidian + gold (#d3ac63) premium language — dark
//  glass cards, gold hairlines, gold "click this" chips.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React, { useMemo, useState } from 'react';
import { ShieldCheck, MousePointerClick, ChevronDown, Monitor, Globe, Command } from 'lucide-react';

const GOLD = '#d3ac63';
const GOLD_SOFT = 'rgba(211,172,99,0.16)';
const GOLD_LINE = 'rgba(211,172,99,0.28)';

type OSKey = 'windows' | 'mac' | 'linux';

function detectOS(): OSKey {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/mac os x|macintosh/.test(ua)) return 'mac';
  if (/linux/.test(ua) && !/android/.test(ua)) return 'linux';
  return 'windows';
}

/** Gold "this is the thing you click" chip. */
const ClickChip = ({ children }: { children: React.ReactNode }) => (
  <span
    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap align-middle"
    style={{ background: GOLD_SOFT, color: '#f0d78a', border: `1px solid ${GOLD_LINE}` }}
  >
    <MousePointerClick size={10} />
    {children}
  </span>
);

/** Numbered step row. */
const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <li className="flex gap-2.5 items-start">
    <span
      className="flex-shrink-0 w-4.5 h-4.5 mt-[1px] w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center"
      style={{ background: GOLD_SOFT, color: GOLD, border: `1px solid ${GOLD_LINE}` }}
    >
      {n}
    </span>
    <span className="text-[12.5px] leading-relaxed text-gray-300">{children}</span>
  </li>
);

/* ── CSS mockups — schematic, instantly recognizable, never rotting ── */

/** Windows SmartScreen — the blue full-panel banner. */
const SmartScreenMock = () => (
  <div className="rounded-lg overflow-hidden select-none" style={{ border: '1px solid rgba(255,255,255,0.08)' }} aria-hidden>
    <div className="px-3.5 py-3" style={{ background: '#0f5cad' }}>
      <div className="text-[13px] font-bold text-white">Windows protected your PC</div>
      <div className="text-[10px] text-white/85 mt-1 leading-snug">
        Microsoft Defender SmartScreen prevented an unrecognized app from starting…
      </div>
      <div className="text-[10.5px] mt-1.5 underline font-semibold" style={{ color: '#fff' }}>
        More info
        <span className="ml-1 not-italic no-underline inline-flex align-middle" style={{ color: '#f0d78a' }}>← click this first</span>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <span
          className="px-2.5 py-1 rounded-sm text-[10.5px] font-semibold text-[#0f5cad] bg-white relative"
          style={{ boxShadow: `0 0 0 2px ${GOLD}` }}
        >
          Run anyway
        </span>
        <span className="px-2.5 py-1 rounded-sm text-[10.5px] font-semibold text-white" style={{ background: 'rgba(255,255,255,0.18)' }}>
          Don&rsquo;t run
        </span>
      </div>
    </div>
  </div>
);

/** Chrome / Edge download-bar row with the ⋯ menu highlighted. */
const DownloadBarMock = ({ browser }: { browser: 'edge' | 'chrome' }) => (
  <div
    className="rounded-lg px-3 py-2 flex items-center gap-2.5 select-none"
    style={{ background: '#1d1f24', border: '1px solid rgba(255,255,255,0.08)' }}
    aria-hidden
  >
    <span className="w-6 h-6 rounded-full flex items-center justify-center text-[11px]" style={{ background: 'rgba(255,255,255,0.08)' }}>⚠️</span>
    <div className="min-w-0 flex-1">
      <div className="text-[11px] font-semibold text-white truncate">InterviewCopilot-Setup.exe</div>
      <div className="text-[9.5px] text-gray-400 truncate">
        {browser === 'edge' ? 'InterviewCopilot-Setup.exe isn’t commonly downloaded.' : 'This file isn’t commonly downloaded.'}
      </div>
    </div>
    <span
      className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[13px] font-bold flex-shrink-0 relative"
      style={{ background: 'rgba(255,255,255,0.10)', boxShadow: `0 0 0 2px ${GOLD}` }}
    >
      ⋯
    </span>
    <span className="text-[9.5px] font-semibold flex-shrink-0" style={{ color: '#f0d78a' }}>← the three dots</span>
  </div>
);

/* ── Per-platform guidance cards ── */

interface GuideSection {
  key: string;
  os: OSKey | 'any';
  icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>;
  title: string;
  body: React.ReactNode;
}

function buildSections(): GuideSection[] {
  return [
    {
      key: 'smartscreen',
      os: 'windows',
      icon: Monitor,
      title: 'Windows — the blue "Windows protected your PC" screen',
      body: (
        <>
          <SmartScreenMock />
          <ol className="mt-3 space-y-2">
            <Step n={1}>When the blue panel appears after you run the installer, click <ClickChip>More info</ClickChip> (the small underlined link — the buttons stay hidden until you do).</Step>
            <Step n={2}>Click <ClickChip>Run anyway</ClickChip>. Setup starts normally.</Step>
          </ol>
          <p className="mt-2.5 text-[11px] text-gray-400 leading-relaxed">
            You&rsquo;ll see the publisher listed as <span className="text-gray-200 font-medium">Venu Madhav Pentala</span> — the installer is code-signed via Azure Trusted Signing. SmartScreen shows this once for newer apps that haven&rsquo;t accumulated millions of downloads yet; it clears on its own as the app&rsquo;s reputation builds.
          </p>
        </>
      ),
    },
    {
      key: 'edge-chrome',
      os: 'windows',
      icon: Globe,
      title: 'Edge & Chrome — "isn’t commonly downloaded" on the download itself',
      body: (
        <>
          <DownloadBarMock browser="edge" />
          <div className="mt-3 space-y-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: GOLD }}>Microsoft Edge</div>
              <ol className="space-y-2">
                <Step n={1}>Hover the download (top-right bubble or bottom bar) and click the <ClickChip>⋯ three dots</ClickChip> on it.</Step>
                <Step n={2}>Click <ClickChip>Keep</ClickChip>.</Step>
                <Step n={3}>On the &ldquo;Make sure you trust&hellip;&rdquo; sheet, click <ClickChip>Show more</ClickChip>, then <ClickChip>Keep anyway</ClickChip>.</Step>
              </ol>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: GOLD }}>Google Chrome</div>
              <ol className="space-y-2">
                <Step n={1}>In the downloads bubble (top-right ↓ icon), click the <ClickChip>⋯ / ∨ menu</ClickChip> on the file.</Step>
                <Step n={2}>Click <ClickChip>Keep</ClickChip> — and if Chrome asks again, <ClickChip>Keep anyway</ClickChip>.</Step>
              </ol>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: GOLD }}>Already dismissed it? The Downloads page works too</div>
              <ol className="space-y-2">
                <Step n={1}>Press <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-white/10 border border-white/15 text-white">Ctrl + J</span> (or the browser&rsquo;s ↓ downloads icon) to open Downloads.</Step>
                <Step n={2}>Find <span className="text-gray-200 font-medium">InterviewCopilot-Setup.exe</span>, click its <ClickChip>⋯ three dots</ClickChip>, then <ClickChip>Keep</ClickChip> / <ClickChip>Keep anyway</ClickChip>.</Step>
              </ol>
            </div>
          </div>
        </>
      ),
    },
    {
      key: 'firefox',
      os: 'windows',
      icon: Globe,
      title: 'Firefox — "This file may harm your computer"',
      body: (
        <ol className="space-y-2">
          <Step n={1}>Click the <ClickChip>↓ downloads arrow</ClickChip> in the toolbar.</Step>
          <Step n={2}>Right-click the flagged file and choose <ClickChip>Allow download</ClickChip> (or click the file and confirm).</Step>
        </ol>
      ),
    },
    {
      key: 'mac',
      os: 'mac',
      icon: Command,
      title: 'macOS — normally no warning at all',
      body: (
        <>
          <ol className="space-y-2">
            <Step n={1}>Open the downloaded <span className="text-gray-200 font-medium">.dmg</span> and drag <span className="text-gray-200 font-medium">Interview Copilot</span> into <ClickChip>Applications</ClickChip>.</Step>
            <Step n={2}>On first launch macOS shows the standard &ldquo;downloaded from the internet&rdquo; note — click <ClickChip>Open</ClickChip>. That&rsquo;s it.</Step>
          </ol>
          <p className="mt-2.5 text-[11px] text-gray-400 leading-relaxed">
            Our Mac builds are Developer-ID signed and <span className="text-gray-200 font-medium">notarized by Apple</span>, so Gatekeeper opens them without protest. If an <em>old</em> download ever claims the app &ldquo;cannot be opened&rdquo;: re-download the current installer first; as a last resort, open <span className="text-gray-200 font-medium">System Settings → Privacy &amp; Security</span>, scroll down, and click <ClickChip>Open Anyway</ClickChip> (macOS Sequoia removed the old right-click trick — this settings path is the official one).
          </p>
        </>
      ),
    },
    {
      key: 'linux',
      os: 'linux',
      icon: Monitor,
      title: 'Linux — make the AppImage executable',
      body: (
        <>
          <ol className="space-y-2">
            <Step n={1}>Right-click the AppImage → Properties → Permissions → check <ClickChip>Allow executing file as program</ClickChip> (or run <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-white/10 border border-white/15 text-white">chmod +x InterviewCopilot-Linux.AppImage</span>).</Step>
            <Step n={2}>Double-click to launch. A FUSE error means <span className="font-mono text-[11px] px-1 rounded bg-white/10">libfuse2</span> is missing — install it or use the .deb instead.</Step>
          </ol>
        </>
      ),
    },
  ];
}

export function DownloadGuide({ className = '' }: { className?: string }) {
  const os = useMemo(detectOS, []);
  const sections = useMemo(buildSections, []);
  // Detected OS's sections first; the rest stay reachable below.
  const ordered = useMemo(
    () => [...sections].sort((a, b) => Number(b.os === os) - Number(a.os === os)),
    [sections, os],
  );
  const [open, setOpen] = useState<string | null>(ordered[0]?.key ?? null);

  return (
    <section
      className={`rounded-2xl overflow-hidden ${className}`}
      style={{
        background: 'linear-gradient(180deg, rgba(211,172,99,0.05), rgba(255,255,255,0.015))',
        border: `1px solid ${GOLD_LINE}`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
      aria-label="What you might see after clicking download"
    >
      <div className="px-4 pt-4 pb-3 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: GOLD_SOFT, border: `1px solid ${GOLD_LINE}` }}>
          <ShieldCheck size={17} style={{ color: GOLD }} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white leading-tight">
            After you click download — your browser may double-check. Here&rsquo;s exactly what to click.
          </h3>
          <p className="text-[11.5px] text-gray-400 mt-1 leading-relaxed">
            Newer apps without millions of downloads get a one-time caution prompt from Windows and the browsers.
            The installer is <span className="text-gray-200 font-medium">code-signed</span> (Azure Trusted Signing on Windows, Apple-notarized on macOS) —
            these prompts are reputation checks on <em>new</em> software, not a judgment of it. Each takes two clicks:
          </p>
        </div>
      </div>

      <div className="px-3 pb-3 space-y-1.5">
        {ordered.map((s) => {
          const isOpen = open === s.key;
          const Icon = s.icon;
          const isYourOS = s.os === os;
          return (
            <div key={s.key} className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.25)' }}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : s.key)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
                aria-expanded={isOpen}
              >
                <Icon size={14} style={{ color: isYourOS ? GOLD : 'rgba(255,255,255,0.45)' }} className="flex-shrink-0" />
                <span className={`flex-1 text-[12.5px] font-semibold ${isYourOS ? 'text-white' : 'text-gray-400'}`}>{s.title}</span>
                {isYourOS && (
                  <span className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded flex-shrink-0" style={{ background: GOLD_SOFT, color: GOLD, border: `1px solid ${GOLD_LINE}` }}>
                    Your system
                  </span>
                )}
                <ChevronDown size={14} className={`text-gray-500 transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && <div className="px-3.5 pb-3.5">{s.body}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default DownloadGuide;
