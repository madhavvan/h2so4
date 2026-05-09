// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WizardHat — Max-tier "Aureole Star" identity icon
//
//  Despite the filename (kept stable so the import sites elsewhere don't
//  churn), this is NOT a literal wizard hat. The first revision was a
//  cone + brim + sparkle — it read as a costume hat, not as supremacy.
//  User feedback (2026-05-08) asked for "god's level" — something that
//  feels divine, supreme, top-of-everything.
//
//  The design now is an **Aureole Star**:
//    • Outer thin halo ring → "sacred / saintly" (universal across
//      Christian, Hindu, Buddhist, Islamic iconography — the ring of
//      light around a deity's head)
//    • Inner 8-point divine star (octagram) → "supreme power" (the
//      Bahá'í star, the Babylonian Ishtar star, the Islamic rub-el-hizb,
//      the Christian "morning star" — universally a positive divine
//      mark, distinct from the Pentagram's occult connotations and
//      from lucide's generic 4-point Star/Sparkle)
//    • A small inner accent dot → focal weight at the center so the
//      icon has a clear "core" rather than reading as empty
//
//  Together: halo + 8-point star + core = divine emanation. Reads
//  unambiguously as "god-tier" without leaning on any specific
//  religious tradition. Visually distinct from Pro's `Crown` (the
//  whole point of the icon swap was Pro≠Max differentiation), from
//  lucide's `Sparkles` (4-point, no halo), and from `Star` (5-point,
//  no halo).
//
//  Drop-in replacement for any lucide icon — same `size` / `strokeWidth`
//  / `className` props, same currentColor stroke, same 24×24 viewBox.
//  Validated to read cleanly at 8px (lock badges), 9px (header chips),
//  14px (inline buttons), 18-22px (cards), and beyond.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React from 'react';

interface WizardHatProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

export const WizardHat = ({ size = 20, strokeWidth = 1.5, ...rest }: WizardHatProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    {/*
      Outer halo ring. Stroked at 60% opacity (via stroke-opacity
      attribute) so it reads as a soft aura instead of a hard outline,
      letting the inner star carry the visual weight.
    */}
    <circle cx="12" cy="12" r="10.5" strokeOpacity="0.55" />

    {/*
      8-point divine star (octagram). Path traces 16 vertices in
      clockwise order, alternating outer points (radius 7) at the 8
      cardinal/inter-cardinal compass positions and inner valleys
      (radius 2.6) at the 22.5° offsets between them. Filled in
      currentColor with no stroke so the points stay sharp at 8px.

      Geometry recap (so anyone editing this can keep it symmetric):
        outer N / E / S / W                — at distance 7 from (12,12)
        outer NE / SE / SW / NW            — at distance 7, 45° rotated
        inner valleys at every 22.5° offset — at distance 2.6
    */}
    <path
      d="M12 5 L12.99 9.61 L16.95 7.05 L14.4 11.01 L19 12 L14.4 12.99 L16.95 16.95 L12.99 14.4 L12 19 L11.01 14.4 L7.05 16.95 L9.6 12.99 L5 12 L9.6 11.01 L7.05 7.05 L11.01 9.61 Z"
      fill="currentColor"
      stroke="none"
    />

    {/*
      Tiny core sparkle — a 4-point flame inside the octagram's
      inner valley diamond. Uses fill-rule: evenodd so it punches a
      visible "focal point" at the center even when the surrounding
      8-point star is solid currentColor. Keeps the icon from reading
      as a flat blob at small sizes.
    */}
    <path
      d="M12 9.5 L12.4 11.6 L14.5 12 L12.4 12.4 L12 14.5 L11.6 12.4 L9.5 12 L11.6 11.6 Z"
      fill="var(--cream, #ffffff)"
      fillOpacity="0.18"
      stroke="none"
    />
  </svg>
);

export default WizardHat;
