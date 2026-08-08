// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE PROMPT THAT ASKED FOR AN INVENTED CAREER
//
//  buildSystemInstruction used to contain, one line below "you are not an AI
//  assistant — you ARE the specific person described below":
//
//    "If KB is empty, fall back to general knowledge silently —
//     never mention the gap."
//
//  Those two instructions together are a request to invent a history and
//  conceal that it was invented, and the app obliged. Sixteen sessions in the
//  user's database have NO file attached, and across them it repeatedly
//  placed the candidate at "Meridian Health" and described an Aurora
//  migration there in detail.
//
//  This is a different defect from the cover fabrication (which produced
//  "IBM" and "Accenture" WITH a resume attached). That one is fixed by the
//  fact ledger. This one lived in the main answer prompt and needed the
//  no-documents case told apart from the documents case, because they need
//  opposite instructions.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildSystemInstruction, buildSystemInstructionNew } =
  await import('../../services/aiProxyService.ts');

const KB = '[[SOURCE: CUSTOM - r.pdf]]\nData Engineer | Siemens, Dallas, TX | April 2026 – Present\n[[END SOURCE]]';

describe('the sentence is gone', () => {
  it('no prompt this function can produce asks for a silent fallback', () => {
    for (const ctx of ['', '   ', KB]) {
      for (const general of [true, false]) {
        const p = buildSystemInstruction(ctx, general);
        expect(p, `ctx=${JSON.stringify(ctx.slice(0, 12))} general=${general}`)
          .not.toMatch(/fall back to general knowledge silently/i);
        expect(p).not.toMatch(/never mention the gap/i);
      }
    }
  });
});

describe('no documents loaded', () => {
  const empty = buildSystemInstruction('', false);
  const emptyGeneral = buildSystemInstruction('', true);

  it('says so plainly instead of presenting an empty knowledge base', () => {
    expect(empty).toContain('MODE — NO DOCUMENTS LOADED');
    expect(empty).toContain('KNOWLEDGE BASE: none loaded for this session.');
    // The old prompt still printed the "KNOWLEDGE BASE (Resume / JD / Notes):"
    // header with nothing under it, then told the model to cover the gap.
    expect(empty).not.toContain('KNOWLEDGE BASE (Resume / JD / Notes):');
  });

  it('forbids exactly the things it used to invent', () => {
    for (const forbidden of ['employer', 'client', 'product', 'project', 'team size', 'date', 'metric']) {
      expect(empty.toLowerCase(), `does not forbid inventing a ${forbidden}`).toContain(forbidden);
    }
    expect(empty).toMatch(/do NOT name an employer/);
    expect(empty).toMatch(/Not one\./);
  });

  it('still answers the question — it narrows, it does not refuse', () => {
    expect(empty).toMatch(/answer fully and well/);
    expect(empty).toMatch(/answer\s+in the first person/);
    // The behavioural case is the one that used to force invention.
    expect(empty).toMatch(/Tell me about a time/);
    expect(empty).toMatch(/how you\s+approach that class of problem/);
  });

  it('never breaks character — declining to invent is not confessing to a tool', () => {
    // This distinction is the whole reason the original instruction existed,
    // and it has to survive the fix: the model must stop fabricating WITHOUT
    // telling an interviewer that software is involved.
    expect(empty).toMatch(/Never say "I don't have access to"/);
    expect(empty).toMatch(/my knowledge base/);
    expect(empty).toMatch(/as an AI/);
    expect(empty).toMatch(/Stay in\ncharacter/);
  });

  it('does not hand the model vocabulary it will read back out', () => {
    // Observed live: with the example phrased "you are not going to invent
    // it", the answer came back "I'd rather not invent or overstate a list
    // of logos" — the model lifted the instruction's own word and said it
    // out loud. A candidate describing a rule they were given is stranger
    // than any silence, so the rule names the words it must not echo.
    expect(empty).toMatch(/DO NOT NARRATE THIS RULE/);
    for (const w of ['invent', 'fabricate', 'make up', 'overstate', 'guess']) {
      expect(empty, `does not forbid echoing "${w}"`).toContain(`"${w}"`);
    }
    // The suggested phrasing itself is clean of those words.
    const example = /"Most of my work has been on the platform side[^"]*"/.exec(empty)[0];
    expect(example).not.toMatch(/invent|fabricate|make up|overstate|guess/i);
  });

  it('applies in general mode too — an empty KB is empty either way', () => {
    expect(emptyGeneral).toContain('MODE — NO DOCUMENTS LOADED');
  });
});

describe('documents loaded', () => {
  const grounded = buildSystemInstruction(KB, false);

  it('keeps the grounded instruction and the knowledge base', () => {
    expect(grounded).toContain('MODE — GROUNDED IN RESUME/JD');
    expect(grounded).toContain('KNOWLEDGE BASE (Resume / JD / Notes):');
    expect(grounded).toContain('Siemens');
    expect(grounded).not.toContain('MODE — NO DOCUMENTS LOADED');
  });

  it('gains the boundaries the NEW prompt path already had', () => {
    // buildSystemInstructionNew has had a KNOWLEDGE BOUNDARIES block since
    // the grounding audit. The OLD path — which serves general mode AND
    // question one, before the briefing card resolves — had none, so the
    // most latency-sensitive question in the session was the least guarded.
    expect(grounded).toContain('KNOWLEDGE BOUNDARIES');
    expect(grounded).toMatch(/NARROW the answer instead of inventing/);
    expect(grounded).toMatch(/Never name an employer,\s+client, product, metric or date that does not appear above/);
  });

  it('a placeholder counts as a knowledge base, not an empty one', () => {
    // With offload active the renderer sends ⟪CTX:sha256⟫ rather than the
    // text. It is opaque but it is NOT absent, and treating it as absent
    // would put the no-documents prompt in front of a full resume.
    const p = buildSystemInstruction('⟪CTX:' + 'a'.repeat(64) + '⟫', false);
    expect(p).toContain('MODE — GROUNDED IN RESUME/JD');
    expect(p).not.toContain('MODE — NO DOCUMENTS LOADED');
  });

  it('the NEW path is unchanged and still carries its own boundaries', () => {
    const p = buildSystemInstructionNew('- Senior DE', '- wants Spark', 'evidence here');
    expect(p).toContain('KNOWLEDGE BOUNDARIES');
    expect(p).toMatch(/FABRICATED specifics destroy the answer/);
  });
});
