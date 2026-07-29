// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE GROQ ROUTE RESERVED THE WHOLE MINUTE AND THEN ASKED FOR MORE
//
//  Measured 2026-07-25 against the key in server/.env: `openai/gpt-oss-120b`
//  on this org has a tokens-per-minute limit of exactly 8,000, and Groq
//  admits a request against TPM using input + max_tokens BEFORE
//  generating anything. Both Groq routes asked for max_tokens: 8,000.
//
//    193-token system prompt  → 413 "Limit 8000, Requested 8239"
//    963-token system prompt  → 413 "Limit 8000, Requested 8839"
//    7,700-token prompt       → 413 "Limit 8000, Requested 14089"
//
//  Not "sometimes, under load" — ALWAYS, by arithmetic, with any prompt
//  at all. Every user who picked the Groq model got "Groq rate-limited —
//  give it a few seconds and try again", forever, for a condition that
//  waiting cannot clear. (The cover kept working the whole time: it runs
//  on llama-3.3-70b, a 12,000 bucket, reserving 90.)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseGroqTpm, callGroqWithinTpm, describeGroqTpmFailure,
  GROQ_BASE_MAX_TOKENS, GROQ_CAP_MAX_TOKENS,
} = require('../src/routes/ai.js')._test;

// The exact error body Groq returned, kept verbatim so a change in their
// wording fails here rather than silently in production.
const tpmError = (limit, requested) => Object.assign(new Error('413 status code'), {
  status: 413,
  error: { error: {
    message: `Request too large for model \`openai/gpt-oss-120b\` in organization \`org_x\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${limit}, Requested ${requested}, please reduce your message size and try again.`,
    type: 'tokens',
    code: 'rate_limit_exceeded',
  } },
});

describe('the reservation can no longer eat the whole bucket', () => {
  it('asks for far less than a plausible TPM limit', () => {
    // 8,000 was picked as "the model's output ceiling", not as "what an
    // interview answer needs". A long STAR answer is ~1,500 tokens.
    expect(GROQ_BASE_MAX_TOKENS).toBeLessThan(8000);
    expect(GROQ_BASE_MAX_TOKENS).toBeGreaterThanOrEqual(2048);
    expect(GROQ_CAP_MAX_TOKENS).toBeGreaterThan(GROQ_BASE_MAX_TOKENS);
  });
});

describe('reading the numbers out of Groq own error', () => {
  it('extracts limit and requested', () => {
    expect(parseGroqTpm(tpmError(8000, 8239))).toMatchObject({ limit: 8000, requested: 8239 });
  });

  it('ignores errors that are not about TPM', () => {
    expect(parseGroqTpm(new Error('connection reset'))).toBeNull();
    expect(parseGroqTpm({ error: { error: { message: 'requests per minute (RPM): Limit 30' } } })).toBeNull();
    expect(parseGroqTpm(null)).toBeNull();
  });
});

describe('one self-healing retry, sized from what Groq counted', () => {
  it('retries with a reservation that actually fits', async () => {
    const calls = [];
    const groq = { chat: { completions: { create: async (p) => {
      calls.push(p.max_tokens);
      // requested = prompt(1200) + max_tokens
      if (1200 + p.max_tokens > 8000) throw tpmError(8000, 1200 + p.max_tokens);
      return { ok: true };
    } } } };

    const res = await callGroqWithinTpm(groq, { model: 'm', messages: [], max_tokens: 8000 });
    expect(res).toEqual({ ok: true });
    expect(calls[0]).toBe(8000);
    // 8000 limit - 1200 prompt - 256 headroom
    expect(calls[1]).toBe(6544);
    expect(1200 + calls[1]).toBeLessThan(8000);
  });

  it('gives up when the PROMPT alone is over the limit — no reservation fits', async () => {
    // This is the real production case: the app's rules block alone is
    // ~7,074 tokens and the whole prompt lands near 9,200, against a
    // bucket of 8,000. There is no max_tokens that rescues it, and
    // retrying forever would just burn the interview.
    let attempts = 0;
    const groq = { chat: { completions: { create: async (p) => {
      attempts++;
      throw tpmError(8000, 9200 + p.max_tokens);
    } } } };
    // It rethrows the ORIGINAL error, so the route's catch can recognise
    // it and produce the honest message rather than a generic 500.
    const err = await callGroqWithinTpm(groq, { model: 'm', messages: [], max_tokens: 4096 })
      .then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(parseGroqTpm(err)).toMatchObject({ limit: 8000 });
    expect(describeGroqTpmFailure(err)).toBeTruthy();
    expect(attempts).toBe(1);   // no pointless second call
  });

  it('passes non-TPM failures straight through, unretried', async () => {
    let attempts = 0;
    const groq = { chat: { completions: { create: async () => { attempts++; throw new Error('upstream 500'); } } } };
    await expect(callGroqWithinTpm(groq, { max_tokens: 4096 })).rejects.toThrow('upstream 500');
    expect(attempts).toBe(1);
  });
});

describe('the message the candidate sees is true', () => {
  it('says waiting will not help, because it will not', () => {
    const d = describeGroqTpmFailure(tpmError(8000, 9200));
    // The old text was "give it a few seconds and try again" — advice
    // that could never work for a limit the prompt structurally exceeds.
    expect(d.userMessage).not.toMatch(/try again|few seconds/i);
    expect(d.userMessage).toMatch(/waiting will not clear it/i);
    expect(d.userMessage).toContain('8,000');
    expect(d.userMessage).toContain('9,200');
    expect(d.userMessage).toMatch(/switch models/i);
  });

  it('returns null for anything else, so the normal 429 path still runs', () => {
    expect(describeGroqTpmFailure(new Error('rate limit'))).toBeNull();
  });
});
