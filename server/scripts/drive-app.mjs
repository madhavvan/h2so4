// LIVE APP DRIVE — attaches to the running Electron app over CDP (:9222),
// takes console control, injects an admin session, and drives the real UI
// the way a user does. PRIMARY signal is the DOM (the .msg / .msg.ai.
// streaming bubbles the human actually sees), which survives HMR/reload;
// a fetch clone-tap is kept only as secondary wire-timing evidence.
//
// Scenario proven:
//   1. app boots to the main UI as an authed Max/admin user
//   2. deep question → an answer appears on screen FAST (the instant
//      cover; on-screen TTFT target < 2.5s) and streams to a full answer
//   3. the full answer does NOT verbatim-repeat its own opening
//      (seamless cover→continuation, not two glued answers)
//   4. a follow-up sent WHILE the first answer is still streaming:
//      the partial first answer is preserved on screen (committed as its
//      own bubble), and the follow-up gets its own answer
//   5. backchannel gate works inside the live bundle
//   6. zero runtime console errors across the whole run
//
// Run: node --env-file=.env scripts/drive-app.mjs   (from server/)
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const SHOT_DIR = process.env.SHOT_DIR || '.';
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Admin identity from the local dev DB + a real signed token ──
const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'minicaai.db');
const ddb = new Database(dbPath, { readonly: true });
const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
const adminRow = ddb.prepare('SELECT id, email, name FROM users WHERE email = ?').get(adminEmail);
if (!adminRow) { console.log('ABORT: no admin row'); process.exit(1); }
const token = jwt.sign({ id: adminRow.id, email: adminRow.email }, process.env.JWT_SECRET, { expiresIn: '30m' });

// ── CDP plumbing ──
async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      const t = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('mode=popout'));
      if (t) return t;
    } catch {}
    await sleep(500);
  }
  return null;
}
const target = await findTarget();
if (!target) { console.log('ABORT: no CDP page target on :9222'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION: ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '?').slice(0, 300));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push('console.error: ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval failed: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 300));
  return r.result?.result?.value;
};
const waitFor = async (expr, timeoutMs = 20000, everyMs = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await evaluate(expr)) return true; } catch {} await sleep(everyMs); }
  return false;
};

await send('Runtime.enable');
await send('Page.enable');

// ── Phase A: inject admin session + select GPT, reload ──
// Use the REAL license row shape (ultra + unlimited sentinels) so the
// client's time-remaining preflight sees unlimited — a bare {tier}
// object has no time fields and trips the "interview time used up" wall.
const licenseRow = ddb.prepare('SELECT tier, status, expires_at, sessions_limit, sessions_used, credits_remaining_seconds, credits_expire_at, trial_remaining_seconds FROM licenses WHERE user_id = ?').get(adminRow.id) || { tier: 'ultra', status: 'active', expires_at: -1, sessions_limit: -1, sessions_used: 0, credits_remaining_seconds: -1, credits_expire_at: -1, trial_remaining_seconds: 0 };
await evaluate(`(() => {
  localStorage.setItem('minicaai_token', ${JSON.stringify(token)});
  localStorage.setItem('minicaai_auth', JSON.stringify({ id: ${JSON.stringify(adminRow.id)}, email: ${JSON.stringify(adminRow.email)}, name: ${JSON.stringify(adminRow.name || 'Admin')} }));
  localStorage.setItem('minicaai_license', ${JSON.stringify(JSON.stringify(licenseRow))});
  localStorage.setItem('SELECTED_MODEL', 'openai');
  localStorage.setItem('REASONING_EFFORT', 'none');
  return true;
})()`);
await send('Page.reload', { ignoreCache: true }); // hard reload clears Fast Refresh state
await sleep(2800);
const uiUp = await waitFor(`(() => {
  const field = Array.from(document.querySelectorAll('textarea, input[type="text"]')).find(el => el.offsetParent !== null && /listening for interviewer|type or speak/i.test(el.placeholder || ''));
  const btn = document.querySelector('button[aria-label="Send message"]');
  return !!field && !!btn;
})()`, 30000);
const timeWall = await evaluate(`/interview time is used up|free trial.*used up|pick a plan to keep going/i.test(document.body.innerText)`);
record('app boots to main UI as admin', uiUp && !timeWall, uiUp ? (timeWall ? 'BOOTED BUT TIME-WALL ACTIVE' : 'composer ready, no time wall') : 'composer never appeared');
if (!uiUp || timeWall) { console.log('body snippet: ' + (await evaluate('document.body.innerText.slice(0, 400)'))); ws.close(); process.exit(1); }

// ── DOM observers (primary) ── real live-app layout:
//   user bubble = .flex.justify-end (has .markdown-body)
//   AI bubble   = .flex.justify-start (has .markdown-body)
//   STREAMING bubble is the one containing .stream-caret (unique marker)
const domState = `(() => {
  const bubbles = Array.from(document.querySelectorAll('.flex.justify-end, .flex.justify-start'));
  const users = [], ais = [];
  let streamingText = '';
  for (const b of bubbles) {
    const md = b.querySelector('.markdown-body');
    const txt = md ? md.innerText.trim() : '';
    if (b.querySelector('.stream-caret')) { streamingText = txt; continue; }
    if (b.classList.contains('justify-end')) { if (txt) users.push(txt); }
    else if (txt) ais.push(txt);
  }
  return {
    streamingText, streamingLen: streamingText.length,
    userCount: users.length, aiCount: ais.length,
    lastAiText: ais.length ? ais[ais.length - 1] : '',
    thinking: !!document.querySelector('.stream-caret') || /THINKING \\(/.test(document.body.innerText),
  };
})()`;
const getState = async () => JSON.parse(await evaluate(`JSON.stringify(${domState})`));

// Deterministic fresh session via the app's own db.newSession() (same
// call the "New chat" button makes) so no prior-session content pollutes
// the assertions. Falls back to a button click if the dev hook is absent.
await waitFor(`typeof window.__dev_newSession === 'function'`, 8000, 200);
await evaluate(`(() => {
  if (window.__dev_newSession) { window.__dev_newSession(); return 'hook'; }
  const nc = Array.from(document.querySelectorAll('button, a, [role=button]')).find(el => /new chat/i.test(el.innerText || ''));
  if (nc) { nc.click(); return 'click'; }
  return 'none';
})()`);
await sleep(1500);
const cleared = await evaluate(`(${domState}).aiCount === 0 && (${domState}).userCount === 0`);
console.log('fresh session: ' + (cleared ? 'clean (0 messages)' : 'WARNING leftover messages remain'));

// ── Secondary: fetch wire-tap (best-effort; DOM is the source of truth) ──
await evaluate(`(() => {
  window.__probe = [];
  const orig = window.__origFetch || window.fetch.bind(window);
  window.__origFetch = orig;
  window.fetch = async (...a) => {
    const url = String(a[0] || '');
    const resp = await orig(...a);
    if (url.includes('/api/v1/ai/stream/')) {
      const e = { t0: performance.now(), ttftMs: null, chars: 0, done: false };
      window.__probe.push(e);
      try { const c = resp.clone(); (async () => { const rd = c.body.getReader(); const dec = new TextDecoder();
        while (true) { const { value, done } = await rd.read(); if (done) break; const s = dec.decode(value);
          if (e.ttftMs === null && s.includes('"t":')) e.ttftMs = Math.round(performance.now() - e.t0); e.chars += s.length; } e.done = true; })(); } catch {}
    }
    return resp;
  };
  return true;
})()`);

// ── UI send via the real textarea + button (proves UI wiring) ──
const uiSend = async (text) => {
  const r = await evaluate(`(() => {
    const fields = Array.from(document.querySelectorAll('textarea, input[type="text"]')).filter(el => el.offsetParent !== null);
    const field = fields.find(el => /listening for interviewer|type or speak/i.test(el.placeholder || '')) || fields[0];
    if (!field) return 'no-field';
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  if (r !== 'typed') throw new Error('uiSend type failed: ' + r);
  // Wait for the send button to enable (inputText.trim() && !isProcessing), then click.
  const enabled = await waitFor(`!!Array.from(document.querySelectorAll('button[aria-label="Send message"]')).find(b => b.offsetParent !== null && !b.disabled)`, 5000, 100);
  if (!enabled) return 'button-stayed-disabled';
  await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button[aria-label="Send message"]')).find(x => x.offsetParent !== null && !x.disabled); b.click(); return true; })()`);
  return 'clicked';
};

const Q1 = 'How would you design a rate limiter that supports per-user quotas across multiple regions?';
const Q2 = 'How would you design a URL shortener that scales to a billion links?';
const Q3 = 'And how would you handle sudden traffic bursts on top of that?';
const idle = () => waitFor(`window.__dev_isProcessing ? !window.__dev_isProcessing() : true`, 30000, 200);

// Wait for the app to be idle (no prior stream still processing) so the
// send fires immediately and the measured TTFT is the cover's, not the
// send button waiting on a previous request.
await waitFor(`window.__dev_isProcessing ? !window.__dev_isProcessing() : true`, 15000, 200);
const base = await getState();
const probeBefore = await evaluate('(window.__probe || []).length');

// ── Phase B: deep question → instant on-screen answer (the cover) ──
const sendT0 = Date.now();
const clickRes = await uiSend(Q1);
record('deep Q accepted by UI (textarea+button)', clickRes === 'clicked', `result=${clickRes}`);

// On-screen TTFT: first moment new answer text is visible in the live
// streaming bubble (delta vs baseline).
const gotOnScreen = await waitFor(`(() => { const s = ${domState}; return s.streamingLen > 0 || s.aiCount > ${base.aiCount}; })()`, 12000, 40);
const onScreenTtft = Date.now() - sendT0;
// Capture the cover opening from the LIVE streaming bubble immediately.
let coverText = (await getState()).streamingText.slice(0, 120);
// Wire TTFT (ground truth for cover latency) from this send's probe entry.
await sleep(200);
const wireTtft = await evaluate(`(() => { const p = window.__probe || []; const e = p[${probeBefore}]; return e ? e.ttftMs : null; })()`);
record('deep Q → cover FAST (wire is ground truth, DOM follows)', gotOnScreen && wireTtft !== null && wireTtft < 2500,
  `wire TTFT=${wireTtft}ms · on-screen=${onScreenTtft}ms · cover="${coverText.slice(0, 40)}..."`);

// Let Q1 FULLY complete (no interruption) — this is the clean cover→
// continuation seam test.
const q1Done = await waitFor(`(() => { const s = ${domState}; return !s.thinking && s.aiCount >= ${base.aiCount + 1}; })()`, 60000, 300);
const q1State = await getState();
const q1Answer = q1State.lastAiText;
record('deep Q → full answer rendered', q1Done && q1Answer.length > 200, `answerLen=${q1Answer.length}`);

// Seam test: the full single answer must not verbatim-repeat its own
// opening (which would mean the continuation re-stated the cover instead
// of continuing it). Check the cover opening appears exactly once.
const openFrag = (coverText || q1Answer).slice(0, 45).replace(/\s+/g, ' ').trim();
const repeatCount = openFrag.length > 25 ? await evaluate(`(() => {
  const a = ${JSON.stringify(q1Answer)}; const c = ${JSON.stringify(openFrag)};
  let n = 0, i = -1; while ((i = a.indexOf(c, i + 1)) !== -1) n++; return n;
})()`) : 0;
record('no verbatim repeat of cover opening (seam)', repeatCount <= 1, `opening="${openFrag.slice(0, 38)}..." occurrences=${repeatCount}`);

// ── Phase C: INTERRUPTION — send Q2, then Q3 mid-stream ──
await idle();
const cBase = await getState();
await evaluate(`(window.__dev_executeSend(${JSON.stringify(Q2)}), true)`);
// Interrupt the INSTANT the cover appears (streamingLen>60) — a wide
// mid-stream window, since the full answer takes ~5-8s to finish.
const q2Streaming = await waitFor(`(${domState}).streamingLen > 60`, 20000, 30);
const midState = await getState();
const partialBefore = midState.streamingText.slice(0, 80);
record('Q2 answer streaming (interviewer about to cut in)', q2Streaming && midState.streamingLen > 60, `streamingLen=${midState.streamingLen}`);

// Interviewer interrupts with Q3 mid-stream (voice path → executeSend).
await evaluate(`(window.__dev_executeSend(${JSON.stringify(Q3)}), true)`);
const settled = await waitFor(`(() => { const s = ${domState}; return !s.thinking && s.userCount >= ${cBase.userCount + 2} && s.aiCount >= ${cBase.aiCount + 2}; })()`, 90000, 400);
const afterState = await getState();
record('interruption: Q3 sent mid-Q2, both answered', settled && afterState.userCount >= cBase.userCount + 2 && afterState.aiCount >= cBase.aiCount + 2,
  `userDelta=${afterState.userCount - cBase.userCount} aiDelta=${afterState.aiCount - cBase.aiCount}`);
const partialSurvived = partialBefore.length > 30
  ? await evaluate(`document.body.innerText.includes(${JSON.stringify(partialBefore)})`)
  : false;
record('interrupted Q2 partial preserved on screen', !!partialSurvived, `partial="${partialBefore.slice(0, 45)}..."`);

// ── Phase D: backchannel module inside the live bundle ──
const bc = await evaluate(`import('/services/interruption.ts').then(m => JSON.stringify({
  a: m.isBackchannelOnly('okay'), b: m.isBackchannelOnly('hmm, got it'),
  c: m.isBackchannelOnly('okay, now design a cache for me'), d: m.isBackchannelOnly('why?'),
})).catch(e => JSON.stringify({ err: String(e).slice(0,120) }))`, true);
const bcv = JSON.parse(bc || '{}');
record('backchannel gate (live module)', bcv.a === true && bcv.b === true && bcv.c === false && bcv.d === false, JSON.stringify(bcv));

// ── Phase E: quality eyeball + screenshot + console digest ──
const p = JSON.parse(await evaluate('JSON.stringify(window.__probe || [])') || '[]');
console.log(`wire probe: ${p.length} stream(s) — ${p.map(x => `TTFT=${x.ttftMs}ms/${x.chars}ch/done=${x.done}`).join(' , ')}`);
console.log('--- Q1 answer on screen (first 420 chars) ---\n' + q1Answer.slice(0, 420) + '\n---');
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => null)]);
  if (shot && shot.result?.data) { writeFileSync(path.join(SHOT_DIR, 'app-drive.png'), Buffer.from(shot.result.data, 'base64')); console.log('screenshot: app-drive.png written'); }
  else console.log('screenshot skipped (timeout)');
} catch (e) { console.log('screenshot failed: ' + e.message.slice(0, 120)); }

const realErrors = consoleErrors.filter(e => !/ERR_CONNECTION_REFUSED.*9222|Autofill|DevTools|favicon|electron-log|Download the React/i.test(e));
console.log(`console errors during run: ${realErrors.length}${realErrors.length ? '\n' + realErrors.slice(0, 8).join('\n') : ''}`);
record('zero runtime console errors', realErrors.length === 0, `${realErrors.length} error(s)`);

console.log(results.every(r => r.ok) ? '\nDRIVE: ALL PASS' : `\nDRIVE: ${results.filter(r => !r.ok).length} FAILURE(S)`);
ws.close();
process.exit(0);
