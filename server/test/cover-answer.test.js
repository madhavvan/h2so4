// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Cover-answer engine — pin the instant-opener contract
//
//  The cover is the "no dead air" guarantee for reasoning-depth
//  questions: stream a 12-30-word spoken opener from the fastest model
//  BEFORE the main call, then hand the opener to the main model with a
//  continuation instruction. These tests pin:
//    1. tokens stream through onToken and the full text is returned
//    2. every failure mode (no key, upstream error, slow first token,
//       outer abort) degrades to '' — the cover can never break a route
//    3. the continuation instruction carries the cover verbatim with
//       the no-repeat contract
//    4. appendTextToLastUserMessage never touches the system prompt
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { streamCoverAnswer, buildCoverContinuation } = require('../src/services/coverAnswer.js');
const { appendTextToLastUserMessage } = require('../src/routes/ai.js')._test;

const okStream = (tokens) => async function* () { for (const t of tokens) yield { text: t }; }();

describe('streamCoverAnswer — happy path', () => {
  it('streams tokens through onToken and returns the joined text', async () => {
    const seen = [];
    const text = await streamCoverAnswer({
      question: 'How would you design a rate limiter?',
      category: 'system_design',
      geminiKey: 'test-key',
      onToken: (t) => seen.push(t),
      _streamFn: async () => okStream(["So the way I'd approach that — ", 'token bucket per user, Redis-backed.']),
    });
    expect(text).toBe("So the way I'd approach that — token bucket per user, Redis-backed.");
    expect(seen.join('')).toContain('token bucket');
  });
});

describe('streamCoverAnswer — failure modes all degrade to ""', () => {
  it('no key and no injected stream → empty', async () => {
    expect(await streamCoverAnswer({ question: 'q', onToken: () => {} })).toBe('');
  });

  it('missing onToken → empty', async () => {
    expect(await streamCoverAnswer({ question: 'q', geminiKey: 'k' })).toBe('');
  });

  it('upstream throw → empty (never rejects)', async () => {
    const text = await streamCoverAnswer({
      question: 'q', geminiKey: 'k', onToken: () => {},
      _streamFn: async () => { throw new Error('upstream down'); },
    });
    expect(text).toBe('');
  });

  it('first token slower than the deadline → aborted, empty', async () => {
    const text = await streamCoverAnswer({
      question: 'q', geminiKey: 'k', onToken: () => {},
      firstTokenDeadlineMs: 30,
      _streamFn: async ({ signal }) => (async function* () {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 300);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        });
        yield { text: 'too late' };
      })(),
    });
    expect(text).toBe('');
  });

  it('already-aborted outer signal → empty without calling upstream', async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    const text = await streamCoverAnswer({
      question: 'q', geminiKey: 'k', onToken: () => {}, signal: ac.signal,
      _streamFn: async () => { called = true; return okStream(['x']); },
    });
    expect(text).toBe('');
    expect(called).toBe(false);
  });
});

describe('buildCoverContinuation', () => {
  it('carries the cover verbatim with the no-repeat continuation contract', () => {
    const block = buildCoverContinuation("First thing I'd look at is the partition key.");
    expect(block).toContain("First thing I'd look at is the partition key.");
    expect(block).toContain('Do not repeat');
    expect(block).toContain('continue');
  });

  it('rides on the last user message and leaves the system prompt byte-identical', () => {
    const SYSTEM = 'huge stable KB';
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'the question' },
    ];
    const out = appendTextToLastUserMessage(messages, buildCoverContinuation('opener.'));
    expect(out[0].content).toBe(SYSTEM);
    expect(out[1].content).toContain('the question');
    expect(out[1].content).toContain('opener.');
  });
});
