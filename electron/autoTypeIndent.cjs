// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  autoTypeIndent.cjs — "is the code indented the way we wrote it?"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//  THE HOLE THIS FILLS. Both existing checks strip ALL whitespace before
//  comparing — autoTypeVerifyMultiOp for "did each op land", and
//  autoTypeCoverage for "is the whole solution there". That is deliberate
//  and correct for what they measure: it makes them immune to reflow,
//  wrapping and line-splitting.
//
//  But it means the one thing that most plausibly goes wrong is the one
//  thing nobody looks at. The editor supplies its own indentation on every
//  Enter, our code carries its own, and the two have to be reconciled on
//  every line. Get it wrong in Java and the code is ugly. Get it wrong in
//  Python and the file does not run — while the verify says "all ops
//  present" and we report success into a live interview.
//
//  So this compares the leading whitespace, and nothing else.
//
//  ── WHY IT WILL NOT CRY WOLF ──
//  Every rule here exists to avoid a false alarm, because a warning that
//  fires on healthy runs is worse than no warning:
//   • Only lines whose stripped content appears EXACTLY ONCE in the editor
//     are compared. `continue` or `}` appear all over; matching the wrong
//     occurrence would invent a mismatch.
//   • Blank and near-empty lines are skipped — nothing to indent.
//   • A whole-block CONSTANT offset is not a mismatch. Pasting a method
//     body one level deeper than written is the editor's doing, still
//     valid code, and not something to alarm about; what matters is the
//     RELATIVE shape.
//   • Only fires on 2+ bad lines, or 1 with a tab/space conflict — the
//     one case a single line is enough to break a Python file outright.
//
//  Pure. No I/O. The caller gates it on a reliable UIA read, exactly as it
//  gates autoTypeCoverage.

// A line has to have real content before its indentation means anything —
// but the floor here is LOWER than the 8 used by the content checks, on
// purpose. There, length is what stops a short fragment matching the wrong
// place; here that job is already done by requiring the content to appear
// exactly once. Keeping 8 would have skipped `out = []` (6 stripped chars)
// and `else:` (5) — ordinary Python lines, and exactly the short ones a
// mis-predicted auto-indent lands on.
const MIN_LINE_CHARS = 5;

function leadingWhitespace(s) {
  const m = /^[ \t]*/.exec(String(s == null ? '' : s));
  return m ? m[0] : '';
}

function stripWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

/**
 * compareIndentation(intendedText, editorText)
 *
 * Returns {
 *   compared:   lines we could line up unambiguously
 *   mismatches: [{ line, expected, actual, tabMix }]
 *   offset:     the constant shift applied before comparing, if any
 *   ok:         nothing worth reporting
 * }
 */
function compareIndentation(intendedText, editorText) {
  const intendedLines = String(intendedText == null ? '' : intendedText).split('\n');
  const editorLines = String(editorText == null ? '' : editorText).split('\n');

  // Index the editor by stripped content, remembering duplicates so they
  // can be excluded rather than guessed at.
  const byContent = new Map();
  for (const raw of editorLines) {
    const key = stripWs(raw);
    if (!key) continue;
    if (byContent.has(key)) byContent.get(key).count++;
    else byContent.set(key, { indent: leadingWhitespace(raw), count: 1 });
  }

  const pairs = [];
  for (const raw of intendedLines) {
    const key = stripWs(raw);
    if (key.length < MIN_LINE_CHARS) continue;
    const hit = byContent.get(key);
    if (!hit || hit.count !== 1) continue;          // absent, or ambiguous
    pairs.push({ line: raw.trim(), expected: leadingWhitespace(raw), actual: hit.indent });
  }

  if (pairs.length === 0) {
    return { ok: true, compared: 0, mismatches: [], offset: 0, reason: 'nothing_comparable' };
  }

  // A block landing uniformly deeper (or shallower) than written is the
  // editor placing it, not a defect. Cancel the most common shift before
  // judging, so only lines that break the SHAPE are reported.
  const deltas = pairs.map(p => p.actual.length - p.expected.length);
  const tally = new Map();
  for (const d of deltas) tally.set(d, (tally.get(d) || 0) + 1);
  let offset = 0, best = -1;
  for (const [d, n] of tally) if (n > best) { best = n; offset = d; }

  const mismatches = [];
  for (const p of pairs) {
    // Mixing tabs and spaces on one line is never intentional here and is
    // an outright TabError in Python, so it counts however the lengths
    // happen to line up.
    const tabMix = (p.expected.includes('\t') !== p.actual.includes('\t'));
    const shapeOff = (p.actual.length - p.expected.length) !== offset;
    if (tabMix || shapeOff) {
      mismatches.push({
        line: p.line.slice(0, 60),
        expected: p.expected.length,
        actual: p.actual.length,
        tabMix,
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    compared: pairs.length,
    mismatches,
    offset,
  };
}

/**
 * Worth telling the user about?
 *
 * Conservative deliberately. This runs at the end of a successful-looking
 * run, and the cost of being wrong is undermining trust in a tool someone
 * is relying on mid-interview.
 */
function shouldReportIndent(result) {
  if (!result || result.ok) return false;
  if (result.mismatches.some(m => m.tabMix)) return true;   // breaks Python outright
  return result.mismatches.length >= 2;
}

module.exports = { compareIndentation, shouldReportIndent, MIN_LINE_CHARS };
