// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REALISTIC FULL-SCREEN VISION PROBE
//
//  The earlier probe rendered ONLY the editor, big and clean — and it
//  passed. But captureScreenForVision() grabs the WHOLE SCREEN. On real
//  HackerRank the editor is ~half the screen, wrapped in browser chrome,
//  a problem-statement panel, and a test-case panel — and the caret is
//  ~2px in the downscaled capture.
//
//  This probe renders that realistic layout (1680x1050, editor is one
//  region among several) and feeds it to the LIVE /autotype-vision
//  endpoint. If the planner can no longer detect the caret / existing
//  code (skip_leading collapses to 0, or confidence drops below the 0.7
//  use-threshold), the hypothesis is confirmed: full-screen capture is
//  the bug, and the fix is to crop to the editor before planning.
//
//  Cost: ~2 Claude vision calls (~$0.03).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
'use strict';
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createCanvas } = require('@napi-rs/canvas');

// HackerRank-style Python template currently shown in the editor.
// The caret is dropped on the "# Write your code here" line — mid-file,
// NOT at the start. A correct planner must detect the shebang/imports/
// def lines above are already present (skip_leading > 0).
const EDITOR_LINES = [
  '#!/bin/python3',                       // 0
  '',                                     // 1
  'import math',                          // 2
  'import os',                            // 3
  'import sys',                           // 4
  '',                                     // 5
  'def solve(n):',                        // 6
  '    # Write your code here',           // 7  ← caret dropped HERE (mid-file)
  '',                                     // 8
  "if __name__ == '__main__':",           // 9
  '    n = int(input().strip())',         // 10
  '    print(solve(n))',                  // 11
];
const CARET_LINE = 7;

const CODE_TO_TYPE = [
  '#!/bin/python3',
  '',
  'import math',
  'import os',
  'import sys',
  '',
  'def solve(n):',
  '    total = 0',
  '    for i in range(1, n + 1):',
  '        total += i * i',
  '    return total',
  '',
  "if __name__ == '__main__':",
  '    n = int(input().strip())',
  '    print(solve(n))',
].join('\n');

// Render a realistic full-screen HackerRank-like layout: browser chrome,
// left problem panel, the dark editor (one region of many), bottom test
// panel. The editor's code is rendered at the small size it'd really be.
function renderFullScreenPng() {
  const W = 1680, H = 1050;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Desktop / page bg.
  ctx.fillStyle = '#0f0f14'; ctx.fillRect(0, 0, W, H);

  // Browser chrome (tabs + URL bar).
  ctx.fillStyle = '#2b2b34'; ctx.fillRect(0, 0, W, 64);
  ctx.fillStyle = '#3a3a45'; ctx.fillRect(16, 14, 220, 34);   // active tab
  ctx.fillStyle = '#1f1f27'; ctx.fillRect(20, 70, W - 40, 30); // url bar strip
  ctx.fillStyle = '#9aa0aa';
  ctx.font = '13px Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText('hackerrank.com/challenges/sum-of-squares/problem', 32, 85);

  // Left problem-statement panel.
  ctx.fillStyle = '#16161d'; ctx.fillRect(0, 104, 600, H - 104);
  ctx.fillStyle = '#c9ced6';
  ctx.font = 'bold 20px Arial';
  ctx.fillText('Sum of Squares', 28, 140);
  ctx.fillStyle = '#3a3f48';
  for (let i = 0; i < 18; i++) {
    const lw = 540 - (i % 4) * 60;
    ctx.fillRect(28, 172 + i * 26, lw, 12);
  }

  // ── The EDITOR region — right side, ~1060px wide, one panel of many ──
  const edX = 612, edY = 104, edW = W - edX, edH = 700;
  ctx.fillStyle = '#1e1e2e'; ctx.fillRect(edX, edY, edW, edH);
  // Editor toolbar.
  ctx.fillStyle = '#181822'; ctx.fillRect(edX, edY, edW, 34);
  ctx.fillStyle = '#8a8f99';
  ctx.font = '12px Arial';
  ctx.fillText('Python 3', edX + 14, edY + 17);
  // Gutter.
  const gutterW = 44;
  ctx.fillStyle = '#181825'; ctx.fillRect(edX, edY + 34, gutterW, edH - 34);

  // Code lines — realistic small size (~14px), the size they'd really be.
  const fontPx = 14, lineH = 21, codeTop = edY + 44;
  ctx.font = `${fontPx}px Menlo, Consolas, "DejaVu Sans Mono", monospace`;
  EDITOR_LINES.forEach((text, i) => {
    const y = codeTop + i * lineH + lineH / 2;
    if (i === CARET_LINE) {
      ctx.fillStyle = '#2f2f42';
      ctx.fillRect(edX + gutterW, codeTop + i * lineH, edW - gutterW, lineH);
    }
    ctx.fillStyle = '#5b6068';
    ctx.fillText(String(i + 1), edX + 12, y);
    ctx.fillStyle = '#cdd6f4';
    ctx.fillText(text, edX + gutterW + 8, y);
    if (i === CARET_LINE) {
      const w = ctx.measureText(text).width;
      ctx.fillStyle = '#f5e0dc';
      ctx.fillRect(edX + gutterW + 8 + w + 1, codeTop + i * lineH + 3, 2, lineH - 6);
    }
  });

  // Bottom test-case panel.
  ctx.fillStyle = '#16161d'; ctx.fillRect(edX, edY + edH, edW, H - (edY + edH));
  ctx.fillStyle = '#8a8f99';
  ctx.font = '13px Arial';
  ctx.fillText('Test Results', edX + 14, edY + edH + 24);
  ctx.fillStyle = '#3a3f48';
  for (let i = 0; i < 4; i++) ctx.fillRect(edX + 14, edY + edH + 44 + i * 24, 600, 12);

  return canvas.toBuffer('image/png');
}

function post(pathName, jwt, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      method: 'POST', hostname: 'localhost', port: 4000, path: pathName,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${jwt}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  const db = require('../src/database');
  const jwt = require('jsonwebtoken');
  const adminUser = db.getDB().prepare("SELECT id, email FROM users WHERE LOWER(email) = 'nippu@gmail.com'").get();
  if (!adminUser) { console.error('No admin user; aborting'); process.exit(2); }
  const token = jwt.sign({ id: adminUser.id, email: adminUser.email, tier: 'max' }, process.env.JWT_SECRET, { expiresIn: '15m' });

  const png = renderFullScreenPng();
  console.log(`realistic full-screen PNG: 1680x1050, ${png.length} bytes`);
  // Save it so we can eyeball it if needed.
  require('fs').writeFileSync(path.resolve(__dirname, 'probe-fullscreen-sample.png'), png);
  console.log(`(saved to scripts/probe-fullscreen-sample.png for inspection)`);

  console.log('\n━━━ caret dropped MID-FILE on line 8 ("    # Write your code here") ━━━');
  console.log('    A correct planner must detect: shebang + imports + def are ALREADY');
  console.log('    above (skip_leading > 0), and the __main__ block is below.\n');
  const t0 = Date.now();
  const r = await post('/api/v1/ai/autotype-vision', token, {
    screenshotBase64: png.toString('base64'),
    screenshotMediaType: 'image/png',
    code: CODE_TO_TYPE,
    language: 'python',
  });
  console.log(`HTTP ${r.status} in ${Date.now() - t0}ms`);
  if (r.status !== 200) { console.log(`body: ${r.body.slice(0,300)}`); process.exit(1); }
  const plan = JSON.parse(r.body);
  console.log(`\nplan: action=${plan.cursor_action} lines_delta=${plan.lines_delta} target_col=${plan.target_column} skip_lead=${plan.skip_leading} skip_trail=${plan.skip_trailing} conf=${plan.confidence}`);
  console.log(`reasoning: ${String(plan.reasoning).slice(0, 320)}\n`);

  const detectedExistingCode = plan.skip_leading >= 3;
  const wouldBeUsed = plan.confidence >= 0.7;
  const verdictGood = detectedExistingCode && wouldBeUsed;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (verdictGood) {
    console.log('✅ Full-screen capture STILL works — planner detected the existing');
    console.log(`   code (skip_leading=${plan.skip_leading}) at usable confidence (${plan.confidence}).`);
    process.exit(0);
  } else {
    console.log('❌ HYPOTHESIS CONFIRMED — full-screen capture defeats the planner:');
    if (!detectedExistingCode) console.log(`   • skip_leading=${plan.skip_leading} (expected >=3) — did NOT detect the template above the caret`);
    if (!wouldBeUsed) console.log(`   • confidence=${plan.confidence} (<0.7) — plan would be REJECTED → falls through → full dump`);
    console.log('   FIX: crop the screenshot to the editor region before planning.');
    process.exit(3);
  }
})().catch(e => {
  console.error('\n❌ PROBE ERROR:', e.message);
  process.exit(1);
});
