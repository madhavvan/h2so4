// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ProviderIcons — AI model provider brand marks
//
//  Each export is a thin wrapper around the corresponding component
//  from @lobehub/icons (MIT-licensed brand-icon library — the de-facto
//  package for AI-provider iconography in React, used by Cursor,
//  Continue, T3 Chat, Lobe Chat, Open WebUI, and others). We import
//  the `.Mono` (monochrome) variants so each icon picks up the
//  surrounding chip's `color` via `currentColor`, preserving the
//  per-model accent colors the existing CSS already wires up. The
//  `.Color` variant from Lobe ships with hard-coded brand colors and
//  would override our chip theming — wrong choice for our case.
//
//  Why an indirection layer (instead of importing @lobehub/icons
//  directly in App.tsx)?
//   1) Stable internal API — if Lobe ever renames or restructures,
//      the swap lives in one file.
//   2) Consistent prop shape (`size`) so the call sites in
//      ModelPickerCard don't need to know about Lobe's component
//      structure (Mono vs. Color vs. Combine etc.).
//   3) Single attribution / license note (see header).
//
//  Trademark / nominative use note: each provider's logo is their
//  trademark. Displaying it next to the provider's name in a model
//  picker is nominative use — explicitly permitted under trademark
//  law and standard practice across every AI app on the market.
//  Lobe Icons distributes the SVGs under MIT for exactly this
//  purpose; we use them unmodified.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';
import { Anthropic, Gemini, Grok, Groq, OpenAI } from '@lobehub/icons';

interface IconProps {
  size?: number | string;
  className?: string;
}

/**
 * GeminiIcon — Google Gemini's official brand mark via @lobehub/icons.
 * Monochrome variant; picks up the chip's `color` for tinting.
 */
export const GeminiIcon = ({ size = 18, ...rest }: IconProps) => (
  <Gemini size={size} {...rest} />
);

/**
 * OpenAIIcon — OpenAI's "Blossom" brand mark via @lobehub/icons.
 */
export const OpenAIIcon = ({ size = 18, ...rest }: IconProps) => (
  <OpenAI size={size} {...rest} />
);

/**
 * ClaudeIcon — Anthropic's "asterisk" brand mark via @lobehub/icons.
 * We use the Anthropic mark (the company's symbol) rather than a
 * Claude-specific glyph because Anthropic's identity centers on the
 * asterisk; "Claude" inherits it as the product mark in their own
 * UI as well.
 */
export const ClaudeIcon = ({ size = 18, ...rest }: IconProps) => (
  <Anthropic size={size} {...rest} />
);

/**
 * GrokIcon — xAI's Grok mark via @lobehub/icons.
 */
export const GrokIcon = ({ size = 18, ...rest }: IconProps) => (
  <Grok size={size} {...rest} />
);

/**
 * GroqIcon — Groq's mark via @lobehub/icons.
 */
export const GroqIcon = ({ size = 18, ...rest }: IconProps) => (
  <Groq size={size} {...rest} />
);

// ── Map keyed by ModelKey for lookup-style access; unchanged
// signature from the prior version so existing callers work.
export const PROVIDER_ICONS = {
  gemini: GeminiIcon,
  groq: GroqIcon,
  openai: OpenAIIcon,
  xai: GrokIcon,
  claude: ClaudeIcon,
} as const;

export type ProviderIconKey = keyof typeof PROVIDER_ICONS;
