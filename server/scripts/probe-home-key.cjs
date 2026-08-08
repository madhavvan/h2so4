// Where does Home actually put the caret in Monaco?
//
// electron/main.cjs assumes Home == column 0 (navigateToDocLine ends with
// Home, selectLineRangeContent starts from there). If Monaco implements
// "smart home" — first press goes to the first NON-WHITESPACE character —
// then on any indented line the engine never reaches column 0: the leading
// whitespace is neither selected nor replaced, and the code's own indent is
// typed on top of it. Measured symptom: 16 spaces where 8 were intended.
//
// This types a marker after each variant and reads the file back, so the
// answer comes from the document rather than from documentation.
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const sleep = ms => new Promise(r => setTimeout(r, ms));
keyboard.config.autoDelayMs = 8;

const SCRATCH = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad');
fs.mkdirSync(SCRATCH, { recursive: true });
const FILE = path.join(SCRATCH, 'home_key_probe.txt');

// Four identical indented lines; each gets a different Home treatment.
const STUB = ['        alpha', '        alpha', '        alpha', '        alpha', ''].join('\n');

const tap = async k => { await keyboard.pressKey(k); await sleep(12); await keyboard.releaseKey(k); await sleep(12); };
const ctrlTap = async k => {
  await keyboard.pressKey(Key.LeftControl); await sleep(8);
  await keyboard.pressKey(k); await sleep(12); await keyboard.releaseKey(k); await sleep(8);
  await keyboard.releaseKey(Key.LeftControl); await sleep(12);
};

function focusedProcess() {
  const ps = `Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
"@
$h=[W]::GetForegroundWindow();$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p).ProcessName`;
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim(); }
  catch { return '?'; }
}

(async () => {
  fs.writeFileSync(FILE, STUB, 'utf8');
  const CODE_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  spawn(CODE_EXE, ['--new-window', '--disable-extensions', FILE], { detached: true, stdio: 'ignore' }).unref();
  await sleep(9000);
  const proc = focusedProcess();
  if (!/^Code$/i.test(proc)) { console.error(`REFUSING — focused process "${proc}" is not Code`); process.exit(2); }

  const goLine = async n => { await ctrlTap(Key.Home); for (let i = 0; i < n - 1; i++) await tap(Key.Down); };

  // L1: End then ONE Home  -> marker shows where a single Home lands
  await goLine(1); await tap(Key.End); await tap(Key.Home); await keyboard.type('1');
  // L2: End then TWO Homes -> does a second press reach column 0?
  await goLine(2); await tap(Key.End); await tap(Key.Home); await tap(Key.Home); await keyboard.type('2');
  // L3: End then THREE Homes -> is it a toggle (would bounce back)?
  await goLine(3); await tap(Key.End); await tap(Key.Home); await tap(Key.Home); await tap(Key.Home); await keyboard.type('3');
  // L4: End then Shift+Home selection, then type -> what does it replace?
  await goLine(4); await tap(Key.End);
  await keyboard.pressKey(Key.LeftShift); await sleep(8);
  await keyboard.pressKey(Key.Home); await sleep(12); await keyboard.releaseKey(Key.Home); await sleep(8);
  await keyboard.releaseKey(Key.LeftShift); await sleep(12);
  await keyboard.type('4');

  await sleep(500); await ctrlTap(Key.S); await sleep(1500);
  const got = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const label = ['ONE Home', 'TWO Homes', 'THREE Homes', 'Shift+Home then type'];
  console.log('line  treatment              result');
  got.slice(0, 4).forEach((l, i) => console.log(`  L${i + 1}  ${label[i].padEnd(22)} ${JSON.stringify(l)}`));
  const col0 = got[0].startsWith('1');
  console.log(`\nSingle Home reaches column 0: ${col0 ? 'YES' : 'NO — it stops at the first non-whitespace character (smart home)'}`);
  console.log(`Second Home reaches column 0: ${got[1].startsWith('2') ? 'YES' : 'NO'}`);
  console.log(`Third Home stays at column 0: ${got[2].startsWith('3') ? 'YES' : 'NO — it toggles back'}`);
  process.exit(0);
})();
