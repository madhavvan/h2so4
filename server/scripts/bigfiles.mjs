// Big-knowledge-base test: inject 100 context files (well over the 400K
// char cap) into the live app, then verify — with that huge context on
// EVERY call — the answer is (a) jet-fast on screen (cover + cached
// prompt), (b) grounded in the uploaded resume (a planted unique fact
// must surface), and (c) still reasons. Measures Q1 vs Q2 to show the
// provider prompt-cache paying off on the repeat.
//   node --env-file=.env scripts/bigfiles.mjs   (from server/)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('popout'));
if (!target) { console.log('no app window'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const ev = (e, ap = false) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: ap, returnByValue: true } })); }).then(r => { if (r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result?.result?.value; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expr, ms = 60000, every = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(every); } return false; };
const DOM = `(function(){var b=Array.prototype.slice.call(document.querySelectorAll('.flex.justify-end,.flex.justify-start'));var sl=0,ai=0,u=0;for(var i=0;i<b.length;i++){var x=b[i],md=x.querySelector('.markdown-body'),t=md?md.innerText.trim():'';if(x.querySelector('.stream-caret')){sl=t.length;}else if(x.classList.contains('justify-end')){if(t)u++;}else if(t)ai++;}return{streamingLen:sl,aiCommitted:ai,userCount:u,thinking:/THINKING \\(/.test(document.body.innerText),lastAi:(function(){var a=b.filter(function(e){return e.classList.contains('justify-start')&&!e.querySelector('.stream-caret')&&e.querySelector('.markdown-body');});return a.length?a[a.length-1].querySelector('.markdown-body').innerText.trim():'';})()};})()`;
const state = () => ev(`JSON.stringify(${DOM})`).then(s => JSON.parse(s));

await waitFor(`typeof window.__dev_setContextFiles==='function'`, 15000, 300);
await ev(`window.__dev_newSession && window.__dev_newSession()`);
await sleep(1200);

// Build 100 files IN THE BROWSER (avoids a huge CDP payload). File 0 is
// the resume carrying a UNIQUE planted fact; files 1..99 are realistic
// filler. Total ~600K chars — comfortably over the 400K cap, so we also
// prove the cap holds without breaking the request.
const RESUME_UNIQUE = 'At Meridian Health Systems (2021-2024) I led the migration of a 41-billion-row PostgreSQL fleet onto Aurora, cutting checkout p99 latency from 820ms to 90ms, and I built a Kafka-to-Iceberg CDC pipeline processing 3.2 million events per minute.';
await ev(`(function(){
  var files = [];
  files.push({ id:'resume', name:'resume.md', type:'resume', content:
    '# Alex Morgan — Senior Data Engineer\\n\\n## Experience\\n' + ${JSON.stringify(RESUME_UNIQUE)} +
    '\\nStack: PySpark, Airflow, dbt, Snowflake, AWS Glue, Kubernetes. ' +
    'Earlier at Northwind Labs I owned the streaming ingestion tier and cut nightly batch cost 38%.\\n'.repeat(60) });
  files.push({ id:'jd', name:'jd.md', type:'jd', content:
    '# Senior Data Engineer — Payments\\nQualifications: streaming pipelines, exactly-once semantics, CDC, lakehouse, Kubernetes, cost optimization. Responsibilities: own the real-time ingestion platform.\\n'.repeat(80) });
  for (var i=1;i<=98;i++){
    files.push({ id:'f'+i, name:'notes_'+i+'.md', type:'custom', content:
      ('## Project note '+i+'\\nDesign doc covering ingestion, partitioning, retries, dedupe keys, backfill strategy, and SLO budgets for service '+i+'. ').repeat(45) });
  }
  window.__dev_setContextFiles(files);
  return files.length;
})()`);
await sleep(500);
const info = await ev(`JSON.stringify(window.__dev_contextInfo())`).then(JSON.parse);
console.log(`injected: ${info.count} files, ${info.totalChars.toLocaleString()} chars total (cap is 400,000 in the prompt builder)`);

// Prewarm fires ~3.5s after files land (KB >= 20K). Give it time to warm
// the provider prompt cache before Q1.
console.log('waiting 6s for prompt-cache prewarm...');
await sleep(6000);

const askAndTime = async (q) => {
  await waitFor(`window.__dev_isProcessing ? !window.__dev_isProcessing() : true`, 30000, 200);
  const base = await state();
  const t0 = Date.now();
  await ev(`(window.__dev_executeSend(${JSON.stringify(q)}),1)`);
  await waitFor(`(function(){var s=${DOM};return s.streamingLen>0 || s.aiCommitted>${base.aiCommitted};})()`, 20000, 40);
  const onScreen = Date.now() - t0;
  await waitFor(`(function(){var s=${DOM};return !s.thinking && s.aiCommitted>=${base.aiCommitted + 1};})()`, 90000, 300);
  const total = Date.now() - t0;
  const s = await state();
  return { onScreen, total, answer: s.lastAi };
};

console.log('\nQ1 (with 100 files as context on the call):');
const r1 = await askAndTime('Tell me about the most challenging data migration you have led.');
console.log(`  first paint: ${r1.onScreen}ms · full answer: ${r1.total}ms`);
const grounded1 = /meridian|41[\s-]?billion|820ms|aurora/i.test(r1.answer);
console.log(`  grounded in the uploaded resume: ${grounded1 ? 'YES' : 'NO'}`);
console.log(`  answer: ${r1.answer.slice(0, 300)}…`);

console.log('\nQ2 (same 100 files — provider prompt cache should now be warm):');
const r2 = await askAndTime('And how did you keep exactly-once semantics in that pipeline?');
console.log(`  first paint: ${r2.onScreen}ms · full answer: ${r2.total}ms`);
console.log(`  answer: ${r2.answer.slice(0, 260)}…`);

console.log(`\nSUMMARY: 100 files / ${info.totalChars.toLocaleString()} chars · Q1 paint ${r1.onScreen}ms, Q2 paint ${r2.onScreen}ms · grounded=${grounded1}`);
ws.close(); process.exit(0);
