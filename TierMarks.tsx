// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TierMarks — Basic / Pro / Max precious-material identity marks
//
//  A materials ladder that mirrors the price ladder, in the same baked-SVG
//  dialect as UltraMark (the amethyst flagship). Reading up the tiers:
//
//    • Basic → BRONZE     (BasicMark)  — warm copper, the entry metal
//    • Pro   → PLATINUM    (ProMark)   — cool polished silver-white
//    • Max   → GOLD        (MaxMark)   — rich yellow-gold, the top metal
//    • Ultra → AMETHYST+GOLD gem       — the jewel, one rung ABOVE all metal
//                                        (lives in UltraMark.tsx, untouched)
//
//  WHY metals-then-jewel: bronze < silver < gold is the most universally
//  legible value ladder there is (medals, trophies, card tiers), and a cut
//  gemstone unambiguously outranks any metal — so Ultra keeps its crown.
//
//  ENGINEERED TO STAY BELOW ULTRA. These three are deliberately quieter than
//  the flagship: each is a SINGLE material (a two-stop→three-stop sheen of
//  ONE metal, not a two-material journey), none carries amethyst (the violet
//  is Ultra's alone), none has a lit inner "table" face, and even Gold's
//  brightest highlight (#f3db8f) is kept a hair softer than Ultra's champagne
//  glint (#faeec6). So next to them the jewel still wins the eye — which is
//  the whole point.
//
//  Shared light model: every gradient is userSpaceOnUse, raked from the
//  upper-LEFT down to the lower-right (matching UltraMark's x1 6 y1 3 →
//  x2 17 y2 21 axis), so the whole tier row looks lit by one warm source.
//  userSpaceOnUse (not objectBoundingBox) is load-bearing: on the multi-path
//  marks it keeps ONE continuous sheen across every path instead of
//  restarting the gradient inside each path's own box.
//
//  Shapes are the EXACT existing marks — lucide `Zap` (v0.562.0) for Basic,
//  lucide `Crown` for Pro, and WizardHat's Aureole-Star geometry for Max —
//  so only the COLOUR changes vs. what shipped; the silhouettes users already
//  know are preserved. Native stroke weights are preserved too (2 / 2 / 1.5).
//
//  Self-coloured by design: like UltraMark, these ignore currentColor / the
//  parent span tint — the tier's material IS its identity. Wired into the
//  pricing rows (PLAN_ROW_META in ManageSubscription.tsx). The semantic
//  identity chips (TIER_INFO, emerald/blue/amber) are left on currentColor.
//  Same drop-in API as every other mark: `size` / `strokeWidth` / ...rest,
//  24×24 box. Reads cleanly from ~13px chips up.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

interface MarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

// ── Basic → BRONZE ────────────────────────────────────────────────────────
// lucide `Zap` bolt, self-coloured in warm copper. Outline-only (no fill) —
// Basic is intentionally the plainest mark, the entry metal.
export const BasicMark = ({ size = 20, strokeWidth = 2, ...rest }: MarkProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="url(#tierBronze)"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <defs>
      {/* Warm copper sheen — clearly browner/redder than Gold's yellow so the
          two warm metals never read as the same colour at chip size. */}
      <linearGradient id="tierBronze" gradientUnits="userSpaceOnUse" x1="5" y1="3" x2="17" y2="21">
        <stop offset="0" stopColor="#e6a468" />
        <stop offset="0.5" stopColor="#b56f30" />
        <stop offset="1" stopColor="#7a471d" />
      </linearGradient>
    </defs>
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  </svg>
);

// ── Pro → PLATINUM ────────────────────────────────────────────────────────
// lucide `Crown`, self-coloured in cool polished silver-white. The cool hue
// separates it cleanly from the warm bronze below and warm gold above.
export const ProMark = ({ size = 20, strokeWidth = 2, ...rest }: MarkProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="url(#tierPlatinum)"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <defs>
      {/* Cool platinum with a faint blue cast up top so it reads as "polished
          metal", not a greyed-out / disabled icon. Shadow kept mid, not dark,
          so the crown stays legible on obsidian. */}
      <linearGradient id="tierPlatinum" gradientUnits="userSpaceOnUse" x1="5" y1="4" x2="19" y2="20">
        <stop offset="0" stopColor="#e9eff6" />
        <stop offset="0.5" stopColor="#b9c2ce" />
        <stop offset="1" stopColor="#79828f" />
      </linearGradient>
    </defs>
    <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
    <path d="M5 21h14" />
  </svg>
);

// ── Max → GOLD ────────────────────────────────────────────────────────────
// WizardHat's Aureole-Star (halo + 8-point octagram + core), self-coloured in
// rich yellow-gold. The boldest metal (a filled gold star) — the top one-time
// tier — but still single-material and violet-free, so Ultra outranks it.
export const MaxMark = ({ size = 20, strokeWidth = 1.5, ...rest }: MarkProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="url(#tierGold)"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <defs>
      {/* Rich yellow-gold built around the app's native #d3ac63 mid-tone.
          Highlight (#f3db8f) deliberately a touch softer than UltraMark's
          champagne (#faeec6) so the flagship keeps the brightest glint. */}
      <linearGradient id="tierGold" gradientUnits="userSpaceOnUse" x1="6" y1="3" x2="18" y2="21">
        <stop offset="0" stopColor="#f3db8f" />
        <stop offset="0.5" stopColor="#d3ac63" />
        <stop offset="1" stopColor="#9c7430" />
      </linearGradient>
    </defs>
    {/* Outer halo — soft aura at 55%. */}
    <circle cx="12" cy="12" r="10.5" strokeOpacity="0.55" />
    {/* 8-point divine star — filled gold. */}
    <path
      d="M12 5 L12.99 9.61 L16.95 7.05 L14.4 11.01 L19 12 L14.4 12.99 L16.95 16.95 L12.99 14.4 L12 19 L11.01 14.4 L7.05 16.95 L9.6 12.99 L5 12 L9.6 11.01 L7.05 7.05 L11.01 9.61 Z"
      fill="url(#tierGold)"
      stroke="none"
    />
    {/* Core sparkle — same cream focal point as the original. */}
    <path
      d="M12 9.5 L12.4 11.6 L14.5 12 L12.4 12.4 L12 14.5 L11.6 12.4 L9.5 12 L11.6 11.6 Z"
      fill="var(--cream, #ffffff)"
      fillOpacity="0.18"
      stroke="none"
    />
  </svg>
);
