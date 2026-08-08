// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE GUARD ON THE CARET JUMP
//
//  Auto-Type reaches a line by pressing Ctrl+G and typing the number.
//  That is only safe because it first reads WHAT OPENED: if the chord is
//  unbound, or a browser claims it, the digits would be typed into the
//  candidate's code mid-interview.
//
//  So the predicate that decides "this is a line prompt" is the whole
//  safety boundary, and it is pinned here against element names captured
//  from real windows rather than imagined ones.
//
//  Mirrors GOTO_LINE_PROMPT / GOTO_LINE_RANGE in electron/main.cjs —
//  main.cjs is an Electron entry point and cannot be imported here.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIN = path.resolve(process.cwd(), '..', 'electron', 'main.cjs');
const src = fs.readFileSync(MAIN, 'utf8');

// Read the real patterns out of the engine, so editing them there is what
// this test actually watches.
function literal(name) {
  const m = new RegExp(`const ${name} = (/.*/[gimsuy]*);`).exec(src);
  expect(m, `${name} not found in electron/main.cjs`).toBeTruthy();
  // eslint-disable-next-line no-eval -- one regex literal from our own file
  return eval(m[1]);
}

describe('recognising a go-to-line prompt', () => {
  const PROMPT = literal('GOTO_LINE_PROMPT');
  const RANGE = literal('GOTO_LINE_RANGE');

  it('accepts the prompt VS Code actually shows', () => {
    // Captured live from VS Code 1.x after Ctrl+G.
    expect(PROMPT.test('Type a line number to go to (from 1 to 41).')).toBe(true);
  });

  it('accepts other editors that name the command', () => {
    for (const n of ['Go to Line', 'Go To Line/Column', 'goto line']) {
      expect(PROMPT.test(n), n).toBe(true);
    }
  });

  it('refuses the editor itself', () => {
    // All captured from real focused elements. If any of these matched,
    // the engine would type digits into open code.
    const notPrompts = [
      'gotoline_probe.py',           // run-together: an identifier, not a sentence
      'goto_line.py',
      'src/utils/gotoLine.ts',
      'autotype_probe_fixed.java',
      'The editor is not accessible at this time. To enable screen reader optimized mode, use Shift+Alt+F1',
      '',
      'Solution.java - Visual Studio Code',
    ];
    for (const n of notPrompts) expect(PROMPT.test(n), n).toBe(false);
  });

  it('refuses an editor that merely mentions line numbers', () => {
    // The reason the pattern does not match a bare "line number": an
    // accessible name can say this and still be the document.
    for (const n of [
      'Editor content, line numbers enabled',
      'source code editor, 1 line number gutter',
      'Show line numbers',
    ]) {
      expect(PROMPT.test(n), n).toBe(false);
    }
  });

  it('refuses a browser find bar', () => {
    // The specific thing that would happen if Ctrl+G were claimed by the
    // browser instead of the editor.
    for (const n of ['Find', 'Find in page', 'Search the web and your history']) {
      expect(PROMPT.test(n), n).toBe(false);
    }
  });

  it('reads the document length out of the prompt', () => {
    // Free ground truth about a document UIA will not show us — used to
    // refuse a jump aimed past the end of the file.
    expect(Number(RANGE.exec('Type a line number to go to (from 1 to 41).')[1])).toBe(41);
    expect(Number(RANGE.exec('Type a line number to go to (from 1 to 2148).')[1])).toBe(2148);
    expect(RANGE.exec('Go to Line')).toBeNull();     // no range offered — jump still allowed
  });
});

describe('the jump is wired into the navigator', () => {
  it('is tried before the walk, and only when it beats walking', () => {
    // A fixed ~1.2s prompt is not worth it for a three-line hop; the two
    // costs cross near line 13.
    expect(src).toMatch(/if \(target >= GOTO_LINE_WORTH_IT && await autoTypeJumpToLine\(target, ctx\)\)/);
    const m = /const GOTO_LINE_WORTH_IT = (\d+);/.exec(src);
    expect(m, 'GOTO_LINE_WORTH_IT not found').toBeTruthy();
    // Sanity rails, not a pin: low enough that a real crawl never happens,
    // high enough that shallow hops are not made slower.
    expect(Number(m[1])).toBeGreaterThan(1);
    expect(Number(m[1])).toBeLessThanOrEqual(25);
  });

  it('retries the read once before giving up on an editor', () => {
    // A single slow frame must not permanently disable the jump.
    const fn = /async function autoTypeJumpToLine[\s\S]*?\n}/.exec(src)[0];
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
  });

  it('refuses a second time in an editor that already declined', () => {
    expect(src).toMatch(/_gotoLineUnsupported\.add\(who\)/);
    expect(src).toMatch(/if \(_gotoLineUnsupported\.has\(who\)\) return false/);
  });

  it('escapes without typing when the prompt is not recognised', () => {
    // The ordering that matters: Escape happens on the refusal path,
    // before any digit is sent.
    const fn = /async function autoTypeJumpToLine[\s\S]*?\n}/.exec(src)[0];
    const refusal = fn.indexOf('_gotoLineUnsupported.add(who)');
    const firstDigitTyped = fn.indexOf('typeCharHumanly');
    expect(refusal).toBeGreaterThan(-1);
    expect(firstDigitTyped).toBeGreaterThan(refusal);
  });
});
