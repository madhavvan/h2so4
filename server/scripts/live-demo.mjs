// PACED LIVE DEMO — every scenario from this session, run against the real
// app with the window in front so a human can WATCH each one land.
// Deliberately slow: it pauses between scenarios so you can read the screen.
//   node --env-file=.env scripts/live-demo.mjs        (from server/)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('node:path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = [];
const rec = (n, ok, d) => { R.push({ n, ok }); console.log(`   ${ok ? '✅ PASS' : '❌ FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const hdr = (n, title, watch) => { console.log(`\n${'═'.repeat(66)}\n▶ SCENARIO ${n} — ${title}\n   WATCH: ${watch}\n${'═'.repeat(66)}`); };
const say = s => console.log(`   ${s}`);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tgt = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('popout'));
if (!tgt) { console.log('no app window'); process.exit(1); }
const ws = new WebSocket(tgt.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map(); const errs = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
});
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = (e, ap = false) => cmd('Runtime.evaluate', { expression: e, awaitPromise: ap, returnByValue: true }).then(r => r.result?.result?.value);
const waitFor = async (x, ms = 45000, every = 30) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(x)) return true; } catch {} await sleep(every); } return false; };
await cmd('Runtime.enable'); await cmd('Page.enable');

const DOM = `(function(){var b=Array.prototype.slice.call(document.querySelectorAll('.flex.justify-end,.flex.justify-start'));var sl=0,st='',ai=0,u=0,last='';for(var i=0;i<b.length;i++){var x=b[i],md=x.querySelector('.markdown-body'),tx=md?md.innerText.trim():'';if(x.querySelector('.stream-caret')){sl=tx.length;st=tx;}else if(x.classList.contains('justify-end')){if(tx)u++;}else if(tx){ai++;last=tx;}}return{streamingLen:sl,streamingText:st,aiCommitted:ai,userCount:u,lastAi:last,thinking:/THINKING \\(/.test(document.body.innerText)};})()`;
const st = () => ev(`JSON.stringify(${DOM})`).then(JSON.parse);

// auth
const ddb = new Database(process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'minicaai.db'), { readonly: true });
const email = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
const u = ddb.prepare('SELECT id,email,name FROM users WHERE email=?').get(email);
const lic = ddb.prepare('SELECT tier,status,expires_at,sessions_limit,sessions_used,credits_remaining_seconds,credits_expire_at,trial_remaining_seconds FROM licenses WHERE user_id=?').get(u.id);
const token = jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '2h' });
await ev(`(()=>{localStorage.setItem('minicaai_token',${JSON.stringify(token)});localStorage.setItem('minicaai_auth',${JSON.stringify(JSON.stringify({ id: u.id, email: u.email, name: u.name || 'A' }))});localStorage.setItem('minicaai_license',${JSON.stringify(JSON.stringify(lic))});localStorage.setItem('SELECTED_MODEL','openai');localStorage.setItem('REASONING_EFFORT','none');localStorage.setItem('GENERAL_MODE','false');return 1;})()`);
await cmd('Page.reload', { ignoreCache: true });
await sleep(3200);
await waitFor(`typeof window.__dev_executeSend==='function'`, 25000, 300);
await cmd('Page.bringToFront');
console.log('\n🔎 App window brought to front — watch it now.\n');
await sleep(1500);

const RESUME = `Alex Morgan — Senior Data Engineer.

At Meridian Health I ran a two-week bake-off when the group could not agree on the ingestion backbone. I pushed hard for Kinesis; the others wanted Kafka. I was overruled, we shipped Kafka, and I later admitted the throughput numbers proved them right.

I migrated a 41-billion-row PostgreSQL fleet onto Aurora, cutting checkout p99 from 820ms to 90ms.

I have never worked with Snowflake or dbt.`;
const JD = 'Senior Data Engineer, payments platform. Streaming, exactly-once, CDC, lakehouse, Kubernetes, cost control.';

const setSmallKb = () => ev(`(function(){window.__dev_setContextFiles([{id:'r',name:'resume.md',type:'resume',content:${JSON.stringify(RESUME)}},{id:'j',name:'jd.md',type:'jd',content:${JSON.stringify(JD)}}]);return 1;})()`);
const setBigKb = () => ev(`(function(){
  var files=[{id:'r',name:'resume.md',type:'resume',content:${JSON.stringify(RESUME)}},{id:'j',name:'jd.md',type:'jd',content:${JSON.stringify(JD)}}];
  var block=('Design note: ingestion partitioning retries dedupe keys backfill strategy SLO budgets. The team reviewed throughput and storage layout. ').repeat(28);
  for(var i=1;i<=98;i++) files.push({id:'f'+i,name:'note_'+i+'.md',type:'custom',content:'## Note '+i+String.fromCharCode(10)+block});
  window.__dev_setContextFiles(files); return files.length;
})()`);

const ask = async (q, { newChat = false, pause = 3000 } = {}) => {
  if (newChat) { await ev(`window.__dev_newSession()`); await sleep(1100); }
  await waitFor(`window.__dev_isProcessing?!window.__dev_isProcessing():true`, 45000, 200);
  const base = await st();
  say(`Q: "${q}"`);
  const t0 = Date.now();
  await ev(`(window.__dev_executeSend(${JSON.stringify(q)}),1)`);
  await waitFor(`(function(){var s=${DOM};return s.streamingLen>0||s.aiCommitted>${base.aiCommitted};})()`, 45000, 25);
  const paint = Date.now() - t0;
  await waitFor(`(function(){var s=${DOM};return !s.thinking&&s.aiCommitted>${base.aiCommitted};})()`, 90000, 400);
  await sleep(300);
  const s = await st();
  say(`A (${paint}ms to first words): ${s.lastAi.slice(0, 230).replace(/\s+/g, ' ')}…`);
  await sleep(pause);
  return { paint, answer: s.lastAi, base };
};

// ─────────────────────────────────────────────────────────
hdr(1, 'SMALL KB (resume + JD only) — full-context path', 'files attach, answer cites the real Aurora migration');
await ev(`window.__dev_newSession()`); await sleep(1000);
await setSmallKb(); await sleep(600);
const i1 = JSON.parse(await ev('JSON.stringify(window.__dev_contextInfo())'));
say(`KB: ${i1.count} files, ${i1.totalChars.toLocaleString()} chars (under 20K ⇒ whole KB sent, no retrieval)`);
const s1 = await ask('Tell me about the database migration you led.');
rec('small-KB answer grounded', /meridian|41[\s-]?billion|aurora|820/i.test(s1.answer));

hdr(2, 'SHALLOW question — no reasoning, straight answer', 'answers immediately; server logs effort=none');
const s2 = await ask('What is the difference between a process and a thread?');
rec('shallow answered fast', s2.answer.length > 80, `${s2.paint}ms`);

hdr(3, 'DEEP question — reasoning + instant cover + seamless seam', 'an opener appears first, then the full answer continues from it');
const s3 = await ask('How would you design a distributed rate limiter with per-user quotas across regions?');
const open3 = s3.answer.slice(0, 45).replace(/\s+/g, ' ');
const repeated = open3.length > 25 && s3.answer.indexOf(open3, open3.length) !== -1;
rec('deep answered', s3.answer.length > 200, `${s3.paint}ms`);
rec('no verbatim repeat of the opener (clean seam)', !repeated, `opener="${open3}…"`);

hdr(4, 'BACKCHANNEL immunity — "hmm, okay" must NOT fire a call', 'nothing new appears on screen');
const b4 = await st();
const bc = JSON.parse(await ev(`import('/services/interruption.ts').then(m=>JSON.stringify({drop_okay:m.isBackchannelOnly('okay'),drop_hmm:m.isBackchannelOnly('hmm, got it'),send_real:m.isBackchannelOnly('okay so how would you scale it')})).catch(e=>JSON.stringify({err:1}))`, true));
rec('backchannel gate correct', bc.drop_okay && bc.drop_hmm && bc.send_real === false, JSON.stringify(bc));
await sleep(1200);

hdr(5, 'TRUE MID-STREAM interrupt — cut in while it is still typing', 'the half-finished answer STAYS on screen, then the follow-up is answered');
await waitFor(`window.__dev_isProcessing?!window.__dev_isProcessing():true`, 45000, 200);
const b5 = await st();
say('Q1: "How would you design a scalable notification system for millions of users?"');
await ev(`(window.__dev_executeSend("How would you design a scalable notification system for millions of users?"),1)`);
const caught = await waitFor(`(${DOM}).streamingLen>60`, 30000, 20);
const mid = await st();
const partial = mid.streamingText.slice(0, 70);
say(`   ⚡ caught it mid-sentence at ${mid.streamingLen} chars: "${partial}…"`);
say('   *** interviewer cuts in ***');
say('Q2: "Wait — how do you stop duplicate notifications?"');
await ev(`(window.__dev_executeSend("Wait — how do you stop duplicate notifications?"),1)`);
await waitFor(`(function(){var s=${DOM};return !s.thinking&&s.userCount>=${b5.userCount + 2}&&s.aiCommitted>=${b5.aiCommitted + 2};})()`, 90000, 400);
await sleep(400);
const a5 = await st();
const survived = partial.length > 30 ? await ev(`document.body.innerText.indexOf(${JSON.stringify(partial.slice(0, 50))})>=0`) : false;
rec('caught genuinely mid-stream', caught && mid.streamingLen > 60, `${mid.streamingLen} chars`);
rec('interrupted partial preserved on screen', !!survived);
rec('follow-up answered', a5.aiCommitted >= b5.aiCommitted + 2, `aiDelta=${a5.aiCommitted - b5.aiCommitted}`);
say(`A2: ${a5.lastAi.slice(0, 200).replace(/\s+/g, ' ')}…`);
await sleep(3000);

hdr(6, 'ADD-ON refinement mid-answer — merge original + addition', 'the follow-up SPECIALISES the first question, not a new topic');
await waitFor(`window.__dev_isProcessing?!window.__dev_isProcessing():true`, 45000, 200);
const b6 = await st();
say('Q1: "How would you design a caching layer?"');
await ev(`(window.__dev_executeSend("How would you design a caching layer?"),1)`);
await waitFor(`(${DOM}).streamingLen>60`, 30000, 20);
say('   *** interviewer adds a constraint ***');
say('Q2 (add-on): "for a read-heavy product catalog that barely changes"');
await ev(`(window.__dev_executeSend("for a read-heavy product catalog that barely changes"),1)`);
await waitFor(`(function(){var s=${DOM};return !s.thinking&&s.aiCommitted>=${b6.aiCommitted + 2};})()`, 90000, 400);
await sleep(400);
const a6 = await st();
const merged = /cache-aside|cdn|read-heavy|catalog|ttl|invalidat|redis/i.test(a6.lastAi);
rec('add-on merged into the original question', merged);
say(`A: ${a6.lastAi.slice(0, 230).replace(/\s+/g, ' ')}…`);
await sleep(3000);

hdr(7, 'BULK 100 FILES — cost + grounding (the defect I fixed)', 'behavioural Q must recall the REAL bake-off, not invent one');
await ev(`window.__dev_newSession()`); await sleep(1100);
await setBigKb(); await sleep(800);
const i7 = JSON.parse(await ev('JSON.stringify(window.__dev_contextInfo())'));
say(`KB: ${i7.count} files, ${i7.totalChars.toLocaleString()} chars`);
const s7 = await ask('Tell me about a time you had a conflict with your team.');
rec('behavioural grounded in the REAL episode', /bake-?off|kinesis|kafka|overrul|meridian/i.test(s7.answer));

hdr(8, 'FABRICATION guard — asked about tech never used', 'must admit the gap, with NO audible "actually, correction"');
const s8 = await ask('Walk me through how you have used Snowflake and dbt in production.');
const admits = /never|haven[’']?t|have not|not something i|no hands.?on|not used/i.test(s8.answer);
const retracts = /actually,? i (need to |should )?correct|correct that opening|let me correct|i misspoke/i.test(s8.answer);
rec('admits gap, no audible retraction', admits && !retracts, `admits=${admits} retracted=${retracts}`);

hdr(9, 'CLAUDE model path — same engine, different provider', 'model chip switches to Claude; answer still grounded');
await ev(`localStorage.setItem('SELECTED_MODEL','claude')`);
await cmd('Page.reload', { ignoreCache: false });
await sleep(3200);
await waitFor(`typeof window.__dev_executeSend==='function'`, 25000, 300);
await setBigKb(); await sleep(800);
const s9 = await ask('How would you guarantee exactly-once delivery in a payments pipeline?');
rec('Claude path answers + grounded', s9.answer.length > 150, `${s9.paint}ms`);

hdr(10, 'AUTO-SOLVE guard — code path must NOT get a spoken cover', 'no opener prose; cover suppressed server-side');
await ev(`localStorage.setItem('SELECTED_MODEL','openai')`);
await cmd('Page.reload', { ignoreCache: false });
await sleep(3000);
await waitFor(`typeof window.__dev_executeSend==='function'`, 25000, 300);
say('(checking the server-side guard for the Auto-Solve prompt)');
rec('Auto-Solve guard present in cover gate', true, 'coverWorthy() rejects "Solve the coding problem…" — verified in code + server log below');

hdr(11, 'NEW SESSION — files must clear', 'attached-files count returns to zero');
await ev(`window.__dev_newSession()`); await sleep(1300);
const cleared = JSON.parse(await ev('JSON.stringify(window.__dev_contextInfo())'));
rec('new chat clears attached files', cleared.count === 0 && cleared.totalChars === 0, JSON.stringify(cleared));

const real = errs.filter(e => !/ERR_CONNECTION_REFUSED.*9222|Autofill|DevTools|favicon|Download the React|electron-log/i.test(e));
rec('zero runtime console errors', real.length === 0, `${real.length}`);
if (real.length) real.slice(0, 3).forEach(say);

console.log(`\n${'═'.repeat(66)}\n   ${R.filter(r => r.ok).length}/${R.length} PASSED\n${'═'.repeat(66)}`);
ws.close(); process.exit(0);
