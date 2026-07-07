// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  UltraMark — Ultra-tier "Amethyst Brilliant" identity icon
//
//  Ultra is the apex tier — the unlimited monthly flagship, one rank above
//  Max. It needed a mark that sits ABOVE Max without repeating Max's visual
//  language, and that carries Ultra's amethyst/violet accent. The tiers each
//  own a distinct family so they never blur together:
//    • Pro  → Crown           (regalia)
//    • Max  → Aureole Star     (a radiant 8-point octagram inside a halo)
//    • Ultra→ THIS: a cut gem  (the singular, most-precious object)
//
//  The design is a **brilliant-cut gemstone** — the "crown jewel". A faceted
//  stone reads instantly as the rarest, highest-value thing in a set, and a
//  cut gem is a completely different silhouette from a star, a crown, or a
//  halo, so Ultra is never confused with Max/Pro at a glance. It is coloured
//  by a baked-in gold→amethyst gradient (#ultraGoldPurple, below): warm gold
//  raking the crown from the upper left, melting through the girdle into
//  rich amethyst down the pavilion — so beside the flat-gold tier icons it
//  reads as an amethyst SET IN gold, i.e. actual jewellery, not a tint swap.
//
//  Anatomy (24×24 viewBox), so anyone editing keeps the cut symmetric:
//    • TABLE   — the flat top facet, the segment y=5 from x=7.2 to x=16.8,
//                filled at 22% so the stone catches light (a hollow outline
//                reads as a cheap sticker; the lit table gives it a face —
//                and under the gradient it glows warm champagne-gold).
//    • CROWN   — two large kite facets falling from the table corners to the
//                girdle's centre (the "star" facets of a real brilliant cut).
//    • GIRDLE  — the widest line, y=9.2, the stone's equator.
//    • PAVILION— three facet lines fanning from the girdle down to the culet
//                (the bottom point at 12,20.8), the underside of the cut.
//
//  Deliberately distinct from lucide's `Gem` (only 3 inner lines, no lit
//  table — reads flat) and lucide's `Sparkles` (a 4-point glyph, the thing
//  this replaces). Drop-in for any lucide icon: same `size` / `strokeWidth`
//  / `className` props, same 24×24 box — but, uniquely, SELF-COLOURED: it
//  ignores currentColor/parent tint by design. The flagship mark owns its
//  own material; parents no longer need to (and cannot) tint it. Reads
//  cleanly from 13px (chips) through 22px (cards) and up.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

interface UltraMarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

export const UltraMark = ({ size = 20, strokeWidth = 1.4, ...rest }: UltraMarkProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="url(#ultraGoldPurple)"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    {/* One continuous gold→amethyst sweep shared by EVERY path below.
        gradientUnits="userSpaceOnUse" is load-bearing: with the default
        objectBoundingBox each path would restart the gradient inside its own
        bounding box (the girdle line alone would run the full gold→purple)
        and the stone would look shattered. The coords span the gem's bounds
        (x 2.8→21.2, y 5→20.8), angled so warm light rakes in from the upper
        left: gold across the table/crown, blending at the girdle, rich
        amethyst down the pavilion to the culet. */}
    <defs>
      <linearGradient
        id="ultraGoldPurple"
        gradientUnits="userSpaceOnUse"
        x1="6"
        y1="3"
        x2="17"
        y2="21"
      >
        <stop offset="0" stopColor="#faeec6" />
        <stop offset="0.34" stopColor="#d9b874" />
        <stop offset="0.54" stopColor="#a78bfa" />
        <stop offset="0.8" stopColor="#8b5cf6" />
        <stop offset="1" stopColor="#7c3aed" />
      </linearGradient>
    </defs>

    {/* Lit table facet — fills the top facet so the stone has a face that
        catches light (a warm gold glow up top), instead of a hollow outline. */}
    <path d="M7.2 5 H16.8 L12 9.2 Z" fill="url(#ultraGoldPurple)" fillOpacity="0.22" stroke="none" />

    {/* Stone outline: table → shoulders → girdle → culet. */}
    <path d="M7.2 5 H16.8 L21.2 9.2 L12 20.8 L2.8 9.2 Z" />

    {/* Girdle — the widest line (equator). */}
    <path d="M2.8 9.2 H21.2" />

    {/* Crown star facets — table corners falling to the girdle centre. */}
    <path d="M7.2 5 L12 9.2 M16.8 5 L12 9.2" />

    {/* Pavilion facets — fanned from the girdle down to the culet. */}
    <path d="M12 9.2 V20.8 M7.6 9.2 L12 20.8 M16.4 9.2 L12 20.8" />
  </svg>
);

export default UltraMark;
