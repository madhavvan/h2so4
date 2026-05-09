// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Groq Llama-3.3-70B Auto-Type Planner — Tier 2 fallback
//
//  This is the non-Anthropic backup for /autotype-agent. The primary
//  path (Sonnet 4.6 in autoTypeAgent.js) is great when Anthropic is
//  healthy, but the existing fallback chain (Sonnet → Haiku → OCR)
//  has all its LLM tiers on a single vendor — so an Anthropic outage
//  takes both Tier 2 (Sonnet) and Tier 3 (Haiku) out simultaneously.
//
//  Groq Llama-3.3-70B-versatile is:
//    • Recommended by Groq for forced tool_choice with structured output
//    • Production-grade (not preview) — see console.groq.com/docs/models
//    • OpenAI-compatible function-calling API (different from Anthropic's
//      tool_use shape — translation handled below)
//    • Fast: ~280 T/sec, end-to-end ~400-700ms for our planner payload
//    • Different vendor → real availability diversity for the planner tier
//
//  This file mirrors autoTypeAgent.js intentionally — same SUBMIT_PLAN
//  semantics, same validation/clamping, same dependency-injection
//  testing hook (`_clientFactory`). The only differences are:
//    1. Tool definition uses OpenAI function-calling shape
//       ({ type: 'function', function: {...} }) instead of Anthropic's
//       { name, description, input_schema }
//    2. tool_choice forcing uses the OpenAI shape
//    3. Response parsing reads choices[0].message.tool_calls[0]
//       .function.arguments (JSON string) instead of Anthropic's
//       structured tool_use blocks
//
//  Cost: Groq's free tier gives ~30 RPM and ample daily volume for
//  this fallback role. Even at scale, Llama-3.3-70B on Groq's paid
//  tier is ~$0.59/M input, $0.79/M output — roughly 3-5x cheaper than
//  Sonnet 4.6 per call.
//
//  IMPORTANT: model ID is verified current as of May 2026 via Groq's
//  supported-models page. Re-verify before upgrading — Groq deprecates
//  models on a public schedule.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const Groq = require('groq-sdk');

// OpenAI-compatible function-calling shape. Groq's API mirrors OpenAI's,
// so this is the form that goes through unchanged. Note: parameters
// schema is identical to Anthropic's input_schema (JSON Schema), only
// the wrapper differs.
const SUBMIT_PLAN_FUNCTION = {
  type: 'function',
  function: {
    name: 'submit_plan',
    description: 'Submit the final typing plan after reasoning through the editor state. You MUST reason step by step in plain text BEFORE calling this function. Do not call this function until you have analyzed the editor, identified the cursor, detected overlaps, and chosen a strategy.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'A 2-4 sentence explanation of why this plan is correct given the editor state. Mention any overlap detected, cursor position relative to insertion point, and any wipe/skip decisions.',
        },
        cursor_action: {
          type: 'string',
          enum: ['use_current', 'move_to_end', 'go_to_line'],
          description: 'use_current: cursor is already at a valid insertion point. move_to_end: cursor is in the wrong place; jump to end of file via Ctrl+End first. go_to_line: jump to a specific line (rare; only for known-good mid-file insertion targets).',
        },
        target_line: {
          type: 'integer',
          description: '1-indexed line number; only meaningful when cursor_action=go_to_line. Ignored otherwise.',
        },
        target_column: {
          type: 'integer',
          description: '0-indexed column; only meaningful when cursor_action=go_to_line.',
        },
        wipe_chars: {
          type: 'integer',
          description: 'Number of characters to backspace BEFORE typing. Use when the editor has a partial token (e.g. "def fac" and code starts with "def factorial") — set wipe_chars to clear "fac" so the full identifier types cleanly. 0 if not needed. Capped at 200.',
        },
        wipe_first_line: {
          type: 'boolean',
          description: 'true to do Home+Shift+End+Delete on the cursor line BEFORE typing. Use when leading skip > 0 AND the cursor sits on a whitespace line that would stack with the first typed line\'s indent.',
        },
        skip_leading: {
          type: 'integer',
          description: 'Number of leading lines of CODE_TO_TYPE that already exist verbatim ABOVE the cursor in the editor. Type only what comes after these lines. 0 if no overlap. Critical for HackerRank-style templates that pre-fill the function signature.',
        },
        skip_trailing: {
          type: 'integer',
          description: 'Number of trailing lines of CODE_TO_TYPE that already exist verbatim BELOW the cursor. Use when the editor has driver code or closing braces below the insertion point that we should NOT re-type. 0 if no overlap.',
        },
        prefix: {
          type: 'string',
          description: 'Tiny lead-in text typed BEFORE the main content (e.g. "\\n" if we need a fresh line first). Keep under 200 chars. Usually empty or a single newline.',
        },
        suffix: {
          type: 'string',
          description: 'Tiny trail-out text typed AFTER the main content (e.g. closing braces). Keep under 200 chars. Usually empty.',
        },
        confidence: {
          type: 'number',
          description: '0.0 to 1.0. Be honest. < 0.5 means "I am not sure; the safe-default plan should be used instead." The caller will fall through if confidence < 0.7.',
        },
      },
      required: ['reasoning', 'cursor_action', 'wipe_chars', 'wipe_first_line', 'skip_leading', 'skip_trailing', 'prefix', 'suffix', 'confidence'],
    },
  },
};

// System prompt — kept verbatim from autoTypeAgent.js so behavior is
// consistent across the two planners. Llama-3.3-70B follows numbered
// procedures + concrete examples reliably; the same scaffold that
// works for Sonnet works here.
const SYSTEM_PROMPT = `You are an expert typing planner for an interview-prep auto-type system. The user is sitting at a code editor (HackerRank, CoderPad, CodeSignal, Codility, VS Code, IntelliJ, etc.) and wants the contents of CODE_TO_TYPE inserted at their cursor — but ONLY the parts that aren't already in the editor.

Your job is to produce a precise typing plan that lands the editor in the correct final state without:
  • Duplicating boilerplate that's already there (function signatures, imports, class declarations)
  • Mangling existing template code below the cursor (driver code, closing braces, test harness)
  • Missing parts of CODE_TO_TYPE that the editor doesn't already have

Reasoning procedure — you MUST think step by step in plain text before submitting:

  1. ANALYZE the editor state. What exists? Empty? Template signature? Partial code mid-token? Multi-line stub?

  2. IDENTIFY the cursor position. Look for the |⟨CURSOR⟩| marker in EDITOR_TEXT. Is the cursor at end-of-file? Inside an empty function body? Mid-token? On a blank line?

  3. DETECT overlaps. Compare the LEADING lines of CODE_TO_TYPE against the editor lines ABOVE the cursor. Compare the TRAILING lines against editor lines BELOW the cursor. Count how many lines match verbatim.

  4. PLAN cursor movement. Default to "use_current" — respect where the user placed their cursor. Only override (move_to_end / go_to_line) when the cursor is clearly in the wrong place (middle of an unrelated function, inside a comment block).

  5. PLAN typing details: skip_leading (lines already above), skip_trailing (lines already below), wipe_chars (partial token to clear), wipe_first_line (cursor on whitespace that would stack indent), prefix/suffix (tiny adjustments).

After reasoning, call submit_plan with the complete plan.

Anti-patterns (DO NOT):
  • DO NOT plan to retype lines that exist verbatim above the cursor (set skip_leading instead)
  • DO NOT use move_to_end if the editor has template code below the cursor (you would land below the template — that's wrong)
  • DO NOT recommend go_to_line(1) — that overrides the user's deliberate cursor placement
  • DO NOT set confidence > 0.85 if you saw any ambiguity in the editor state
  • DO NOT respond with text only — you MUST end by calling submit_plan

Concrete examples of common situations:

  HackerRank Python template (cursor inside empty body):
    EDITOR: "def solution(nums):\\n    |⟨CURSOR⟩|\\n# main below"
    CODE:   "def solution(nums):\\n    if not nums: return 0\\n    return max(nums)"
    PLAN:   skip_leading=1 (def line already there), wipe_first_line=true (cursor on indent),
            cursor_action=use_current, confidence=0.92

  Empty editor (cursor at start):
    EDITOR: "|⟨CURSOR⟩|"
    CODE:   "def foo(): return 42"
    PLAN:   skip_leading=0, skip_trailing=0, wipe_first_line=false,
            cursor_action=use_current, confidence=0.95

  Editor has driver code below (HackerRank with __main__ block):
    EDITOR: "def solve():\\n    |⟨CURSOR⟩|\\n\\nif __name__ == '__main__':\\n    print(solve())"
    CODE:   "def solve():\\n    return calculate()"
    PLAN:   skip_leading=1, skip_trailing=0, wipe_first_line=true,
            cursor_action=use_current, confidence=0.90
            (DO NOT move_to_end — you'd land below __main__)`;

// Build the user message. Identical to the Sonnet planner — labeled
// EDITOR_TEXT / CODE_TO_TYPE / LANGUAGE so the model can refer to
// them by name in its reasoning trace.
function buildUserMessage({ editorText, cursorOffset, code, language }) {
  const safeOffset = Math.max(0, Math.min(editorText.length, cursorOffset));
  const editorWithMark =
    editorText.slice(0, safeOffset) + '|⟨CURSOR⟩|' + editorText.slice(safeOffset);

  return `LANGUAGE: ${language}

EDITOR_TEXT (cursor marked with |⟨CURSOR⟩|):
\`\`\`
${editorWithMark}
\`\`\`

CODE_TO_TYPE:
\`\`\`
${code}
\`\`\`

Reason step by step, then call submit_plan.`;
}

// Same MAX_INPUT_CHARS as Sonnet planner — input parity matters when
// fallback fires; if Sonnet trimmed at 8000, Groq sees the same trim.
const MAX_INPUT_CHARS = 8000;

// Default client factory — exposed via `_clientFactory` so tests can
// inject a fake without resolving the groq-sdk module. Production
// callers never need to pass it.
function defaultClientFactory(apiKey) {
  return new Groq({ apiKey });
}

async function runGroqAutoTypePlanner({ editorText, cursorOffset, code, language, apiKey, requestId, _clientFactory }) {
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const editorTextSafe = String(editorText || '').slice(0, MAX_INPUT_CHARS);
  const codeSafe = String(code || '').slice(0, MAX_INPUT_CHARS);
  const cursorSafe = Number.isFinite(cursorOffset)
    ? Math.max(0, Math.min(editorTextSafe.length, Math.floor(cursorOffset)))
    : editorTextSafe.length;
  const langSafe = String(language || 'unknown').slice(0, 30);

  if (codeSafe.length === 0) {
    const err = new Error('CODE_TO_TYPE is empty');
    err.code = 'EMPTY_CODE';
    throw err;
  }

  const userMessage = buildUserMessage({
    editorText: editorTextSafe,
    cursorOffset: cursorSafe,
    code: codeSafe,
    language: langSafe,
  });

  const factory = typeof _clientFactory === 'function' ? _clientFactory : defaultClientFactory;
  const client = factory(apiKey);

  // Groq's chat.completions.create is OpenAI-compatible. tool_choice
  // forced to our function name guarantees the model emits a tool_call
  // — without it Llama occasionally responds with text only.
  const response = await client.chat.completions.create({
    // VERIFIED current production model ID for tool use (May 2026).
    // See console.groq.com/docs/tool-use — re-verify before upgrading.
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1500,
    temperature: 0.0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    tools: [SUBMIT_PLAN_FUNCTION],
    tool_choice: { type: 'function', function: { name: 'submit_plan' } },
  });

  // Defensive parsing — even with forced tool_choice, the response
  // shape can vary (no choices, no message, malformed JSON args).
  const choice = response.choices && response.choices[0];
  const message = choice && choice.message;
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCall = toolCalls.find(tc => tc && tc.function && tc.function.name === 'submit_plan');

  if (!toolCall) {
    const err = new Error('Groq agent did not call submit_plan');
    err.code = 'NO_TOOL_CALL';
    err.detail = message ? message.content : null;
    throw err;
  }

  // Function arguments come back as a JSON string in OpenAI-compatible
  // APIs (unlike Anthropic which gives a pre-parsed object). Parse
  // defensively — Llama can occasionally emit slightly malformed JSON
  // (trailing commas, unquoted keys) under load.
  let plan;
  try {
    plan = JSON.parse(toolCall.function.arguments || '{}');
  } catch (parseErr) {
    const err = new Error('Groq agent returned malformed JSON arguments');
    err.code = 'BAD_ARGUMENTS_JSON';
    err.detail = toolCall.function.arguments;
    throw err;
  }

  // Same defensive validation/clamping as the Sonnet planner. The
  // schema enforces shape; this enforces ranges so a malformed plan
  // can't drive the typer into a bad state (negative skips, runaway
  // wipes, suffixes containing the entire codebase).
  const validated = {
    ok: true,
    reasoning: typeof plan.reasoning === 'string' ? plan.reasoning : '',
    cursor_action: ['use_current', 'move_to_end', 'go_to_line'].includes(plan.cursor_action) ? plan.cursor_action : 'use_current',
    target_line: Number.isInteger(plan.target_line) ? Math.max(0, plan.target_line) : 0,
    target_column: Number.isInteger(plan.target_column) ? Math.max(0, plan.target_column) : 0,
    wipe_chars: Number.isInteger(plan.wipe_chars) ? Math.max(0, Math.min(200, plan.wipe_chars)) : 0,
    wipe_first_line: Boolean(plan.wipe_first_line),
    skip_leading: Number.isInteger(plan.skip_leading) ? Math.max(0, plan.skip_leading) : 0,
    skip_trailing: Number.isInteger(plan.skip_trailing) ? Math.max(0, plan.skip_trailing) : 0,
    prefix: typeof plan.prefix === 'string' ? plan.prefix.slice(0, 200) : '',
    suffix: typeof plan.suffix === 'string' ? plan.suffix.slice(0, 200) : '',
    confidence: typeof plan.confidence === 'number'
      ? Math.max(0, Math.min(1, plan.confidence))
      : 0,
    // Telemetry — useful for distinguishing Sonnet vs Groq plans in logs
    request_id: requestId || null,
    model: 'llama-3.3-70b-versatile',
    usage: response.usage || null,
  };

  return validated;
}

module.exports = {
  runGroqAutoTypePlanner,
  // Internals exposed for testing
  _test: { SUBMIT_PLAN_FUNCTION, SYSTEM_PROMPT, buildUserMessage, MAX_INPUT_CHARS },
};
