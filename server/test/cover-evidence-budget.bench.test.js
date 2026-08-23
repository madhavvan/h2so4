// ⚠️ REAL GROQ CALLS + a running server on :4321. Gated behind COVERBUDGET=1.
//   COVERBUDGET=1 BENCH_TOKENS=<file> npx vitest run test/cover-evidence-budget.bench --silent=false
//
// HOW BIG SHOULD THE COVER'S SLICE OF THE DOCUMENT BE?
//
// COVER_EVIDENCE_CHARS trades two things that pull in opposite directions,
// and neither is visible from the code:
//
//   accuracy      a bigger slice carries more of the candidate's material,
//                 so a rarely-mentioned tool is more likely to be in front
//                 of the model when it is asked about.
//   availability  a bigger prompt is slower to answer, and the cover has
//                 only ~1,050ms before the question is sent. Measured: the
//                 shipping 7k value delivered 8/12 covers where 3k delivered
//                 12/12.
//
// Tuning on either number alone is how you get a fast cover that is wrong or
// a right cover nobody hears. So the metric here is the one the candidate
// actually experiences:
//
//   USABLE = the cover arrived inside the window AND named the right fact.
//
// GROUND TRUTH comes from the document, not from opinion. The corpus is a
// real 168 KB interview dossier; the facts below were counted in it:
//   Evonik x41, Cook MyoSite x21, MSN x15, Sciegen x11   (real employers)
//   Eli Lilly x3                                          (the TARGET — never an employer)
//   Agilent x42, Kneat x29, HPLC x26, Empower x24, Waters x21
//   UV-Vis x12, FTIR x12, LIMS x12, TOC x11, LC-MS x10, UPLC x8
//   Karl Fischer x3, Chromeleon x1, Beckman x1            (RARE — the sensitive ones)
//
// The rare tools are the point. The documented failure that set the budget
// at 7k was "the model lost a tool the candidate uses daily, 3 times out of
// 3" — so if a smaller budget loses accuracy, it will show up on Karl
// Fischer and TOC long before it shows up on HPLC.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const RUN = process.env.COVERBUDGET === '1';
const BASE = 'http://127.0.0.1:4321';
const DOC = process.env.BENCH_DOC
  || 'C:\\Users\\penta\\Downloads\\DEEPKNOWLEDGE_Lilly_CQV_Lead_Lab_Instruments.md';

const { selectCoverEvidence, _setCoverEvidenceBudget } = await import('../../services/coverSource.ts');

// The real auto-send window: 1,200ms composer timer minus the 150ms
// transcript debounce. A cover that lands later is written and discarded.
const WINDOW_MS = 1_050;

const CASES = [
  // ── common facts: should survive any budget ──
  { q: 'Have you worked with Empower chromatography data system?', must: /empower/i },
  { q: 'What chromatography systems have you qualified?',          must: /hplc|uplc|\bgc\b|chromatograph/i },
  { q: 'Which instrument vendors have you worked with?',           must: /agilent|waters|thermo|mettler|shimadzu/i },
  { q: 'What do you use for validation documentation?',            must: /kneat|lims|electronic/i },
  // ── the employer question: right answer AND no target-company claim ──
  { q: 'Where have you worked before this?',                       must: /evonik|cook\s*myosite|msn|sciegen/i, mustNot: /eli\s*lilly/i },
  { q: 'Tell me about yourself.',                                  must: /cqv|qualification|validation|evonik/i, mustNot: /eli\s*lilly/i },
  // ── RARE tools: where a too-small budget will fail first ──
  { q: 'Have you qualified a Karl Fischer titrator?',              must: /karl\s*fischer|titrat|moisture|water content/i },
  { q: 'What about TOC analyzers — have you qualified those?',     must: /\btoc\b|total organic carbon/i },
  { q: 'Have you worked with FTIR?',                               must: /ftir|infrared|spectroscop/i },
  { q: 'Have you qualified UV-Vis spectrophotometers?',            must: /uv|spectrophotomet|spectroscop/i },
  { q: 'Any LC-MS qualification experience?',                      must: /lc-?ms|mass\s*spec/i },
  // ── numeric + pure-domain: no personal fact required ──
  { q: 'How many analytical assets have you been responsible for?', must: /\b70\b|\b100\b|seventy|hundred|dozens|many/i },
  { q: 'What is the difference between IQ, OQ and PQ?',            must: /install|operat|perform|iq|oq|pq/i },
  { q: 'A calibration comes back out of tolerance mid-study. What do you do?', must: /impact|assess|quarantin|deviation|as-found/i },
];

const SIZES = [2_500, 3_500, 4_500, 5_500, 7_000, 9_000];

const files = [{ id: 'kb', name: 'kb.md', type: 'custom', content: fs.readFileSync(DOC, 'utf8') }];

async function cover(question, coverContext, token) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/v1/ai/cover/prewarm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'x-app-version': '4.0.22' },
    body: JSON.stringify({ question, provider: 'openai', coverContext, coverVocabulary: '', recentTurns: '' }),
  });
  const j = await r.json().catch(() => ({}));
  return { ms: Date.now() - t0, cover: j.cover || '', reason: j.reason || null };
}

describe('how big should the cover evidence budget be', () => {
  it(RUN ? 'sweeps budget vs USABLE covers' : 'skipped (set COVERBUDGET=1)', async () => {
    if (!RUN) return;
    // One token per size — the prewarm cache is keyed user|provider|question,
    // so sharing a user makes every arm after the first a 2ms cache hit.
    const tokens = fs.readFileSync(process.env.BENCH_TOKENS, 'utf8').trim().split('\n').map(s => s.trim()).filter(Boolean);
    expect(tokens.length, 'need one token per size arm').toBeGreaterThanOrEqual(SIZES.length);

    const table = [];
    for (let i = 0; i < SIZES.length; i++) {
      const size = SIZES[i];
      const token = tokens[i];
      _setCoverEvidenceBudget(size);
      let arrived = 0, correct = 0, usable = 0, fabricated = 0;
      const times = [];
      const misses = [];
      for (const c of CASES) {
        const ctx = selectCoverEvidence(files, c.q);
        const r = await cover(c.q, ctx, token);
        times.push(r.ms);
        const inTime = !!r.cover && r.ms <= WINDOW_MS;
        const hit = !!r.cover && c.must.test(r.cover);
        const bad = !!r.cover && c.mustNot && c.mustNot.test(r.cover);
        if (r.cover) arrived++;
        if (hit && !bad) correct++;
        if (inTime && hit && !bad) usable++; else misses.push(`${c.q.slice(0, 30)} [${!r.cover ? (r.reason || 'none') : bad ? 'FABRICATED' : !hit ? 'wrong-fact' : r.ms + 'ms late'}]`);
        if (bad) fabricated++;
      }
      const med = times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)];
      table.push({ size, n: CASES.length, arrived, correct, usable, fabricated, med, misses });
    }
    _setCoverEvidenceBudget(null);

    console.log('\n  budget   produced  correct  USABLE(in-time+right)  fabricated  median');
    console.log('  ' + '-'.repeat(76));
    for (const r of table) {
      console.log(
        `  ${String(r.size).padStart(5)}    ${r.arrived}/${r.n}      ${r.correct}/${r.n}`
        + `         ${String(r.usable + '/' + r.n).padStart(5)}`
        + `              ${r.fabricated}        ${r.med}ms`
      );
    }
    console.log('\n  what each arm missed:');
    for (const r of table) console.log(`   ${r.size}: ${r.misses.join(' | ') || '(nothing)'}`);

    const best = table.slice().sort((a, b) => (b.usable - a.usable) || (a.size - b.size))[0];
    console.log(`\n  ==> best USABLE: ${best.usable}/${best.n} at ${best.size} chars (median ${best.med}ms)`);
    // Fabrication is a hard failure at any size — it is the thing the guard
    // and the identity-lead fix exist to prevent.
    for (const r of table) expect(r.fabricated, `budget ${r.size} produced a target-company claim`).toBe(0);
  }, 900_000);
});
