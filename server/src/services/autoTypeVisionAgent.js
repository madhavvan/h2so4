// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Auto-Type VISION Agent — Sonnet 4.6, vision + MULTI-OPERATION plan
//
//  Why multi-operation (v2):
//    The v1 plan was SINGLE-REGION — one skip_leading, one skip_trailing,
//    one cursor move. On a clean template that's fine. On a real, messy
//    test pad — two half-written function chunks, a junk line typed by
//    accident, a missing import — it physically cannot express reality
//    ("fix the broken `while` in chunk 1, DELETE the junk line, THEN
//    fill the chunk-2 stub"). The model, sensing it can't fit the world
//    into one region, produced low-confidence, inconsistent plans that
//    got rejected → the app fell back to dumping the whole file. That's
//    the "it still writes the entire code" bug, root-caused.
//
//    v2: the model emits an ORDERED LIST of edit operations, each
//    anchored to a DOCUMENT LINE NUMBER it reads off the editor's gutter
//    in the screenshot:
//      • replace  [start_line..end_line] with text
//      • delete   [start_line..end_line]            (kills junk / dead code)
//      • insert   after start_line, text            (adds a missing import / fn)
//    The typing engine in main.cjs executes them BOTTOM-TO-TOP so an
//    edit never shifts the line numbers of an edit still pending above
//    it. This is the structural model a human actually uses: navigate to
//    a region, make a targeted change, move to the next.
//
//  Output contract (consumed by main.cjs executeMultiOpPlan):
//    { ok, reasoning, confidence, operations: [
//        { op:'replace'|'insert'|'delete', start_line, end_line, text, reason }
//    ] }
//
//  Resilience: typed errors (NOT_CONFIGURED / NO_TOOL_CALL / EMPTY_CODE
//  / BAD_IMAGE) so the route can fall through. Never mangles by default.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { Anthropic } = require('@anthropic-ai/sdk');
const { detectStubs } = require('./stubDetector');

const MAX_OPERATIONS = 16;        // a real edit is rarely more than a handful
const MAX_OP_TEXT_CHARS = 6000;   // per-operation text cap
const MAX_INPUT_CHARS = 8000;     // CODE_TO_TYPE cap

const SUBMIT_PLAN_TOOL = {
  name: 'submit_plan',
  description: 'Submit the ordered list of edit operations after visually reasoning through the editor screenshot. You MUST reason step by step in plain text BEFORE calling this tool — describe what you see, which lines are broken / stub / junk / missing, and which operations fix them.',
  input_schema: {
    type: 'object',
    properties: {
      reasoning: {
        type: 'string',
        description: 'A short structural account, grounded in the screenshot: what code exists, what is broken/incomplete (a half-written chunk, a `pass` stub), what is junk (accidental keystrokes, dead code), what is missing (an import), and why the chosen operations fix exactly those things without touching what is already correct.',
      },
      operations: {
        type: 'array',
        description: 'Ordered list of edit operations. Each is anchored to a DOCUMENT LINE NUMBER read directly from the editor gutter in the screenshot. Operations must NOT overlap each other. Order does not matter (the engine sorts bottom-to-top); just make each one correct. Keep the list MINIMAL — only the regions that actually need to change. Empty array = nothing to do.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['replace', 'insert', 'delete'],
              description: "replace: overwrite document lines [start_line..end_line] with `text`. insert: add `text` as new line(s) AFTER document line start_line. delete: remove document lines [start_line..end_line] entirely (use for accidental junk, dead/unreachable code, a wrong chunk that must go).",
            },
            start_line: {
              type: 'integer',
              description: '1-indexed DOCUMENT line number, read from the editor gutter in the screenshot. For replace/delete: first line of the range. For insert: the line to insert AFTER.',
            },
            end_line: {
              type: 'integer',
              description: '1-indexed DOCUMENT line number, inclusive. For replace/delete: last line of the range (>= start_line). For insert: set equal to start_line (ignored).',
            },
            text: {
              type: 'string',
              description: 'For replace/insert: the new content. Multi-line allowed (use \\n). Indentation must be correct for where it lands. For delete: set to empty string "".',
            },
            reason: {
              type: 'string',
              description: 'One short clause explaining why this operation — e.g. "fix broken while-loop, missing colon + incomplete deque logic" or "delete accidental junk line" or "fill empty function body".',
            },
          },
          required: ['op', 'start_line', 'end_line', 'text', 'reason'],
        },
      },
      confidence: {
        type: 'number',
        description: '0.0-1.0. Be honest. The caller falls through to other planners if confidence < 0.7. Lower it if the screenshot is blurry, line numbers in the gutter are unreadable, or the editor state is genuinely ambiguous.',
      },
    },
    required: ['reasoning', 'operations', 'confidence'],
  },
};

const SYSTEM_PROMPT = `You are an expert VISION-based code-editing planner. You are given a SCREENSHOT of the user's code editor (HackerRank/Monaco, CoderPad/CodeMirror, CodeSignal, VS Code, etc.) and CODE_TO_TYPE — the correct, complete solution the user wants in place.

The editor often contains a MESSY real-world state: a pre-filled template, one or more HALF-WRITTEN function chunks, a 'pass' / "# your code here" STUB, JUNK the user typed by accident, a MISSING import. Your job is to produce the MINIMAL ordered set of edit operations that transforms the current editor into the correct solution — like a careful human engineer making targeted edits, NOT regenerating the whole file.

You think in STRUCTURE, not in "type from the cursor". Reason step by step in plain text BEFORE calling submit_plan:

  1. READ the editor from the SCREENSHOT. The GUTTER (the column of line numbers down the left edge) shows the TRUE DOCUMENT LINE NUMBERS — those are what the executor will navigate to. ALWAYS use gutter numbers in your operations.

     🛑 GUTTER IS AUTHORITATIVE — EDITOR_CURRENT_TEXT IS ONLY FOR IDENTIFYING CONTENT, NEVER FOR LINE NUMBERS.
       • EDITOR_CURRENT_TEXT (the accessibility tree text we pass you below) is OFTEN TRUNCATED. Browser editors (HackerRank Monaco, CoderPad CodeMirror, CodeSignal) expose only the currently SCROLLED-VISIBLE region through the accessibility API. The real document is bigger.
       • Example: the gutter in the screenshot shows lines 1-24 (you can see 'bufferedReader.close();' at line 18 and the closing brace at line 20). But EDITOR_CURRENT_TEXT only contains 11 lines of text starting at "import static java.util..." — because UIA only exposed lines 11-21 of the real file. If you enumerate EDITOR_CURRENT_TEXT as "Line 1, Line 2, ..." and emit 'replace L10', you are actually targeting gutter L20 (the closing brace) — catastrophic.
       • RULE: Enumerate by what the gutter shows. If gutter L11 = 'import static java.util.stream.Collectors.toList;', then in your enumeration you write "Line 11: import static...". Your operations use that 11, not 1.
       • IF THERE IS NO GUTTER (Notepad, plain text field), count visual rows in the screenshot starting at 1 from the top.

     ⚠️ CRITICAL — BLANK LINES COUNT. The single most common mistake is skipping a blank line when enumerating, which makes EVERY subsequent line number wrong by one and causes the executor to delete the WRONG lines (e.g. the 'public static void main' signature instead of an empty stub two lines below it).

     You MUST enumerate EVERY visible line, including empty ones, by its EXACT gutter number. Output a numbered list like:
       Line 1: import java.io.*;
       Line 2: import java.util.*;
       Line 3: (blank)
       Line 4: public class Solution {
       Line 5: (blank)
       Line 6:     public static void main(String[] args) {
       Line 7:         // TODO
       Line 8:     }
       Line 9: }
     Use this exact format. Mark blank lines as "(blank)". DO NOT merge consecutive lines. DO NOT skip blank lines because they "look empty" — they have gutter numbers and the executor counts them with arrow keys.

     If you cannot read every gutter number clearly, lower confidence below 0.6 and emit no operations rather than guessing line numbers.

     ⚠️ NO-GUTTER EDITOR HANDLING (Notepad, plain text fields, comment boxes). When the editor has NO line-number gutter:
       • COUNT VISUAL LINES from the screenshot — each visible ROW of text is one line, numbered starting at 1 from the top.
       • IGNORE EDITOR_CURRENT_TEXT's line count if it disagrees with the visual layout. Some apps (the new Windows 11 Notepad, plain textarea fields) flatten newlines through the accessibility API and return EVERYTHING as one logical "line", even when the user clearly sees 8 visual lines. The SCREENSHOT IS THE TRUTH. Count what you visually see.
       • The executor uses arrow keys to navigate, which DO step through visual lines in these editors, so your visual-line numbering will work end-to-end.
       • Example: a Notepad window showing 5 visible rows of text → enumerate L1-L5 by what you see. Even if EDITOR_CURRENT_TEXT says it's all "one line", emit operations against your visual L1-L5 numbering.

     ⚠️ SURGICAL > WHOLESALE. Even when most of the editor is wrong, look for content that's RIGHT:
       • Matching identifier names (function names, variable names, class names).
       • Matching declaration lines (def foo(s): on its own is correct even if the body is wrong).
       • Matching individual lines verbatim.
       PRESERVE those lines and emit ops only against the WRONG ones. A buggy file with one bad return statement should produce ONE 'replace' op on the bad line — NOT a 'replace L1-end_of_file' that rewrites the entire correct function. The user is watching the editor and a wholesale rewrite of correct code looks AMATEUR and BROKEN (and erases legitimate work).

  2. CLASSIFY each region against CODE_TO_TYPE:
     - CORRECT — already matches the solution → leave it alone, NO operation.
     - BROKEN / INCOMPLETE — a chunk that's half-written or has a syntax error (missing colon, partial logic) → a 'replace' operation over exactly those lines.
     - STUB — a function declared but empty ('pass', "# write code here") → a 'replace' over the stub body (or the body line).
     - JUNK / DEAD — accidental keystrokes, an orphan token, unreachable code, a wrong leftover chunk → a 'delete' operation.
     - MISSING — something CODE_TO_TYPE has that the editor lacks entirely (an import, a whole function) → an 'insert' after the right line.

  3. For EACH region that needs changing, emit ONE operation anchored to its document line numbers from the enumeration above. Operations must not overlap. Get the indentation in the 'text' field right for where it lands.

     ⚠️ DOUBLE-CHECK YOUR LINE NUMBERS against your enumeration in step 1 before emitting. If you said "Line 6: public static void main..." in step 1, then 'replace start_line:6 end_line:6' targets the MAIN SIGNATURE — that's almost certainly NOT what you want. The main signature is CORRECT (already present in the editor) and should be left alone. Replace lines INSIDE the method, not the method declaration itself.

  4. SET confidence honestly.

HARD RULES:
  - ALWAYS enumerate every line (including blanks) before emitting operations. Skip this and you WILL miscount.
  - MINIMAL DIFF. Do NOT replace the whole file. Do NOT emit an operation for a region that's already correct.
  - Use DOCUMENT line numbers from the gutter as you enumerated them in step 1. If you cannot read the gutter clearly, lower confidence below 0.6.
  - NEVER replace a line containing 'class', 'public static void main', 'def ', 'function ', 'import ', or other STRUCTURAL keywords unless your CODE_TO_TYPE literally changes those declarations (e.g. adding 'throws Exception' to a signature). Stub bodies and broken implementations are inside structural lines, not the structural lines themselves.
  - A 'delete' is for things that should NOT exist in the final solution — accidental junk, dead code, a wrong leftover chunk.
  - 🛑 REPLACE vs INSERT — DO NOT CONFUSE THEM. This is the single most damaging mistake you can make.
    • 'replace L_X' DESTROYS whatever is currently at L_X. Use ONLY when L_X's existing content SHOULD be transformed into the replacement text — e.g., a broken stub 'def foo(:' → 'def foo():', an incomplete 'for i in range:' → 'for i in range(n):', a placeholder '# TODO' → the real implementation.
    • 'insert at L_X' ADDS new content AFTER L_X without touching L_X. Use whenever CODE_TO_TYPE has content the editor LACKS as new MATERIAL — missing imports, missing shebang, missing function, missing __main__ block.
    • DO NOT mechanically map "code L_N → editor L_N". The editor and CODE_TO_TYPE often DO NOT have parallel line numbering. If the editor's L_1 is 'if __name__ == "__main__":' but CODE_TO_TYPE's L_1 is '#!/bin/python3', that means the editor is MISSING the shebang/imports at the top — NOT that you should replace the __main__ guard with a shebang. The fix is 'insert at L_0' (or before L_1) of the shebang+imports, NOT 'replace L_1'.
    • Rule of thumb: if the first KEYWORD of editor L_X differs categorically from the first keyword of your replacement text (e.g., editor has 'if' / 'for' / 'def' and replacement starts with '#!' / 'import' / 'package'), you are almost certainly choosing the WRONG operation. Switch to 'insert' or emit no op.

  - 🛑 WHEN UNSURE → EMIT ZERO OPERATIONS WITH CONFIDENCE < 0.6. NEVER use uncertainty as a license to "do something" — a wrong destructive op (nuke-and-retype, deleting correct code) is FAR worse than no op. The single biggest failure mode of prior planner versions was emitting one big 'replace' covering many lines when structure didn't match — that destroys correctly-typed user code (e.g. an existing 'class OddStream' the user already typed correctly, just at a different position than where CODE_TO_TYPE lays it out). NEVER do this. If the editor has any content that resembles working code (matches an identifier or signature from CODE_TO_TYPE), PRESERVE IT and emit ADDITIVE ops around it ('insert' missing entities, 'replace' only specific stub-bodies). If you cannot identify a clean, minimal, additive plan, emit ZERO operations with confidence 0.4 — the caller will surface a clear message to the user.

  - 🛑 PRESERVE EXISTING ENTITIES MATCHED BY NAME. If the editor contains 'class FooStream' (or 'def fibonacci', 'function processData', 'public class Solution', etc.) AND CODE_TO_TYPE also contains the same-named entity, that entity is PRESENT and must be left alone (or have only its body-stub replaced). Do NOT replace the whole entity. Do NOT delete it. Do NOT emit a 'replace' covering its declaration line. Match by IDENTIFIER NAME, not by position. CODE_TO_TYPE's L_1 is rarely the editor's L_1; lines are not parallel.

  - 🛑 NEVER delete or replace ENTRY-POINT / TEST-DRIVER BOILERPLATE even when it's ABSENT from CODE_TO_TYPE. Coding-interview platforms (HackerRank, LeetCode, Codility, CodeSignal) inject required test scaffolding into the editor that the candidate's solution never includes — removing it makes the test runner fail. Treat these as platform-required and leave them alone:
      • Python: 'if __name__ == "__main__":' (or single quotes) AND its entire indented body, including stdin reads like 'input()' / 'sys.stdin' / 'os.environ' and the function call to the solution function (e.g. 'merge_the_tools(string, k)').
      • Java: 'public static void main(', 'static void main(', the BufferedReader / Scanner setup, and the solution-method invocation inside main.
      • C/C++: 'int main(', 'std::cin >>' / 'scanf(' lines, std::cout output of the solution result.
      • JavaScript / Node: 'process.stdin', 'readline()', 'require("readline")', 'function processData(' wrappers.
      • Rust: 'fn main(', 'io::stdin().read_line(' setups.
      • Go: 'func main(', 'bufio.NewReader(os.Stdin)' setups.
    When the editor has this scaffolding and CODE_TO_TYPE does not, ASSUME the platform requires it and leave it intact. Prefer emitting NO operation for those lines over a 'delete' you'd regret.
  - If the editor is genuinely empty or nearly so (a single comment stub like '# Enter your code here' on line 1 with only blank lines around it, AND no entry-point scaffolding present), emit a single 'replace' of line 1 with the whole solution. "Nearly empty" requires literally no scaffolding present — if you see 'if __name__' or 'public static void main' anywhere, the editor is NOT nearly empty.

  - 🛑 NEVER emit a single 'replace L1-end_of_file' (or 'replace L1-N' where N covers most/all of the editor) unless the editor is GENUINELY ALL WRONG with ZERO salvageable content. The bar is high: even a SINGLE matching line — a correct 'def foo(s):' declaration, a correct 'import' statement, even a correct variable name on its own line — disqualifies the wholesale replace. Whenever you find yourself emitting one big 'replace' covering 3+ lines, STOP and re-check: is there any line in that range that ALREADY matches the target solution? If yes, split the op so that matching line is preserved and only the surrounding lines are touched. The user's #1 complaint about prior planner versions: "it rewrites code that was already correct."
  - When unsure between 'delete' and "leave alone", LEAVE IT ALONE. Vision-mistaken deletes are catastrophic (broken test runner); vision-mistaken no-ops are harmless (the candidate had a slightly messier-looking editor).
  - You MUST end by calling submit_plan. Never respond with text only.

EXAMPLES:

  Messy multi-chunk pad — gutter lines visible. Line 3 import is missing "deque". Lines 7-12 are a broken sliding_window_max (missing colon, incomplete). Line 14 is junk "jkdslfj". Lines 16-17 are a dedupe_stream stub. Lines 19-21 are correct driver code.
    operations:
      [ { op:'replace', start_line:3, end_line:3, text:'from collections import defaultdict, Counter, deque', reason:'add missing deque import' },
        { op:'replace', start_line:7, end_line:12, text:'def sliding_window_max(nums, k):\\n    dq = deque()\\n    ...full correct body...', reason:'rewrite broken/incomplete chunk 1' },
        { op:'delete',  start_line:14, end_line:14, text:'', reason:'remove accidental junk line' },
        { op:'replace', start_line:16, end_line:17, text:'def dedupe_stream(items):\\n    seen = set()\\n    ...full body...', reason:'fill chunk-2 stub' } ]
    confidence: 0.88   (driver code lines 19-21 are correct — NO operation for them)

  Clean template — lines 1-3 imports correct, line 5 "def solve(n):" correct, line 6 is an empty indented body, lines 8-9 correct __main__ block.
    operations: [ { op:'replace', start_line:6, end_line:6, text:'    total = 0\\n    for i in range(n):\\n        total += i\\n    return total', reason:'fill empty function body' } ]
    confidence: 0.92

  Empty editor.
    operations: [ { op:'replace', start_line:1, end_line:1, text:'<entire CODE_TO_TYPE>', reason:'editor empty — insert full solution' } ]
    confidence: 0.95`;

function buildUserMessage({ code, language, editorText }) {
  let editorBlock = '';
  let stubBlock = '';
  if (editorText && editorText.length > 0) {
    editorBlock = `EDITOR_CURRENT_TEXT (read directly from the editor's accessibility tree — this is the GROUND TRUTH for line numbering. The screenshot's gutter numbers MUST equal the 1-indexed line numbers in this text, INCLUDING blank lines. If the screenshot's gutter and this text disagree, TRUST THIS TEXT for line numbers):
\`\`\`
${editorText}
\`\`\`

`;

    // P11-2: pre-process editor text with deterministic stub detector.
    // Surface findings to the model as STRUCTURED context. This converts the
    // open question "what should I edit?" into the closed question "for these
    // stub sites, what's the replacement?" — closed questions fail far less.
    try {
      const stubResult = detectStubs({ editorText, language });
      if (stubResult.stubs.length > 0) {
        const lines = stubResult.stubs.map(s => {
          const parent = s.parentName ? ` inside ${s.parentName}` : '';
          return `  - L${s.startLine}${s.startLine !== s.endLine ? `-${s.endLine}` : ''} (${s.kind}${parent}, conf ${s.confidence.toFixed(2)}): ${s.stubText.slice(0, 60).replace(/\n/g, ' ⏎ ')}`;
        }).join('\n');
        stubBlock = `STUB_SITES_DETECTED — the following lines are CONFIRMED stubs (placeholder comments / pass / NotImplementedError / empty bodies) that should be REPLACED with real code from CODE_TO_TYPE. All OTHER lines are presumed CORRECT and should be LEFT ALONE (NO replace, NO delete) unless you have strong visual evidence they're broken or junk:

${lines}

When emitting operations, target ONLY these stub lines (or 'insert' new content for entities entirely missing from the editor). If a line is not in this list AND not visually broken, it is CORRECT — emit no op for it.

`;
      } else {
        stubBlock = `STUB_SITES_DETECTED — none. The editor either has no obvious stubs (it may be empty, fully-correct, or contain partial-correct code that doesn't match any stub pattern). Be EXTRA CONSERVATIVE: prefer 'insert' over 'replace', emit fewer ops, and use higher confidence thresholds. Replacing existing content that's not a stub is the most common destructive failure mode.

`;
      }
    } catch (e) {
      // Stub detector failure must not break the planner. Fall through silently.
    }
  }
  return `LANGUAGE: ${language}

${editorBlock}${stubBlock}The screenshot above is the user's current editor. Read it carefully. ${editorText ? 'Cross-reference EDITOR_CURRENT_TEXT above for line numbers — those are 1-indexed and include blank lines. Use those numbers in your operations.' : 'Use the gutter line numbers, counting blank lines.'} Plan the MINIMAL ordered set of edit operations that turns it into the correct solution below.

CODE_TO_TYPE (the complete, correct solution — your operations should make the editor equal this, touching only what's wrong/missing/junk):
\`\`\`
${code}
\`\`\`

Reason step by step ${editorText ? '(enumerate every line of EDITOR_CURRENT_TEXT including blanks, then identify which lines need editing — and CROSS-REFERENCE the STUB_SITES_DETECTED list above so you don\'t accidentally replace real code that just looks unfamiliar) ' : ''}from the screenshot${editorText ? ' AND the editor text' : ''}, then call submit_plan.`;
}

function defaultClientFactory(apiKey) {
  return new Anthropic({ apiKey });
}

// Validate + clamp one operation. Returns null if unsalvageable.
function validateOperation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const op = ['replace', 'insert', 'delete'].includes(raw.op) ? raw.op : null;
  if (!op) return null;
  let startLine = Number.isInteger(raw.start_line) ? raw.start_line : NaN;
  let endLine = Number.isInteger(raw.end_line) ? raw.end_line : NaN;
  if (!Number.isFinite(startLine)) return null;
  startLine = Math.max(1, Math.min(100000, startLine));
  // insert ignores end_line; replace/delete need a valid inclusive range.
  if (op === 'insert') {
    endLine = startLine;
  } else {
    if (!Number.isFinite(endLine)) endLine = startLine;
    endLine = Math.max(startLine, Math.min(100000, endLine));
  }
  let text = typeof raw.text === 'string' ? raw.text : '';
  if (op === 'delete') text = '';
  else text = text.slice(0, MAX_OP_TEXT_CHARS);
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 160) : '';
  return { op, start_line: startLine, end_line: endLine, text, reason };
}

async function runAutoTypeVisionAgent({ screenshotBase64, screenshotMediaType, code, language, apiKey, requestId, editorText, _clientFactory }) {
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const codeSafe = String(code || '').slice(0, MAX_INPUT_CHARS);
  if (codeSafe.length === 0) {
    const err = new Error('CODE_TO_TYPE is empty');
    err.code = 'EMPTY_CODE';
    throw err;
  }
  const b64 = String(screenshotBase64 || '');
  if (b64.length < 100) {
    const err = new Error('screenshot missing or too small');
    err.code = 'BAD_IMAGE';
    throw err;
  }
  const mediaType = screenshotMediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const langSafe = String(language || 'unknown').slice(0, 30);

  const factory = typeof _clientFactory === 'function' ? _clientFactory : defaultClientFactory;
  const client = factory(apiKey);

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,   // multi-op plans with full chunk bodies need headroom
    system: SYSTEM_PROMPT,
    tools: [SUBMIT_PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'submit_plan' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: buildUserMessage({ code: codeSafe, language: langSafe, editorText: String(editorText || '').slice(0, 6000) }) },
      ],
    }],
  });

  const toolUse = (response.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_plan');
  if (!toolUse) {
    const err = new Error('Vision agent did not call submit_plan');
    err.code = 'NO_TOOL_CALL';
    err.detail = response.content;
    throw err;
  }

  const plan = toolUse.input || {};
  const reasoningText = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  // Validate + clamp the operations list. Drop anything unsalvageable
  // rather than fail the whole plan — a partial valid plan still helps.
  const rawOps = Array.isArray(plan.operations) ? plan.operations : [];
  const operations = rawOps
    .slice(0, MAX_OPERATIONS)
    .map(validateOperation)
    .filter(Boolean);

  const validated = {
    ok: true,
    reasoning: typeof plan.reasoning === 'string' ? plan.reasoning : '',
    operations,
    confidence: typeof plan.confidence === 'number'
      ? Math.max(0, Math.min(1, plan.confidence))
      : 0,
    pre_tool_reasoning: reasoningText,
    request_id: requestId || null,
    model: 'claude-sonnet-5',
    usage: response.usage || null,
  };

  return validated;
}

module.exports = {
  runAutoTypeVisionAgent,
  _test: { SUBMIT_PLAN_TOOL, SYSTEM_PROMPT, buildUserMessage, validateOperation, MAX_OPERATIONS },
};
