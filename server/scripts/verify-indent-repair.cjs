// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  INDENT REPAIR, AGAINST A REAL EDITOR
//
//  Types a block into real VS Code, then breaks the indentation on two
//  lines the way a mis-predicted auto-indent would, then runs the SAME
//  detect-and-retype sequence the engine runs — and reads the file off
//  disk to see whether the code came back correct.
//
//  The important assertion is not "it changed something". It is that the
//  file ends up BYTE-IDENTICAL to what was intended, because a repair
//  that half-works during an interview is worse than one that refuses.
//
//  Usage:  node scripts/verify-indent-repair.cjs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { compareIndentation, shouldReportIndent } = require('../../electron/autoTypeIndent.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
keyboard.config.autoDelayMs = 8;

const SCRATCH = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad');
fs.mkdirSync(SCRATCH, { recursive: true });
const FILE = path.join(SCRATCH, 'indent_repair.py');

const CODE = [
  'def process(rows):',
  '    out = []',
  '    for r in rows:',
  '        if not r:',
  '            continue',
  '        n = int(r)',
  '        if n % 2 == 0:',
  '            out.append(n)',
  '    return out',
];
const GOOD = CODE.join('\n') + '\n';
// Two lines de-indented — exactly what happens when the editor did not
// auto-indent and the predictor assumed it would.
const BROKEN = CODE.map(l =>
  (l.includes('n = int(r)') || l.includes('out.append(n)')) ? l.trimStart() : l
).join('\n') + '\n';

const tap = async k => { await keyboard.pressKey(k); await sleep(14); await keyboard.releaseKey(k); await sleep(14); };
const ctrlTap = async k => {
  await keyboard.pressKey(Key.LeftControl); await sleep(10);
  await keyboard.pressKey(k); await sleep(14); await keyboard.releaseKey(k); await sleep(10);
  await keyboard.releaseKey(Key.LeftControl); await sleep(14);
};
const shiftTap = async k => {
  await keyboard.pressKey(Key.LeftShift); await sleep(10);
  await keyboard.pressKey(k); await sleep(14); await keyboard.releaseKey(k); await sleep(10);
  await keyboard.releaseKey(Key.LeftShift); await sleep(14);
};
// electron/main.cjs autoTypeGoToColumnZero
const col0 = async () => { await tap(Key.End); await tap(Key.Home); await tap(Key.Home); };
async function goToLine(n) {   // mirrors navigateToDocLine's jump path
  await ctrlTap(Key.G); await sleep(340);
  for (const ch of String(n)) { await keyboard.type(ch); await sleep(80); }
  await sleep(140); await tap(Key.Enter); await sleep(260);
  await col0();
}
const focusedProc = () => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName UIAutomationClient;$e=[System.Windows.Automation.AutomationElement]::FocusedElement;(Get-Process -Id $e.Current.ProcessId -EA SilentlyContinue).ProcessName`
    ], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch { return '?'; }
};
const save = async () => { await ctrlTap(Key.S); await sleep(1400); };

(async () => {
  fs.writeFileSync(FILE, BROKEN, 'utf8');
  const CODE_EXE = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
  spawn(CODE_EXE, ['-n', FILE], { detached: true, stdio: 'ignore' }).unref();
  await sleep(11000);
  if (focusedProc() !== 'Code') { console.log('VS Code not focused — refusing to type'); process.exit(1); }
  console.log('focused process: Code ✓');

  // 1. The detector must see the damage.
  const before = compareIndentation(GOOD, fs.readFileSync(FILE, 'utf8'));
  console.log(`\ndetector on the broken file: ${before.mismatches.length} mismatch(es), block offset ${before.offset}`);
  if (!shouldReportIndent(before)) { console.log('❌ detector missed it'); process.exit(1); }
  console.log('✅ detected');

  // 2. Repair, the way the engine does: for each wrong line, navigate in
  //    DOCUMENT coordinates, select the line, retype the intended one.
  const stripWs = s => s.replace(/\s+/g, '');
  const targets = [];
  for (const m of before.mismatches) {
    const hits = CODE.map((l, i) => stripWs(l) === stripWs(m.line) ? i : -1).filter(i => i >= 0);
    if (hits.length === 1) targets.push({ index: hits[0], line: CODE[hits[0]] });
  }
  console.log(`locatable targets: ${targets.length}`);
  targets.sort((a, b) => a.index - b.index);

  for (const t of targets) {
    const docLine = 1 + t.index;      // block starts at document line 1
    await goToLine(docLine);
    await shiftTap(Key.End);          // select the line's content
    await sleep(150);
    await tap(Key.Delete);
    await sleep(120);
    await keyboard.type(t.line);
    await sleep(250);
    console.log(`  retyped L${docLine}: "${t.line.trim().slice(0, 34)}"`);
  }
  await save();

  // 3. Ground truth.
  const after = fs.readFileSync(FILE, 'utf8');
  const exact = after === GOOD;
  const recheck = compareIndentation(GOOD, after);
  console.log('\n─── FILE ON DISK ───');
  after.split('\n').forEach((l, i) => { if (l !== '' || i < 9) console.log(String(i + 1).padStart(3) + ' | ' + l); });
  console.log(`\nremaining mismatches: ${recheck.mismatches.length}`);
  console.log(exact ? '✅ byte-exact — the repair restored the intended code'
                    : '❌ not byte-exact after repair');
  process.exit(exact && !shouldReportIndent(recheck) ? 0 : 1);
})();
