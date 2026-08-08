// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Fresh-context injection — pin the cache-preserving contract
//
//  FRESH_CONTEXT must ride with the final user message, never touch the
//  system prompt. Every provider keys its prompt cache on a byte-stable
//  prefix (OpenAI automatic, Gemini implicit, xAI cached-input,
//  Anthropic cache_control) — the old prepend-to-system behavior forced
//  a full re-prefill of the multi-thousand-token KNOWLEDGE BASE on
//  every fresh-context flip, which was the dominant per-question
//  latency with large uploaded files. These tests pin:
//    1. the system message is BYTE-IDENTICAL with and without fresh
//       context (the cache guarantee)
//    2. the block lands at the end of the last user message, for both
//       string and multimodal-array content shapes
//    3. no-fresh passes the original array through untouched
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { appendFreshToPrompt, appendFreshToMessages } = require('../src/routes/ai.js')._test;

const FRESH = '<FRESH_CONTEXT>\nToday\'s snapshot.\n</FRESH_CONTEXT>';
const SYSTEM = 'You are the candidate. KNOWLEDGE BASE: <huge stable blob>';

describe('appendFreshToPrompt', () => {
  it('appends after the prompt text', () => {
    expect(appendFreshToPrompt('the question', FRESH)).toBe(`the question\n\n${FRESH}`);
  });
  it('no fresh → prompt unchanged', () => {
    expect(appendFreshToPrompt('the question', null)).toBe('the question');
    expect(appendFreshToPrompt('the question', undefined)).toBe('the question');
  });
});

describe('appendFreshToMessages — cache guarantee', () => {
  it('system message stays byte-identical with and without fresh context', () => {
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const withFresh = appendFreshToMessages(messages, FRESH);
    const without = appendFreshToMessages(messages, null);
    expect(withFresh[0].content).toBe(SYSTEM);
    expect(without[0].content).toBe(SYSTEM);
    // History prefix untouched too — only the final user turn changes.
    expect(withFresh[1]).toEqual(messages[1]);
    expect(withFresh[2]).toEqual(messages[2]);
  });

  it('string-content final user turn gets the block appended', () => {
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'q2' },
    ];
    const out = appendFreshToMessages(messages, FRESH);
    expect(out[1].content).toBe(`q2\n\n${FRESH}`);
    // Original array not mutated.
    expect(messages[1].content).toBe('q2');
  });

  it('multimodal final user turn gets an extra text part after the images', () => {
    const messages = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q2' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ],
      },
    ];
    const out = appendFreshToMessages(messages, FRESH);
    expect(out[1].content).toHaveLength(3);
    expect(out[1].content[2]).toEqual({ type: 'text', text: FRESH });
    // Original parts untouched.
    expect(messages[1].content).toHaveLength(2);
  });

  it('no fresh context → the exact same array reference passes through', () => {
    const messages = [{ role: 'user', content: 'q' }];
    expect(appendFreshToMessages(messages, null)).toBe(messages);
    expect(appendFreshToMessages(messages, '')).toBe(messages);
  });
});
