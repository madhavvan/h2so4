// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MinicaMark — the "Given Word" brand mark as a living component.
//
//  The app icon's two quote-drops (gold = the line the copilot gives;
//  obsidian+gold edge = the words as you speak them), usable anywhere in
//  the UI as a status-bearing mark — the same trick Claude's asterisk
//  and Grok's slash pull during activity:
//
//    state="idle"      static mark
//    state="loading"   Grok-school: the drops TRACE themselves in from
//                      their edges on a loop (fills dimmed) — "minica is
//                      loading"
//    state="thinking"  Claude-school: the gold line breathes its sheen,
//                      then the echo answers — a looping two-voice pulse
//                      — "minica is composing your line"
//
//  Follows the WizardHat/UltraMark component conventions (size prop,
//  self-colored, default export). Honors prefers-reduced-motion: all
//  states collapse to the static mark. Transparent background — the
//  obsidian tile belongs to the OS icon, not the UI mark.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import React from 'react';

type MarkState = 'idle' | 'loading' | 'thinking';

// One quote-drop silhouette, head r=132 centered at origin, tail to y=338.
// Identical geometry to build/icon.svg — keep them in sync.
const DROP =
  'M -132 0 A 132 132 0 1 1 118 60 C 122 160 76 262 -34 338 C 30 240 52 168 44 118 A 132 132 0 0 1 -132 0 Z';
// Specular arc across the head top (origin coords).
const SHEEN = 'M -93.3 -93.3 A 132 132 0 0 1 93.3 -93.3';

const CSS = `
  .mm-sheen{stroke-opacity:.65}
  .mm-trace{stroke-dasharray:1;stroke-dashoffset:1;opacity:0}
  .mm-loading .mm-fill{opacity:.14}
  .mm-loading .mm-sheen{stroke-opacity:0}
  .mm-loading .mm-trace{opacity:1;animation:mmTrace 1.5s cubic-bezier(.45,.05,.35,1) infinite}
  .mm-loading .mm-trace-echo{animation-delay:.55s}
  @keyframes mmTrace{0%{stroke-dashoffset:1}62%{stroke-dashoffset:0}100%{stroke-dashoffset:0}}
  .mm-thinking .mm-sheen{animation:mmSheen 2.6s ease-in-out infinite}
  @keyframes mmSheen{0%,100%{stroke-opacity:.25}50%{stroke-opacity:1}}
  .mm-thinking .mm-echo-g{animation:mmEcho 2.6s ease-in-out infinite}
  @keyframes mmEcho{0%,16%{opacity:.35;transform:translateX(-12px)}52%,100%{opacity:1;transform:translateX(0)}}
  @media (prefers-reduced-motion: reduce){
    .mm-loading .mm-trace{animation:none;stroke-dashoffset:0}
    .mm-loading .mm-fill{opacity:1}
    .mm-thinking .mm-sheen,.mm-thinking .mm-echo-g{animation:none}
  }
`;

export const MinicaMark: React.FC<{
  size?: number;
  state?: MarkState;
  className?: string;
  title?: string;
}> = ({ size = 24, state = 'idle', className = '', title }) => (
  <svg
    width={size}
    height={size}
    viewBox="220 250 610 530"
    className={`mm-mark mm-${state} ${className}`}
    role={title ? 'img' : undefined}
    aria-hidden={title ? undefined : true}
    style={{ display: 'block' }}
  >
    {title ? <title>{title}</title> : null}
    <style>{CSS}</style>
    <defs>
      <linearGradient id="mmGold" x1="0" y1="0" x2="0.25" y2="1">
        <stop offset="0%" stopColor="#f9ecc0" />
        <stop offset="38%" stopColor="#ecd28a" />
        <stop offset="74%" stopColor="#d3ac63" />
        <stop offset="100%" stopColor="#a17e3c" />
      </linearGradient>
      <linearGradient id="mmGoldEdge" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#f0d78a" />
        <stop offset="100%" stopColor="#b08a44" />
      </linearGradient>
    </defs>

    {/* lead voice — the line the copilot gives */}
    <g transform="translate(382,412)">
      <path className="mm-fill" d={DROP} fill="url(#mmGold)" />
      <path className="mm-sheen" d={SHEEN} fill="none" stroke="#fff7dc" strokeWidth={10} strokeLinecap="round" />
      <path className="mm-trace mm-trace-lead" d={DROP} pathLength={1} fill="none" stroke="url(#mmGoldEdge)" strokeWidth={9} />
    </g>

    {/* echo voice — the words as you speak them */}
    <g className="mm-echo-g" style={{ transformBox: 'fill-box', transformOrigin: 'center' } as React.CSSProperties}>
      <g transform="translate(668,412)">
        <path className="mm-fill" d={DROP} fill="#2b2839" />
        <path className="mm-fill" d={DROP} fill="none" stroke="url(#mmGoldEdge)" strokeWidth={7} strokeOpacity={0.85} />
        <path className="mm-trace mm-trace-echo" d={DROP} pathLength={1} fill="none" stroke="url(#mmGoldEdge)" strokeWidth={9} />
      </g>
    </g>
  </svg>
);

export default MinicaMark;
