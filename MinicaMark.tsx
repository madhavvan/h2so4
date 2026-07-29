// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MinicaMark — the "Given Word" brand mark as a living component.
//
//  The app icon's two quote-drops (gold = the line the copilot gives;
//  obsidian+gold edge = the words as you speak them), usable anywhere in
//  the UI as a status-bearing mark — the same trick Claude's asterisk
//  and Grok's slash pull during activity:
//
//  ⚠️ PICKING A STATE BY SIZE — this matters and is easy to get wrong:
//    "loading" animates ONLY STROKES (the fills sit at opacity .14 while
//    the outline traces). The viewBox is 610 units wide, so a 9-unit
//    trace renders at 9 × size/610 — that is 0.32px at 22px and 0.44px
//    at 30px. Sub-pixel. Below roughly 64px the state is a faint
//    flicker, not a trace, and reads as a rendering bug. Measured and
//    captured side by side before the in-app loaders were wired.
//    Use "loading" at 64px+; use "thinking" for anything inline — it
//    animates the echo drop's opacity and position, and filled shapes
//    stay legible at any size. Every in-app loader therefore uses
//    "thinking"; the landing's 104px brand beat uses "given".
//
//    state="idle"      static mark
//    state="loading"   Grok-school: the drops TRACE themselves in from
//                      their edges on a loop (fills dimmed) — "minica is
//                      loading". LARGE SIZES ONLY (see note above).
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

type MarkState = 'idle' | 'loading' | 'thinking' | 'given';

// One quote-drop silhouette, head r=132 centered at origin, tail to y=338.
// Identical geometry to build/icon.svg — keep them in sync.
const DROP =
  'M -132 0 A 132 132 0 1 1 118 60 C 122 160 76 262 -34 338 C 30 240 52 168 44 118 A 132 132 0 0 1 -132 0 Z';
// Specular arc across the head top (origin coords).
const SHEEN = 'M -93.3 -93.3 A 132 132 0 0 1 93.3 -93.3';

// The question that comes first. Drawn in the space the two drops will
// later occupy, then dissolved as the first drop takes its place — the
// mark is literally a question becoming a quotation.
//
// Sized and placed against the drops' real visual mass, not their heads:
// the pair spans y 280→750 and x 250→800, so the centre is (525, 515).
// Anchoring on the head centre (y=412) left the question floating high
// and reading small against the finished mark.
const QMARK = 'M -113 -125 A 113 113 0 1 1 0 -12 L 0 64';

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
  /* ── state="given" — the whole reason the mark is two quote-drops ──
     A question is asked. It resolves into the first drop — the line the
     copilot gives you. A beat. Then the second drop closes the quotation:
     the words as YOU speak them. The mark finishes itself, holds, and the
     question returns.
     One 6.4s timeline drives every element so the beats can never drift
     apart the way separate animations do. */
  .mm-q,.mm-q-dot{opacity:0}
  /* the dot lands a beat AFTER the hook finishes drawing, the way a hand
     writes it */
  .mm-given .mm-q-dot{animation:mmGivenQDot 6.4s ease-in-out infinite}
  @keyframes mmGivenQDot{0%,12%{opacity:0}16%,21%{opacity:1}28%,100%{opacity:0}}
  .mm-given .mm-fill{opacity:0}
  .mm-given .mm-sheen{stroke-opacity:0}
  .mm-given .mm-q{animation:mmGivenQ 6.4s ease-in-out infinite}
  .mm-given .mm-trace{opacity:0}
  .mm-given .mm-trace-lead{animation:mmGivenTraceA 6.4s ease-in-out infinite}
  .mm-given .mm-trace-echo{animation:mmGivenTraceB 6.4s ease-in-out infinite}
  .mm-given .mm-lead-g .mm-fill{animation:mmGivenFillA 6.4s ease-in-out infinite}
  .mm-given .mm-echo-g .mm-fill{animation:mmGivenFillB 6.4s ease-in-out infinite}
  .mm-given .mm-sheen{animation:mmGivenSheen 6.4s ease-in-out infinite}
  @keyframes mmGivenQ{
    0%{opacity:0;stroke-dashoffset:1}
    4%{opacity:1;stroke-dashoffset:1}
    14%{opacity:1;stroke-dashoffset:0}
    21%{opacity:1;stroke-dashoffset:0}
    28%,100%{opacity:0;stroke-dashoffset:0}
  }
  @keyframes mmGivenTraceA{
    0%,21%{opacity:0;stroke-dashoffset:1}
    24%{opacity:1;stroke-dashoffset:1}
    39%{opacity:1;stroke-dashoffset:0}
    50%,100%{opacity:0;stroke-dashoffset:0}
  }
  @keyframes mmGivenFillA{0%,33%{opacity:0}45%,92%{opacity:1}100%{opacity:0}}
  @keyframes mmGivenTraceB{
    0%,45%{opacity:0;stroke-dashoffset:1}
    48%{opacity:1;stroke-dashoffset:1}
    63%{opacity:1;stroke-dashoffset:0}
    74%,100%{opacity:0;stroke-dashoffset:0}
  }
  @keyframes mmGivenFillB{0%,57%{opacity:0}69%,92%{opacity:1}100%{opacity:0}}
  @keyframes mmGivenSheen{0%,69%{stroke-opacity:0}77%{stroke-opacity:1}89%{stroke-opacity:.3}100%{stroke-opacity:0}}

  @media (prefers-reduced-motion: reduce){
    .mm-loading .mm-trace{animation:none;stroke-dashoffset:0}
    .mm-loading .mm-fill{opacity:1}
    .mm-thinking .mm-sheen,.mm-thinking .mm-echo-g{animation:none}
    /* The finished quotation, held still — the state the sequence ends on. */
    .mm-given .mm-q{animation:none;opacity:0}
    .mm-given .mm-trace{animation:none;opacity:0}
    .mm-given .mm-fill{animation:none;opacity:1}
    .mm-given .mm-sheen{animation:none;stroke-opacity:.65}
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

    {/* the question — drawn in the space the quotation will fill, then
        handed over to the first drop. Only ever visible in state="given". */}
    <g transform="translate(525,470)">
      <path
        className="mm-q"
        d={QMARK}
        pathLength={1}
        fill="none"
        stroke="url(#mmGoldEdge)"
        strokeWidth={38}
        strokeLinecap="round"
        strokeDasharray={1}
        strokeDashoffset={1}
      />
      <circle className="mm-q-dot" cx={0} cy={151} r={25} fill="url(#mmGoldEdge)" />
    </g>

    {/* lead voice — the line the copilot gives */}
    <g className="mm-lead-g" transform="translate(382,412)">
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
