// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BrandMark — minicaai's living identity medallion (obsidian & gold)
//
//  The app's brand mark, upgraded from a flat lucide <Mic> in a circle to a
//  layered gold-on-obsidian MEDALLION that carries the launcher icon's exact
//  "m" letterform (build/icon.svg geometry, 1024-space, reused verbatim so
//  the dock icon, the favicon and the in-app mark are one identity).
//
//  It is ANIMATED, and the animation tells the product's story —
//  a copilot that LISTENS to the interviewer, THINKS, and ANSWERS:
//
//    state="idle"       At rest. A slow specular sweep glides across the gold
//                       "m" every ~6s — polished metal catching light. Faint
//                       ambient bloom. Nothing else moves.
//    state="listening"  Sound ARRIVES: three concentric wavefront arcs pulse
//                       inward from the left toward the medallion, the whole
//                       coin breathes (scale 1→1.014), and the bloom swells
//                       with it. Reads as "audio is reaching the mark".
//    state="thinking"   The LOADING action: two gold comets race around the
//                       bezel rim (light traveling around machined metal)
//                       while the "m" pulses with inner light — the mind at
//                       work. Also the app's generic loading treatment.
//    state="answering"  The mark SPEAKS: wavefront arcs emit outward on the
//                       right, the "m" holds a steady inner glow, and a slow
//                       comet keeps orbiting. Mirrors `listening` — in on the
//                       left, out on the right.
//
//  Material realism comes from layers, not filters (the transparent pop-out
//  forbids backdrop-filter, and live feGaussianBlur would re-render every
//  animation frame): a radial-lit obsidian face, a machined two-tone gold
//  bezel (main ring lit top-left, counter-lit inner hairline), a top-left
//  bezel glint, a window-light specular ellipse on the face, an embossed
//  drop-shadow copy under the gold "m", a sheen glaze stamped over it, and
//  a pre-painted radial-gradient bloom instead of a blur halo.
//
//  Motion is GPU-cheap by construction: every animation is transform/opacity
//  only (CSS keyframes live in index.css under "BRAND MARK"), so it is safe
//  in the transparent Electron pop-out. Both global prefers-reduced-motion
//  kill-switches (index.html + pip-styles.css) cover these animations too.
//
//  Self-coloured like UltraMark/TierMarks: pure obsidian + gold, ignores
//  currentColor. Deliberately NO violet — the golden-purple hint is Ultra's
//  tier tell, never the brand's. Gradient ids are namespaced per instance
//  via useId so the mark can render in the header, the empty state and any
//  loading surface simultaneously without SVG id collisions.
//
//  Reads from 22px (header jewel) through 104px (empty-state hero).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

export type BrandMarkState = 'idle' | 'listening' | 'thinking' | 'answering';

interface BrandMarkProps {
  size?: number | string;
  state?: BrandMarkState;
  className?: string;
}

const STATE_LABEL: Record<BrandMarkState, string> = {
  idle: 'minicaai — ready',
  listening: 'minicaai — listening',
  thinking: 'minicaai — thinking',
  answering: 'minicaai — answering',
};

export const BrandMark = ({ size = 64, state = 'idle', className }: BrandMarkProps) => {
  // useId returns ":r1:" style tokens — strip anything url(#…) can't carry.
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = (name: string) => `bm-${name}-${uid}`;
  const url = (name: string) => `url(#${id(name)})`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      role="img"
      aria-label={STATE_LABEL[state]}
      className={`bm bm--${state}${className ? ` ${className}` : ''}`}
    >
      <defs>
        {/* Ambient bloom — a pre-painted radial glow standing in for a blur
            halo (cheap: only its opacity ever animates). */}
        <radialGradient id={id('bloom')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#e8c987" stopOpacity="0.5" />
          <stop offset="45%" stopColor="#d3ac63" stopOpacity="0.17" />
          <stop offset="72%" stopColor="#d3ac63" stopOpacity="0" />
        </radialGradient>

        {/* Soft grounding shadow under the coin so it sits IN the canvas
            instead of floating as a sticker. */}
        <radialGradient id={id('ground')} cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="#000000" stopOpacity="0.38" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0" />
        </radialGradient>

        {/* Machined gold bezel — lit from the upper-left, falling to deep
            bronze at the lower-right. userSpaceOnUse so the ramp spans the
            ring as one surface. */}
        <linearGradient id={id('bezel')} gradientUnits="userSpaceOnUse" x1="22" y1="16" x2="74" y2="80">
          <stop offset="0" stopColor="#f2e3ae" />
          <stop offset="0.3" stopColor="#d3ac63" />
          <stop offset="0.58" stopColor="#9a7a3d" />
          <stop offset="0.82" stopColor="#6e5527" />
          <stop offset="1" stopColor="#57431f" />
        </linearGradient>

        {/* Counter-lit inner hairline — bright where the main ring is dark.
            The opposing ramps are what read as a machined metal step. */}
        <linearGradient id={id('bezelIn')} gradientUnits="userSpaceOnUse" x1="24" y1="20" x2="72" y2="76">
          <stop offset="0" stopColor="#6e5527" />
          <stop offset="0.5" stopColor="#c9a45d" />
          <stop offset="1" stopColor="#f0e0aa" />
        </linearGradient>

        {/* Obsidian face — warm near-black lit from the upper-left, darkening
            into the bezel at the edge (built-in inner shadow). */}
        <radialGradient id={id('face')} cx="38%" cy="30%" r="78%">
          <stop offset="0" stopColor="#2a2416" />
          <stop offset="0.42" stopColor="#171310" />
          <stop offset="0.88" stopColor="#0a0907" />
          <stop offset="1" stopColor="#050403" />
        </radialGradient>

        {/* Window-light specular on the face + the bezel's top-left glint. */}
        <radialGradient id={id('spec')} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.13" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('glint')} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#fff8e2" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#fff8e2" stopOpacity="0" />
        </radialGradient>

        {/* The m's gold — same raked-from-upper-left light as the launcher
            icon and the tier marks. Coordinates are in the m's own
            1024-space (the group below scales it down). */}
        <linearGradient id={id('mGold')} gradientUnits="userSpaceOnUse" x1="300" y1="240" x2="720" y2="780">
          <stop offset="0" stopColor="#f7e7b5" />
          <stop offset="0.3" stopColor="#ddb878" />
          <stop offset="0.68" stopColor="#bb9350" />
          <stop offset="1" stopColor="#8a6a33" />
        </linearGradient>

        {/* Sheen glaze across the arch crowns — light catching the top of
            the letterform, fading out by mid-stem. */}
        <linearGradient id={id('mSheen')} gradientUnits="userSpaceOnUse" x1="0" y1="260" x2="0" y2="620">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>

        {/* Travelling specular band (the idle "metal catches light" action). */}
        <linearGradient id={id('sweep')} gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>

        {/* Comet tail for the bezel orbit — transparent tail → bright head. */}
        <linearGradient id={id('comet')} gradientUnits="userSpaceOnUse" x1="48" y1="15.4" x2="76.2" y2="31.7">
          <stop offset="0" stopColor="#f6e4b0" stopOpacity="0" />
          <stop offset="0.7" stopColor="#f6e4b0" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fbf0c8" />
        </linearGradient>

        {/* The launcher icon's exact "m": 3 capsule stems + 2 arched bridges
            (see build/icon.svg for the full geometry rationale). Defined once,
            stamped four times below (shadow / gold / sheen / inner-glow). */}
        <g id={id('m')}>
          <rect x="334" y="350" width="92" height="400" rx="46" />
          <rect x="466" y="350" width="92" height="400" rx="46" />
          <rect x="598" y="350" width="92" height="400" rx="46" />
          <path d="M 334 390 A 112 112 0 0 1 558 390 L 466 390 A 20 20 0 0 0 426 390 Z" />
          <path d="M 466 390 A 112 112 0 0 1 690 390 L 598 390 A 20 20 0 0 0 558 390 Z" />
        </g>
        <clipPath id={id('mClip')}>
          <use href={`#${id('m')}`} />
        </clipPath>
      </defs>

      {/* ── 1 · Ambient bloom (opacity-only animation per state) ── */}
      <circle className="bm-bloom" cx="48" cy="48" r="46" fill={url('bloom')} />

      {/* ── 2 · Incoming sound — wavefronts arriving from the left.
             Brightness grows inward (the wave reaching the mark). ── */}
      <g className="bm-waves bm-waves-in" stroke="#e8cf8f" strokeLinecap="round" fill="none">
        <path d="M 7.3 24.5 A 47 47 0 0 0 7.3 71.5" strokeWidth="1.3" opacity="0.5" />
        <path d="M 11.2 26.75 A 42.5 42.5 0 0 0 11.2 69.25" strokeWidth="1.5" opacity="0.72" />
        <path d="M 15.1 29 A 38 38 0 0 0 15.1 67" strokeWidth="1.7" opacity="0.95" />
      </g>

      {/* ── 3 · The answer — wavefronts emitted to the right. ── */}
      <g className="bm-waves bm-waves-out" stroke="#e8cf8f" strokeLinecap="round" fill="none">
        <path d="M 80.9 29 A 38 38 0 0 1 80.9 67" strokeWidth="1.7" opacity="0.95" />
        <path d="M 84.8 26.75 A 42.5 42.5 0 0 1 84.8 69.25" strokeWidth="1.5" opacity="0.72" />
        <path d="M 88.7 24.5 A 47 47 0 0 1 88.7 71.5" strokeWidth="1.3" opacity="0.5" />
      </g>

      {/* ── 4 · The medallion (breathes as one body while listening) ── */}
      <g className="bm-body">
        {/* grounding shadow */}
        <circle cx="48" cy="50" r="35" fill={url('ground')} />

        {/* bezel stack: dark outer edge → gold ring → counter-lit hairline */}
        <circle cx="48" cy="48" r="34.2" stroke="rgba(5,4,2,0.55)" strokeWidth="0.9" />
        <circle cx="48" cy="48" r="32.6" stroke={url('bezel')} strokeWidth="2.6" />
        <circle cx="48" cy="48" r="31.1" stroke={url('bezelIn')} strokeWidth="0.7" opacity="0.9" />

        {/* obsidian face + window light + bezel glint */}
        <circle cx="48" cy="48" r="30.7" fill={url('face')} />
        <ellipse cx="39" cy="33" rx="17" ry="11" fill={url('spec')} />
        <circle cx="25.4" cy="25.4" r="3" fill={url('glint')} opacity="0.85" />

        {/* the m — embossed: shadow under, gold on top, sheen glaze,
            inner-light overlay (animated), travelling specular band. */}
        <g transform="translate(48 48.6) scale(0.082) translate(-512 -514)">
          <g fill="#040302" opacity="0.5" transform="translate(7 15)">
            <use href={`#${id('m')}`} />
          </g>
          <use href={`#${id('m')}`} fill={url('mGold')} />
          <use href={`#${id('m')}`} fill={url('mSheen')} />
          <use className="bm-mglow" href={`#${id('m')}`} fill="#ffedb0" />
          <g clipPath={url('mClip')}>
            <g className="bm-sweep">
              <rect x="150" y="160" width="150" height="740" fill={url('sweep')} transform="skewX(-18)" opacity="0.8" />
            </g>
          </g>
        </g>
      </g>

      {/* ── 5 · Orbit comets — light racing the bezel rim (thinking). ── */}
      <g className="bm-orbit">
        <path d="M 48 15.4 A 32.6 32.6 0 0 1 76.2 31.7" stroke={url('comet')} strokeWidth="2.2" strokeLinecap="round" fill="none" />
        <circle cx="76.2" cy="31.7" r="1.7" fill="#fdf3cf" />
        <g transform="rotate(180 48 48)" opacity="0.55">
          <path d="M 48 15.4 A 32.6 32.6 0 0 1 76.2 31.7" stroke={url('comet')} strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <circle cx="76.2" cy="31.7" r="1.4" fill="#fdf3cf" />
        </g>
      </g>
    </svg>
  );
};

export default BrandMark;
