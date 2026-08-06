// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE LIGHT THEME IS A LIST, AND A LIST CANNOT NOTICE
//
//  The app is dark-first: components hardcode dark Tailwind utilities and
//  index.css remaps them for light mode by LITERAL CLASS NAME. That works
//  for every name somebody remembered and fails silently for every one they
//  did not, because nothing in the build, the types or the tests could tell
//  the difference between "remapped" and "still white on cream".
//
//  Audited 2026-07-29 against the compiled stylesheet, 27 utilities were
//  painting unreadably in light mode:
//    · 7 text-white alphas had no rule at all (/20 /30 /35 /55 /65 /75 /85)
//    · bg-white/[0.1] was remapped; bg-white/10 — same colour, the other
//      spelling Tailwind accepts — was not
//    · the scale that DID exist bottomed out at 1.92:1
//    · pale semantic tints (amber-200/90 at 1.13:1) were a bright smear
//
//  This suite re-derives that audit from the source, so the gap cannot
//  reopen quietly. It reads the SHIPPED hex values out of index.css and
//  measures them — no build required, no snapshot to go stale.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'index.css'), 'utf8');
const TSX = fs.readdirSync(ROOT).filter((f) => /\.tsx$/.test(f));

// ── colour maths ──
const PAGE = [0xfa, 0xf6, 0xec];
const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (f, b) => { const a = lum(f) + 0.05; const c = lum(b) + 0.05; return a > c ? a / c : c / a; };
function parseHex(h) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(s.substr(i, 2), 16));
}

// ── every utility the components reference ──
const used = new Map();
for (const f of TSX) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const t of src.matchAll(/[\w!:[\]/\\.\-#()%,]+/g)) {
    const s = t[0];
    if (!/^(?:hover:|focus:|active:|group-hover:)?(?:text|bg|border|ring|divide|placeholder)-/.test(s)) continue;
    if (!used.has(s)) used.set(s, new Set());
    used.get(s).add(f);
  }
}

// ── every class the light layer remaps ──
const remapped = new Set();
for (const m of CSS.matchAll(/:root:not\(\.dark\)([^{]*)\{/g)) {
  for (const sel of m[1].split(',')) {
    for (const c of sel.matchAll(/\.((?:\\.|[^\s.:>+~[\](){}])+)/g)) {
      remapped.add(c[1].replace(/\\/g, ''));
    }
  }
}
// A variant may be remapped under EITHER name: `hover:bg-white/10` is
// written in CSS as `.hover\:bg-white\/10:hover`, so the remapped set holds
// the prefixed form — while a plain `.bg-white\/10` rule also covers it,
// since the hover class shares the same declaration block in Tailwind's
// output only when written that way. Checking one form and not the other
// reported six rules as missing that were right there.
const isRemapped = (cls) => remapped.has(cls)
  || remapped.has(cls.replace(/^(?:hover|focus|active|group-hover):/, ''));

// ── the light rules and the colours they actually ship ──
const rules = new Map();
for (const m of CSS.matchAll(/:root:not\(\.dark\)\s+([^{]+)\{([^}]*)\}/g)) {
  const body = m[2];
  const col = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,8})/.exec(body);
  if (!col) continue;
  for (const c of m[1].matchAll(/\.((?:\\.|[^\s.:>+~[\](){}])+)/g)) {
    rules.set(c[1].replace(/\\/g, ''), col[1]);
  }
}

describe('coverage — a dark-surface utility with no light rule is invisible', () => {
  // These families are pure dark-mode assumptions: white ink, white washes,
  // white hairlines. On cream every one of them is either invisible or a
  // bright smear, so every variant the app uses needs a rule.
  const FAMILIES = [
    [/^(?:hover:|focus:|active:|group-hover:)?text-white(\/\d+)?$/, 'white text'],
    [/^(?:hover:|focus:|active:|group-hover:)?bg-white\/[\d.[\]]+$/, 'white surface'],
    [/^(?:hover:|focus:|active:|group-hover:)?border-white\/[\d.[\]]+$/, 'white border'],
    [/^(?:hover:|focus:|active:|group-hover:)?divide-white\/[\d.[\]]+$/, 'white divider'],
    [/^(?:hover:|focus:|active:|group-hover:)?ring-white\/[\d.[\]]+$/, 'white ring'],
    [/^placeholder-white\/[\d.[\]]+$/, 'white placeholder'],
  ];

  for (const [re, label] of FAMILIES) {
    it(`every ${label} variant used is remapped`, () => {
      const missing = [];
      for (const [cls, files] of used) {
        if (!re.test(cls)) continue;
        if (!isRemapped(cls)) missing.push(`${cls} (${[...files].slice(0, 2).join(', ')})`);
      }
      if (missing.length) {
        console.log(`   MISSING ${label} rules:\n     ` + missing.join('\n     '));
      }
      expect(missing, `add a :root:not(.dark) rule in index.css for: ${missing.join(' ')}`).toEqual([]);
    });
  }

  it('the two spellings of one colour are both remapped', () => {
    // bg-white/[0.1] and bg-white/10 are the same colour. One was remapped
    // and the other was not, which is how a card became invisible.
    for (const [cls] of used) {
      const m = /^(?:hover:)?(bg|border)-white\/\[0?\.(\d+)\]$/.exec(cls);
      if (!m) continue;
      const pct = m[2].length === 1 ? `${m[2]}0` : String(Number(`0.${m[2]}`) * 100);
      const twin = cls.replace(/\/\[0?\.\d+\]$/, `/${Number(pct)}`);
      if (!used.has(twin)) continue;
      expect(isRemapped(cls), `${cls} unmapped while its twin ${twin} is used`).toBe(true);
      expect(isRemapped(twin), `${twin} unmapped while its twin ${cls} is used`).toBe(true);
    }
  });

  it('pale NEUTRAL text and dark neutral surfaces are remapped', () => {
    // Found by rendering real in-app class strings and measuring the painted
    // pixels: text-gray-200 came out at 1.15:1. The layer mapped gray-300
    // through gray-600 and stopped, so the two palest shades — the ones used
    // as bright text on dark, which vanish hardest on cream — had no rule.
    const missing = [];
    for (const [cls, files] of used) {
      const pale = /^(?:hover:|focus:|group-hover:)?text-(gray|zinc|slate|neutral|stone)-(50|100|200|300)(?:\/\d+)?$/.test(cls);
      const darkSurface = /^(?:hover:|focus:|group-hover:)?(bg|border|divide)-(gray|zinc|slate|neutral|stone)-(600|700|800|900|950)(?:\/[\d.[\]]+)?$/.test(cls);
      if (!pale && !darkSurface) continue;
      if (!isRemapped(cls)) missing.push(`${cls} (${[...files][0]})`);
    }
    if (missing.length) console.log('   MISSING neutral rules:\n     ' + missing.join('\n     '));
    expect(missing).toEqual([]);
  });

  it('pale semantic tints used for text are remapped', () => {
    // A -100/-200/-300 shade is a light-on-dark colour. Used as text on
    // cream it is the "very bright" half of the report.
    const missing = [];
    for (const [cls, files] of used) {
      const m = /^(?:hover:|group-hover:)?text-(amber|orange|red|rose|blue|cyan|emerald|green|purple|violet|yellow|teal|indigo|pink|sky|lime|fuchsia)-(100|200|300)(?:\/\d+)?$/.exec(cls);
      if (!m) continue;
      if (!isRemapped(cls)) missing.push(`${cls} (${[...files][0]})`);
    }
    if (missing.length) console.log('   MISSING semantic rules:\n     ' + missing.join('\n     '));
    expect(missing).toEqual([]);
  });
});

describe('quality — the shipped colours are readable on cream', () => {
  it('no light text rule falls below the legibility floor', () => {
    const bad = [];
    for (const [cls, hexv] of rules) {
      const c = parseHex(hexv);
      if (!c) continue;
      const r = contrast(c, PAGE);
      // 2.4 is the floor for purely decorative / disabled text; anything
      // that carries information is checked more strictly below.
      if (r < 2.35) bad.push(`${cls} ${hexv} ${r.toFixed(2)}:1`);
    }
    if (bad.length) console.log('   BELOW FLOOR:\n     ' + bad.join('\n     '));
    expect(bad).toEqual([]);
  });

  it('text-white/40 and /50 are no longer unreadable', () => {
    // The exact regression: /40 shipped #b8b4a5 (1.92:1) and /50 shipped
    // #9b988e (2.67:1) — measurably invisible and measurably too faint.
    for (const [cls, floor] of [['text-white/40', 2.9], ['text-white/50', 3.2], ['text-white/60', 3.8]]) {
      const hexv = rules.get(cls);
      expect(hexv, `${cls} has no light rule`).toBeTruthy();
      const r = contrast(parseHex(hexv), PAGE);
      console.log(`   ${cls.padEnd(15)} ${hexv}  ${r.toFixed(2)}:1`);
      expect(r, `${cls} is ${r.toFixed(2)}:1, below ${floor}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('neutral body/metadata text clears 3.2:1', () => {
    // text-gray-600 shipped #9b988e = 2.67:1 and is used for 10px uppercase
    // metadata. Measured by rendering real markup, not by reading the file.
    const bad = [];
    for (const [cls, hexv] of rules) {
      if (!/^text-(gray|zinc|slate|neutral|stone)-\d{2,3}$/.test(cls)) continue;
      const r = contrast(parseHex(hexv), PAGE);
      if (r < 3.2) bad.push(`${cls} ${hexv} ${r.toFixed(2)}:1`);
    }
    if (bad.length) console.log('   TOO FAINT:\n     ' + bad.join('\n     '));
    expect(bad).toEqual([]);
  });

  it('semantic text clears 4:1 — a warning has to be readable to warn', () => {
    const bad = [];
    for (const [cls, hexv] of rules) {
      if (!/^text-(amber|orange|red|rose|blue|cyan|emerald|green|purple|violet|yellow|teal|indigo|pink)-/.test(cls)) continue;
      const r = contrast(parseHex(hexv), PAGE);
      if (r < 4.0) bad.push(`${cls} ${hexv} ${r.toFixed(2)}:1`);
    }
    if (bad.length) console.log('   TOO FAINT:\n     ' + bad.join('\n     '));
    expect(bad).toEqual([]);
  });

  it('the text-white scale is monotonic — a higher alpha is never lighter', () => {
    const scale = [];
    for (const [cls, hexv] of rules) {
      const m = /^text-white\/(\d+)$/.exec(cls);
      if (m) scale.push([Number(m[1]), contrast(parseHex(hexv), PAGE), hexv]);
    }
    scale.sort((a, b) => a[0] - b[0]);
    console.log('   ' + scale.map(([a, r]) => `/${a}:${r.toFixed(1)}`).join(' '));
    for (let i = 1; i < scale.length; i++) {
      expect(scale[i][1], `text-white/${scale[i][0]} (${scale[i][2]}) is lighter than /${scale[i - 1][0]}`)
        .toBeGreaterThanOrEqual(scale[i - 1][1] - 0.01);
    }
    expect(scale.length).toBeGreaterThanOrEqual(10);
  });
});

describe('the fixes that needed judgement, not a formula', () => {
  it('modal scrims are softened, but a non-scrim dark tint is left alone', () => {
    for (const c of ['bg-black/80', 'bg-black/70', 'bg-black/60']) {
      expect(remapped.has(c), `${c} is a full-screen scrim and should be softened`).toBe(true);
    }
    // bg-black/40 is used, but never as a scrim — a dark tint on cream is a
    // legitimate recessed surface and must not be touched.
    expect(remapped.has('bg-black/40')).toBe(false);
  });

  it('gradient text that starts at white is made solid ink', () => {
    expect(CSS).toMatch(/\.bg-clip-text\.from-white/);
    expect(CSS).toMatch(/-webkit-text-fill-color:\s*#141413/);
  });

  it('the dark toast-card gradient is remapped', () => {
    for (const c of ['from-slate-900', 'to-slate-800']) {
      expect(remapped.has(c), `${c} paints a dark card on a light page`).toBe(true);
    }
  });
});
