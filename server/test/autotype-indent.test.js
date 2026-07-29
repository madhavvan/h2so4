// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE INDENTATION CHECK
//
//  Both existing post-write checks strip all whitespace before comparing,
//  so a correctly-worded but wrongly-indented answer passed as success.
//  In Python that is a file that does not run, reported as done.
//
//  These tests pin both halves: it must CATCH the breakages, and — more
//  importantly — it must stay quiet on the healthy runs, because a check
//  that cries wolf during a live interview is worse than no check.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compareIndentation, shouldReportIndent } =
  require('../../electron/autoTypeIndent.cjs');

// The real deep-nesting case the live harness types into VS Code.
const INTENDED = [
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
].join('\n');

describe('staying quiet when the run was fine', () => {
  it('passes code typed exactly as intended', () => {
    const r = compareIndentation(INTENDED, `import sys\n\n${INTENDED}\n`);
    expect(r.ok).toBe(true);
    expect(shouldReportIndent(r)).toBe(false);
  });

  it('passes a block the editor placed one level deeper', () => {
    // Whole-block shift: the editor's doing, still valid code, and the
    // relative shape is intact. Alarming here would fire on healthy runs.
    const shifted = INTENDED.split('\n').map(l => '    ' + l).join('\n');
    const r = compareIndentation(INTENDED, shifted);
    expect(r.offset).toBe(4);
    expect(shouldReportIndent(r)).toBe(false);
  });

  it('does not guess when a line appears twice', () => {
    // "continue" shows up twice at different depths. Matching the wrong
    // one would invent a mismatch out of correct code.
    const r = compareIndentation(INTENDED, `import sys\n\n${INTENDED}\n`);
    expect(r.mismatches.every(m => !/^continue$/.test(m.line))).toBe(true);
  });

  it('says nothing when it cannot line anything up', () => {
    const r = compareIndentation(INTENDED, 'totally different file contents');
    expect(r.ok).toBe(true);
    expect(r.compared).toBe(0);
    expect(shouldReportIndent(r)).toBe(false);
  });

  it('ignores short lines, which carry no signal', () => {
    const r = compareIndentation('  x = 1\n  y = 2', 'x = 1\n        y = 2');
    expect(r.compared).toBe(0);
  });
});

describe('catching what would actually break', () => {
  it('catches a body that lost its indentation', () => {
    // The classic: the editor did not auto-indent and our predictor
    // assumed it would, so the body lands at column 0. Python: broken.
    const broken = INTENDED.split('\n')
      .map(l => (l.includes('out.append(n)') ? l.trimStart() : l)).join('\n');
    const r = compareIndentation(INTENDED, broken);
    expect(r.ok).toBe(false);
    expect(r.mismatches.some(m => m.line.includes('out.append(n)'))).toBe(true);
  });

  it('catches tabs where spaces were written, on a single line', () => {
    // A TabError in Python. One line is enough — this is the case where
    // the 2-line threshold is deliberately bypassed.
    const mixed = INTENDED.replace('            n = int(r)', '\t\t\tn = int(r)');
    const r = compareIndentation(INTENDED, mixed);
    expect(r.mismatches.some(m => m.tabMix)).toBe(true);
    expect(shouldReportIndent(r)).toBe(true);
  });

  it('catches the double-indent that whitespace-stripping hides', () => {
    // 16 spaces where 8 were meant — the exact shape of the smart-Home
    // bug recorded in main.cjs. Content identical, so the existing
    // verify calls it present; only this check sees it.
    const doubled = INTENDED.split('\n')
      .map(l => (l.startsWith('        ') && !l.startsWith('            ') ? '        ' + l : l))
      .join('\n');
    const r = compareIndentation(INTENDED, doubled);
    expect(shouldReportIndent(r)).toBe(true);
  });

  it('needs two bad lines before speaking up', () => {
    const one = INTENDED.replace('    out = []', '      out = []');
    expect(shouldReportIndent(compareIndentation(INTENDED, one))).toBe(false);
    const two = one.replace('    return out', '      return out');
    expect(shouldReportIndent(compareIndentation(INTENDED, two))).toBe(true);
  });
});

describe('the gap it was built to close', () => {
  it('the existing whitespace-stripped verify cannot see any of this', () => {
    // Proof the new check is not redundant: strip whitespace and the
    // broken and the correct versions are the same string.
    const broken = INTENDED.split('\n').map(l => l.trimStart()).join('\n');
    const strip = (s) => s.replace(/\s+/g, '');
    expect(strip(broken)).toBe(strip(INTENDED));          // old check: identical
    expect(compareIndentation(INTENDED, broken).ok).toBe(false);  // new check: caught
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE REPAIR'S REFUSALS
//
//  autoTypeFixIndentation retypes whole lines, so the question that
//  matters is not "does it fix things" — the live harness answers that
//  against a real editor — but "does it know when NOT to". Each refusal
//  below prevents it from making correct code worse.
//
//  Mirrors the decision logic in electron/main.cjs; that file is an
//  Electron entry point and cannot be imported here, so the guards are
//  also asserted against its source.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import fs from 'node:fs';
import path from 'node:path';

const MAIN_SRC = fs.readFileSync(
  path.resolve(process.cwd(), '..', 'electron', 'main.cjs'), 'utf8');

describe('the repair knows when to keep its hands off', () => {
  it('refuses when the whole block sits at a different depth', () => {
    // Valid code the editor placed one level in. Retyping ONE line at the
    // written indent would leave it out of step with its neighbours —
    // turning a cosmetic difference into broken code.
    const shifted = INTENDED.split('\n').map(l => '    ' + l).join('\n');
    const r = compareIndentation(INTENDED, shifted);
    expect(r.offset).not.toBe(0);
    expect(MAIN_SRC).toMatch(/if \(result\.offset !== 0\)/);
    expect(MAIN_SRC).toMatch(/reason: 'block_offset'/);
  });

  it('refuses a line it cannot locate unambiguously in the block', () => {
    // Duplicated content means we cannot say WHICH occurrence the editor
    // read was describing, so navigating to one is a guess.
    expect(MAIN_SRC).toMatch(/if \(hits\.length === 1\) targets\.push/);
    expect(MAIN_SRC).toMatch(/reason: 'not_locatable'/);
  });

  it('refuses when too many lines are wrong to be a stray', () => {
    expect(MAIN_SRC).toMatch(/const MAX_INDENT_FIXES = \d+/);
    expect(MAIN_SRC).toMatch(/targets\.length > MAX_INDENT_FIXES/);
    expect(MAIN_SRC).toMatch(/reason: 'too_many'/);
  });

  it('refuses when the editor will not give readable text', () => {
    // VS Code without screen-reader mode hands UIA a placeholder, not the
    // code. Acting on that would retype against a fiction.
    expect(MAIN_SRC).toMatch(/reason: 'no_readable_text'/);
  });

  it('navigates in PLAN coordinates, never editor-read line numbers', () => {
    // The coordinate trap: a UIA line is not a gutter line on browser
    // editors. The target is derived from the plan's own start line.
    expect(MAIN_SRC).toMatch(/const docLine = startLine \+ t\.index;/);
    // And the editor read is used only to pick lines by CONTENT.
    expect(MAIN_SRC).not.toMatch(/startLine \+ .*uia.*[Ll]ine/);
  });

  it('re-reads afterwards instead of assuming it worked', () => {
    const fn = /async function autoTypeFixIndentation[\s\S]*?\n}/.exec(MAIN_SRC)[0];
    const typed = fn.indexOf('typeLinesHumanized');
    const recheck = fn.indexOf('compareIndentation(intended, after.text)');
    expect(typed).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(typed);      // verification comes after the fix
    expect(fn).toMatch(/verified: !!recheck && !stillWrong/);
  });

  it('replaces whole lines rather than counting whitespace characters', () => {
    // Deleting "the first N chars because they should be whitespace" eats
    // code the moment N is off by one.
    const fn = /async function autoTypeFixIndentation[\s\S]*?\n}/.exec(MAIN_SRC)[0];
    expect(fn).toMatch(/selectLineRangeContent\(docLine, docLine, ctx\)/);
    expect(fn).not.toMatch(/Key\.Right/);
  });
});

describe('every path that types code is covered', () => {
  it('all three typing paths run the indent fix', () => {
    // Three places call typeLinesHumanized with a block: insert,
    // whole-document Ctrl+A replace, and ordinary replace. The first two
    // were missed when the fix was first wired, so this pins the count —
    // a fourth typing path added without a fixIndentation call fails here
    // rather than silently shipping unchecked indentation.
    const typed = (MAIN_SRC.match(/await typeLinesHumanized\(lines, ctx\);/g) || []).length;
    const fixed = (MAIN_SRC.match(/await fixIndentation\(lines, /g) || []).length;
    expect(typed).toBe(3);
    expect(fixed).toBe(3);
  });

  it('each path passes its own block start line, from the plan', () => {
    // insert lands one line below its anchor, Ctrl+A replaces from line 1,
    // and an ordinary replace starts where the plan said. Getting any of
    // these wrong would retype the wrong line.
    expect(MAIN_SRC).toMatch(/await fixIndentation\(lines, s \+ 1\);/);   // insert
    expect(MAIN_SRC).toMatch(/await fixIndentation\(lines, 1\);/);        // whole-doc
    expect(MAIN_SRC).toMatch(/await fixIndentation\(lines, s\);/);        // replace
  });

  it('the helper stops immediately if the run was aborted', () => {
    const helper = /const fixIndentation = async[\s\S]*?\n  \};/.exec(MAIN_SRC)[0];
    expect(helper).toMatch(/if \(autoTypeAbort\) return;/);
  });
});
