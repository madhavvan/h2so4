// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GitHubIcons — GitHub Primer Octicons re-exposed as React icons
//
//  These are GitHub's own MIT-licensed icon designs from the Primer
//  Octicons library (https://primer.style/octicons/), copied verbatim
//  from the canonical 24px SVG sources. We use them in place of
//  lucide-react's generic `Send` / `Wand2` for the chat composer's
//  Send and Auto-Solve buttons because:
//
//   • paper-airplane-24 is the de-facto chat-send icon across GitHub
//     Issues, PR comments, Discussions, and Copilot Chat. Users coming
//     from any of those surfaces recognize it instantly. Lucide's `Send`
//     is conceptually the same shape but has a flatter silhouette and
//     lacks the inner-crease line that makes GitHub's variant read as
//     a folded paper plane vs. a triangle.
//
//   • sparkles-fill-24 is the universal "AI generate / magic / suggest"
//     mark that GitHub Copilot, ChatGPT, Cursor, Claude, Notion AI, and
//     basically every modern AI surface converged on. One big 4-point
//     star + two smaller satellites. Lucide's `Wand2` (a literal magic
//     wand with sparkle dots) reads as "fantasy game" — wrong cultural
//     register for an AI assistant.
//
//  Note we deliberately did NOT pull GitHub's `copilot-24` mascot icon
//  — that's GitHub's *brand* mark for their Copilot product, and using
//  it inside our app would mis-attribute the action to GitHub Copilot
//  instead of our own Auto-Solve flow. sparkles-fill is generic enough
//  to be brand-neutral.
//
//  License: MIT (Primer Octicons, GitHub Inc).
//    https://github.com/primer/octicons/blob/main/LICENSE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

interface OcticonProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

/**
 * paper-airplane-24 — GitHub's chat-send icon.
 * Single path defining the airplane silhouette plus the inner-crease
 * line that gives the icon its "folded paper" read. Path is filled
 * with currentColor so the icon picks up the parent button's text
 * color (white inside the gradient buttons, gray inside disabled).
 */
export const PaperAirplane = ({ size = 18, ...rest }: OcticonProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <path d="M1.513 1.96a1.374 1.374 0 0 1 1.499-.21l19.335 9.215a1.147 1.147 0 0 1 0 2.07L3.012 22.25a1.374 1.374 0 0 1-1.947-1.46L2.49 12 1.065 3.21a1.375 1.375 0 0 1 .448-1.25Zm2.375 10.79-1.304 8.042L21.031 12 2.584 3.208l1.304 8.042h7.362a.75.75 0 0 1 0 1.5Z" />
  </svg>
);

/**
 * sparkles-fill-24 — GitHub's "AI / magic / generate" icon.
 * Three filled paths: (1) the big 4-point sparkle in the upper-right,
 * (2) the medium sparkle in the lower-middle, (3) the small sparkle
 * in the lower-left. Together they read as "magical generation" at
 * any size. All three paths use currentColor so the whole composite
 * recolors as one unit.
 */
export const SparklesFill = ({ size = 18, ...rest }: OcticonProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <path d="M14.4 3.419a.639.639 0 0 1 1.2 0l.61 1.668a9.587 9.587 0 0 0 5.703 5.703l1.668.61a.639.639 0 0 1 0 1.2l-1.668.61a9.587 9.587 0 0 0-5.703 5.703l-.61 1.668a.639.639 0 0 1-1.2 0l-.61-1.668a9.587 9.587 0 0 0-5.703-5.703l-1.668-.61a.639.639 0 0 1 0-1.2l1.668-.61a9.587 9.587 0 0 0 5.703-5.703l.61-1.668ZM8 16.675a.266.266 0 0 1 .5 0l.254.694a3.992 3.992 0 0 0 2.376 2.377l.695.254a.266.266 0 0 1 0 .5l-.695.254a3.992 3.992 0 0 0-2.376 2.377l-.254.694a.266.266 0 0 1-.5 0l-.254-.694a3.992 3.992 0 0 0-2.376-2.377l-.695-.254a.266.266 0 0 1 0-.5l.695-.254a3.992 3.992 0 0 0 2.376-2.377L8 16.675ZM4.2.21a.32.32 0 0 1 .6 0l.305.833a4.793 4.793 0 0 0 2.852 2.852l.833.305a.32.32 0 0 1 0 .6l-.833.305a4.793 4.793 0 0 0-2.852 2.852L4.8 8.79a.32.32 0 0 1-.6 0l-.305-.833a4.793 4.793 0 0 0-2.852-2.852L.21 4.8a.32.32 0 0 1 0-.6l.833-.305a4.793 4.793 0 0 0 2.852-2.852L4.2.21Z" />
  </svg>
);
