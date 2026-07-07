// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Auto-Type Agent — unit tests
//
//  Uses dependency injection (the _clientFactory escape hatch on
//  runAutoTypeAgent) instead of trying to mock the Anthropic SDK at
//  the module-resolution layer. vitest's vi.mock interop with
//  @anthropic-ai/sdk's CJS-with-__esModule shape is finicky;
//  injecting a fake client is more robust and the production code
//  path is never exercised by the tests.
//
//  Covered:
//    1. Tool schema is well-formed
//    2. Prompt construction inserts cursor mark correctly
//    3. Successful tool_use response produces a valid plan
//    4. Missing tool_use raises NO_TOOL_CALL
//    5. Missing API key raises NOT_CONFIGURED
//    6. Empty code raises EMPTY_CODE
//    7. Plan values are clamped (skip_leading >= 0, etc.)
//    8. Long inputs are truncated to MAX_INPUT_CHARS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runAutoTypeAgent, _test } = require('../src/services/autoTypeAgent.js');
const { SUBMIT_PLAN_TOOL, SYSTEM_PROMPT, buildUserMessage, MAX_INPUT_CHARS } = _test;

// Helper: build a fake Anthropic client that returns whatever response
// the test queues up. Mirrors the real SDK shape: client.messages.create.
function makeFakeClient(responseToReturn, captureCallArgs) {
  return () => ({
    messages: {
      create: vi.fn().mockImplementation((args) => {
        if (captureCallArgs) captureCallArgs.push(args);
        if (typeof responseToReturn === 'function') return responseToReturn(args);
        return Promise.resolve(responseToReturn);
      }),
    },
  });
}

describe('SUBMIT_PLAN_TOOL schema', () => {
  it('has the right shape', () => {
    expect(SUBMIT_PLAN_TOOL.name).toBe('submit_plan');
    expect(SUBMIT_PLAN_TOOL.input_schema.type).toBe('object');
    const required = SUBMIT_PLAN_TOOL.input_schema.required;
    expect(required).toContain('reasoning');
    expect(required).toContain('cursor_action');
    expect(required).toContain('skip_leading');
    expect(required).toContain('skip_trailing');
    expect(required).toContain('confidence');
  });

  it('cursor_action enum constrains to three values', () => {
    const enumVals = SUBMIT_PLAN_TOOL.input_schema.properties.cursor_action.enum;
    expect(enumVals).toEqual(['use_current', 'move_to_end', 'go_to_line']);
  });
});

describe('SYSTEM_PROMPT', () => {
  it('mentions the 5-step procedure', () => {
    expect(SYSTEM_PROMPT).toMatch(/ANALYZE/);
    expect(SYSTEM_PROMPT).toMatch(/IDENTIFY/);
    expect(SYSTEM_PROMPT).toMatch(/DETECT/);
    expect(SYSTEM_PROMPT).toMatch(/PLAN/);
    expect(SYSTEM_PROMPT).toMatch(/submit_plan/);
  });

  it('lists anti-patterns', () => {
    expect(SYSTEM_PROMPT).toMatch(/DO NOT/);
  });

  it('includes concrete editor examples', () => {
    expect(SYSTEM_PROMPT).toMatch(/HackerRank/);
  });
});

describe('buildUserMessage', () => {
  it('inserts cursor marker at the right offset', () => {
    const msg = buildUserMessage({ editorText: 'hello world', cursorOffset: 5, code: 'x', language: 'js' });
    expect(msg).toContain('hello|⟨CURSOR⟩| world');
  });

  it('clamps cursor to editor length', () => {
    const msg = buildUserMessage({ editorText: 'short', cursorOffset: 999, code: 'x', language: 'js' });
    expect(msg).toContain('short|⟨CURSOR⟩|');
  });

  it('clamps cursor to >= 0', () => {
    const msg = buildUserMessage({ editorText: 'abc', cursorOffset: -5, code: 'x', language: 'js' });
    expect(msg).toContain('|⟨CURSOR⟩|abc');
  });

  it('includes language label', () => {
    const msg = buildUserMessage({ editorText: '', cursorOffset: 0, code: 'x', language: 'python' });
    expect(msg).toContain('LANGUAGE: python');
  });
});

describe('runAutoTypeAgent — happy path', () => {
  it('returns the plan when submit_plan is called', async () => {
    const calls = [];
    const fakeClient = makeFakeClient({
      content: [
        { type: 'text', text: 'I see a HackerRank template with the def line already there.' },
        {
          type: 'tool_use',
          name: 'submit_plan',
          input: {
            reasoning: 'def line is duplicated',
            cursor_action: 'use_current',
            target_line: 0,
            target_column: 0,
            wipe_chars: 0,
            wipe_first_line: true,
            skip_leading: 1,
            skip_trailing: 0,
            prefix: '',
            suffix: '',
            confidence: 0.9,
          },
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 200 },
    }, calls);

    const plan = await runAutoTypeAgent({
      editorText: 'def solution(nums):\n    \n# main below',
      cursorOffset: 24,
      code: 'def solution(nums):\n    return max(nums)',
      language: 'python',
      apiKey: 'sk-ant-test',
      _clientFactory: fakeClient,
    });

    expect(plan.ok).toBe(true);
    expect(plan.cursor_action).toBe('use_current');
    expect(plan.skip_leading).toBe(1);
    expect(plan.wipe_first_line).toBe(true);
    expect(plan.confidence).toBe(0.9);
    expect(plan.reasoning).toBe('def line is duplicated');
    expect(plan.pre_tool_reasoning).toContain('HackerRank template');
    expect(plan.usage.input_tokens).toBe(1000);
  });

  it('passes the right model + system prompt to Anthropic', async () => {
    const calls = [];
    const fakeClient = makeFakeClient({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {
        reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
        skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.5,
      } }],
    }, calls);
    await runAutoTypeAgent({
      editorText: '', cursorOffset: 0, code: 'x', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(calls.length).toBe(1);
    const callArg = calls[0];
    expect(callArg.model).toBe('claude-sonnet-5');
    expect(callArg.system).toBe(SYSTEM_PROMPT);
    expect(callArg.tool_choice).toEqual({ type: 'tool', name: 'submit_plan' });
    expect(callArg.tools).toEqual([SUBMIT_PLAN_TOOL]);
  });
});

describe('runAutoTypeAgent — error paths', () => {
  it('throws NOT_CONFIGURED when apiKey missing', async () => {
    await expect(runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: '',
    })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('throws EMPTY_CODE when code is empty', async () => {
    await expect(runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: '', language: 'js', apiKey: 'k',
    })).rejects.toMatchObject({ code: 'EMPTY_CODE' });
  });

  it('throws NO_TOOL_CALL when Sonnet responds with text only', async () => {
    const fakeClient = makeFakeClient({
      content: [{ type: 'text', text: 'I refuse to call the tool.' }],
    });
    await expect(runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    })).rejects.toMatchObject({ code: 'NO_TOOL_CALL' });
  });
});

describe('runAutoTypeAgent — defensive clamping', () => {
  it('clamps negative skip_leading to 0', async () => {
    const fakeClient = makeFakeClient({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {
        reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
        skip_leading: -5, skip_trailing: -3, prefix: '', suffix: '', confidence: 0.8,
      } }],
    });
    const plan = await runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.skip_leading).toBe(0);
    expect(plan.skip_trailing).toBe(0);
  });

  it('clamps wipe_chars to <= 200', async () => {
    const fakeClient = makeFakeClient({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {
        reasoning: '', cursor_action: 'use_current', wipe_chars: 9999, wipe_first_line: false,
        skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.8,
      } }],
    });
    const plan = await runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.wipe_chars).toBe(200);
  });

  it('clamps confidence to [0, 1]', async () => {
    const fakeClient = makeFakeClient({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {
        reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
        skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 1.5,
      } }],
    });
    const plan = await runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.confidence).toBe(1);
  });

  it('truncates prefix/suffix to 200 chars', async () => {
    const longStr = 'a'.repeat(500);
    const fakeClient = makeFakeClient({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {
        reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
        skip_leading: 0, skip_trailing: 0, prefix: longStr, suffix: longStr, confidence: 0.8,
      } }],
    });
    const plan = await runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.prefix.length).toBe(200);
    expect(plan.suffix.length).toBe(200);
  });

  it('rejects unknown cursor_action and defaults to use_current', async () => {
    const fakeClient = makeFakeClient({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {
        reasoning: '', cursor_action: 'evaporate_into_void', wipe_chars: 0, wipe_first_line: false,
        skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.8,
      } }],
    });
    const plan = await runAutoTypeAgent({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.cursor_action).toBe('use_current');
  });
});

describe('runAutoTypeAgent — input truncation', () => {
  it('truncates editorText longer than MAX_INPUT_CHARS', async () => {
    const giant = 'x'.repeat(MAX_INPUT_CHARS + 5000);
    const calls = [];
    const fakeClient = makeFakeClient({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {
        reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
        skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.5,
      } }],
    }, calls);
    await runAutoTypeAgent({
      editorText: giant, cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    const userMsg = calls[0].messages[0].content;
    // Truncated editor body should be <= MAX_INPUT_CHARS + the cursor marker length
    const match = userMsg.match(/EDITOR_TEXT[^`]*```([\s\S]*?)```/);
    const enclosed = match ? match[1].trim() : '';
    expect(enclosed.length).toBeLessThanOrEqual(MAX_INPUT_CHARS + 30);
  });
});
