// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VISION CURSOR-DETECTION PROBE
//
//  Answers ONE question definitively: when the cursor is dropped
//  somewhere in the editor, does /autotype-vision actually DETECT
//  where it is and pick the correct place to start writing — or
//  does it just trust wherever the user put it?
//
//  Method: render a REAL, readable CoderPad-style editor screenshot
//  with @napi-rs/canvas (monospace code text, line-number gutter,
//  active-line highlight, a visible caret bar) and send it to the
//  live /autotype-vision endpoint.
//
//  TEST 1 — caret in the WRONG place (on the `import math` line).
//    The only correct plan is cursor_action=move_relative with a
//    positive lines_delta to reach the empty function body. If the
//    model returns move_relative with a sane delta → detection +
//    relocation PROVEN. If it returns use_current → it is NOT
//    relocating; it is trusting the user's (wrong) placement.
//
//  TEST 2 — caret already ON the correct line (the empty body).
//    Correct plan is use_current / lines_delta 0 — proves the model
//    doesn't needlessly move the caret when it's already right.
//
//  Cost: 2 Claude vision calls (~$0.03 total).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
'use strict';
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// @napi-rs/canvas lives in the repo-root node_modules; require resolves
// up the tree from here so a bare specifier finds it.
const { createCanvas } = require('@napi-rs/canvas');

// Render a dark-theme code editor screenshot with a visible caret.
// caretLine is 0-indexed into `lines`; the caret is drawn at the end of
// that line's text, plus a full-width active-line highlight band.
function renderEditorPng({ lines, caretLine }) {
  const padTop = 24, lineH = 30, gutterW = 56, fontPx = 17;
  const width = 920;
  const height = padTop * 2 + lines.length * lineH + 40;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Editor background (CodeMirror "one dark"-ish).
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, width, height);
  // Gutter.
  ctx.fillStyle = '#181825';
  ctx.fillRect(0, 0, gutterW, height);

  ctx.font = `${fontPx}px Menlo, Consolas, "DejaVu Sans Mono", monospace`;
  ctx.textBaseline = 'middle';

  lines.forEach((text, i) => {
    const y = padTop + i * lineH + lineH / 2;
    // Active-line highlight band on the caret's line.
    if (i === caretLine) {
      ctx.fillStyle = '#313244';
      ctx.fillRect(gutterW, padTop + i * lineH, width - gutterW, lineH);
    }
    // Line number.
    ctx.fillStyle = '#6c7086';
    ctx.fillText(String(i + 1), 14, y);
    // Code text.
    ctx.fillStyle = '#cdd6f4';
    ctx.fillText(text, gutterW + 10, y);
    // Caret bar at end of the caret line's text.
    if (i === caretLine) {
      const w = ctx.measureText(text).width;
      ctx.fillStyle = '#f5e0dc';
      ctx.fillRect(gutterW + 10 + w + 1, padTop + i * lineH + 5, 2, lineH - 10);
    }
  });

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

function assert(label, cond, detail) {
  console.log(cond ? `  ✅ ${label}` : `  ❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

// The editor's current template (what's already on screen). Line 3 is
// the empty, indented function body — the correct insertion point.
const EDITOR_LINES = [
  'import math',                       // 0
  '',                                  // 1
  'def solve(n):',                     // 2
  '    ',                              // 3  ← empty body (insertion point)
  '',                                  // 4
  'if __name__ == "__main__":',        // 5
  '    print(solve(int(input())))',    // 6
];

// The full solution the user wants typed.
const CODE_TO_TYPE = [
  'import math',
  '',
  'def solve(n):',
  '    total = 0',
  '    for i in range(n):',
  '        total += i',
  '    return total',
  '',
  'if __name__ == "__main__":',
  '    print(solve(int(input())))',
].join('\n');

(async () => {
  const db = require('../src/database');
  const jwt = require('jsonwebtoken');
  const adminUser = db.getDB().prepare("SELECT id, email FROM users WHERE LOWER(email) = 'nippu@gmail.com'").get();
  if (!adminUser) { console.error('No admin user; aborting'); process.exit(2); }
  const token = jwt.sign({ id: adminUser.id, email: adminUser.email, tier: 'max' }, process.env.JWT_SECRET, { expiresIn: '15m' });

  // ── TEST 1: caret on the WRONG line (line 0, `import math`) ──
  console.log('\n━━━ TEST 1: caret dropped on the WRONG line (line 1: "import math") ━━━');
  console.log('    Insertion point is the empty body on line 4. Correct plan MUST');
  console.log('    relocate the caret down to it (move_relative, positive delta).\n');
  const png1 = renderEditorPng({ lines: EDITOR_LINES, caretLine: 0 });
  const r1 = await post('/api/v1/ai/autotype-vision', token, {
    screenshotBase64: png1.toString('base64'),
    screenshotMediaType: 'image/png',
    code: CODE_TO_TYPE,
    language: 'python',
  });
  assert('route responded 200', r1.status === 200, `got ${r1.status}: ${r1.body.slice(0,200)}`);
  const p1 = JSON.parse(r1.body);
  console.log(`  plan: action=${p1.cursor_action} lines_delta=${p1.lines_delta} target_col=${p1.target_column} skip_lead=${p1.skip_leading} skip_trail=${p1.skip_trailing} wipe_first=${p1.wipe_first_line} conf=${p1.confidence}`);
  console.log(`  reasoning: ${String(p1.reasoning).slice(0, 260)}\n`);
  assert('confidence >= 0.7 (plan would actually be USED)', p1.confidence >= 0.7, `conf=${p1.confidence}`);
  assert('DETECTED wrong cursor → cursor_action is move_relative (not use_current)',
    p1.cursor_action === 'move_relative',
    `got "${p1.cursor_action}" — if use_current, the model is NOT relocating, it trusts the user's placement`);
  assert('relocation is DOWNWARD toward the body (lines_delta > 0)',
    p1.lines_delta > 0, `lines_delta=${p1.lines_delta}`);
  assert('relocation magnitude is sane (1..6 lines)',
    p1.lines_delta >= 1 && p1.lines_delta <= 6, `lines_delta=${p1.lines_delta}`);
  assert('DETECTED existing code above (skip_leading >= 2)',
    p1.skip_leading >= 2, `skip_leading=${p1.skip_leading} — should detect import/blank/def already present`);
  assert('DETECTED existing code below (skip_trailing >= 2)',
    p1.skip_trailing >= 2, `skip_trailing=${p1.skip_trailing} — should detect __main__/print already present`);

  // ── TEST 2: caret already ON the correct line (line 3, empty body) ──
  console.log('━━━ TEST 2: caret dropped ON the correct line (line 4: the empty body) ━━━');
  console.log('    Correct plan should NOT move the caret (use_current, or delta 0).\n');
  const png2 = renderEditorPng({ lines: EDITOR_LINES, caretLine: 3 });
  const r2 = await post('/api/v1/ai/autotype-vision', token, {
    screenshotBase64: png2.toString('base64'),
    screenshotMediaType: 'image/png',
    code: CODE_TO_TYPE,
    language: 'python',
  });
  assert('route responded 200', r2.status === 200, `got ${r2.status}`);
  const p2 = JSON.parse(r2.body);
  console.log(`  plan: action=${p2.cursor_action} lines_delta=${p2.lines_delta} target_col=${p2.target_column} skip_lead=${p2.skip_leading} skip_trail=${p2.skip_trailing} conf=${p2.confidence}`);
  console.log(`  reasoning: ${String(p2.reasoning).slice(0, 260)}\n`);
  assert('confidence >= 0.7', p2.confidence >= 0.7, `conf=${p2.confidence}`);
  assert('caret already correct → no big move (use_current OR |delta| <= 1)',
    p2.cursor_action === 'use_current' || Math.abs(p2.lines_delta) <= 1,
    `action=${p2.cursor_action} delta=${p2.lines_delta} — model wants to move a caret that's already in the right place`);
  assert('still DETECTED existing code above (skip_leading >= 2)',
    p2.skip_leading >= 2, `skip_leading=${p2.skip_leading}`);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅✅✅ VERIFIED: the vision planner DETECTS cursor position —');
  console.log('   it relocated a wrong caret (Test 1) and left a correct one alone (Test 2),');
  console.log('   and in both cases detected the template code already in the editor.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  console.error('   (A failed assertion here is a real finding — it tells us cursor');
  console.error('    detection is NOT working the way it should.)');
  process.exit(1);
});
