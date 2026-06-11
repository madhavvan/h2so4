// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HARD MULTI-CHUNK VISION PROBE — the real stress test
//
//  Renders a realistic full-screen coding-test layout where the editor
//  contains a GENUINELY messy template:
//    • imports (one missing — `deque`)
//    • CHUNK 1: sliding_window_max() — half-written, BROKEN (missing
//      colon on the `while`, incomplete deque logic)
//    • a junk line `jkdslfj` — accidental keystrokes from a confused user
//    • CHUNK 2: dedupe_stream() — just a `pass` stub
//    • driver code at the bottom
//  ...and the caret is dropped MID-CHUNK-1, on the broken `while` line —
//  exactly the "I don't know where I am" scenario.
//
//  It pushes this through the LIVE /autotype-vision endpoint (the same
//  one the Electron app calls) — now the MULTI-OPERATION schema (v2) —
//  and reports the operation list verbatim, then gives an honest verdict:
//  did the planner reason in STRUCTURE (separate targeted ops for the
//  missing import / broken chunk-1 / junk line / chunk-2 stub, leaving
//  the already-correct driver code alone), or collapse to one whole-file
//  replace (the old dumb behavior)?
//
//  Run twice — consistency matters as much as correctness.
//  Cost: 2 Claude vision calls (~$0.03).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
'use strict';
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createCanvas } = require('@napi-rs/canvas');

// What's actually IN the testpad editor — messy, multi-chunk, broken.
const EDITOR_LINES = [
  '#!/bin/python3',                                            // 0
  'import sys',                                                // 1
  'from collections import defaultdict, Counter',              // 2
  '',                                                          // 3
  '# Implement sliding_window_max() and dedupe_stream() below', // 4
  '',                                                          // 5
  'def sliding_window_max(nums, k):',                          // 6
  '    dq = []',                                               // 7
  '    out = []',                                              // 8
  '    for i, n in enumerate(nums):',                          // 9
  '        while dq and nums[dq[-1]] <= n',                    // 10 ← BROKEN (no colon) + CARET HERE
  '    return out',                                            // 11
  '',                                                          // 12
  'jkdslfj',                                                   // 13 ← accidental junk
  '',                                                          // 14
  'def dedupe_stream(items):',                                 // 15
  '    pass',                                                  // 16 ← stub
  '',                                                          // 17
  "if __name__ == '__main__':",                                // 18
  '    raw = sys.stdin.read().split()',                        // 19
  '    print(sliding_window_max(list(map(int, raw)), 3))',     // 20
];
const CARET_LINE = 10; // mid CHUNK 1, on the broken `while` line

// The full, correct solution the user wants in place.
const CODE_TO_TYPE = [
  '#!/bin/python3',
  'import sys',
  'from collections import defaultdict, Counter, deque',
  '',
  '# Implement sliding_window_max() and dedupe_stream() below',
  '',
  'def sliding_window_max(nums, k):',
  '    dq = deque()',
  '    out = []',
  '    for i, n in enumerate(nums):',
  '        while dq and nums[dq[-1]] <= n:',
  '            dq.pop()',
  '        dq.append(i)',
  '        if dq[0] <= i - k:',
  '            dq.popleft()',
  '        if i >= k - 1:',
  '            out.append(nums[dq[0]])',
  '    return out',
  '',
  'def dedupe_stream(items):',
  '    seen = set()',
  '    result = []',
  '    for it in items:',
  '        if it not in seen:',
  '            seen.add(it)',
  '            result.append(it)',
  '    return result',
  '',
  "if __name__ == '__main__':",
  '    raw = sys.stdin.read().split()',
  '    print(sliding_window_max(list(map(int, raw)), 3))',
].join('\n');

// Realistic full-screen test layout: chrome + left problem panel +
// the editor (one region) + bottom console. Editor code at real size.
function renderTestPadPng() {
  const W = 1680, H = 1050;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0f0f14'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2b2b34'; ctx.fillRect(0, 0, W, 64);
  ctx.fillStyle = '#3a3a45'; ctx.fillRect(16, 14, 240, 34);
  ctx.fillStyle = '#1f1f27'; ctx.fillRect(20, 70, W - 40, 30);
  ctx.fillStyle = '#9aa0aa';
  ctx.font = '13px Menlo, Consolas, monospace'; ctx.textBaseline = 'middle';
  ctx.fillText('codepad.io/test/sliding-window-and-dedupe', 32, 85);

  // Left problem panel.
  ctx.fillStyle = '#16161d'; ctx.fillRect(0, 104, 600, H - 104);
  ctx.fillStyle = '#c9ced6'; ctx.font = 'bold 19px Arial';
  ctx.fillText('Stream Analytics — 2 functions', 24, 138);
  ctx.fillStyle = '#3a3f48';
  for (let i = 0; i < 20; i++) ctx.fillRect(24, 168 + i * 25, 540 - (i % 5) * 50, 11);

  // Editor.
  const edX = 612, edY = 104, edW = W - edX, edH = 720;
  ctx.fillStyle = '#1e1e2e'; ctx.fillRect(edX, edY, edW, edH);
  ctx.fillStyle = '#181822'; ctx.fillRect(edX, edY, edW, 32);
  ctx.fillStyle = '#8a8f99'; ctx.font = '12px Arial';
  ctx.fillText('solution.py', edX + 14, edY + 16);
  const gutterW = 46;
  ctx.fillStyle = '#181825'; ctx.fillRect(edX, edY + 32, gutterW, edH - 32);

  const fontPx = 14, lineH = 21, codeTop = edY + 42;
  ctx.font = `${fontPx}px Menlo, Consolas, "DejaVu Sans Mono", monospace`;
  EDITOR_LINES.forEach((text, i) => {
    const y = codeTop + i * lineH + lineH / 2;
    if (i === CARET_LINE) {
      ctx.fillStyle = '#2f2f42';
      ctx.fillRect(edX + gutterW, codeTop + i * lineH, edW - gutterW, lineH);
    }
    ctx.fillStyle = '#5b6068';
    ctx.fillText(String(i + 1), edX + 12, y);
    // junk line in a faint red to mimic a lint squiggle context
    ctx.fillStyle = (text === 'jkdslfj') ? '#e0a0a0' : '#cdd6f4';
    ctx.fillText(text, edX + gutterW + 8, y);
    if (i === CARET_LINE) {
      const w = ctx.measureText(text).width;
      ctx.fillStyle = '#f5e0dc';
      ctx.fillRect(edX + gutterW + 8 + w + 1, codeTop + i * lineH + 3, 2, lineH - 6);
    }
  });

  ctx.fillStyle = '#16161d'; ctx.fillRect(edX, edY + edH, edW, H - (edY + edH));
  ctx.fillStyle = '#8a8f99'; ctx.font = '13px Arial';
  ctx.fillText('Console', edX + 14, edY + edH + 22);
  return c.toBuffer('image/png');
}

function post(jwt, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      method: 'POST', hostname: 'localhost', port: 4000,
      path: '/api/v1/ai/autotype-vision',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${jwt}`,
      },
    }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

// The scenario, in DOCUMENT line numbers (gutter, 1-indexed):
//   L3        — import line, MISSING `deque`
//   L7-L12    — CHUNK 1 sliding_window_max, BROKEN/INCOMPLETE
//   L14       — junk `jkdslfj`
//   L16-L17   — CHUNK 2 dedupe_stream, STUB (`pass`)
//   L19-L21   — driver code, CORRECT — must NOT be touched
const overlaps = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;

function scoreRun(p) {
  const ops = Array.isArray(p.operations) ? p.operations : [];
  const usable = typeof p.confidence === 'number' && p.confidence >= 0.7;
  // A region is "addressed" if any op overlaps it (small tolerance band).
  const hitImport = ops.some(o => overlaps(o.start_line, o.end_line, 2, 4));
  const hitChunk1 = ops.some(o => overlaps(o.start_line, o.end_line, 7, 12));
  const hitJunk   = ops.some(o => overlaps(o.start_line, o.end_line, 13, 15));
  const hitChunk2 = ops.some(o => overlaps(o.start_line, o.end_line, 15, 18));
  // Touching the correct driver code with a replace/delete = NOT a minimal diff.
  const touchedDriver = ops.some(o => o.op !== 'insert' && overlaps(o.start_line, o.end_line, 19, 21));
  // The old dumb collapse: one giant replace spanning ~the whole file.
  const wholeFileRewrite = ops.length === 1 && ops[0].op === 'replace'
    && ops[0].start_line <= 2 && ops[0].end_line >= 18;
  const regionsHit = [hitImport, hitChunk1, hitJunk, hitChunk2].filter(Boolean).length;
  return { ops, usable, hitImport, hitChunk1, hitJunk, hitChunk2, touchedDriver, wholeFileRewrite, regionsHit };
}

(async () => {
  const db = require('../src/database');
  const jwt = require('jsonwebtoken');
  const u = db.getDB().prepare("SELECT id, email FROM users WHERE LOWER(email) = 'nippu@gmail.com'").get();
  if (!u) { console.error('No admin user'); process.exit(2); }
  const token = jwt.sign({ id: u.id, email: u.email, tier: 'max' }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const png = renderTestPadPng();
  require('fs').writeFileSync(path.resolve(__dirname, 'probe-hard-multichunk-sample.png'), png);
  console.log(`rendered ${png.length}-byte testpad (saved to scripts/probe-hard-multichunk-sample.png)`);
  console.log('Scenario: caret on line 11 — the BROKEN `while` line, mid CHUNK 1.');
  console.log('Editor has: missing import (L3), broken chunk 1 (L7-12), junk line "jkdslfj" (L14),');
  console.log('stub chunk 2 (L16-17), CORRECT driver code (L19-21 — must be left alone).\n');

  const runs = [];
  for (let n = 1; n <= 2; n++) {
    const t0 = Date.now();
    const r = await post(token, {
      screenshotBase64: png.toString('base64'),
      screenshotMediaType: 'image/png',
      code: CODE_TO_TYPE,
      language: 'python',
    });
    if (r.status !== 200) { console.log(`RUN ${n}: HTTP ${r.status} — ${r.body.slice(0, 240)}`); continue; }
    const p = JSON.parse(r.body);
    runs.push(p);
    const ops = Array.isArray(p.operations) ? p.operations : [];
    console.log(`━━━ RUN ${n}  (${Date.now() - t0}ms) ━━━`);
    console.log(`  ok=${p.ok}  confidence=${p.confidence}  operations=${ops.length}`);
    ops.forEach((o, i) => {
      const span = o.op === 'insert' ? `after L${o.start_line}` : `L${o.start_line}-${o.end_line}`;
      console.log(`    [${i}] ${String(o.op).padEnd(7)} ${span.padEnd(13)} ${o.reason || ''}`);
      if (o.op !== 'delete') {
        const preview = String(o.text || '').replace(/\n/g, '⏎').slice(0, 64);
        console.log(`         text: ${preview}${(o.text || '').length > 64 ? '…' : ''}`);
      }
    });
    console.log(`  reasoning: ${String(p.reasoning).replace(/\s+/g, ' ').slice(0, 360)}\n`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('HONEST VERDICT  (multi-operation schema v2):');
  if (runs.length === 0) { console.log('  ✗ no successful runs — endpoint failed.'); process.exit(1); }

  let allGood = true;
  for (let i = 0; i < runs.length; i++) {
    const s = scoreRun(runs[i]);
    const tags = [
      s.hitImport ? '✓import' : '✗import',
      s.hitChunk1 ? '✓chunk1' : '✗chunk1',
      s.hitJunk ? '✓junk' : '✗junk',
      s.hitChunk2 ? '✓chunk2' : '✗chunk2',
      s.touchedDriver ? '✗DRIVER-TOUCHED' : '✓driver-safe',
    ];
    let verdict;
    if (s.wholeFileRewrite) {
      verdict = '✗ COLLAPSED — single full-file replace (the old dumb behavior).';
      allGood = false;
    } else if (!s.usable) {
      verdict = `~ would be REJECTED (conf ${runs[i].confidence} < 0.7) → app falls back to dumb typing.`;
      allGood = false;
    } else if (s.touchedDriver) {
      verdict = '✗ touched the CORRECT driver code (L19-21) — not a minimal diff.';
      allGood = false;
    } else if (s.regionsHit >= 3) {
      verdict = `✓ INTELLIGENT — ${s.ops.length} targeted op(s), hit ${s.regionsHit}/4 broken regions, left correct driver alone.`;
    } else {
      verdict = `~ partial — only addressed ${s.regionsHit}/4 broken regions.`;
      allGood = false;
    }
    console.log(`  RUN ${i + 1}: ${verdict}`);
    console.log(`          regions: ${tags.join('  ')}`);
  }

  // Consistency check.
  if (runs.length === 2) {
    const a = scoreRun(runs[0]), b = scoreRun(runs[1]);
    const stable = a.regionsHit === b.regionsHit
      && a.touchedDriver === b.touchedDriver
      && a.wholeFileRewrite === b.wholeFileRewrite;
    console.log(`  consistency: ${stable ? 'STABLE — both runs hit the same region set' : 'UNSTABLE — plans differ between runs (a real concern)'}`);
    if (!stable) allGood = false;
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (allGood) {
    console.log('✅ MULTI-OP SCHEMA WORKS — the planner reasons in STRUCTURE: it');
    console.log('   targets the broken / missing / junk regions with separate ops');
    console.log('   and leaves the already-correct driver code untouched. This is');
    console.log('   the fix for "it still writes the entire code".');
    process.exit(0);
  } else {
    console.log('❌ NOT YET — see per-run verdicts above. The multi-op schema is');
    console.log('   wired end-to-end but the planner is not yet producing coherent,');
    console.log('   minimal, consistent plans on this messy multi-chunk pad.');
    process.exit(3);
  }
})().catch(e => { console.error('PROBE ERROR:', e.message); process.exit(1); });
