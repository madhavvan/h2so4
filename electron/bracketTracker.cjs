// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BRACKET TRACKER — string/comment-aware bracket pair detector.
//
//  PURPOSE: After auto-typing, verify the editor's brackets are still
//  balanced. The user's specific failure scenario: a 'replace L3' that
//  deletes a `# YOUR CODE HERE` comment can collaterally destroy a `}`
//  that was on line 4 if the planner miscounted. The result: an
//  unclosed `{` somewhere above, code doesn't parse, user is stuck
//  mid-interview with no idea what's wrong.
//
//  This module detects bracket imbalance per language (Python, JS, TS,
//  Java, C, C++, Go, Rust, Ruby, Kotlin, Swift). Tokenizes only enough
//  to skip brackets inside strings and comments — the #1 source of
//  false positives. Then runs a stack-based pairing pass and returns
//  any unmatched opens / unexpected closes with their (line, col).
//
//  Used by verify+repair in main.cjs:
//    1. Compare bracketsBefore vs bracketsAfter
//    2. New unmatched in After but not Before = damage we caused
//    3. Emit surgical insertChar ops to fix (capped at ≤2 missing
//       brackets — beyond that, escalate to vision repair)
//
//  All output is deterministic, no LLM. ~5ms on a 500-line file.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// String-quote definitions per language. Each entry is {open, close,
// allowEscape (whether \\ escapes the close char), multiline}.
const STRING_QUOTES = {
  python: [
    { open: '"""', close: '"""', allowEscape: false, multiline: true },
    { open: "'''", close: "'''", allowEscape: false, multiline: true },
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  javascript: [
    { open: '`', close: '`', allowEscape: true, multiline: true },
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  typescript: [
    { open: '`', close: '`', allowEscape: true, multiline: true },
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  java: [
    { open: '"""', close: '"""', allowEscape: false, multiline: true },
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  c: [
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  cpp: [
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  go: [
    { open: '`', close: '`', allowEscape: false, multiline: true },
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  rust: [
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  ruby: [
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  kotlin: [
    { open: '"""', close: '"""', allowEscape: false, multiline: true },
    { open: '"', close: '"', allowEscape: true, multiline: false },
    { open: "'", close: "'", allowEscape: true, multiline: false },
  ],
  swift: [
    { open: '"""', close: '"""', allowEscape: true, multiline: true },
    { open: '"', close: '"', allowEscape: true, multiline: false },
  ],
};

// Comment markers per language. {lineComment, blockOpen, blockClose}
const COMMENT_MARKERS = {
  python: { line: '#', block: null },
  javascript: { line: '//', block: { open: '/*', close: '*/' } },
  typescript: { line: '//', block: { open: '/*', close: '*/' } },
  java: { line: '//', block: { open: '/*', close: '*/' } },
  c: { line: '//', block: { open: '/*', close: '*/' } },
  cpp: { line: '//', block: { open: '/*', close: '*/' } },
  go: { line: '//', block: { open: '/*', close: '*/' } },
  rust: { line: '//', block: { open: '/*', close: '*/' } },
  ruby: { line: '#', block: { open: '=begin', close: '=end' } },
  kotlin: { line: '//', block: { open: '/*', close: '*/' } },
  swift: { line: '//', block: { open: '/*', close: '*/' } },
};

const PAIRS = { '(': ')', '[': ']', '{': '}' };
const OPENS = new Set(Object.keys(PAIRS));
const CLOSES = new Set(Object.values(PAIRS));

function normalizeLang(lang) {
  const l = String(lang || '').toLowerCase().trim();
  if (l === 'py' || l === 'python3' || l === 'python2') return 'python';
  if (l === 'js' || l === 'node') return 'javascript';
  if (l === 'ts') return 'typescript';
  if (l === 'c++' || l === 'cxx') return 'cpp';
  if (l === 'rs') return 'rust';
  if (l === 'kt') return 'kotlin';
  if (l === 'rb') return 'ruby';
  return l;
}

// Walk the text once, tracking string/comment state, and call cb(char, line, col)
// for each bracket character encountered in CODE context (not inside strings/comments).
function walkBrackets(text, lang, cb) {
  const language = normalizeLang(lang);
  const quotes = STRING_QUOTES[language] || STRING_QUOTES.javascript;
  const comments = COMMENT_MARKERS[language] || { line: null, block: null };

  let i = 0;
  let line = 1;
  let col = 0;
  const n = text.length;
  let inString = null;     // active quote {open, close, allowEscape, multiline}
  let inBlockComment = false;

  while (i < n) {
    const ch = text[i];

    // Track line/col
    if (ch === '\n') {
      // In string mode: end if not multiline
      if (inString && !inString.multiline) inString = null;
      line++;
      col = 0;
      i++;
      continue;
    }

    // Inside block comment: only look for close marker
    if (inBlockComment) {
      if (comments.block && text.substr(i, comments.block.close.length) === comments.block.close) {
        i += comments.block.close.length;
        col += comments.block.close.length;
        inBlockComment = false;
        continue;
      }
      i++; col++;
      continue;
    }

    // Inside string: look for close (handle escapes)
    if (inString) {
      if (inString.allowEscape && ch === '\\') {
        i += 2; col += 2;
        continue;
      }
      if (text.substr(i, inString.close.length) === inString.close) {
        i += inString.close.length;
        col += inString.close.length;
        inString = null;
        continue;
      }
      i++; col++;
      continue;
    }

    // Not in string/comment. Check for string start, comment start, or bracket.
    // Block comment open?
    if (comments.block && text.substr(i, comments.block.open.length) === comments.block.open) {
      i += comments.block.open.length;
      col += comments.block.open.length;
      inBlockComment = true;
      continue;
    }

    // Line comment open?
    if (comments.line && text.substr(i, comments.line.length) === comments.line) {
      // Skip to end of line
      const eol = text.indexOf('\n', i);
      if (eol < 0) return;
      col += (eol - i);
      i = eol;
      continue;
    }

    // String start? Test longer quotes first (e.g. """ before ").
    let matchedQuote = null;
    for (const q of quotes) {
      if (text.substr(i, q.open.length) === q.open) {
        matchedQuote = q;
        break;
      }
    }
    if (matchedQuote) {
      i += matchedQuote.open.length;
      col += matchedQuote.open.length;
      inString = matchedQuote;
      continue;
    }

    // Bracket?
    if (OPENS.has(ch) || CLOSES.has(ch)) {
      cb(ch, line, col);
    }

    i++; col++;
  }
}

// Run bracket pairing. Returns { unclosed: [...opens], orphans: [...closes], pairs: [...] }
function balance(text, lang) {
  const stack = [];
  const pairs = [];
  const orphans = [];

  walkBrackets(text, lang, (ch, line, col) => {
    if (OPENS.has(ch)) {
      stack.push({ char: ch, line, col });
    } else if (CLOSES.has(ch)) {
      const top = stack[stack.length - 1];
      if (top && PAIRS[top.char] === ch) {
        stack.pop();
        pairs.push({ open: top, close: { char: ch, line, col } });
      } else {
        orphans.push({ char: ch, line, col, expected: top ? PAIRS[top.char] : null });
      }
    }
  });

  return {
    unclosed: stack,    // each is {char, line, col}
    orphans,            // each is {char, line, col, expected}
    pairs,              // each is {open, close}
    balanced: stack.length === 0 && orphans.length === 0,
  };
}

// Compute the DAMAGE diff between two bracket states (typically before/after
// auto-typing). Returns issues that exist in `after` but not in `before` —
// i.e., damage we caused, not pre-existing imbalances.
function diffBalance(before, after) {
  // For "unclosed" issues, key by (line, col, char). Issues in after but not in before are new.
  const beforeUnclosedSet = new Set(before.unclosed.map(u => `${u.line}:${u.col}:${u.char}`));
  const beforeOrphansSet = new Set(before.orphans.map(o => `${o.line}:${o.col}:${o.char}`));

  const newUnclosed = after.unclosed.filter(u => !beforeUnclosedSet.has(`${u.line}:${u.col}:${u.char}`));
  const newOrphans = after.orphans.filter(o => !beforeOrphansSet.has(`${o.line}:${o.col}:${o.char}`));

  // Also: pairs LOST in after (existed in before but not in after).
  const afterPairKeys = new Set(after.pairs.map(p => `${p.open.line}:${p.open.col}-${p.close.line}:${p.close.col}`));
  const lostPairs = before.pairs.filter(p => !afterPairKeys.has(`${p.open.line}:${p.open.col}-${p.close.line}:${p.close.col}`));

  return {
    newUnclosed,
    newOrphans,
    lostPairs,
    netDamage: newUnclosed.length + newOrphans.length,
  };
}

// Compute a surgical repair plan for an after-state's bracket imbalance.
// For each new unclosed open `{` at line X, we want to insert the matching
// close `}` at the END of the line BEFORE the next "natural terminator"
// (next non-blank line whose indent is ≤ open's line indent).
//
// Returns an array of {action: 'insert', line, col, char} or empty if
// repair is too risky (e.g., > 2 imbalances → escalate).
function planSurgicalRepair(afterBalance, afterText) {
  const issues = afterBalance.unclosed.length + afterBalance.orphans.length;
  if (issues === 0) return { ok: true, ops: [], reason: 'balanced' };
  if (issues > 2) return { ok: false, reason: `too_many_issues_${issues}`, ops: [] };

  const lines = afterText.split('\n');
  const ops = [];

  // For each unclosed open, find a sane insertion point for the matching close.
  for (const open of afterBalance.unclosed) {
    const closeChar = PAIRS[open.char];
    // Find the line where indent first becomes ≤ open's line's indent
    // (or EOF). Insert close at end of the previous non-blank line.
    const openLineIdx = open.line - 1;
    const openLineIndent = (lines[openLineIdx] || '').match(/^[\t ]*/)[0].length;
    let insertAfterLine = lines.length;  // default to EOF
    for (let i = openLineIdx + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) continue;
      const indent = ln.match(/^[\t ]*/)[0].length;
      if (indent <= openLineIndent) {
        insertAfterLine = i;  // insert close BEFORE this line (at end of previous non-blank)
        break;
      }
    }
    // Find the LAST non-blank line strictly before insertAfterLine.
    let targetLine = insertAfterLine - 1;
    while (targetLine > openLineIdx && !(lines[targetLine] || '').trim()) targetLine--;
    const targetText = lines[targetLine] || '';
    ops.push({
      action: 'insert',
      line: targetLine + 1,     // 1-indexed
      col: targetText.length,    // end of line
      char: closeChar,
      reason: `close unclosed ${open.char} from L${open.line}`,
    });
  }

  // For each orphan close, just delete it (the simplest surgical fix).
  for (const orphan of afterBalance.orphans) {
    ops.push({
      action: 'delete',
      line: orphan.line,
      col: orphan.col,
      char: orphan.char,
      reason: `delete orphan ${orphan.char} at L${orphan.line}`,
    });
  }

  return { ok: true, ops, reason: 'surgical' };
}

module.exports = {
  balance,
  diffBalance,
  planSurgicalRepair,
  _test: { walkBrackets, normalizeLang, STRING_QUOTES, COMMENT_MARKERS },
};
