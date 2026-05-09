// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Groq Auto-Type Planner — unit tests
//
//  Mirrors test/autotype-agent.test.js. Same dependency-injection
//  pattern (_clientFactory) so we don't have to mock the groq-sdk
//  module resolution. The fake client mimics Groq's OpenAI-compatible
//  shape: response.choices[0].message.tool_calls[0].function.arguments
//  is the JSON string the planner must parse.
//
//  Covered:
//    1. Function schema is well-formed (OpenAI-compatible shape)
//    2. Prompt construction inserts cursor mark correctly
//    3. Successful tool_call response produces a valid plan
//    4. Missing tool_call raises NO_TOOL_CALL
//    5. Malformed JSON args raises BAD_ARGUMENTS_JSON
//    6. Missing API key raises NOT_CONFIGURED
//    7. Empty code raises EMPTY_CODE
//    8. Plan values are clamped (skip_leading >= 0, etc.)
//    9. Long inputs are truncated to MAX_INPUT_CHARS
//   10. Correct model ID + tool_choice forcing is sent to Groq
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runGroqAutoTypePlanner, _test } = require('../src/services/groqAutoTypePlanner.js');
const { SUBMIT_PLAN_FUNCTION, SYSTEM_PROMPT, buildUserMessage, MAX_INPUT_CHARS } = _test;

// Helper: build a fake Groq client. Groq's API mirrors OpenAI's, so the
// shape is client.chat.completions.create(...) returning an object with
// choices[0].message.tool_calls[].function.arguments (JSON string).
function makeFakeClient(toolCallArgs, captureCallArgs, options = {}) {
  // toolCallArgs can be:
  //   - object → wrapped as a normal tool_call with that as arguments
  //   - string → used as-is as the arguments JSON string (for malformed-JSON tests)
  //   - null   → no tool_calls at all (NO_TOOL_CALL test)
  //   - function → called with create() args, expected to return the response
  return () => ({
    chat: {
      completions: {
        create: vi.fn().mockImplementation((args) => {
          if (captureCallArgs) captureCallArgs.push(args);
          if (typeof toolCallArgs === 'function') return toolCallArgs(args);

          let toolCalls;
          if (toolCallArgs === null) {
            toolCalls = [];
          } else if (typeof toolCallArgs === 'string') {
            // Use the raw string as the arguments — for testing malformed JSON.
            toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'submit_plan', arguments: toolCallArgs } }];
          } else {
            toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(toolCallArgs) } }];
          }

          return Promise.resolve({
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: options.content || null,
                tool_calls: toolCalls,
              },
              finish_reason: 'tool_calls',
            }],
            usage: options.usage || { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
          });
        }),
      },
    },
  });
}

describe('SUBMIT_PLAN_FUNCTION schema', () => {
  it('uses OpenAI function-calling shape', () => {
    expect(SUBMIT_PLAN_FUNCTION.type).toBe('function');
    expect(SUBMIT_PLAN_FUNCTION.function.name).toBe('submit_plan');
    expect(SUBMIT_PLAN_FUNCTION.function.parameters.type).toBe('object');
  });

  it('has all the required fields the typer consumes', () => {
    const required = SUBMIT_PLAN_FUNCTION.function.parameters.required;
    expect(required).toContain('reasoning');
    expect(required).toContain('cursor_action');
    expect(required).toContain('skip_leading');
    expect(required).toContain('skip_trailing');
    expect(required).toContain('confidence');
  });

  it('cursor_action enum constrains to three values', () => {
    const enumVals = SUBMIT_PLAN_FUNCTION.function.parameters.properties.cursor_action.enum;
    expect(enumVals).toEqual(['use_current', 'move_to_end', 'go_to_line']);
  });
});

describe('SYSTEM_PROMPT (Groq variant)', () => {
  it('is identical in spirit to the Sonnet planner — same procedure', () => {
    expect(SYSTEM_PROMPT).toMatch(/ANALYZE/);
    expect(SYSTEM_PROMPT).toMatch(/IDENTIFY/);
    expect(SYSTEM_PROMPT).toMatch(/DETECT/);
    expect(SYSTEM_PROMPT).toMatch(/submit_plan/);
  });

  it('includes anti-patterns', () => {
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

describe('runGroqAutoTypePlanner — happy path', () => {
  it('returns a valid plan when submit_plan tool_call is present', async () => {
    const calls = [];
    const fakeClient = makeFakeClient({
      reasoning: 'def line is duplicated above the cursor',
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
    }, calls);

    const plan = await runGroqAutoTypePlanner({
      editorText: 'def solution(nums):\n    \n# main below',
      cursorOffset: 24,
      code: 'def solution(nums):\n    return max(nums)',
      language: 'python',
      apiKey: 'gsk_test',
      _clientFactory: fakeClient,
    });

    expect(plan.ok).toBe(true);
    expect(plan.cursor_action).toBe('use_current');
    expect(plan.skip_leading).toBe(1);
    expect(plan.wipe_first_line).toBe(true);
    expect(plan.confidence).toBe(0.9);
    expect(plan.reasoning).toBe('def line is duplicated above the cursor');
    expect(plan.model).toBe('llama-3.3-70b-versatile');
    expect(plan.usage.total_tokens).toBe(1200);
  });

  it('passes the correct model + tool_choice to Groq', async () => {
    const calls = [];
    const fakeClient = makeFakeClient({
      reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
      skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.5,
    }, calls);

    await runGroqAutoTypePlanner({
      editorText: '', cursorOffset: 0, code: 'x', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });

    expect(calls.length).toBe(1);
    const callArg = calls[0];
    expect(callArg.model).toBe('llama-3.3-70b-versatile');
    expect(callArg.tools).toEqual([SUBMIT_PLAN_FUNCTION]);
    // Groq uses OpenAI's tool_choice shape — different from Anthropic's.
    expect(callArg.tool_choice).toEqual({ type: 'function', function: { name: 'submit_plan' } });
    // Temperature 0 for determinism — same plan for same input.
    expect(callArg.temperature).toBe(0.0);
    // System prompt goes via the messages array (OpenAI-compatible),
    // not as a separate `system` field (which is Anthropic's shape).
    expect(callArg.messages[0].role).toBe('system');
    expect(callArg.messages[0].content).toBe(SYSTEM_PROMPT);
    expect(callArg.messages[1].role).toBe('user');
  });
});

describe('runGroqAutoTypePlanner — error paths', () => {
  it('throws NOT_CONFIGURED when apiKey missing', async () => {
    await expect(runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: '',
    })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('throws EMPTY_CODE when code is empty', async () => {
    await expect(runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: '', language: 'js', apiKey: 'k',
    })).rejects.toMatchObject({ code: 'EMPTY_CODE' });
  });

  it('throws NO_TOOL_CALL when Groq responds with text only (empty tool_calls)', async () => {
    const fakeClient = makeFakeClient(null, null, { content: 'I refuse to call the tool.' });
    await expect(runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    })).rejects.toMatchObject({ code: 'NO_TOOL_CALL' });
  });

  it('throws BAD_ARGUMENTS_JSON when tool_call arguments are malformed', async () => {
    // Llama occasionally emits trailing-comma or unquoted-key JSON under load.
    // Pass a deliberately malformed string as the raw `arguments` payload.
    const fakeClient = makeFakeClient('{"reasoning": "hi", "cursor_action": "use_current",}');
    await expect(runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    })).rejects.toMatchObject({ code: 'BAD_ARGUMENTS_JSON' });
  });
});

describe('runGroqAutoTypePlanner — defensive clamping', () => {
  it('clamps negative skip_leading to 0', async () => {
    const fakeClient = makeFakeClient({
      reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
      skip_leading: -5, skip_trailing: -3, prefix: '', suffix: '', confidence: 0.8,
    });
    const plan = await runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.skip_leading).toBe(0);
    expect(plan.skip_trailing).toBe(0);
  });

  it('clamps wipe_chars to <= 200', async () => {
    const fakeClient = makeFakeClient({
      reasoning: '', cursor_action: 'use_current', wipe_chars: 9999, wipe_first_line: false,
      skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.8,
    });
    const plan = await runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.wipe_chars).toBe(200);
  });

  it('clamps confidence to [0, 1]', async () => {
    const fakeClient = makeFakeClient({
      reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
      skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 1.5,
    });
    const plan = await runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.confidence).toBe(1);
  });

  it('truncates prefix/suffix to 200 chars', async () => {
    const longStr = 'a'.repeat(500);
    const fakeClient = makeFakeClient({
      reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
      skip_leading: 0, skip_trailing: 0, prefix: longStr, suffix: longStr, confidence: 0.8,
    });
    const plan = await runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.prefix.length).toBe(200);
    expect(plan.suffix.length).toBe(200);
  });

  it('rejects unknown cursor_action and defaults to use_current', async () => {
    const fakeClient = makeFakeClient({
      reasoning: '', cursor_action: 'evaporate_into_void', wipe_chars: 0, wipe_first_line: false,
      skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.8,
    });
    const plan = await runGroqAutoTypePlanner({
      editorText: 'x', cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    expect(plan.cursor_action).toBe('use_current');
  });
});

describe('runGroqAutoTypePlanner — input truncation', () => {
  it('truncates editorText longer than MAX_INPUT_CHARS', async () => {
    const giant = 'x'.repeat(MAX_INPUT_CHARS + 5000);
    const calls = [];
    const fakeClient = makeFakeClient({
      reasoning: '', cursor_action: 'use_current', wipe_chars: 0, wipe_first_line: false,
      skip_leading: 0, skip_trailing: 0, prefix: '', suffix: '', confidence: 0.5,
    }, calls);
    await runGroqAutoTypePlanner({
      editorText: giant, cursorOffset: 0, code: 'y', language: 'js', apiKey: 'k',
      _clientFactory: fakeClient,
    });
    // The user message is the second messages[] entry (system is index 0).
    const userMsg = calls[0].messages[1].content;
    const match = userMsg.match(/EDITOR_TEXT[^`]*```([\s\S]*?)```/);
    const enclosed = match ? match[1].trim() : '';
    expect(enclosed.length).toBeLessThanOrEqual(MAX_INPUT_CHARS + 30);
  });
});
