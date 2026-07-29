// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  extractCurrentQuestion + auto reasoning depth — pin the contract
//
//  The renderer wraps the live transcript in a large RESPONSE RULES
//  block before it reaches the AI routes. Classification (auto
//  reasoning_effort, Gemini thinking level) and fresh-context retrieval
//  must run on the RAW question, not the wrapper — the rules block
//  contains example phrases ("tell me about a time...") that would
//  misclassify every call, and the Brave cache key must match what
//  /prefetch-context stored. These tests pin:
//    1. extraction for every prompt shape the renderer produces
//    2. array-content support in lastUserMessage (the final user turn
//       is multimodal; the string-only version read the PREVIOUS turn)
//    3. the depth-adaptive auto-effort policy (deep→low, shallow→none,
//       tier gate forcing non-Max to none)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractCurrentQuestion,
  lastUserMessage,
  resolveReasoningEffort,
  AUTO_EFFORT_BY_CATEGORY,
  DEEP_CATEGORIES,
} = require('../src/routes/ai.js')._test;

// Realistic miniature of buildUserRulesBlock() — includes the example
// phrases that used to poison classification.
const RULES = `<<<RESPONSE RULES — FOLLOW EXACTLY>>>
Ex 2 — BEHAVIORAL: Q: "Tell me about a time you debugged a tricky production issue."
Sometimes the block covers "what's new in Python 3.13" or "AWS Glue dashboard tabs".
<<<END RESPONSE RULES>>>

---

`;

describe('extractCurrentQuestion — prompt shapes', () => {
  it('openai shape: rules terminator + question + KB hint + Remember tail', () => {
    const composed = `${RULES}How would you design a rate limiter that supports per-user quotas?\n\n[Remember: draw from the Knowledge Base where relevant.]\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
    expect(extractCurrentQuestion(composed))
      .toBe('How would you design a rate limiter that supports per-user quotas?');
  });

  it('gemini/xai/groq/claude shape: history + Current Audio marker + Task tail', () => {
    const composed = `${RULES}Interviewer (Transcript): what is a hashmap?\nCandidate (You): It's a key-value store...\n\nInterviewer (Current Audio): implement a function that reverses a singly linked list\n\n[Anchor this answer in ONE specific memory from WHO YOU ARE.]\n\nTask:\n- If this is the Interviewer asking a question, provide the Candidate's response.`;
    expect(extractCurrentQuestion(composed))
      .toBe('implement a function that reverses a singly linked list');
  });

  it('plain text (auto-solve / internal callers) passes through unchanged', () => {
    expect(extractCurrentQuestion('What is a hashmap?')).toBe('What is a hashmap?');
    expect(extractCurrentQuestion('')).toBe('');
  });

  it('rules-only text no longer classifies as the rules examples', () => {
    // Without extraction, the composed prompt matched the behavioral
    // example inside the rules block. After extraction the live question
    // wins.
    const composed = `${RULES}what is the time complexity of quicksort?\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`;
    const q = extractCurrentQuestion(composed);
    expect(q).toBe('what is the time complexity of quicksort?');
    expect(q).not.toContain('Tell me about a time');
  });
});

describe('lastUserMessage — multimodal final turn', () => {
  it('reads the text parts of an array-shaped final user message', () => {
    const messages = [
      { role: 'user', content: 'previous raw question' },
      { role: 'assistant', content: 'previous answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${RULES}current question` },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ],
      },
    ];
    // The string-only implementation returned 'previous raw question'.
    expect(lastUserMessage(messages)).toContain('current question');
    expect(extractCurrentQuestion(lastUserMessage(messages))).toBe('current question');
  });

  it('still reads plain-string user messages', () => {
    expect(lastUserMessage([{ role: 'user', content: 'plain' }])).toBe('plain');
  });
});

describe('auto reasoning depth — policy pins', () => {
  const mkReq = (tier, effort, question) => ({
    body: { reasoning_effort: effort, messages: [{ role: 'user', content: question }] },
    license: { tier },
    user: { email: 'someone@example.com' },
  });

  it('map: deep analytical shapes are low, conversational shapes are none', () => {
    expect(AUTO_EFFORT_BY_CATEGORY).toEqual({
      coding: 'low',
      system_design: 'low',
      ml_data: 'low',
      quantitative: 'low',
      strategy_case: 'low',
      behavioral: 'none',
      concept: 'none',
      clarifier: 'none',
      other: 'none',
    });
    expect([...DEEP_CATEGORIES].sort()).toEqual(
      ['coding', 'ml_data', 'quantitative', 'strategy_case', 'system_design']);
  });

  it('max tier + auto + deep question → low', () => {
    const req = mkReq('max', 'auto',
      `${RULES}How would you design a rate limiter that supports per-user quotas?\n\nRemember: the RESPONSE RULES above are the highest-priority instructions. Obey them literally.`);
    expect(resolveReasoningEffort(req)).toBe('low');
  });

  it('max tier + auto + shallow question → none', () => {
    const req = mkReq('max', 'auto', `${RULES}tell me about yourself\n\nRemember: obey.`);
    expect(resolveReasoningEffort(req)).toBe('none');
  });

  it('basic tier + auto + deep question → forced none (tier gate)', () => {
    const req = mkReq('basic', 'auto',
      `${RULES}How would you design a rate limiter that supports per-user quotas?\n\nRemember: obey.`);
    expect(resolveReasoningEffort(req)).toBe('none');
  });

  it('explicit picks are honored (max) and gated (basic)', () => {
    expect(resolveReasoningEffort(mkReq('max', 'high', 'anything'))).toBe('high');
    expect(resolveReasoningEffort(mkReq('basic', 'high', 'anything'))).toBe('none');
    expect(resolveReasoningEffort(mkReq('max', 'none', 'How would you design a rate limiter?'))).toBe('none');
  });

  it('medium/high are never values in the auto map', () => {
    expect(Object.values(AUTO_EFFORT_BY_CATEGORY)).not.toContain('medium');
    expect(Object.values(AUTO_EFFORT_BY_CATEGORY)).not.toContain('high');
  });
});
