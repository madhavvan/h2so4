// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Auto-Type Agent — Sonnet 4.6 with tool-use
//
//  This is the "god-level" planner that replaces the v1 Haiku one-shot.
//  Where Haiku saw {editor, code} and produced one JSON object,
//  Sonnet 4.6 here is given:
//    1. A SYSTEM PROMPT that requires explicit 5-step reasoning before
//       any output (ANALYZE → IDENTIFY → DETECT → PLAN → SUBMIT)
//    2. A TOOL (submit_plan) that forces structured output via
//       Anthropic's tool_use API — Claude can only "answer" by calling
//       the tool, which guarantees the JSON shape we need
//    3. EXAMPLES of common editor configurations (HackerRank template,
//       partial signature, empty body, mid-file insertion) so the
//       output reflects domain knowledge of how interview platforms
//       actually structure their starting state
//
//  Why this is genuinely better than Haiku one-shot:
//    • Sonnet's chain-of-thought is dramatically stronger — it actually
//      reasons about overlapping prefix lines, indent stacking, cursor
//      validity before producing the plan
//    • The reasoning trace is logged for debugging — when SID detects
//      drift in production, we can read what the agent was thinking
//    • The plan schema is enforced by the tool input_schema — no more
//      "Sonnet returned text instead of JSON" failure modes
//    • Prompt has explicit anti-patterns: "do NOT plan to retype lines
//      that exist verbatim above the cursor"
//
//  Cost analysis:
//    • Sonnet 4.6 input ~$0.003/1K tok, output ~$0.015/1K tok
//    • Typical call: ~2K input (editor + code + system) + ~500 output
//    • Per-call: ~$0.013
//    • Triggered only when deterministic UIA confidence < 0.85
//      (estimated 30% of runs based on the existing planner's metrics)
//    • At 2k Max users × 3 auto-types/day × 30% agent rate: ~1800/day
//      → ~$24/day → ~$700/month
//    • Mitigated by the deterministic-first hierarchy: simple cases
//      never trigger the agent.
//
//  Resilience:
//    • If the Anthropic API is slow / down, caller sees a 503 and
//      falls through to the OCR-supplied skipLines (existing path)
//    • If the agent returns an unparseable response, we return null
//      and the caller falls through. Safe-by-default — never
//      undercharge or mangle the user's editor.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { Anthropic } = require('@anthropic-ai/sdk');

// Tool definition — Anthropic's tool_use guarantees the shape, so we don't
// have to defensively parse free-form text from the model. The required
// fields here are exactly what the typing engine in main.cjs consumes.
const SUBMIT_PLAN_TOOL = {
  name: 'submit_plan',
  description: 'Submit the final typing plan after reasoning through the editor state. You MUST reason step by step in plain text BEFORE calling this tool. Do not call this tool until you have analyzed the editor, identified the cursor, detected overlaps, and chosen a strategy.',
  input_schema: {
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
};

// System prompt — explicit chain-of-thought scaffold. Sonnet follows
// numbered procedures faithfully when given concrete steps + examples.
// Anti-patterns are listed because frontier models still occasionally
// "helpfully" decide to retype the whole file from scratch when the
// editor has 80% of the code already.
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

// Build the user message — labels are explicit so Sonnet can refer to
// them by name in its reasoning, which makes the chain-of-thought
// auditable in logs.
function buildUserMessage({ editorText, cursorOffset, code, language }) {
  // Inject cursor marker. Doing this in code (rather than asking Claude
  // to compute the cursor by character offset) eliminates an entire
  // class of off-by-one bugs.
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

// Cap inputs so a runaway editor (huge file, accidentally pasted novel)
// can't blow up our token budget. 8000 chars of editor + 8000 of code
// covers any realistic interview window with margin.
const MAX_INPUT_CHARS = 8000;

// Default client factory — exposed via the `_clientFactory` arg so tests
// can swap in a mock without needing to monkey-patch the @anthropic-ai/sdk
// require resolution. Production callers never need to pass it.
function defaultClientFactory(apiKey) {
  return new Anthropic({ apiKey });
}

async function runAutoTypeAgent({ editorText, cursorOffset, code, language, apiKey, requestId, _clientFactory }) {
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
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

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    tools: [SUBMIT_PLAN_TOOL],
    // tool_choice forces the model to USE a tool. Without it, Sonnet
    // sometimes responds with text only ("Here is my plan: ..."), which
    // we'd have to text-parse — defeating the structured-output point.
    tool_choice: { type: 'tool', name: 'submit_plan' },
    messages: [{ role: 'user', content: userMessage }],
  });

  // Extract the tool call. With tool_choice forcing submit_plan, the
  // response MUST contain a tool_use block — but we defensively check.
  const toolUse = (response.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_plan');
  if (!toolUse) {
    const err = new Error('Agent did not call submit_plan');
    err.code = 'NO_TOOL_CALL';
    err.detail = response.content;
    throw err;
  }

  const plan = toolUse.input || {};

  // Extract any reasoning text the agent emitted before the tool call.
  // Useful for debugging and for showing the user what the model thought.
  const reasoningText = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  // Defensive validation. The tool schema enforces shape, but we still
  // clamp ranges to safe values so a malformed plan can't drive the
  // typer into a bad state (e.g. negative skip lines).
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
    // Telemetry / debugging — not consumed by the typer
    pre_tool_reasoning: reasoningText,
    request_id: requestId || null,
    model: 'claude-sonnet-5',
    usage: response.usage || null,
  };

  return validated;
}

module.exports = {
  runAutoTypeAgent,
  // Internals exposed for testing
  _test: { SUBMIT_PLAN_TOOL, SYSTEM_PROMPT, buildUserMessage, MAX_INPUT_CHARS },
};
