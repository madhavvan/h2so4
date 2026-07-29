// Verify the FULL stack on ONE deep question with 100 files loaded:
//   depth-adaptive reasoning  +  KB retrieval (cheap, grounded)  +  instant
//   cover  +  seamless continuation — all at once. This is the exact
//   "bulk files + deep question" scenario. Prints the client-observed
//   timing/grounding; server [cover]/[promptsize] are grepped separately.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('popout'));
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const ev = (e, ap = false) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: ap, returnByValue: true } })); }).then(r => r.result?.result?.value);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (x, ms = 30000, every = 30) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(x)) return true; } catch {} await sleep(every); } return false; };
const DOM = `(function(){var b=Array.prototype.slice.call(document.querySelectorAll('.flex.justify-end,.flex.justify-start'));var sl=0,ai=0,last='';for(var i=0;i<b.length;i++){var x=b[i],md=x.querySelector('.markdown-body'),tx=md?md.innerText.trim():'';if(x.querySelector('.stream-caret'))sl=tx.length;else if(x.classList.contains('justify-start')&&tx){ai++;last=tx;}}return{streamingLen:sl,aiCommitted:ai,lastAi:last};})()`;

await waitFor(`typeof window.__dev_setContextFiles==='function'`, 15000, 300);
await ev(`window.__dev_newSession && window.__dev_newSession()`);
await sleep(1200);

// 100 files: resume carries deep-topic facts (Kafka→Iceberg CDC, exactly-once)
// + a unique number; 98 filler notes bury it.
await ev(`(function(){
  var files=[];
  files.push({id:'resume',name:'resume.md',type:'resume',content:'Senior Data Engineer.\\nAt Meridian I built a Kafka to Iceberg CDC pipeline doing exactly-once at 3.2 million events per minute, checkpointing Kafka offsets only after the Iceberg snapshot committed. Also migrated a 41-billion-row Postgres fleet to Aurora, p99 820ms to 90ms.'});
  files.push({id:'jd',name:'jd.md',type:'jd',content:'Payments platform. streaming, exactly-once, CDC, lakehouse, kubernetes.'});
  var block=('design note on partitioning retries dedupe backfill slo budgets ingestion. ').repeat(45);
  for(var i=1;i<=98;i++) files.push({id:'f'+i,name:'n'+i+'.md',type:'custom',content:'## Note '+i+'\\n'+block});
  window.__dev_setContextFiles(files);
  return files.length;
})()`);
await sleep(600);
const info = JSON.parse(await ev('JSON.stringify(window.__dev_contextInfo())'));
console.log(`KB: ${info.count} files, ${info.totalChars.toLocaleString()} chars`);

// Install a wire tap to time the cover's first token.
await ev(`(function(){window.__probe=[];var o=window.__origFetch||window.fetch.bind(window);window.__origFetch=o;window.fetch=async function(){var u=String(arguments[0]||'');var r=await o.apply(null,arguments);if(u.indexOf('/api/v1/ai/stream/')>=0){var e={t0:performance.now(),ttft:null};window.__probe.push(e);try{var c=r.clone();(async()=>{var rd=c.body.getReader(),d=new TextDecoder();while(true){var x=await rd.read();if(x.done)break;var s=d.decode(x.value);if(e.ttft===null&&s.indexOf('"t":')>=0)e.ttft=Math.round(performance.now()-e.t0);}})();}catch(_){}}return r;};return 1;})()`);

const Q = 'How would you design an exactly-once streaming pipeline across regions, like the one you built?';
console.log(`\nDEEP Q (bulk files loaded): ${Q}\n`);
await waitFor(`window.__dev_isProcessing ? !window.__dev_isProcessing() : true`, 20000, 200);
const t0 = Date.now();
await ev(`(window.__dev_executeSend(${JSON.stringify(Q)}),1)`);
await waitFor(`(${DOM}).streamingLen>0 || (${DOM}).aiCommitted>0`, 25000, 25);
const firstPaint = Date.now() - t0;
await sleep(250);
const wire = await ev(`(function(){var p=window.__probe||[];var e=p[p.length-1];return e?e.ttft:null;})()`);
await waitFor(`(function(){var s=${DOM};return !s.streamingLen && s.aiCommitted>0;})() || (${DOM}).aiCommitted>0`, 60000, 400);
await sleep(300);
const st = JSON.parse(await ev(`JSON.stringify(${DOM})`));
const grounded = /kafka|iceberg|exactly-once|3\.2 million|offset|snapshot|cdc/i.test(st.lastAi);
console.log(`cover first token (wire): ${wire}ms   ·   first paint: ${firstPaint}ms`);
console.log(`grounded in the deep-topic chunk: ${grounded ? 'YES' : 'NO'}`);
console.log(`\nANSWER:\n${st.lastAi.slice(0, 480)}${st.lastAi.length > 480 ? ' …' : ''}`);
ws.close(); process.exit(0);
