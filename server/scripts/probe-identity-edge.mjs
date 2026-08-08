// Where exactly does identity-doc detection stop working? Pure function
// probe (no model calls). Each case is a resume PDF the user might really
// upload; PASS = the resume survives into the evidence sent to the model.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tgt = list.find(x => x.type === 'page' && x.url.includes('localhost:3005') && !x.url.includes('popout'));
const ws = new WebSocket(tgt.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const P = new Map();
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
const ev = (e, ap = false) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: ap, returnByValue: true } })); })
  .then(r => { if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 200)); return r.result?.result?.value; });

const MARK = 'ran a two-week bake-off';
const body = `${MARK} when the group could not agree on the ingestion backbone. I pushed for Kinesis; we shipped Kafka.\n` + 'Owned pipeline reliability and on-call. '.repeat(50);

// Realistic resume shapes a user might upload as a PDF.
const CASES = [
  ['classic headings + "resume" in name', 'Venu_Resume.pdf', 'PROFESSIONAL SUMMARY\nSenior DE.\n\nWORK EXPERIENCE\n' + body + '\nEDUCATION\nMS 2025.'],
  ['classic headings, neutral name', 'VMADp_2026.pdf', 'PROFESSIONAL SUMMARY\nSenior DE.\n\nWORK EXPERIENCE\n' + body + '\nEDUCATION\nMS 2025.'],
  ['"EXPERIENCE" only (no "work"), neutral name', 'VMADp_2026.pdf', 'Senior Data Engineer\n\nEXPERIENCE\n' + body + '\n\nSKILLS\nKafka, Spark.'],
  ['no headings at all, neutral name', 'VMADp_2026.pdf', 'Senior Data Engineer with 4+ years.\n' + body],
  ['"EXPERIENCE" only but named CV', 'VMADp_CV.pdf', 'Senior Data Engineer\n\nEXPERIENCE\n' + body],
];

const expr = `
(async () => {
  const m = await import('/services/aiProxyService.ts?bust=' + Date.now());
  const cases = ${JSON.stringify(CASES)};
  const filler = 'Design note: ingestion partitioning retries dedupe backfill SLO budgets. The team reviewed throughput. '.repeat(30);
  const out = [];
  for (const [label, name, content] of cases) {
    const files = [{ id:'r', name, type:'custom', content }];
    for (let i = 1; i <= 40; i++) files.push({ id:'f'+i, name:'note_'+i+'.md', type:'custom', content:'## Note '+i+'\\n'+filler });
    const e = await m.assembleEvidence('Tell me about a time you disagreed with your team.', files);
    out.push({ label, kept: e.indexOf(${JSON.stringify(MARK)}) >= 0, evidenceChars: e.length });
  }
  return JSON.stringify(out, null, 1);
})()`;
const res = JSON.parse(await ev(expr, true));
let bad = 0;
for (const r of res) {
  if (!r.kept) bad++;
  console.log(`  ${r.kept ? '✅ kept ' : '❌ LOST '}  ${r.label.padEnd(46)} evidence=${String(r.evidenceChars).padStart(6)} chars`);
}
console.log(`\n  ${res.length - bad}/${res.length} resume shapes protected`);

// ── Cost guard: broadening detection must NOT let bulk material in ──
// Notes here deliberately use resume-ish vocabulary ("experience",
// "projects", "skills"), which is exactly what real engineering notes do.
console.log('\n  COST GUARD — bulk notes that use resume vocabulary');
const costExpr = `
(async () => {
  const m = await import('/services/aiProxyService.ts?bust=' + Date.now());
  const chatty = 'In our experience the ingestion projects need dedupe, retries and backfill. Skills matrix and summary of throughput were reviewed. '.repeat(30);
  const out = [];

  // A) 40 chatty notes + a real resume -> resume kept, evidence still small
  var a = [{ id:'r', name:'Venu_Resume.pdf', type:'custom', content:'PROFESSIONAL SUMMARY\\nSenior DE.\\n\\nWORK EXPERIENCE\\n${MARK} when the group could not agree.\\nEDUCATION\\nMS 2025.' }];
  for (let i=1;i<=40;i++) a.push({ id:'c'+i, name:'note_'+i+'.md', type:'custom', content:'## Note '+i+'\\n'+chatty });
  const ea = await m.assembleEvidence('Tell me about a time you disagreed with your team.', a);
  out.push({ label:'40 chatty notes + resume', chars: ea.length, kept: ea.indexOf(${JSON.stringify(MARK)})>=0, kbChars: a.reduce((n,f)=>n+f.content.length,0) });

  // B) one 85K architecture doc using the same vocabulary -> must be BULK
  var big = '# Platform Notes\\n' + chatty.repeat(24);
  var b = [{ id:'r', name:'Venu_Resume.pdf', type:'custom', content:'PROFESSIONAL SUMMARY\\nSenior DE.\\n\\nWORK EXPERIENCE\\n${MARK} when the group could not agree.' },
           { id:'big', name:'platform_notes.md', type:'custom', content: big }];
  const eb = await m.assembleEvidence('Tell me about a time you disagreed with your team.', b);
  out.push({ label:'85K doc using resume words', chars: eb.length, kept: eb.indexOf(${JSON.stringify(MARK)})>=0, kbChars: b.reduce((n,f)=>n+f.content.length,0) });
  return JSON.stringify(out);
})()`;
const cost = JSON.parse(await ev(costExpr, true));
let costBad = 0;
for (const c of cost) {
  const ok = c.kept && c.chars < 25000;
  if (!ok) costBad++;
  console.log(`  ${ok ? '✅ ok   ' : '❌ BAD  '}  ${c.label.padEnd(46)} KB=${c.kbChars.toLocaleString().padStart(8)} → sent=${c.chars.toLocaleString().padStart(7)} chars  resume=${c.kept ? 'kept' : 'LOST'}`);
}
console.log(`\n  ${cost.length - costBad}/${cost.length} cost guards held`);
ws.close(); process.exit(bad + costBad ? 1 : 0);
