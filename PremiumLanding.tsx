import React, { useEffect, useRef, useState } from 'react';
import { pricingService, PricingTier, RegionPricing } from './services/pricingService';
import { UltraMark } from './UltraMark';
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
  --ink:#070706; --ink2:#0b0a08; --paper:#f2efe6; --mut:#9d968a; --faint:#645e54;
  --line:rgba(255,255,255,.07);
  --gold-1:#f6e4b0; --gold-2:#d9b874; --gold-3:#b58f45; --gold:#d3ac63;
  --gold-line:rgba(211,172,99,.24); --gold-glow:rgba(211,172,99,.16);
  position:fixed; inset:0; overflow-y:auto; overflow-x:hidden;
  background:var(--ink); color:var(--paper);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  letter-spacing:-0.011em;
  /* Never fake a face: if a weight/style isn't loaded, fall to a real cut
     instead of letting the browser shear or double-strike letterforms. */
  font-synthesis:none;
}
.pl-root *{box-sizing:border-box;}
.pl-root ::selection{background:rgba(211,172,99,.3);color:#fff;}
.pl-root :focus-visible{outline:2px solid var(--gold-2);outline-offset:3px;border-radius:4px;}
.pl-serif{font-family:'Newsreader','Tiempos Headline',ui-serif,Georgia,serif;font-optical-sizing:auto;}
.pl-grain{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.045;mix-blend-mode:overlay;
  background-image:url("${GRAIN}");background-size:140px 140px;}
.pl-vignette{position:fixed;inset:0;z-index:1;pointer-events:none;
  background:radial-gradient(120% 90% at 50% 8%, transparent 46%, rgba(0,0,0,.55) 100%);}
.pl-lamp{position:fixed;left:0;top:0;width:640px;height:640px;border-radius:50%;
  pointer-events:none;z-index:3;opacity:0;mix-blend-mode:screen;will-change:transform,opacity;
  background:radial-gradient(closest-side, rgba(211,172,99,.5), rgba(211,172,99,.1) 44%, transparent 72%);}
.pl-wrap{max-width:1140px;margin:0 auto;padding:0 34px;position:relative;z-index:2;}
.pl-navbar{position:sticky;top:0;z-index:6;border-bottom:1px solid transparent;
  transition:background .4s ease, border-color .4s ease, backdrop-filter .4s ease;}
.pl-navbar.pl-scrolled{background:rgba(9,8,7,.74);border-bottom-color:var(--line);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);}
.pl-eyebrow{font-size:11.5px;font-weight:600;letter-spacing:.34em;text-transform:uppercase;color:var(--gold);}
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
  color:#231c0c;font-weight:700;
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
.pl-hero-sub{max-width:470px;margin-top:26px;}
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
.pl-cap{position:relative;max-width:520px;margin-left:auto;}
.pl-frame{border-radius:12px;overflow:hidden;background:linear-gradient(180deg,#0e0d0b,#090807);
  border:1px solid var(--line);}
.pl-frame--back{position:relative;opacity:.92;
  box-shadow:0 24px 60px -30px rgba(0,0,0,.85);}
.pl-frame--front{position:relative;margin-top:26px;
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
.pl-captag{position:absolute;top:-9px;left:12px;z-index:3;font-size:9px;font-weight:700;
  letter-spacing:.18em;text-transform:uppercase;padding:3px 9px;border-radius:999px;
  background:#0b0a08;border:1px solid var(--line);color:var(--faint);}
.pl-captag--you{border-color:var(--gold-line);color:var(--gold);}
.pl-mini{position:absolute;right:10px;bottom:10px;width:min(66%,250px);z-index:2;
  background:linear-gradient(180deg,#141109,#0c0a07);border:1px solid var(--gold-line);
  border-radius:10px;padding:10px 12px;
  box-shadow:0 18px 44px -18px rgba(0,0,0,.9), 0 0 30px -12px var(--gold-glow), inset 0 1px 0 rgba(255,255,255,.06);}
@media (max-width:980px){ .pl-cap{margin-left:0;} }
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
.pl-price{background:linear-gradient(180deg,rgba(255,255,255,.022),rgba(255,255,255,0));
  border:1px solid var(--line);border-radius:18px;transition:border-color .35s,transform .4s cubic-bezier(.2,.9,.3,1),box-shadow .4s;}
.pl-price:hover{transform:translateY(-4px);border-color:rgba(255,255,255,.14);}
.pl-price-pop{border:1px solid var(--gold-line);
  background:linear-gradient(180deg, rgba(211,172,99,.08), rgba(211,172,99,.01));
  box-shadow:0 40px 90px -46px rgba(211,172,99,.5), inset 0 1px 0 rgba(255,255,255,.06);}
.pl-price-pop:hover{border-color:rgba(211,172,99,.5);transform:translateY(-4px);}

/* Target 1: Pricing composition — flagship staging.
   Passes are compact supporting players. Ultra is the distinct cinematic band:
   a spotlighted object with its own material depth and hierarchy. */
.pl-passes{display:grid;grid-template-columns:repeat(auto-fit,minmax(186px,1fr));gap:14px;align-items:stretch;}
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
  transition:color 1.2s ease .2s, text-shadow 1.2s ease .2s;}
.pl-reveal.pl-in .pl-num{color:rgba(211,172,99,.42);text-shadow:0 0 26px rgba(211,172,99,.18);}
.pl-ledger{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));column-gap:64px;}
.pl-row{display:flex;flex-direction:column;gap:8px;padding:22px 0;border-top:1px solid var(--line);}
.pl-chip{font-size:9.5px;font-weight:700;letter-spacing:.16em;color:var(--gold);
  border:1px solid var(--gold-line);border-radius:999px;padding:3px 8px;text-transform:uppercase;flex-shrink:0;}
.pl-faq{border-top:1px solid var(--line);}
.pl-faq:last-of-type{border-bottom:1px solid var(--line);}
.pl-faq summary{display:flex;align-items:baseline;justify-content:space-between;gap:22px;
  padding:22px 2px;cursor:pointer;list-style:none;}
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
   * GLOBE / PLATFORM STAGE — mobile reliability path
   * Desktop: WebGL nebula orb. Mobile: pure CSS galaxy (WebGL skipped) because
   * phones were showing a bright empty black disc when .pl-orb-live hid CSS
   * layers after a partial WebGL init, and RAF pause froze spin.
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
  /* Fewer GPU layers on phones — dust motes are desktop theater dressing. */
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
  /* Never allow WebGL live-mode styles to blank the CSS galaxy on phones. */
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
  .pl-orb-live .pl-globe-shell{
    display:block !important;
  }
  .pl-orb-live .pl-galaxy-sphere{
    background:
      radial-gradient(circle at 32% 28%, #100e24 0%, #07060f 55%, #010104 100%) !important;
    overflow:hidden !important;
  }
  .pl-orb-canvas,.pl-orb-clip{display:none !important;}

  /* Continuous, obvious rotation of the interior (shell is a sibling so
     glass highlights stay fixed while the galaxy turns beneath). */
  .pl-galaxy-sphere{
    animation: pl-mobile-sphere-spin 32s linear infinite;
    will-change: transform;
  }
  @keyframes pl-mobile-sphere-spin{
    from{transform:rotate(0deg);}
    to{transform:rotate(360deg);}
  }
  .pl-galaxy-core{animation-duration: 36s !important; opacity:1;}
  .pl-galaxy-depth{animation-duration: 52s !important;}
  .pl-galaxy-band-drift,
  .pl-galaxy-stardrift{animation-duration: 22s !important;}
  /* Richer interior so it never reads as a flat black disc. */
  .pl-galaxy-heart{opacity:1; filter:blur(1.5px);}
  .pl-galaxy-stars{opacity:1;}
  .pl-globe-atmo{opacity:.85; animation-duration:6s;}
  .pl-globe-caustic{opacity:.9;}
  /* Shell stays put (sibling of spinning sphere) — bright glass rim. */
  .pl-globe-shell{opacity:1;}

  /* Chips stay readable after stage scale (~0.5 → ~30px marks). */
  .pl-chip-node{
    width:64px; height:64px; border-radius:18px;
    /* Keep chips fully opaque even if chipfly hasn't fired yet. */
    opacity:1 !important;
  }
  .pl-chip-node svg{width:30px; height:30px;}
  /* Traces always drawn on mobile (don't wait for pl-in choreography). */
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
/* Reduced motion: keep the globe visible (no blank disc) but stop spinning. */
@media (max-width:767px) and (prefers-reduced-motion:reduce){
  .pl-galaxy-sphere,
  .pl-galaxy-core,
  .pl-galaxy-depth,
  .pl-galaxy-band-drift,
  .pl-galaxy-stardrift,
  .pl-orb-float{animation:none !important;}
}
@media (prefers-reduced-motion:reduce){
  .pl-root *{animation:none !important;}
  .pl-reveal{opacity:1 !important;transform:none !important;}
  .pl-drawline{transform:none !important;}
  .pl-foil{background-position:0 0 !important;}
  .pl-lamp,.pl-mote{display:none !important;}
  .pl-trace{stroke-dashoffset:0 !important;}
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
.pl-orb-live .pl-globe-shell { display: none !important; }
.pl-orb-live .pl-globe-atmo { opacity: .28; filter: blur(3px); }
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
    <span className="pl-serif" style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--paper)' }}>
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
    <span className={`pl-captag${overlay ? ' pl-captag--you' : ''}`}>{overlay ? 'You see' : 'They see'}</span>
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
          <p className="pl-serif" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--paper)', margin: 0 }}>
            Start with the trade-offs, then the design…<span className="pl-caret" style={{ height: '.8em' }} />
          </p>
        </div>
      )}
    </div>
  </div>
);

const HERO_LINE = 'answered the moment it’s asked.';
const ANSWER = 'I’d anchor it on an event backbone — Kafka — with stateless scoring pulling features from Redis, and the model behind a feature cache so p99 holds under 50ms.';

const MODELS = ['Claude Sonnet 5', 'GPT-5.5', 'Gemini 3.5', 'Grok 4.3', 'Groq'];
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
  { icon: PhMonitor, t: 'Screenshots vanish after the call', b: 'Auto-Solve captures live in memory for a single model call. Nothing is written to disk — yours or ours.' },
  { icon: PhLock, t: 'Scoped hearing only', b: 'It hears the one source you pick — a tab, a window, a screen. No keylogger, no reading other windows.' },
  { icon: PhCheck, t: 'Signed and verifiable', b: 'The Windows installer is code-signed via Azure Trusted Signing; updates ship over HTTPS and verify their signature before installing.' },
];

const PLATFORMS = ['Zoom', 'Google Meet', 'Microsoft Teams', 'Webex', 'HackerRank', 'CodeSignal', 'CoderPad'];

const FAQS = [
  { q: 'Will the interviewer ever see it?', a: 'No. The pop-out renders in a content-protected window that screen-share cannot capture — on Windows, macOS, and Linux. Even while you share your screen, they see the area behind it.' },
  { q: 'Is the free trial actually free?', a: 'Yes. Signing up gives you 10 minutes with every model except Claude — no card, nothing to cancel. When your 10 minutes are up, you choose a plan to keep going; nothing ever auto-charges.' },
  { q: 'Is this cheating?', a: 'We don’t make that call for you. Modern interviews increasingly test recall of obscure trivia under pressure more than they test the actual job. We build the tool; how you use it is your decision.' },
  { q: 'Is my interview audio stored anywhere?', a: 'No. Audio streams to the transcription engine, comes back as text, and is discarded. Every provider we use runs on paid API tiers whose terms exclude your data from training.' },
  { q: 'What do I need to run it?', a: 'Windows 10 or later, macOS 12 Monterey or later (native on Apple Silicon), or Linux (Ubuntu 22.04+, Fedora 38+). It works with any interview platform that plays audio through your computer.' },
  { q: 'Can I use one account on two machines?', a: 'A license binds to one device. Signing in on a new machine evicts the old one — so you can move any time, but two people can’t share a seat.' },
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
const ORB_FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uT;
uniform float uSpin;
uniform float uPhase;
/* legacy uniform kept so old call sites don't break if re-linked */
uniform float uDpr;

/* x.ai AgentOrb hash — single sin hash is enough for their star field */
float h1(float x){ return fract(sin(x*127.1)*43758.5453); }

/* Palette: gold + soft violet (minicaai brand cast on deep space) */
vec3 uC0(){ return vec3(0.83, 0.68, 0.39); } /* gold */
vec3 uC1(){ return vec3(0.55, 0.48, 0.95); } /* violet */
vec3 uC2(){ return vec3(0.96, 0.90, 0.72); } /* cream */

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

  /* nebula wisps + dark dust lanes carved through the bright band */
  float n1 = sin(lon*2.0 + sin(lat*3.0 + t*0.25)*1.6 + t*0.15);
  float n2 = sin(lon*5.0 - sin(lat*4.0 - t*0.2)*1.2 - t*0.22 + 2.4);
  float neb = pow(0.5 + 0.5*n1, 2.0)*(0.45 + 0.55*pow(0.5 + 0.5*n2, 2.0));
  float lane = pow(0.5 + 0.5*sin(lon*4.0 + lat*7.0 + sin(lon*2.0)*2.0), 3.0);
  float galaxy = clamp(band*neb*(1.0 - lane*(0.55 + 0.35*v2)), 0.0, 1.0);

  /* dust color: cool silver-blue with a gold/violet brand cast */
  vec3 hue = mix(mix(uC0(), uC1(), v1), mix(uC1(), uC2(), v3), 0.5 + 0.5*sin(lon + lat*2.0 - t*0.2));
  vec3 hueGrey = vec3(dot(hue, vec3(0.299, 0.587, 0.114)));
  hue = clamp(hueGrey + (hue - hueGrey)*1.35, 0.0, 1.0);
  vec3 dust = mix(vec3(0.72, 0.78, 0.92), hue, 0.42 + 0.25*v1);
  /* slightly tighter dust so black void between arms stays deep */
  vec3 col = dust*galaxy*0.58;

  /* faint shear lines — the galaxy visibly turns */
  float shear = sin(lon*13.0 + lat*4.0 - t*0.35)*sin(lon*5.0 + t*0.2);
  col += dust*band*neb*max(shear, 0.0)*0.10;

  /* second arm for spiral depth */
  float gb2 = lat - (0.35 + 0.25*v2)*sin(lon*2.0 - 1.1) + 0.4;
  float arm = exp(-gb2*gb2*7.0)*neb;
  col += mix(dust, uC1(), 0.35)*arm*0.15;

  /* void: nearly pure black with only a whisper of indigo (deeper = more premium) */
  vec3 voidGlow = mix(vec3(0.015, 0.012, 0.04), mix(uC0(), mix(uC1(), uC2(), v3), v1)*0.10, 0.45);
  col += voidGlow*(0.28 + 0.12*sin(t*0.4 + lon))*(0.25 + 0.45*band);

  /* warm amber core deep in the band — keep bright so contrast pops */
  col += vec3(1.0, 0.88, 0.68)*pow(band, 4.0)*pow(neb, 2.0)*0.42;

  /* saturated color pockets breathing in the dust */
  float pocket = pow(neb, 5.0)*band*(0.7 + 0.3*sin(t*0.6 + lon*3.0));
  col += mix(uC2(), uC0(), fract(v1 + 0.5*sin(lon*2.0)))*pocket*0.55;

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
    vec3 tint = mix(vec3(1.0), hx < 0.33 ? vec3(0.85, 0.9, 1.0) : (hx < 0.66 ? vec3(1.0, 0.95, 0.85) : mix(vec3(1.0), uC1(), 0.3)), 0.55);
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

void main(){
  vec2 p = (gl_FragCoord.xy*2.0 - uRes)/min(uRes.x, uRes.y);
  float r = length(p);
  /* CSS clip-path cuts the circle; discard corners for cost */
  if(r > 1.0){ gl_FragColor = vec4(0.0); return; }

  float t = uT*0.8 + uPhase;
  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr*rr);
  vec3 N = vec3(p.x, p.y, z);
  float fres = pow(1.0 - z, 2.4);

  /* refracted back-wall sample — solid glass, not a painted shell */
  vec3 I = vec3(0.0, 0.0, -1.0);
  vec3 R = refract(I, N, 0.75);
  float dHit = -2.0*dot(N, R);
  vec3 B = normalize(N + R*dHit);

  float sv = fract(uPhase*6.31);
  float sw = fract(uPhase*2.17);
  float tWarp = t
    + (0.9 + 1.3*sv)*sin(t*(0.09 + 0.07*sw))
    + (0.5 + 0.8*sw)*sin(t*(0.21 + 0.09*sv) + 2.6);

  vec4 front = sphereAt(N, uSpin, tWarp);
  vec4 back  = sphereAt(B, uSpin, tWarp*0.8 + 2.7);

  /* deeper black glass body — void reads almost ink, rim still catches gold */
  vec3 anchor = uC0();
  vec3 voidCol = mix(anchor*0.02, anchor*0.22, fres);
  vec3 col = mix(vec3(0.004, 0.004, 0.007), voidCol, 0.94 - 0.06*fres);

  /* mix (not add): band REPLACES glass where it lives — x.ai's key trick.
     Slightly lower back-wall echo so the interior stays blacker. */
  float fa = clamp(front.a, 0.0, 1.0);
  float ba = clamp(back.a, 0.0, 1.0);
  col = mix(col, back.rgb, ba*0.10);
  col = mix(col, front.rgb, fa*0.82);

  /* soft terminator — a touch more contrast (darker shade side) */
  vec3 LD = normalize(vec3(0.85*sin(t*0.42), 0.45*sin(t*0.26 + 1.2), 0.5));
  float diffuse = 0.52 + 0.72*max(dot(N, LD), 0.0);
  col *= diffuse;

  /* counter-rim atmospheric glow */
  float counter = max(dot(N.xy, -LD.xy), 0.0)*fres;
  col += mix(uC0(), vec3(0.5, 0.6, 0.9), 0.5)*counter*0.16;

  /* drifting key light + soft sheen + counter glint (product glass) */
  vec3 L1 = normalize(vec3(-0.45 + 0.3*sin(t*0.34), 0.62 + 0.2*sin(t*0.27 + 1.7), 0.64));
  float keyAmp = 0.5*(0.78 + 0.22*sin(t*0.45 + 2.2));
  col += vec3(1.0)*pow(max(dot(N, L1), 0.0), 150.0)*keyAmp;
  vec3 LS = normalize(vec3(sin(t*0.07)*0.9, 0.35 + 0.3*cos(t*0.05), 0.7));
  col += vec3(1.0)*pow(max(dot(N, LS), 0.0), 7.0)*0.05;
  vec3 L2 = normalize(vec3(0.52, -0.5 + 0.12*sin(t*0.09), 0.69));
  col += vec3(1.0)*pow(max(dot(N, L2), 0.0), 140.0)*0.25;

  /* fresnel: limb catches a touch of the band's color */
  col = mix(col, front.rgb, fa*fres*0.3);
  float limb = smoothstep(0.94, 1.0, rr);
  col = mix(col, col*0.85, limb*0.4);

  /* soft AA at the circle edge (CSS mask finishes the silhouette) */
  float aa = smoothstep(1.0, 0.985, r);
  gl_FragColor = vec4(col*aa, aa);
}`;

const NebulaOrbCanvas: React.FC = () => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    // ── Mobile: skip WebGL entirely ──
    // Phones were hitting a failure mode where we added .pl-orb-live (which
    // HIDES the CSS galaxy stars/bands) and then the canvas drew a flat
    // black/bright disc or the RAF loop paused — "dead crystal" with no
    // rotation. CSS galaxy + continuous CSS spin is reliable on mobile GPU
    // and battery; desktop keeps the full WebGL orb.
    const isMobile = typeof window !== 'undefined'
      && !!window.matchMedia?.('(max-width: 767px)').matches;
    if (isMobile) {
      cv.style.display = 'none';
      cv.closest('.pl-galaxy-globe')?.classList.remove('pl-orb-live');
      return;
    }

    const globe = cv.closest('.pl-galaxy-globe');
    const gl = cv.getContext('webgl', {
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
      // Preserve so a single missed frame doesn't flash empty.
      preserveDrawingBuffer: false,
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
    const vs = compile(gl.VERTEX_SHADER, 'attribute vec2 aP; void main(){ gl_Position = vec4(aP, 0.0, 1.0); }');
    const fs = compile(gl.FRAGMENT_SHADER, ORB_FRAG);
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
    cv.width = 480;
    cv.height = 480;
    gl.viewport(0, 0, cv.width, cv.height);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uT = gl.getUniformLocation(prog, 'uT');
    const uSpin = gl.getUniformLocation(prog, 'uSpin');
    const uPhase = gl.getUniformLocation(prog, 'uPhase');
    const uDpr = gl.getUniformLocation(prog, 'uDpr');
    gl.uniform2f(uRes, cv.width, cv.height);
    gl.uniform1f(uPhase, 0.37);
    gl.uniform1f(uDpr, 2.0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const reduce = prefersReduce();
    const spinBase = 0.18;
    const spinWave = 0.06;
    let raf = 0;
    let visible = true;
    let live = false; // only hide CSS after a real frame paints
    const t0 = performance.now();
    let spin = 0;
    let last = t0;

    const demoteToCss = () => {
      // Restore CSS galaxy if GPU path dies mid-session (context lost,
      // tab kill, driver reset) — never leave a blank bright disc.
      live = false;
      globe?.classList.remove('pl-orb-live');
      cv.style.display = 'none';
    };

    const draw = (now: number) => {
      if (gl.isContextLost()) {
        demoteToCss();
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      spin += dt * (spinBase + spinWave * Math.sin(now * 0.0004));
      gl.uniform1f(uT, (now - t0) / 1000 + 18);
      gl.uniform1f(uSpin, spin);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // Promote only after the first successful paint so a failed init
      // never strips the CSS stars/bands.
      if (!live) {
        live = true;
        globe?.classList.add('pl-orb-live');
      }
      if (!reduce && visible) raf = requestAnimationFrame(draw);
    };

    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      demoteToCss();
    };
    cv.addEventListener('webglcontextlost', onLost, false);

    // Pause off-screen to save GPU; generous margin so scrolling past the
    // theater doesn't freeze the orb while it's still in view.
    const scrollRoot = cv.closest('.pl-root') as Element | null;
    const observeEl = (cv.closest('.pl-theater') as Element | null) || cv;
    const io = new IntersectionObserver(([e]) => {
      const was = visible;
      visible = e.isIntersecting;
      if (visible && !was && !reduce && live && !gl.isContextLost()) {
        last = performance.now();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    }, scrollRoot
      ? { root: scrollRoot, threshold: 0.01, rootMargin: '80px 0px' }
      : { threshold: 0.01, rootMargin: '80px 0px' });
    io.observe(observeEl);

    // Page visibility: iOS suspends RAF; resume cleanly when the tab returns.
    const onVis = () => {
      if (document.hidden || reduce || !live || gl.isContextLost()) return;
      last = performance.now();
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(draw);
    };
    document.addEventListener('visibilitychange', onVis);

    raf = requestAnimationFrame(draw);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      cv.removeEventListener('webglcontextlost', onLost);
      document.removeEventListener('visibilitychange', onVis);
      globe?.classList.remove('pl-orb-live');
    };
  }, []);
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

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const tiers: PricingTier[] = (pricing?.tiers as PricingTier[]) || [];

  const priceBlock = (t: PricingTier) => {
    if (!t.price || t.price === 0) return <span className="pl-serif" style={{ fontSize: 40, fontWeight: 500 }}>Free</span>;
    const amount = pricingService.formatPrice(t.price, t.currencySymbol, t.currency);
    const suffix = t.period === 'month' ? '/mo' : t.period === 'year' ? '/yr' : '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="pl-serif" style={{ fontSize: 42, fontWeight: 500, letterSpacing: '-0.02em' }}>{amount}</span>
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
            <h1 className="pl-serif" style={{ fontWeight: 500, fontSize: 'clamp(37px, 4.4vw, 62px)', lineHeight: 1.02, letterSpacing: '-0.03em', margin: 0 }} data-pl-hero aria-label={`Every interview question, ${HERO_LINE}`}>
              <span aria-hidden="true">
                <span style={{ color: 'var(--paper)' }}>Every interview question,</span>
                <br />
                <span style={{ display: 'inline-block', minHeight: '1.05em' }}>
                  <em className="pl-gold" style={{ fontStyle: 'italic' }}>{typed || ' '}</em>
                  <span className="pl-caret" />
                </span>
              </span>
            </h1>
            <p className="pl-hero-sub" style={{ fontSize: 'clamp(15px, 1.4vw, 17.5px)', lineHeight: 1.6, color: 'var(--mut)' }}>
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
                    <p className="pl-serif" style={{ fontSize: 18, lineHeight: 1.55, color: 'var(--paper)', letterSpacing: '-0.01em' }}>
                      {ANSWER}<span className="pl-caret" />
                    </p>

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
                        <span className="pl-hide-sm">0.8s</span>
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

      {/* ── Trust line ──────────────────────────────────────── */}
      <section className="pl-wrap pl-reveal" style={{ paddingTop: 64, paddingBottom: 64, textAlign: 'center' }}>
        <p style={{ fontSize: 11.5, letterSpacing: '.22em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 22 }}>
          Candidates use it to land offers at
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          {PROOF.map((c, i) => (
            <React.Fragment key={c}>
              {i > 0 && <span style={{ color: 'var(--gold)', opacity: 0.5 }}>·</span>}
              <span className="pl-serif" style={{ fontSize: 19, color: '#b7b1a4' }}>{c}</span>
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
            <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, lineHeight: 1.04, letterSpacing: '-0.025em', marginBottom: 20 }}>
              They share the screen.<br /><span className="pl-gold pl-foil">They still can’t see it.</span>
            </h2>
            <p style={{ fontSize: 16.5, lineHeight: 1.65, color: 'var(--mut)', maxWidth: 460 }}>
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
                <span className="pl-serif" style={{ fontSize: 17, color: i === 0 ? 'var(--paper)' : 'var(--mut)' }}>{m}</span>
                {i === 0
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--gold)', fontWeight: 600 }}><span className="pl-live" /> active</span>
                  : <span style={{ fontSize: 11, color: 'var(--faint)' }}>ready</span>}
              </div>
            ))}
          </div>
          <div style={{ order: -1 }}>
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Five minds, one earpiece</div>
            <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, lineHeight: 1.04, letterSpacing: '-0.025em', marginBottom: 20 }}>
              The right model<br />for <span className="pl-gold pl-foil">every question.</span>
            </h2>
            <p style={{ fontSize: 16.5, lineHeight: 1.65, color: 'var(--mut)', maxWidth: 460 }}>
              Claude Sonnet 5 for reasoning, GPT-5.5 for range, Gemini 3.5 for speed, Grok and Groq when you need instant. Switch minds mid-interview — no one will know.
            </p>
          </div>
        </div>

        <div className="pl-goldline pl-drawline" />

        {/* Moment 3 — Auto-Type */}
        <div className="pl-reveal pl-moment">
          <div>
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Auto-Type · Ultra</div>
            <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, lineHeight: 1.04, letterSpacing: '-0.025em', marginBottom: 20 }}>
              It can even<br /><span className="pl-gold pl-foil">type it for you.</span>
            </h2>
            <p style={{ fontSize: 16.5, lineHeight: 1.65, color: 'var(--mut)', maxWidth: 460 }}>
              On Ultra, the perfect answer lands straight into the box at a human cadence — hands-free, for take-homes and live coding alike.
            </p>
          </div>
          <div style={{ border: '1px solid var(--gold-line)', borderRadius: 16, padding: 20, background: 'linear-gradient(180deg,#100e0a,#0a0908)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--gold)' }}><PhBolt size={14} weight="fill" /> Auto-Type</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.14em', color: 'var(--gold)', border: '1px solid var(--gold-line)', borderRadius: 999, padding: '3px 9px' }}>ULTRA</span>
            </div>
            <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.6, color: '#d9d3c6', background: 'rgba(0,0,0,.35)', borderRadius: 10, padding: '14px 16px', minHeight: 92 }}>
              def two_sum(nums, target):<br />
              &nbsp;&nbsp;seen = {'{}'}<br />
              &nbsp;&nbsp;for i, n in enumerate(nums):<span className="pl-caret" />
            </div>
          </div>
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

      {/* ── Capability ledger — the rest of the kit, spec-sheet style ── */}
      <section id="kit" className="pl-wrap" style={{ paddingTop: 72, paddingBottom: 24 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 40, maxWidth: 640, marginLeft: 'auto', marginRight: 'auto' }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>Beyond the answer</div>
          <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, letterSpacing: '-0.025em', marginBottom: 14 }}>
            Every detail, <span className="pl-gold pl-foil">already handled.</span>
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--mut)' }}>
            The quiet systems around the big moment — all working before you notice you need them.
          </p>
        </div>
        <div className="pl-ledger pl-reveal">
          {LEDGER.map((f) => (
            <div key={f.t} className="pl-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="pl-serif" style={{ fontSize: 19, fontWeight: 500, letterSpacing: '-0.015em' }}>{f.t}</span>
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
          <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, letterSpacing: '-0.025em' }}>
            Live help, three quiet steps.
          </h2>
        </div>
        {STEPS.map((s, idx) => (
          <div key={s.n} className="pl-reveal">
            <div className="pl-goldline" style={{ margin: '0 0 30px' }} />
            <div className="pl-step-row">
              <span className="pl-serif pl-num">{s.n}</span>
              <div className="pl-step-copy">
                <h3 className="pl-serif" style={{ fontSize: 'clamp(22px,3vw,32px)', fontWeight: 500, letterSpacing: '-0.02em' }}>{s.t}</h3>
                <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--mut)' }}>{s.b}</p>
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

      {/* ── Privacy — the discretion pact ───────────────────── */}
      <section id="privacy" className="pl-wrap" style={{ paddingTop: 72, paddingBottom: 32 }}>
        <div className="pl-moment" style={{ alignItems: 'start', padding: 0 }}>
          <div className="pl-reveal">
            <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Discretion, engineered</div>
            <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, lineHeight: 1.04, letterSpacing: '-0.025em', marginBottom: 20 }}>
              What we <span className="pl-gold pl-foil">never keep.</span>
            </h2>
            <p style={{ fontSize: 16.5, lineHeight: 1.65, color: 'var(--mut)', maxWidth: 440, marginBottom: 28 }}>
              A tool this private has to be private all the way down. The whole pipeline is built to forget — audio, screenshots, keystrokes.
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
              <span className="pl-serif" style={{ fontSize: 17, color: 'var(--mut)' }}>{p}</span>
            </React.Fragment>
          ))}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--faint)', letterSpacing: '.02em' }}>
          Windows 10+ · macOS 12+ (native on Apple Silicon) · Linux (Ubuntu 22.04+, Fedora 38+)
        </p>
      </section>

      {/* ── Pricing ─────────────────────────────────────────── */}
      {/* Wider than pl-wrap (1280 vs 1140): five tiers since the 2026-07
          overhaul — at 1140 the grid fits four per row and Ultra orphans. */}
      <section id="pricing" style={{ maxWidth: 1280, margin: '0 auto', padding: '80px 34px 40px', position: 'relative', zIndex: 2 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 44, maxWidth: 620, marginLeft: 'auto', marginRight: 'auto' }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>Pricing</div>
          <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, letterSpacing: '-0.025em', marginBottom: 16 }}>
            Pay for the interview,<br /><span className="pl-gold pl-foil">not a subscription.</span>
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--mut)' }}>
            One-time passes for the interviews that matter — or go unlimited with Ultra.{pricing?.currency ? ` Prices in ${pricing.currency}.` : ''}
          </p>
        </div>
        <div className="pl-reveal" style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 8 }}>One-time passes</div>
          <div className="pl-passes">
            {tiers.filter(t => t.id !== 'ultra').map((t) => {
              const pop = !!t.popular;
              const Mark = TIER_MARK[t.id];
              return (
                <div key={t.id} className={pop ? 'pl-price-pop' : 'pl-price'} style={{ borderRadius: 18, padding: 20, display: 'flex', flexDirection: 'column', position: 'relative' }}>
                  {pop && (
                    <span style={{ position: 'absolute', top: -9, left: 20, fontSize: 9, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: '#231c0c', background: 'linear-gradient(100deg,var(--gold-1),var(--gold-3))', padding: '2px 8px', borderRadius: 999 }}>Most chosen</span>
                  )}
                  {Mark && (
                    <div style={{ marginBottom: 8, height: 24, display: 'flex', alignItems: 'center' }}>
                      <Mark size={24} />
                    </div>
                  )}
                  <h3 className="pl-serif" style={{ fontSize: 18, fontWeight: 500 }}>{t.name}</h3>
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
          const ultra = tiers.find(t => t.id === 'ultra');
          if (!ultra) return null;
          const Mark = TIER_MARK[ultra.id];
          return (
            <div className="pl-reveal">
              <div style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--gold)', margin: '2px 0 6px' }}>Flagship — unlimited</div>
              <div className="pl-ultra-band">
                <div>
                  {Mark && <div style={{ marginBottom: 6 }}><Mark size={38} /></div>}
                  <h3 className="pl-serif" style={{ fontSize: 23, fontWeight: 500, letterSpacing: '-0.01em' }}>{ultra.name}</h3>
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
        <p className="pl-reveal" style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--faint)', letterSpacing: '.02em', marginTop: 28 }}>
          Stripe or Razorpay at checkout · Apple Pay · Google Pay · UPI in India ·{' '}
          <button className="pl-footnote-link" onClick={() => setShowRefund(true)}>14-day first-purchase refund window</button>
        </p>
      </section>

      {/* ── FAQ ─────────────────────────────────────────────── */}
      <section id="faq" className="pl-wrap" style={{ paddingTop: 80, paddingBottom: 40 }}>
        <div className="pl-reveal" style={{ textAlign: 'center', marginBottom: 40 }}>
          <div className="pl-eyebrow" style={{ marginBottom: 18 }}>Questions</div>
          <h2 className="pl-serif" style={{ fontSize: 'clamp(27px,3.6vw,44px)', fontWeight: 500, letterSpacing: '-0.025em' }}>
            Asked. <span className="pl-gold pl-foil">Answered.</span>
          </h2>
        </div>
        <div className="pl-reveal" style={{ maxWidth: 760, margin: '0 auto' }}>
          {FAQS.map((f) => (
            <details key={f.q} className="pl-faq">
              <summary>
                <span className="pl-serif" style={{ fontSize: 19, fontWeight: 500, letterSpacing: '-0.015em' }}>{f.q}</span>
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
          <div className="pl-eyebrow" style={{ marginBottom: 20 }}>Calm outside · lightning within</div>
          <h2 className="pl-serif" style={{ fontSize: 'clamp(30px,4.2vw,56px)', fontWeight: 500, lineHeight: 1.04, letterSpacing: '-0.028em', marginBottom: 26 }}>
            <span style={{ color: 'var(--paper)' }}>The offer is one</span><br />
            <em className="pl-gold pl-foil" style={{ fontStyle: 'italic' }}>great answer away.</em>
          </h2>
          <p style={{ fontSize: 17.5, color: 'var(--mut)', maxWidth: 480, margin: '0 auto 36px' }}>
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
