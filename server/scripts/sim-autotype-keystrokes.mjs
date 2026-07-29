// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Keystroke-level simulator for the auto-type engine.
//
//  WHY: .autotype-plans.jsonl shows real runs ending with orphan closing
//  braces / whitespace-only documents, but the trace records only the
//  START and END state — never the keystrokes in between. This replays the
//  EXACT key sequence main.cjs emits against a model of a Monaco-style
//  editor (auto-closing brackets + auto-indent), so the failure can be
//  observed step by step instead of inferred.
//
//  FIDELITY: the key sequence below mirrors electron/main.cjs exactly —
//    navigateToDocLine     : Ctrl+Home, Down×(n-1), Home
//    selectLineRangeContent: Shift↓×(e-s), Shift+End
//    replace op            : nav, select, Delete, typeLinesHumanized
//    delete op             : nav, select, Delete, Delete
//    insert op             : nav, End, Enter, Home, Shift+End, Delete, type
//    typeLinesHumanized    : per line -> type chars; between lines ->
//                            Enter, Home, Shift+End, Delete
//  Humanization (delays, typos, backtracking) changes TIMING only, never
//  the net character sequence, so it is omitted.
//
//  VALIDATION: run with --validate to replay the recorded runs from
//  .autotype-plans.jsonl and compare the simulated final document against
//  the afterText the app actually read back. Agreement is what makes the
//  editor model credible.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };
const QUOTES = new Set(['"', "'", '`']);

// Model of a code editor. `autoClose`/`autoIndent` reproduce Monaco's
// defaults (HackerRank, CodeSignal, VS Code) — CodeMirror/CoderPad behave
// the same for these two features. Set both false to model a plain
// textarea and isolate which behaviour causes a given failure.
class Editor {
  constructor(text, { autoClose = true, autoIndent = true, indentUnit = 4 } = {}) {
    this.lines = String(text).split('\n');
    this.r = 0; this.c = 0;
    this.anchor = null;           // selection anchor {r,c}
    this.autoClose = autoClose;
    this.autoIndent = autoIndent;
    this.indentUnit = indentUnit;
  }
  get text() { return this.lines.join('\n'); }
  line(i = this.r) { return this.lines[i] ?? ''; }
  clampC() { this.c = Math.max(0, Math.min(this.c, this.line().length)); }

  _ordered() {
    const a = this.anchor, b = { r: this.r, c: this.c };
    if (!a) return null;
    const first = (a.r < b.r || (a.r === b.r && a.c <= b.c)) ? a : b;
    const last = first === a ? b : a;
    return { first, last };
  }
  hasSel() { const o = this._ordered(); return !!o && !(o.first.r === o.last.r && o.first.c === o.last.c); }
  deleteSel() {
    const o = this._ordered();
    if (!o) return false;
    const { first, last } = o;
    if (first.r === last.r && first.c === last.c) return false;
    const head = this.line(first.r).slice(0, first.c);
    const tail = this.line(last.r).slice(last.c);
    this.lines.splice(first.r, last.r - first.r + 1, head + tail);
    this.r = first.r; this.c = first.c; this.anchor = null;
    return true;
  }

  press(key, shift = false) {
    if (this.keylog) this.keylog.push((shift ? 'Shift+' : '') + key);
    if (shift && !this.anchor) this.anchor = { r: this.r, c: this.c };
    // Only MOVEMENT collapses a selection. Delete/Backspace/Enter and
    // typing consume it — clearing the anchor first would silently turn
    // every "select then delete" into a no-op.
    const isMove = ['CtrlHome', 'CtrlEnd', 'Home', 'End', 'Down', 'Up'].includes(key);
    if (!shift && isMove) this.anchor = null;
    switch (key) {
      case 'CtrlHome': this.r = 0; this.c = 0; break;
      case 'CtrlEnd': this.r = this.lines.length - 1; this.c = this.line().length; break;
      // Smart home, as measured in real Monaco (probe-home-key.cjs):
      // press 1 -> first non-whitespace char, press 2 -> column 0,
      // press 3 -> back to the first non-whitespace char.
      case 'Home': {
        const first = this.line().search(/\S/);
        const smart = first === -1 ? 0 : first;
        this.c = (this.c === smart) ? 0 : smart;
        break;
      }
      case 'End': this.c = this.line().length; break;
      case 'Down': this.r = Math.min(this.lines.length - 1, this.r + 1); this.clampC(); break;
      case 'Up': this.r = Math.max(0, this.r - 1); this.clampC(); break;
      // Any edit collapses the selection, whether or not it removed a range.
      case 'Delete': this._delete(); this.anchor = null; break;
      case 'Backspace': this._backspace(); this.anchor = null; break;
      case 'Enter': this._enter(); this.anchor = null; break;
      case 'CtrlA':
        this.anchor = { r: 0, c: 0 };
        this.r = this.lines.length - 1; this.c = this.line().length;
        break;
      default: throw new Error('unknown key ' + key);
    }
  }
  _delete() {
    if (this.deleteSel()) return;
    const ln = this.line();
    if (this.c < ln.length) this.lines[this.r] = ln.slice(0, this.c) + ln.slice(this.c + 1);
    else if (this.r < this.lines.length - 1) {
      this.lines[this.r] = ln + this.line(this.r + 1);
      this.lines.splice(this.r + 1, 1);
    }
  }
  _backspace() {
    if (this.deleteSel()) return;
    const ln = this.line();
    if (this.c > 0) { this.lines[this.r] = ln.slice(0, this.c - 1) + ln.slice(this.c); this.c--; }
    else if (this.r > 0) {
      const prev = this.line(this.r - 1);
      this.c = prev.length;
      this.lines[this.r - 1] = prev + ln;
      this.lines.splice(this.r, 1);
      this.r--;
    }
  }
  _indentOf(s) { const m = String(s).match(/^[ \t]*/); return m ? m[0] : ''; }
  _enter() {
    this.deleteSel();
    const ln = this.line();
    const before = ln.slice(0, this.c);
    const after = ln.slice(this.c);

    let indent = '';
    if (this.autoIndent) {
      indent = this._indentOf(ln);
      if (/[{:([]\s*$/.test(before)) indent += ' '.repeat(this.indentUnit);
    }

    // Monaco brace expansion: Enter with the caret between a just-opened
    // bracket and its auto-inserted closer produces THREE lines, pushing
    // the closer onto its own line at the outer indent.
    const prevCh = before.slice(-1);
    const nextCh = after.slice(0, 1);
    if (this.autoIndent && OPEN[prevCh] && OPEN[prevCh] === nextCh) {
      const outer = this._indentOf(ln);
      this.lines.splice(this.r, 1, before, indent, outer + after);
      this.r += 1; this.c = indent.length;
      return;
    }
    this.lines.splice(this.r, 1, before, indent + after);
    this.r += 1; this.c = indent.length;
  }

  type(ch) {
    if (this.keylog) this.keylog.push('char');
    this.deleteSel();
    this.anchor = null;
    const ln = this.line();
    const after = ln.slice(this.c);
    const next = after.slice(0, 1);

    // Overtype: typing a closer that is already sitting under the caret
    // (auto-inserted moments ago) just steps over it.
    if (this.autoClose && (CLOSE[ch] || QUOTES.has(ch)) && next === ch) { this.c++; return; }

    let ins = ch;
    if (this.autoClose && OPEN[ch] && (next === '' || /\s/.test(next) || CLOSE[next])) ins = ch + OPEN[ch];
    else if (this.autoClose && QUOTES.has(ch) && (next === '' || /\s/.test(next) || CLOSE[next])) ins = ch + ch;

    this.lines[this.r] = ln.slice(0, this.c) + ins + after;
    this.c += 1; // caret lands INSIDE an auto-closed pair
  }
  typeString(s) { for (const ch of s) this.type(ch); }
}

// ── The engine's key sequences, mirrored from electron/main.cjs ──

// autoTypeGoToColumnZero — End then two Homes. Monaco's Home is a toggle
// (first non-whitespace <-> column 0), so anchoring at End makes the two
// presses land on column 0 for every line shape.
function goToColumnZero(ed) {
  if (LEGACY) { ed.press('Home'); return; }
  ed.press('End');
  ed.press('Home');
  ed.press('Home');
}

function navigateToDocLine(ed, lineNum) {
  ed.press('CtrlHome');
  for (let i = 0; i < Math.max(1, lineNum | 0) - 1; i++) ed.press('Down');
  goToColumnZero(ed);
}

function selectLineRangeContent(ed, s, e) {
  const span = Math.max(0, (e | 0) - (s | 0));
  for (let i = 0; i < span; i++) ed.press('Down', true);
  ed.press('End', true);
}

// electron/main.cjs — autoTypeLineBreak, used between every pair of lines
// by BOTH typing paths:
//   Shift+End : select any closer the editor auto-inserted after the caret
//   Enter     : deletes that selection, then splits
//   Home + Shift+End : select the editor's auto-indent on the new line
// The next line then types OVER that selection. Nothing is Deleted.
//
// Set LEGACY=1 in the environment to replay the pre-fix sequence
// (Enter, Home, Shift+End, Delete) for before/after comparison.
const LEGACY = process.env.LEGACY === '1';

function lineBreak(ed) {
  if (LEGACY) {
    ed.press('Enter');
    ed.press('Home');
    ed.press('End', true);
    ed.press('Delete');
    return;
  }
  ed.press('End', true);   // consume auto-inserted closer
  ed.press('Enter');
  ed.press('Home');
  ed.press('End', true);   // select auto-indent; next line types over it
}

function typeLinesHumanized(ed, lines) {
  for (let li = 0; li < lines.length; li++) {
    ed.typeString(lines[li]);
    if (li < lines.length - 1) lineBreak(ed);
  }
  if (!LEGACY) {
    // autoTypeConsumeTrailingResidue — Shift+End, throwaway char, Backspace.
    // Removes an auto-closer left by a FINAL line ending in an opener,
    // and is byte-identical when there is nothing parked.
    ed.press('End', true);
    ed.type(' ');
    ed.press('Backspace');
  }
}

// Execution order.
//   LEGACY  : bottom-to-top, which keeps line numbers valid for free.
//   current : reading order (top-to-bottom) with an exact running line
//             shift, so the first problem is fixed first.
// The two MUST produce the same document — that is what --order asserts.
function executeMultiOpPlan(ed, operations) {
  const ops = LEGACY
    ? [...operations].sort((a, b) => b.start_line - a.start_line)
    : [...operations].sort((a, b) => a.start_line - b.start_line);
  let lineShift = 0;
  let caretLine = null;
  for (const op of ops) {
    const s = Math.max(1, (op.start_line | 0) + (LEGACY ? 0 : lineShift));
    const e = Math.max(s, (op.end_line | 0) + (LEGACY ? 0 : lineShift));
    const origSpan = Math.max(1, (op.end_line | 0) - (op.start_line | 0) + 1);
    const goTo = (line) => {
      // autoTypeGoToLine: walk from the current caret when we know it and
      // the distance is plausible; otherwise absolute re-anchor.
      if (!LEGACY && Number.isInteger(caretLine) && Math.abs(line - caretLine) <= 40) {
        const d = line - caretLine;
        for (let i = 0; i < Math.abs(d); i++) ed.press(d > 0 ? 'Down' : 'Up');
        ed.press('End'); ed.press('Home'); ed.press('Home');
      } else {
        navigateToDocLine(ed, line);
      }
    };
    if (op.op === 'insert') {
      goTo(s);
      ed.press('End');
      ed.press('Enter');
      ed.press('Home');
      ed.press('End', true);          // select auto-indent, type over it
      if (LEGACY) ed.press('Delete');
      const lines = String(op.text || '').split('\n');
      typeLinesHumanized(ed, lines);
      caretLine = s + lines.length;
      lineShift += lines.length;
      continue;
    }
    goTo(s);
    selectLineRangeContent(ed, s, e);
    ed.press('Delete');
    if (op.op === 'delete') {
      ed.press('Delete');
      caretLine = s;
      lineShift -= origSpan;
      continue;
    }
    const lines = String(op.text || '').split('\n');
    typeLinesHumanized(ed, lines);
    caretLine = s + lines.length - 1;
    lineShift += lines.length - origSpan;
  }
  return ed.text;
}

// ── Reporting helpers ──
const stripWs = s => String(s || '').replace(/\s+/g, '');
function coverage(target, actual) {
  const blob = stripWs(actual);
  const lines = String(target).split('\n').map(stripWs).filter(x => x.length >= 8);
  const hit = lines.filter(l => blob.includes(l)).length;
  return { hit, total: lines.length, pct: lines.length ? Math.round(100 * hit / lines.length) : 100 };
}
function braceCount(s) {
  const t = String(s || '');
  return { open: (t.match(/\{/g) || []).length, close: (t.match(/\}/g) || []).length };
}

export { Editor, executeMultiOpPlan, typeLinesHumanized, coverage, braceCount };

// ─────────────────────────── CLI ───────────────────────────
if (process.argv[1] && process.argv[1].endsWith('sim-autotype-keystrokes.mjs')) {
  const mode = process.argv[2] || '--validate';

  if (mode === '--validate') {
    // Replay recorded production runs and compare with what the app read
    // back from the real editor. Only runs with a trustworthy UIA after-read
    // can be scored (browser editors return a placeholder or a partial slice).
    const file = path.join(ROOT, '.autotype-plans.jsonl');
    const runs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const PH = /not accessible at this time|screen reader optimized/i;
    console.log('Replaying recorded runs through the simulator (Monaco-style editor model)\n');
    console.log('run  lang    ops                         simulated result            matches recorded end-state?');
    for (const [i, o] of runs.entries()) {
      if (!Array.isArray(o.operations) || !o.operations.length) continue;
      if (!o.beforeText || o.afterText === undefined) continue;
      if (PH.test(o.beforeText) || PH.test(o.afterText)) continue;
      if (o.aborted) continue;
      const ed = new Editor(o.beforeText);
      let out = '';
      try { out = executeMultiOpPlan(ed, o.operations); } catch (e) { out = 'SIM ERROR: ' + e.message; }
      const cov = coverage(o.intendedCode || '', out);
      const b = braceCount(out);
      const bIn = braceCount(o.intendedCode || '');
      const opSum = o.operations.map(x => `${x.op[0]}${x.start_line}-${x.end_line}`).join(',');
      // Agreement test: does the simulation reproduce the same VERDICT the
      // real editor produced (code landed vs did not)?
      const realCov = coverage(o.intendedCode || '', o.afterText);
      const agree = (cov.pct >= 80) === (realCov.pct >= 80);
      console.log(
        `#${String(i).padStart(2)}  ${String(o.language || '?').padEnd(7)} ${opSum.padEnd(27)} ` +
        `cov=${String(cov.pct + '%').padEnd(5)} braces ${b.open}/${b.close} (want ${bIn.open}/${bIn.close})  ` +
        `${agree ? 'YES' : 'no '}  (real cov=${realCov.pct}%)`
      );
    }
    console.log('\nA reproduced verdict means the editor model is behaving like the real editor did.');
  }

  if (mode === '--selftest') {
    // Sanity-check the editor MODEL before trusting any conclusion drawn
    // from it. Each case is behaviour a real editor is known to have.
    let pass = 0, fail = 0;
    const t = (name, got, want) => {
      const ok = got === want;
      ok ? pass++ : fail++;
      console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`}`);
    };
    let ed = new Editor('', { autoClose: false, autoIndent: false });
    ed.typeString('abc'); t('typing inserts', ed.text, 'abc');

    ed = new Editor('one\ntwo', { autoClose: false, autoIndent: false });
    navigateToDocLine(ed, 1); selectLineRangeContent(ed, 1, 1); ed.press('Delete');
    t('select line + Delete clears it', ed.text, '\ntwo');

    ed = new Editor('ab', { autoClose: false, autoIndent: false });
    ed.press('Home'); ed.press('Down'); ed.c = 1; ed.press('Enter');
    t('Enter splits the line', ed.text, 'a\nb');

    ed = new Editor('', { autoClose: true });
    ed.type('('); t('auto-close inserts the pair', ed.text, '()');
    ed.type(')'); t('overtype steps past the closer', ed.text + '|' + ed.c, '()|2');

    ed = new Editor('\nnext', { autoClose: false, autoIndent: false });
    ed.press('Home'); ed.press('Delete');
    t('Delete on an empty line merges the next line up', ed.text, 'next');

    // The strongest check: typing a whole document into a PLAIN editor must
    // reproduce it byte-for-byte. If this fails, the engine's key sequence
    // is wrong independently of any editor smartness.
    const doc = ['def f(x):', '    if x:', '        return 1', '    return 0'].join('\n');
    ed = new Editor('', { autoClose: false, autoIndent: false });
    typeLinesHumanized(ed, doc.split('\n'));
    t('typeLinesHumanized reproduces a document in a plain editor', ed.text, doc);

    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  if (mode === '--order') {
    // Differential test: reading-order + line-shift accounting must land
    // the SAME document as bottom-to-top, which needs no accounting at all.
    // Randomised over op-type combinations, since the shift arithmetic
    // differs per op kind and that is exactly where it could be wrong.
    //
    // Run in a child process per ordering because LEGACY is read once at
    // module load. Here we re-implement both orderings inline instead.
    const applyPlain = (before, operations, order) => {
      // Pure text application of the SAME semantics, independent of the
      // keystroke layer, so a keystroke bug can't mask an ordering bug.
      let lines = before.split('\n');
      const ops = order === 'desc'
        ? [...operations].sort((a, b) => b.start_line - a.start_line)
        : [...operations].sort((a, b) => a.start_line - b.start_line);
      let shift = 0;
      for (const op of ops) {
        const s = (op.start_line | 0) + (order === 'desc' ? 0 : shift);
        const e = (op.end_line | 0) + (order === 'desc' ? 0 : shift);
        const span = (op.end_line | 0) - (op.start_line | 0) + 1;
        if (op.op === 'insert') {
          const t = String(op.text || '').split('\n');
          lines.splice(s, 0, ...t);
          shift += t.length;
        } else if (op.op === 'delete') {
          lines.splice(s - 1, span);
          shift -= span;
        } else {
          const t = String(op.text || '').split('\n');
          lines.splice(s - 1, span, ...t);
          shift += t.length - span;
        }
      }
      return lines.join('\n');
    };

    // Deterministic pseudo-random so failures are reproducible.
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    let pass = 0, fail = 0;
    for (let trial = 0; trial < 400; trial++) {
      const nLines = 12 + rnd(20);
      const before = Array.from({ length: nLines }, (_, i) => (rnd(3) === 0 ? '' : `    line_${i + 1}();`)).join('\n');
      // Non-overlapping ops in ascending order, as the validator guarantees.
      const operations = [];
      let cursor = 1 + rnd(3);
      const nOps = 2 + rnd(3);
      for (let k = 0; k < nOps && cursor <= nLines - 2; k++) {
        const kind = ['replace', 'delete', 'insert'][rnd(3)];
        const span = 1 + rnd(2);
        const end = Math.min(nLines - 1, cursor + span - 1);
        const tLines = 1 + rnd(4);
        operations.push({
          op: kind,
          start_line: cursor,
          end_line: kind === 'insert' ? cursor : end,
          text: kind === 'delete' ? '' : Array.from({ length: tLines }, (_, j) => `    new_${k}_${j}();`).join('\n'),
        });
        cursor = end + 2 + rnd(3);
      }
      if (operations.length < 2) continue;
      const desc = applyPlain(before, operations, 'desc');
      const asc = applyPlain(before, operations, 'asc');
      if (desc === asc) pass++;
      else {
        fail++;
        if (fail === 1) {
          console.log('MISMATCH on trial', trial);
          console.log('ops:', JSON.stringify(operations, null, 1));
          console.log('--- bottom-to-top ---\n' + desc);
          console.log('--- reading order  ---\n' + asc);
        }
      }
    }
    console.log(`  ${pass}/${pass + fail} randomised multi-op plans: reading order == bottom-to-top`);
    process.exit(fail ? 1 : 0);
  }

  if (mode === '--scenarios') {
    // Realistic interview uploads. PASS = the editor ends EXACTLY as it
    // would if a human had typed the solution into the stub by hand.
    // Run with LEGACY=1 to see the pre-fix behaviour.
    const S = [
      { n: 'Python — body only, all lines indented', s: 3, e: 4,
        before: ['import sys', '', 'def twoSum(nums, target):', '    pass', '', 'if __name__ == "__main__":', '    print(twoSum([2,7],9))'],
        code:   ['def twoSum(nums, target):', '    seen = {}', '    for i, n in enumerate(nums):', '        if target - n in seen:', '            return [seen[target-n], i]', '        seen[n] = i', '    return []'] },
      { n: 'Python — imports + blank lines (column 0)', s: 3, e: 4,
        before: ['# solve below', '', 'def f():', '    pass', '', 'print(f())'],
        code:   ['import sys', 'from collections import Counter', '', 'def f():', '    c = Counter(sys.stdin.read().split())', '', '    return c.most_common(1)'] },
      { n: 'Java — HackerRank stub, nested blocks', s: 6, e: 6,
        before: ['import java.io.*;', 'import java.util.*;', '', 'public class Solution {', '    public static void main(String[] args) {', '        /* Enter your code here. */', '    }', '}'],
        code:   ['        Scanner sc = new Scanner(System.in);', '        int n = sc.nextInt();', '        int[] a = new int[n];', '        for (int i = 0; i < n; i++) {', '            a[i] = sc.nextInt();', '        }', '        Arrays.sort(a);', '        System.out.println(a[n-1]);'] },
      { n: 'JavaScript — CoderPad, function + loop', s: 2, e: 3,
        before: ['// Implement below', 'function solve(arr) {', '}', '', 'console.log(solve([1,2,3]));'],
        code:   ['function solve(arr) {', '  let best = -Infinity;', '  for (const x of arr) {', '    best = Math.max(best, x);', '  }', '  return best;', '}'] },
      { n: 'Python — dict/list literals and strings', s: 2, e: 2,
        before: ['import json', 'def parse(s):', '    pass'],
        code:   ['def parse(s):', '    d = {"a": [1, 2], "b": (3, 4)}', '    return json.dumps(d, indent=2)'] },
      { n: 'C++ — nested braces + includes', s: 4, e: 4,
        before: ['#include <bits/stdc++.h>', 'using namespace std;', 'int main() {', '    // code here', '    return 0;', '}'],
        code:   ['    int n; cin >> n;', '    vector<int> v(n);', '    for (int i = 0; i < n; i++) {', '        cin >> v[i];', '    }', '    sort(v.begin(), v.end());'] },
    ];
    let pass = 0, fail = 0;
    console.log(`Realistic scenarios — Monaco-style editor${LEGACY ? '   [LEGACY: pre-fix sequence]' : ''}\n`);
    for (const c of S) {
      const ed = new Editor(c.before.join('\n'), { autoClose: true, autoIndent: true });
      const out = executeMultiOpPlan(ed, [{ op: 'replace', start_line: c.s, end_line: c.e, text: c.code.join('\n') }]);
      const want = [...c.before.slice(0, c.s - 1), ...c.code, ...c.before.slice(c.e)].join('\n');
      const ok = out === want;
      ok ? pass++ : fail++;
      const b = braceCount(out), bw = braceCount(want);
      console.log(`  ${ok ? '✅' : '❌'} ${c.n.padEnd(44)} braces ${b.open}/${b.close} (want ${bw.open}/${bw.close})`);
      if (!ok) {
        const ol = out.split('\n'), wl = want.split('\n');
        for (let i = 0; i < Math.max(ol.length, wl.length); i++) {
          if (ol[i] !== wl[i]) console.log(`        L${i + 1}  got ${JSON.stringify(ol[i])}\n            want ${JSON.stringify(wl[i])}`);
        }
      }
    }
    console.log(`\n  ${pass}/${pass + fail} scenarios produce a byte-exact editor`);
    process.exit(fail ? 1 : 0);
  }

  if (mode === '--isolate') {
    // Which editor behaviour actually breaks it? Same op, four editors.
    const before = [
      'import java.io.*;',
      'import java.util.*;',
      '',
      'public class Solution {',
      '',
      '    public static void main(String[] args) {',
      '        /* Enter your code here. */',
      '    }',
      '}',
    ].join('\n');
    const code = [
      '        Scanner sc = new Scanner(System.in);',
      '        int t = sc.nextInt();',
      '        for (int i = 0; i < t; i++) {',
      '            String s = sc.next();',
      '            System.out.println(s);',
      '        }',
    ].join('\n');
    const ops = [{ op: 'replace', start_line: 7, end_line: 7, text: code }];
    const configs = [
      ['plain textarea      (no autoClose, no autoIndent)', { autoClose: false, autoIndent: false }],
      ['autoIndent only     (no autoClose)               ', { autoClose: false, autoIndent: true }],
      ['autoClose only      (no autoIndent)              ', { autoClose: true, autoIndent: false }],
      ['Monaco / HackerRank (autoClose + autoIndent)     ', { autoClose: true, autoIndent: true }],
    ];
    for (const [label, cfg] of configs) {
      const ed = new Editor(before, cfg);
      const out = executeMultiOpPlan(ed, ops);
      const cov = coverage(code, out);
      const b = braceCount(out);
      console.log(`\n═══ ${label} → coverage ${cov.pct}%  braces ${b.open}open/${b.close}close ═══`);
      console.log(out.split('\n').map((l, n) => String(n + 1).padStart(3) + ' | ' + l).join('\n'));
    }
  }
}
