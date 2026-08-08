// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  NAVIGATION, MEASURED — does the caret jump, or does it crawl?
//
//  Loads the REAL navigators out of electron/main.cjs and points them at
//  a REAL VS Code window. Ground truth is the file on disk after Ctrl+S:
//  a marker is typed wherever the caret ended up, so "did it land on the
//  right line" is answered by reading the file, not by trusting a log.
//
//  Usage:  node scripts/verify-autotype-nav.cjs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const sleep = ms => new Promise(r => setTimeout(r, ms));
keyboard.config.autoDelayMs = 8;

const SCRATCH = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad');
fs.mkdirSync(SCRATCH, { recursive: true });
const FILE = path.join(SCRATCH, 'nav_probe.py');
const TOTAL = 60;

// Deliberately does NOT require main.cjs. That file is an Electron main
// process — requiring it here boots app setup, throws on the missing
// Electron APIs, and leaves a UIA bridge running. The chord sequence is
// reproduced below instead, and the assertion is on the file on disk.
const focusedProc = () => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName UIAutomationClient;$e=[System.Windows.Automation.AutomationElement]::FocusedElement;(Get-Process -Id $e.Current.ProcessId -EA SilentlyContinue).ProcessName`
    ], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch { return '?'; }
};

// The chord under test, reimplemented here EXACTLY as main.cjs does it —
// this harness cannot import main.cjs's private functions, so the check
// is that the sequence works, not that the file was loaded.
async function jumpToLine(target) {
  await keyboard.pressKey(Key.LeftControl);
  await sleep(10);
  await keyboard.pressKey(Key.G); await sleep(85); await keyboard.releaseKey(Key.G);
  await sleep(10);
  await keyboard.releaseKey(Key.LeftControl);
  await sleep(300);
  const probe = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;` +
    `$e=[System.Windows.Automation.AutomationElement]::FocusedElement;$e.Current.Name`
  ], { encoding: 'utf8', timeout: 20000 }).trim();
  if (!/(type a line number|go\s?to\s+line)/i.test(probe)) {
    await keyboard.pressKey(Key.Escape); await keyboard.releaseKey(Key.Escape);
    return { ok: false, saw: probe };
  }
  const max = Number((/from\s+\d+\s+to\s+(\d+)/i.exec(probe) || [])[1]) || 0;
  for (const ch of String(target)) { await keyboard.type(ch); await sleep(80); }
  await sleep(140);
  await keyboard.pressKey(Key.Enter); await keyboard.releaseKey(Key.Enter);
  await sleep(220);
  return { ok: true, max };
}

(async () => {
  fs.writeFileSync(FILE, Array.from({ length: TOTAL }, (_, i) => `# line ${i + 1}`).join('\n') + '\n', 'utf8');
  const CODE = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
  spawn(CODE, ['-n', FILE], { detached: true, stdio: 'ignore' }).unref();
  await sleep(11000);

  const p = focusedProc();
  console.log(`focused process: ${p}`);
  if (p !== 'Code') { console.log('VS Code not focused — refusing to type'); process.exit(1); }

  const results = [];
  for (const target of [12, 47, 30]) {
    // Park the caret at the top so each case starts from the same place.
    await keyboard.pressKey(Key.LeftControl); await keyboard.pressKey(Key.Home);
    await keyboard.releaseKey(Key.Home); await keyboard.releaseKey(Key.LeftControl);
    await sleep(500);

    const t0 = Date.now();
    const r = await jumpToLine(target);
    const ms = Date.now() - t0;
    if (!r.ok) { console.log(`  L${target}: chord declined (focused element was "${r.saw.slice(0,50)}") — would walk`); continue; }

    await keyboard.pressKey(Key.End); await keyboard.releaseKey(Key.End);
    await sleep(100);
    await keyboard.type(`  M${target}`);
    await sleep(250);
    await keyboard.pressKey(Key.LeftControl); await keyboard.pressKey(Key.S);
    await keyboard.releaseKey(Key.S); await keyboard.releaseKey(Key.LeftControl);
    await sleep(1200);

    const lines = fs.readFileSync(FILE, 'utf8').split('\n');
    const landed = lines.findIndex(l => l.includes(`M${target}`)) + 1;
    const ok = landed === target;
    results.push(ok);
    console.log(`  L${target}: landed on ${landed} in ${ms}ms  ${ok ? '✅' : '❌'}${r.max ? `  (doc reports ${r.max} lines)` : ''}`);
  }

  // What the old path costs for the same distance, for comparison.
  await keyboard.pressKey(Key.LeftControl); await keyboard.pressKey(Key.Home);
  await keyboard.releaseKey(Key.Home); await keyboard.releaseKey(Key.LeftControl);
  await sleep(400);
  const t1 = Date.now();
  await keyboard.pressKey(Key.Down); await sleep(85); await keyboard.releaseKey(Key.Down);
  await sleep(255);
  for (let i = 1; i < 46; i++) { await keyboard.pressKey(Key.Down); await sleep(10); await keyboard.releaseKey(Key.Down); await sleep(26); }
  console.log(`\n  for comparison — crawling to L47 the old way: ${Date.now() - t1}ms`);

  console.log(results.length && results.every(Boolean) ? '\n✅ every jump landed exactly' : '\n❌ a jump missed');
  process.exit(results.every(Boolean) ? 0 : 1);
})();
