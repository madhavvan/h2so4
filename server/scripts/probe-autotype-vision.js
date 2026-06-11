// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUTOTYPE-VISION ENDPOINT PROBE
//  Verifies the /api/v1/ai/autotype-vision route end-to-end:
//  auth (Max tier) → autoTypeVisionAgent → Claude vision → tool_use
//  → validated plan shape. Cost: ONE Claude vision call (~$0.015).
//
//  Uses a synthetic PNG that draws a few lines of code-like text so
//  the model has something real to plan against.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
'use strict';
const http = require('http');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// ── Build a minimal but VALID PNG: white canvas with black rectangles
// laid out like indented code lines. Enough for the vision model to
// recognize "this is a code editor screenshot" and exercise the full
// validation path. Hand-rolled so the probe has zero image-lib deps.
function buildSyntheticEditorPng(width, height) {
  // RGBA raster, white background.
  const px = Buffer.alloc(width * height * 4, 0xff);
  const setPx = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 0xff;
  };
  // Draw 8 "code lines" as dark bars with varying indent + length;
  // line 4 left blank (the empty function body where a caret would sit).
  const lines = [
    { indent: 4, len: 180 }, { indent: 4, len: 240 }, { indent: 24, len: 120 },
    { indent: 44, len: 0 },  { indent: 24, len: 90 },  { indent: 4, len: 60 },
    { indent: 4, len: 200 }, { indent: 24, len: 150 },
  ];
  lines.forEach((ln, row) => {
    const y0 = 30 + row * 28;
    for (let y = y0; y < y0 + 12; y++) {
      for (let x = ln.indent; x < ln.indent + ln.len; x++) setPx(x, y, 30, 30, 35);
    }
  });
  // PNG encode: filter-0 per row, zlib deflate, assemble chunks.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter type 0
    px.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  const crc = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(td), 0);
    return Buffer.concat([len, td, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
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
  console.log(cond ? `✅ ${label}` : `❌ ${label} — ${detail || ''}`);
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

(async () => {
  const db = require('../src/database');
  const jwt = require('jsonwebtoken');
  const adminUser = db.getDB().prepare("SELECT id, email FROM users WHERE LOWER(email) = 'nippu@gmail.com'").get();
  if (!adminUser) { console.error('No admin user in DB; aborting'); process.exit(2); }
  const token = jwt.sign({ id: adminUser.id, email: adminUser.email, tier: 'max' }, process.env.JWT_SECRET, { expiresIn: '15m' });

  const png = buildSyntheticEditorPng(420, 260);
  const b64 = png.toString('base64');
  console.log(`synthetic PNG: ${png.length} bytes, base64 ${b64.length} chars`);

  console.log('\n━━━ POST /api/v1/ai/autotype-vision ━━━\n');
  const t0 = Date.now();
  const r = await post('/api/v1/ai/autotype-vision', token, {
    screenshotBase64: b64,
    screenshotMediaType: 'image/png',
    code: 'def solve(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total',
    language: 'python',
  });
  const took = Date.now() - t0;
  console.log(`HTTP ${r.status} in ${took}ms`);
  console.log(`body: ${r.body.slice(0, 600)}`);

  assert('route responded 200', r.status === 200, `got ${r.status}`);
  const plan = JSON.parse(r.body);
  assert('plan.ok === true', plan.ok === true);
  assert('planner_used === vision', plan.planner_used === 'vision', `got ${plan.planner_used}`);
  assert('cursor_action is valid', ['use_current', 'move_relative', 'move_to_end'].includes(plan.cursor_action), `got ${plan.cursor_action}`);
  assert('lines_delta is an integer', Number.isInteger(plan.lines_delta), `got ${plan.lines_delta}`);
  assert('lines_delta clamped to ±400', plan.lines_delta >= -400 && plan.lines_delta <= 400);
  assert('confidence in [0,1]', typeof plan.confidence === 'number' && plan.confidence >= 0 && plan.confidence <= 1, `got ${plan.confidence}`);
  assert('skip_leading is non-negative int', Number.isInteger(plan.skip_leading) && plan.skip_leading >= 0);
  assert('skip_trailing is non-negative int', Number.isInteger(plan.skip_trailing) && plan.skip_trailing >= 0);
  assert('wipe_chars clamped 0..200', Number.isInteger(plan.wipe_chars) && plan.wipe_chars >= 0 && plan.wipe_chars <= 200);
  assert('prefix is a string', typeof plan.prefix === 'string');
  assert('suffix is a string', typeof plan.suffix === 'string');
  assert('reasoning present', typeof plan.reasoning === 'string' && plan.reasoning.length > 0);

  console.log(`\n   model reasoning: ${String(plan.reasoning).slice(0, 220)}`);
  console.log('\n✅✅✅ /autotype-vision wired end-to-end: auth → vision agent → Claude → validated plan.\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ PROBE FAILED:', e.message);
  process.exit(1);
});
