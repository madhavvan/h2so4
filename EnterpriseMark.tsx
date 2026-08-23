// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EnterpriseMark — Enterprise-tier "Gold Vault" identity icon
//
//  Enterprise ($1199/mo) is the Team plan and the top of the ladder: one
//  rank above Ultra, unlimited interview time that never expires. It needed
//  a mark that outranks Ultra without repeating anyone's visual language.
//  The families stay disjoint so no two tiers blur at 13px:
//    • Pro        → Crown            (regalia — a spiked top edge)
//    • Max        → Aureole Star     (radial — points from a centre)
//    • Ultra      → Brilliant gem    (a single faceted stone, pointing down)
//    • Enterprise → THIS: an arch    (round-topped, footed, load-bearing)
//
//  Why an arch rather than "a bigger gem". A gem is an argument about
//  rarity, and that argument is Ultra's. Enterprise's argument is different:
//  it is the thing everything else rests on. An arch is the structure that
//  gets stronger under load, and the wedge at its crown — the keystone,
//  drawn lit here — is the single stone the whole span depends on. That is a
//  team plan, drawn. Its silhouette (a round-topped span on two piers) also
//  shares nothing with a crown's spikes, a star's radiation, or a gem's
//  downward point, so the ladder stays readable in a crowded row of chips.
//
//  ⚠️ THE FIRST ATTEMPT WAS A TRASH CAN. It drew the keystone ALONE: a
//  block wider at the top than the bottom, a horizontal line above it, a
//  horizontal line below it, and two vertical ribs inside. Rendered at
//  42px on the landing page that is, unmistakably, a wastebasket with a
//  lid — tapered bin, ribs, base. A keystone only reads as a keystone when
//  the arch is around it; on its own it is a trapezoid, and a trapezoid
//  with a lid line is a bin. So the arch is now actually drawn, the taper
//  is gone, and there is no line above the form or across its foot.
//  If you edit this: never add a horizontal cap above the shape.
//
//  Anatomy (24×24 viewBox), for anyone editing:
//    • GROUND    — y=21, the full width: what the arch stands on.
//    • PIERS     — the two legs, outer faces at x=5.6 / x=18.4 and inner
//                  faces at x=8.2 / x=15.8, rising to the springing line
//                  at y=12.6 where the curve begins.
//    • EXTRADOS  — the outer curve, r=6.4 about (12, 12.6).
//    • INTRADOS  — the inner curve, r=3.8 about the same centre. The gap
//                  between the two IS the masonry; leaving the opening
//                  hollow is what stops the form reading as a solid block.
//    • VOUSSOIRS — two radial joint lines per side, at 45° and 22.5° off
//                  the springing, so the span reads as cut stone rather
//                  than as a doorway or a horseshoe.
//    • KEYSTONE  — the wedge at the crown, flanked at ±18° from vertical
//                  and FILLED at 28% so it catches light. It is the only
//                  filled area in the mark, which puts the eye exactly on
//                  the stone the metaphor is about.
//
//  Coloured by a baked-in champagne→deep-gold gradient (#entVaultGold):
//  no violet, deliberately. Ultra owns amethyst; a second colour up here
//  would make the top of the ladder look like Ultra's sibling rather than
//  its successor. Instead it is the deepest, most saturated gold in the
//  set — the same material as the other marks, more of it. Like UltraMark
//  this is SELF-COLOURED and ignores currentColor by design: the flagship
//  marks own their own material.
//
//  Drop-in for any lucide icon: same `size` / `strokeWidth` / `className`
//  props, same 24×24 box.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

interface EnterpriseMarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

export const EnterpriseMark = ({ size = 20, strokeWidth = 1.4, ...rest }: EnterpriseMarkProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="url(#entVaultGold)"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    {/* One continuous champagne→deep-gold sweep shared by every path.
        gradientUnits="userSpaceOnUse" is load-bearing for the same reason
        it is in UltraMark: with the default objectBoundingBox each path
        restarts the gradient inside its own bounding box, so the short
        voussoir strokes would each run the full range and the arch would
        look assembled from mismatched stones. The coords span the mark's
        bounds so light rakes in from the upper left. */}
    <defs>
      <linearGradient
        id="entVaultGold"
        gradientUnits="userSpaceOnUse"
        x1="4"
        y1="4"
        x2="20"
        y2="21"
      >
        <stop offset="0" stopColor="#fbf1cf" />
        <stop offset="0.3" stopColor="#e6c680" />
        <stop offset="0.62" stopColor="#c9a253" />
        <stop offset="1" stopColor="#9c7728" />
      </linearGradient>
    </defs>

    {/* Lit keystone — the wedge at the crown, and the only filled area.
        Outer edge follows the extrados, inner edge the intrados, so it is
        a true voussoir rather than a rectangle pasted on the curve. */}
    <path
      d="M10.02 6.51 A6.4 6.4 0 0 1 13.98 6.51 L13.17 8.99 A3.8 3.8 0 0 0 10.83 8.99 Z"
      fill="url(#entVaultGold)"
      fillOpacity="0.28"
      stroke="none"
    />

    {/* Outer face: pier → extrados → pier. */}
    <path d="M5.6 21 V12.6 A6.4 6.4 0 0 1 18.4 12.6 V21" />

    {/* Inner face: the opening. Hollow by design — a filled span would read
        as a solid block, which is how the first version became a bin. */}
    <path d="M8.2 21 V12.6 A3.8 3.8 0 0 1 15.8 12.6 V21" />

    {/* Keystone flanks — the joints that cut the crown stone free. */}
    <path d="M10.02 6.51 L10.83 8.99 M13.98 6.51 L13.17 8.99" />

    {/* Voussoir joints — two per side, so the span reads as cut stone. */}
    <path d="M7.47 8.07 L9.31 9.91 M16.53 8.07 L14.69 9.91" />
    <path d="M6.05 10.15 L8.65 10.85 M17.95 10.15 L15.35 10.85" />

    {/* Ground — what the whole arch stands on. */}
    <path d="M3.4 21 H20.6" />
  </svg>
);

export default EnterpriseMark;
