// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ProviderIcons — official AI provider brand marks
//
//  Each export wraps the corresponding SVG from
//  @lobehub/icons-static-svg (MIT-licensed) imported via
//  vite-plugin-svgr's `?react` query so the SVG is bundled into
//  our build as a React component. This package is the lighter
//  sibling of @lobehub/icons — static SVG only, zero peer deps,
//  no @lobehub/ui transitive (which is what blew up the v4.0.0
//  build with electron-builder + npm-ls).
//
//  We use the monochrome marks (`gemini.svg`, `openai.svg`, etc.,
//  not the `*-color.svg` variants) so each icon picks up the
//  chip's `color` via `currentColor` — preserving the per-model
//  accent theming the existing CSS already wires (blue for
//  Gemini, orange for Groq, emerald for OpenAI, zinc for Grok,
//  gold for Claude).
//
//  Trademark / nominative-use note: each provider's logo is
//  their trademark. Displaying it next to the provider's name
//  in a model picker is nominative use — explicitly permitted
//  under trademark law. This is industry-standard practice
//  across every serious AI app on the market (Cursor, Continue,
//  T3 Chat, Lobe Chat, Open WebUI, Claude Desktop integrations).
//  Lobe distributes the SVGs MIT for exactly this purpose.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

// SVGR converts each SVG file into a React component at build
// time. Per @lobehub/icons-static-svg's package layout the icons
// live under /icons/<name>.svg.
import GeminiSvg from '@lobehub/icons-static-svg/icons/gemini.svg?react';
import OpenAISvg from '@lobehub/icons-static-svg/icons/openai.svg?react';
import AnthropicSvg from '@lobehub/icons-static-svg/icons/anthropic.svg?react';
import GrokSvg from '@lobehub/icons-static-svg/icons/grok.svg?react';
import GroqSvg from '@lobehub/icons-static-svg/icons/groq.svg?react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

// Common wrapper that normalizes the size prop across all five
// brand icons. SVGR-generated components accept all standard SVG
// element props, so width/height/className/style flow through.
const wrap = (Comp: React.ComponentType<React.SVGProps<SVGSVGElement>>) =>
  ({ size = 18, ...rest }: IconProps) =>
    <Comp width={size} height={size} aria-hidden="true" focusable={false} {...rest} />;

export const GeminiIcon = wrap(GeminiSvg);
export const OpenAIIcon = wrap(OpenAISvg);
// Claude inherits Anthropic's mark (the asterisk) — same approach
// Anthropic itself takes in claude.ai's UI.
export const ClaudeIcon = wrap(AnthropicSvg);
export const GrokIcon = wrap(GrokSvg);
export const GroqIcon = wrap(GroqSvg);

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
