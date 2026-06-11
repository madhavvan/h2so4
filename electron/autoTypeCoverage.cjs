// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  autoTypeCoverage.cjs — "did we actually write the whole solution?"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//  Why: the post-write verify (autoTypeVerifyMultiOp) only checks that
//  each EMITTED operation's text landed in the editor. It is blind to the
//  case where the planner UNDER-PLANNED — it never emitted an op for a
//  chunk at all, or an op's text was itself incomplete, or the executor
//  silently dropped one. In all those cases every emitted op verifies as
//  "present" yet the editor still does not contain the full target
//  solution. The user sees a half-finished answer and we reported success.
//
//  This module answers the complementary question: of the MEANINGFUL lines
//  in CODE_TO_TYPE, how many are actually present in the editor right now?
//  The lines that aren't = coverage gaps. The caller (main.cjs) uses a gap
//  to TRIGGER the same vision-repair pass that the missing-op path uses —
//  so this adds detection, not a new always-on cost.
//
//  Normalization MATCHES autoTypeVerifyMultiOp exactly so the two agree on
//  what "present" means: strip ALL whitespace, require >=8 chars, substring
//  test against the whitespace-stripped editor blob. Whitespace-stripping
//  makes the check immune to indentation / reflow / line-splitting (the
//  editor's newlines vanish too, so a target line split across two editor
//  rows still matches).
//
//  ⚠️ This must ONLY be run when the editor's UIA text is RELIABLE (not a
//  browser-hosted Monaco/CodeMirror, where UIA exposes only the scrolled-
//  visible region — there, most of the target would look "missing" and
//  every run would false-trigger). The caller enforces that gate; this
//  module is pure and makes no I/O.

const MIN_LINE_CHARS = 8;   // matches autoTypeVerifyMultiOp's per-op floor

function _stripWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

// computeCoverageGaps(targetCode, editorText)
//   targetCode: the CODE_TO_TYPE the planner was asked to produce
//   editorText: the post-write editor contents (reliable UIA read)
// returns {
//   meaningfulTotal: number of target lines we actually checked,
//   missingLines:    [{ line: <original target line>, stripped: <ws-stripped> }],
//   coverageRatio:   present / meaningfulTotal  (1 when nothing meaningful, i.e. trivially covered),
// }
function computeCoverageGaps(targetCode, editorText) {
  const editorBlob = _stripWs(editorText);
  const targetLines = String(targetCode == null ? '' : targetCode).split('\n');

  const missingLines = [];
  let meaningfulTotal = 0;

  for (const raw of targetLines) {
    const stripped = _stripWs(raw);
    // Skip trivial lines: blanks, lone brackets/colons, short fragments.
    // These are noisy (a lone `}` appears all over) and not diagnostic of
    // a missing CHUNK — chunk-level content is always longer than 8 chars.
    if (stripped.length < MIN_LINE_CHARS) continue;
    meaningfulTotal++;
    if (!editorBlob.includes(stripped)) {
      missingLines.push({ line: raw, stripped });
    }
  }

  const present = meaningfulTotal - missingLines.length;
  const coverageRatio = meaningfulTotal === 0 ? 1 : present / meaningfulTotal;
  return { meaningfulTotal, missingLines, coverageRatio };
}

// shouldTriggerRepair(gaps) — the decision rule, kept here so it's tested
// alongside the math. Conservative on purpose: a single missing line only
// counts if it's substantial; otherwise require >=2 missing meaningful
// lines. Combined with the caller's reliableUia gate this keeps false
// triggers (which cost one wasted vision call) rare.
function shouldTriggerRepair(gaps) {
  if (!gaps || gaps.meaningfulTotal === 0) return false;
  const n = gaps.missingLines.length;
  if (n === 0) return false;
  if (n >= 2) return true;
  // exactly one missing line — only act if it's a substantial chunk line
  return gaps.missingLines[0].stripped.length >= 20;
}

module.exports = { computeCoverageGaps, shouldTriggerRepair, MIN_LINE_CHARS };
