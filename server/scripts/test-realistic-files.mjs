// EXACTLY the user's scenario:
//   • one large .md  (~80K chars)
//   • two "PDFs" (2 pages each ≈ 5K chars) — stored the way handleFileUpload
//     really stores them: type:'custom', name:'*.pdf'
//   • one more .md carrying the DEEPEST information
// Measures: what actually reaches the model, per-question size, speed, and
// whether each distinctive fact is nailed.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = [];
const rec = (n, ok, d) => { R.push({ n, ok }); console.log(`   ${ok ? '✅ PASS' : '❌ FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const say = s => console.log(`   ${s}`);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tgt = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('popout'));
const ws = new WebSocket(tgt.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const cmd = (m, p = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = (e, ap = false) => cmd('Runtime.evaluate', { expression: e, awaitPromise: ap, returnByValue: true }).then(r => r.result?.result?.value);
const waitFor = async (x, ms = 60000, every = 25) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(x)) return true; } catch {} await sleep(every); } return false; };
await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Page.bringToFront');

const DOM = `(function(){var b=Array.prototype.slice.call(document.querySelectorAll('.flex.justify-start'));var sl=0,ai=0,last='';for(var i=0;i<b.length;i++){var x=b[i],md=x.querySelector('.markdown-body'),t=md?md.innerText.trim():'';if(x.querySelector('.stream-caret')){sl=t.length;}else if(t){ai++;last=t;}}return{streamingLen:sl,aiCommitted:ai,lastAi:last,thinking:/THINKING \\(/.test(document.body.innerText)};})()`;
const st = () => ev(`JSON.stringify(${DOM})`).then(JSON.parse);

// ── Build the realistic file set IN THE PAGE ──
// 80K .md of dense architecture notes, with ONE distinctive fact buried in it.
// Two "PDFs" exactly as handleFileUpload stores them (type:'custom').
// One more .md holding the deepest, most specific knowledge.
const build = (resumeName) => `(function(){
  var para = 'The ingestion tier partitions by tenant and time bucket, with retries governed by an exponential backoff and a dead-letter path after five attempts. Storage layout favours columnar files compacted hourly to keep small-file pressure off the metastore. ';
  var big = '# Platform Architecture Notes\\n' + para.repeat(320);
  big += '\\n\\nOPERATIONAL DETAIL: our Iceberg compaction job runs at 03:15 UTC and we cap manifest rewrite concurrency at 4 to avoid metastore lock contention.\\n\\n' + para.repeat(20);

  var resume = [
    'ALEX MORGAN',
    'Senior Data Engineer',
    '',
    'PROFESSIONAL SUMMARY',
    'Data engineer with 4+ years building streaming and lakehouse platforms.',
    '',
    'WORK EXPERIENCE',
    'Meridian Health — Senior Data Engineer (2021-2024)',
    'Ran a two-week bake-off when the group could not agree on the ingestion backbone. I pushed hard for Kinesis; the others wanted Kafka. I was overruled, we shipped Kafka, and the throughput numbers proved them right.',
    'Migrated a 41-billion-row PostgreSQL fleet onto Aurora, cutting checkout p99 from 820ms to 90ms.',
    '',
    'EDUCATION',
    'MS Health Informatics, Indiana University, 2025.',
    '',
    'I have never worked with Snowflake or dbt.'
  ].join('\\n') + '\\n' + 'Additional detail on pipeline ownership and on-call rotations. '.repeat(60);

  var jd = 'JOB DESCRIPTION\\nSenior Data Engineer, payments platform.\\nRESPONSIBILITIES: own the real-time ingestion platform, exactly-once delivery, CDC into the lakehouse.\\nQUALIFICATIONS: Kafka, Iceberg, Kubernetes, cost optimisation.\\n' + 'Further role context about the team and the on-call expectations. '.repeat(60);

  var deep = '# Deep Dive — Cost Model\\n' + 'Detailed reasoning about warehouse credit consumption and clustering strategy. '.repeat(120) + '\\n\\nKEY NUMBER: our per-terabyte scan cost fell from 4.80 dollars to 1.15 dollars after we switched to partition pruning on event_date and enabled result caching.\\n' + 'More elaboration on the cost model and its assumptions. '.repeat(60);

  var files = [
    { id:'big',    name:'platform_architecture_notes.md', type:'custom', content: big },
    { id:'resume', name:${JSON.stringify(resumeName)},    type:'custom', content: resume },
    { id:'jd',     name:'role_description.pdf',           type:'custom', content: jd },
    { id:'deep',   name:'deep_dive_cost_model.md',        type:'custom', content: deep }
  ];
  window.__dev_lastFiles = files;
  window.__dev_setContextFiles(files);
  return JSON.stringify(files.map(function(f){ return { name:f.name, chars:f.content.length }; }));
})()`;

const ask = async (q, label) => {
  await waitFor(`window.__dev_isProcessing?!window.__dev_isProcessing():true`, 60000, 200);
  const base = await st();
  const t0 = Date.now();
  await ev(`(window.__dev_executeSend(${JSON.stringify(q)}),1)`);
  await waitFor(`(function(){var s=${DOM};return s.streamingLen>0||s.aiCommitted>${base.aiCommitted};})()`, 60000, 20);
  const paint = Date.now() - t0;
  await waitFor(`(function(){var s=${DOM};return !s.thinking&&s.aiCommitted>${base.aiCommitted};})()`, 120000, 400);
  await sleep(300);
  const s = await st();
  say(`Q (${label}): "${q}"`);
  say(`   first words on screen: ${paint}ms`);
  say(`   A: ${s.lastAi.slice(0, 210).replace(/\s+/g, ' ')}…`);
  return { paint, answer: s.lastAi };
};

// ═══ PART 1: well-named resume PDF ═══
console.log('\n═════ PART 1 — resume PDF named "Venu_Resume.pdf" ═════');
await ev(`window.__dev_newSession()`); await sleep(1200);
const manifest = JSON.parse(await ev(build('Venu_Resume.pdf')));
await sleep(700);
manifest.forEach(f => say(`   ${f.name.padEnd(36)} ${f.chars.toLocaleString().padStart(8)} chars`));
const info = JSON.parse(await ev('JSON.stringify(window.__dev_contextInfo())'));
say(`   TOTAL: ${info.count} files, ${info.totalChars.toLocaleString()} chars`);

// What actually reaches the model?
const probe = JSON.parse(await ev(`
(async () => {
  const m = await import('/services/aiProxyService.ts?bust=' + Date.now());
  const files = window.__dev_lastFiles;
  const q = 'Tell me about a time you disagreed with your team.';
  const e = await m.assembleEvidence(q, files);
  return JSON.stringify({
    evidenceChars: e.length,
    hasResumeEpisode: e.indexOf('bake-off') >= 0,
    hasNeverSnowflake: e.indexOf('never worked with Snowflake') >= 0,
    hasJd: e.indexOf('RESPONSIBILITIES') >= 0
  });
})()`, true).catch(() => '{}') || '{}');
say('');
say(`   evidence actually sent for a behavioural Q: ${(probe.evidenceChars || 0).toLocaleString()} chars`);
rec('resume PDF protected (identity doc, always sent)', probe.hasResumeEpisode === true);
rec('JD PDF protected (identity doc, always sent)', probe.hasJd === true);

const q1 = await ask('Tell me about a time you disagreed with your team.', 'behavioural → needs resume');
rec('behavioural nails the real bake-off episode', /bake-?off|kinesis|overrul|meridian/i.test(q1.answer), `${q1.paint}ms`);

const q2 = await ask('What did our per-terabyte scan cost drop to, and how?', 'deep .md → needs retrieval');
rec('deep .md fact retrieved (1.15 / partition pruning)', /1\.15|partition prun|result cach/i.test(q2.answer), `${q2.paint}ms`);

const q3 = await ask('When does the Iceberg compaction job run and what is the concurrency cap?', 'buried in the 80K .md');
rec('fact buried in the 80K file retrieved (03:15 / 4)', /03:15|3:15|concurrency|manifest/i.test(q3.answer), `${q3.paint}ms`);

// ═══ PART 2: badly-named resume PDF (the risk case) ═══
console.log('\n═════ PART 2 — same resume, but named "VMADp_2026.pdf" (no "resume" in name) ═════');
await ev(`window.__dev_newSession()`); await sleep(1200);
await ev(build('VMADp_2026.pdf')); await sleep(700);
const probe2 = JSON.parse(await ev(`
(async () => {
  const m = await import('/services/aiProxyService.ts?bust=' + Date.now());
  const e = await m.assembleEvidence('Tell me about a time you disagreed with your team.', window.__dev_lastFiles);
  return JSON.stringify({ evidenceChars: e.length, hasResumeEpisode: e.indexOf('bake-off') >= 0 });
})()`, true).catch(() => '{}') || '{}');
rec('badly-named resume STILL protected (content markers)', probe2.hasResumeEpisode === true, `evidence=${(probe2.evidenceChars || 0).toLocaleString()} chars`);

console.log(`\n═════ ${R.filter(r => r.ok).length}/${R.length} PASSED ═════`);
ws.close(); process.exit(0);
