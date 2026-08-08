// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE ANSWER HAS TO KNOW IT IS IN A CONVERSATION.
//
//  Every rule above these in the block scores ONE answer — shape, length,
//  banned words. None of them could see the defect Venu caught in a real
//  three-turn exchange on 2026-08-07, because the defect only exists
//  BETWEEN answers:
//
//    Q1  "how do you handle the hallucinations?"
//        -> grounding + schema validation + a human reviews it.        (good)
//    Q2  "...and did you understand the question I asked?"
//        -> grounding + schema validation + a human reviews it.        (same)
//    Q3  "even WITHOUT validating through schema, WITHOUT the human,
//         how can you actually control the hallucinations?"
//        -> "I handle hallucinations by grounding ... validating answers
//            against a schema, ensuring a human reviews..."
//
//  The third answer opened with the two mechanisms the interviewer had
//  just excluded. Not wrong — but it reads as not listening, which is
//  worse, and it is what "the answers are generic and dumb" actually was.
//
//  Measured with test/answer-drill.test.js (DRILL=1, real model, real
//  three-turn history) before and after these rules:
//
//                                        before      after
//    T3 offers an excluded mechanism      YES         no
//    T3 reaches the advanced tier         NO          self-consistency +
//                                                     uncertainty control
//    T3 repeats the established tier      3 of 3      none
//
//  This file is the free half of that: it pins the RULES, so the drill's
//  cost is only paid when someone wants to re-measure the behaviour.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildUserRulesBlock } = await import('../../services/aiProxyService.ts');
const RULES = buildUserRulesBlock();

describe('an exclusion in the question is binding', () => {
  it('names the forms an exclusion takes', () => {
    expect(RULES).toMatch(/AN EXCLUSION IN THE QUESTION IS BINDING/);
    // Whitespace-tolerant: the block is hard-wrapped, so several of these
    // phrases straddle a newline.
    for (const form of ['without', 'other than', 'apart from', "even if you can'?t", 'setting X aside']) {
      const re = new RegExp(form.replace(/ /g, '\\s+'), 'i');
      expect(RULES, `exclusion form missing: ${form}`).toMatch(re);
    }
  });

  it('says never to OPEN with the excluded thing', () => {
    // "Without X, I'd do Y" is correct — naming the constraint and
    // answering inside it. Leading with X as the mechanism is the defect.
    expect(RULES).toMatch(/Never open with X/i);
  });

  it('is checked before emitting, not merely stated', () => {
    expect(RULES).toMatch(/12\. CONVERSATION: did the question exclude something/);
    expect(RULES).toMatch(/FIRST sentence/);
  });
});

describe('a follow-up advances instead of restating', () => {
  it('states the rule', () => {
    expect(RULES).toMatch(/A FOLLOW-UP MUST ADVANCE, NOT RESTATE/);
    expect(RULES).toMatch(/it is spent/i);
  });

  it('says what a repeated question MEANS', () => {
    // The model has to read a re-ask as dissatisfaction, not as a request
    // for the same answer again.
    expect(RULES).toMatch(/the previous layer did not satisfy them/i);
  });

  it('is checked before emitting', () => {
    expect(RULES).toMatch(/13\. CONVERSATION: is this a follow-up/);
  });

  it('handles being asked whether it understood the question', () => {
    expect(RULES).toMatch(/IF THEY ASK WHETHER YOU UNDERSTOOD/i);
    expect(RULES).toMatch(/Do not defend the previous answer/i);
  });
});

describe('there is somewhere to go when pushed', () => {
  it('gives a generic ladder, coarse control to fine', () => {
    expect(RULES).toMatch(/WHEN PUSHED, GO DOWN THE LADDER/);
    expect(RULES).toMatch(/Each rung is your answer when the rung above it has been taken away/i);
  });

  it('gives AI/ML systems the vocabulary the ladder needs', () => {
    // The abstract ladder alone did not work: the model had the shape but
    // not the words, and stayed on grounding + schema + human. Naming the
    // middle rungs is what moved it.
    expect(RULES).toMatch(/AI \/ ML SYSTEMS/);
    for (const rung of ['self-consistency', 'entailment', 'abstention', 'citations']) {
      expect(RULES.toLowerCase(), `ladder rung missing: ${rung}`).toContain(rung);
    }
  });

  it('demands the SPECIFIC technique, not the category', () => {
    expect(RULES).toMatch(/name the SPECIFIC technique, never the category/i);
  });

  it('⚠️ forbids reciting the ladder — the house-phrase trap', () => {
    // This codebase has twice shipped a prompt whose memorable phrasing the
    // model copied verbatim (the "Fidelity" example, then the "Most of my
    // time's been on" frame). A ladder is exactly the shape that invites
    // it, so the prompt has to say so.
    expect(RULES).toMatch(/vocabulary to think with, NOT a list to recite/i);
    expect(RULES).toMatch(/naming every rung in one answer leaves you nothing to say/i);
  });

  it('ends honestly rather than promising zero', () => {
    expect(RULES).toMatch(/cannot be driven to zero/i);
  });
});

describe('later turns do not restart the interview', () => {
  it('forbids re-introducing yourself', () => {
    expect(RULES).toMatch(/DO NOT RE-INTRODUCE YOURSELF/i);
  });
});
