// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Drive a REAL editor with the REAL keystroke sequence.
//
//  The simulator says the fixed line-break sequence produces byte-exact
//  code; this proves it against genuine Monaco (VS Code), with genuine
//  auto-closing brackets and auto-indent, using the same nut-js the app
//  uses. Ground truth is the FILE ON DISK after Ctrl+S — not a UIA read,
//  which is what made the production traces ambiguous in the first place.
//
//  No AI calls, no cost. Humanization delays are omitted: they change
//  timing, never the character sequence.
//
//  Usage:  node scripts/live-editor-verify.cjs [--legacy]
//          --legacy replays the pre-fix sequence for comparison.
//
//  SAFETY: types into whatever window is focused. It launches its own
//  VS Code window on a scratch file, focuses it, and verifies the focused
//  process is Code.exe before sending a single keystroke.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEGACY = process.argv.includes('--legacy');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

keyboard.config.autoDelayMs = 8;

const SCRATCH = path.join(
  os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad'
);
fs.mkdirSync(SCRATCH, { recursive: true });
const PY = process.argv.includes('--python');
const FILE = path.join(SCRATCH, `autotype_probe_${LEGACY ? 'legacy' : 'fixed'}.${(PY || process.argv.includes('--twoblocks') || process.argv.includes('--deep')) ? 'py' : 'java'}`);

// HackerRank-shaped Java stub — the exact shape of recorded runs #16/#17.
// Python variant: the dangerous case — code whose lines sit at column 0
// (imports, blank lines) with the platform's driver block BELOW the cursor.
// The old sequence forward-deleted that block one line at a time.
const PY_STUB = [
  '# Complete the function below.',
  '',
  'def placeholder():',
  '    pass',
  '',
  'if __name__ == "__main__":',
  '    print(placeholder())',
  '',
].join('\n');
const PY_OP = { start_line: 3, end_line: 4 };
const PY_CODE = [
  'import sys',
  'from collections import deque',
  '',
  'def solve(grid):',
  '    q = deque()',
  '    q.append((0, 0))',
  '    return len(q)',
];

const STUB = [
  'import java.io.*;',
  'import java.util.*;',
  '',
  'public class Solution {',
  '    public static void main(String[] args) {',
  '        /* Enter your code here. */',
  '    }',
  '}',
  '',
].join('\n');

// One replace op covering the stub comment — the common vision plan shape.
const OP = { start_line: 6, end_line: 6 };
const CODE = [
  '        Scanner sc = new Scanner(System.in);',
  '        int n = sc.nextInt();',
  '        int[] a = new int[n];',
  '        for (int i = 0; i < n; i++) {',
  '            a[i] = sc.nextInt();',
  '        }',
  '        Arrays.sort(a);',
  '        System.out.println(a[n - 1]);',
];

// TWO BROKEN BLOCKS — the live scenario: a file with two separate faults,
// fixed in one Auto-Type run. Exercises reading order, the running line
// shift (block A grows by a line, so block B's anchor moves), and walking
// between regions instead of re-anchoring at the top of the file.
const TB = process.argv.includes('--twoblocks');
const TB_STUB = [
  'import sys',                        // 1
  '',                                  // 2
  'def parse_line(s):',                // 3
  '    parts = s.split(',              // 4  ← broken: unclosed call
  '    return parts',                  // 5
  '',                                  // 6
  'def summarize(rows):',              // 7
  '    total = 0',                     // 8
  '    for r in rows',                 // 9  ← broken: missing colon
  '        total += r',                // 10
  '    return total',                  // 11
  '',                                  // 12
  'if __name__ == "__main__":',        // 13
  '    print(summarize([1, 2]))',      // 14
  '',
].join('\n');
// Block A becomes TWO lines (a strip() is added), so every anchor below it
// shifts by +1 — block B must still land on the right line.
const TB_OPS = [
  { op: 'replace', start_line: 4, end_line: 4,
    text: ['    parts = s.split(",")', '    parts = [p.strip() for p in parts]'].join('\n') },
  { op: 'replace', start_line: 9, end_line: 9, text: '    for r in rows:' },
];
const TB_EXPECTED = [
  'import sys', '', 'def parse_line(s):',
  '    parts = s.split(",")',
  '    parts = [p.strip() for p in parts]',
  '    return parts', '',
  'def summarize(rows):', '    total = 0',
  '    for r in rows:',
  '        total += r', '    return total', '',
  'if __name__ == "__main__":', '    print(summarize([1, 2]))', '',
].join('\n');


// ── DEEP NESTING — the case where auto-indent fights hardest ──
// Every DEDENT is a place the editor supplies indentation we do not want,
// and every nested block is a place it supplies some we do. Python makes
// the stakes real: get it wrong and the file does not run at all, while
// the post-write verify — which strips whitespace before comparing — would
// still call it present.
const DEEP = process.argv.includes('--deep');
const DEEP_STUB = [
  'import sys',
  '',
  'def process(rows):',
  '    pass',
  '',
  'if __name__ == "__main__":',
  '    print(process([]))',
  '',
].join('\n');
const DEEP_OP = { start_line: 3, end_line: 4 };
const DEEP_CODE = [
  'def process(rows):',
  '    out = []',
  '    for r in rows:',
  '        if not r:',
  '            continue',
  '        try:',
  '            n = int(r)',
  '        except ValueError:',
  '            continue',
  '        if n % 2 == 0:',
  '            out.append(n)',
  '        else:',
  '            out.append(-n)',
  '    return out',
];

const _STUB = DEEP ? DEEP_STUB : TB ? TB_STUB : (PY ? PY_STUB : STUB);
const _OPS = DEEP ? [{ ...DEEP_OP, text: DEEP_CODE.join('\n') }]
  : TB ? TB_OPS : [{ ...(PY ? PY_OP : OP), text: (PY ? PY_CODE : CODE).join('\n') }];

const EXPECTED = DEEP ? [
  ..._STUB.split('\n').slice(0, DEEP_OP.start_line - 1),
  ...DEEP_CODE,
  ..._STUB.split('\n').slice(DEEP_OP.end_line),
].join('\n') : TB ? TB_EXPECTED : [
  ..._STUB.split('\n').slice(0, _OPS[0].start_line - 1),
  ..._OPS[0].text.split('\n'),
  ..._STUB.split('\n').slice(_OPS[0].end_line),
].join('\n');

// ── key primitives, mirroring electron/main.cjs ──
const tap = async (k) => { await keyboard.pressKey(k); await sleep(12); await keyboard.releaseKey(k); await sleep(12); };
const shiftTap = async (k) => {
  await keyboard.pressKey(Key.LeftShift); await sleep(8);
  await keyboard.pressKey(k); await sleep(12); await keyboard.releaseKey(k); await sleep(8);
  await keyboard.releaseKey(Key.LeftShift); await sleep(12);
};
const ctrlTap = async (k) => {
  await keyboard.pressKey(Key.LeftControl); await sleep(8);
  await keyboard.pressKey(k); await sleep(12); await keyboard.releaseKey(k); await sleep(8);
  await keyboard.releaseKey(Key.LeftControl); await sleep(12);
};

// electron/main.cjs autoTypeGoToColumnZero — Monaco's Home is a toggle
// (first non-whitespace <-> column 0), so anchor at End and press twice.
async function goToColumnZero() {
  if (LEGACY) { await tap(Key.Home); return; }
  await tap(Key.End);
  await tap(Key.Home);
  await tap(Key.Home);
}
// electron/main.cjs autoTypeArrowRun — counted presses (so the landing line
// stays deterministic) but at key-repeat cadence past a short hop.
async function arrowRun(key, count) {
  if (!(count > 0)) return;
  await tap(key);
  if (count === 1) return;
  if (count <= 3 || LEGACY) {
    for (let i = 1; i < count; i++) await tap(key);
    return;
  }
  await sleep(190 + Math.random() * 130);          // typematic delay
  for (let i = 1; i < count; i++) {
    await keyboard.pressKey(key); await sleep(7 + Math.random() * 7);
    await keyboard.releaseKey(key); await sleep(19 + Math.random() * 15);
  }
  await sleep(130 + Math.random() * 200);
}
// electron/main.cjs navigateToDocLine + autoTypeJumpToLine.
//
// Mirrors the engine: ask the editor for the line directly, and only walk
// when it will not offer a line prompt. The chord is verified by reading
// the focused element's name — if what opened is not a line prompt (an
// unbound chord, a browser's find bar) we Escape and fall back, which is
// exactly what the engine does.
function focusedElementName() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;` +
      `$e=[System.Windows.Automation.AutomationElement]::FocusedElement;$e.Current.Name`
    ], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch { return ''; }
}
let gotoLineWorks = null;   // null = untried
async function jumpToLine(n) {
  if (gotoLineWorks === false) return false;
  await ctrlTap(Key.G);
  await sleep(320);
  const name = focusedElementName();
  if (!/(type a line number|go\s?to\s+line)/i.test(name)) {
    await tap(Key.Escape);
    gotoLineWorks = false;
    console.log(`  nav: no line prompt on Ctrl+G (saw "${name.slice(0, 40)}") — walking`);
    return false;
  }
  gotoLineWorks = true;
  for (const ch of String(n)) { await keyboard.type(ch); await sleep(80); }
  await sleep(140);
  await tap(Key.Enter);
  await sleep(220);
  const max = Number((/from\s+\d+\s+to\s+(\d+)/i.exec(name) || [])[1]) || 0;
  console.log(`  nav: JUMPED straight to L${n}${max ? ` (document has ${max} lines)` : ''}`);
  return true;
}
const GOTO_LINE_WORTH_IT = 13;   // mirrors electron/main.cjs
async function navigateToDocLine(n) {
  if (n >= GOTO_LINE_WORTH_IT && await jumpToLine(n)) {
    await goToColumnZero();
    return;
  }
  await ctrlTap(Key.Home);
  await arrowRun(Key.Down, n - 1);
  await goToColumnZero();
}
async function selectLineRangeContent(s, e) {
  for (let i = 0; i < e - s; i++) await shiftTap(Key.Down);
  await shiftTap(Key.End);
}
// electron/main.cjs autoTypeLineBreak
async function lineBreak() {
  if (LEGACY) {
    await tap(Key.Enter);
    await tap(Key.Home);
    await shiftTap(Key.End);
    await tap(Key.Delete);
    return;
  }
  await shiftTap(Key.End);   // consume auto-inserted closer
  await tap(Key.Enter);
  await tap(Key.Home);
  await shiftTap(Key.End);   // select auto-indent; next line types over it
}
// electron/main.cjs autoTypeConsumeTrailingResidue
async function consumeTrailingResidue() {
  await shiftTap(Key.End);
  await keyboard.type(' ');
  await sleep(30);
  await tap(Key.Backspace);
}
async function typeLines(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length) { await keyboard.type(lines[i]); await sleep(40); }
    if (i < lines.length - 1) await lineBreak();
  }
  if (!LEGACY) await consumeTrailingResidue();
}

function focusedProcess() {
  const ps = `Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
"@
$h=[W]::GetForegroundWindow();$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p).ProcessName`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
  } catch { return '?'; }
}

(async () => {
  fs.writeFileSync(FILE, _STUB, 'utf8');
  console.log(`Mode: ${LEGACY ? 'LEGACY (pre-fix sequence)' : 'FIXED (current main.cjs sequence)'}`);
  console.log(`File: ${FILE}\n`);

  const CODE_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  spawn(CODE_EXE, ['--new-window', '--disable-extensions', '--skip-release-notes', FILE], { detached: true, stdio: 'ignore' }).unref();
  console.log('Launching VS Code…');
  await sleep(9000);

  // Another window can grab focus while VS Code is starting, and right
  // after launch there may briefly be NO foreground window at all (the
  // focused-PID lookup then reports the System Idle process). Push VS Code
  // to the front and re-sample a few times. The guard below is what
  // actually protects us; this only avoids a spurious refusal.
  // SetForegroundWindow is refused by Windows' foreground lock when called
  // from a process that isn't already in front. WScript.Shell's AppActivate
  // is not subject to that restriction, so try it first and fall back.
  const forceForeground = () => {
    try {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type @"
using System;using System.Runtime.InteropServices;
public class Fg{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);}
"@
$p = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { "no-window"; exit }
[void][Fg]::ShowWindow($p.MainWindowHandle, 9)
try { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null } catch {}
[void][Fg]::SetForegroundWindow($p.MainWindowHandle)
"ok"`], { encoding: 'utf8' }).trim();
    } catch { return 'err'; }
  };
  let proc = focusedProcess();
  for (let attempt = 0; attempt < 6 && !/^Code$/i.test(proc); attempt++) {
    forceForeground();
    await sleep(1200);
    proc = focusedProcess();
  }
  if (!/^Code$/i.test(proc)) {
    console.error(`REFUSING to type — focused process is "${proc}", expected "Code". No keystrokes sent.`);
    process.exit(2);
  }
  console.log(`Focused process: ${proc} ✓`);

  // Click into the editor area: Ctrl+Home lands the caret in the text.
  await ctrlTap(Key.Home);
  await sleep(400);

  // ── executeMultiOpPlan: reading order + running line shift + relative nav ──
  const ordered = LEGACY
    ? [..._OPS].sort((a, b) => b.start_line - a.start_line)
    : [..._OPS].sort((a, b) => a.start_line - b.start_line);
  let lineShift = 0, caretLine = null;
  for (const op of ordered) {
    const s = Math.max(1, op.start_line + (LEGACY ? 0 : lineShift));
    const e = Math.max(s, op.end_line + (LEGACY ? 0 : lineShift));
    const span = op.end_line - op.start_line + 1;
    const lines = op.text.split('\n');
    // autoTypeGoToLine — walk from the caret when we know where it is.
    if (!LEGACY && Number.isInteger(caretLine) && Math.abs(s - caretLine) <= 40) {
      const d = s - caretLine;
      console.log(`  nav: walk ${d > 0 ? 'down' : 'up'} ${Math.abs(d)} from L${caretLine} -> L${s} (no viewport reset)`);
      await arrowRun(d > 0 ? Key.Down : Key.Up, Math.abs(d));
      await goToColumnZero();
    } else {
      console.log(`  nav: absolute anchor -> L${s}`);
      await navigateToDocLine(s);
    }
    console.log(`  edit: replace L${s}-${e} with ${lines.length} line(s)  [shift ${lineShift >= 0 ? '+' : ''}${lineShift}]`);
    await selectLineRangeContent(s, e);
    await tap(Key.Delete);
    await typeLines(lines);
    caretLine = s + lines.length - 1;
    lineShift += lines.length - span;
  }

  await sleep(600);
  await ctrlTap(Key.S);
  await sleep(1500);

  const got = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
  const ok = got.trimEnd() === EXPECTED.trimEnd();
  console.log(`\n─── FILE ON DISK ───`);
  console.log(got.split('\n').map((l, i) => String(i + 1).padStart(3) + ' | ' + l).join('\n'));
  const open = (got.match(/\{/g) || []).length, close = (got.match(/\}/g) || []).length;
  console.log(`\nbraces: ${open} open / ${close} close   balanced: ${open === close ? 'YES' : 'NO'}`);
  console.log(`byte-exact vs expected: ${ok ? '✅ YES' : '❌ NO'}`);
  if (!ok) {
    const g = got.trimEnd().split('\n'), w = EXPECTED.trimEnd().split('\n');
    for (let i = 0; i < Math.max(g.length, w.length); i++) {
      if (g[i] !== w[i]) console.log(`  L${i + 1}\n     got  ${JSON.stringify(g[i])}\n     want ${JSON.stringify(w[i])}`);
    }
  }
  process.exit(ok ? 0 : 1);
})();
