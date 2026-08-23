import React, { useEffect, useRef, useState } from 'react';
import MinicaMark from './MinicaMark';
import { pricingService, PricingTier, RegionPricing, PLAN_GROUPS, groupOf } from './services/pricingService';
import { UltraMark } from './UltraMark';
import { EnterpriseMark } from './EnterpriseMark';
import { BasicMark, ProMark, MaxMark } from './TierMarks';
import { RefundPolicy } from './RefundPolicy';
// Confirmed-present phosphor glyphs (same set SubscriptionGate imports).
import {
  ArrowRight as PhArrowRight,
  CheckCircle as PhCheck,
  Shield as PhShield,
  Sparkle as PhSparkle,
  Lock as PhLock,
  Lightning as PhBolt,
  Monitor as PhMonitor,
  Headphones as PhHeadphones,
} from '@phosphor-icons/react';

// The tier marks from the electron app — the same bronze / platinum / gold /
// amethyst ladder — so the landing's pricing plans read as the SAME product
// as the app. Self-colouring gradient SVGs; free ("Starter") carries no
// precious mark by design (it's the pre-metal tier).
const TIER_MARK: Partial<Record<PricingTier['id'], React.ComponentType<{ size?: number }>>> = {
  basic: BasicMark,
  pro: ProMark,
  max: MaxMark,
  ultra: UltraMark,
  enterprise: EnterpriseMark,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PREMIUM LANDING — "Obsidian & Gold, Cinematic Teleprompter"
//
//  The thesis: restraint IS the luxury. Deep obsidian black, warm off-white
//  paper text, and GOLD as the single, precious accent — used sparingly on
//  hairlines, one hero phrase, the CTA, and one spotlit object. The hero
//  headline TYPES ITSELF the way the product streams your answer (form =
//  function). Film grain + vignette give it material weight. Everything else
//  is air. Nothing like the generic dark-glass-gradient look.
//
//  Every motion effect on the page extends ONE metaphor — light in a dark
//  theater: a reading lamp that follows the cursor (brightens when you pause
//  to read), dust motes drifting in the hero projector beam, a rim light that
//  counters the hero card's tilt, gold foil catching light as headlines
//  reveal, hairlines that draw themselves, a capture scan-line that reads
//  the shared frame and finds nothing, and the step number you're on
//  lighting up like the current teleprompter line. All transform/opacity
//  only, all driven off refs (the typing hero re-renders 60×; effects must
//  not ride the React render loop), all off under prefers-reduced-motion.
//
//  Content sections (capability ledger, privacy, compatibility, FAQ) are
//  grounded in docs/public/*.md — tier labels follow the 2026-07 pricing
//  (services/pricingService.ts), NOT the stale tier map in FEATURES.md.
//
//  Self-contained (all selectors scoped under .pl-root). Renders the real
//  region-aware pricing and drives the real funnel via setView / handleTierSelect.
//
//  Target 1 complete: Pricing composition elevated to flagship staging.
//  One-time passes rendered as compact supporting grid (4-col). Ultra is a
//  distinct cinematic band — spotlight material, two-column features, larger
//  presence, gold-lifted treatment. All data + handlers untouched.
//
//  Target 2 complete: Full-bleed cinematic theater intermission between Why
//  and Kit. Slow breathing projector beams, traveling gold slit (the light
//  in the dark theater), breathing aperture, 28 delicate motes, proscenium
//  gate. At center: enormous, almost-invisible foil echo of the hero line
//  that the slit dramatically illuminates as it passes — a quiet miracle.
//
//  Stage wash (2026-08): after the globe the page went dead-flat ink.
//  Gold radial wash on .pl-root, warmer vignette, slightly louder grain,
//  brighter --mut, and ledger rows as beveled instrument plates so Kit
//  reads as the same theater — not a spec sheet on a black void.
//
//  Type lock (2026-08): the page was falling through to thin mixed faces.
//  Newsreader is the only display voice (opsz + wght + ital locked per
//  size — never opsz alone, which resets the other axes). Inter is the
//  only UI voice, inherited from .pl-root, never forced onto <p> so a
//  .pl-serif paragraph cannot be stolen back. One scale: display / h2 /
//  h3 / lede / ui. No new families.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface PremiumLandingProps {
  // Exact views the landing navigates to — a subset of SubscriptionGate's
  // View union, spelled out so passing its setState dispatcher type-checks.
  setView: (v: 'login' | 'signup' | 'docs' | 'support' | 'tutorials') => void;
  // Null while geo/pricing is still resolving — tiers render empty until then.
  pricing: RegionPricing | null;
  handleTierSelect: (tier: PricingTier) => void;
  isSubmitting: boolean;
  // Checkout feedback. A signed-in visitor clicking a paid tier goes
  // straight into initiateCheckout — its failures (geo not resolved,
  // server 4xx/5xx, timeout) land in the gate's paymentError, which
  // every other purchase surface renders but the landing used to
  // swallow: the click just silently did nothing. Optional so the
  // component stays drop-in for previews/tests without the gate.
  paymentError?: string | null;
  onDismissPaymentError?: () => void;
}

const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

const prefersReduce = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const hasFinePointer = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

const CSS = `
.pl-root{
  --ink:#070706; --ink2:#0b0a08; --paper:#f6f2e9; --mut:#c6beaf; --faint:#8a8377;
  --line:rgba(255,255,255,.07);
  --gold-1:#f6e4b0; --gold-2:#d9b874; --gold-3:#b58f45; --gold:#d3ac63;
  --gold-line:rgba(211,172,99,.24); --gold-glow:rgba(211,172,99,.16);
  /* ── Amethyst: the SECOND voice ──────────────────────────────────
     The page is gold on obsidian, so a second colour has to earn its
     place by MEANING something, or it is just a stray accent. It means
     one thing here and never anything else:
         gold   = the full answer — considered, arrives when it is ready
         violet = the covering line — half a second, yours to speak NOW
     Given the same token shape as gold (1/2/3 + line + glow) on purpose:
     a sibling of the system reads as designed, a one-off hex reads as a
     mistake. Blue-violet rather than magenta so it separates cleanly
     from gold's warmth at small sizes and on a near-black ground. */
  --pv-1:#d7c2ff; --pv-2:#a271ff; --pv-3:#6c3fd6; --pv:#b48dff;
  --pv-line:rgba(162,113,255,.32); --pv-glow:rgba(162,113,255,.22);
  position:fixed; inset:0; overflow-y:auto; overflow-x:hidden;
  background:
    radial-gradient(90% 48% at 50% -10%, rgba(211,172,99,.135), transparent 58%),
    radial-gradient(55% 36% at 88% 28%, rgba(180,140,70,.06), transparent 52%),
    radial-gradient(50% 30% at 8% 70%, rgba(211,172,99,.045), transparent 48%),
    var(--ink);
  color:var(--paper);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-optical-sizing:auto;
  font-kerning:normal;
  font-weight:460;
  font-size:16.5px;
  line-height:1.55;
  font-feature-settings:"ss01" 1,"cv11" 1,"kern" 1,"liga" 1,"calt" 1;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
  letter-spacing:-0.012em;
  font-synthesis:none;
}
/* Inter only on chrome that sits inside a serif parent. Do NOT force it
   onto p/li — that rule beat .pl-serif and mixed the faces. */
.pl-root button,.pl-root summary,.pl-root input,.pl-root a{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-optical-sizing:auto;
}
.pl-root *{box-sizing:border-box;}
/* Bar-less scrolling — the landing reads as a cinematic surface, not a
   document. Wheel / touch / keys / programmatic scrollTo all still work;
   only the visible scrollbar chrome goes. */
.pl-root{scrollbar-width:none;-ms-overflow-style:none;}
.pl-root::-webkit-scrollbar{width:0;height:0;display:none;}
.pl-root ::selection{background:rgba(211,172,99,.3);color:#fff;}
.pl-root :focus-visible{outline:2px solid var(--gold-2);outline-offset:3px;border-radius:4px;}
.pl-serif{font-family:'Newsreader','Tiempos Headline',ui-serif,Georgia,serif;
  font-optical-sizing:none;font-weight:500;font-style:normal;font-kerning:normal;
  font-feature-settings:"kern" 1,"liga" 1;
  font-variation-settings:"opsz" 28,"wght" 500,"ital" 0;
  letter-spacing:-0.02em;font-synthesis:none;}
.pl-serif em,.pl-serif i{font-style:italic;font-weight:500;font-synthesis:none;
  font-variation-settings:"opsz" 28,"wght" 500,"ital" 1;}
.pl-display,.pl-root h1.pl-serif{
  font-size:clamp(38px,5.1vw,66px);line-height:1.02;letter-spacing:-0.032em;
  font-weight:520;text-wrap:balance;
  font-variation-settings:"opsz" 72,"wght" 520,"ital" 0;}
.pl-display em,.pl-display i,.pl-root h1.pl-serif em,.pl-root h1.pl-serif i{
  font-style:italic;font-weight:520;font-synthesis:none;
  font-variation-settings:"opsz" 72,"wght" 520,"ital" 1;}
.pl-h2,.pl-root h2.pl-serif{
  font-size:clamp(32px,4.15vw,52px);line-height:1.07;letter-spacing:-0.028em;
  font-weight:500;text-wrap:balance;
  font-variation-settings:"opsz" 52,"wght" 500,"ital" 0;}
.pl-h2 em,.pl-root h2.pl-serif em,.pl-h2 i,.pl-root h2.pl-serif i{
  font-style:italic;font-weight:500;font-synthesis:none;
  font-variation-settings:"opsz" 52,"wght" 500,"ital" 1;}
.pl-closing h2.pl-serif{
  font-size:clamp(34px,4.6vw,60px);letter-spacing:-0.03em;
  font-variation-settings:"opsz" 64,"wght" 500,"ital" 0;}
.pl-closing h2.pl-serif em,.pl-closing h2.pl-serif i{
  font-variation-settings:"opsz" 64,"wght" 500,"ital" 1;}
.pl-step-copy h3.pl-serif{
  font-size:clamp(22px,2.8vw,32px);line-height:1.16;letter-spacing:-0.02em;
  font-weight:500;font-variation-settings:"opsz" 28,"wght" 500,"ital" 0;}
.pl-price h3.pl-serif,.pl-price-pop h3.pl-serif{
  font-size:20px;letter-spacing:-0.016em;
  font-variation-settings:"opsz" 22,"wght" 500,"ital" 0;}
.pl-ultra-band h3.pl-serif{
  font-size:26px;letter-spacing:-0.018em;
  font-variation-settings:"opsz" 28,"wght" 500,"ital" 0;}
.pl-lede{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-optical-sizing:auto;font-weight:460;
  font-size:clamp(16.5px,1.35vw,18px);line-height:1.65;letter-spacing:-0.011em;
  color:var(--mut);}
.pl-wordmark{font-size:22px;font-weight:600;letter-spacing:-0.022em;color:var(--paper);
  font-variation-settings:"opsz" 22,"wght" 600,"ital" 0;}
.pl-price-num{font-size:42px;font-weight:500;letter-spacing:-0.024em;line-height:1;
  font-variation-settings:"opsz" 48,"wght" 500,"ital" 0;}
.pl-proof{font-size:20px;font-weight:500;letter-spacing:-0.018em;color:#c9c2b4;
  font-variation-settings:"opsz" 20,"wght" 500,"ital" 0;}
.pl-faq-q{font-size:20px;font-weight:500;letter-spacing:-0.018em;
  font-variation-settings:"opsz" 24,"wght" 500,"ital" 0;}
.pl-row-t{font-size:19px;font-weight:500;letter-spacing:-0.016em;
  font-variation-settings:"opsz" 22,"wght" 500,"ital" 0;}
.pl-model{font-size:17px;font-variation-settings:"opsz" 18,"wght" 500,"ital" 0;}
.pl-say{font-size:18px;line-height:1.55;letter-spacing:-0.012em;
  font-variation-settings:"opsz" 18,"wght" 500,"ital" 0;}
.pl-say-sm{font-size:12px;line-height:1.5;
  font-variation-settings:"opsz" 12,"wght" 500,"ital" 0;}
.pl-grain{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.07;mix-blend-mode:overlay;
  background-image:url("${GRAIN}");background-size:140px 140px;}
.pl-vignette{position:fixed;inset:0;z-index:1;pointer-events:none;
  background:
    radial-gradient(110% 80% at 50% 6%, rgba(211,172,99,.06), transparent 42%),
    radial-gradient(120% 90% at 50% 8%, transparent 44%, rgba(0,0,0,.62) 100%);}
.pl-lamp{position:fixed;left:0;top:0;width:640px;height:640px;border-radius:50%;
  pointer-events:none;z-index:3;opacity:0;mix-blend-mode:screen;will-change:transform,opacity;
  background:radial-gradient(closest-side, rgba(211,172,99,.5), rgba(211,172,99,.1) 44%, transparent 72%);}
.pl-wrap{max-width:1140px;margin:0 auto;padding:0 34px;position:relative;z-index:2;}
.pl-navbar{position:sticky;top:0;z-index:6;border-bottom:1px solid transparent;
  transition:background .4s ease, border-color .4s ease, backdrop-filter .4s ease;}
.pl-navbar.pl-scrolled{background:rgba(9,8,7,.74);border-bottom-color:var(--line);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);}
/* ── Every nav destination has to clear the sticky bar ──
   scrollTo() uses scrollIntoView({block:'start'}), which parks a section's
   TOP at the scrollport's top — which is exactly where the sticky navbar
   is sitting. Nothing else corrects for that, so each destination was
   losing however much of itself the bar covers: measured against their own
   top padding, Features and Pop-out lost 38px, FAQ 16px, Privacy 6px, and
   the wordmark's scroll-to-top buried 18px of the hero. Only Pricing
   survived, by 2px of luck (80px padding vs a 78px bar).
   Set once, on the ids themselves, so a new section cannot be added
   without it. 92px = 78px bar + 14px of air; 74px = 60px bar + 14px. */
.pl-root [id]{scroll-margin-top:92px;}
@media (max-width:767px){ .pl-root [id]{scroll-margin-top:74px;} }
.pl-eyebrow{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-optical-sizing:auto;font-size:11.5px;font-weight:600;letter-spacing:.34em;
  text-transform:uppercase;color:var(--gold);}
.pl-gold{background:linear-gradient(100deg,var(--gold-1),var(--gold-2) 52%,var(--gold-3));
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;}
.pl-foil{background-size:230% 100%;background-position:82% 0;}
.pl-reveal.pl-in .pl-foil{animation:pl-foilsweep 1.5s .2s cubic-bezier(.3,.7,.2,1) forwards;}
@keyframes pl-foilsweep{from{background-position:82% 0;}to{background-position:0% 0;}}
.pl-goldline{height:1px;background:linear-gradient(90deg,transparent,var(--gold-line),transparent);}
.pl-drawline{transform:scaleX(0);transform-origin:center;
  transition:transform 1.3s cubic-bezier(.2,.8,.2,1);}
.pl-drawline.pl-in{transform:scaleX(1);}
.pl-caret{display:inline-block;width:3px;height:.92em;margin-left:4px;vertical-align:-.08em;
  background:var(--gold);border-radius:1px;box-shadow:0 0 12px var(--gold-glow);
  animation:pl-blink 1.05s steps(2,start) infinite;}
@keyframes pl-blink{to{opacity:0;}}
.pl-cta{position:relative;overflow:hidden;cursor:pointer;border:none;
  background:linear-gradient(100deg,var(--gold-1),var(--gold-2) 55%,var(--gold-3));
  color:#231c0c;font-weight:650;letter-spacing:-0.014em;
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  box-shadow:0 14px 40px -16px rgba(211,172,99,.7), inset 0 1px 0 rgba(255,255,255,.4);
  transition:transform .25s cubic-bezier(.2,.9,.3,1), box-shadow .3s, filter .3s;}
.pl-cta:hover{transform:translateY(-2px);filter:brightness(1.05);box-shadow:0 22px 54px -18px rgba(211,172,99,.85), inset 0 1px 0 rgba(255,255,255,.5);}
.pl-cta:active{transform:translateY(0);}
.pl-cta::after{content:'';position:absolute;top:0;left:-130%;width:42%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);transition:left .8s;}
.pl-cta:hover::after{left:230%;}
.pl-mag{display:inline-block;transition:transform .5s cubic-bezier(.2,.9,.25,1.15);will-change:transform;}
.pl-textlink{background:none;border:none;cursor:pointer;color:var(--paper);font-weight:500;
  display:inline-flex;align-items:center;gap:7px;transition:gap .25s,color .2s;}
.pl-textlink:hover{gap:11px;color:var(--gold);}
.pl-navlink{background:none;border:none;cursor:pointer;color:var(--mut);font-size:13.5px;font-weight:500;
  transition:color .2s;}
.pl-navlink:hover{color:var(--paper);}
.pl-live{width:7px;height:7px;border-radius:50%;background:var(--gold);
  box-shadow:0 0 0 0 rgba(211,172,99,.6);animation:pl-pulse 1.9s ease-out infinite;}
@keyframes pl-pulse{0%{box-shadow:0 0 0 0 rgba(211,172,99,.55);}70%{box-shadow:0 0 0 8px rgba(211,172,99,0);}100%{box-shadow:0 0 0 0 rgba(211,172,99,0);}}
/* ── Hero card: "Obsidian Glass Teleprompter"
   A floating crystal plate under a single stage light. Signature is the
   traveling gold rim-beam (light catching a beveled edge), a pointer-driven
   specular sheet of glass, and a real floor caustic — not a flat dark box.
   All decorative. Content + handlers inside are untouched. ── */
.pl-obj{position:relative;isolation:isolate;overflow:hidden;
  background:
    linear-gradient(165deg, rgba(255,255,255,.045) 0%, transparent 38%),
    linear-gradient(180deg,#14110c 0%,#0c0a08 48%,#080706 100%);
  border:1px solid transparent;
  border-radius:22px;
  box-shadow:
    0 1px 0 rgba(255,255,255,.07) inset,
    0 -1px 0 rgba(0,0,0,.35) inset,
    0 0 0 1px rgba(211,172,99,.14),
    0 2px 4px rgba(0,0,0,.25),
    0 28px 56px -20px rgba(0,0,0,.75),
    0 60px 120px -40px rgba(0,0,0,.95),
    0 0 80px -28px rgba(211,172,99,.28);
  transform-style:preserve-3d;
}
/* Soft glass film over the body — gives the plate physical thickness */
.pl-obj::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:4;
  background:
    linear-gradient(180deg, rgba(255,255,255,.055) 0%, transparent 18%),
    linear-gradient(105deg, transparent 40%, rgba(246,228,176,.03) 50%, transparent 60%);
  mix-blend-mode:soft-light;}
/* Inner hairline — the beveled lip of cut glass */
.pl-obj::after{content:'';position:absolute;inset:1px;border-radius:21px;pointer-events:none;z-index:4;
  border:1px solid rgba(255,255,255,.04);
  box-shadow:inset 0 0 40px rgba(0,0,0,.18);}
/* Traveling gold rim-beam: conic light spinning slowly around the edge.
   Uses @property when available; otherwise a masked rotating layer. */
.pl-card-rimbeam{position:absolute;inset:0;border-radius:22px;pointer-events:none;z-index:6;
  background:conic-gradient(from var(--rim-angle,0deg),
    transparent 0deg,
    transparent 295deg,
    rgba(246,228,176,.08) 318deg,
    rgba(246,228,176,.95) 338deg,
    rgba(211,172,99,.7) 348deg,
    transparent 360deg);
  animation:pl-rimspin 8s linear infinite;
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;padding:1.25px;
  opacity:.9;}
@keyframes pl-rimspin{to{--rim-angle:360deg;}}
@property --rim-angle{syntax:'<angle>';initial-value:0deg;inherits:false;}
/* Fallback: rotate the whole gradient when CSS variables in @keyframes unsupported */
@supports not (background:conic-gradient(from var(--a,0deg),red,blue)){
  .pl-card-rimbeam{
    background:conic-gradient(from 0deg,transparent 0 78%,rgba(246,228,176,.85) 88%,rgba(211,172,99,.5) 93%,transparent 100%);
    animation:pl-rimspin-fallback 8s linear infinite;}
  @keyframes pl-rimspin-fallback{to{transform:rotate(360deg);}}
}
/* Pointer specular — a soft sheet of light across glass */
.pl-card-sheen{position:absolute;inset:0;border-radius:22px;pointer-events:none;z-index:5;
  background:radial-gradient(420px 280px at var(--sheenx,28%) var(--sheeny,18%),
    rgba(255,252,240,.14) 0%,
    rgba(246,228,176,.06) 28%,
    transparent 62%);
  opacity:.85;mix-blend-mode:soft-light;
  transition:opacity .4s ease;will-change:background;}
.pl-obj:hover .pl-card-sheen{opacity:1;}
/* Corner brackets — precision instrument frame, not decoration for its own sake */
.pl-card-corners{position:absolute;inset:10px;pointer-events:none;z-index:6;}
.pl-card-corners span{position:absolute;width:14px;height:14px;border-color:rgba(211,172,99,.38);border-style:solid;}
.pl-card-corners span:nth-child(1){top:0;left:0;border-width:1px 0 0 1px;border-radius:2px 0 0 0;}
.pl-card-corners span:nth-child(2){top:0;right:0;border-width:1px 1px 0 0;border-radius:0 2px 0 0;}
.pl-card-corners span:nth-child(3){bottom:0;left:0;border-width:0 0 1px 1px;border-radius:0 0 0 2px;}
.pl-card-corners span:nth-child(4){bottom:0;right:0;border-width:0 1px 1px 0;border-radius:0 0 2px 0;}
/* The living answer-stream inside the hero card: golden silk ribbons on a
   transparent GPU canvas. Paints under .pl-rim and the card copy; if WebGL
   is missing the canvas stays clear and the card is simply its old self. */
.pl-silk-canvas{position:absolute;inset:0;width:100%;height:100%;border-radius:22px;pointer-events:none;z-index:1;opacity:1;}
.pl-rim{position:absolute;inset:0;border-radius:22px;pointer-events:none;z-index:2;
  background:radial-gradient(460px 260px at var(--rimx,50%) var(--rimy,16%), rgba(246,228,176,.11), transparent 62%);}
/* Tilt shell — 3D parallax + idle float. Transition only when not mid-drag. */
.pl-tilt{transition:transform .55s cubic-bezier(.2,.8,.25,1);will-change:transform;transform-style:preserve-3d;}
.pl-tilt.pl-tilting{transition:transform .08s linear;}
.pl-card-float{animation:pl-float 7.2s ease-in-out infinite;}
@keyframes pl-float{
  0%,100%{transform:translateY(0);}
  50%{transform:translateY(-7px);}
}
.pl-spot{position:absolute;left:50%;top:38%;width:760px;height:520px;transform:translate(-50%,-50%);
  background:radial-gradient(ellipse at center, var(--gold-glow), transparent 62%);
  filter:blur(30px);pointer-events:none;z-index:0;}
.pl-beam{position:absolute;left:50%;top:32%;width:680px;height:540px;max-width:92vw;
  transform:translate(-50%,-50%);pointer-events:none;z-index:1;}
/* ── Hero: two-column cinematic stage. Left = the promise; right = the product,
   lit like cut glass on black velvet (directional light + floor caustic). ── */
.pl-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.06fr);
  gap:clamp(30px,4.4vw,60px);align-items:center;min-height:min(80vh,720px);}
.pl-hero-copy{max-width:560px;}
.pl-hero-sub{max-width:490px;margin-top:26px;}
.pl-hero-cta{display:flex;gap:24px;align-items:center;flex-wrap:wrap;justify-content:flex-start;margin:36px 0 16px;}
.pl-hero-visual{position:relative;perspective:1400px;}
.pl-stagelight{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);
  width:150%;height:140%;pointer-events:none;z-index:0;
  background:
    radial-gradient(48% 42% at 55% 30%,rgba(246,228,176,.18),rgba(211,172,99,.06) 42%,transparent 70%),
    radial-gradient(70% 55% at 50% 60%,rgba(211,172,99,.05),transparent 68%);}
/* Soft caustic under the card — the light pool on the stage floor.
   Opacity-only breathe so it never fights the load-in transform. */
.pl-card-aura{position:absolute;left:50%;bottom:-8%;transform:translateX(-50%);
  width:88%;height:42%;pointer-events:none;z-index:0;
  background:radial-gradient(ellipse at 50% 40%, rgba(211,172,99,.32) 0%, rgba(211,172,99,.08) 38%, transparent 70%);
  filter:blur(18px);opacity:.78;animation:pl-aurabreathe 7.2s ease-in-out infinite;}
@keyframes pl-aurabreathe{
  0%,100%{opacity:.65;}
  50%{opacity:1;}
}
/* Cross-browser floor reflection (replaces -webkit-box-reflect so Windows Chrome gets it) */
.pl-card-floor{position:absolute;left:6%;right:6%;top:calc(100% + 10px);height:38%;
  pointer-events:none;z-index:1;overflow:hidden;border-radius:0 0 18px 18px;
  -webkit-mask-image:linear-gradient(to bottom, rgba(0,0,0,.38) 0%, transparent 72%);
  mask-image:linear-gradient(to bottom, rgba(0,0,0,.38) 0%, transparent 72%);
  opacity:.55;transform:scaleY(-1);transform-origin:center top;
  background:
    linear-gradient(180deg, rgba(20,17,12,.9), rgba(8,7,6,.4)),
    radial-gradient(ellipse at 50% 0%, rgba(211,172,99,.2), transparent 60%);}
.pl-card-floor::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg, transparent, rgba(246,228,176,.08) 45%, transparent);
  animation:pl-floorsheen 6s ease-in-out infinite;}
@keyframes pl-floorsheen{
  0%,100%{opacity:.3;transform:translateX(-12%);}
  50%{opacity:.7;transform:translateX(12%);}
}
.pl-reflectwrap{position:relative;z-index:2;animation:pl-cardland 920ms 420ms cubic-bezier(.18,.82,.22,1) both;}
@media (max-width:980px){
  .pl-hero{grid-template-columns:1fr;gap:44px;min-height:0;text-align:center;}
  .pl-hero-copy{max-width:none;margin:0 auto;}
  .pl-hero-sub{margin-left:auto;margin-right:auto;}
  .pl-hero-cta{justify-content:center;}
  .pl-card-floor{display:none;}
  .pl-card-float{animation:none;}
  .pl-card-aura{animation:none;opacity:.55;}
}
.pl-mote{position:absolute;border-radius:50%;background:var(--gold-1);opacity:0;
  box-shadow:0 0 6px var(--gold-glow);filter:blur(.4px);
  animation-name:pl-drift;animation-timing-function:linear;animation-iteration-count:infinite;}
@keyframes pl-drift{
  0%{transform:translate3d(0,50px,0);opacity:0;}
  12%{opacity:var(--o,.3);}
  78%{opacity:calc(var(--o,.3)*.55);}
  100%{transform:translate3d(var(--dx,0px),-250px,0);opacity:0;}
}
/* ── The capture test (Invisible by design) ──
   Two IDENTICAL mini screen-share frames, overlapped: the back frame is
   what the interviewer's capture receives, the front is the same screen
   on your glass — plus the gold answer card. The only difference between
   the frames IS the card; a scan-line periodically reads the captured
   frame and finds nothing. The one foreign color on the page is the
   6px recording dot: recording lights are red in the physical world. */
.pl-cap{position:relative;max-width:520px;margin-left:auto;
  /* Room above the first frame so "They see" / "You see" pills aren't clipped. */
  padding-top:14px;}
/* overflow:visible so .pl-captag (top:-10px) can sit on the frame rim.
   Interior clipping is handled on .pl-frame-surface instead. */
.pl-frame{position:relative;overflow:visible;background:transparent;border:none;
  box-shadow:none;}
.pl-frame-surface{border-radius:12px;overflow:hidden;background:linear-gradient(180deg,#0e0d0b,#090807);
  border:1px solid var(--line);position:relative;}
.pl-frame--back .pl-frame-surface{opacity:.92;
  box-shadow:0 24px 60px -30px rgba(0,0,0,.85);}
.pl-frame--front{margin-top:26px;}
.pl-frame--front .pl-frame-surface{
  border-color:var(--gold-line);
  box-shadow:0 34px 90px -34px rgba(0,0,0,.92), 0 0 60px -24px var(--gold-glow), inset 0 1px 0 rgba(255,255,255,.05);}
.pl-chrome{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line);}
.pl-dot3{display:flex;gap:5px;}
.pl-dot3 i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.12);}
.pl-addr{flex:1;min-width:0;font-size:10px;letter-spacing:.03em;color:var(--faint);
  background:rgba(255,255,255,.035);border-radius:6px;padding:4px 9px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pl-sharepill{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;
  font-size:8.5px;font-weight:700;letter-spacing:.14em;color:var(--mut);
  border:1px solid var(--line);border-radius:999px;padding:3px 8px;}
.pl-recdot{width:6px;height:6px;border-radius:50%;background:#b0524a;
  box-shadow:0 0 6px rgba(176,82,74,.55);animation:pl-recblink 2.2s ease-in-out infinite;}
@keyframes pl-recblink{0%,100%{opacity:1;}50%{opacity:.35;}}
.pl-editor{position:relative;display:flex;gap:12px;padding:14px 14px 16px;overflow:hidden;}
.pl-gutter{display:flex;flex-direction:column;gap:9px;font-size:9px;line-height:7px;
  color:var(--faint);opacity:.55;font-variant-numeric:tabular-nums;text-align:right;}
.pl-lines{flex:1;display:flex;flex-direction:column;gap:9px;}
.pl-skl{height:7px;border-radius:4px;background:rgba(255,255,255,.075);}
.pl-scan{position:absolute;top:0;bottom:0;width:1px;background:linear-gradient(180deg,transparent,var(--gold-line),transparent);
  box-shadow:0 0 14px rgba(211,172,99,.25);opacity:0;animation:pl-scanmove 5.2s ease-in-out infinite;}
@keyframes pl-scanmove{0%,54%{left:4%;opacity:0;}58%{opacity:.9;}88%{opacity:.9;}96%,100%{left:96%;opacity:0;}}
.pl-captag{position:absolute;top:-10px;left:12px;z-index:5;font-size:9px;font-weight:700;
  letter-spacing:.18em;text-transform:uppercase;padding:3px 9px;border-radius:999px;
  background:#0b0a08;border:1px solid var(--line);color:var(--faint);
  white-space:nowrap;line-height:1.2;pointer-events:none;}
.pl-captag--you{border-color:var(--gold-line);color:var(--gold);}
.pl-mini{position:absolute;right:10px;bottom:10px;width:min(66%,250px);z-index:2;
  background:linear-gradient(180deg,#141109,#0c0a07);border:1px solid var(--gold-line);
  border-radius:10px;padding:10px 12px;
  box-shadow:0 18px 44px -18px rgba(0,0,0,.9), 0 0 30px -12px var(--gold-glow), inset 0 1px 0 rgba(255,255,255,.06);}
@media (max-width:980px){ .pl-cap{margin-left:0;} }
@media (max-width:767px){
  .pl-cap{padding-top:16px;}
  .pl-captag{font-size:10px;padding:4px 10px;letter-spacing:.14em;top:-11px;}
  .pl-sharepill{font-size:8px;padding:3px 6px;letter-spacing:.1em;}
  .pl-addr{font-size:9px;}
}
.pl-wave{display:flex;align-items:flex-end;gap:2.5px;height:22px;}
.pl-wave i{display:block;width:2.5px;border-radius:999px;background:linear-gradient(to top,var(--gold-3),var(--gold-1));
  animation:pl-eq 1.15s ease-in-out infinite;}
@keyframes pl-eq{0%,100%{height:3px;opacity:.5;}50%{height:20px;opacity:1;}}
.pl-reveal{opacity:0;transform:translateY(24px);transition:opacity 1s cubic-bezier(.2,.8,.2,1),transform 1s cubic-bezier(.2,.8,.2,1);}
.pl-reveal.pl-in{opacity:1;transform:none;}
/* Shared content grids — desktop two-up; phones collapse without minmax(300px)
   overflow that clipped copy on ~320–375px viewports. */
.pl-moment{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:56px;align-items:center;padding:56px 0;}
.pl-step-row{display:grid;grid-template-columns:auto 1fr auto;gap:clamp(20px,4vw,60px);align-items:center;padding-bottom:30px;}
.pl-step-copy{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:20px;align-items:baseline;}
/* ── Pricing surfaces, brought to the same material as the Answer
   Theater and the hero card ──
   These were the flattest cards on the page: one faint gradient and a
   neutral hairline, sitting directly beside the most considered surfaces
   we have. Same recipe as .pl-at — a radial light falling from above the
   card, a 1px inner highlight along the top edge so it reads as a bevel,
   and a deep contact shadow so the card sits ON the page instead of
   being painted onto it. */
.pl-price{position:relative;
  background:
    linear-gradient(165deg,rgba(255,255,255,.04) 0%,transparent 34%),
    linear-gradient(180deg,#100e0a 0%,#0b0a08 55%,#080706 100%);
  border:1px solid var(--line);border-radius:18px;
  box-shadow:0 1px 0 rgba(246,228,176,.05) inset,0 -1px 0 rgba(0,0,0,.4) inset,
             0 30px 60px -42px rgba(0,0,0,.9);
  transition:border-color .35s,transform .4s cubic-bezier(.2,.9,.3,1),box-shadow .4s;}
.pl-price::before,.pl-price-pop::before{content:'';position:absolute;inset:0;border-radius:inherit;
  pointer-events:none;
  background:radial-gradient(125% 78% at 50% -14%,rgba(211,172,99,.075),transparent 62%);}
/* The featured plan is the only card that catches a moving light. Five
   sweeping cards would be a fairground; one is a spotlight.
   The sweep travels as a BACKGROUND POSITION on the inset:0 ::before, not
   as a moving child — a moving child would need overflow:hidden to stay
   inside the rounded corners, and that would clip the "Most chosen" badge,
   which is deliberately positioned at top:-9 outside the card box. */
.pl-price-pop{position:relative;}
.pl-price-pop::before{
  background:
    linear-gradient(100deg,transparent 41%,rgba(246,228,176,.07) 50%,transparent 59%),
    radial-gradient(125% 78% at 50% -14%,rgba(211,172,99,.075),transparent 62%);
  background-size:300% 100%,100% 100%;
  background-position:190% 0,0 0;
  animation:pl-price-sheen 10s ease-in-out infinite;}
@keyframes pl-price-sheen{0%,60%{background-position:190% 0,0 0;}100%{background-position:-90% 0,0 0;}}
@media (prefers-reduced-motion:reduce){ .pl-price-pop::before{animation:none;background-position:190% 0,0 0;} }
.pl-price:hover{transform:translateY(-4px);border-color:rgba(255,255,255,.14);}
.pl-price-pop{border:1px solid var(--gold-line);
  background:linear-gradient(180deg, rgba(211,172,99,.08), rgba(211,172,99,.01));
  box-shadow:0 40px 90px -46px rgba(211,172,99,.5), inset 0 1px 0 rgba(255,255,255,.06);}
.pl-price-pop:hover{border-color:rgba(211,172,99,.5);transform:translateY(-4px);}

/* Target 1: Pricing composition — flagship staging.
   Passes are compact supporting players. Ultra is the distinct cinematic band:
   a spotlighted object with its own material depth and hierarchy. */
.pl-passes{display:grid;grid-template-columns:repeat(auto-fit,minmax(186px,1fr));gap:14px;align-items:stretch;}

/* Plan tabs — Individual / Team.
   A segmented control, not two links: the two groups are alternatives, and
   a segmented control is the one form that says "pick one of these" without
   a word of copy. Gold hairline, obsidian well, the active segment lifted
   on a warm gradient so it reads as the sheet in front. Deliberately small
   and centred under the heading — it introduces the price list, it does not
   compete with it. */
.pl-plantabs{
  display:inline-flex;gap:4px;padding:4px;margin:0 auto 30px;
  border:1px solid var(--gold-line);border-radius:999px;
  background:rgba(10,9,8,.6);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
}
.pl-plantab{
  appearance:none;border:0;cursor:pointer;
  padding:9px 22px;border-radius:999px;
  font-size:13px;font-weight:600;letter-spacing:.02em;
  color:var(--mut);background:transparent;
  transition:color .28s ease, background .28s ease, box-shadow .28s ease;
}
.pl-plantab:hover{color:var(--paper);}
.pl-plantab[aria-selected="true"]{
  color:#231c0c;
  background:linear-gradient(100deg,var(--gold-1),var(--gold-3));
  box-shadow:0 10px 26px -14px rgba(211,172,99,.7);
}
.pl-plantab:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}

/* Enterprise band — same cinematic staging as the Ultra band, one step
   deeper. NO violet: Ultra owns amethyst, and giving Enterprise a second
   accent colour would make the top of the ladder read as Ultra's sibling
   rather than its successor. It gets more of the same gold instead —
   a heavier border, a warmer floor, a wider glow. */
.pl-ent-band{
  margin-top:18px;
  background:linear-gradient(145deg,rgba(211,172,99,.10),rgba(10,9,8,.82));
  border:1px solid rgba(211,172,99,.34);
  border-radius:22px;
  padding:30px 34px;
  box-shadow:0 70px 160px -50px rgba(0,0,0,.95), 0 0 120px -34px var(--gold-glow), inset 0 1px 0 rgba(255,255,255,.05);
  display:grid;grid-template-columns:340px 1fr;gap:36px;align-items:start;
}
.pl-ent-band h3.pl-serif{
  font-size:28px;letter-spacing:-0.018em;
  font-variation-settings:"opsz" 30,"wght" 500,"ital" 0;}
@media (max-width:980px){
  .pl-ent-band{grid-template-columns:1fr;gap:22px;padding:24px 24px;}
}
@media (max-width:640px){
  .pl-ent-band{padding:20px 18px;border-radius:18px;}
  .pl-ent-band ul{grid-template-columns:1fr !important;}
  .pl-plantab{padding:8px 16px;font-size:12.5px;}
}
.pl-ultra-band{
  margin-top:18px;
  background:linear-gradient(145deg,rgba(211,172,99,.065),rgba(10,9,8,.75));
  border:1px solid var(--gold-line);
  border-radius:22px;
  padding:28px 32px;
  box-shadow:0 60px 140px -50px rgba(0,0,0,.92), 0 0 90px -30px var(--gold-glow), inset 0 1px 0 rgba(255,255,255,.04);
  display:grid;grid-template-columns:310px 1fr;gap:34px;align-items:start;
}
@media (max-width:980px){
  .pl-ultra-band{grid-template-columns:1fr;gap:22px;padding:22px 24px;}
}
.pl-num{font-size:64px;line-height:1;color:rgba(211,172,99,.16);font-weight:500;
  font-variation-settings:"opsz" 72,"wght" 500,"ital" 0;
  transition:color 1.2s ease .2s, text-shadow 1.2s ease .2s;}
.pl-reveal.pl-in .pl-num{color:rgba(211,172,99,.42);text-shadow:0 0 26px rgba(211,172,99,.18);}
.pl-root #kit::before{
  content:'';position:absolute;left:50%;top:0;width:min(920px,100%);height:280px;
  transform:translateX(-50%);pointer-events:none;z-index:0;
  background:radial-gradient(ellipse at 50% 0%, rgba(211,172,99,.09), transparent 68%);
}
.pl-root #kit > *{position:relative;z-index:1;}
.pl-ledger{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));column-gap:18px;row-gap:12px;}
.pl-row{display:flex;flex-direction:column;gap:8px;padding:20px 18px;border:1px solid var(--line);
  border-radius:16px;
  background:
    linear-gradient(165deg,rgba(255,255,255,.035) 0%,transparent 42%),
    linear-gradient(180deg,#110f0b 0%,#0a0907 100%);
  box-shadow:inset 0 1px 0 rgba(246,228,176,.06), 0 18px 40px -28px rgba(0,0,0,.8);
  transition:border-color .35s, transform .4s cubic-bezier(.2,.9,.3,1), box-shadow .4s;}
.pl-row:hover{border-color:var(--gold-line);transform:translateY(-2px);
  box-shadow:inset 0 1px 0 rgba(246,228,176,.1), 0 24px 50px -26px rgba(211,172,99,.22);}
.pl-chip{font-size:9.5px;font-weight:700;letter-spacing:.16em;color:var(--gold);
  border:1px solid var(--gold-line);border-radius:999px;padding:3px 8px;text-transform:uppercase;flex-shrink:0;}
.pl-faq{border-top:1px solid var(--line);}
.pl-faq:last-of-type{border-bottom:1px solid var(--line);}
.pl-faq summary{display:flex;align-items:baseline;justify-content:space-between;gap:22px;
  padding:22px 2px;cursor:pointer;list-style:none;transition:color .2s;}
.pl-faq summary::-webkit-details-marker{display:none;}
.pl-faq summary:hover .pl-plus{color:var(--gold-1);}
.pl-plus{color:var(--gold);font-size:21px;line-height:1;flex-shrink:0;
  transition:transform .35s cubic-bezier(.2,.9,.3,1), color .2s;}
.pl-faq[open] .pl-plus{transform:rotate(45deg);}
.pl-faq-a{max-width:700px;padding:0 2px 24px;color:var(--mut);font-size:15px;line-height:1.65;
  animation:pl-fadeup .45s cubic-bezier(.2,.8,.2,1);}
@keyframes pl-fadeup{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
.pl-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9;
  display:flex;align-items:flex-start;gap:14px;max-width:min(92vw,560px);
  background:linear-gradient(180deg,#14110b,#0c0a07);border:1px solid var(--gold-line);
  border-left:2px solid var(--gold);border-radius:14px;padding:13px 16px;
  box-shadow:0 24px 70px -22px rgba(0,0,0,.9), 0 0 40px -18px var(--gold-glow);
  font-size:13.5px;line-height:1.55;color:var(--paper);
  animation:pl-fadeup .45s cubic-bezier(.2,.8,.2,1);}
.pl-toast-x{background:none;border:none;cursor:pointer;color:var(--mut);font-size:17px;
  line-height:1;padding:2px 2px 0;flex-shrink:0;transition:color .2s;}
.pl-toast-x:hover{color:var(--paper);}
.pl-footnote-link{background:none;border:none;cursor:pointer;padding:0;color:var(--faint);
  font-size:12.5px;letter-spacing:.02em;text-decoration:underline;text-underline-offset:3px;
  text-decoration-color:var(--gold-line);transition:color .2s;}
.pl-footnote-link:hover{color:var(--gold);}
@media (max-width:860px){ .pl-wrap{padding:0 22px;} .pl-hide-sm{display:none !important;} .pl-lamp{display:none;} }
/* Phone polish — same cinematic landing as desktop, scaled for thumb reach,
   notched safe-areas, and one-column pricing. Keeps mobile on PremiumLanding
   instead of a parallel older surface. */
@media (max-width:767px){
  .pl-root{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);}
  .pl-navbar{padding-top:env(safe-area-inset-top);}
  .pl-navbar .pl-wrap{height:60px !important;padding-left:16px;padding-right:16px;}
  .pl-wrap{padding-left:18px;padding-right:18px;}
  .pl-hero{min-height:0;gap:28px;padding-bottom:8px;}
  .pl-hero-cta{justify-content:center;gap:16px;margin:28px 0 14px;}
  .pl-hero-cta .pl-cta{width:100%;justify-content:center;}
  .pl-passes{grid-template-columns:1fr;gap:12px;}
  .pl-ultra-band{padding:20px 18px;border-radius:18px;}
  .pl-ultra-band ul{grid-template-columns:1fr !important;}
  /*
   * GLOBE / PLATFORM STAGE — same WebGL orb as desktop.
   * Only layout/scale fixes on phones (620×420 stage + chip coords). Do NOT
   * restyle the crystal or swap to a CSS-only galaxy look.
   */
  .pl-theater{
    height: calc(420px * var(--pl-stage-scale, 0.55) + 64px);
    min-height: 240px;
    max-height: none;
    overflow: hidden;
  }
  .pl-theater-aperture{
    width: calc(260px * var(--pl-stage-scale, 0.55));
    height: calc(260px * var(--pl-stage-scale, 0.55));
    opacity: .4;
  }
  /* Motes are pure decoration; drop on phones for GPU headroom for the orb. */
  .pl-theater-mote{display:none !important;}
  .pl-theater-echo{font-size:clamp(28px,11vw,48px) !important;}
  .pl-connect-stage{
    transform: translate(-50%, -50%) scale(var(--pl-stage-scale, 0.55));
    transform-origin: center center;
  }
  .pl-orb-float{
    --orb-float-y: -5px;
    animation-duration: 5s;
  }
  /* Canvas must paint; never display:none the WebGL surface on mobile. */
  .pl-orb-canvas{
    display:block !important;
    width:100% !important;
    height:100% !important;
  }
  .pl-orb-clip{display:block !important;}

  /* Chips/traces: stay visible even if reveal choreography is late. */
  .pl-chip-node{
    width:64px; height:64px; border-radius:18px;
    opacity:1 !important;
  }
  .pl-chip-node svg{width:30px; height:30px;}
  .pl-trace{stroke-dashoffset:0 !important; opacity:.9;}
  .pl-trace-pulse{opacity:.85 !important; animation: pl-pulseflow 2.4s linear infinite !important;}

  .pl-ledger{grid-template-columns:1fr;column-gap:0;}
  .pl-toast{left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));transform:none;max-width:none;}
  #pricing{padding:56px 18px 32px !important;}
  .pl-ledger,.pl-passes,.pl-moment,.pl-step-row,.pl-step-copy{min-width:0;}
  .pl-row{min-width:0;}
  .pl-moment{gap:28px;padding:36px 0;}
  .pl-step-row{grid-template-columns:auto 1fr;gap:16px 18px;padding-bottom:22px;}
  .pl-step-copy{grid-template-columns:1fr;gap:10px;}
  .pl-num{font-size:48px;}
  #pl-top{padding-top:36px !important;padding-bottom:48px !important;}
  .pl-cta:hover{transform:none;}
  .pl-price:hover,.pl-price-pop:hover{transform:none;}
  .pl-chip-node:hover{transform:none;}
  .pl-reveal{transition-duration:.55s;}
}
/* ═══════════════════════════════════════════════════════════════════
   ANSWER THEATER — the four seconds after they ask.
   Auto-Type is the product's differentiator and it had a static three
   line snippet. This is the same moment played out: the question
   arriving, the depth being read, the covering line landing while you
   are still drawing breath, the full answer continuing without a seam,
   and — on Ultra and Enterprise — the code typing itself into the editor.
   Everything here is namespaced .pl-at-* and rides CSS/timers, never
   the React render loop; character streaming writes textContent
   directly through refs.
   ═══════════════════════════════════════════════════════════════════ */
.pl-at{position:relative;border:1px solid var(--gold-line);border-radius:18px;overflow:hidden;
  background:linear-gradient(180deg,#100e0a,#090807 62%,#070605);
  box-shadow:0 40px 90px -50px rgba(0,0,0,.9),inset 0 1px 0 rgba(246,228,176,.05);}
.pl-at::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:4;
  background:radial-gradient(120% 80% at 50% -10%,rgba(211,172,99,.09),transparent 62%);}
/* travelling rim light — the stage is lit from somewhere off-frame */
.pl-at::after{content:'';position:absolute;left:-40%;top:0;width:40%;height:100%;pointer-events:none;z-index:5;
  background:linear-gradient(100deg,transparent,rgba(246,228,176,.045),transparent);
  animation:pl-at-sheen 9s ease-in-out infinite;}
@keyframes pl-at-sheen{0%,62%{left:-45%;}100%{left:115%;}}

.pl-at-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.05);position:relative;z-index:6;}
.pl-at-step{display:inline-flex;align-items:center;gap:9px;font-size:10px;font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;color:var(--faint);transition:color .5s ease;
  white-space:nowrap;}
/* Four full labels do not fit a 354px stage — "TYPING" clipped to "TYPI".
   Carry a short form and swap it in on narrow screens rather than let the
   rail wrap or truncate. */
.pl-at-sm{display:none;}
.pl-at-step[data-on="1"]{color:var(--gold);}
.pl-at-pip{width:5px;height:5px;border-radius:50%;background:var(--faint);transition:all .5s ease;}
.pl-at-step[data-on="1"] .pl-at-pip{background:var(--gold);box-shadow:0 0 10px var(--gold-glow);}
.pl-at-body{position:relative;z-index:6;padding:18px 18px 20px;min-height:318px;}

/* ── the interviewer's line ── */
.pl-at-ask{display:flex;gap:12px;align-items:flex-start;}
.pl-at-wave{display:flex;align-items:flex-end;gap:2px;height:22px;flex-shrink:0;padding-top:2px;}
.pl-at-wave i{width:2px;border-radius:1px;background:var(--faint);opacity:.5;height:4px;
  transition:opacity .4s ease;}
.pl-at[data-beat="0"] .pl-at-wave i{opacity:1;background:var(--gold);
  animation:pl-at-bar 1s ease-in-out infinite;}
@keyframes pl-at-bar{0%,100%{height:3px;}50%{height:18px;}}
.pl-at-qtext{font-size:14.5px;line-height:1.55;color:var(--paper);opacity:.92;}

/* ── depth read ── */
.pl-at-depth{margin-top:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  opacity:0;transform:translateY(4px);transition:opacity .5s ease,transform .5s ease;}
.pl-at[data-beat="1"] .pl-at-depth,.pl-at[data-beat="2"] .pl-at-depth,
.pl-at[data-beat="3"] .pl-at-depth,.pl-at[data-beat="4"] .pl-at-depth{opacity:1;transform:none;}
.pl-at-meter{position:relative;height:3px;flex:1;min-width:120px;border-radius:2px;
  background:rgba(255,255,255,.07);overflow:hidden;}
.pl-at-meter b{position:absolute;inset:0 100% 0 0;border-radius:2px;
  background:linear-gradient(90deg,var(--gold-3),var(--gold-1));
  box-shadow:0 0 12px var(--gold-glow);transition:inset 1.1s cubic-bezier(.22,.9,.3,1);}
.pl-at[data-beat="1"] .pl-at-meter b,.pl-at[data-beat="2"] .pl-at-meter b,
.pl-at[data-beat="3"] .pl-at-meter b,.pl-at[data-beat="4"] .pl-at-meter b{inset:0 12% 0 0;}
.pl-at-model{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--gold);
  border:1px solid var(--gold-line);border-radius:999px;padding:4px 10px;white-space:nowrap;
  background:rgba(211,172,99,.05);}

/* ── the answer ── */
.pl-at-answer{margin-top:16px;position:relative;border-radius:12px;padding:14px 15px;
  background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.05);min-height:104px;
  font-size:14.5px;line-height:1.62;color:#e6e0d3;}
.pl-at-cover{color:var(--paper);}
/* the covering line gets a held gold rim the moment it lands */
.pl-at-answer[data-cover="1"]{border-color:var(--gold-line);
  box-shadow:0 0 0 1px rgba(211,172,99,.08),0 0 34px -8px var(--gold-glow);}
.pl-at-rest{color:#cdc6b8;}
.pl-at-stamp{position:absolute;top:-9px;right:12px;font-size:9px;font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;padding:3px 9px;border-radius:999px;background:#0b0a08;
  border:1px solid var(--gold-line);color:var(--gold);opacity:0;transform:translateY(3px);
  transition:opacity .45s ease,transform .45s ease;}
.pl-at-answer[data-cover="1"] .pl-at-stamp{opacity:1;transform:none;}

/* ── the editor (Auto-Type) ── */
.pl-at-ed{margin-top:16px;border-radius:12px;border:1px solid rgba(255,255,255,.06);
  background:rgba(0,0,0,.42);overflow:hidden;opacity:0;max-height:0;
  transition:opacity .55s ease,max-height .75s cubic-bezier(.22,.9,.3,1);}
.pl-at[data-beat="4"] .pl-at-ed{opacity:1;max-height:210px;}
.pl-at-edhead{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;
  border-bottom:1px solid rgba(255,255,255,.05);font-size:10px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--faint);}
.pl-at-code{display:flex;gap:12px;padding:12px 14px 14px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.62;}
.pl-at-nums{display:flex;flex-direction:column;color:var(--faint);opacity:.5;text-align:right;
  font-variant-numeric:tabular-nums;user-select:none;}
.pl-at-src{flex:1;white-space:pre-wrap;color:#d9d3c6;min-height:96px;}
.pl-at-k{color:#c7a3e8;}
.pl-at-f{color:var(--gold-1);}
.pl-at-cur{display:inline-block;width:7px;height:15px;vertical-align:-3px;margin-left:1px;
  background:var(--gold);box-shadow:0 0 10px var(--gold-glow);animation:pl-at-blink 1.05s steps(1) infinite;}
@keyframes pl-at-blink{0%,49%{opacity:1;}50%,100%{opacity:0;}}

/* ── caption strip under the stage ── */
.pl-at-cap{display:flex;gap:10px;align-items:flex-start;padding:0 18px 18px;position:relative;z-index:6;
  font-size:12.5px;line-height:1.5;color:var(--mut);min-height:38px;}
.pl-at-cap b{color:var(--gold);font-weight:600;}

/* ═══════════════════════════════════════════════════════════════════
   THE SEAM  (.pl-seam-*)  — one sentence that changes hands
   ───────────────────────────────────────────────────────────────────
   Every model worth asking takes seconds to think, and in a live
   interview that pause IS the problem. So two answers are sent: a
   covering line in about half a second that the candidate starts
   speaking immediately, and the full reasoning underneath, continuing
   the exact sentence they are already in.

   THE FIRST BUILD PUT THEM IN TWO PLATES WITH A DIVIDER BETWEEN, and
   that was wrong in the only way that mattered: two boxes say "two
   answers", and the truth is ONE answer arriving at two speeds. The
   whole promise is that the sentence is never restarted — so the two
   halves now live in ONE paragraph, in one container, and the seam is
   the point inside the running text where the colour changes hands.
   Nothing separates them, because nothing separates them.

   Violet is a HINT, not a surface. It is the voice of the covering
   line — the words, the caret, one chip — on the page's own obsidian
   and gold material. A fully violet plate made the section look like a
   different product.

   Same discipline as .pl-at-*: CSS and timers only, character streaming
   writes textContent through refs, so a ~1,600-char sequence costs zero
   React renders (only the four coarse beats re-render).
   ═══════════════════════════════════════════════════════════════════ */
/* ── The card is GLASS, and it is borderless ──────────────────────────
   No stroke anywhere on it. The edge is made of light: a bright specular
   line along the top where the material catches the room, a hairline
   ring at 5.5% white that reads as thickness rather than as a border,
   and a deep contact shadow so the card sits ABOVE the page instead of
   being drawn onto it.
   The fill is a translucent veil, not a colour — everything you see
   through it is the light field behind (.pl-seam-halo), blurred and
   saturated. That is why the halo below is two coloured blobs rather
   than one wash: frosted glass with nothing behind it is just grey. */
.pl-seam{position:relative;max-width:900px;margin:0 auto;border-radius:28px;overflow:hidden;
  border:0;
  /* Two layers, and the ORDER is the whole trick. A specular veil of
     white on top for the sheen; underneath it a DARK translucent base.
     Without that base the card is a window — everything behind pours
     through and it reads as tinted plastic. iOS dark material is mostly
     dark; the colour behind is a hint that survives the blur, not the
     subject. */
  background:
    linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.014) 52%,rgba(255,255,255,.006)),
    linear-gradient(180deg,rgba(15,13,20,.60),rgba(9,8,11,.72));
  -webkit-backdrop-filter:blur(36px) saturate(138%);
  backdrop-filter:blur(36px) saturate(138%);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.18),
    inset 0 0 0 1px rgba(255,255,255,.055),
    inset 0 -1px 0 rgba(255,255,255,.035),
    0 46px 96px -46px rgba(0,0,0,.92),
    0 0 100px -46px var(--pv-glow);}
/* Light falls from above in the house colour. It picks up the faintest
   violet only while the covering line is the one speaking — the hint,
   and the only place the container itself acknowledges the second voice. */
.pl-seam::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:4;
  border-radius:inherit;transition:background 1.2s ease;
  background:radial-gradient(125% 82% at 50% -12%,rgba(211,172,99,.085),transparent 62%);}
.pl-seam[data-beat="1"]::before,.pl-seam[data-beat="2"]::before{
  background:radial-gradient(125% 82% at 50% -12%,rgba(162,113,255,.10),transparent 60%),
             radial-gradient(125% 82% at 50% -12%,rgba(211,172,99,.05),transparent 62%);}
/* one slow sheen — the recipe allows exactly one per view */
.pl-seam::after{content:'';position:absolute;left:-42%;top:0;width:42%;height:100%;
  pointer-events:none;z-index:5;
  background:linear-gradient(100deg,transparent,rgba(246,228,176,.045),transparent);
  animation:pl-at-sheen 10s ease-in-out infinite;}

/* A hairline of LIGHT, not a rule — on glass a dark divider reads as a
   crack. Fades out at both ends so it never touches the card edge. */
.pl-seam-head{display:flex;align-items:center;justify-content:space-between;gap:14px;
  padding:14px 19px;position:relative;z-index:6;}
.pl-seam-head::after{content:'';position:absolute;left:16px;right:16px;bottom:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.10),transparent);}
.pl-seam-live{display:inline-flex;align-items:center;gap:8px;font-size:10px;font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;color:var(--faint);white-space:nowrap;}
.pl-seam-live i{width:5px;height:5px;border-radius:50%;background:var(--pv-2);
  box-shadow:0 0 10px var(--pv-glow);animation:pl-seam-pulse 2s ease-out infinite;}
@keyframes pl-seam-pulse{0%{box-shadow:0 0 0 0 rgba(162,113,255,.5);}
  70%{box-shadow:0 0 0 7px rgba(162,113,255,0);}100%{box-shadow:0 0 0 0 rgba(162,113,255,0);}}
/* Which question is on stage. Pips, not numerals — the order carries no
   meaning, so numbering it would be decoration pretending to be
   structure. */
.pl-seam-pips{display:inline-flex;gap:6px;}
.pl-seam-pips b{width:14px;height:2px;border-radius:1px;background:rgba(255,255,255,.11);
  transition:background .6s ease,box-shadow .6s ease;}
.pl-seam-pips b[data-on="1"]{background:var(--pv-2);box-shadow:0 0 8px var(--pv-glow);}

/* Fixed height, not min-height: three scenes of different lengths rotate
   through this box, and a stage that grows and shrinks under the reader
   is worse than a little slack at the bottom of the shortest one. */
.pl-seam-body{position:relative;z-index:6;padding:20px 22px 18px;height:294px;}

/* ── the question ── */
.pl-seam-ask{display:flex;gap:13px;align-items:flex-start;min-height:52px;}
.pl-seam-wave{display:flex;align-items:flex-end;gap:2px;height:22px;flex-shrink:0;padding-top:3px;}
.pl-seam-wave i{width:2px;border-radius:1px;background:var(--faint);opacity:.45;height:4px;
  transition:opacity .4s ease;}
.pl-seam[data-beat="0"] .pl-seam-wave i{opacity:1;background:var(--pv-2);
  animation:pl-at-bar 1s ease-in-out infinite;}
.pl-seam-q{font-size:15px;line-height:1.55;color:var(--paper);opacity:.93;}

/* ── ONE plate. ONE paragraph. Two voices. ────────────────────────── */
/* Borderless too — a bordered plate inside a borderless glass card
   fights it. This is a RECESS in the same material: darker fill, an
   inset shadow along the top where it drops away, and a faint light
   line along the bottom lip where it comes back up. */
.pl-seam-say{position:relative;margin-top:16px;border-radius:19px;padding:16px 18px 17px;
  background:linear-gradient(180deg,rgba(0,0,0,.30),rgba(0,0,0,.20));border:0;
  box-shadow:inset 0 1px 3px rgba(0,0,0,.45),
             inset 0 0 0 1px rgba(255,255,255,.035),
             inset 0 -1px 0 rgba(255,255,255,.05);
  transition:box-shadow .9s ease,background .9s ease;}
/* While the covering line is the only thing on screen the recess is lit
   from within by the violet — glow, not a border. */
.pl-seam[data-beat="1"] .pl-seam-say,.pl-seam[data-beat="2"] .pl-seam-say{
  background:linear-gradient(180deg,rgba(52,28,96,.30),rgba(0,0,0,.22));
  box-shadow:inset 0 1px 3px rgba(0,0,0,.4),
             inset 0 0 0 1px rgba(196,160,255,.10),
             inset 0 -1px 0 rgba(215,194,255,.07),
             0 0 46px -18px var(--pv-glow);}
/* THE HANDOVER. A single light wipes the plate left to right at the
   instant the sentence changes hands. It fires once per question and
   nothing else on the page moves like it — this is where the section
   spends its boldness. */
.pl-seam-wipe{position:absolute;inset:0;border-radius:inherit;pointer-events:none;overflow:hidden;}
.pl-seam-wipe::after{content:'';position:absolute;top:0;bottom:0;left:-38%;width:38%;opacity:0;
  background:linear-gradient(100deg,transparent,rgba(215,194,255,.16),rgba(246,228,176,.16),transparent);}
.pl-seam[data-beat="2"] .pl-seam-wipe::after{animation:pl-seam-wipe 1.1s cubic-bezier(.4,0,.2,1) forwards;}
@keyframes pl-seam-wipe{0%{left:-38%;opacity:0;}10%{opacity:1;}90%{opacity:1;}100%{left:112%;opacity:0;}}

/* Borderless pill, lifted off the recess by its own glass fill. */
.pl-seam-stamp{position:absolute;top:-10px;left:17px;display:inline-flex;align-items:center;gap:7px;
  font-size:8.5px;font-weight:700;letter-spacing:.17em;text-transform:uppercase;
  padding:4px 11px;border-radius:999px;line-height:1.2;white-space:nowrap;border:0;
  background:linear-gradient(180deg,rgba(133,92,214,.55),rgba(70,44,128,.5));
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 4px 14px -6px rgba(0,0,0,.8);
  color:#efe6ff;
  opacity:0;transform:translateY(3px);transition:opacity .45s ease,transform .45s ease;}
.pl-seam[data-beat="1"] .pl-seam-stamp,.pl-seam[data-beat="2"] .pl-seam-stamp,
.pl-seam[data-beat="3"] .pl-seam-stamp{opacity:1;transform:none;}

/* The running text. One block, two colours — the ONLY thing that marks
   the seam is that the voice changes mid-sentence, which is exactly what
   happens. */
/* Holds the height of the settled answer from the first frame. Without
   it the plate is a thin empty pill at beat 0, the box below it is a
   void, and the caption floats a hundred pixels adrift — and this
   section sits near the top of the page, so that frame gets seen. */
.pl-seam-said{font-size:15px;line-height:1.68;letter-spacing:.002em;min-height:101px;}
.pl-seam-c{color:#c9b0f6;}
.pl-seam-f{color:#d6cfc1;}
/* the stitch — a hairline tick sitting in the text flow at the join */
.pl-seam-stitch{display:none;width:2px;height:1em;margin:0 7px -2px;border-radius:2px;
  vertical-align:-2px;
  background:linear-gradient(180deg,var(--pv-1),var(--gold-1));
  box-shadow:0 0 12px var(--pv-glow);}
.pl-seam[data-beat="2"] .pl-seam-stitch,.pl-seam[data-beat="3"] .pl-seam-stitch{
  display:inline-block;animation:pl-seam-tick .5s ease-out;}
@keyframes pl-seam-tick{0%{transform:scaleY(0);opacity:0;}60%{transform:scaleY(1.35);opacity:1;}
  100%{transform:scaleY(1);opacity:1;}}
/* The caret is the tension: it sits at the end of what you have said and
   blinks while the reasoning is still coming. */
.pl-seam-caret{display:none;width:8px;height:17px;vertical-align:-3px;margin-left:2px;
  background:var(--pv-2);box-shadow:0 0 14px var(--pv-glow);
  animation:pl-at-blink 1.05s steps(1) infinite;}
.pl-seam[data-beat="1"] .pl-seam-caret,.pl-seam[data-beat="2"] .pl-seam-caret{display:inline-block;}

/* ── the clock, on its own line under the plate ── */
.pl-seam-meta{display:flex;align-items:center;gap:10px;margin-top:11px;flex-wrap:wrap;
  font-size:10px;font-weight:700;letter-spacing:.17em;text-transform:uppercase;color:var(--faint);
  opacity:0;transition:opacity .5s ease;}
.pl-seam[data-beat="1"] .pl-seam-meta,.pl-seam[data-beat="2"] .pl-seam-meta,
.pl-seam[data-beat="3"] .pl-seam-meta{opacity:1;}
.pl-seam-clock{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px;
  letter-spacing:0;text-transform:none;color:var(--gold-1);}
.pl-seam[data-beat="1"] .pl-seam-clock,.pl-seam[data-beat="2"] .pl-seam-clock{
  color:var(--pv-1);text-shadow:0 0 16px var(--pv-glow);}
.pl-seam-bar{position:relative;flex:1;min-width:90px;height:2px;border-radius:2px;
  background:rgba(255,255,255,.06);overflow:hidden;}
.pl-seam-bar b{position:absolute;inset:0 100% 0 0;border-radius:2px;
  background:linear-gradient(90deg,var(--pv-3),var(--pv-1));
  transition:inset 1.2s linear,background .8s ease;}
.pl-seam[data-beat="1"] .pl-seam-bar b,.pl-seam[data-beat="2"] .pl-seam-bar b{inset:0 22% 0 0;}
.pl-seam[data-beat="3"] .pl-seam-bar b{inset:0 0 0 0;
  background:linear-gradient(90deg,var(--pv-3),var(--gold-2));}

/* ── the line under the stage that says what just happened ── */
.pl-seam-cap{display:flex;gap:10px;align-items:flex-start;padding:0 22px 18px;
  position:relative;z-index:6;font-size:12.5px;line-height:1.5;color:var(--mut);min-height:36px;}
.pl-seam-cap b{font-weight:600;}
.pl-seam-cap[data-tone="pv"] b{color:var(--pv);}
.pl-seam-cap[data-tone="gold"] b{color:var(--gold);}

/* ── the legend: what the two colours ARE ─────────────────────────────
   The stage shows the mechanism; this names it. Without it a first-time
   visitor sees two colours of text and has to guess why. */
.pl-seam-legend{max-width:900px;margin:18px auto 0;display:flex;gap:26px;flex-wrap:wrap;
  align-items:flex-start;justify-content:center;padding:0 4px;}
.pl-seam-leg{display:flex;gap:11px;align-items:flex-start;max-width:400px;text-align:left;}
.pl-seam-swatch{flex-shrink:0;width:11px;height:11px;border-radius:3px;margin-top:4px;}
.pl-seam-leg[data-v="pv"] .pl-seam-swatch{background:linear-gradient(140deg,var(--pv-1),var(--pv-3));
  box-shadow:0 0 14px var(--pv-glow);}
.pl-seam-leg[data-v="gold"] .pl-seam-swatch{background:linear-gradient(140deg,var(--gold-1),var(--gold-3));
  box-shadow:0 0 14px var(--gold-glow);}
.pl-seam-leg strong{display:block;font-size:11px;font-weight:700;letter-spacing:.15em;
  text-transform:uppercase;margin-bottom:5px;}
.pl-seam-leg[data-v="pv"] strong{color:var(--pv-1);}
.pl-seam-leg[data-v="gold"] strong{color:var(--gold-1);}
.pl-seam-leg span{font-size:13px;line-height:1.55;color:var(--mut);}

/* ── the ambient pool the section sits in ── */
/* ── The light field the glass refracts ──────────────────────────────
   Frosted glass over a flat black page is just a grey rectangle. This
   is what makes the material read: two coloured pools sitting BEHIND
   the card — violet under the half where the covering line appears,
   warm gold under the half where the reasoning lands — so the blur has
   a gradient to pull through and the card picks up colour it never
   paints itself. Wider and taller than the card on purpose, so the
   colour runs off its edges rather than stopping at them. */
.pl-seam-halo{position:absolute;left:50%;top:34%;transform:translateX(-50%);
  width:min(1080px,104%);height:560px;pointer-events:none;z-index:0;
  background:
    radial-gradient(40% 54% at 26% 34%,rgba(162,113,255,.30),transparent 70%),
    radial-gradient(44% 58% at 80% 68%,rgba(219,183,110,.13),transparent 72%),
    radial-gradient(58% 62% at 50% 50%,rgba(120,80,220,.07),transparent 74%);
  filter:blur(34px);}

@media (max-width:760px){
  /* height, not min-height — the base rule sets a fixed height, which a
     min-height cannot override, so the old value did nothing and the
     longest scene ran 51px past the bottom of the stage on every phone.
     Measured with probe-seam-fit.mjs; re-run it if the copy changes. */
  .pl-seam-body{height:422px;padding:16px 15px 16px;}
  .pl-seam-q{font-size:13.5px;}
  .pl-seam-said{font-size:13.8px;line-height:1.62;min-height:179px;}
  .pl-seam-say{padding:14px 14px 15px;}
  .pl-seam-head{padding:11px 13px;}
  .pl-seam-live{font-size:8.5px;letter-spacing:.12em;}
  .pl-seam-cap{font-size:12px;padding:0 15px 15px;}
  .pl-seam-legend{gap:15px;margin-top:15px;}
  .pl-seam-leg{max-width:none;}
}


/* ── Hero card, brought up to the Answer Theater's material class ──
   The hero already had the expensive parts — rim beam, silk stream,
   pointer-tracked sheen, corner brackets. What it lacked was the thing
   that makes the theater card read as premium: the ANSWER given its own
   recessed, gold-rimmed plate with a floating stamp, so the reply looks
   like an object placed on the card rather than text sitting on it. */
.pl-hero-answer{position:relative;margin-top:6px;border-radius:13px;padding:15px 16px 16px;
  background:rgba(0,0,0,.30);border:1px solid var(--gold-line);
  box-shadow:0 0 0 1px rgba(211,172,99,.06),0 0 38px -10px var(--gold-glow),
             inset 0 1px 0 rgba(246,228,176,.05);}
.pl-hero-answer::after{content:'';position:absolute;left:-30%;top:0;width:30%;height:100%;
  pointer-events:none;border-radius:13px;
  background:linear-gradient(100deg,transparent,rgba(246,228,176,.05),transparent);
  animation:pl-at-sheen 11s ease-in-out infinite;animation-delay:-3s;}
.pl-hero-stamp{position:absolute;top:-9px;right:13px;font-size:8.5px;font-weight:700;
  letter-spacing:.17em;text-transform:uppercase;padding:3px 9px;border-radius:999px;
  background:#0b0a08;border:1px solid var(--gold-line);color:var(--gold);
  white-space:nowrap;line-height:1.2;}
@media (max-width:760px){
  .pl-hero-answer{padding:13px 13px 14px;}
  .pl-hero-stamp{right:10px;font-size:8px;}
}
@media (prefers-reduced-motion:reduce){ .pl-hero-answer::after{display:none;} }

/* The mark's own moment above the final ask. A pool of light beneath it so
   it reads as an object resting on the page, not a sticker on top of it. */
.pl-markbeat{position:relative;display:flex;justify-content:center;margin-bottom:30px;}
.pl-markbeat::before{content:'';position:absolute;left:50%;top:52%;transform:translate(-50%,-50%);
  width:230px;height:130px;pointer-events:none;
  background:radial-gradient(closest-side,var(--gold-glow),transparent 72%);
  opacity:.55;filter:blur(6px);}
@media (max-width:760px){ .pl-markbeat{margin-bottom:24px;} .pl-markbeat::before{width:170px;height:100px;} }
/* The stage is decorative (aria-hidden); this carries the same meaning
   for screen readers and crawlers without showing twice. */
.pl-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WHAT WE SAY ABOUT MONEY — three beats around the price

   These are the only places on the page where the product argues
   against its own sale, so they are staged as one three-act passage
   wrapped around the pricing table rather than collected into a wall
   of testimonial cards:

     THE VOW        before the first number   - what the money is for
     THE ASIDE      among the numbers          - permission to leave
     THE UNDERWRITING  after the numbers       - what happens if we fail

   Each gets ONE gesture, and no two are the same KIND of gesture -
   not merely a different duration or direction:
     vow    light travelling through the letterforms, handed from one
            line to the next and never returning
     aside  optical development, triggered by STILLNESS rather than
            by scroll or hover - the only thing here that is
     back    displacement returning, and the only rule on the page
            that draws right-to-left
   All three stay inside the house metaphor (a lit thing in a dark
   theater) and all three are transform/opacity/background-position, so
   nothing here touches layout while it moves.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/* ⚠️ PERFORMANCE BUDGET FOR THIS WHOLE PASSAGE - it was learned the
   expensive way. The first build of these four used will-change on a
   blurred element, mix-blend-mode:screen, and two persistent filter:
   blur() layers. Every one of those promotes a compositing layer that
   the browser then maintains on EVERY frame, everywhere on the page,
   regardless of where you have scrolled to - so a set of effects that
   only appear near the price made the whole page feel loose under the
   scroll wheel. Nothing here uses will-change, blend modes or filters.
   Softness is baked into gradient STOPS, which costs nothing, and every
   animation is transform / opacity / background-position. */

/* ── 1. THE VOW - centred, and the only full-bleed line on the page ──
   The thesis of the commercial relationship, so it gets the whole
   width and the whole silence. A beam crosses it once, top to bottom,
   and the two lines trade places in the light: the sentence about
   money surrenders its brightness at the exact moment the sentence
   about the job takes it. Lit through the GLYPHS, not behind them, so
   it reads as light on letterpress rather than a highlighter over a
   box. */
.pl-vow{position:relative;overflow:hidden;}
.pl-vow-inner{max-width:1140px;margin:0 auto;padding:0 34px;position:relative;z-index:2;}
/* The beam. Softened by having many gradient stops rather than by a
   blur filter - visually the same band, none of the layer cost. */
.pl-vow-beam{position:absolute;left:50%;top:0;z-index:1;
  width:min(940px,96%);height:42%;
  transform:translate(-50%,-80%);opacity:0;pointer-events:none;
  background:linear-gradient(180deg,
    transparent 0%,rgba(246,228,176,.015) 16%,rgba(246,228,176,.05) 30%,
    rgba(246,228,176,.10) 42%,rgba(246,228,176,.13) 50%,rgba(246,228,176,.10) 58%,
    rgba(246,228,176,.05) 70%,rgba(246,228,176,.015) 84%,transparent 100%);}
.pl-vow.pl-in .pl-vow-beam{animation:pl-vow-beam 2.7s cubic-bezier(.36,.08,.24,1) .16s forwards;}
@keyframes pl-vow-beam{
  0%{transform:translate(-50%,-80%);opacity:0;}
  14%{opacity:1;}
  74%{opacity:1;}
  100%{transform:translate(-50%,190%);opacity:0;}}
.pl-vow-line{display:block;font-weight:500;line-height:1.03;
  letter-spacing:-0.032em;font-size:clamp(29px,5.6vw,74px);
  font-variation-settings:"opsz" 72,"wght" 500,"ital" 0;}
/* The second line keeps the light. The first stays legible on purpose -
   the pair is the message, and a first line dimmed to decoration would
   throw half of it away. */
@supports ((-webkit-background-clip:text) or (background-clip:text)){
  .pl-vow-a,.pl-vow-b{-webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;color:transparent;background-repeat:no-repeat;
    background-size:100% 360%;background-position:0% 0%;}
  .pl-vow-a{background-image:linear-gradient(180deg,var(--paper) 0%,var(--paper) 22%,
    var(--mut) 54%,var(--mut) 100%);}
  .pl-vow-b{background-image:linear-gradient(180deg,#4b463d 0%,#4b463d 32%,
    var(--gold-1) 58%,var(--gold-2) 80%,var(--gold-2) 100%);}
  .pl-vow.pl-in .pl-vow-a{animation:pl-vow-pass 1.5s cubic-bezier(.42,0,.3,1) .30s forwards;}
  .pl-vow.pl-in .pl-vow-b{animation:pl-vow-pass 1.5s cubic-bezier(.42,0,.3,1) .80s forwards;}
}
@keyframes pl-vow-pass{to{background-position:0% 100%;}}

/* ── 2. THE ASIDE - LEFT, and set as a margin note ──────────────────
   The one line that tells a reader to go somewhere cheaper. It is not
   a headline and must not be staged as one: it is an annotation in the
   margin of the price list, so it is small, left-aligned, hung off a
   vertical rule, and deliberately off the centre axis everything else
   on this page sits on.
   Its gesture is the rule drawing DOWNWARD, like a pen stroke made
   beside a paragraph - the only vertical draw on the page - with the
   two lines arriving after it in sequence. */
/* Narrow on purpose. A margin note is a narrow column of two or three
   short lines; at 520px this ran to one long line plus the orphan "can." */
.pl-note{position:relative;padding-left:26px;max-width:430px;}
.pl-note-rule{position:absolute;left:0;top:2px;bottom:2px;width:2px;border-radius:2px;
  background:linear-gradient(180deg,var(--gold-2),rgba(211,172,99,.18));
  transform:scaleY(0);transform-origin:50% 0;
  transition:transform 1.05s cubic-bezier(.3,.8,.25,1);}
.pl-reveal.pl-in .pl-note-rule{transform:scaleY(1);}
.pl-note-l{display:block;opacity:0;transform:translateY(9px);
  transition:opacity .8s cubic-bezier(.2,.8,.2,1),transform .8s cubic-bezier(.2,.8,.2,1);}
/* ⚠️ Sequenced with the adjacent-sibling combinator, NOT :nth-of-type.
   nth-of-type counts by ELEMENT TYPE, and the rule above these lines is
   also a span — so it occupies type-position 1, :nth-of-type(1) matched
   nothing, and the SECOND line never received a reveal rule at all. It
   sat at opacity 0 and the note silently shipped as half a sentence. */
.pl-reveal.pl-in .pl-note-l{transition-delay:.42s;opacity:1;transform:none;}
.pl-reveal.pl-in .pl-note-l + .pl-note-l{transition-delay:.66s;}

/* ── 3. THE RECKONING - RIGHT-aligned, and it arrives from the right ─
   What the money actually buys. Right-aligned so it mirrors the margin
   note rather than repeating it, and its lines enter from the right
   edge in sequence - travelling the way the eye will read them back.
   No other block on this page is set right. */
.pl-reck{text-align:right;margin-left:auto;max-width:760px;}
.pl-reck-l{display:block;opacity:0;transform:translateX(38px);
  transition:opacity .9s cubic-bezier(.2,.8,.2,1),transform 1.1s cubic-bezier(.16,.86,.26,1);}
/* Adjacent-sibling, for the same reason as the note above. */
.pl-reveal.pl-in .pl-reck-l{transition-delay:.10s;opacity:1;transform:none;}
.pl-reveal.pl-in .pl-reck-l + .pl-reck-l{transition-delay:.34s;}
.pl-reck-rule{height:1px;margin-left:auto;transform:scaleX(0);transform-origin:100% 50%;
  background:linear-gradient(90deg,transparent,var(--gold-2));
  transition:transform 1.2s cubic-bezier(.2,.75,.2,1) .60s;}
.pl-reveal.pl-in .pl-reck-rule{transform:scaleX(1);}

/* ── 4. THE UNDERWRITING - a SPLIT, because an agreement has two sides
   The promise on the left at full size, the conditions on the right at
   footnote size. Showing both halves in one composition is the honest
   form for a guarantee, and it is the only two-column block in this
   passage.
   The gesture: a refund is the transaction running backwards, so the
   final clause is displaced and absent, then travels back into its own
   place and settles (the bezier overshoots slightly past 1 - it lands
   rather than stops). The conditions fade in after it, because that is
   the order you learn them in. */
.pl-uw{display:grid;grid-template-columns:1.35fr .85fr;gap:46px;align-items:start;}
.pl-return-back{display:inline-block;opacity:0;transform:translateX(34px);
  transition:opacity .85s cubic-bezier(.2,.8,.25,1) .42s,
             transform 1.3s cubic-bezier(.14,.9,.24,1.04) .42s;}
.pl-reveal.pl-in .pl-return-back{opacity:1;transform:none;}
.pl-uw-terms{opacity:0;transform:translateY(10px);
  transition:opacity .9s ease 1.05s,transform .9s cubic-bezier(.2,.8,.2,1) 1.05s;}
.pl-reveal.pl-in .pl-uw-terms{opacity:1;transform:none;}
@media (max-width:860px){
  .pl-uw{grid-template-columns:1fr;gap:26px;}
}

@media (max-width:760px){
  .pl-at-body{min-height:352px;padding:15px 14px 16px;}
  .pl-at-qtext,.pl-at-answer{font-size:13.5px;}
  .pl-at-code{font-size:11.5px;}
  .pl-at-head{padding:11px 12px;}
  .pl-at-step{font-size:8.5px;letter-spacing:.11em;gap:6px;}
  .pl-at-lg{display:none;}
  .pl-at-sm{display:inline;}
  /* The beam is sized to the block, so on a narrow column it becomes a
     bar rather than light - widen it past the edges to keep it a beam. */
  .pl-vow-beam{width:150%;height:34%;}
  /* Displacement scaled to the measure: 34-38px of travel against a
     320px line reads as the clause being thrown, not returned. */
  .pl-return-back{transform:translateX(18px);}
  .pl-reck-l{transform:translateX(22px);}
  /* A margin note needs a margin. At 390px there is none, so it keeps
     the rule but loses the indent it cannot afford. */
  .pl-note{padding-left:18px;}
}

@media (prefers-reduced-motion:reduce){
  .pl-root *{animation:none !important;}
  .pl-reveal{opacity:1 !important;transform:none !important;}
  .pl-at::after{display:none !important;}
  /* Seam: render the finished frame and hold. Both answers present, the
     join already made — the meaning survives without the motion. */
  .pl-seam::after{display:none !important;}
  .pl-seam-stamp,.pl-seam-meta{opacity:1 !important;transform:none !important;}
  .pl-seam-stitch{display:inline-block !important;animation:none !important;}
  .pl-seam-caret{display:none !important;}
  .pl-seam-wipe::after{display:none !important;}
  .pl-seam-bar b{inset:0 0 0 0 !important;transition:none !important;}
  .pl-at-ed{opacity:1 !important;max-height:210px !important;}
  .pl-at-depth{opacity:1 !important;transform:none !important;}
  .pl-at-meter b{inset:0 12% 0 0 !important;transition:none !important;}
  .pl-drawline{transform:none !important;}
  .pl-foil{background-position:0 0 !important;}
  .pl-lamp,.pl-mote{display:none !important;}
  .pl-trace{stroke-dashoffset:0 !important;}
  /* The money passage: render the settled frame of all four. The
     meaning is in WHERE things end up, which survives without the
     travel - first line quiet, second line gold, notes in place, rules
     drawn, clause returned. */
  .pl-vow-beam{display:none !important;}
  .pl-vow-a,.pl-vow-b{background-position:0% 100% !important;}
  .pl-note-rule{transform:scaleY(1) !important;}
  .pl-note-l,.pl-reck-l,.pl-uw-terms{opacity:1 !important;transform:none !important;}
  .pl-reck-rule{transform:scaleX(1) !important;}
  .pl-return-back{opacity:1 !important;transform:none !important;}
  .pl-card-float,.pl-card-rimbeam,.pl-card-aura,.pl-card-floor::after{animation:none !important;}
  .pl-reflectwrap{opacity:1 !important;transform:none !important;filter:none !important;}
}

/* ═══════════════════════════════════════════════════════════════════
   TARGET 2 — Full-bleed cinematic theater intermission
   A deliberate breath between the big claims and the quiet details.
   "Light in a dark theater" taken to its purest form: slow projector
   beams, living dust, a traveling slit of light, and a breathing
   aperture at center. The light occasionally "finds" something.
   All motion is expensive, slow, and quiet. 10-trillion-company
   restraint and poetry.
   ═══════════════════════════════════════════════════════════════════ */
.pl-theater{
  position:relative;
  height:420px;
  background:#030302;
  overflow:hidden;
  border-top:1px solid var(--line);
  border-bottom:1px solid var(--line);
}
.pl-theater-inner{
  position:absolute;inset:0;
  background:
    radial-gradient(120% 70% at 18% 38%, rgba(246,228,176,.065), transparent 58%),
    radial-gradient(90% 80% at 78% 52%, rgba(211,172,99,.055), transparent 62%),
    radial-gradient(140% 55% at 52% 72%, rgba(217,184,116,.035), transparent 68%);
  animation:pl-theaterbreathe 22s ease-in-out infinite;
}
@keyframes pl-theaterbreathe{
  0%,100%{transform:translate3d(0,0,0) scale(1);}
  50%{transform:translate3d(0,1px,0) scale(1.006);}
}
.pl-theater-slit{
  position:absolute;top:0;bottom:0;width:3px;
  background:linear-gradient(180deg,transparent,rgba(246,228,176,.75) 8%,#f6e4b0 46%,rgba(246,228,176,.75) 90%,transparent);
  box-shadow:0 0 52px rgba(211,172,99,.65), 0 0 110px rgba(211,172,99,.28);
  animation:pl-slittravel 24s cubic-bezier(.22,.6,.22,1) infinite;
  mix-blend-mode:screen;
}
@keyframes pl-slittravel{
  0%{left:-3%;} 47%{left:97%;} 53%{left:97%;} 100%{left:-3%;}
}
.pl-theater-aperture{
  position:absolute;left:50%;top:50%;width:320px;height:320px;
  transform:translate(-50%,-50%);
  border:1px solid rgba(211,172,99,.16);
  border-radius:999px;
  box-shadow:0 0 0 1px rgba(211,172,99,.07) inset, 0 0 70px rgba(211,172,99,.12);
  animation:pl-aperturebreathe 15s ease-in-out infinite;
}
.pl-theater-aperture::before,
.pl-theater-aperture::after{
  content:'';position:absolute;inset:-16%;border:1px solid rgba(211,172,99,.09);border-radius:999px;
}
.pl-theater-aperture::after{inset:-30%;border-color:rgba(211,172,99,.05);}
@keyframes pl-aperturebreathe{
  0%,100%{transform:translate(-50%,-50%) scale(1); opacity:.75;}
  50%{transform:translate(-50%,-50%) scale(1.18); opacity:1;}
}
.pl-theater-mote{
  position:absolute;border-radius:50%;background:var(--gold-1);
  opacity:0;filter:blur(.3px);
  animation:pl-theaterdrift 19s linear infinite;
  box-shadow:0 0 5px var(--gold-glow);
}
@keyframes pl-theaterdrift{
  0%{transform:translate3d(0,38px,0);opacity:0;}
  7%{opacity:var(--o,.22);}
  78%{opacity:calc(var(--o,.22)*.55);}
  100%{transform:translate3d(var(--dx,0),-195px,0);opacity:0;}
}
.pl-theater-gate{
  position:absolute;left:5%;right:5%;top:16%;bottom:16%;
  border:1px solid rgba(211,172,99,.09);
  pointer-events:none;
}
.pl-theater-gate::before,
.pl-theater-gate::after{
  content:'';position:absolute;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--gold-line),transparent);
  opacity:.48;
}
.pl-theater-gate::before{top:0;}
.pl-theater-gate::after{bottom:0;}

/* ── Target 3: Load choreography (first ~1.5s)
   Stage lights up → card lands with premium settle → copy reveals →
   then headline typing begins. Pure transform/opacity + both fill.
   Orchestrated, expensive, no independent fades. */
@keyframes pl-lightup{
  from{opacity:0;transform:translateY(8px) scale(0.985);}
  to{opacity:1;transform:none;}
}
@keyframes pl-cardland{
  0%{opacity:0;transform:translateY(42px) scale(0.92);filter:blur(6px);}
  50%{transform:translateY(-6px) scale(1.012);filter:blur(0);}
  72%{transform:translateY(2px) scale(0.997);}
  100%{opacity:1;transform:none;filter:none;}
}
@keyframes pl-loadup{
  from{opacity:0;transform:translateY(16px);}
  to{opacity:1;transform:none;}
}
.pl-stagelight{animation:pl-lightup 620ms 120ms cubic-bezier(.2,.7,.1,1) both;}
.pl-beam{animation:pl-lightup 720ms 260ms cubic-bezier(.2,.7,.1,1) both;}
.pl-card-aura{animation:pl-aura-in 700ms 380ms cubic-bezier(.2,.7,.1,1) both, pl-aurabreathe 7.2s 1.4s ease-in-out infinite;}
@keyframes pl-aura-in{from{opacity:0;}to{opacity:.78;}}
.pl-hero-copy .pl-eyebrow{animation:pl-loadup 480ms 920ms cubic-bezier(.2,.8,.2,1) both;}
.pl-hero-sub{animation:pl-loadup 520ms 1080ms cubic-bezier(.2,.8,.2,1) both;}
.pl-hero-cta{animation:pl-loadup 520ms 1180ms cubic-bezier(.2,.8,.2,1) both;}
.pl-hero-copy p:last-of-type{animation:pl-loadup 420ms 1280ms cubic-bezier(.2,.8,.2,1) both;}

/* How-it-works vignettes — tiny live scenes in the capture-test language,
   one per step. Own keyframes (pl-stepeq): reusing pl-eq here would
   redefine the hero waveform's amplitude (last definition wins). */
.pl-step-vignette{
  width:128px;height:78px;border-radius:8px;overflow:hidden;
  background:linear-gradient(180deg,#0e0d0b,#090807);
  border:1px solid var(--line);position:relative;font-size:7px;
  box-shadow:0 8px 20px -10px rgba(0,0,0,.7);
}
.pl-step-chrome{display:flex;align-items:center;gap:3px;padding:3px 5px;border-bottom:1px solid var(--line);}
.pl-step-dot{width:3px;height:3px;border-radius:50%;background:rgba(255,255,255,.2);}
.pl-step-addr{flex:1;color:var(--faint);font-size:5.5px;opacity:.6;}
.pl-step-content{padding:4px 5px;}
.pl-step-skl{height:3px;border-radius:2px;background:rgba(255,255,255,.12);margin-bottom:2px;}
.pl-step-wave{display:flex;gap:1.5px;height:9px;align-items:flex-end;}
.pl-step-wave i{width:1.5px;background:linear-gradient(to top,var(--gold-3),var(--gold-1));border-radius:999px;animation:pl-stepeq 900ms ease-in-out infinite;}
@keyframes pl-stepeq{0%,100%{height:2px;}50%{height:9px;}}
.pl-step-mini{
  position:absolute;bottom:4px;right:4px;width:58px;background:linear-gradient(180deg,#141109,#0c0a07);
  border:1px solid var(--gold-line);border-radius:4px;padding:3px 4px;font-size:5.5px;line-height:1.2;
}
.pl-step-caret{display:inline-block;width:1px;height:5px;background:var(--gold);margin-left:1px;animation:pl-blink 1s steps(2) infinite;}
.pl-step-live{width:3px;height:3px;border-radius:50%;background:var(--gold);box-shadow:0 0 3px var(--gold-glow);animation:pl-pulse 1.6s infinite;}

/* ═══════════════════════════════════════════════════════════════════
   POP-OUT SHOWCASE — real premium glass (no purple cast, no neon rim).

   STRUCTURE (matches Electron pop-out):
     floating HEAD + clear frosted middle + floating FOOT shell.

   MATERIAL — real glass, not sci-fi crystal:
     • warm neutral fill only (obsidian + champagne gold)
     • soft frosted backdrop-blur (true glass depth)
     • single quiet hairline edge — NO multi-ring bright border
     • soft top light-catch + gentle specular, not a glowing outline
     • no violet / purple / blue color anywhere in this block
   Decorative only.
   ═══════════════════════════════════════════════════════════════════ */
.pl-popout-stage{
  position:relative;display:flex;align-items:center;justify-content:center;
  min-height:460px;border-radius:22px;overflow:hidden;
  border:1px solid rgba(255,255,255,.05);
  /* warm dark stage — gold only, zero purple */
  background:
    radial-gradient(80% 70% at 50% 40%, rgba(211,172,99,.08), transparent 60%),
    radial-gradient(70% 60% at 22% 18%, rgba(255,255,255,.035), transparent 50%),
    radial-gradient(ellipse 70% 35% at 50% 100%, rgba(211,172,99,.05), transparent 55%),
    linear-gradient(165deg,#121210 0%,#0c0c0b 52%,#080807 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.035), inset 0 -36px 70px -36px rgba(0,0,0,.55);
}
/* Meeting windows — warm neutral glass plates (not purple UI frames) */
.pl-popout-ghost{position:absolute;border-radius:14px;pointer-events:none;
  border:1px solid rgba(255,255,255,.08);
  background:
    linear-gradient(180deg, rgba(255,255,255,.09) 0 28px, transparent 28px),
    repeating-linear-gradient(180deg, rgba(255,255,255,.055) 0 2px, transparent 2px 22px),
    linear-gradient(165deg, rgba(36,32,24,.50), rgba(16,14,12,.32));
  background-position:0 0, 18px 40px, 0 0;
  background-size:100% 100%, calc(100% - 36px) calc(100% - 52px), 100% 100%;
  background-repeat:no-repeat;
  box-shadow:0 22px 50px -26px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);}
.pl-popout-tag{position:absolute;font-size:10px;letter-spacing:.16em;text-transform:uppercase;
  color:rgba(214,178,108,.36);font-weight:600;pointer-events:none;text-shadow:0 1px 8px rgba(0,0,0,.5);}

/* Soft warm ambient behind the window — champagne only */
.pl-pip-atmo{
  position:absolute;left:50%;top:46%;width:560px;height:480px;
  transform:translate(-50%,-50%);pointer-events:none;z-index:1;
  background:
    radial-gradient(closest-side, rgba(211,172,99,.12) 0%, rgba(180,150,90,.05) 42%, transparent 72%),
    radial-gradient(circle at 36% 28%, rgba(255,248,230,.06) 0%, transparent 45%);
  filter:blur(8px);
  animation:pl-pip-atmo-breathe 9s ease-in-out infinite;
}
@keyframes pl-pip-atmo-breathe{
  0%,100%{opacity:.55;transform:translate(-50%,-50%) scale(1);}
  50%{opacity:.85;transform:translate(-50%,-50%) scale(1.04);}
}
/* Soft floor reflection under glass (warm, not colored) */
.pl-pip-caustic{
  position:absolute;left:50%;bottom:2.5%;width:52%;height:10%;
  transform:translateX(-50%);pointer-events:none;z-index:1;
  background:radial-gradient(ellipse at 50% 30%,
    rgba(246,228,176,.22) 0%,
    rgba(211,172,99,.10) 40%,
    transparent 72%);
  filter:blur(12px);
  animation:pl-caustic-breathe 7.5s ease-in-out infinite;
}
/* Soft warm light behind glass so frost has something to smear —
   white + champagne only (no purple / blue) */
.pl-pip-backlight{
  position:absolute;left:50%;top:46%;width:270px;height:290px;
  transform:translate(-50%,-50%);pointer-events:none;z-index:1;
  background:
    linear-gradient(130deg, rgba(255,255,255,.14) 0%, transparent 50%),
    linear-gradient(310deg, rgba(211,172,99,.28) 0%, rgba(180,140,80,.10) 40%, transparent 62%),
    radial-gradient(circle at 30% 24%, rgba(255,250,235,.18), transparent 40%);
  border-radius:28px;
  filter:blur(18px);
}

/* Outer shell — quiet, almost invisible (no bright rim glow) */
.pl-pip-shell{
  position:absolute;inset:-8px;border-radius:24px;pointer-events:none;z-index:1;
  background:radial-gradient(ellipse 80% 70% at 50% 40%, transparent 55%, rgba(255,255,255,.03) 100%);
  opacity:.5;
}

/* Floating window chassis */
.pl-pip{
  position:relative;z-index:2;width:min(348px,88vw);
  display:flex;flex-direction:column;gap:0;
  border-radius:20px;
  background:transparent;
  /* soft real-world cast only — no gold/purple halo around the edge */
  filter:drop-shadow(0 40px 56px rgba(0,0,0,.70)) drop-shadow(0 12px 24px rgba(0,0,0,.40));
  animation:pl-pip-bob 8s ease-in-out infinite;
}
@keyframes pl-pip-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}

/* Real frosted glass face — premium, quiet edge, no neon border */
.pl-pip-face{
  position:relative;border-radius:20px;overflow:hidden;
  display:flex;flex-direction:column;
  background:
    linear-gradient(165deg, rgba(255,255,255,.08) 0%, rgba(28,24,18,.16) 28%, rgba(12,11,9,.14) 70%, rgba(10,9,8,.18) 100%);
  backdrop-filter:blur(28px) saturate(1.35);
  -webkit-backdrop-filter:blur(28px) saturate(1.35);
  box-shadow:
    /* depth only — no multi-ring bright outline */
    0 40px 80px -28px rgba(0,0,0,.88),
    0 14px 32px -12px rgba(0,0,0,.50),
    /* single soft hairline (real glass edge) */
    0 0 0 1px rgba(255,255,255,.10),
    /* soft top light-catch inside the pane */
    inset 0 1px 0 rgba(255,255,255,.18),
    inset 0 -18px 36px -20px rgba(0,0,0,.28);
}
/* Kill the old bright multi-color border ring entirely */
.pl-pip-face::after{display:none;content:none;}

/* Soft surface light — natural, not a product-photo pin-flare */
.pl-pip-spec{
  position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:7;
  background:
    /* gentle top-left reflection */
    radial-gradient(ellipse 55% 28% at 22% 0%, rgba(255,255,255,.22) 0%, transparent 58%),
    /* soft top sheen band */
    linear-gradient(180deg, rgba(255,255,255,.10) 0%, transparent 18%),
    /* faint warm floor bounce */
    radial-gradient(ellipse 60% 30% at 50% 100%, rgba(211,172,99,.08) 0%, transparent 60%);
  mix-blend-mode:soft-light;
  opacity:.85;
}
/* Slow soft sheen across the pane */
.pl-pip-sheen{
  position:absolute;inset:-40% -70%;pointer-events:none;z-index:6;
  background:linear-gradient(118deg,
    transparent 42%,
    rgba(255,255,255,.03) 48%,
    rgba(255,255,255,.09) 50.5%,
    rgba(246,228,176,.04) 53%,
    transparent 59%);
  transform:translateX(-40%);
  animation:pl-pip-sweep 12s cubic-bezier(.33,.1,.25,1) infinite;
  mix-blend-mode:soft-light;
}
@keyframes pl-pip-sweep{
  0%, 55%{transform:translateX(-42%);}
  90%, 100%{transform:translateX(42%);}
}
@media (prefers-reduced-motion: reduce){
  .pl-pip{animation:none;}
  .pl-pip-sheen,.pl-pip-atmo,.pl-pip-caustic{animation:none;}
}

/* HEAD — Electron warm obsidian glass band */
.pl-pip-head{
  display:flex;align-items:center;gap:10px;
  margin:5px 5px 0;padding:11px 12px 12px;
  border-radius:18px 18px 12px 12px;position:relative;z-index:3;
  background:linear-gradient(180deg, rgba(22,19,14,.80) 0%, rgba(12,11,8,.64) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.09),
    0 8px 20px -14px rgba(0,0,0,.65);
}
.pl-pip-head::after{content:'';position:absolute;left:14px;right:14px;bottom:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(211,172,99,.36),transparent);pointer-events:none;}
.pl-pip-ava{width:30px;height:30px;border-radius:50%;flex-shrink:0;
  background:linear-gradient(145deg,#f6e4b0,#d9b874 52%,#b58f45);color:#231c0c;
  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 3px 10px -3px rgba(211,172,99,.45);}
.pl-pip-title{flex:1;min-width:0;}
.pl-pip-title h4{font-family:'Newsreader',ui-serif,Georgia,serif;font-size:14px;font-weight:500;margin:0;color:#fff;letter-spacing:-.01em;
  font-optical-sizing:none;font-variation-settings:"opsz" 14,"wght" 500,"ital" 0;
  text-shadow:0 1px 4px rgba(0,0,0,.5);}
.pl-pip-title span{display:flex;align-items:center;gap:5px;font-size:11px;color:rgba(255,255,255,.56);
  text-shadow:0 1px 4px rgba(0,0,0,.5);}
.pl-pip-livedot{width:6px;height:6px;border-radius:50%;background:#d3ac63;box-shadow:0 0 6px rgba(211,172,99,.55);animation:pl-pulse 1.6s infinite;}
.pl-pip-sizes{display:flex;gap:4px;}
.pl-pip-size{width:20px;height:20px;border-radius:6px;border:none;
  background:rgba(255,255,255,.035);color:rgba(255,255,255,.52);font-size:9px;font-weight:700;
  display:flex;align-items:center;justify-content:center;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}
.pl-pip-size.on{background:rgba(211,172,99,.20);color:#d3ac63;
  box-shadow:inset 0 0 0 1px rgba(211,172,99,.40), inset 0 1px 0 rgba(255,255,255,.10);}

/* MIDDLE — clear frosted pane over the call */
.pl-pip-body{padding:14px 14px 12px;display:flex;flex-direction:column;gap:11px;position:relative;z-index:3;
  background:linear-gradient(180deg, rgba(255,255,255,.03) 0%, transparent 30%, rgba(0,0,0,.04) 100%);
  min-height:168px;}
.pl-pip-msg{max-width:88%;display:flex;flex-direction:column;gap:5px;}
.pl-pip-msg.ai{align-self:flex-start;}
.pl-pip-msg.you{align-self:flex-end;align-items:flex-end;}
.pl-pip-name{font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;font-weight:600;color:rgba(214,178,108,.90);
  text-shadow:0 1px 5px rgba(0,0,0,.5);}
.pl-pip-bubble{padding:11px 13px;border-radius:13px;font-size:12.5px;line-height:1.5;}
/* AI — Electron warm obsidian plate */
.pl-pip-msg.ai .pl-pip-bubble{
  background:linear-gradient(180deg, rgba(27,24,17,.80) 0%, rgba(13,12,9,.74) 100%);
  color:#f4f0e8;border:none;border-bottom-left-radius:4px;
  text-shadow:0 1px 4px rgba(0,0,0,.4);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.09),
    0 10px 26px -12px rgba(0,0,0,.58);}
/* YOU — solid gold plate */
.pl-pip-msg.you .pl-pip-bubble{
  background:linear-gradient(180deg, rgba(212,176,110,.96) 0%, rgba(186,148,83,.94) 100%);
  color:#2a1f08;font-weight:500;border:none;border-bottom-right-radius:4px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.45),
    0 10px 26px -12px rgba(0,0,0,.48),
    0 0 18px -10px rgba(211,172,99,.35);}
.pl-pip-cursor{display:inline-block;width:2px;height:1.05em;margin-left:2px;vertical-align:-.15em;
  background:#d3ac63;border-radius:1px;box-shadow:0 0 8px rgba(211,172,99,.45);animation:pl-blink 1.05s steps(2,start) infinite;}
.pl-pip-model{align-self:flex-start;font-size:9.5px;color:#d6c396;display:flex;align-items:center;gap:5px;
  padding:3px 10px;border-radius:999px;background:rgba(211,172,99,.12);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10);text-shadow:0 1px 3px rgba(0,0,0,.35);}

/* FOOT — floating glass composer */
.pl-pip-foot{display:flex;align-items:center;gap:8px;
  margin:4px 7px 7px;padding:8px;position:relative;z-index:3;
  border-radius:20px;
  background:linear-gradient(180deg, rgba(30,27,20,.82) 0%, rgba(14,12,9,.84) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.12),
    inset 0 -14px 28px -18px rgba(0,0,0,.45),
    0 14px 36px -20px rgba(0,0,0,.75);}
/* Soft inner edge only — not a bright outer ring */
.pl-pip-foot::after{content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;
  background:linear-gradient(180deg, rgba(255,255,255,.12), transparent 55%);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite:exclude;opacity:.7;}
.pl-pip-input{flex:1;min-height:28px;display:flex;align-items:center;padding:4px 10px;font-size:11.5px;
  color:rgba(255,255,255,.40);text-shadow:0 1px 3px rgba(0,0,0,.4);}
.pl-pip-send{width:34px;height:34px;border-radius:50%;flex-shrink:0;border:none;
  background:linear-gradient(145deg,#f6e4b0 0%,#d9b874 55%,#b58f45 100%);color:#231c0c;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 5px 14px -5px rgba(211,172,99,.50), inset 0 1px 0 rgba(255,255,255,.42);}

.pl-pip-shieldrow{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:18px;
  font-size:12.5px;color:var(--mut);}
.pl-pip-shield{color:var(--gold);display:inline-flex;}

/* Code answer plate — same gold family, monospace for coding rounds */
.pl-pip-msg.you .pl-pip-bubble.pl-pip-code{
  font-family:ui-monospace,'SF Mono','Cascadia Code','JetBrains Mono',Menlo,Consolas,monospace;
  font-size:10.5px;line-height:1.55;letter-spacing:-.01em;font-weight:500;
  /* overflow HIDDEN, not auto — the showcase is bar-less everywhere; the
     snippet is sized to fit, and a decorative card must never grow a
     scrollbar of its own */
  text-align:left;white-space:pre;overflow:hidden;max-width:100%;
  background:linear-gradient(180deg, rgba(28,24,16,.88) 0%, rgba(14,12,9,.90) 100%);
  color:#e8d9b0;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.08),
    inset 0 0 0 1px rgba(211,172,99,.14),
    0 10px 26px -12px rgba(0,0,0,.55);
  border-bottom-right-radius:4px;
}
.pl-pip-code .pl-kw{color:#f0d9a0;}
.pl-pip-code .pl-fn{color:#f6e4b0;}
.pl-pip-code .pl-cm{color:rgba(214,178,108,.55);}
.pl-pip-code .pl-cn{color:#d9b874;}

/* ═══════════════════════════════════════════════════════════════════
   POP-OUT PORTAL — iOS / voice-portal scroll scrub
   Tall track + sticky stage. Scroll forms Theory, then Coding.
   BAR-LESS (2026-07-16): no HUD chips, no progress bar, no caption —
   the two screens themselves are the narrative; the crossfade is a
   single monotonic timeline (no snap clamps), and each card is
   fit-scaled by JS so it always fits the stage it's assigned.
   ⚠️ Never animate parent filter:blur — it kills child backdrop-filter
   glass (cards go fully invisible). Motion = opacity + translate + scale
   only, driven by JS inline styles (CSS vars are secondary).
   Fallback without JS: Theory card fully visible.
   ═══════════════════════════════════════════════════════════════════ */
.pl-pip-portal{
  position:relative;
  /* Short soft runway: Theory is already on stage; scroll only reveals Coding */
  height:132vh;
  margin:0;
}
.pl-pip-portal-sticky{
  position:sticky;
  top:max(64px, 7vh);
  min-height:min(82vh, 680px);
  height:min(82vh, 680px);
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  z-index:2;
  /* sticky must not be clipped by ancestors with overflow:hidden */
}
.pl-popout-stage.pl-pip-portal-stage{
  width:100%;
  flex:1 1 auto;
  min-height:min(64vh, 540px);
  height:min(64vh, 540px);
  max-height:min(64vh, 540px);
  /* override base stage overflow — absolute layers must paint glass */
  overflow:visible !important;
  position:relative;
  isolation:isolate;
  opacity:1;
}
.pl-pip-layer{
  position:absolute;inset:0;
  display:flex;align-items:center;justify-content:center;
  pointer-events:none;
  /* JS writes opacity/transform; CSS fallback shows Theory so the stage
     is never an empty black box if the scrubber fails to attach. */
  will-change:transform, opacity;
  /* NO filter property — backdrop-filter glass lives on .pl-pip-face */
}
/* Fallback (pre-JS / failed scrub): Theory visible, Coding hidden */
.pl-pip-layer-a{
  z-index:2;
  opacity:1;
  transform:translate3d(0,0,0) scale(1);
}
.pl-pip-layer-b{
  z-index:3;
  opacity:0;
  transform:translate3d(0,36px,0) scale(.94);
}
/* Once JS owns the portal, hide both until scrub paints (avoids flash) —
   but only if data-portal-ready is set AND we haven't painted yet.
   Safer: JS always sets inline styles immediately on mount. */
.pl-pip-portal[data-portal="live"] .pl-pip-layer-a,
.pl-pip-portal[data-portal="live"] .pl-pip-layer-b{
  /* inline styles from JS win over these; keep as soft defaults */
}
/* Portal cards: no idle bob — scroll is the motion language */
.pl-pip-portal-stage .pl-pip{
  animation:none !important;
  filter:drop-shadow(0 36px 48px rgba(0,0,0,.68)) drop-shadow(0 10px 20px rgba(0,0,0,.38));
  max-width:min(348px, 88vw);
}
.pl-pip-portal-stage .pl-pip-sheen{animation:none;opacity:.55;}
@media (max-width:720px){
  .pl-popout-stage{min-height:400px;}
  .pl-popout-ghost,.pl-popout-tag,.pl-pip-shell{display:none;}
  .pl-pip-backlight{width:230px;height:250px;filter:blur(14px);}
  .pl-pip-portal{height:122vh;}
  .pl-pip-portal-sticky{top:max(56px, 5vh);min-height:min(84vh, 620px);height:min(84vh, 620px);}
  .pl-popout-stage.pl-pip-portal-stage{min-height:min(62vh, 460px);height:min(62vh, 460px);max-height:min(62vh, 460px);}
  .pl-pip-msg.you .pl-pip-bubble.pl-pip-code{font-size:9.5px;padding:10px 11px;}
}
@media (prefers-reduced-motion:reduce){
  .pl-pip-portal{height:auto !important;}
  .pl-pip-portal-sticky{position:relative !important;top:auto !important;height:auto !important;min-height:0 !important;gap:28px;}
  .pl-popout-stage.pl-pip-portal-stage{
    height:auto !important;min-height:360px !important;max-height:none !important;
    display:flex !important;flex-direction:column;align-items:center;gap:22px;overflow:visible !important;
  }
  .pl-pip-layer{
    position:relative !important;inset:auto !important;
    opacity:1 !important;transform:none !important;
    margin:0 auto;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   GLASS GALAXY GLOBE — optical crystal, theater-lit
   Multi-shell polished crystal: outer atmosphere, floor caustic,
   double-wall glass, multi-specular optics, and a live spiral galaxy
   star sphere. Platform chips (Zoom / Meet / Teams / …) on gold
   circuit traces. Cursor tilt moves reflections like real optics.
   Decorative only — WebGL + platform data + handlers untouched.
   ═══════════════════════════════════════════════════════════════════ */

.pl-galaxy-globe {
  /* Sized and centered by .pl-orb-float, which carries the slow bob —
     keeping the float on the wrapper leaves the cursor-tilt transform
     on the sphere itself untouched. */
  position: absolute;
  inset: 0;
  z-index: 4;
}

/* Outer atmosphere — gold-violet bloom that breathes with the theater light */
.pl-globe-atmo {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 188%;
  height: 188%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background:
    radial-gradient(circle, rgba(211,172,99,.14) 0%, rgba(140,110,240,.16) 28%, rgba(90,120,240,.06) 48%, transparent 66%),
    radial-gradient(circle at 42% 36%, rgba(246,228,176,.10) 0%, transparent 42%);
  pointer-events: none;
  z-index: -1;
  animation: pl-atmo-breathe 9s ease-in-out infinite;
  filter: blur(1px);
}
@keyframes pl-atmo-breathe {
  0%, 100% { opacity: .55; transform: translate(-50%, -50%) scale(1); }
  50% { opacity: 1; transform: translate(-50%, -50%) scale(1.07); }
}

/* Floor caustic — light focused through solid crystal onto the stage */
.pl-globe-caustic {
  position: absolute;
  left: 50%;
  top: 78%;
  width: 78%;
  height: 28%;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(ellipse at 50% 30%,
    rgba(246,228,176,.38) 0%,
    rgba(211,172,99,.14) 32%,
    rgba(150,120,255,.08) 52%,
    transparent 72%);
  filter: blur(10px);
  animation: pl-caustic-breathe 7.5s ease-in-out infinite;
}
@keyframes pl-caustic-breathe {
  0%, 100% { opacity: .55; transform: translateX(-50%) scaleX(1); }
  50% { opacity: .95; transform: translateX(-50%) scaleX(1.08); }
}

/* Outer glass shell — the second wall of thick optical crystal */
.pl-globe-shell {
  position: absolute;
  inset: -7%;
  border-radius: 50%;
  pointer-events: none;
  z-index: 5;
  background:
    radial-gradient(circle at 30% 24%, rgba(255,255,255,.14) 0%, transparent 18%),
    radial-gradient(circle at 72% 78%, rgba(180,200,255,.08) 0%, transparent 28%),
    radial-gradient(circle at 50% 50%, transparent 62%, rgba(255,255,255,.06) 78%, rgba(255,255,255,.12) 92%, transparent 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.18),
    inset 0 0 0 2px rgba(211,172,99,.06),
    inset 0 2px 12px rgba(255,255,255,.10),
    0 0 0 1px rgba(255,255,255,.05),
    0 0 40px rgba(150,130,255,.10);
  -webkit-mask: radial-gradient(circle, transparent 58%, #000 68%, #000 96%, transparent 100%);
  mask: radial-gradient(circle, transparent 58%, #000 68%, #000 96%, transparent 100%);
  transition: transform .55s cubic-bezier(.2,.82,.2,1);
  will-change: transform;
}
/* The planet body — a thick optical-glass sphere over a live galaxy */
.pl-galaxy-sphere {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(circle at 32% 28%, #100e24 0%, #07060f 55%, #010104 100%);
  box-shadow:
    /* deep cast shadow — grounds the crystal on the stage */
    0 60px 140px -28px rgba(0,0,0,.97),
    0 24px 48px -16px rgba(0,0,0,.7),
    /* chromatic dispersion fringe (crystal splits light: warm→cool) */
    0 0 0 1px rgba(255,255,255,.14),
    0 0 0 2px rgba(255,140,120,.06),
    0 0 0 3.5px rgba(211,172,99,.05),
    0 0 0 5.5px rgba(120,160,255,.05),
    /* spherical volume — clear crystal, soft terminator */
    inset 28px 32px 56px rgba(0,0,0,.58),
    inset -24px -28px 58px rgba(160,130,255,.20),
    inset 0 0 0 1.5px rgba(255,255,255,.55),
    inset 0 0 100px rgba(130,100,220,.10),
    /* gold kiss from the theater light */
    0 0 50px -8px rgba(211,172,99,.22);
  overflow: hidden;
  transform: translateZ(0);
  transition: transform .55s cubic-bezier(.2,.82,.2,1);
  will-change: transform;
}

/* Inner galactic volume — soft circular core + clean arms (CSS fallback) */
.pl-galaxy-core {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    /* circular warm core */
    radial-gradient(circle 22% at 44% 46%, rgba(255,230,200,.55) 0%, rgba(200,160,255,.28) 38%, transparent 68%),
    /* soft violet disc */
    radial-gradient(ellipse 58% 22% at 48% 50%, rgba(140,120,255,.55) 0%, rgba(90,140,255,.18) 48%, transparent 72%),
    /* arm glow — circular, not blotchy */
    radial-gradient(circle 18% at 62% 44%, rgba(76,170,255,.35) 0%, transparent 70%),
    radial-gradient(circle 16% at 32% 56%, rgba(186,126,255,.32) 0%, transparent 70%);
  animation: pl-galaxy-rotate 140s linear infinite;
  mix-blend-mode: screen;
}

/* Counter-rotating soft depth haze */
.pl-galaxy-depth {
  position: absolute;
  inset: 6%;
  border-radius: 50%;
  background:
    radial-gradient(ellipse 62% 28% at 50% 50%, rgba(120,100,220,.16) 0%, transparent 70%),
    radial-gradient(circle 30% at 40% 42%, rgba(255,216,140,.08) 0%, transparent 65%);
  animation: pl-galaxy-rotate 200s linear infinite reverse;
  mix-blend-mode: screen;
  opacity: .75;
}

/* Bright galactic heart at the core */
.pl-galaxy-heart {
  position: absolute;
  left: 39%;
  top: 37%;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,253,248,1) 0%, rgba(224,196,255,.6) 28%, rgba(150,110,255,.22) 54%, transparent 72%);
  filter: blur(2px);
  animation: pl-heart-pulse 7s ease-in-out infinite;
  pointer-events: none;
}
@keyframes pl-heart-pulse {
  0%, 100% { opacity: .7; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.14); }
}

@keyframes pl-galaxy-rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* The living nebula — real-time WebGL interior. Sits above the CSS
   galaxy layers (which remain as the no-WebGL fallback) and below the
   stars, heart, and glass optics. */
/* Canvas fills the sphere; soft edge via wrapper mask (x.ai recipe) */
.pl-orb-canvas {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  clip-path: circle(50% at 50% 50%);
  -webkit-clip-path: circle(50% at 50% 50%);
}
/* x.ai canvas wrapper: circular clip + soft radial mask (anti-aliased limb) */
.pl-orb-clip {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  overflow: hidden;
  clip-path: circle(50% at 50% 50%);
  -webkit-clip-path: circle(50% at 50% 50%);
  mask-image: radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent);
  -webkit-mask-image: radial-gradient(closest-side, #000 calc(100% - 0.5px), transparent);
}
/* When the GPU orb is live — match x.ai: hide CSS galaxy, keep ONLY the
   glass-ring overlay. The shader owns interior + catchlights + fresnel. */
.pl-orb-live .pl-galaxy-core,
.pl-orb-live .pl-galaxy-depth,
.pl-orb-live .pl-galaxy-band,
.pl-orb-live .pl-galaxy-heart,
.pl-orb-live .pl-galaxy-stars,
.pl-orb-live .pl-glass-bounce,
.pl-orb-live .pl-glass-spec,
.pl-orb-live .pl-glass-spec2,
.pl-orb-live .pl-glass-crescent,
.pl-orb-live .pl-glass-rim,
.pl-orb-live .pl-glass-inner,
.pl-orb-live .pl-globe-shell,
.pl-orb-live .pl-globe-atmo,
.pl-orb-live .pl-globe-caustic { display: none !important; }
.pl-orb-live .pl-galaxy-sphere {
  background: transparent;
  box-shadow:
    0 52px 120px -28px rgba(0,0,0,.92),
    0 0 60px -12px rgba(211,172,99,.14);
  overflow: visible;
}
/* x.ai exact glass-ring recipe (verbatim from AgentOrb markup) */
.pl-orb-live .pl-orb-glassring {
  opacity: .35;
  box-shadow:
    inset 0 1px 1px rgba(255,255,255,.7),
    inset 0 -1px 1px rgba(255,255,255,.45),
    inset 0 0 0 1px rgba(255,255,255,.22),
    inset 0 0 12.5px rgba(255,255,255,.18);
}

/* Dense twinkling starfield inside the glass */
.pl-galaxy-stars {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  overflow: hidden;
  mix-blend-mode: screen;
}

.pl-galaxy-star {
  position: absolute;
  background: #fffdf9;
  border-radius: 50%;
  box-shadow: 0 0 3px #dcd0ff, 0 0 7px rgba(200,175,255,.65);
  animation: pl-galaxy-twinkle var(--tw) ease-in-out infinite;
  animation-delay: var(--d);
  opacity: var(--o);
}

@keyframes pl-galaxy-twinkle {
  0%, 100% { transform: scale(1); opacity: var(--o); }
  45% { transform: scale(2); opacity: calc(var(--o) * 0.2); }
}

/* ── AXIAL ROTATION — the Earth effect ──
   A planet doesn't spin because something keeps pushing it; it spins on
   conserved angular momentum and nothing in space stops it. So the motion
   here is pure momentum: constant angular velocity, linear timing, no
   easing, ever. Two nebula bands drift across the face along a
   23.4°-tilted axis (Earth's real obliquity). The near hemisphere travels
   west→east (left→right); because the sphere is CLEAR crystal, the far
   hemisphere shows through drifting the OPPOSITE way — dimmer, softer,
   exactly as the back of a transparent ball behaves. The starfield rides
   the near band; a radial mask fades features at the limbs
   (foreshortening). Lighting never rotates: the specular, rim, crescent
   and caustic stay fixed while the world turns beneath them. */
.pl-galaxy-band {
  position: absolute;
  inset: -20%;
  transform: rotate(-23.4deg);
  pointer-events: none;
  -webkit-mask: radial-gradient(circle at 50% 50%, #000 50%, rgba(0,0,0,.45) 71%, transparent 95%);
  mask: radial-gradient(circle at 50% 50%, #000 50%, rgba(0,0,0,.45) 71%, transparent 95%);
}
.pl-galaxy-band-drift {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 200%;
  mix-blend-mode: screen;
  will-change: transform;
  /* One sidereal day ≈ 76s. Paired features at 50% for seamless loop. */
  animation: pl-earth-drift 76s linear infinite;
  /* Clean galaxy disc: one soft plane + two arm cores, duplicated for loop.
     No scattered blotches — proper elliptical form. */
  background:
    /* primary disc plane (near) */
    radial-gradient(ellipse 42% 9% at 25% 48%, rgba(110,140,255,.42) 0%, rgba(160,120,255,.18) 40%, transparent 72%),
    radial-gradient(ellipse 42% 9% at 75% 48%, rgba(110,140,255,.42) 0%, rgba(160,120,255,.18) 40%, transparent 72%),
    /* spiral arm cores — circular, not jagged */
    radial-gradient(circle 7% at 18% 46%, rgba(200,160,255,.55) 0%, transparent 70%),
    radial-gradient(circle 7% at 68% 46%, rgba(200,160,255,.55) 0%, transparent 70%),
    radial-gradient(circle 6% at 32% 52%, rgba(90,180,255,.45) 0%, transparent 70%),
    radial-gradient(circle 6% at 82% 52%, rgba(90,180,255,.45) 0%, transparent 70%),
    /* warm galactic core */
    radial-gradient(circle 4.5% at 25% 48%, rgba(255,230,190,.5) 0%, transparent 68%),
    radial-gradient(circle 4.5% at 75% 48%, rgba(255,230,190,.5) 0%, transparent 68%);
}
/* Far hemisphere through the glass: same disc, dimmer + softer */
.pl-galaxy-band--far .pl-galaxy-band-drift {
  animation-direction: reverse;
  opacity: .38;
  filter: blur(1.8px) brightness(.8);
  background:
    radial-gradient(ellipse 40% 8% at 25% 50%, rgba(120,110,255,.4) 0%, transparent 70%),
    radial-gradient(ellipse 40% 8% at 75% 50%, rgba(120,110,255,.4) 0%, transparent 70%),
    radial-gradient(circle 5% at 20% 48%, rgba(180,140,255,.4) 0%, transparent 70%),
    radial-gradient(circle 5% at 70% 48%, rgba(180,140,255,.4) 0%, transparent 70%);
}
@keyframes pl-earth-drift {
  from { transform: translateX(-50%); }
  to { transform: translateX(0); }
}
/* Stars are pinned to the rotating body, so they ride the same drift. */
.pl-galaxy-starwrap {
  position: absolute;
  inset: -20%;
  transform: rotate(-23.4deg);
  -webkit-mask: radial-gradient(circle at 50% 50%, #000 55%, rgba(0,0,0,.5) 75%, transparent 96%);
  mask: radial-gradient(circle at 50% 50%, #000 55%, rgba(0,0,0,.5) 75%, transparent 96%);
}
.pl-galaxy-stardrift {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 200%;
  will-change: transform;
  animation: pl-earth-drift 76s linear infinite;
}

/* Glass optics — multi-source specular stack.
   Clear crystal: hard key catchlight + soft bloom + secondary fill + top sheen.
   Frosted glass would smear these; polished crystal keeps them small & bright. */
.pl-glass-spec {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  z-index: 8;
  background:
    /* primary hard key (product-photo catchlight) */
    radial-gradient(circle at 30% 21%, rgba(255,255,255,1) 0%, rgba(255,255,255,.98) 1.8%, rgba(255,255,255,.45) 4%, transparent 7.5%),
    /* key bloom */
    radial-gradient(ellipse 20% 13% at 31% 20%, rgba(255,255,255,.65) 0%, rgba(246,228,176,.12) 40%, transparent 62%),
    /* secondary window light */
    radial-gradient(ellipse 11% 7% at 64% 12%, rgba(255,255,255,.48) 0%, transparent 68%),
    /* tertiary cool fill */
    radial-gradient(ellipse 8% 5% at 18% 48%, rgba(200,220,255,.22) 0%, transparent 70%),
    /* broad top sheen (thin, not milky) */
    radial-gradient(ellipse 58% 26% at 44% 9%, rgba(255,255,255,.14) 0%, transparent 58%);
  mix-blend-mode: screen;
}
/* Second specular layer — gold-kissed edge light from the theater lamp */
.pl-glass-spec2 {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  z-index: 8;
  background:
    radial-gradient(ellipse 18% 10% at 78% 28%, rgba(246,228,176,.28) 0%, transparent 65%),
    radial-gradient(circle at 74% 70%, rgba(211,172,99,.12) 0%, transparent 22%);
  mix-blend-mode: screen;
  opacity: .85;
}

/* Lower-right bounce + interior caustic pool — solid-glass tell */
.pl-glass-bounce {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  z-index: 7;
  background:
    radial-gradient(circle at 72% 74%, rgba(170,205,255,.38) 0%, transparent 30%),
    radial-gradient(ellipse 42% 18% at 50% 91%, rgba(246,228,176,.45) 0%, rgba(200,170,255,.28) 38%, rgba(150,120,255,.12) 55%, transparent 70%),
    radial-gradient(ellipse 24% 12% at 38% 86%, rgba(255,255,255,.14) 0%, transparent 60%);
}

/* Fresnel rim — bright glass edge where the sphere curves away */
.pl-glass-rim {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  z-index: 9;
  border: 1px solid rgba(255,255,255,.28);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.82),
    inset 0 2px 12px rgba(255,255,255,.48),
    inset 0 0 28px 2px rgba(180,150,255,.30),
    inset 12px 14px 28px rgba(255,255,255,.16),
    inset -10px -12px 22px rgba(190,210,255,.18),
    0 0 0 3px rgba(140,110,230,.10),
    0 0 0 5px rgba(211,172,99,.05),
    0 0 40px rgba(160,130,255,.32),
    0 0 28px rgba(211,172,99,.12);
}

/* Curved window reflection — the crescent a polished crystal ball throws
   back from the room. Strongest "this is real glass" cue in product photos. */
.pl-glass-crescent {
  position: absolute;
  inset: 5%;
  border-radius: 50%;
  pointer-events: none;
  z-index: 8;
  border-top: 2.5px solid rgba(255,255,255,.62);
  border-left: 1.5px solid rgba(255,255,255,.18);
  border-right: 1px solid transparent;
  border-bottom: 1px solid transparent;
  transform: rotate(-38deg);
  filter: blur(1.1px);
  box-shadow: 0 -2px 12px rgba(255,255,255,.08);
}
/* Inner refraction ring — light bending inside the solid ball */
.pl-glass-inner {
  position: absolute;
  inset: 11%;
  border-radius: 50%;
  pointer-events: none;
  z-index: 6;
  border: 1px solid rgba(255,255,255,.08);
  box-shadow:
    inset 0 0 20px rgba(255,255,255,.04),
    0 0 1px rgba(246,228,176,.12);
  opacity: .65;
}

/* ── The connected core — x.ai-voice-grade stagecraft ──
   (x.ai's orb is a Rive-authored WASM vector animation; ours is the
   living CSS galaxy above — same stage direction, zero runtime.)
   A 620×420 stage: the orb floats on a slow bob wearing a hairline
   glass ring; on reveal, circuit traces draw themselves outward and
   frosted chips holding the real platform marks fly from the core to
   their endpoints; pulses of gold light then flow along the traces
   forever. */
.pl-connect-stage {
  position: absolute;
  left: 50%;
  top: 50%;
  /* Desktop design coordinate system: chips + SVG traces are authored in
     620×420 px. Mobile scales this whole stage via --pl-stage-scale so
     Meet/Teams/etc. stay on-screen instead of being clipped. */
  width: 620px;
  height: 420px;
  transform: translate(-50%, -50%) scale(var(--pl-stage-scale, 1));
  transform-origin: center center;
}
.pl-traces { position: absolute; inset: 0; width: 100%; height: 100%; }
.pl-trace {
  fill: none;
  stroke: rgba(211,172,99,.38);
  stroke-width: 1.15;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  filter: drop-shadow(0 0 2px rgba(211,172,99,.25));
}
.pl-theater.pl-in .pl-trace {
  animation: pl-tracedraw .9s cubic-bezier(.2,.8,.2,1) forwards;
  animation-delay: var(--td, 0s);
}
@keyframes pl-tracedraw { to { stroke-dashoffset: 0; } }
.pl-trace-pulse {
  fill: none;
  stroke: #f6e4b0;
  stroke-width: 1.85;
  stroke-linecap: round;
  stroke-dasharray: .06 .94;
  stroke-dashoffset: 1;
  opacity: 0;
  filter: drop-shadow(0 0 4px rgba(246,228,176,1)) drop-shadow(0 0 10px rgba(211,172,99,.55));
  transition: opacity .6s ease 1.1s;
}
.pl-theater.pl-in .pl-trace-pulse {
  opacity: 1;
  animation: pl-pulseflow 3.2s linear infinite;
  animation-delay: var(--pd, 0s);
}
@keyframes pl-pulseflow { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
/* x.ai OrbFloat: translateY + optional scale via CSS vars */
.pl-orb-float {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 240px;
  height: 240px;
  transform: translate(-50%, -50%);
  --orb-float-y: -9px;
  --orb-float-scale: 1;
  animation: pl-orbfloat 7s ease-in-out infinite;
  will-change: transform;
}
@keyframes pl-orbfloat {
  0%, 100% { transform: translate(-50%, -50%) translateY(0) scale(1); }
  50% { transform: translate(-50%, -50%) translateY(var(--orb-float-y, -9px)) scale(var(--orb-float-scale, 1)); }
}
/* Default glass ring (CSS-fallback path). Live path uses x.ai recipe above. */
.pl-orb-glassring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  z-index: 10;
  opacity: .35;
  box-shadow:
    inset 0 1px 1px rgba(255,255,255,.7),
    inset 0 -1px 1px rgba(255,255,255,.45),
    inset 0 0 0 1px rgba(255,255,255,.22),
    inset 0 0 12.5px rgba(255,255,255,.18);
  transition: transform .55s cubic-bezier(.2,.82,.2,1);
}
/* Premium frosted glass chips — platform marks on cut crystal tiles */
.pl-chip-node {
  position: absolute;
  width: 58px;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 17px;
  background:
    linear-gradient(155deg, rgba(255,255,255,.10) 0%, rgba(255,255,255,.03) 42%, rgba(211,172,99,.04) 100%),
    rgba(12,11,9,.55);
  border: 1px solid rgba(255,255,255,.12);
  box-shadow:
    0 20px 48px -14px rgba(0,0,0,.78),
    0 0 0 1px rgba(211,172,99,.08),
    inset 0 1px 0 rgba(255,255,255,.18),
    inset 0 -1px 0 rgba(0,0,0,.25),
    inset 0 0 20px rgba(255,255,255,.03);
  backdrop-filter: blur(12px) saturate(1.2);
  -webkit-backdrop-filter: blur(12px) saturate(1.2);
  transition: border-color .3s, box-shadow .35s, background .3s, transform .35s cubic-bezier(.2,.9,.3,1);
}
.pl-theater.pl-in .pl-chip-node {
  animation: pl-chipfly .95s cubic-bezier(.16,.8,.24,1) both;
  animation-delay: var(--cd, 0s);
}
/* Born at the core, flies to its endpoint */
@keyframes pl-chipfly {
  from { opacity: 0; transform: translate(var(--cdx, 0px), var(--cdy, 0px)) scale(.42); }
  to { opacity: 1; transform: none; }
}
.pl-chip-node:hover {
  background:
    linear-gradient(155deg, rgba(255,255,255,.14) 0%, rgba(255,255,255,.05) 42%, rgba(211,172,99,.08) 100%),
    rgba(14,12,9,.6);
  border-color: rgba(211,172,99,.55);
  transform: translateY(-3px) scale(1.04);
  box-shadow:
    0 24px 52px -12px rgba(0,0,0,.85),
    0 0 32px rgba(211,172,99,.32),
    0 0 0 1px rgba(211,172,99,.2),
    inset 0 1px 0 rgba(255,255,255,.28),
    inset 0 0 24px rgba(246,228,176,.06);
}
.pl-chip-node svg { width: 28px; height: 28px; display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
/* Reduced motion: kill globe ornaments that move */
@media (prefers-reduced-motion: reduce) {
  .pl-globe-caustic, .pl-globe-atmo, .pl-orb-float { animation: none !important; }
}
`;

const Wordmark: React.FC<{ onClick?: () => void }> = ({ onClick }) => (
  <button onClick={onClick} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
    <span className="pl-serif pl-wordmark">
      minicaai<span style={{ color: 'var(--gold)' }}>.</span>
    </span>
  </button>
);

// Magnetic wrapper for the two hero-grade CTAs. Moves the WRAPPER (the
// button keeps its own hover transform) toward the pointer, max ±7px.
const Magnetic: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || prefersReduce()) return;
    const r = el.getBoundingClientRect();
    const dx = Math.max(-7, Math.min(7, (e.clientX - (r.left + r.width / 2)) * 0.14));
    const dy = Math.max(-7, Math.min(7, (e.clientY - (r.top + r.height / 2)) * 0.14));
    el.style.transform = `translate3d(${dx}px,${dy}px,0)`;
  };
  const onLeave = () => { if (ref.current) ref.current.style.transform = ''; };
  return (
    <div ref={ref} className="pl-mag" onPointerMove={onMove} onPointerLeave={onLeave}>
      {children}
    </div>
  );
};

// The capture test — one screen, rendered twice. Deterministic skeleton
// [indent px, width %] so both frames are pixel-identical; the only
// difference the reader can find is the gold answer card in the front one.
const SKELINES: [number, number][] = [
  [0, 62], [14, 46], [14, 74], [28, 38], [28, 58], [14, 30], [0, 52],
];

const ShareFrame: React.FC<{ overlay?: boolean; scan?: boolean }> = ({ overlay, scan }) => (
  <div className={`pl-frame ${overlay ? 'pl-frame--front' : 'pl-frame--back'}`}>
    {/* Tag sits on the outer frame (overflow:visible). Surface clips the UI. */}
    <span className={`pl-captag${overlay ? ' pl-captag--you' : ''}`}>{overlay ? 'You see' : 'They see'}</span>
    <div className="pl-frame-surface">
      <div className="pl-chrome">
        <span className="pl-dot3"><i /><i /><i /></span>
        <span className="pl-addr">codesignal.com/assessment — final round</span>
        <span className="pl-sharepill"><span className="pl-recdot" /> SHARING</span>
      </div>
      <div className="pl-editor">
        <span className="pl-gutter">{SKELINES.map((_, i) => <span key={i}>{i + 1}</span>)}</span>
        <span className="pl-lines">
          {SKELINES.map(([ind, w], i) => (
            <span key={i} className="pl-skl" style={{ marginLeft: ind, width: `${w}%` }} />
          ))}
        </span>
        {scan && <span className="pl-scan" />}
        {overlay && (
          <div className="pl-mini">
            <div className="pl-gold" style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.2em', textTransform: 'uppercase', marginBottom: 5 }}>You say</div>
            <p className="pl-serif pl-say-sm" style={{ color: 'var(--paper)', margin: 0 }}>
              Start with the trade-offs, then the design…<span className="pl-caret" style={{ height: '.8em' }} />
            </p>
          </div>
        )}
      </div>
    </div>
  </div>
);

const HERO_LINE = 'answered the moment it’s asked.';
const ANSWER = 'I’d anchor it on an event backbone — Kafka — with stateless scoring pulling features from Redis, and the model behind a feature cache so p99 holds under 50ms.';

const MODELS = ['Claude Sonnet 5', 'GPT-5.6', 'Gemini 3.6', 'Grok 4.5', 'Groq'];
const CAPS = [
  { icon: PhHeadphones, t: 'Sub-second transcription' },
  { icon: PhMonitor, t: 'Solves coding & case rounds' },
  { icon: PhLock, t: 'Nothing recorded or stored' },
];
const STEPS = [
  { n: '01', t: 'Open it before the call', b: 'One hotkey summons minicaai over your Zoom, Meet, or Teams window.' },
  { n: '02', t: 'It listens, in real time', b: 'Every question is transcribed the instant it’s asked — grounded in your résumé and the role.' },
  { n: '03', t: 'Read your answer, live', b: 'A tailored response streams onto your screen. Invisible to them. Effortless for you.' },
];
const PROOF = ['Google', 'Amazon', 'Stripe', 'Meta', 'JPMorgan', 'Nvidia', 'Airbnb'];

// Projector dust in the hero beam. Deterministic pseudo-random so the 60
// re-renders during the typing animation never reshuffle a mote.
const MOTES = Array.from({ length: 16 }, (_, i) => ({
  left: 6 + ((i * 613) % 88),
  top: 52 + ((i * 271) % 44),
  size: 1.6 + (i % 3) * 0.7,
  delay: (i * 911) % 8000,
  dur: 9000 + ((i * 397) % 9000),
  dx: ((i * 89) % 44) - 22,
  o: 0.22 + (i % 4) * 0.09,
}));

// Theater dust — slower, more delicate, different rhythm.
// Deterministic so it never reshuffles on the typing hero re-renders.
const THEATER_MOTES = Array.from({ length: 28 }, (_, i) => ({
  left: 4 + ((i * 137) % 92),
  top: 12 + ((i * 211) % 76),
  size: 0.9 + (i % 5) * 0.35,
  delay: (i * 173) % 14000,
  dur: 16000 + ((i * 281) % 11000),
  dx: ((i * 67) % 38) - 19,
  o: 0.07 + (i % 5) * 0.035,
}));

// ── App-grounded content (docs/public/*.md; tiers per 2026-07 pricing) ──

const LEDGER: { t: string; b: string; chip?: string }[] = [
  { t: 'Auto-send', b: 'Hands-free mode. About 1.2 seconds after the interviewer stops talking, a draft is already streaming. Toggle it off any time to send manually.' },
  { t: 'Auto-Solve', b: 'One click captures the question on your screen — LeetCode-style problems included — and drafts the code answer. The screenshot lives in memory for that single call, then it’s gone.' },
  { t: 'Knowledge files', b: 'Your résumé, the job description, your notes — prepended to every answer so it cites your projects, not generic ones. Stored on your machine only.' },
  { t: 'Custom Instructions', b: 'Standing orders the model follows in every session: “answer like a senior engineer,” “no preamble,” “say analytics platform, not BI tool.”' },
  { t: 'Train Model', b: 'Before the call, it studies your résumé against the role: projects worth citing, stack overlaps, likely behavioural angles, recent company news.', chip: 'Max+' },
  { t: 'Web-search answers', b: 'Claude checks the live web mid-answer when a question is time-sensitive — a new API, a fresh benchmark, yesterday’s launch.', chip: 'Pro+' },
  { t: 'Reasoning control', b: 'A three-notch dial. Instant for behavioural rounds; deeper, step-by-step rigor for system design and math.', chip: 'Max+' },
  { t: 'History & export', b: 'Every session saved and searchable. Reopen last week’s answers before this week’s final round — or export the lot.' },
];

const TRUST = [
  { icon: PhHeadphones, t: 'Audio is transcribed, then discarded', b: 'Your call audio streams only to the transcription engine — a paid tier whose terms exclude it from training — and never touches our servers.' },
  { icon: PhShield, t: 'No model trains on you', b: 'Every AI provider in the app runs on paid API terms that exclude your traffic from training datasets.' },
  // ── These two were making claims the app does not keep. ──
  //
  // "Nothing is written to disk — yours or ours" was false on the user's
  // own machine: when Auto-Type cannot read an editor through the
  // accessibility APIs it falls back to a vision planner, and that path
  // writes the captured frame to <userData>/autotype-screenshots
  // (electron/autoTypePlanLog.cjs saveScreenshot), keeping the 50 most
  // recent. True for Auto-Solve, false for Auto-Type — and the heading
  // generalised to "Screenshots".
  //
  // "No ... reading other windows" was contradicted by both features:
  // Auto-Solve asks desktopCapturer for 'Entire Screen' (App.tsx) and the
  // Auto-Type planner captures the whole display the cursor is on
  // (main.cjs captureScreenForVision, types:['screen']). Whatever else is
  // on that display is in the frame.
  //
  // The accurate version is still the strong one — nothing reaches our
  // servers, the local copy is the user's own, and capture only ever
  // happens on a deliberate press. Claims here must stay checkable
  // against the code; docs/public/PRIVACY.md carries the same wording.
  { icon: PhMonitor, t: 'Screenshots never reach our servers', b: 'Auto-Solve holds the frame in memory for one model call and drops it. Auto-Type keeps its last 50 frames on YOUR machine, so you can see what it saw — never on ours, never in a backup.' },
  { icon: PhLock, t: 'It only looks when you ask', b: 'Audio comes from the one source you pick. Screen capture is a single still frame, taken when you press Auto-Solve or Auto-Type and never between — no recording, no keylogger, nothing running in the background.' },
  { icon: PhCheck, t: 'Signed and verifiable', b: 'The Windows installer is code-signed via Azure Trusted Signing; updates ship over HTTPS and verify their signature before installing.' },
];

const PLATFORMS = ['Zoom', 'Google Meet', 'Microsoft Teams', 'Webex', 'HackerRank', 'CodeSignal', 'CoderPad'];

const FAQS = [
  { q: 'Will the interviewer ever see it?', a: 'No. The pop-out renders in a content-protected window that screen-share cannot capture — on Windows, macOS, and Linux. Even while you share your screen, they see the area behind it.' },
  { q: 'Is the free trial actually free?', a: 'Yes. Signing up gives you 10 minutes with every model except Claude — no card, nothing to cancel. When your 10 minutes are up, you choose a plan to keep going; nothing ever auto-charges.' },
  { q: 'Is this cheating?', a: 'We don’t make that call for you. Modern interviews increasingly test recall of obscure trivia under pressure more than they test the actual job. We build the tool; how you use it is your decision.' },
  { q: 'Is my interview audio stored anywhere?', a: 'No. Audio streams to the transcription engine, comes back as text, and is discarded. Every provider we use runs on paid API tiers whose terms exclude your data from training.' },
  { q: 'What do I need to run it?', a: 'Windows 10 or later, macOS 12 Monterey or later (native on Apple Silicon), or Linux (Ubuntu 22.04+, Fedora 38+). It works with any interview platform that plays audio through your computer.' },
  // Device counts mirror the server's per-tier limits (registerDevice in
  // server/src/database.js: free/basic 2 · pro 3 · max 5 · ultra 10 ·
  // enterprise 25).
  { q: 'Can I use one account on two machines?', a: 'Yes — every plan includes a device allowance (2 devices on Free and Basic, 3 on Pro, 5 on Max, 10 on Ultra, 25 on Enterprise). Signing in past your allowance moves the seat off your oldest device, so you can switch machines any time — but seats can’t be farmed out.' },
  { q: 'What if it doesn’t work out?', a: 'There’s a 14-day window on your first purchase — under two hours of use gets a full refund. Cancel any time and keep access through the period you already paid for.' },
];

// Deterministic starfield for the globe interior. Sin-hashed (not Math.random)
// so it's stable across renders — no hydration flicker, generated once.
const GALAXY_STARS = Array.from({ length: 76 }, (_, i) => {
  const h = (n: number) => { const s = Math.sin((i + 1) * n) * 43758.5453; return s - Math.floor(s); };
  const ang = h(12.9898) * Math.PI * 2;
  const rad = Math.sqrt(h(78.233)) * 46; // sqrt → stars spread evenly across the disc
  return {
    x: 50 + Math.cos(ang) * rad,
    y: 50 + Math.sin(ang) * rad,
    sz: +(0.7 + h(3.7) * 1.9).toFixed(2),
    tw: Math.round(2000 + h(5.11) * 3400),
    d: Math.round(h(9.31) * 4200),
    o: +(0.5 + h(2.17) * 0.5).toFixed(2),
  };
});

// GENUINE platform marks — official artwork, not approximations. Meet +
// Teams are the vendors' own multicolor icons; Webex / HackerRank /
// CodeSignal are the exact registered brand paths (Simple Icons data);
// CoderPad's red comes from coderpad.io's own favicon. Marks render bare
// on dark frosted chips (the x.ai treatment): Webex uses its white-on-
// dark variant; HackerRank's knocked-out "h" over the dark chip is
// literally HackerRank's own dark-mode mark.
// Stage geometry: 620×420, orb center (310,210) r≈120. Each node carries
// its chip center (x,y), the orthogonal circuit trace from the orb's rim
// to the chip's edge, and its choreography delays (trace draw / chip
// flight / pulse phase).
const PLATFORM_ICONS: {
  name: string; x: number; y: number; trace: string;
  td: string; cd: string; pd: string; svg: React.ReactNode;
}[] = [
  { name: 'Zoom', x: 88, y: 68, trace: 'M 234 116 V 68 H 116', td: '0s', cd: '.1s', pd: '0s', svg: (
    <svg viewBox="0 0 24 24"><path d="M1.75 7.6c0-.98.8-1.78 1.78-1.78h8.93c1.57 0 2.84 1.27 2.84 2.84v7.74c0 .98-.8 1.78-1.78 1.78H4.59a2.84 2.84 0 0 1-2.84-2.84V7.6Z" fill="#2D8CFF"/><path d="m16.95 10.44 3.71-3.04c.63-.52 1.57-.07 1.57.74v7.72c0 .81-.94 1.26-1.57.74l-3.71-3.04v-3.12Z" fill="#2D8CFF"/></svg>
  ) },
  { name: 'Meet', x: 88, y: 163, trace: 'M 200 163 H 116', td: '.07s', cd: '.17s', pd: '-1.3s', svg: (
    <svg viewBox="0 0 87.5 72" fill="none"><path fill="#00832d" d="M49.5 36l8.53 9.75 11.47 7.33 2-17.02-2-16.64-11.69 6.44z"/><path fill="#0066da" d="M0 51.5V66c0 3.315 2.685 6 6 6h14.5l3-10.96-3-9.54-9.95-3z"/><path fill="#e94235" d="M20.5 0L0 20.5l10.55 3 9.95-3 2.95-9.41z"/><path fill="#2684fc" d="M20.5 20.5H0v31h20.5z"/><path fill="#00ac47" d="M82.6 8.68L69.5 19.42v33.66l13.16 10.79c1.97 1.54 4.85.135 4.85-2.37V11c0-2.535-2.945-3.925-4.91-2.32zM49.5 36v15.5h-29V72h43c3.315 0 6-2.685 6-6V53.08z"/><path fill="#ffba00" d="M63.5 0h-43v20.5h29V36l20-16.57V6c0-3.315-2.685-6-6-6z"/></svg>
  ) },
  { name: 'Teams', x: 88, y: 258, trace: 'M 196 246 H 176 V 258 H 116', td: '.14s', cd: '.24s', pd: '-2.1s', svg: (
    <svg viewBox="0 0 2228.833 2073.333"><path fill="#5059C9" d="M1554.637,777.5h575.713c54.391,0,98.483,44.092,98.483,98.483v524.398c0,199.901-162.051,361.952-361.952,361.952h-1.711c-199.901,0.028-361.975-162-362.004-361.901c0-0.017,0-0.034,0-0.052V828.971C1503.167,800.544,1526.211,777.5,1554.637,777.5L1554.637,777.5z"/><circle fill="#5059C9" cx="1943.75" cy="440.583" r="233.25"/><circle fill="#7B83EB" cx="1218.083" cy="336.917" r="336.917"/><path fill="#7B83EB" d="M1667.323,777.5H717.01c-53.743,1.33-96.257,45.931-95.01,99.676v598.105c-7.505,322.519,247.657,590.16,570.167,598.053c322.51-7.893,577.671-275.534,570.167-598.053V877.176C1763.579,823.431,1721.066,778.83,1667.323,777.5z"/><path opacity=".1" d="M1244,777.5v838.145c-0.258,38.435-23.549,72.964-59.09,87.598c-11.316,4.787-23.478,7.254-35.765,7.257H667.613c-6.738-17.105-12.958-34.21-18.142-51.833c-18.144-59.477-27.402-121.307-27.472-183.49V877.02c-1.246-53.659,41.198-98.19,94.855-99.52H1244z"/><path opacity=".2" d="M1192.167,777.5v889.978c-0.002,12.287-2.47,24.449-7.257,35.765c-14.634,35.541-49.163,58.833-87.598,59.09H691.975c-8.812-17.105-17.105-34.21-24.362-51.833c-7.257-17.623-12.958-34.21-18.142-51.833c-18.144-59.476-27.402-121.307-27.472-183.49V877.02c-1.246-53.659,41.198-98.19,94.855-99.52H1192.167z"/><path opacity=".2" d="M1140.333,777.5v786.312c-0.395,52.223-42.632,94.46-94.855,94.855H649.472c-18.144-59.476-27.402-121.307-27.472-183.49V877.02c-1.246-53.659,41.198-98.19,94.855-99.52H1140.333z"/><path opacity=".1" d="M1244,509.522v163.275c-8.812,0.518-17.105,1.037-25.917,1.037c-8.812,0-17.105-0.518-25.917-1.037c-17.496-1.161-34.848-3.937-51.833-8.293c-104.963-24.857-191.679-98.469-233.25-198.003c-7.153-16.715-12.706-34.071-16.587-51.833h258.648C1201.449,414.866,1243.801,457.217,1244,509.522z"/><path opacity=".2" d="M1192.167,561.355v111.442c-17.496-1.161-34.848-3.937-51.833-8.293c-104.963-24.857-191.679-98.469-233.25-198.003h190.228C1149.616,466.699,1191.968,509.051,1192.167,561.355z"/><path opacity=".2" d="M1140.333,561.355v103.148c-104.963-24.857-191.679-98.469-233.25-198.003h138.395C1097.783,466.699,1140.134,509.051,1140.333,561.355z"/><linearGradient id="plTeamsGrad" gradientUnits="userSpaceOnUse" x1="198.099" y1="1683.0726" x2="942.2344" y2="394.2607" gradientTransform="matrix(1 0 0 -1 0 2075.3333)"><stop offset="0" stopColor="#5a62c3"/><stop offset=".5" stopColor="#4d55bd"/><stop offset="1" stopColor="#3940ab"/></linearGradient><path fill="url(#plTeamsGrad)" d="M95.01,466.5h950.312c52.473,0,95.01,42.538,95.01,95.01v950.312c0,52.473-42.538,95.01-95.01,95.01H95.01c-52.473,0-95.01-42.538-95.01-95.01V561.51C0,509.038,42.538,466.5,95.01,466.5z"/><path fill="#FFF" d="M820.211,828.193H630.241v517.297H509.211V828.193H320.123V727.844h500.088V828.193z"/></svg>
  ) },
  { name: 'Webex', x: 532, y: 92, trace: 'M 400 128 V 92 H 504', td: '.28s', cd: '.38s', pd: '-1.7s', svg: (
    <svg viewBox="0 0 24 24"><path fill="#EDF1F7" d="M21.78 7.376c.512 1.181.032 2.644-1.11 3.106-2.157.888-3-1.295-3-1.295-.236-.55-.727-1.496-1.335-1.496-.204 0-.503 0-.94.844-.229.443-.434 1.185-.616 1.84l-.09.32c-.373-1.587-.821-3.454-1.536-4.816-.195-.38-.42-.74-.673-1.08a5.135 5.135 0 0 1 1.743-1.337 4.891 4.891 0 0 1 2.112-.463c1.045 0 2.765.338 4.227 2.227.167.206.317.424.448.654.278.441.52.904.726 1.383l.043.113zM.02 8.4C-.15 7.105.8 5.845 1.953 5.755c1.794-.157 2.36 1.385 2.455 1.89l.022.137c.07.44.29 1.838.48 2.744.078.4.244 1.013.353 1.416l.006.022.026.092c.11.4.232.799.362 1.193.185.548.399 1.085.641 1.61.47.955.93 1.45 1.367 1.45.203 0 .512 0 .96-.878.283-.59.512-1.208.684-1.845.373 1.598.811 3.128 1.495 4.456.205.406.444.794.715 1.16a5.124 5.124 0 0 1-1.742 1.338 4.88 4.88 0 0 1-2.112.461c-1.548 0-3.727-.698-5.339-4.005a22.407 22.407 0 0 1-1.078-2.824 26.848 26.848 0 0 1-.693-2.656 48.56 48.56 0 0 1-.215-1.114C.191 9.603.074 8.872.02 8.4zm22.047-2.645-.202-.022h-.052c.222.392.421.797.597 1.215l.053.113c.322.76.346 1.614.068 2.391a3.079 3.079 0 0 1-1.552 1.749 2.93 2.93 0 0 1-1.228.28 3.115 3.115 0 0 1-.854-.135c-.299 1.182-.768 2.634-1.195 3.511-.427.877-.93 1.451-1.378 1.451-.192 0-.501 0-.95-.877a10.746 10.746 0 0 1-.683-1.845 38.722 38.722 0 0 1-.396-1.575 12.67 12.67 0 0 1-.136-.598l-.002-.01c-.406-1.778-.865-3.645-1.655-5.142A8.263 8.263 0 0 0 11.52 4.8a5.136 5.136 0 0 0-1.748-1.34A4.892 4.892 0 0 0 7.654 3c-1.036 0-2.754.338-4.217 2.228.466.223.867.562 1.164.984.305.433.499.933.565 1.458.076.563.256 1.654.47 2.688l.001.007c.021.11.042.221.073.342.126-.34.25-.642.38-.955l.112-.271.128-.293c.235-.55.726-1.496 1.324-1.496.213 0 .513 0 .95.844.296.606.532 1.239.706 1.89.138.507.276 1.047.394 1.587.04.148.07.296.101.444l.006.028c.427 1.879.875 3.69 1.644 5.187.159.317.34.622.545.911.15.215.31.422.48.62 1.27 1.45 2.733 1.8 3.843 1.8 1.548 0 3.738-.698 5.35-4.006.822-1.7 1.515-4.208 1.772-5.48.256-1.27.449-2.419.534-3.115.04-.307.023-.618-.051-.918-.075-.299-.205-.579-.382-.825a2.247 2.247 0 0 0-.653-.607 2.143 2.143 0 0 0-.826-.296z"/></svg>
  ) },
  { name: 'HackerRank', x: 88, y: 353, trace: 'M 222 296 V 353 H 116', td: '.21s', cd: '.31s', pd: '-0.7s', svg: (
    <svg viewBox="0 0 24 24"><defs><clipPath id="plHrClip"><rect width="24" height="24" rx="5.6"/></clipPath></defs><path clipPath="url(#plHrClip)" fill="#00EA64" d="M0 0v24h24V0zm9.95 8.002h1.805c.061 0 .111.05.111.111v7.767c0 .061-.05.111-.11.111H9.95c-.061 0-.111-.05-.111-.11v-2.87H7.894v2.87c0 .06-.05.11-.11.11H5.976a.11.11 0 01-.11-.11V8.112c0-.06.05-.11.11-.11h1.806c.061 0 .11.05.11.11v2.869H9.84v-2.87c0-.06.05-.11.11-.11zm2.999 0h5.778c.061 0 .111.05.111.11v7.767a.11.11 0 01-.11.112h-5.78a.11.11 0 01-.11-.11V8.111c0-.06.05-.11.11-.11z"/></svg>
  ) },
  { name: 'CodeSignal', x: 532, y: 210, trace: 'M 430 210 H 504', td: '.35s', cd: '.45s', pd: '-2.6s', svg: (
    <svg viewBox="0 0 24 24"><path fill="#2E79FF" d="M24 1.212 13.012 2.787 12 5.62l-1.01-2.833L0 1.212 3.672 11.45l4.512.646 3.815 10.691 3.816-10.691 4.512-.646zm-3.625 4.406-4.52.648-.73 2.044 4.517-.647-.734 2.047-4.514.647L12 17.064l-2.393-6.707-4.514-.647-.735-2.047 4.518.647-.73-2.044-4.52-.648-.735-2.047 6.676.956L12 11.345l2.434-6.818 6.676-.956Z"/></svg>
  ) },
  { name: 'CoderPad', x: 532, y: 328, trace: 'M 398 290 V 328 H 504', td: '.42s', cd: '.52s', pd: '-0.4s', svg: (
    <svg viewBox="0 0 24 24"><path d="M9.1 8.45 5.55 12l3.55 3.55M14.9 8.45 18.45 12l-3.55 3.55" stroke="#E8354B" strokeWidth="2.05" fill="none" strokeLinecap="round" strokeLinejoin="round"/><path d="m13.02 7.55-2.04 8.9" stroke="#E8354B" strokeWidth="2.05" strokeLinecap="round"/></svg>
  ) },
];

// ── Glass starfield orb — reverse-engineered from x.ai/voice (2026) ──
// Source: live AgentOrb on https://x.ai/voice (chunk starfield shader).
// DOM recipe: circular clip-path + soft closest-side mask + one glass-ring
// inset box-shadow. GPU: dual-layer (front + refracted back wall), multi-axis
// tumble, milky-way band with INTEGER lon frequencies (no seam crease),
// three star scales with diffraction spikes, drifting key lights, fresnel.
// Palette: gold/obsidian for minicaai. CSS galaxy remains the no-WebGL fallback.
const ORB_VERT = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main(){
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const ORB_FRAG = `
precision highp float;
#define DUAL_LAYER
varying vec2 vUV;
uniform vec2 uRes;
uniform vec3 uBg;
uniform vec3 uAnchor, uC0, uC1, uC2;
uniform float uTime, uPhase, uAudio, uSpin, uArch, uLens;
/* kept so older uniform writes never fail to link */
uniform float uT;
uniform float uDpr;

float h1(float x){ return fract(sin(x * 127.1) * 43758.5453); }

/* ── starfield: a real galaxy in a glass sphere (x.ai recipe) ──
   Tilted galactic band, dark dust lanes, three star scales, warm core.
   lon frequencies are INTEGERS so the ±π wrap never stamps a crease. */
vec4 starfield(vec3 n, float t){
  float lon = atan(n.z, n.x);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float v1 = fract(uPhase*7.13);
  float v2 = fract(uPhase*3.71);
  float v3 = fract(uPhase*5.37);

  /* galactic plane — soft undulating band */
  float gb = lat + (0.15 + 0.4*v1)*sin(lon*(1.0 + floor(v2*2.0)) + 1.3)
           + 0.12*sin(lon*3.0 + t*0.1);
  float band = exp(-gb*gb*(5.0 + 10.0*v3));
  float at = uArch >= 0.0 ? uArch : floor(fract(uPhase * 9.73) * 4.0);
  float isNeb = step(0.5, at) * (1.0 - step(1.5, at));
  float isCore = step(1.5, at) * (1.0 - step(2.5, at));
  float isDeep = step(2.5, at);
  band = mix(band, max(band, 0.8), isNeb);
  band *= 1.0 - 0.85 * isDeep;

  /* nebula wisps + dark dust lanes carved through the bright band */
  float n1 = sin(lon*2.0 + sin(lat*3.0 + t*0.25)*1.6 + t*0.15);
  float n2 = sin(lon*5.0 - sin(lat*4.0 - t*0.2)*1.2 - t*0.22 + 2.4);
  float neb = pow(0.5 + 0.5*n1, 2.0)*(0.45 + 0.55*pow(0.5 + 0.5*n2, 2.0));
  float lane = pow(0.5 + 0.5*sin(lon*4.0 + lat*7.0 + sin(lon*2.0)*2.0), 3.0);
  float galaxy = clamp(band*neb*(1.0 - lane*(0.55 + 0.35*v2)), 0.0, 1.0);

  vec3 hue = mix(mix(uC0, uC1, v1), mix(uC1, uC2, v3), 0.5 + 0.5*sin(lon + lat*2.0 - t*0.2));
  vec3 hueGrey = vec3(dot(hue, vec3(0.299, 0.587, 0.114)));
  hue = clamp(hueGrey + (hue - hueGrey)*1.45, 0.0, 1.0);
  vec3 dust = mix(vec3(0.72, 0.78, 0.92), hue, 0.45 + 0.3*v1 + 0.45*isNeb);
  vec3 col = dust * galaxy * (0.6 + 0.9 * isNeb);

  /* faint shear lines — the galaxy visibly turns */
  float shear = sin(lon*13.0 + lat*4.0 - t*0.35)*sin(lon*5.0 + t*0.2);
  col += dust*band*neb*max(shear, 0.0)*0.10;

  /* second arm for spiral depth */
  float gb2 = lat - (0.35 + 0.25*v2)*sin(lon*2.0 - 1.1) + 0.4;
  float arm = exp(-gb2*gb2*7.0)*neb;
  col += mix(dust, uC1, 0.35)*arm*0.20;

  vec3 voidGlow = mix(vec3(0.04, 0.03, 0.1), mix(uC0, mix(uC1, uC2, v3), v1)*0.22, 0.75);
  col += voidGlow*(0.5 + 0.22*sin(t*0.4 + lon))*(0.4 + 0.6*band);

  col += vec3(1.0, 0.88, 0.68)*pow(band, 4.0)*pow(neb, 2.0)*0.4;
  float ca = v2 * 6.28318;
  vec3 Cdir = normalize(vec3(cos(ca)*0.85, 0.6*(v3 - 0.5), sin(ca)*0.85));
  float bulge = max(dot(n, Cdir), 0.0);
  col += mix(vec3(1.0, 0.85, 0.6), uC2, 0.25)*(pow(bulge, 14.0)*1.6 + pow(bulge, 4.0)*0.5)*isCore;

  float pocket = pow(neb, 5.0)*band*(0.7 + 0.3*sin(t*0.6 + lon*3.0));
  col += mix(uC2, uC0, fract(v1 + 0.5*sin(lon*2.0)))*pocket*(0.5 + 0.4*v2 + 0.8*isNeb);

  /* milky grain along the band */
  float detail = smoothstep(90.0, 200.0, uRes.y);
  vec2 gg = vec2(lon, lat)*34.0;
  vec2 gc = floor(gg), gf = fract(gg);
  float gh = h1(gc.x*3.7 + gc.y*11.3);
  vec2 gp = vec2(0.2 + 0.6*h1(gh*91.0), 0.2 + 0.6*h1(gh*47.0));
  float gd = length((gf - gp)*vec2(cos(lat), 1.0));
  float grain = exp(-gd*gd*700.0*clamp(uRes.y/420.0, 0.22, 1.0))*step(0.3, gh)*(0.15 + 0.85*band);
  col += vec3(0.88, 0.9, 1.0)*grain*0.38*detail;

  float w = clamp(galaxy*0.7 + pow(band, 4.0)*0.25, 0.0, 1.0);

  /* three star scales — few bright, many mid, dense faint */
  for(int s = 0; s < 3; s++){
    float K = s == 0 ? 6.0 : (s == 1 ? 11.0 : 19.0);
    vec2 g = vec2(lon, lat)*K;
    vec2 cell = floor(g), f = fract(g);
    float hx = h1(cell.x*13.7 + cell.y*7.3 + float(s)*91.0);
    float hy = h1(cell.x*5.1 + cell.y*17.9 + float(s)*37.0);
    vec2 sp = vec2(0.15 + 0.7*hx, 0.15 + 0.7*hy);
    float d = length((f - sp)*vec2(cos(lat), 1.0));
    float keep = step((s == 2 ? 0.3 : 0.55), h1(hx*89.0 + hy*31.0) + band*0.25);
    float resFac = clamp(uRes.y/420.0, 0.22, 1.0);
    float tw = mix(0.92, 0.6 + 0.4*sin(t*(1.5 + 3.0*hx) + hx*40.0), resFac);
    float hz = h1(hx*53.0 + hy*71.0 + cell.x);
    float sizeJit = 0.35 + 1.8*hz*hz;
    float sharp = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0))/sizeJit*resFac;
    float star = exp(-d*d*sharp)*keep*tw;
    vec3 tint = mix(vec3(1.0), hx < 0.33 ? vec3(0.85, 0.9, 1.0) : (hx < 0.66 ? vec3(1.0, 0.95, 0.85) : mix(vec3(1.0), uC1, 0.3)), 0.55);
    float bright = (s == 0 ? 1.9 : (s == 1 ? 1.0 : 0.55))*(0.55 + 0.7*sizeJit);
    float starFade = mix(s == 2 ? 0.18 : 0.5, 1.0, detail);
    col += tint*star*bright*starFade;
    if(s == 0){
      float big = smoothstep(1.2, 2.0, sizeJit);
      col += tint*exp(-d*d*60.0)*0.18*big*tw*starFade;
      /* diffraction-cross sparkle on the biggest stars */
      vec2 dd = (f - sp)*vec2(cos(lat), 1.0);
      float spike = exp(-dd.x*dd.x*1200.0)*exp(-dd.y*dd.y*26.0)
                  + exp(-dd.y*dd.y*1200.0)*exp(-dd.x*dd.x*26.0);
      col += tint*spike*0.28*big*tw*starFade;
      w = max(w, spike*0.3*big*starFade);
    }
    w = max(w, star*min(bright, 1.5)*starFade);
  }

  /* one soft pulsar per orb */
  float pa = v1*6.28318;
  vec3 P = normalize(vec3(sin(pa)*0.9, 1.4*(v2 - 0.5), cos(pa)*0.9));
  float pd = max(dot(n, P), 0.0);
  float beat = pow(0.5 + 0.5*sin(t*(1.2 + v3) + v3*6.28), 8.0);
  col += vec3(0.9, 0.95, 1.0)*(pow(pd, 900.0)*(0.55 + beat) + pow(pd, 110.0)*0.4*beat);
  w = max(w, pow(pd, 900.0)*0.55);

  return vec4(min(col, vec3(1.0)), min(w, 1.0));
}

/* Multi-axis tumble — roll + precessing tilt + CPU spin (x.ai sphereAt) */
vec4 sphereAt(vec3 n, float spin, float t){
  float roll = t*0.13;
  float cr = cos(roll), sr = sin(roll);
  n = vec3(cr*n.x - sr*n.y, sr*n.x + cr*n.y, n.z);
  float tilt = 0.45 + 0.35*sin(t*0.24);
  float cx = cos(tilt), sx = sin(tilt);
  n = vec3(n.x, cx*n.y - sx*n.z, sx*n.y + cx*n.z);
  float cs = cos(spin), ss = sin(spin);
  n = vec3(cs*n.x + ss*n.z, n.y, -ss*n.x + cs*n.z);
  return starfield(n, t);
}

vec3 shade(vec2 p){
  float r = length(p);
  float t = uTime * 0.8 + uPhase;
  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr * rr);
  vec3 N = vec3(p.x, p.y, z);
  float fres = pow(1.0 - z, 2.4);

  vec3 I = vec3(0.0, 0.0, -1.0);
  vec3 R = refract(I, N, 0.75);
  float dHit = -2.0 * dot(N, R);
  vec3 B = normalize(N + R * dHit);

  float sv = fract(uPhase * 6.31);
  float sw = fract(uPhase * 2.17);
  float tWarp = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);
  vec4 front = sphereAt(N, uSpin, tWarp);
#ifdef DUAL_LAYER
  vec4 back = sphereAt(B, uSpin, tWarp * 0.8 + 2.7);
#else
  vec4 back = vec4(0.0);
#endif

  vec3 voidCol = mix(uAnchor * 0.04, uAnchor * 0.35, fres);
  vec3 col = mix(uBg, voidCol, 0.97 - 0.04 * fres);
  float fa = clamp(front.a, 0.0, 1.0);
  float ba = clamp(back.a, 0.0, 1.0);
  col = mix(col, back.rgb, ba * 0.16);
  col = mix(col, front.rgb, fa * 0.85);

  vec3 LD = normalize(vec3(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
  float diffuse = (0.62 + 0.65 * max(dot(N, LD), 0.0)) * (1.0 + 0.35 * uAudio);
  col *= diffuse;
  vec3 voiceCol = mix(uC1, vec3(1.0, 0.97, 0.9), 0.45);
  col += voiceCol * pow(1.0 - rr, 1.8) * uAudio * 0.5;
  col += (uC1 * 0.7 + vec3(0.12)) * fres * uAudio * 0.65;
  float counter = max(dot(N.xy, -LD.xy), 0.0) * fres;
  col += mix(uC0, vec3(0.5, 0.6, 0.9), 0.5) * counter * 0.18;

  vec3 L1 = normalize(vec3(-0.45 + 0.3 * sin(t * 0.34), 0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  col += vec3(1.0) * pow(max(dot(N, L1), 0.0), 150.0) * (0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2)));
  vec3 LS = normalize(vec3(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  col += vec3(1.0) * pow(max(dot(N, LS), 0.0), 7.0) * 0.05;
  vec3 L2 = normalize(vec3(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69));
  col += vec3(1.0) * pow(max(dot(N, L2), 0.0), 140.0) * 0.25;
  col = mix(col, front.rgb, fa * fres * 0.3);
  float limb = smoothstep(0.94, 1.0, rr);
  col = mix(col, col * 0.85, limb * 0.4);
  return col;
}

void main(){
  vec2 p = vUV * 2.0 - 1.0;
  if (uLens > 0.0) {
    float r = length(p);
    float ex = exp(2.0 * 1.7724539 * (r - 0.9) / 0.1414214);
    float fall = 0.5 + 0.5 * (ex - 1.0) / (ex + 1.0);
    if (fall > 0.004) {
      float swell = 1.0 + 0.16 * (0.6 * sin(uTime * 0.9 + uPhase)
                                + 0.4 * sin(uTime * 1.7 + uPhase * 1.3));
      float k = uLens * fall * swell;
      float cR = 1.4 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase));
      float cG = 1.2 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 2.1));
      float cB = 1.0 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 4.2));
      vec3 col = vec3(shade(p * (1.0 - k * cR)).r,
                      shade(p * (1.0 - k * cG)).g,
                      shade(p * (1.0 - k * cB)).b);
      vec2 a2 = min(abs(p), 1.0);
      float lobe = max(abs(a2.x * 0.766 + a2.y * 0.643), abs(a2.x * 0.766 - a2.y * 0.643));
      float glow = 0.65 * pow(clamp((lobe - 0.0707) / 1.3435, 0.0, 1.0), 2.4) * fall;
      glow += 1.02 * clamp(1.0 + (r - 1.0) / 0.15, 0.0, 1.0) * step(r, 1.0) * pow(lobe, 2.0);
      col += vec3(0.25) * min(glow, 1.0);
      gl_FragColor = vec4(col, 1.0);
      return;
    }
  }
  gl_FragColor = vec4(shade(p), 1.0);
}`;

// Same WebGL nebula orb on laptop AND phone. Mobile used to skip WebGL and
// fall back to a different CSS look; that is gone. Hardening rules so phones
// keep the *identical* shader path without the blank-disc / freeze bugs:
//   1) CSS galaxy stays visible until N successful GPU frames paint
//   2) .pl-orb-live only then (never hide CSS before the canvas has content)
//   3) canvas sized to the real CSS box × dpr (not a hard-coded 480 that
//      mismatches the scaled mobile stage)
//   4) phones never pause RAF while the document is visible (IO pause was
//      freezing spin mid-scroll); desktop still pauses when fully off-screen
//   5) context-lost demotes to CSS (no blank disc) and remounts once to retry
const NebulaOrbCanvas: React.FC = () => {
  const ref = useRef<HTMLCanvasElement>(null);
  // Bump to remount after a context-lost recovery attempt.
  const [boot, setBoot] = useState(0);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const globe = cv.closest('.pl-galaxy-globe');
    const isMobile = typeof window !== 'undefined'
      && !!window.matchMedia?.('(max-width: 767px)').matches;

    // Restore canvas if a prior demote hid it.
    cv.style.display = '';
    globe?.classList.remove('pl-orb-live');

    // Prefer default power on mobile — high-performance can be throttled or
    // pre-empted more aggressively on iOS thermal/battery paths.
    const gl = cv.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: isMobile ? 'default' : 'high-performance',
    }) as WebGLRenderingContext | null;
    if (!gl || gl.isContextLost()) return;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[orb]', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, ORB_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, ORB_FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUV');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uT = gl.getUniformLocation(prog, 'uT');
    const uSpin = gl.getUniformLocation(prog, 'uSpin');
    const uPhase = gl.getUniformLocation(prog, 'uPhase');
    const uDpr = gl.getUniformLocation(prog, 'uDpr');
    const uLens = gl.getUniformLocation(prog, 'uLens');
    const uAudio = gl.getUniformLocation(prog, 'uAudio');
    const uArch = gl.getUniformLocation(prog, 'uArch');
    const uBg = gl.getUniformLocation(prog, 'uBg');
    const uAnchor = gl.getUniformLocation(prog, 'uAnchor');
    const uC0 = gl.getUniformLocation(prog, 'uC0');
    const uC1 = gl.getUniformLocation(prog, 'uC1');
    const uC2 = gl.getUniformLocation(prog, 'uC2');
    gl.uniform1f(uPhase, 0.37);
    gl.uniform1f(uAudio, 0.0);
    gl.uniform1f(uArch, 0.0);
    gl.uniform3f(uBg, 0.004, 0.004, 0.007);
    gl.uniform3f(uAnchor, 0.83, 0.68, 0.39);
    gl.uniform3f(uC0, 0.83, 0.68, 0.39);
    gl.uniform3f(uC1, 0.55, 0.48, 0.95);
    gl.uniform3f(uC2, 0.96, 0.90, 0.72);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // Layout size (240 CSS) — NOT getBoundingClientRect, which includes the
    // mobile stage scale(0.55) and would undersample the buffer.
    const syncSize = () => {
      const css = Math.max(120, Math.round(cv.clientWidth || cv.parentElement?.clientWidth || 240));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.min(1280, Math.max(240, Math.round(css * dpr)));
      if (cv.width !== px || cv.height !== px) {
        cv.width = px;
        cv.height = px;
      }
      gl.viewport(0, 0, px, px);
      gl.uniform2f(uRes, px, px);
      gl.uniform1f(uDpr, dpr);
      gl.uniform1f(uLens, css >= 48 ? 0.4 : 0.0);
    };
    syncSize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncSize) : null;
    ro?.observe(cv);

    // Exact same spin model as the original desktop orb.
    const reduce = prefersReduce();
    const spinBase = 0.18;
    const spinWave = 0.06;
    let raf = 0;
    // Phones: keep spinning whenever the tab is visible. Desktop may pause
    // when the theater is fully off-screen to save GPU.
    let visible = true;
    let live = false;
    let goodFrames = 0;
    const PROMOTE_AFTER = 3; // never hide CSS on frame 0/1 blank
    const t0 = performance.now();
    let spin = 0;
    let last = t0;
    let dead = false;
    let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;

    const demoteToCss = (retry: boolean) => {
      if (dead) return;
      dead = true;
      live = false;
      goodFrames = 0;
      cancelAnimationFrame(raf);
      globe?.classList.remove('pl-orb-live');
      // Keep canvas in DOM but transparent — CSS galaxy shows through.
      cv.style.opacity = '0';
      cv.style.pointerEvents = 'none';
      if (retry && boot < 2) {
        retryTimer = setTimeout(() => setBoot((b) => b + 1), 900);
      }
    };

    const draw = (now: number) => {
      if (dead || gl.isContextLost()) {
        demoteToCss(true);
        return;
      }
      // iOS can suspend RAF while the tab is still "visible" — clamp dt so
      // spin doesn't jump, and keep going.
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      spin += dt * (spinBase + spinWave * Math.sin(now * 0.0004));
      const tSec = (now - t0) / 1000 + 18;
      gl.uniform1f(uTime, tSec);
      gl.uniform1f(uT, tSec);
      gl.uniform1f(uSpin, spin);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (!live) {
        goodFrames += 1;
        if (goodFrames >= PROMOTE_AFTER) {
          live = true;
          cv.style.opacity = '1';
          globe?.classList.add('pl-orb-live');
        }
      }

      const pageOk = !document.hidden;
      // Mobile: ignore IntersectionObserver freezes — always spin if page open.
      const shouldRun = !reduce && pageOk && (isMobile || visible);
      if (shouldRun) raf = requestAnimationFrame(draw);
    };

    const kick = () => {
      if (dead || reduce || gl.isContextLost()) return;
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };

    const onLost = (e: Event) => {
      e.preventDefault();
      demoteToCss(true);
    };
    const onRestored = () => {
      // Full re-init via remount — getContext state after restore is messy.
      setBoot((b) => b + 1);
    };
    cv.addEventListener('webglcontextlost', onLost, false);
    cv.addEventListener('webglcontextrestored', onRestored, false);

    const scrollRoot = cv.closest('.pl-root') as Element | null;
    const observeEl = (cv.closest('.pl-theater') as Element | null) || cv;
    const io = new IntersectionObserver(([e]) => {
      if (isMobile) {
        // Mobile keeps spinning; only track for optional future use.
        visible = true;
        return;
      }
      const was = visible;
      visible = e.isIntersecting;
      if (visible && !was) kick();
    }, scrollRoot
      ? { root: scrollRoot, threshold: 0.01, rootMargin: '120px 0px' }
      : { threshold: 0.01, rootMargin: '120px 0px' });
    io.observe(observeEl);

    const onVis = () => {
      if (!document.hidden) kick();
    };
    document.addEventListener('visibilitychange', onVis);
    // iOS Safari: visual viewport / bfcache resumes
    window.addEventListener('pageshow', onVis);
    window.addEventListener('focus', onVis);

    // Start transparent until promote — CSS galaxy is the safety backdrop.
    cv.style.opacity = '0';
    kick();

    return () => {
      io.disconnect();
      ro?.disconnect();
      cancelAnimationFrame(raf);
      if (retryTimer) clearTimeout(retryTimer);
      cv.removeEventListener('webglcontextlost', onLost);
      cv.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', onVis);
      window.removeEventListener('focus', onVis);
      globe?.classList.remove('pl-orb-live');
    };
  }, [boot]);

  return <canvas ref={ref} className="pl-orb-canvas" aria-hidden="true" />;
};

// ── The answer-stream silk — the hero card's own living graphic ──
// A different instrument than the globe: where the orb is a black crystal
// full of stars, this is the CONVERSATION made visible — three ribbons of
// golden light streaming through the card's glass behind the copy, warped
// by the same fbm language, with fine thread grain along the flow.
// Scroll is the second clock: scrolling advances the stream's phase and
// flares it slightly (the x.ai trick — ambient GPU graphics that answer
// the scroll). Whisper-quiet by design (alpha ceiling 0.30) so the type
// stays the loudest thing on the card. Transparent canvas = graceful
// no-WebGL fallback; same StrictMode-safe lifecycle as the orb (never
// loseContext in cleanup).
const SILK_FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uT;
uniform float uScroll;

float h21(vec2 p){ p = fract(p*vec2(234.34, 435.345)); p += dot(p, p+34.23); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = h21(i), b = h21(i+vec2(1.0,0.0)), c = h21(i+vec2(0.0,1.0)), d = h21(i+vec2(1.0,1.0));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for(int i = 0; i < 4; i++){ v += a*vnoise(p); p = r*p*2.03; a *= 0.55; }
  return v;
}

void main(){
  vec2 uv = gl_FragCoord.xy/uRes;
  vec2 p = vec2(uv.x*uRes.x/uRes.y, uv.y);
  /* two clocks: time drifts the stream, scroll scrubs it forward */
  float t = uT*0.06 + uScroll*1.4;

  /* three silk ribbons — soft ridges of light advected along the card */
  float silk = 0.0;
  for(int i = 0; i < 3; i++){
    float fi = float(i);
    float y0 = 0.30 + 0.22*fi;
    float w = fbm(vec2(p.x*1.35 - t*(0.7 + 0.25*fi), fi*7.7 + t*0.11));
    float yy = y0 + (w - 0.5)*0.34;
    float d = uv.y - yy;
    /* bottom-heavy weights: light pools under the answer, not the header */
    silk += exp(-d*d*340.0)*(0.62 - 0.10*fi) + exp(-d*d*34.0)*0.16;
  }

  /* fine threads along the flow — the weave of the silk */
  silk *= 0.72 + 0.28*fbm(vec2(p.x*6.0 - t*2.2, uv.y*30.0));

  /* scroll flares the stream a breath as it rushes on */
  silk *= 1.0 + 0.35*min(uScroll, 1.2);

  /* stay out of the card header, die before the edges */
  silk *= smoothstep(0.96, 0.82, uv.y)*smoothstep(0.0, 0.10, uv.y);
  silk *= smoothstep(0.0, 0.06, uv.x)*smoothstep(1.0, 0.94, uv.x);

  /* deep amber shadows to pale gold highlights, premultiplied whisper */
  vec3 gold = mix(vec3(0.36, 0.26, 0.10), vec3(0.96, 0.89, 0.69), clamp(silk, 0.0, 1.0));
  float a = clamp(silk, 0.0, 1.0)*0.38;
  gl_FragColor = vec4(gold*a, a);
}`;

const SilkStreamCanvas: React.FC = () => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const gl = cv.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'low-power' }) as WebGLRenderingContext | null;
    if (!gl || gl.isContextLost()) return; // canvas stays transparent — card unchanged
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('[silk]', gl.getShaderInfoLog(sh)); return null; }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, 'attribute vec2 aP; void main(){ gl_Position = vec4(aP, 0.0, 1.0); }');
    const fs = compile(gl.FRAGMENT_SHADER, SILK_FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aP = gl.getAttribLocation(prog, 'aP');
    gl.enableVertexAttribArray(aP);
    gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uT = gl.getUniformLocation(prog, 'uT');
    const uScroll = gl.getUniformLocation(prog, 'uScroll');
    // The card is fluid-width: track its box. dpr capped at 1.5 — the silk
    // is soft gradients, and the card canvas is ~20x the orb's pixel count.
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const size = () => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(2, Math.round(r.width * dpr));
      cv.height = Math.max(2, Math.round(r.height * dpr));
      gl.viewport(0, 0, cv.width, cv.height);
      gl.uniform2f(uRes, cv.width, cv.height);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    // Scroll clock: the landing scrolls on .pl-root (position:fixed), not
    // the window. One normalized value, read passively, fed per frame.
    const root = cv.closest('.pl-root') as HTMLElement | null;
    let scroll = 0;
    const onScroll = () => {
      if (root) scroll = Math.min(1.6, root.scrollTop / Math.max(1, window.innerHeight));
    };
    root?.addEventListener('scroll', onScroll, { passive: true });
    const reduce = prefersReduce();
    let raf = 0;
    let visible = true;
    const t0 = performance.now();
    const draw = (now: number) => {
      gl.uniform1f(uT, (now - t0) / 1000 + 60); // open mid-stream
      gl.uniform1f(uScroll, scroll);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduce && visible) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      const was = visible;
      visible = e.isIntersecting;
      if (visible && !was && !reduce) { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
    }, root ? { root, threshold: 0.01 } : { threshold: 0.01 });
    io.observe(cv);
    raf = requestAnimationFrame(draw); // at least one frame, even reduced
    return () => {
      io.disconnect();
      ro.disconnect();
      root?.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
      // No loseContext here — StrictMode re-runs this effect on the same
      // canvas; a killed context would silently blank the card forever.
    };
  }, []);
  return <canvas ref={ref} className="pl-silk-canvas" aria-hidden="true" />;
};

// ── Answer Theater ────────────────────────────────────────────────
// Plays the real shape of a live answer, once the section scrolls into
// view: the question arrives, the depth is read, the covering line lands
// while you're still drawing breath, the full answer continues without a
// seam, and on Ultra/Enterprise the code types itself into the editor.
//
// No engineering internals on screen — a candidate should read this and
// understand what they'll EXPERIENCE, not how it's built.
//
// Character streaming writes textContent through refs, so a 1,400-char
// sequence costs zero React renders; only the five coarse beat changes
// re-render. Paused entirely while off-screen, and under
// prefers-reduced-motion it renders the finished state and never moves.
const AT_QUESTION = 'Design a fraud-detection pipeline that scores every transaction in under 50 ms.';
const AT_COVER = "The way I'd frame this is around a streaming backbone, with the scoring kept off the write path.";
const AT_REST = ' Concretely — Kafka for ingest, features precomputed in Redis so a lookup is a single hop, and the model behind a feature cache. That holds p99 under 50 ms even when volume spikes.';
const AT_CODE = 'def score(txn, feats):\n    f = feats.get(txn.card_id)\n    if f is None:\n        return FALLBACK\n    return model.predict(f, txn)';

const AT_CAPTIONS: { t: string; b: string }[] = [
  { b: 'They ask.', t: 'minicaai hears the question as it is spoken — no clicking, no pasting.' },
  { b: 'It reads how deep the question is.', t: 'A throwaway question gets a quick answer. A hard one gets real thinking — chosen for you, every time.' },
  { b: 'You have something to say in under a second.', t: 'An opening line lands while you are still drawing breath, so you are never the person sitting in silence.' },
  { b: 'The full answer arrives underneath it.', t: 'It continues from where your opening left off — one thought, no seam, nothing to backtrack out of.' },
  { b: 'On Ultra and Enterprise, it types the code for you.', t: 'Straight into the editor at a human pace, so what appears on the screen looks like you wrote it.' },
];

/* ═══════════════════════════════════════════════════════════════════
   THE SEAM — three real questions, each answered twice
   ───────────────────────────────────────────────────────────────────
   These are not written-for-the-website examples. Every pair below is
   the shape the product actually produces: the covering line opens with
   what the candidate would ESTABLISH (never a guess at the mechanism,
   because a cover that guesses gets contradicted by the reasoning
   behind it one sentence later), and the full answer continues that
   exact sentence rather than restarting.

   `cover` / `full` are the two measured clocks — time to first word on
   screen, and time to the full answer's first token. Real numbers from
   the current build; if the engine is retuned, retune these with it.
   ═══════════════════════════════════════════════════════════════════ */
const SEAM_SCENES = [
  {
    q: 'Design exactly-once delivery from an event stream into a warehouse when the sink can’t deduplicate and you can’t change it.',
    cover: 'First thing I’d establish is what that sink actually guarantees on a retry — because if it can’t dedupe and I can’t change it, true exactly-once at that hop isn’t on the table.',
    full: 'So I’d move the guarantee upstream instead: a staging table keyed on a stable event ID, one controlled writer pushing committed batches, and a reconciliation ledger of what landed. The hop itself I’d call at-least-once and say so plainly.',
    cover_s: 0.6,
    full_s: 9.2,
  },
  {
    q: 'A Spark job that ran in twenty minutes now takes three hours. Nothing changed in the code. What do you look at, in order?',
    cover: 'Before I touch any tuning I’d prove what actually changed — the code didn’t, so it’s the data, the skew, or the cluster underneath it.',
    full: 'I’d put the last green run’s stage timings next to today’s. One stage gone wide is skew, or a partition count that stopped matching the data. Every stage slower by the same factor is the cluster — spot reclaim, a smaller pool, noisy neighbours.',
    cover_s: 0.5,
    full_s: 4.4,
  },
  {
    q: 'A stakeholder says the numbers in their dashboard are wrong. You check, and the pipeline is green. How do you handle that?',
    cover: 'A green pipeline only tells me the job finished, not that the numbers are right — so I’d start by getting one row they believe is wrong.',
    full: 'From that row I can walk backwards through each layer until the number changes, which turns “the dashboard is wrong” into one specific transform. Then I’d tell them what I found and when it’s fixed, rather than defending the pipeline.',
    cover_s: 0.6,
    full_s: 6.1,
  },
];

const SEAM_CAPS: { b: string; t: string; tone: 'pv' | 'gold' }[] = [
  { b: 'They stop talking.', t: 'This is the second everyone can hear you thinking.', tone: 'pv' },
  { b: 'You’re already speaking.', t: 'Half a second, and there is something true in your mouth.', tone: 'pv' },
  { b: 'Watch the hand-off.', t: 'Same sentence. The reasoning arrives mid-breath and takes it from here.', tone: 'pv' },
  { b: 'No restart. No repeat. No pause.', t: 'They heard one answer. It came from two.', tone: 'gold' },
];

/* One stage, four beats, three questions on rotation. */
const SeamStage: React.FC = () => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const qRef = React.useRef<HTMLSpanElement>(null);
  const coverRef = React.useRef<HTMLSpanElement>(null);
  const fullRef = React.useRef<HTMLSpanElement>(null);
  const clockRef = React.useRef<HTMLSpanElement>(null);
  const [beat, setBeat] = React.useState(0);
  const [scene, setScene] = React.useState(0);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const S = SEAM_SCENES;

    // Reduced motion: the finished frame of the first scene, held still.
    if (prefersReduce()) {
      if (qRef.current) qRef.current.textContent = S[0].q;
      if (coverRef.current) coverRef.current.textContent = S[0].cover;
      if (fullRef.current) fullRef.current.textContent = S[0].full;
      if (clockRef.current) clockRef.current.textContent = `${S[0].full_s.toFixed(1)}s`;
      setBeat(3);
      return;
    }

    let alive = true;
    let timers: number[] = [];
    let ticker: number | null = null;
    const wait = (ms: number) => new Promise<void>(res => { timers.push(window.setTimeout(res, ms)); });

    // Words, not characters.
    //
    // Character-by-character is how a person TYPES, and this is not
    // typing — it is a model emitting tokens, which arrive in clumps and
    // fast. Streaming whole words in small bursts is both truer to what
    // is actually happening and far more urgent to watch: the line
    // arrives in a rush, the way it does in the product, instead of
    // trickling out at reading speed while the viewer waits for it.
    const stream = async (node: HTMLElement | null, text: string, perWord: number) => {
      if (!node) return;
      node.textContent = '';
      const parts = text.split(/(\s+)/);
      let buf = '';
      for (let i = 0; i < parts.length; i++) {
        if (!alive) return;
        buf += parts[i];
        if (/^\s+$/.test(parts[i])) continue;      // flush on word boundaries only
        node.textContent = buf;
        // A beat of hesitation after a clause, the way speech has one.
        const tail = parts[i].slice(-1);
        const extra = tail === ',' ? perWord * 3 : (tail === '.' || tail === '—') ? perWord * 5 : 0;
        await wait(perWord + extra);
      }
      node.textContent = text;
    };

    // The clock the whole section turns on. It starts the instant the
    // covering line appears and keeps climbing WHILE the candidate is
    // already speaking — so the number on screen is the silence they are
    // not having. Ramped to land exactly on the scene's real measured
    // figure at the moment the full answer arrives.
    const runClock = (from: number, to: number, overMs: number) => {
      if (ticker !== null) window.clearInterval(ticker);
      const t0 = Date.now();
      const write = (v: number) => { if (clockRef.current) clockRef.current.textContent = `${v.toFixed(1)}s`; };
      write(from);
      ticker = window.setInterval(() => {
        const p = Math.min(1, (Date.now() - t0) / overMs);
        write(from + (to - from) * p);
        if (p >= 1 && ticker !== null) { window.clearInterval(ticker); ticker = null; }
      }, 60);
    };

    const cycle = async () => {
      let i = 0;
      while (alive) {
        const s = S[i % S.length];
        setScene(i % S.length);
        setBeat(0);
        [qRef, coverRef, fullRef].forEach(r => { if (r.current) r.current.textContent = ''; });
        if (clockRef.current) clockRef.current.textContent = '0.0s';
        await wait(300);

        await stream(qRef.current, s.q, 62);                 // they ask
        if (!alive) return;
        await wait(340);

        setBeat(1);                                          // the covering line
        runClock(s.cover_s, s.full_s, 4600);
        await stream(coverRef.current, s.cover, 58);
        if (!alive) return;
        // The hold is the point: the caret blinks, the clock climbs, and
        // for these two seconds the candidate is talking and the model is
        // still thinking. Cutting it short throws away the whole idea.
        await wait(1500);

        setBeat(2);                                          // the handover
        await wait(1000);
        if (!alive) return;

        setBeat(3);                                          // the full answer
        if (clockRef.current) clockRef.current.textContent = `${s.full_s.toFixed(1)}s`;
        if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
        await stream(fullRef.current, s.full, 46);           // lands fast — it was ready
        if (!alive) return;
        await wait(4600);                                    // hold, then rotate
        i++;
      }
    };

    // Only play while the stage is on screen.
    let running = false;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !running) { running = true; alive = true; cycle(); }
      else if (!e.isIntersecting && running) {
        running = false; alive = false;
        timers.forEach(clearTimeout); timers = [];
        if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
      }
    }, { threshold: 0.2 });
    io.observe(el);

    return () => {
      alive = false; io.disconnect();
      timers.forEach(clearTimeout);
      if (ticker !== null) window.clearInterval(ticker);
    };
  }, []);

  const cap = SEAM_CAPS[beat] || SEAM_CAPS[0];

  return (
    <div style={{ position: 'relative' }}>
      <div className="pl-seam" ref={rootRef} data-beat={beat} aria-hidden="true">
        <div className="pl-seam-head">
          <span className="pl-seam-live"><i />Live interview</span>
          <span className="pl-seam-pips">
            {SEAM_SCENES.map((_, i) => <b key={i} data-on={i === scene ? '1' : '0'} />)}
          </span>
        </div>

        <div className="pl-seam-body">
          <div className="pl-seam-ask">
            <span className="pl-seam-wave">
              {[0, 1, 2, 3, 4].map(i => <i key={i} style={{ animationDelay: `${i * 110}ms` }} />)}
            </span>
            <span className="pl-seam-q">“<span ref={qRef} />”</span>
          </div>

          {/* ONE plate, ONE paragraph. The seam is the point inside the
              running text where the colour changes hands — there is no
              divider, because in the product there is nothing between
              them either. */}
          <div className="pl-seam-say">
            <span className="pl-seam-wipe" aria-hidden />
            <span className="pl-seam-stamp">out loud, from 0.6s</span>
            <p className="pl-seam-said">
              <span className="pl-seam-c" ref={coverRef} />
              <span className="pl-seam-caret" />
              <span className="pl-seam-stitch" />
              <span className="pl-seam-f" ref={fullRef} />
            </p>
          </div>

          <div className="pl-seam-meta">
            <span>{beat >= 3 ? 'Full reasoning landed at' : 'Still reasoning'}</span>
            <span className="pl-seam-clock" ref={clockRef}>0.0s</span>
            <span className="pl-seam-bar"><b /></span>
          </div>
        </div>

        <div className="pl-seam-cap" data-tone={cap.tone}>
          <span><b>{cap.b}</b> {cap.t}</span>
        </div>
      </div>

      {/* The legend. The stage shows the mechanism; this names it, so a
          first-time visitor is not left guessing why the sentence is two
          colours. */}
      <div className="pl-seam-legend">
        <div className="pl-seam-leg" data-v="pv">
          <span className="pl-seam-swatch" aria-hidden />
          <div>
            <strong>The covering line</strong>
            <span>Lands in about half a second, so you start talking while they’re still settling. It only ever commits to what you’d <em>establish</em> first — so there is nothing in it to walk back.</span>
          </div>
        </div>
        <div className="pl-seam-leg" data-v="gold">
          <span className="pl-seam-swatch" aria-hidden />
          <div>
            <strong>The real answer</strong>
            <span>The full reasoning, seconds later. It doesn’t restart your sentence and it doesn’t repeat you — it finishes the one you’re already saying.</span>
          </div>
        </div>
      </div>

      {/* The stage is decorative; this is the same meaning in prose, once,
          for assistive tech and crawlers. */}
      <p className="pl-sr-only">
        A hard interview question is answered twice. About half a second in, a covering line
        arrives that you start speaking immediately — it commits only to what you would
        establish first, so nothing in it can be contradicted. The full reasoning lands
        seconds later and continues the same sentence rather than restarting it.
        {SEAM_SCENES.map(sc => ` Asked: ${sc.q} You say: ${sc.cover} ${sc.full}`).join('')}
      </p>
    </div>
  );
};

const AnswerTheater: React.FC = () => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const qRef = React.useRef<HTMLSpanElement>(null);
  const coverRef = React.useRef<HTMLSpanElement>(null);
  const restRef = React.useRef<HTMLSpanElement>(null);
  const codeRef = React.useRef<HTMLSpanElement>(null);
  const [beat, setBeat] = React.useState(0);
  const [cover, setCover] = React.useState(0);
  const beatRef = React.useRef(0);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    // Reduced motion: show the finished frame, never animate.
    if (prefersReduce()) {
      if (qRef.current) qRef.current.textContent = AT_QUESTION;
      if (coverRef.current) coverRef.current.textContent = AT_COVER;
      if (restRef.current) restRef.current.textContent = AT_REST;
      if (codeRef.current) codeRef.current.textContent = AT_CODE;
      setBeat(4); setCover(1);
      return;
    }

    let alive = true;
    let timers: number[] = [];
    const wait = (ms: number) => new Promise<void>(res => { timers.push(window.setTimeout(res, ms)); });
    const setB = (n: number) => { beatRef.current = n; setBeat(n); };

    // Stream text into a node one character at a time. Cadence varies the
    // way real typing does — a touch slower after punctuation.
    const stream = async (node: HTMLElement | null, text: string, per: number) => {
      if (!node) return;
      node.textContent = '';
      for (let i = 0; i < text.length; i++) {
        if (!alive) return;
        node.textContent += text[i];
        const ch = text[i];
        const extra = ch === ',' ? per * 4 : (ch === '.' || ch === '—') ? per * 7 : 0;
        await wait(per + extra + Math.random() * per * 0.7);
      }
    };

    const clear = () => {
      [qRef, coverRef, restRef, codeRef].forEach(r => { if (r.current) r.current.textContent = ''; });
      setCover(0);
    };

    const cycle = async () => {
      while (alive) {
        clear(); setB(0);
        await wait(700);
        await stream(qRef.current, AT_QUESTION, 21);       // they ask
        if (!alive) return;
        await wait(520);

        setB(1);                                            // depth read
        await wait(1500);
        if (!alive) return;

        setB(2);                                            // the covering line
        setCover(1);
        await stream(coverRef.current, AT_COVER, 15);
        if (!alive) return;
        await wait(420);

        setB(3);                                            // full answer continues
        await stream(restRef.current, AT_REST, 12);
        if (!alive) return;
        await wait(900);

        setB(4);                                            // Auto-Type
        await wait(420);
        await stream(codeRef.current, AT_CODE, 24);
        if (!alive) return;
        await wait(3200);                                   // hold, then loop
      }
    };

    // Only play while the stage is actually on screen.
    let running = false;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !running) { running = true; cycle(); }
      else if (!e.isIntersecting && running) {
        running = false; alive = false;
        timers.forEach(clearTimeout); timers = [];
        alive = true;                                        // re-arm for next entry
      }
    }, { threshold: 0.28 });
    io.observe(el);

    return () => { alive = false; io.disconnect(); timers.forEach(clearTimeout); };
  }, []);

  const STEPS: [string, string][] = [['Listening', 'Listen'], ['Reading depth', 'Depth'], ['Answering', 'Answer'], ['Typing', 'Type']];
  const stepOn = [beat === 0, beat === 1, beat === 2 || beat === 3, beat === 4];
  const cap = AT_CAPTIONS[beat] || AT_CAPTIONS[0];

  return (
    <div>
      <div className="pl-at" ref={rootRef} data-beat={beat} aria-hidden="true">
        <div className="pl-at-head">
          {STEPS.map(([long, short], i) => (
            <span key={long} className="pl-at-step" data-on={stepOn[i] ? '1' : '0'}>
              <span className="pl-at-pip" />
              <span className="pl-at-lg">{long}</span><span className="pl-at-sm">{short}</span>
            </span>
          ))}
        </div>

        <div className="pl-at-body">
          <div className="pl-at-ask">
            <span className="pl-at-wave">{[0, 1, 2, 3, 4].map(i => (
              <i key={i} style={{ animationDelay: `${i * 110}ms` }} />
            ))}</span>
            <span className="pl-at-qtext">“<span ref={qRef} />”</span>
          </div>

          <div className="pl-at-depth">
            <span style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--faint)' }}>Depth</span>
            <span className="pl-at-meter"><b /></span>
            <span className="pl-at-model"><PhBolt size={12} weight="fill" /> deep question · full reasoning</span>
          </div>

          <div className="pl-at-answer" data-cover={cover ? '1' : '0'}>
            <span className="pl-at-stamp">you start speaking · 0.4s</span>
            <span className="pl-at-cover" ref={coverRef} />
            <span className="pl-at-rest" ref={restRef} />
          </div>

          <div className="pl-at-ed">
            <div className="pl-at-edhead">
              <span>your editor</span>
              <span style={{ color: 'var(--gold)', letterSpacing: '.16em' }}>ULTRA &amp; ENTERPRISE · AUTO-TYPE</span>
            </div>
            <div className="pl-at-code">
              <span className="pl-at-nums">{[1, 2, 3, 4, 5].map(n => <span key={n}>{n}</span>)}</span>
              <span className="pl-at-src"><span ref={codeRef} /><span className="pl-at-cur" /></span>
            </div>
          </div>
        </div>

        <div className="pl-at-cap"><span><b>{cap.b}</b> {cap.t}</span></div>
      </div>

      {/* The same sequence as plain prose — what assistive tech and search
          engines read, since the stage itself is decorative. */}
      <p className="pl-sr-only">
        {AT_CAPTIONS.map(c => `${c.b} ${c.t}`).join(' ')}
      </p>
    </div>
  );
};

const PremiumLanding: React.FC<PremiumLandingProps> = ({ setView, pricing, handleTierSelect, isSubmitting, paymentError, onDismissPaymentError }) => {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [typed, setTyped] = useState(reduce ? HERO_LINE : '');
  const [scrolled, setScrolled] = useState(false);
  // Refund policy modal — the pricing footnote promises a 14-day window,
  // so the policy itself has to be readable BEFORE purchase, not only
  // from the post-purchase billing sheet (ManageSubscription).
  const [showRefund, setShowRefund] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lampRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const rimRef = useRef<HTMLDivElement>(null);
  const sheenRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<HTMLDivElement>(null);
  // Pop-out portal — scroll-scrubbed theory → coding crossfade (iOS/voice-portal).
  const portalRef = useRef<HTMLDivElement>(null);

  // Signature: the second headline line types itself onto the screen the way
  // the product streams an answer. Starts after a beat so the page settles.
  useEffect(() => {
    if (reduce) return;
    let i = 0;
    let iv: ReturnType<typeof setInterval>;
    const start = setTimeout(() => {
      iv = setInterval(() => {
        i += 1;
        setTyped(HERO_LINE.slice(0, i));
        if (i >= HERO_LINE.length) clearInterval(iv);
      }, 52);
    }, 1450);
    return () => { clearTimeout(start); clearInterval(iv); };
  }, [reduce]);

  // Fit the 620×420 platform stage (orb + Zoom/Meet/Teams chips) to the
  // phone width. Without this the absolute-positioned chips sit past the
  // viewport edge and get clipped by .pl-theater { overflow:hidden }.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const updateStageScale = () => {
      const avail = Math.min(root.clientWidth || window.innerWidth, window.innerWidth) - 28;
      // Floor keeps chips readable; ceiling is full desktop size.
      const scale = Math.min(1, Math.max(0.42, avail / 620));
      root.style.setProperty('--pl-stage-scale', scale.toFixed(4));
    };
    updateStageScale();
    window.addEventListener('resize', updateStageScale);
    window.addEventListener('orientationchange', updateStageScale);
    // iOS address-bar show/hide changes visual viewport without a full resize.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', updateStageScale);
    return () => {
      window.removeEventListener('resize', updateStageScale);
      window.removeEventListener('orientationchange', updateStageScale);
      vv?.removeEventListener('resize', updateStageScale);
    };
  }, []);

  // Pop-out portal scroll scrub — Theory forms, then Coding crossfades.
  // Critical reliability rules:
  //  1) Drive layers with INLINE opacity/transform (not only CSS vars).
  //  2) Never set filter:blur on the layer (kills child backdrop-filter glass).
  //  3) Progress off .pl-root + continuous rAF while portal is on-screen.
  //  4) Theory is visible as soon as the sticky stage is in view (not empty box).
  useEffect(() => {
    const root = rootRef.current;
    const portal = portalRef.current;
    if (!root || !portal) return;

    const layerA = portal.querySelector('.pl-pip-layer-a') as HTMLElement | null;
    const layerB = portal.querySelector('.pl-pip-layer-b') as HTMLElement | null;
    const sticky = portal.querySelector('.pl-pip-portal-sticky') as HTMLElement | null;
    const stage = portal.querySelector('.pl-pip-portal-stage') as HTMLElement | null;
    const cardA = layerA?.querySelector('.pl-pip') as HTMLElement | null;
    const cardB = layerB?.querySelector('.pl-pip') as HTMLElement | null;

    const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
    // Smootherstep — softer than smoothstep, no hard corners at 0/1
    const soft = (t: number) => {
      const x = clamp01(t);
      return x * x * x * (x * (x * 6 - 15) + 10);
    };

    // ── Fit-to-stage scale ──
    // Each card must FIT the stage it's assigned — the coding card (8-line
    // snippet) is naturally taller than the theory card and used to spill
    // past the stage on short viewports. Measure card vs stage and bake a
    // per-layer fit factor into every painted scale. Cards are centered by
    // the layer's flexbox, transform-origin center, so pure scale keeps
    // them inside. Re-measured on resize/orientation (fonts settle before
    // first scroll in practice; the resize hook covers late shifts).
    let fitA = 1;
    let fitB = 1;
    const measureFit = () => {
      const st = stage?.getBoundingClientRect();
      if (!st || st.width === 0 || st.height === 0) return;
      const fitOf = (card: HTMLElement | null) => {
        if (!card) return 1;
        const w = card.offsetWidth;
        const h = card.offsetHeight;
        if (!w || !h) return 1;
        return Math.min(1, (st.width * 0.92) / w, (st.height * 0.94) / h);
      };
      fitA = fitOf(cardA);
      fitB = fitOf(cardB);
    };

    const paintLayer = (el: HTMLElement | null, o: number, y: number, s: number, fit: number) => {
      if (!el) return;
      // visibility:hidden when fully gone — avoids empty hit targets; glass paints when o>0
      el.style.opacity = String(o);
      el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0) scale(${(s * fit).toFixed(4)})`;
      el.style.visibility = o < 0.02 ? 'hidden' : 'visible';
      // Explicitly clear any filter so glass backdrop-filter works
      el.style.filter = 'none';
    };

    // ── Timeline: Theory is ALWAYS on at rest; scroll only reveals Coding ──
    // p ≤ ~0.18  → Theory full, Coding hidden (no empty stage on arrival)
    // p 0.18–0.72 → one soft crossfade (Theory out, Coding in)
    // p ≥ ~0.72  → Coding full
    // Progress is lerped in tick() so wheel/trackpad never step-jerk the glass.
    const apply = (raw: number) => {
      const p = clamp01(raw);
      // Wide soft crossfade only — Theory does NOT "form in" from empty
      const x = soft((p - 0.16) / 0.52);

      // Theory: fully present until the handoff begins
      const aO = 1 - x;
      const aY = -x * 10;
      const aS = 1 - x * 0.02;

      // Coding: surfaces on scroll only
      const bO = x;
      const bY = (1 - x) * 14;
      const bS = 0.98 + x * 0.02;

      paintLayer(layerA, aO, aY, aS, fitA);
      paintLayer(layerB, bO, bY, bS, fitB);
    };

    // Settled: both cards stacked (reduced motion / no scrub)
    if (reduce) {
      measureFit();
      paintLayer(layerA, 1, 0, 1, fitA);
      paintLayer(layerB, 1, 0, 1, fitB);
      return;
    }

    portal.setAttribute('data-portal', 'live');

    const progressFromLayout = () => {
      const stickyH = sticky?.offsetHeight || Math.min(window.innerHeight * 0.82, 680);
      const track = Math.max(80, portal.offsetHeight - stickyH);
      // Match CSS: top: max(64px, 7vh)
      const stickyTop = Math.max(64, window.innerHeight * 0.07);
      // Portal top relative to the scrollport (.pl-root)
      const rootRect = root.getBoundingClientRect();
      const portalRect = portal.getBoundingClientRect();
      const relTop = portalRect.top - rootRect.top;
      // 0 when sticky engages, 1 when runway is consumed
      return (stickyTop - relTop) / track;
    };

    // Soft follow — visual progress eases toward scroll (frame-rate aware).
    // Start at 0 so Theory paints full immediately, even before pin.
    let displayP = 0;
    let raf = 0;
    let looping = false;
    let lastTs = 0;
    // Lower = silkier (less wheel-notch step); still keeps up with the finger.
    const FOLLOW = 7.2;

    const tick = (ts?: number) => {
      raf = 0;
      const now = ts || performance.now();
      const dt = lastTs ? Math.min(0.05, (now - lastTs) / 1000) : 0.016;
      lastTs = now;

      const target = progressFromLayout();
      // Clamp visual progress: never go negative — Theory stays solid on approach
      const targetClamped = Math.max(0, target);
      const k = 1 - Math.exp(-FOLLOW * dt);
      displayP += (targetClamped - displayP) * k;
      if (Math.abs(targetClamped - displayP) < 0.00035) displayP = targetClamped;

      apply(displayP);
      if (looping || Math.abs(targetClamped - displayP) >= 0.00035) {
        raf = requestAnimationFrame(tick);
      }
    };

    const startLoop = () => {
      if (looping) return;
      looping = true;
      lastTs = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const stopLoop = () => {
      looping = false;
      // drain remaining ease so we settle cleanly on the final pose
      if (!raf) raf = requestAnimationFrame(tick);
    };

    // Theory on stage immediately — never an empty black box on first paint.
    measureFit();
    displayP = Math.max(0, progressFromLayout());
    apply(displayP);

    // rAF while the portal/sticky stage is near/on screen
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          const on = entries.some((e) => e.isIntersecting);
          if (on) startLoop();
          else stopLoop();
        },
        { root, rootMargin: '30% 0px 30% 0px', threshold: 0 },
      );
      io.observe(portal);
      if (sticky) io.observe(sticky);
    } else {
      startLoop();
    }

    const onScroll = () => {
      // ensure a frame runs even if IO hasn't fired yet
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onResize = () => {
      // stage/card geometry changed — refresh the fit factors first
      measureFit();
      onScroll();
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });

    return () => {
      looping = false;
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      portal.removeAttribute('data-portal');
    };
  }, [reduce]);

  // Subtle scroll-reveal (sections) + self-drawing hairlines.
  // CRITICAL: root MUST be .pl-root (the actual overflow scroller). The default
  // root is the browser viewport; with position:fixed + overflow-y:auto on
  // .pl-root, iOS Safari and some Android browsers miss intersections — so
  // .pl-reveal stays at opacity:0 forever ("content never loads" on mobile).
  // Desktop often looked fine because more of the page is in the first paint
  // and thresholds were easier to meet on a tall monitor.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const targets = root.querySelectorAll('.pl-reveal, .pl-drawline');
    if (targets.length === 0) return;

    const reveal = (el: Element) => el.classList.add('pl-in');

    // Reduced motion / no-IO environments: show everything immediately.
    if (reduce || typeof IntersectionObserver === 'undefined') {
      targets.forEach(reveal);
      return;
    }

    const io = new IntersectionObserver(
      (es) => es.forEach((e) => {
        if (e.isIntersecting) {
          reveal(e.target);
          io.unobserve(e.target);
        }
      }),
      {
        root, // ← the fixed scroll container, not the window
        threshold: 0.02,
        // Start reveal slightly before the block fully enters — mobile sticky
        // nav + URL chrome eat vertical space and made 0.14/-6% miss too often.
        rootMargin: '0px 0px 12% 0px',
      },
    );
    targets.forEach((el) => io.observe(el));

    // Safety net: anything still hidden after a short settle is forced visible.
    // Covers flaky mobile IO (tab restore, address-bar resize, PiP, etc.).
    const failSafe = window.setTimeout(() => {
      root.querySelectorAll('.pl-reveal:not(.pl-in), .pl-drawline:not(.pl-in)').forEach(reveal);
    }, 1800);

    return () => {
      io.disconnect();
      window.clearTimeout(failSafe);
    };
  }, [reduce]);

  // The glass planet tracks the cursor the way real optics shift a highlight
  // as you move past them — ±9° tilt on the sphere; shell + ring ride along
  // so the whole crystal tracks as one. Platform chips stay put.
  // Disabled on phones: pointer-tilt fights the continuous CSS spin we use
  // for the mobile CSS-only orb path, and touch move is not a fine pointer.
  useEffect(() => {
    if (reduce) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches) return;
    const globe = globeRef.current;
    const sphere = globe?.querySelector('.pl-galaxy-sphere') as HTMLElement | null;
    const shell = globe?.querySelector('.pl-globe-shell') as HTMLElement | null;
    const ring = globe?.querySelector('.pl-orb-glassring') as HTMLElement | null;
    if (!globe || !sphere) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = globe.getBoundingClientRect();
        const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 300));
        const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 300));
        const t = `perspective(680px) rotateY(${(dx * 9).toFixed(2)}deg) rotateX(${(-dy * 9).toFixed(2)}deg)`;
        sphere.style.transform = t;
        if (shell) shell.style.transform = t;
        if (ring) ring.style.transform = t;
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(raf);
      sphere.style.transform = '';
      if (shell) shell.style.transform = '';
      if (ring) ring.style.transform = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerleave', onLeave); };
  }, [reduce]);

  // Reading lamp: a faint gold light that trails the cursor with lag, and
  // brightens slightly when the reader pauses — light settles when you do.
  useEffect(() => {
    if (prefersReduce() || !hasFinePointer()) return;
    const lamp = lampRef.current;
    const root = rootRef.current;
    if (!lamp || !root) return;
    let tx = window.innerWidth / 2, ty = window.innerHeight * 0.3;
    let x = tx, y = ty, glow = 0, seen = false, lastAct = 0, raf = 0;
    const onMove = (e: PointerEvent) => { tx = e.clientX; ty = e.clientY; seen = true; lastAct = performance.now(); };
    const onScroll = () => { lastAct = performance.now(); };
    const step = () => {
      const idle = performance.now() - lastAct > 420;
      const target = seen ? (idle ? 1 : 0.5) : 0;
      glow += (target - glow) * 0.05;
      x += (tx - x) * 0.09;
      y += (ty - y) * 0.09;
      lamp.style.opacity = String(0.085 * glow);
      lamp.style.transform = `translate3d(${x - 320}px,${y - 320}px,0)`;
      raf = requestAnimationFrame(step);
    };
    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('scroll', onScroll, { passive: true });
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Sticky nav gains its obsidian-blur bar only once the page moves.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let was = false;
    const onScroll = () => {
      const is = root.scrollTop > 8;
      if (is !== was) { was = is; setScrolled(is); }
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, []);

  // Hero object: tilt toward the pointer; gold rim light counters it; glass
  // specular tracks the finger. Direct style writes — no React state.
  const onHeroMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = tiltRef.current;
    if (!el || prefersReduce()) return;
    const r = el.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    el.classList.add('pl-tilting');
    // Slightly more authority than before — still a product shot, not a toy.
    el.style.transform =
      `perspective(1100px) rotateX(${(-ny * 3.2).toFixed(2)}deg) rotateY(${(nx * 4.4).toFixed(2)}deg) translateZ(6px)`;
    rimRef.current?.style.setProperty('--rimx', `${(50 - nx * 38).toFixed(1)}%`);
    rimRef.current?.style.setProperty('--rimy', `${(16 - ny * 30).toFixed(1)}%`);
    // Specular highlight sits ON the glass under the pointer.
    sheenRef.current?.style.setProperty('--sheenx', `${((nx + 1) * 50).toFixed(1)}%`);
    sheenRef.current?.style.setProperty('--sheeny', `${((ny + 1) * 50).toFixed(1)}%`);
  };
  const onHeroLeave = () => {
    const el = tiltRef.current;
    if (el) {
      el.classList.remove('pl-tilting');
      el.style.transform = '';
    }
    rimRef.current?.style.setProperty('--rimx', '50%');
    rimRef.current?.style.setProperty('--rimy', '16%');
    sheenRef.current?.style.setProperty('--sheenx', '28%');
    sheenRef.current?.style.setProperty('--sheeny', '18%');
  };

  const scrollTo = (id: string) => {
    // Pop-out is a sticky portal: land on the stage itself so Theory is on-screen,
    // not stuck above the runway where cards can read as "missing".
    if (id === 'popout') {
      const stage = document.querySelector('.pl-pip-portal-sticky') as HTMLElement | null;
      if (stage) {
        stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const tiers: PricingTier[] = (pricing?.tiers as PricingTier[]) || [];

  // ── Plan group tabs (2026-08) ────────────────────────────────────────
  // Individual = Starter / Basic / Pro / Max / Ultra. Team = Enterprise,
  // alone. Grouping comes off the tier itself (pricingService `group`), not
  // a list hardcoded here, so this section can never disagree with the
  // in-app pricing grid about which tab a plan belongs to.
  const [planGroup, setPlanGroup] = useState<'individual' | 'team'>('individual');
  const individualTiers = tiers.filter(t => groupOf(t) === 'individual');
  const teamTiers = tiers.filter(t => groupOf(t) === 'team');
  // Defensive: an older server / a region table without the Team plan must
  // not leave the tab strip offering an empty tab. Nothing renders the Team
  // tab if there is nothing in it.
  const showTeamTab = teamTiers.length > 0;
  const activeGroup: 'individual' | 'team' = showTeamTab ? planGroup : 'individual';

  const priceBlock = (t: PricingTier) => {
    if (!t.price || t.price === 0) return <span className="pl-serif pl-price-num">Free</span>;
    const amount = pricingService.formatPrice(t.price, t.currencySymbol, t.currency);
    const suffix = t.period === 'month' ? '/mo' : t.period === 'year' ? '/yr' : '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="pl-serif pl-price-num">{amount}</span>
        {suffix
          ? <span style={{ color: 'var(--mut)', fontSize: 15 }}>{suffix}</span>
          : <span style={{ color: 'var(--gold)', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.18em', border: '1px solid var(--gold-line)', borderRadius: 999, padding: '3px 9px' }}>one-time</span>}
      </span>
    );
  };

  return (
    <div className="pl-root" ref={rootRef}>
      <style>{CSS}</style>
      <div className="pl-grain" />
      <div className="pl-vignette" />
      <div className="pl-lamp" ref={lampRef} aria-hidden />

      {/* ── Nav (sticky; obsidian blur appears on scroll) ────── */}
      <div className={`pl-navbar${scrolled ? ' pl-scrolled' : ''}`}>
        <nav className="pl-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 78 }}>
          <Wordmark onClick={() => scrollTo('pl-top')} />
          <div className="pl-hide-sm" style={{ display: 'flex', gap: 34 }}>
            <button className="pl-navlink" onClick={() => scrollTo('why')}>Features</button>
            <button className="pl-navlink" onClick={() => scrollTo('popout')}>Pop-out</button>
            <button className="pl-navlink" onClick={() => scrollTo('pricing')}>Pricing</button>
            <button className="pl-navlink" onClick={() => scrollTo('faq')}>FAQ</button>
            <button className="pl-navlink" onClick={() => setView('docs')}>Docs</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* Sign in stays visible on phones — mid-nav links hide via pl-hide-sm,
                but returning users still need a one-tap path into auth. */}
            <button className="pl-navlink" onClick={() => setView('login')}>Sign in</button>
            <button onClick={() => setView('signup')} className="pl-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderRadius: 999, fontSize: 13 }}>
              Get started <PhArrowRight size={14} weight="bold" />
            </button>
          </div>
        </nav>
      </div>

      {/* ── Hero ────────────────────────────────────────────── */}
      <header id="pl-top" className="pl-wrap" style={{ paddingTop: 60, paddingBottom: 88, position: 'relative' }}>
        <div className="pl-hero">
          {/* LEFT — the promise */}
          <div className="pl-hero-copy">
            <div className="pl-eyebrow" style={{ marginBottom: 24 }}>Real-time interview copilot</div>
            {/* aria-label carries the finished sentence; the visual children
                are hidden from AT because the second line re-renders once
                per typed character — a screen reader following the live DOM
                would announce 40 partial fragments. */}
            <h1 className="pl-serif pl-display" style={{ margin: 0 }} data-pl-hero aria-label={`Every interview question, ${HERO_LINE}`}>
              <span aria-hidden="true">
                <span style={{ color: 'var(--paper)' }}>Every interview question,</span>
                <br />
                <span style={{ display: 'inline-block', minHeight: '1.05em' }}>
                  <em className="pl-gold" style={{ fontStyle: 'italic' }}>{typed || ' '}</em>
                  <span className="pl-caret" />
                </span>
              </span>
            </h1>
            <p className="pl-hero-sub pl-lede">
              minicaai listens to your live call and streams a perfect, personalized answer to your screen —
              <span style={{ color: 'var(--paper)' }}> invisible to everyone but you.</span>
            </p>
            <div className="pl-hero-cta">
              <Magnetic>
                <button onClick={() => setView('signup')} className="pl-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '16px 32px', borderRadius: 999, fontSize: 16 }}>
                  Start free — 10 minutes <PhArrowRight size={17} weight="bold" />
                </button>
              </Magnetic>
              <button onClick={() => scrollTo('why')} className="pl-textlink" style={{ fontSize: 16 }}>
                See it live <PhArrowRight size={15} weight="bold" />
              </button>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--faint)', letterSpacing: '.02em' }}>
              No card to start · Works on Zoom · Google Meet · Microsoft Teams
            </p>
          </div>

          {/* RIGHT — cut-glass teleprompter on black velvet. Stage light,
              dust, floor caustic, traveling gold rim-beam, pointer specular.
              Decorative layers only — content & handlers identical. */}
          <div className="pl-hero-visual">
            <div className="pl-stagelight" aria-hidden />
            <div className="pl-beam" aria-hidden>
              {MOTES.map((m, i) => (
                <span
                  key={i}
                  className="pl-mote"
                  style={{
                    left: `${m.left}%`, top: `${m.top}%`, width: m.size, height: m.size,
                    animationDelay: `${m.delay}ms`, animationDuration: `${m.dur}ms`,
                    '--dx': `${m.dx}px`, '--o': String(m.o),
                  } as React.CSSProperties}
                />
              ))}
            </div>
            <div className="pl-reflectwrap">
              <div className="pl-card-aura" aria-hidden />
              <div className="pl-card-float">
                <div
                  className="pl-obj pl-tilt"
                  ref={tiltRef}
                  onPointerMove={onHeroMove}
                  onPointerLeave={onHeroLeave}
                  style={{ textAlign: 'left', padding: 0 }}
                >
                  {/* Traveling gold light along the beveled edge */}
                  <div className="pl-card-rimbeam" aria-hidden />
                  {/* The answer-stream: golden silk flowing through the card's
                      glass, scrubbed forward by scroll. Under rim + copy. */}
                  <SilkStreamCanvas />
                  <div className="pl-rim" ref={rimRef} aria-hidden />
                  {/* Specular sheet of glass — tracks the pointer */}
                  <div className="pl-card-sheen" ref={sheenRef} aria-hidden />
                  {/* Precision corner brackets */}
                  <div className="pl-card-corners" aria-hidden>
                    <span /><span /><span /><span />
                  </div>

                  <div style={{ position: 'relative', zIndex: 7, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: '1px solid var(--line)', background: 'linear-gradient(180deg, rgba(255,255,255,.03), transparent)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="pl-live" />
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--paper)' }}>Senior Data Engineer</span>
                      <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>· live round</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      <span className="pl-hide-sm" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--gold)', border: '1px solid var(--gold-line)', padding: '4px 9px', borderRadius: 999 }}>hidden on share</span>
                      <span style={{ fontSize: 12, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>12:04</span>
                    </div>
                  </div>

                  <div style={{ position: 'relative', zIndex: 7, padding: '24px 22px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 8 }}>They ask</div>
                    <p style={{ fontSize: 15, lineHeight: 1.5, color: '#cfc9bd', marginBottom: 22 }}>
                      “Design a fraud-detection pipeline that has to score every transaction in under 50&nbsp;milliseconds.”
                    </p>

                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.2em', textTransform: 'uppercase', marginBottom: 8 }} className="pl-gold">You say</div>
                    <div className="pl-hero-answer">
                      <span className="pl-hero-stamp">yours to say · 0.8s</span>
                      <p className="pl-serif pl-say" style={{ color: 'var(--paper)', margin: 0 }}>
                        {ANSWER}<span className="pl-caret" />
                      </p>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 22 }}>
                      <span className="pl-wave">
                        {Array.from({ length: 26 }).map((_, i) => (
                          <i key={i} style={{ animationDelay: `${(i % 13) * 0.08}s`, height: 3 + ((i * 5) % 16) }} />
                        ))}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--mut)' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--gold-line)', borderRadius: 999, padding: '4px 10px', color: 'var(--gold)', fontWeight: 600 }}>
                          <PhSparkle size={13} weight="duotone" /> Claude Sonnet 5
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="pl-card-floor" aria-hidden />
            </div>
          </div>
        </div>
      </header>

      {/* ── The seam — the two-speed answer, immediately after the hero ──
          The first thing a visitor should understand about this product is
          not a feature list, it is that the pause after a hard question has
          been engineered away. That belongs here, one scroll below the
          card, while they still care. The hero and its globe are untouched;
          this is a separate section that begins where the header ends. */}
      {/* scroll-margin-top now comes from the one `.pl-root [id]` rule, so
          every destination clears the sticky bar by the same amount — this
          section used to be the only one that had it, inline and alone. */}
      <section id="seam" className="pl-wrap pl-reveal" style={{ paddingTop: 34, paddingBottom: 46, position: 'relative' }}>
        <div className="pl-seam-halo" aria-hidden />
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 760, margin: '0 auto 30px', textAlign: 'center' }}>
          <p className="pl-eyebrow" style={{ marginBottom: 16 }}>The silence problem</p>
          <h2 className="pl-serif" style={{ marginBottom: 16 }}>
            The question lands.
            <br />
            Then you’re <span className="pl-gold pl-foil">alone with it.</span>
          </h2>
          <p className="pl-lede" style={{ maxWidth: 620, margin: '0 auto' }}>
            Any model worth asking needs seconds to think about a hard question — and in a live
            interview, that pause is the thing that costs you the room. So we stopped making you
            wait for it. You get <span style={{ color: 'var(--pv-1)', fontWeight: 600 }}>a line to say in half a second</span>,
            and the full reasoning arrives underneath and picks up the exact sentence you’re already in.
          </p>
        </div>

        <div style={{ position: 'relative', zIndex: 1 }}>
          <SeamStage />
        </div>
      </section>

      {/* ── Trust line ──────────────────────────────────────── */}
      <section className="pl-wrap pl-reveal" style={{ paddingTop: 64, paddingBottom: 64, textAlign: 'center' }}>
        <p style={{ fontSize: 11.5, letterSpacing: '.22em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 22 }}>
          Candidates use it to land offers at
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          {PROOF.map((c, i) => (
            <React.Fragment key={c}>
              {i > 0 && <span style={{ color: 'var(--gold)', opacity: 0.5 }}>·</span>}
              <span className="pl-serif pl-proof">{c}</span>
            </React.Fragment>
          ))}
        </div>
      </section>

      {/* ── Feature moments (editorial, spacious — not a card grid) ── */}
      <section id="why" className="pl-wrap" style={{ paddingTop: 40, paddingBottom: 40 }}>
        {/* Moment 1 — Invisible */}
        <div className="pl-reveal pl-moment">
          <div>
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Invisible by design</div>
            <h2 className="pl-serif" style={{ marginBottom: 20 }}>
              They share the screen.<br /><span className="pl-gold pl-foil">They still can’t see it.</span>
            </h2>
            <p className="pl-lede" style={{ maxWidth: 460 }}>
              minicaai runs in a content-protected window the interviewer cannot capture — on Zoom, Meet, or Teams, even mid screen-share. Your edge stays yours.
            </p>
          </div>
          {/* The capture test. Two IDENTICAL frames — same chrome, same code
              skeleton, same SHARING pill — so the one visible difference IS
              the claim: the gold card exists only on your glass. The scan
              line reads the captured frame and finds nothing. Decorative
              (the copy on the left carries the claim), hence aria-hidden. */}
          <div aria-hidden="true">
            <div className="pl-cap">
              <ShareFrame scan />
              <ShareFrame overlay />
            </div>
            <p style={{ maxWidth: 520, marginLeft: 'auto', marginTop: 16, fontSize: 12, color: 'var(--faint)', letterSpacing: '.02em', textAlign: 'right' }}>
              One screen, mid share — the answer card never reaches the captured pixels.
            </p>
          </div>
        </div>

        <div className="pl-goldline pl-drawline" />

        {/* Moment 2 — Five minds */}
        <div className="pl-reveal pl-moment">
          <div className="pl-hide-sm" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {MODELS.map((m, i) => (
              <div key={m} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', borderRadius: 12, border: `1px solid ${i === 0 ? 'var(--gold-line)' : 'var(--line)'}`, background: i === 0 ? 'linear-gradient(90deg,rgba(211,172,99,.07),transparent)' : 'transparent' }}>
                <span className="pl-serif pl-model" style={{ color: i === 0 ? 'var(--paper)' : 'var(--mut)' }}>{m}</span>
                {i === 0
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--gold)', fontWeight: 600 }}><span className="pl-live" /> active</span>
                  : <span style={{ fontSize: 11, color: 'var(--faint)' }}>ready</span>}
              </div>
            ))}
          </div>
          <div style={{ order: -1 }}>
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Five minds, one earpiece</div>
            <h2 className="pl-serif" style={{ marginBottom: 20 }}>
              The right model<br />for <span className="pl-gold pl-foil">every question.</span>
            </h2>
            <p className="pl-lede" style={{ maxWidth: 460 }}>
              Claude Sonnet 5 for reasoning, GPT-5.6 for range, Gemini 3.6 for speed, Grok and Groq when you need instant. Switch minds mid-interview — no one will know.
            </p>
          </div>
        </div>

        <div className="pl-goldline pl-drawline" />

        {/* Moment 3 — Auto-Type */}
        <div className="pl-reveal pl-moment">
          <div>
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Auto-Type · Ultra &amp; Enterprise</div>
            <h2 className="pl-serif" style={{ marginBottom: 20 }}>
              It can even<br /><span className="pl-gold pl-foil">type it for you.</span>
            </h2>
            <p className="pl-lede" style={{ maxWidth: 460 }}>
              On Ultra and Enterprise, the perfect answer lands straight into the box at a human cadence — hands-free, for take-homes and live coding alike.
            </p>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--faint)', maxWidth: 460, marginTop: 16 }}>
              Watch the whole thing happen — the question arriving, the depth being read,
              the first line landing before you need it, and the code writing itself.
            </p>
          </div>
          <AnswerTheater />
        </div>

        <div className="pl-goldline pl-drawline" />

        {/* Quiet capability row (no cards) */}
        <div className="pl-reveal" style={{ display: 'flex', justifyContent: 'center', gap: 48, flexWrap: 'wrap', padding: '48px 0 8px' }}>
          {CAPS.map((c) => (
            <div key={c.t} style={{ display: 'inline-flex', alignItems: 'center', gap: 11, color: 'var(--mut)', fontSize: 15 }}>
              <c.icon size={19} weight="duotone" color="var(--gold)" /> {c.t}
            </div>
          ))}
        </div>
      </section>

      {/* ── Theater intermission (full-bleed cinematic breath) ─────────
          Pure light and material. The scroll-depth equivalent of the
          lights dimming in a real theater before something important.
          One of the few places the page is allowed to feel truly quiet
          and slightly miraculous. */}
      <div className="pl-theater pl-reveal" aria-hidden="true">
        <div className="pl-theater-inner" />
        <div className="pl-theater-gate" />
        {/* Slow traveling projector slit — the "light in the dark theater" */}
        <div className="pl-theater-slit" style={{ animationDelay: '-4s' }} />
        {/* Breathing aperture at center — the lens finding focus */}
        <div className="pl-theater-aperture" />
        {/* Delicate projector dust — 28 motes, slower and more precious */}
        {THEATER_MOTES.map((m, i) => (
          <span
            key={i}
            className="pl-theater-mote"
            style={{
              left: `${m.left}%`,
              top: `${m.top}%`,
              width: m.size,
              height: m.size,
              animationDelay: `${m.delay}ms`,
              animationDuration: `${m.dur}ms`,
              '--dx': `${m.dx}px`,
              '--o': String(m.o),
            } as React.CSSProperties}
          />
        ))}
        {/* One extra slow, wider beam for depth */}
        <div
          style={{
            position: 'absolute',
            left: '12%',
            right: '12%',
            top: '28%',
            height: '1px',
            background: 'linear-gradient(90deg,transparent,rgba(246,228,176,.12),transparent)',
            boxShadow: '0 0 60px rgba(211,172,99,.1)',
            animation: 'pl-theaterbreathe 32s ease-in-out infinite',
            animationDelay: '-11s',
            pointerEvents: 'none',
          }}
        />

        {/* THE CONNECTED CORE — the galaxy orb floats at center; circuit
            traces draw themselves out to frosted chips holding the real
            platform marks; pulses of gold light flow along the lines. */}
        <div className="pl-connect-stage" aria-hidden="true">
          <svg className="pl-traces" viewBox="0 0 620 420">
            {PLATFORM_ICONS.map((p) => (
              <g key={p.name}>
                <path className="pl-trace" d={p.trace} pathLength={1} style={{ '--td': p.td } as React.CSSProperties} />
                <path className="pl-trace-pulse" d={p.trace} pathLength={1} style={{ '--pd': p.pd } as React.CSSProperties} />
              </g>
            ))}
          </svg>
          <div className="pl-orb-float">
          <div className="pl-galaxy-globe" ref={globeRef}>
          {/* Atmosphere + floor caustic */}
          <div className="pl-globe-atmo" />
          <div className="pl-globe-caustic" />
          <div className="pl-globe-shell" />
          {/* x.ai structure: sphere body → soft-clipped canvas → glass ring.
              CSS galaxy layers are the no-WebGL fallback; .pl-orb-live hides them. */}
          <div className="pl-galaxy-sphere">
            <div className="pl-galaxy-core" />
            <div className="pl-galaxy-depth" />
            <div className="pl-galaxy-band pl-galaxy-band--far">
              <div className="pl-galaxy-band-drift" />
            </div>
            <div className="pl-galaxy-band">
              <div className="pl-galaxy-band-drift" />
            </div>
            {/* Soft-edge clip wrapper — x.ai mask recipe */}
            <div className="pl-orb-clip">
              <NebulaOrbCanvas />
            </div>
            <div className="pl-galaxy-heart" />
            <div className="pl-galaxy-stars">
              <div className="pl-galaxy-starwrap">
                <div className="pl-galaxy-stardrift">
                  {[0, 50].map((off) =>
                    GALAXY_STARS.map((s, i) => (
                      <span
                        key={`${off}-${i}`}
                        className="pl-galaxy-star"
                        style={{ left: `${(off + (s.x + 20) / 2.8).toFixed(2)}%`, top: `${((s.y + 20) / 1.4).toFixed(2)}%`, width: s.sz, height: s.sz, '--tw': `${s.tw}ms`, '--d': `${s.d}ms`, '--o': String(s.o) } as React.CSSProperties}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="pl-glass-bounce" />
            <div className="pl-glass-inner" />
            <div className="pl-glass-crescent" />
            <div className="pl-glass-spec" />
            <div className="pl-glass-spec2" />
            <div className="pl-glass-rim" />
          </div>
          {/* Exact x.ai glass-ring overlay */}
          <div className="pl-orb-glassring" />
          </div>
          </div>

          {/* Frosted chips — the real platform marks at their circuit endpoints */}
          {PLATFORM_ICONS.map((p) => (
            <div
              key={p.name}
              className="pl-chip-node"
              title={`${p.name} — supported`}
              style={{ left: p.x - 28, top: p.y - 28, '--cdx': `${310 - p.x}px`, '--cdy': `${210 - p.y}px`, '--cd': p.cd } as React.CSSProperties}
            >
              {p.svg}
            </div>
          ))}
        </div>
      </div>

      {/* ── The reckoning — what the money actually buys ──────
          Placed with the PRODUCT proof, not with the price. The
          three money statements sit around the pricing table; this
          one is a claim about the answers themselves, so it belongs
          where the features just finished making their case.
          Set RIGHT — the only right-aligned block on the page — and
          its lines enter from the right edge in sequence, travelling
          the way the eye will read them back. */}
      <section className="pl-wrap pl-reveal" style={{ paddingTop: 86, paddingBottom: 18 }}>
        <div className="pl-reck">
          <div className="pl-eyebrow" style={{ marginBottom: 22 }}>What you actually get</div>
          <h2 className="pl-serif" style={{ margin: 0 }}>
            <span className="pl-reck-l">We don&rsquo;t hand you a guess.</span>
            <span className="pl-reck-l"><em className="pl-gold" style={{ fontStyle: 'italic' }}>Every answer carries its reasoning.</em></span>
          </h2>
          <div className="pl-reck-rule" style={{ maxWidth: 300, marginTop: 24 }} aria-hidden />
          <p className="pl-lede" style={{ maxWidth: 470, marginLeft: 'auto', marginTop: 22 }}>
            Something you can defend when the follow-up question comes — not a confident sentence with nothing underneath it.
          </p>
        </div>
      </section>

      {/* ── Capability ledger — the rest of the kit, spec-sheet style ── */}
      <section id="kit" className="pl-wrap" style={{ paddingTop: 72, paddingBottom: 24 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 40, maxWidth: 640, marginLeft: 'auto', marginRight: 'auto' }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>Beyond the answer</div>
          <h2 className="pl-serif" style={{ marginBottom: 14 }}>
            Every detail, <span className="pl-gold pl-foil">already handled.</span>
          </h2>
          <p className="pl-lede">
            The quiet systems around the big moment — all working before you notice you need them.
          </p>
        </div>
        <div className="pl-ledger pl-reveal">
          {LEDGER.map((f) => (
            <div key={f.t} className="pl-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="pl-serif pl-row-t">{f.t}</span>
                {f.chip && <span className="pl-chip">{f.chip}</span>}
              </div>
              <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--mut)' }}>{f.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────── */}
      <section className="pl-wrap" style={{ paddingTop: 72, paddingBottom: 40 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 12 }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>How it works</div>
          <h2 className="pl-serif">
            Live help, three quiet steps.
          </h2>
        </div>
        {STEPS.map((s, idx) => (
          <div key={s.n} className="pl-reveal">
            <div className="pl-goldline" style={{ margin: '0 0 30px' }} />
            <div className="pl-step-row">
              <span className="pl-serif pl-num">{s.n}</span>
              <div className="pl-step-copy">
                <h3 className="pl-serif">{s.t}</h3>
                <p className="pl-lede">{s.b}</p>
              </div>
              {/* Tiny live vignette per step — same mini-UI language as the
                  capture-test frames. Decorative; the copy carries the steps. */}
              <div aria-hidden="true" className="pl-hide-sm">
                {idx === 0 && (
                  <div className="pl-step-vignette">
                    <div className="pl-step-chrome">
                      <span style={{ display: 'flex', gap: 2 }}><i className="pl-step-dot" /><i className="pl-step-dot" /><i className="pl-step-dot" /></span>
                      <span className="pl-step-addr">zoom — interview</span>
                    </div>
                    <div className="pl-step-content" style={{ textAlign: 'center', paddingTop: 6 }}>
                      <div style={{ fontSize: 6, color: 'var(--gold)', marginBottom: 2 }}>press</div>
                      <div style={{ border: '1px solid var(--gold-line)', borderRadius: 3, padding: '1px 5px', display: 'inline-block', fontSize: 7, letterSpacing: '.5px' }}>Ctrl K</div>
                      <div style={{ marginTop: 4, color: 'var(--faint)', fontSize: 5.5 }}>to open over window</div>
                    </div>
                    <div style={{ position: 'absolute', bottom: 5, right: 5, width: 18, height: 10, border: '1px solid var(--gold-line)', borderRadius: 2, background: 'rgba(211,172,99,.08)' }} />
                  </div>
                )}
                {idx === 1 && (
                  <div className="pl-step-vignette">
                    <div className="pl-step-chrome">
                      <span style={{ display: 'flex', gap: 2 }}><i className="pl-step-dot" /><i className="pl-step-dot" /><i className="pl-step-dot" /></span>
                      <span className="pl-step-addr">listening…</span>
                      <span className="pl-step-live" style={{ marginLeft: 'auto' }} />
                    </div>
                    <div className="pl-step-content">
                      <div className="pl-step-skl" style={{ width: '72%' }} />
                      <div className="pl-step-skl" style={{ width: '54%' }} />
                      <div className="pl-step-skl" style={{ width: '81%' }} />
                      <div className="pl-step-wave" style={{ marginTop: 3 }}>
                        {[3, 6, 4, 8, 5].map((h, i) => <i key={i} style={{ height: h }} />)}
                      </div>
                    </div>
                  </div>
                )}
                {idx === 2 && (
                  <div className="pl-step-vignette">
                    <div className="pl-step-chrome">
                      <span style={{ display: 'flex', gap: 2 }}><i className="pl-step-dot" /><i className="pl-step-dot" /><i className="pl-step-dot" /></span>
                      <span className="pl-step-addr">you see</span>
                    </div>
                    <div className="pl-step-content">
                      <div style={{ fontSize: 5.5, color: 'var(--gold)', marginBottom: 1 }}>You say</div>
                      <div style={{ color: 'var(--paper)', lineHeight: 1.15 }}>
                        Use a feature cache…<span className="pl-step-caret" />
                      </div>
                      <div className="pl-step-mini" style={{ fontSize: 5 }}>
                        Claude Sonnet 5
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* ── Pop-out portal — scroll forms theory, then coding (same glass) ── */}
      <section id="popout" className="pl-wrap" style={{ paddingTop: 40, paddingBottom: 56 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 28, maxWidth: 660, marginLeft: 'auto', marginRight: 'auto' }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>The pop-out</div>
          <h2 className="pl-serif" style={{ marginBottom: 14 }}>
            This is what floats over your <span className="pl-gold pl-foil">interview — and your meetings.</span>
          </h2>
          <p className="pl-lede">
            A small always-on-top window with the answer, in your voice. The systems answer is
            already there — keep scrolling and the coding round surfaces. Invisible when you share your screen.
          </p>
        </div>

        <div className="pl-pip-portal" ref={portalRef}>
          <div className="pl-pip-portal-sticky">
            <div className="pl-popout-stage pl-pip-portal-stage">
              <div className="pl-popout-ghost" aria-hidden="true" style={{ left: '5%', top: '10%', width: '48%', height: '60%' }} />
              <div className="pl-popout-ghost" aria-hidden="true" style={{ right: '6%', bottom: '9%', width: '40%', height: '48%' }} />
              <span className="pl-popout-tag" aria-hidden="true" style={{ left: '8%', top: '6%' }}>Zoom · shared</span>
              <span className="pl-popout-tag" aria-hidden="true" style={{ right: '9%', bottom: '5%' }}>your screen</span>
              <i className="pl-pip-atmo" aria-hidden="true" />
              <i className="pl-pip-backlight" aria-hidden="true" />
              <i className="pl-pip-caustic" aria-hidden="true" />
              <i className="pl-pip-shell" aria-hidden="true" />

              {/* ── Layer A: theoretical / systems ── */}
              <div className="pl-pip-layer pl-pip-layer-a">
                <div className="pl-pip" role="img" aria-label="minicaai pop-out: systems design question with a spoken answer">
                  <div className="pl-pip-face">
                    <i className="pl-pip-spec" aria-hidden="true" />
                    <i className="pl-pip-sheen" aria-hidden="true" />
                    <div className="pl-pip-head">
                      <div className="pl-pip-ava">m</div>
                      <div className="pl-pip-title">
                        <h4>minicaai</h4>
                        <span><i className="pl-pip-livedot" /> listening</span>
                      </div>
                      <div className="pl-pip-sizes" aria-hidden="true">
                        <span className="pl-pip-size">S</span>
                        <span className="pl-pip-size on">M</span>
                        <span className="pl-pip-size">L</span>
                      </div>
                    </div>
                    <div className="pl-pip-body">
                      <div className="pl-pip-msg ai">
                        <span className="pl-pip-name">They ask</span>
                        <div className="pl-pip-bubble">How would you keep a feature&apos;s data fresh without hammering the database on every request?</div>
                      </div>
                      <div className="pl-pip-msg you">
                        <span className="pl-pip-name">You say</span>
                        <div className="pl-pip-bubble">I&apos;d put a read-through cache in front with a short TTL, then refresh it in the background so reads stay fast and the DB only sees a miss occasionally<span className="pl-pip-cursor" /></div>
                      </div>
                      <div className="pl-pip-model" aria-hidden="true"><i className="pl-pip-livedot" style={{ background: '#d3ac63' }} /> Claude Sonnet 5</div>
                    </div>
                    <div className="pl-pip-foot" aria-hidden="true">
                      <div className="pl-pip-input">Type a follow-up…</div>
                      <div className="pl-pip-send">
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M15 8 2 2l2.6 6L2 14z" /></svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Layer B: coding round — same glass language ── */}
              <div className="pl-pip-layer pl-pip-layer-b">
                <div className="pl-pip" role="img" aria-label="minicaai pop-out: coding question with a live solution">
                  <div className="pl-pip-face">
                    <i className="pl-pip-spec" aria-hidden="true" />
                    <i className="pl-pip-sheen" aria-hidden="true" />
                    <div className="pl-pip-head">
                      <div className="pl-pip-ava">m</div>
                      <div className="pl-pip-title">
                        <h4>minicaai</h4>
                        <span><i className="pl-pip-livedot" /> coding</span>
                      </div>
                      <div className="pl-pip-sizes" aria-hidden="true">
                        <span className="pl-pip-size">S</span>
                        <span className="pl-pip-size on">M</span>
                        <span className="pl-pip-size">L</span>
                      </div>
                    </div>
                    <div className="pl-pip-body">
                      <div className="pl-pip-msg ai">
                        <span className="pl-pip-name">They ask</span>
                        <div className="pl-pip-bubble">Write a function that returns the index of the first unique character. O(n) time, O(1) extra space if the alphabet is fixed.</div>
                      </div>
                      <div className="pl-pip-msg you">
                        <span className="pl-pip-name">You say</span>
                        <div className="pl-pip-bubble pl-pip-code">
                          <span className="pl-kw">function</span> <span className="pl-fn">firstUnique</span>(s) {'{\n'}
                          {'  '}<span className="pl-kw">const</span> freq = <span className="pl-kw">new</span> Map();{'\n'}
                          {'  '}<span className="pl-kw">for</span> (<span className="pl-kw">const</span> c <span className="pl-kw">of</span> s){'\n'}
                          {'    '}freq.set(c, (freq.get(c) || <span className="pl-cn">0</span>) + <span className="pl-cn">1</span>);{'\n'}
                          {'  '}<span className="pl-kw">for</span> (<span className="pl-kw">let</span> i = <span className="pl-cn">0</span>; i {'<'} s.length; i++){'\n'}
                          {'    '}<span className="pl-kw">if</span> (freq.get(s[i]) === <span className="pl-cn">1</span>) <span className="pl-kw">return</span> i;{'\n'}
                          {'  '}<span className="pl-kw">return</span> <span className="pl-cn">-1</span>;{'\n'}
                          {'}'}
                          <span className="pl-pip-cursor" />
                        </div>
                      </div>
                      <div className="pl-pip-model" aria-hidden="true"><i className="pl-pip-livedot" style={{ background: '#d3ac63' }} /> Claude Sonnet 5</div>
                    </div>
                    <div className="pl-pip-foot" aria-hidden="true">
                      <div className="pl-pip-input">Walk me through the complexity…</div>
                      <div className="pl-pip-send">
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M15 8 2 2l2.6 6L2 14z" /></svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="pl-pip-shieldrow pl-reveal">
          <span className="pl-pip-shield" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></svg>
          </span>
          Hidden from screen-share on macOS &amp; Windows — resize S / M / L, drag it anywhere, hide it instantly with a shortcut.
        </div>
      </section>

      {/* ── Privacy — the discretion pact ───────────────────── */}
      <section id="privacy" className="pl-wrap" style={{ paddingTop: 72, paddingBottom: 32 }}>
        <div className="pl-moment" style={{ alignItems: 'start', padding: 0 }}>
          <div className="pl-reveal">
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Discretion, engineered</div>
            <h2 className="pl-serif" style={{ marginBottom: 20 }}>
              What we <span className="pl-gold pl-foil">never keep.</span>
            </h2>
            {/* "built to forget — audio, screenshots, keystrokes" implied we
                capture keystrokes at all (we emit them for Auto-Type, we do
                not read them) and that screenshots are forgotten everywhere
                (Auto-Type keeps its last 50 on the user's own disk). Say the
                thing that is actually true and still strong: none of it
                reaches us. */}
            <p className="pl-lede" style={{ maxWidth: 440, marginBottom: 28 }}>
              A tool this private has to be private all the way down. Your audio goes straight to the transcription engine, your screen never leaves your machine, and we keep no recording of either.
            </p>
            <button className="pl-textlink" style={{ fontSize: 15 }} onClick={() => setView('docs')}>
              Read the security overview <PhArrowRight size={14} weight="bold" />
            </button>
          </div>
          <div className="pl-reveal" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {TRUST.map((t) => (
              <div key={t.t} style={{ display: 'flex', gap: 15, alignItems: 'flex-start' }}>
                <span style={{ flexShrink: 0, width: 36, height: 36, borderRadius: 10, border: '1px solid var(--gold-line)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(180deg,rgba(211,172,99,.07),transparent)' }}>
                  <t.icon size={17} weight="duotone" color="var(--gold)" />
                </span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--paper)', marginBottom: 3 }}>{t.t}</div>
                  <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--mut)' }}>{t.b}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Compatibility strip ─────────────────────────────── */}
      <section className="pl-wrap pl-reveal" style={{ paddingTop: 56, paddingBottom: 16, textAlign: 'center' }}>
        <p style={{ fontSize: 11.5, letterSpacing: '.22em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 20 }}>
          Works where you interview
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 13, flexWrap: 'wrap', marginBottom: 16 }}>
          {PLATFORMS.map((p, i) => (
            <React.Fragment key={p}>
              {i > 0 && <span style={{ color: 'var(--gold)', opacity: 0.45 }}>·</span>}
              <span className="pl-serif pl-proof" style={{ color: 'var(--mut)' }}>{p}</span>
            </React.Fragment>
          ))}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--faint)', letterSpacing: '.02em' }}>
          Windows 10+ · macOS 12+ (native on Apple Silicon) · Linux (Ubuntu 22.04+, Fedora 38+)
        </p>
      </section>

      {/* ── The vow — the threshold into the price ────────────
          Deliberately the last thing read before the first number.
          Stated after the table it would be a reassurance; stated
          before it, it is the frame every price below is read
          through. The shaft crosses once and the light ends on the
          second line, which is the whole argument in one gesture. */}
      <section className="pl-reveal pl-vow" style={{ paddingTop: 108, paddingBottom: 34, textAlign: 'center' }}>
        <div className="pl-vow-beam" aria-hidden />
        <div className="pl-vow-inner">
          <div className="pl-eyebrow" style={{ marginBottom: 26 }}>What this is for</div>
          <h2 className="pl-serif" style={{ margin: 0 }}>
            <span className="pl-vow-line pl-vow-a">We don&rsquo;t want your money.</span>
            <span className="pl-vow-line pl-vow-b">We want you to get the job.</span>
          </h2>
          <p className="pl-lede" style={{ maxWidth: 440, margin: '30px auto 0' }}>
            That is the whole business. The prices below keep it running.
          </p>
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────────── */}
      {/* Wider than pl-wrap (1280 vs 1140): five tiers since the 2026-07
          overhaul — at 1140 the grid fits four per row and Ultra orphans. */}
      <section id="pricing" style={{ maxWidth: 1280, margin: '0 auto', padding: '80px 34px 40px', position: 'relative', zIndex: 2 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 44, maxWidth: 620, marginLeft: 'auto', marginRight: 'auto' }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>Pricing</div>
          {activeGroup === 'team' ? (
            <>
              <h2 className="pl-serif" style={{ marginBottom: 16 }}>
                One plan.<br /><span className="pl-gold pl-foil">No meter on it.</span>
              </h2>
              <p className="pl-lede">
                Enterprise removes the clock entirely — unlimited interview time that never expires, every top model, Auto-Type for coding rounds.{pricing?.currency ? ` Prices in ${pricing.currency}.` : ''}
              </p>
            </>
          ) : (
            <>
              <h2 className="pl-serif" style={{ marginBottom: 16 }}>
                Pay for the interview,<br /><span className="pl-gold pl-foil">not a subscription.</span>
              </h2>
              <p className="pl-lede">
                One-time passes for the interviews that matter — or take a monthly block of hours with Ultra.{pricing?.currency ? ` Prices in ${pricing.currency}.` : ''}
              </p>
            </>
          )}
        </div>
        {/* Tab strip. role="tablist" + aria-selected because this genuinely
            IS a tabbed disclosure — a screen reader that reads it as two
            loose buttons gives no hint that picking one replaces the other's
            content. Hidden entirely when there is no Team plan to show. */}
        {showTeamTab && (
          <div className="pl-reveal" style={{ display: 'flex', justifyContent: 'center' }}>
            <div className="pl-plantabs" role="tablist" aria-label="Plan type">
              {PLAN_GROUPS.map(g => (
                <button
                  key={g.id}
                  role="tab"
                  id={`pl-plantab-${g.id}`}
                  aria-selected={activeGroup === g.id}
                  aria-controls={`pl-planpanel-${g.id}`}
                  className="pl-plantab"
                  onClick={() => setPlanGroup(g.id)}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div
          id="pl-planpanel-individual"
          role="tabpanel"
          aria-labelledby="pl-plantab-individual"
          hidden={activeGroup !== 'individual'}
        >
        <div className="pl-reveal" style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 8 }}>One-time passes</div>
          <div className="pl-passes">
            {individualTiers.filter(t => t.id !== 'ultra').map((t) => {
              const pop = !!t.popular;
              const Mark = TIER_MARK[t.id];
              return (
                <div key={t.id} className={pop ? 'pl-price-pop' : 'pl-price'} style={{ borderRadius: 18, padding: 20, display: 'flex', flexDirection: 'column', position: 'relative' }}>
                  {pop && (
                    <span style={{ position: 'absolute', top: -9, left: 20, fontSize: 9, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: '#231c0c', background: 'linear-gradient(100deg,var(--gold-1),var(--gold-3))', padding: '2px 8px', borderRadius: 999 }}>Most chosen</span>
                  )}
                  {/* The row is reserved whether or not this tier has an icon.
                      TIER_MARK has no `free`, and rendering the box conditionally
                      made the Starter card 32px shorter at the top, so its price and
                      CTA sat 40px and 53px above the other three across the grid. */}
                  <div style={{ marginBottom: 8, height: 24, display: 'flex', alignItems: 'center' }}>
                    {Mark && <Mark size={24} />}
                  </div>
                  <h3 className="pl-serif">{t.name}</h3>
                  {t.subtitle && <p style={{ fontSize: 11, color: 'var(--faint)', marginTop: 1 }}>{t.subtitle}</p>}
                  <div style={{ margin: '12px 0 10px' }}>{priceBlock(t)}</div>
                  <button
                    onClick={() => handleTierSelect(t)}
                    disabled={isSubmitting}
                    className={pop ? 'pl-cta' : undefined}
                    style={pop
                      ? { width: '100%', padding: '8px 12px', borderRadius: 999, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: isSubmitting ? 0.6 : 1, cursor: isSubmitting ? 'default' : 'pointer' }
                      : { width: '100%', padding: '8px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: isSubmitting ? 'default' : 'pointer', color: 'var(--paper)', background: 'transparent', border: '1px solid rgba(255,255,255,.16)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: isSubmitting ? 0.6 : 1 }}
                  >
                    {t.cta || 'Choose'} <PhArrowRight size={13} weight="bold" />
                  </button>
                  <ul style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(t.features || []).map((f, i) => (
                      <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11.5, color: '#cbc5b9' }}>
                        <PhCheck size={13} weight="fill" color="var(--gold)" style={{ flexShrink: 0, marginTop: 1 }} />
                        <span style={{ lineHeight: 1.4 }}>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
        {(() => {
          const ultra = individualTiers.find(t => t.id === 'ultra');
          if (!ultra) return null;
          const Mark = TIER_MARK[ultra.id];
          return (
            <div className="pl-reveal">
              {/* Eyebrow was "Flagship — unlimited". Ultra stopped being
                  unlimited on 2026-08-22 (9 hours a month; unlimited moved to
                  Enterprise), and a label that oversells the plan directly
                  above its own feature list is the kind of thing a customer
                  finds out about at 0 seconds, mid-interview. */}
              <div style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--gold)', margin: '2px 0 6px' }}>Flagship — monthly</div>
              <div className="pl-ultra-band">
                <div>
                  {Mark && <div style={{ marginBottom: 6 }}><Mark size={38} /></div>}
                  <h3 className="pl-serif">{ultra.name}</h3>
                  {ultra.subtitle && <p style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 1 }}>{ultra.subtitle}</p>}
                  <div style={{ margin: '12px 0 14px' }}>{priceBlock(ultra)}</div>
                  <button
                    onClick={() => handleTierSelect(ultra)}
                    disabled={isSubmitting}
                    className="pl-cta"
                    style={{ padding: '10px 24px', borderRadius: 999, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: isSubmitting ? 0.6 : 1 }}
                  >
                    {ultra.cta || 'Choose Ultra'} <PhArrowRight size={14} weight="bold" />
                  </button>
                </div>
                <div style={{ paddingTop: 2 }}>
                  <ul style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 14px', margin: 0, padding: 0, listStyle: 'none' }}>
                    {(ultra.features || []).map((f, i) => (
                      <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, color: '#d2ccbf' }}>
                        <PhCheck size={13} weight="fill" color="var(--gold)" style={{ flexShrink: 0, marginTop: 1 }} />
                        <span style={{ lineHeight: 1.4 }}>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        })()}
        </div>

        {/* ── TEAM — Enterprise, alone ─────────────────────────
            One plan on this tab by design: a team buying minicaai is not
            choosing between sizes, it is deciding whether to remove the
            meter. So there is nothing to compare against here — just the
            plan, its price, and what it drops. Staged on the same band the
            flagship uses so the two tabs feel like one price list, not two
            pages. */}
        <div
          id="pl-planpanel-team"
          role="tabpanel"
          aria-labelledby="pl-plantab-team"
          hidden={activeGroup !== 'team'}
        >
          {teamTiers.map((ent) => {
            const Mark = TIER_MARK[ent.id];
            return (
              <div className="pl-reveal" key={ent.id}>
                <div style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--gold)', margin: '2px 0 6px' }}>For teams — unlimited</div>
                <div className="pl-ent-band">
                  <div>
                    {Mark && <div style={{ marginBottom: 6 }}><Mark size={42} /></div>}
                    <h3 className="pl-serif">{ent.name}</h3>
                    {ent.subtitle && <p style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 1 }}>{ent.subtitle}</p>}
                    <div style={{ margin: '12px 0 14px' }}>{priceBlock(ent)}</div>
                    <button
                      onClick={() => handleTierSelect(ent)}
                      disabled={isSubmitting}
                      className="pl-cta"
                      style={{ padding: '11px 26px', borderRadius: 999, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: isSubmitting ? 0.6 : 1 }}
                    >
                      {ent.cta || 'Get Enterprise'} <PhArrowRight size={14} weight="bold" />
                    </button>
                    <p style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 12, lineHeight: 1.5 }}>
                      Billed monthly. Cancel any time — you keep access to the end of the cycle.
                    </p>
                  </div>
                  <div style={{ paddingTop: 2 }}>
                    <ul style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 14px', margin: 0, padding: 0, listStyle: 'none' }}>
                      {(ent.features || []).map((f, i) => (
                        <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, color: '#d2ccbf' }}>
                          <PhCheck size={13} weight="fill" color="var(--gold)" style={{ flexShrink: 0, marginTop: 1 }} />
                          <span style={{ lineHeight: 1.4 }}>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* ── The aside — a margin note, not a headline ────────
            Sits inside the pricing block because this is where the
            thought forms. Staged as an ANNOTATION: left-aligned,
            hung off a vertical rule, small, off the centre axis the
            whole page is built on — so it reads as something written
            beside the price list rather than another statement
            competing with it. The rule draws downward like a pen
            stroke; the two lines follow it in sequence.

            ⚠️ TONE: this asks, it does not dismiss. The first line read
            "If this is more than you can spare, go find something you
            can." — which sends a candidate who cannot afford it away, in
            the same breath as the price. The second line was always the
            warm one; the first now opens the door instead of closing it,
            so the pair reads as an invitation to talk rather than a
            verdict on whether they belong here. Keep it that way. */}
        <div className="pl-reveal pl-note" style={{ margin: '54px 0 4px' }}>
          <span className="pl-note-rule" aria-hidden />
          <span className="pl-note-l pl-serif pl-row-t" style={{ lineHeight: 1.5, color: 'var(--paper)' }}>
            If this is more than you can spare right now, please tell us.
          </span>
          <span className="pl-note-l" style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--mut)', marginTop: 10 }}>
            We would rather you walked in prepared than paid us.
          </span>
        </div>

        {/* Payment-method line must promise only what checkout can deliver
            TODAY: while the Razorpay account is pending (pricingService
            INR_CHECKOUT_ENABLED=false + server RAZORPAY_ROUTING_ENABLED
            unset), every region — India included — checks out via Stripe
            in USD, so "Razorpay · UPI in India" would be a broken promise
            at the payment sheet. Restore those words when the flags flip. */}
        <p className="pl-reveal" style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--faint)', letterSpacing: '.02em', marginTop: 28 }}>
          Secure checkout by Stripe · Apple Pay · Google Pay · all major cards ·{' '}
          <button className="pl-footnote-link" onClick={() => setShowRefund(true)}>14-day first-purchase refund window</button>
        </p>
      </section>

      {/* ── The underwriting ─────────────────────────────────
          Answers the question that follows a price — "and if it
          doesn't work for me?" — so it sits between the number and
          the FAQ rather than buried inside it. The clause travels
          back into its own place and the rule draws right-to-left:
          a refund is the transaction running backwards, and it is
          the only motion on this page that goes that way.
          The qualifier is stated plainly and links to the real
          policy. A guarantee that hides its conditions is worth
          less than one that shows them. */}
      <section className="pl-wrap pl-reveal" style={{ paddingTop: 112, paddingBottom: 8 }}>
        <div className="pl-uw">
          <div>
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Our side of it</div>
            <h2 className="pl-serif" style={{ margin: 0 }}>
              If our answers don&rsquo;t earn it,{' '}
              <span className="pl-return-back"><em className="pl-gold" style={{ fontStyle: 'italic' }}>you get the money back.</em></span>
            </h2>
          </div>
          {/* The conditions, at footnote scale beside the promise rather
              than hidden below it. A guarantee that shows its terms in
              the same breath is worth more than one that doesn't. */}
          <div className="pl-uw-terms" style={{ paddingTop: 8 }}>
            <div style={{ height: 1, background: 'var(--gold-line)', marginBottom: 16 }} aria-hidden />
            <p style={{ fontSize: 14, lineHeight: 1.68, color: 'var(--mut)' }}>
              Every refund request is read by a person, and honoured where the circumstances are right. We will tell you either way, and we will tell you why.
            </p>
            <button className="pl-textlink" style={{ fontSize: 14.5, marginTop: 16 }} onClick={() => setShowRefund(true)}>
              Read the refund policy <PhArrowRight size={13} weight="bold" />
            </button>
          </div>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────────── */}
      <section id="faq" className="pl-wrap" style={{ paddingTop: 62, paddingBottom: 40 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 40 }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>Questions</div>
          <h2 className="pl-serif">
            Asked. <span className="pl-gold pl-foil">Answered.</span>
          </h2>
        </div>
        <div className="pl-reveal" style={{ maxWidth: 760, margin: '0 auto' }}>
          {FAQS.map((f) => (
            <details key={f.q} className="pl-faq">
              <summary>
                <span className="pl-serif pl-faq-q">{f.q}</span>
                <span className="pl-plus" aria-hidden>+</span>
              </summary>
              <p className="pl-faq-a">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ── Closing — the final ask ── */}
      <section className="pl-wrap pl-reveal pl-closing" style={{ paddingTop: 84, paddingBottom: 100, textAlign: 'center', position: 'relative' }}>
        <div style={{ position: 'relative', zIndex: 2 }}>
          {/* The mark, finishing itself. A question is asked; it resolves
              into the gold drop — the line minicaai gives you; a beat; then
              the second drop closes the quotation with the words as you
              speak them. Placed here so the mark completes at the exact
              moment the page makes its ask. */}
          <div className="pl-markbeat" aria-hidden>
            <MinicaMark size={104} state="given" />
          </div>
          <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Calm outside · lightning within</div>
          <h2 className="pl-serif" style={{ marginBottom: 26 }}>
            <span style={{ color: 'var(--paper)' }}>The offer is one</span><br />
            <em className="pl-gold pl-foil" style={{ fontStyle: 'italic' }}>great answer away.</em>
          </h2>
          <p className="pl-lede" style={{ maxWidth: 480, margin: '0 auto 36px' }}>
            Be the most prepared person on the call. Start free — no card, no risk.
          </p>
          <Magnetic>
            <button onClick={() => setView('signup')} className="pl-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '18px 40px', borderRadius: 999, fontSize: 17 }}>
              Get started free <PhArrowRight size={18} weight="bold" />
            </button>
          </Magnetic>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer style={{ borderTop: '1px solid var(--line)' }}>
        <div className="pl-wrap" style={{ paddingTop: 40, paddingBottom: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <Wordmark onClick={() => scrollTo('pl-top')} />
            <span style={{ fontSize: 13, color: 'var(--faint)' }}>© {new Date().getFullYear()} minicaai</span>
          </div>
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            <button className="pl-navlink" onClick={() => setView('docs')}>Docs</button>
            <button className="pl-navlink" onClick={() => setView('tutorials')}>Tutorials</button>
            <button className="pl-navlink" onClick={() => scrollTo('privacy')}>Privacy</button>
            <button className="pl-navlink" onClick={() => setShowRefund(true)}>Refund policy</button>
            <button className="pl-navlink" onClick={() => setView('support')}>Support</button>
            <button className="pl-navlink" onClick={() => setView('login')}>Sign in</button>
            <button className="pl-navlink" onClick={() => setView('signup')}>Get started</button>
          </div>
        </div>
      </footer>

      {/* ── Checkout error toast ─────────────────────────────── */}
      {/* Only reachable for signed-in visitors (anonymous tier clicks
          detour to signup instead of checkout). Persistent until
          dismissed — the messages carry instructions ("try again in a
          moment", a fallback URL), so auto-hiding them would strand
          the reader mid-sentence. */}
      {paymentError && (
        <div className="pl-toast" role="alert">
          <span style={{ overflowWrap: 'anywhere' }}>{paymentError}</span>
          {onDismissPaymentError && (
            <button className="pl-toast-x" onClick={onDismissPaymentError} aria-label="Dismiss">×</button>
          )}
        </div>
      )}

      <RefundPolicy isOpen={showRefund} onClose={() => setShowRefund(false)} />
    </div>
  );
};

export default PremiumLanding;
