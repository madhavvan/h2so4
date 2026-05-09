// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ProviderIcons — AI model provider brand-aligned marks
//
//  Hand-crafted geometric SVG icons that identify each provider in
//  the model picker chips. We deliberately use clean geometric
//  primitives (ellipses / triangles / X-strokes / rounded squares
//  with lightning) instead of pulling intricate brand artwork —
//  that approach reads better at the small sizes we render at
//  (12px in the popout dropdown, 18px in compact cards, 22px in
//  the full-size Claude showcase) AND keeps the bundle dep-free.
//
//  History note: an earlier v4.0.0 build pulled in @lobehub/icons
//  for "exact" brand marks, but that package transitively
//  required @lobehub/ui (~460 packages including ant-design /
//  dnd-kit / emoji-mart) and its react ^18 peer-dep clashed with
//  our react 19, polluting `npm ls --json` with ELSPROBLEMS errors
//  that broke electron-builder's node-modules collector. Cut for
//  the release. Future revisit: switch to @lobehub/icons-static-svg
//  (the lighter sibling package) if exact brand artwork is needed.
//
//  All icons use `fill="currentColor"` so the chip's existing
//  brand-color theming flows through (`color: meta.brand.fg` set
//  inline on `.mp-mono`, gold-gradient `.mp-card-mono-max` for
//  Claude). The SVG canvas is 24×24 — chip CSS already handles
//  centering via inline-flex + align-items: center.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

const baseSvgProps = (size: number | string = 18) => ({
  xmlns: 'http://www.w3.org/2000/svg',
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'currentColor' as const,
  'aria-hidden': true as const,
  focusable: false as const,
});

/**
 * GeminiIcon — 4-point asymmetric sparkle/star with concave
 * bezier sides. The elongated points + concave curves are the
 * shape language Google uses for the Gemini brand mark, but
 * constructed from a simple closed bezier path.
 */
export const GeminiIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...baseSvgProps(size)} {...rest}>
    <path d="M12 2 C12.5 7.5 13.5 9.5 17 11.2 C17.5 11.45 17.5 12.55 17 12.8 C13.5 14.5 12.5 16.5 12 22 C11.5 16.5 10.5 14.5 7 12.8 C6.5 12.55 6.5 11.45 7 11.2 C10.5 9.5 11.5 7.5 12 2 Z" />
  </svg>
);

/**
 * OpenAIIcon — 6-fold radial flower. Six elongated petals
 * (ellipses) at 60° rotations around the center, overlapping
 * inward to produce the dense-center / flared-outer silhouette
 * that reads as "OpenAI" at icon sizes.
 */
export const OpenAIIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...baseSvgProps(size)} {...rest}>
    <g>
      {[0, 60, 120, 180, 240, 300].map(angle => (
        <ellipse
          key={angle}
          cx="12"
          cy="6.5"
          rx="1.55"
          ry="4.5"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </g>
  </svg>
);

/**
 * ClaudeIcon — 8-petal asterisk with alternating long cardinals
 * + shorter diagonals. The long-N/E/S/W + short-NE/SE/SW/NW
 * pattern is the visual signature that distinguishes Anthropic's
 * mark from a regular 8-point star.
 */
export const ClaudeIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...baseSvgProps(size)} {...rest}>
    <g>
      {/* 4 long cardinal petals — apex 9 units from center */}
      {[0, 90, 180, 270].map(angle => (
        <path
          key={`c-${angle}`}
          d="M12 3 L12.65 11.4 L11.35 11.4 Z"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
      {/* 4 shorter diagonal petals — apex 6 units from center */}
      {[45, 135, 225, 315].map(angle => (
        <path
          key={`d-${angle}`}
          d="M12 6 L12.45 11.6 L11.55 11.6 Z"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </g>
  </svg>
);

/**
 * GrokIcon — Two crossing parallelogram strokes forming an X.
 * Sharp angular ends, geometric construction. Picks up the
 * chip's currentColor (white on dark in our case).
 */
export const GrokIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...baseSvgProps(size)} {...rest}>
    <path d="M5 4 L8.5 4 L19 20 L15.5 20 Z" />
    <path d="M19 4 L15.5 4 L5 20 L8.5 20 Z" />
  </svg>
);

/**
 * GroqIcon — Rounded square frame with a horizontal lightning
 * bolt cutting through center. Lightning evokes Groq's brand
 * promise (fast LPU inference); the rounded square ties the
 * mark visually to other geometric AI tooling logos.
 */
export const GroqIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...baseSvgProps(size)} {...rest}>
    <path d="M6 4 H18 A2 2 0 0 1 20 6 V18 A2 2 0 0 1 18 20 H6 A2 2 0 0 1 4 18 V6 A2 2 0 0 1 6 4 Z M7 6 H17 A1 1 0 0 1 18 7 V17 A1 1 0 0 1 17 18 H7 A1 1 0 0 1 6 17 V7 A1 1 0 0 1 7 6 Z" />
    <path d="M14 7 L9 13 L12 13 L10 17 L15 11 L12 11 Z" />
  </svg>
);

// Map keyed by ModelKey for lookup-style access — same shape as
// the prior version so existing callers work unchanged.
export const PROVIDER_ICONS = {
  gemini: GeminiIcon,
  groq: GroqIcon,
  openai: OpenAIIcon,
  xai: GrokIcon,
  claude: ClaudeIcon,
} as const;

export type ProviderIconKey = keyof typeof PROVIDER_ICONS;
