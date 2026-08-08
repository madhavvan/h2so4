// Live demo driver — types a question into the real app UI (you watch the
// window), waits for the answer, and reports the cover's wire-TTFT so you
// can see the instant-cover + seamless-continuation engineering in action.
//
//   node --env-file=.env scripts/ask.mjs --setup            (auth + fresh chat, GPT)
//   node --env-file=.env scripts/ask.mjs "your question"    (ask + report)
//   node --env-file=.env scripts/ask.mjs --interrupt "Q_a" "Q_b"  (ask a, cut in with b mid-stream)
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const SETUP = args.includes('--setup');
const INTERRUPT = args.includes('--interrupt');
const qs = args.filter(a => !a.startsWith('--'));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('popout'));
if (!target) { console.log('No app window found on :9222'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e, ap = false) => cmd('Runtime.evaluate', { expression: e, awaitPromise: ap, returnByValue: true }).then(r => { if (r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result?.result?.value; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expr, ms = 60000, every = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(every); } return false; };

const DOM = `(function(){var b=Array.prototype.slice.call(document.querySelectorAll('.flex.justify-end,.flex.justify-start'));var sl=0,st='',ai=0,u=0;for(var i=0;i<b.length;i++){var x=b[i],md=x.querySelector('.markdown-body'),t=md?md.innerText.trim():'';if(x.querySelector('.stream-caret')){sl=t.length;st=t;}else if(x.classList.contains('justify-end')){if(t)u++;}else if(t)ai++;}return{streamingLen:sl,streamingText:st,aiCommitted:ai,userCount:u,thinking:/THINKING \\(/.test(document.body.innerText),lastAi:(function(){var a=b.filter(function(e){return e.classList.contains('justify-start')&&!e.querySelector('.stream-caret')&&e.querySelector('.markdown-body');});return a.length?a[a.length-1].querySelector('.markdown-body').innerText.trim():'';})()};})()`;
const state = () => ev(`JSON.stringify(${DOM})`).then(s => JSON.parse(s));

if (SETUP) {
  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'minicaai.db');
  const ddb = new Database(dbPath, { readonly: true });
  const email = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
  const u = ddb.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);
  const lic = ddb.prepare('SELECT tier,status,expires_at,sessions_limit,sessions_used,credits_remaining_seconds,credits_expire_at,trial_remaining_seconds FROM licenses WHERE user_id = ?').get(u.id);
  const token = jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '2h' });
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await ev(`(()=>{localStorage.setItem('minicaai_token',${JSON.stringify(token)});localStorage.setItem('minicaai_auth',${JSON.stringify(JSON.stringify({ id: u.id, email: u.email, name: u.name || 'Admin' }))});localStorage.setItem('minicaai_license',${JSON.stringify(JSON.stringify(lic))});localStorage.setItem('SELECTED_MODEL','openai');localStorage.setItem('REASONING_EFFORT','none');return 1;})()`);
  await cmd('Page.reload', { ignoreCache: true });
  await sleep(3000);
  await waitFor(`typeof window.__dev_newSession==='function'`, 20000, 300);
  await ev(`window.__dev_newSession && window.__dev_newSession()`);
  await sleep(1200);
  console.log('setup done — authed as ' + email + ', GPT selected, fresh chat. App window is ready to watch.');
  ws.close(); process.exit(0);
}

const ask = async (q, viaHook = false) => {
  await waitFor(`window.__dev_isProcessing ? !window.__dev_isProcessing() : true`, 30000, 200);
  const base = await state();
  const probeIdx = await ev(`(window.__probe||[]).length`).catch(() => 0);
  // Install a light wire-tap once so we can report the cover's true TTFT.
  await ev(`(()=>{if(window.__askProbe)return;window.__askProbe=1;window.__probe=window.__probe||[];var o=window.__origFetch||window.fetch.bind(window);window.__origFetch=o;window.fetch=async function(){var u=String(arguments[0]||'');var r=await o.apply(null,arguments);if(u.indexOf('/api/v1/ai/stream/')>=0){var e={t0:performance.now(),ttftMs:null};window.__probe.push(e);try{var c=r.clone();(async()=>{var rd=c.body.getReader(),d=new TextDecoder();while(true){var x=await rd.read();if(x.done)break;var s=d.decode(x.value);if(e.ttftMs===null&&s.indexOf('"t":')>=0)e.ttftMs=Math.round(performance.now()-e.t0);}})();}catch(_){}}return r;};})()`);
  const t0 = Date.now();
  if (viaHook) {
    await ev(`(window.__dev_executeSend(${JSON.stringify(q)}),1)`);
  } else {
    await ev(`(()=>{var f=Array.prototype.slice.call(document.querySelectorAll('textarea,input[type=text]')).find(function(el){return el.offsetParent&&/listening for interviewer|type or speak/i.test(el.placeholder||'');});if(!f)return 0;var pr=f.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(pr,'value').set.call(f,${JSON.stringify(q)});f.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
    await waitFor(`!!Array.prototype.slice.call(document.querySelectorAll('button[aria-label="Send message"]')).find(function(b){return b.offsetParent&&!b.disabled;})`, 6000, 80);
    await ev(`(()=>{var b=Array.prototype.slice.call(document.querySelectorAll('button[aria-label="Send message"]')).find(function(x){return x.offsetParent&&!x.disabled;});b&&b.click();return 1;})()`);
  }
  await waitFor(`(${DOM}).streamingLen>0 || (${DOM}).aiCommitted>${base.aiCommitted}`, 15000, 40);
  const onScreen = Date.now() - t0;
  return { base, probeIdx, onScreen };
};

if (INTERRUPT) {
  const [qa, qb] = qs;
  console.log(`\nQ (deep): ${qa}`);
  const r = await ask(qa);
  await waitFor(`(${DOM}).streamingLen>80`, 15000, 30);
  const mid = await state();
  console.log(`  ↳ answer started streaming (${mid.streamingLen} chars on screen): "${mid.streamingText.slice(0, 70)}..."`);
  console.log(`\n  *** interviewer cuts in mid-answer ***`);
  console.log(`Q (follow-up): ${qb}`);
  await ev(`(window.__dev_executeSend(${JSON.stringify(qb)}),1)`);
  await waitFor(`(()=>{var s=${DOM};return !s.thinking && s.userCount>=${r.base.userCount + 2} && s.aiCommitted>=${r.base.aiCommitted + 2};})()`, 90000, 400);
  const after = await state();
  console.log(`  ↳ both handled — partial of the first answer preserved on screen, follow-up answered.`);
  console.log(`  follow-up answer: "${after.lastAi.slice(0, 220)}..."`);
  ws.close(); process.exit(0);
}

for (const q of qs) {
  console.log(`\n──────────────────────────────────────`);
  console.log(`ASK: ${q}`);
  const r = await ask(q);
  await waitFor(`(()=>{var s=${DOM};return !s.thinking && s.aiCommitted>=${r.base.aiCommitted + 1};})()`, 60000, 300);
  await sleep(300);
  const s = await state();
  const wire = await ev(`(()=>{var p=window.__probe||[];var e=p[${r.probeIdx}];return e?e.ttftMs:null;})()`);
  console.log(`  cover on wire: ${wire !== null ? wire + 'ms' : 'n/a (shallow → no cover)'}  ·  first paint on screen: ${r.onScreen}ms`);
  console.log(`  ANSWER: ${s.lastAi.slice(0, 340)}${s.lastAi.length > 340 ? ' …' : ''}`);
  await sleep(1500);
}
ws.close(); process.exit(0);
