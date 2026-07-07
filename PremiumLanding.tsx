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
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface PremiumLandingProps {
  // Exact views the landing navigates to — a subset of SubscriptionGate's
  // View union, spelled out so passing its setState dispatcher type-checks.
  setView: (v: 'login' | 'signup' | 'docs' | 'support' | 'tutorials') => void;
  pricing: RegionPricing;
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
}
.pl-root *{box-sizing:border-box;}
.pl-root ::selection{background:rgba(211,172,99,.3);color:#fff;}
.pl-root :focus-visible{outline:2px solid var(--gold-2);outline-offset:3px;border-radius:4px;}
.pl-serif{font-family:'Newsreader','Tiempos Headline',ui-serif,Georgia,serif;}
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
.pl-obj{position:relative;background:linear-gradient(180deg,#100e0a,#0a0908);
  border:1px solid var(--gold-line);border-radius:20px;
  box-shadow:0 50px 120px -34px rgba(0,0,0,.92), 0 0 74px -26px rgba(211,172,99,.20), 0 0 0 1px rgba(255,255,255,.04), inset 0 1px 0 rgba(255,255,255,.06);}
.pl-tilt{transition:transform .5s cubic-bezier(.2,.8,.25,1);will-change:transform;transform:perspective(1200px) rotateY(6deg) rotateX(1.6deg);}
.pl-rim{position:absolute;inset:0;border-radius:20px;pointer-events:none;
  background:radial-gradient(460px 260px at var(--rimx,50%) var(--rimy,16%), rgba(246,228,176,.09), transparent 62%);
  transition:background-position .3s;}
.pl-spot{position:absolute;left:50%;top:38%;width:760px;height:520px;transform:translate(-50%,-50%);
  background:radial-gradient(ellipse at center, var(--gold-glow), transparent 62%);
  filter:blur(30px);pointer-events:none;z-index:0;}
.pl-beam{position:absolute;left:50%;top:32%;width:680px;height:540px;max-width:92vw;
  transform:translate(-50%,-50%);pointer-events:none;z-index:1;}
/* ── Hero: two-column cinematic stage. Left = the promise; right = the product,
   lit like an object on black glass (still directional light + a real
   reflection — an expensive product shot, NOT an ambient glow). ── */
.pl-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.06fr);
  gap:clamp(30px,4.4vw,60px);align-items:center;min-height:min(80vh,720px);}
.pl-hero-copy{max-width:560px;}
.pl-hero-sub{max-width:470px;margin-top:26px;}
.pl-hero-cta{display:flex;gap:24px;align-items:center;flex-wrap:wrap;justify-content:flex-start;margin:36px 0 16px;}
.pl-hero-visual{position:relative;}
.pl-stagelight{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);
  width:140%;height:132%;pointer-events:none;z-index:0;
  background:radial-gradient(56% 50% at 58% 34%,rgba(226,193,120,.14),rgba(211,172,99,.045) 46%,transparent 72%);}
.pl-reflectwrap{position:relative;z-index:2;
  /* Glass reflection under the hero card. GOTCHA: for below-reflections
     the mask gradient maps onto the FLIPPED copy - gradient 0% is the far
     edge, 100% is the seam at the card's bottom. The previous
     (rgba(.30) to transparent 55%) was therefore upside down: it faded the
     reflection IN with distance, painting a readable inverted card ~300px
     below the hero, behind the company-names strip. Correct form:
     transparent for the far 68%, ramping to 22% only at the seam - the
     sheen kisses the card bottom and is gone within ~a third of its height. */
  -webkit-box-reflect:below 14px linear-gradient(transparent 68%, rgba(0,0,0,.22));
  animation:pl-heroin 1.15s cubic-bezier(.2,.8,.2,1) both;}
@keyframes pl-heroin{from{opacity:0;transform:translateY(22px);}to{opacity:1;transform:none;}}
@media (max-width:980px){
  .pl-hero{grid-template-columns:1fr;gap:44px;min-height:0;text-align:center;}
  .pl-hero-copy{max-width:none;margin:0 auto;}
  .pl-hero-sub{margin-left:auto;margin-right:auto;}
  .pl-hero-cta{justify-content:center;}
  .pl-reflectwrap{-webkit-box-reflect:none;}
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
.pl-price{background:linear-gradient(180deg,rgba(255,255,255,.022),rgba(255,255,255,0));
  border:1px solid var(--line);border-radius:18px;transition:border-color .35s,transform .4s cubic-bezier(.2,.9,.3,1),box-shadow .4s;}
.pl-price:hover{transform:translateY(-4px);border-color:rgba(255,255,255,.14);}
.pl-price-pop{border:1px solid var(--gold-line);
  background:linear-gradient(180deg, rgba(211,172,99,.08), rgba(211,172,99,.01));
  box-shadow:0 40px 90px -46px rgba(211,172,99,.5), inset 0 1px 0 rgba(255,255,255,.06);}
.pl-price-pop:hover{border-color:rgba(211,172,99,.5);transform:translateY(-4px);}
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
@media (prefers-reduced-motion:reduce){
  .pl-root *{animation:none !important;}
  .pl-reveal{opacity:1 !important;transform:none !important;}
  .pl-drawline{transform:none !important;}
  .pl-foil{background-position:0 0 !important;}
  .pl-lamp,.pl-mote{display:none !important;}
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
  { q: 'Is the free trial actually free?', a: 'Yes. Signing up gives you 30 minutes of the full experience — no card, nothing to cancel. After the trial you keep a free model for casual practice; nothing ever auto-converts to paid.' },
  { q: 'Is this cheating?', a: 'We don’t make that call for you. Modern interviews increasingly test recall of obscure trivia under pressure more than they test the actual job. We build the tool; how you use it is your decision.' },
  { q: 'Is my interview audio stored anywhere?', a: 'No. Audio streams to the transcription engine, comes back as text, and is discarded. Every provider we use runs on paid API tiers whose terms exclude your data from training.' },
  { q: 'What do I need to run it?', a: 'Windows 10 or later, macOS 12 Monterey or later (native on Apple Silicon), or Linux (Ubuntu 22.04+, Fedora 38+). It works with any interview platform that plays audio through your computer.' },
  { q: 'Can I use one account on two machines?', a: 'A license binds to one device. Signing in on a new machine evicts the old one — so you can move any time, but two people can’t share a seat.' },
  { q: 'What if it doesn’t work out?', a: 'There’s a 14-day window on your first purchase — under two hours of use gets a full refund. Cancel any time and keep access through the period you already paid for.' },
];

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
    }, 550);
    return () => { clearTimeout(start); clearInterval(iv); };
  }, [reduce]);

  // Subtle scroll-reveal (sections) + self-drawing hairlines.
  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('pl-in'); io.unobserve(e.target); } }),
      { threshold: 0.14, rootMargin: '0px 0px -6% 0px' },
    );
    rootRef.current?.querySelectorAll('.pl-reveal, .pl-drawline').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

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

  // Hero object: tilt toward the pointer while the gold rim light moves the
  // opposite way, like a real reflection. Direct style writes — no state.
  const onHeroMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = tiltRef.current;
    if (!el || prefersReduce()) return;
    const r = el.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    el.style.transform = `perspective(1200px) rotateX(${(1.6 - ny * 2.4).toFixed(2)}deg) rotateY(${(6 + nx * 3.2).toFixed(2)}deg)`;
    rimRef.current?.style.setProperty('--rimx', `${(50 - nx * 34).toFixed(1)}%`);
    rimRef.current?.style.setProperty('--rimy', `${(16 - ny * 26).toFixed(1)}%`);
  };
  const onHeroLeave = () => {
    if (tiltRef.current) tiltRef.current.style.transform = 'perspective(1200px) rotateY(6deg) rotateX(1.6deg)';
    rimRef.current?.style.setProperty('--rimx', '50%');
    rimRef.current?.style.setProperty('--rimy', '16%');
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <button className="pl-navlink pl-hide-sm" onClick={() => setView('login')}>Sign in</button>
            <button onClick={() => setView('signup')} className="pl-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 999, fontSize: 13.5 }}>
              Get started <PhArrowRight size={14} weight="bold" />
            </button>
          </div>
        </nav>
      </div>

      {/* ── Hero ────────────────────────────────────────────── */}
      <header id="pl-top" className="pl-wrap" style={{ paddingTop: 60, paddingBottom: 54, position: 'relative' }}>
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
                  Start free — 30 minutes <PhArrowRight size={17} weight="bold" />
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

          {/* RIGHT — the product, lit like glass. Still directional light (no
              pulse), a floating live-answer panel, dust adrift in the beam, and
              a real reflection beneath — an expensive product shot, not a glow. */}
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
              <div className="pl-obj pl-tilt" ref={tiltRef} onPointerMove={onHeroMove} onPointerLeave={onHeroLeave} style={{ textAlign: 'left', padding: 0 }}>
                <div className="pl-rim" ref={rimRef} aria-hidden />
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: '1px solid var(--line)' }}>
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

                <div style={{ position: 'relative', padding: '24px 22px' }}>
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
        <div className="pl-reveal" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 56, alignItems: 'center', padding: '56px 0' }}>
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
        <div className="pl-reveal" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 56, alignItems: 'center', padding: '56px 0' }}>
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
        <div className="pl-reveal" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 56, alignItems: 'center', padding: '56px 0' }}>
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
        {STEPS.map((s) => (
          <div key={s.n} className="pl-reveal">
            <div className="pl-goldline" style={{ margin: '0 0 30px' }} />
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'clamp(20px,4vw,60px)', alignItems: 'baseline', paddingBottom: 30 }}>
              <span className="pl-serif pl-num">{s.n}</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 20, alignItems: 'baseline' }}>
                <h3 className="pl-serif" style={{ fontSize: 'clamp(22px,3vw,32px)', fontWeight: 500, letterSpacing: '-0.02em' }}>{s.t}</h3>
                <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--mut)' }}>{s.b}</p>
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* ── Privacy — the discretion pact ───────────────────── */}
      <section id="privacy" className="pl-wrap" style={{ paddingTop: 72, paddingBottom: 32 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 56, alignItems: 'start' }}>
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
        <div className="pl-reveal" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(206px,1fr))', gap: 16, alignItems: 'stretch' }}>
          {tiers.map((t) => {
            const pop = !!t.popular;
            const Mark = TIER_MARK[t.id];
            return (
              <div key={t.id} className={pop ? 'pl-price-pop' : 'pl-price'} style={{ borderRadius: 18, padding: 24, display: 'flex', flexDirection: 'column', position: 'relative' }}>
                {pop && (
                  <span style={{ position: 'absolute', top: -10, left: 24, fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: '#231c0c', background: 'linear-gradient(100deg,var(--gold-1),var(--gold-3))', padding: '4px 11px', borderRadius: 999 }}>Most chosen</span>
                )}
                {Mark && (
                  <div style={{ marginBottom: 12, height: 30, display: 'flex', alignItems: 'center' }}>
                    <Mark size={30} />
                  </div>
                )}
                <h3 className="pl-serif" style={{ fontSize: 21, fontWeight: 500 }}>{t.name}</h3>
                {t.subtitle && <p style={{ fontSize: 12.5, color: 'var(--faint)', marginTop: 4 }}>{t.subtitle}</p>}
                <div style={{ margin: '18px 0 16px' }}>{priceBlock(t)}</div>
                <button
                  onClick={() => handleTierSelect(t)}
                  disabled={isSubmitting}
                  className={pop ? 'pl-cta' : undefined}
                  style={pop
                    ? { width: '100%', padding: '11px', borderRadius: 999, fontSize: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: isSubmitting ? 0.6 : 1, cursor: isSubmitting ? 'default' : 'pointer' }
                    : { width: '100%', padding: '11px', borderRadius: 999, fontSize: 14, fontWeight: 600, cursor: isSubmitting ? 'default' : 'pointer', color: 'var(--paper)', background: 'transparent', border: '1px solid rgba(255,255,255,.16)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: isSubmitting ? 0.6 : 1 }}
                >
                  {t.cta || 'Choose'} <PhArrowRight size={14} weight="bold" />
                </button>
                <ul style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(t.features || []).map((f, i) => (
                    <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, color: '#cbc5b9' }}>
                      <PhCheck size={15} weight="fill" color="var(--gold)" style={{ flexShrink: 0, marginTop: 1 }} />
                      <span style={{ lineHeight: 1.45 }}>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
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

      {/* ── Closing ─────────────────────────────────────────── */}
      <section className="pl-wrap pl-reveal" style={{ paddingTop: 100, paddingBottom: 100, textAlign: 'center', position: 'relative' }}>
        <div className="pl-spot" style={{ top: '50%' }} />
        <div style={{ position: 'relative', zIndex: 2 }}>
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
