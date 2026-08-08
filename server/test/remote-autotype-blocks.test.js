// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "TYPE THE SECOND BLOCK" HAS TO MEAN THE SAME THING ON BOTH SIDES.
//
//  The phone sends an INDEX, not code. The desktop resolves that index
//  against its own parse of the answer and types whatever it finds. If
//  the two parsers disagree about what counts as a fenced block — by one
//  — the phone says "type the solution" and the computer types the
//  example above it, into a live coding interview, at human speed.
//
//  There is no runtime signal for that failure. It just types the wrong
//  thing. So the agreement is asserted here, against the phone's actual
//  regex, read from its actual source file.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { extractCodeBlocks, registerAutoTypeBlock, runAutoTypeForCode, autoTypeBlockCount } =
  await import('../../services/remoteBridge.ts');

const ANSWERS = [
  // the ordinary case
  'Here is the idea:\n\n```python\ndef a():\n    return 1\n```\n\nAnd the fix:\n\n```python\ndef b():\n    return 2\n```\n',
  // prose only
  'No code here at all, just an explanation of the tradeoff.',
  // a language-less fence, and one with extra info after the language
  '```\nplain\n```\ntext\n```js title=x\nconst a = 1;\n```',
  // adjacent fences with no prose between them
  '```java\nclass A {}\n```\n```java\nclass B {}\n```',
  // an unterminated fence — the answer is still streaming
  'Working on it:\n\n```python\ndef partial():\n',
  // fence markers inside a string, which must not be treated as fences
  '```js\nconst s = "``` not a fence";\n```',
  // a blank block
  '```\n```',
];

describe('the phone and the desktop count code blocks identically', () => {
  const CANDIDATES = [
    path.resolve(process.cwd(), '../../interview-copilot-mobile/src/components/AnswerBody.tsx'),
    path.join(os.homedir(), 'interview-copilot-mobile', 'src', 'components', 'AnswerBody.tsx'),
  ];
  const phonePath = CANDIDATES.find(p => fs.existsSync(p));

  if (!phonePath) {
    it.skip('phone app not checked out beside this repo', () => {});
  } else {
    // Read the phone's regex out of its source rather than restating it,
    // so editing the phone's parser is what this test actually watches.
    const src = fs.readFileSync(phonePath, 'utf8');
    const m = /const FENCE = (\/.*\/[gimsuy]*);/.exec(src);

    it('finds the phone parser', () => {
      expect(m, 'FENCE regex not found in AnswerBody.tsx').toBeTruthy();
    });

    it('agrees on every block, in every shape of answer', () => {
      // eslint-disable-next-line no-eval -- reading one regex literal out
      // of a file we control; the alternative is a second copy that can
      // drift, which is the exact thing under test.
      const phoneRe = eval(m[1]);
      for (const answer of ANSWERS) {
        const desktop = extractCodeBlocks(answer);
        const phone = [];
        phoneRe.lastIndex = 0;
        let hit;
        while ((hit = phoneRe.exec(answer)) !== null) phone.push(hit[2].replace(/\n$/, ''));
        expect(phone, `disagreement on:\n${answer}`).toEqual(desktop);
      }
    });
  }
});

describe('resolving an index to a runnable block', () => {
  it('numbers blocks in reading order', () => {
    const blocks = extractCodeBlocks(ANSWERS[0]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('def a():\n    return 1');
    expect(blocks[1]).toBe('def b():\n    return 2');
  });

  it('ignores a fence that has not closed yet', () => {
    // Mid-stream, the desktop cannot type an answer that isn't finished
    // — and the phone deliberately shows no button for it either.
    expect(extractCodeBlocks(ANSWERS[4])).toEqual([]);
  });

  it('runs the block the desktop actually has mounted', () => {
    let ran = 0;
    const code = 'def a():\n    return 1';
    const off = registerAutoTypeBlock(code, () => { ran++; });
    expect(autoTypeBlockCount()).toBeGreaterThan(0);

    expect(runAutoTypeForCode(code)).toEqual({ ok: true });
    expect(ran).toBe(1);

    off();
    // Scrolled away / new conversation: refuse rather than type
    // something else.
    expect(runAutoTypeForCode(code)).toEqual({ ok: false, reason: 'block_not_on_screen' });
  });

  it('a stale unregister cannot unmount the live block', () => {
    // React can mount the replacement before unmounting the original. If
    // the outgoing cleanup deleted by key alone it would take the new
    // block's runner with it, and Auto-Type would go dead for exactly
    // the block the user is looking at.
    const code = 'shared-code';
    const offOld = registerAutoTypeBlock(code, () => {});
    let newRan = 0;
    registerAutoTypeBlock(code, () => { newRan++; });
    offOld();
    expect(runAutoTypeForCode(code)).toEqual({ ok: true });
    expect(newRan).toBe(1);
  });
});
