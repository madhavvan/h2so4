// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  End-to-end drive of the REAL user flow:
//    open the pop-out -> put a backend coding question on screen ->
//    click AUTO-SOLVE (screenshot -> model) -> wait for the code block ->
//    click AUTO-TYPE -> focus the editor during the countdown ->
//    watch the solution land in the file on disk.
//
//  Everything is driven through the app's own UI (real button clicks over
//  CDP), not through internal helpers, so this exercises exactly what a
//  candidate does. Ground truth for the typing is the FILE ON DISK.
//
//  Usage: node scripts/drive-popout-autosolve.mjs [--probe]
//         --probe reports auth/tier/gates and exits without acting.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROBE = process.argv.includes('--probe');

const SCRATCH = path.join(os.tmpdir(), 'claude', 'C--Users-penta', '7586704a-eea2-4204-a133-acc0ee56f32b', 'scratchpad');
fs.mkdirSync(SCRATCH, { recursive: true });
const TARGET = path.join(SCRATCH, 'interview_problem.py');

// A backend coding question, shaped like a real screening pad: the prompt
// as a comment block, then a stub for the candidate to fill in.
const PROBLEM = `# BACKEND ENGINEERING — CODING ROUND
#
# You are given a list of API request log entries, each a tuple of
# (timestamp_seconds: int, client_id: str, endpoint: str).
#
# Implement a sliding-window rate limiter check: return the list of
# client_ids that exceeded \`limit\` requests within ANY window of
# \`window_seconds\` seconds. Logs are NOT sorted. Return the ids sorted.
#
# Target: O(n log n). Do not use external libraries.


def find_rate_limit_violators(logs, window_seconds, limit):
    pass
`;

const cdp = async (url) => {
  const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0; const P = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; P.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = (expr, awaitPromise = false) => send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
    .then(r => {
      if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || '').slice(0, 300));
      return r.result?.result?.value;
    });
  return { ws, send, ev, close: () => ws.close() };
};

const targets = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter(t => t.type === 'page');

function foregroundProcess() {
  const ps = `Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
"@
$h=[W]::GetForegroundWindow();$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName`;
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim(); }
  catch { return '?'; }
}
// Windows refuses SetForegroundWindow from a process that isn't already in
// front. The supported way around it is to attach our input queue to the
// current foreground thread for the duration of the call — a normal window
// activation, nothing hidden or destructive.
function focusCode() {
  const ps = `Add-Type @"
using System;using System.Runtime.InteropServices;
public class Fg{
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool attach);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
 [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
}
"@
$p = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { "no-window"; exit }
$target = $p.MainWindowHandle
$fg = [Fg]::GetForegroundWindow()
$dummy = 0
$fgThread = [Fg]::GetWindowThreadProcessId($fg, [ref]$dummy)
$myThread = [Fg]::GetCurrentThreadId()
[void][Fg]::AttachThreadInput($fgThread, $myThread, $true)
[void][Fg]::ShowWindow($target, 9)
[void][Fg]::BringWindowToTop($target)
[void][Fg]::SetForegroundWindow($target)
[void][Fg]::AttachThreadInput($fgThread, $myThread, $false)
"ok"`;
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim(); }
  catch { return 'err'; }
}
async function ensureCodeFocused(tries = 8) {
  for (let i = 0; i < tries; i++) {
    if (/^Code$/i.test(foregroundProcess())) return true;
    focusCode();
    await sleep(900);
  }
  return /^Code$/i.test(foregroundProcess());
}

(async () => {
  const list = await targets();
  const mainT = list.find(t => t.url.includes('localhost:3005') && !t.url.includes('popout'));
  if (!mainT) { console.error('main window not found'); process.exit(1); }
  let main = await cdp(mainT.webSocketDebuggerUrl);

  // ── Auth: sign the renderer in as the real admin user from the local DB
  // (same approach as audit-opus.mjs). Auto-Solve and Auto-Type are both
  // tier-gated, so an unauthenticated renderer can't exercise either.
  if (!PROBE) {
    const Database = require('better-sqlite3');
    const jwt = require('jsonwebtoken');
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'minicaai.db');
    const ddb = new Database(dbPath, { readonly: true });
    const email = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
    const u = ddb.prepare('SELECT id,email,name FROM users WHERE email = ?').get(email);
    if (!u) { console.error('no admin user in local DB for', email); process.exit(1); }
    const lic = ddb.prepare('SELECT tier,status,expires_at,sessions_limit,sessions_used,credits_remaining_seconds,credits_expire_at,trial_remaining_seconds FROM licenses WHERE user_id = ?').get(u.id);
    const token = jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '2h' });
    await main.ev(`(()=>{localStorage.setItem('minicaai_token',${JSON.stringify(token)});localStorage.setItem('minicaai_auth',${JSON.stringify(JSON.stringify({ id: u.id, email: u.email, name: u.name || 'A' }))});localStorage.setItem('minicaai_license',${JSON.stringify(JSON.stringify(lic))});localStorage.setItem('SELECTED_MODEL','openai');localStorage.setItem('REASONING_EFFORT','none');localStorage.setItem('GENERAL_MODE','false');return 1;})()`);
    await main.send('Page.reload', { ignoreCache: true });
    main.close();
    await sleep(4000);
    const relist = await targets();
    const again = relist.find(t => t.url.includes('localhost:3005') && !t.url.includes('popout'));
    main = await cdp(again.webSocketDebuggerUrl);
    console.log(`signed in as ${u.email} (tier=${lic ? lic.tier : 'none'})`);
    await sleep(2000);
  }

  // ── State probe: is this session able to Auto-Solve / Auto-Type at all? ──
  const state = await main.ev(`(function(){
    var pick = function(sel){ var e=document.querySelector(sel); return e ? {found:true, disabled:!!e.disabled, label:(e.getAttribute('aria-label')||'').slice(0,80)} : {found:false}; };
    return JSON.stringify({
      title: document.title,
      signedIn: !!localStorage.getItem('minicaai_token'),
      autoSolveBtn: pick('[aria-label^="Auto-Solve"]'),
      msgCount: document.querySelectorAll('.flex.justify-start, .flex.justify-end').length,
      codeBlocks: document.querySelectorAll('pre code, .markdown-body pre').length
    });
  })()`);
  console.log('APP STATE:', state);

  if (PROBE) { main.close(); process.exit(0); }

  // ── 1. Put the coding problem on screen in a real editor ──
  fs.writeFileSync(TARGET, PROBLEM, 'utf8');
  const CODE_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  if (!execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*interview_problem*" } | Measure-Object).Count'],{encoding:'utf8'}).trim().startsWith('1')) spawn(CODE_EXE, ['--new-window', '--disable-extensions', TARGET], { detached: true, stdio: 'ignore' }).unref();
  console.log('\n[1] Opened the backend coding question in VS Code (this is what Auto-Solve will screenshot)');
  await sleep(9000);
  if (!(await ensureCodeFocused())) { console.error('could not foreground VS Code — aborting, no keystrokes sent'); main.close(); process.exit(2); }
  console.log('    VS Code focused ✓ (problem visible on screen)');

  // Shared DOM probe (defined early — step 3 uses it to confirm a clean slate).
  const DOM_EARLY = `(function(){
    var blocks = document.querySelectorAll('pre code');
    var last = blocks.length ? blocks[blocks.length-1].innerText : '';
    return JSON.stringify({ n: blocks.length, chars: last.length,
      streaming: !!document.querySelector('.stream-caret'),
      thinking: document.body.innerText.indexOf('THINKING (') >= 0,
      atBtn: !!document.querySelector('[aria-label*="Types this code"]') });
  })()`;

  // ── 2. Open the pop-out ──
  await main.ev(`window.electronAPI.send('open-popout', {})`);
  await sleep(2500);
  const withPop = await targets();
  const popT = withPop.find(t => t.url.includes('popout'));
  console.log(`[2] Pop-out ${popT ? 'OPEN ✓  ' + popT.url : 'did NOT open ✗'}`);
  const pop = popT ? await cdp(popT.webSocketDebuggerUrl) : null;

  // ── 3. Click AUTO-SOLVE (real button, screenshots the screen) ──
  // Start from a clean slate: cancel anything in flight (the Auto-Type
  // control is a TOGGLE — clicking it while a run is active CANCELS that
  // run, which is what happened on the first attempt) and open a fresh
  // session so the code block we act on is the one this run produced.
  await main.ev(`window.electronAPI.send('auto-type:abort')`);
  await sleep(1200);
  await main.ev(`typeof window.__dev_newSession==='function' ? (window.__dev_newSession(),1) : 0`);
  await sleep(2000);
  const cleared = JSON.parse(await (pop || main).ev(DOM_EARLY));
  console.log(`    fresh session: ${cleared.n} code block(s) on screen before Auto-Solve`);
  await ensureCodeFocused();
  const surface = pop || main;
  const clicked = await surface.ev(`(function(){
    var b = document.querySelector('[aria-label^="Auto-Solve"]');
    if (!b) return 'no-button';
    if (b.disabled) return 'disabled';
    b.click(); return 'clicked';
  })()`);
  console.log(`[3] Auto-Solve button on the ${pop ? 'POP-OUT' : 'main window'}: ${clicked}`);
  if (clicked !== 'clicked') {
    console.error('    cannot proceed without Auto-Solve');
    main.close(); if (pop) pop.close(); process.exit(3);
  }

  // ── 4. Wait for the model to answer with a code block ──
  const DOM = `(function(){
    var blocks = document.querySelectorAll('pre code');
    var last = blocks.length ? blocks[blocks.length-1].innerText : '';
    return JSON.stringify({
      n: blocks.length,
      chars: last.length,
      streaming: !!document.querySelector('.stream-caret'),
      thinking: /THINKING \\(/.test(document.body.innerText),
      atBtn: !!document.querySelector('[aria-label*="Types this code"]')
    });
  })()`;
  // Poll the SURFACE the button lives on (the pop-out), not the main
  // window — they are separate renderers with separate DOMs.
  const t0 = Date.now();
  let st = null;
  for (let i = 0; i < 300; i++) {
    st = JSON.parse(await surface.ev(DOM));
    if (st.n > 0 && !st.streaming && !st.thinking && st.chars > 40) break;
    await sleep(500);
  }
  console.log(`[4] Model answered in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${st.n} code block(s), ${st.chars} chars, Auto-Type button present: ${st.atBtn}`);
  const solution = await surface.ev(`(function(){var b=document.querySelectorAll('pre code');return b.length?b[b.length-1].innerText:'';})()`);
  console.log('\n──── SOLUTION THE MODEL PRODUCED ────');
  console.log(solution.split('\n').map((l, i) => String(i + 1).padStart(3) + ' | ' + l).join('\n'));

  // ── 5. Prepare the target file, focus the editor, click AUTO-TYPE ──
  // Real flow: click Auto-Type, then click into your editor during the
  // 3-second countdown. We do exactly that.
  console.log('\n[5] Clicking Auto-Type, then focusing the editor during the countdown…');
  const before = fs.readFileSync(TARGET, 'utf8');
  // Record the engine's own status broadcasts so we know exactly when the
  // run finishes. The previous version sampled the file with Ctrl+S every
  // few seconds WHILE the typer was running — those keystrokes interleave
  // with the engine's and can corrupt the very thing being measured.
  await surface.ev(`(function(){
    window.__at_events = [];
    if (!window.__at_hooked) {
      window.__at_hooked = true;
      window.electronAPI.on('auto-type:status', function(d){
        try { window.__at_events.push({ t: Date.now(), phase: d && d.phase, reason: d && d.reason }); } catch(e){}
      });
    }
    return 1;
  })()`);
  const atClicked = await surface.ev(`(function(){
    var b = document.querySelector('[aria-label*="Types this code"]');
    if (!b) return 'no-button';
    b.click(); return 'clicked';
  })()`);
  console.log(`    Auto-Type button: ${atClicked}`);
  if (atClicked !== 'clicked') { main.close(); if (pop) pop.close(); process.exit(4); }

  await ensureCodeFocused();
  console.log(`    editor focused during countdown ✓ (foreground=${foregroundProcess()})`);

  // ── 6. Watch it type ──
  // Watch the engine's OWN phase stream. No keystrokes from us while it
  // types — the editor is left entirely to the auto-typer.
  console.log('\n[6] Watching the engine phases (no interference — we send nothing while it types):');
  const tType = Date.now();
  let seen = 0, finished = false;
  for (let i = 0; i < 240; i++) {
    await sleep(2000);
    const evs = JSON.parse(await surface.ev(`JSON.stringify(window.__at_events || [])`));
    for (; seen < evs.length; seen++) {
      const e = evs[seen];
      console.log(`    +${String(((e.t - tType) / 1000).toFixed(0)).padStart(3)}s  ${e.phase}${e.reason ? ' (' + e.reason + ')' : ''}`);
      if (e.phase === 'done' || e.phase === 'verify-ok' || e.phase === 'verify-mismatch') finished = true;
    }
    if (finished) { await sleep(2500); break; }
  }
  if (!finished) console.log('    (no terminal phase seen within the window)');

  // Only NOW save, so the file read is the finished document.
  const { keyboard, Key } = require('@nut-tree-fork/nut-js');
  keyboard.config.autoDelayMs = 8;
  if (await ensureCodeFocused()) {
    await keyboard.pressKey(Key.LeftControl); await sleep(10);
    await keyboard.pressKey(Key.S); await sleep(12); await keyboard.releaseKey(Key.S); await sleep(8);
    await keyboard.releaseKey(Key.LeftControl);
    await sleep(1500);
  }

  const after = fs.readFileSync(TARGET, 'utf8');
  console.log('\n──── FILE ON DISK AFTER AUTO-TYPE ────');
  console.log(after.split('\n').map((l, i) => String(i + 1).padStart(3) + ' | ' + l).join('\n'));
  console.log(`\nchanged: ${after !== before ? 'YES' : 'NO — nothing was typed'}`);
  console.log(`stub still present ("pass" untouched): ${/def find_rate_limit_violators\(logs, window_seconds, limit\):\s*\n\s*pass/.test(after) ? 'yes (auto-type did not fill it)' : 'no (it was replaced)'}`);
  main.close(); if (pop) pop.close();
  process.exit(0);
})().catch(e => { console.error('DRIVE FAILED:', e && e.message); process.exit(1); });
