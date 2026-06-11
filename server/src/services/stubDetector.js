// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STUB DETECTOR — Deterministic pre-processor for auto-type planner.
//
//  PURPOSE — gives the vision LLM independent ground-truth knowledge of
//  which lines are stubs to FILL vs sacred lines to PRESERVE. Without
//  this, vision reasons blind: "is this `def fibonacci` line one the
//  user wants regenerated or one I should leave alone?" — a question
//  vision can only answer by reading minds. With it, vision is told
//  "L3 and L5 are stubs, the rest is real code." That closed-question
//  reframing is what makes the planner surgically intelligent instead
//  of "nuke and retype."
//
//  This module is INDEPENDENT of the LLM. Pure regex + heuristics. Runs
//  in <5ms on a 200-line file. No external deps.
//
//  Output schema:
//    {
//      stubs: [{
//        startLine: 1-indexed inclusive,
//        endLine: 1-indexed inclusive,
//        kind: 'comment' | 'body-literal' | 'empty-body' | 'mixed',
//        parentName: string | null,        // 'fibonacci', 'Solution.twoSum', etc.
//        confidence: 0..1,
//        stubText: string,                  // verbatim, for logging
//        reasons: string[],                 // human-readable
//      }],
//      detected_count: number,
//      language: string,
//    }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Universal stub-comment phrases (case-insensitive). Strong stub signal.
const STUB_PHRASE_RE = /\b(your code here|write your code|enter your code|implement (this|me|here)|code goes here|solution goes here|write solution|fill in|complete (the |this )?(function|method|implementation)|return (the )?(answer|result|solution) here|do not (modify|edit|change)|your implementation|finish (the )?(function|method)|todo|fixme|hack(?!\w))/i;

// Phrases that REDUCE stub confidence (look like real explanatory comments).
const EXPLANATORY_RE = /\b(my approach|because|since|note that|this works|complexity|o\(|two[- ]pointer|sliding window|dp\b|dynamic programming|greedy|recursion|backtrack|edge case|invariant|assumption|optimization)\b/i;

// Per-language body-stub literals (single-line patterns inside a function body
// that mean "no real code here").
const BODY_STUB_RE = {
  python: /^\s*(pass|\.\.\.|raise\s+NotImplementedError|return\s+None\s*(#|$))\s*(#|$)/,
  java: /^\s*(throw\s+new\s+(UnsupportedOperationException|RuntimeException|NotImplementedException)|return\s+(null|0|false|""|0\.0)\s*;\s*\/\/\s*(TODO|implement|stub))/,
  javascript: /^\s*(throw\s+new\s+Error\s*\(\s*['"]Not implemented|return\s+(undefined|null|0|false|""|\[\]|\{\})\s*;?\s*\/\/\s*(TODO|stub|implement))/,
  typescript: /^\s*(throw\s+new\s+Error\s*\(\s*['"]Not implemented|return\s+(undefined|null|0|false|""|\[\]|\{\})\s*;?\s*\/\/\s*(TODO|stub|implement))/,
  cpp: /^\s*(assert\s*\(\s*0\s*&&\s*"not implemented"|abort\s*\(\s*\)\s*;\s*\/\/\s*(TODO|stub)|return\s+(0|false|nullptr)\s*;\s*\/\/\s*(TODO|stub))/,
  c: /^\s*(assert\s*\(\s*0\s*\)\s*;|abort\s*\(\s*\)\s*;\s*\/\/\s*(TODO|stub)|return\s+(0|NULL)\s*;\s*\/\/\s*(TODO|stub))/,
  go: /^\s*(panic\s*\(\s*"not implemented"|panic\s*\(\s*"TODO"|return\s+(nil|""|0)\s*\/\/\s*(TODO|stub))/,
  rust: /^\s*(unimplemented!\s*\(\s*\)|todo!\s*\(\s*\)|panic!\s*\(\s*"not implemented")/,
  ruby: /^\s*(raise\s+NotImplementedError|raise\s+["']TODO)/,
  kotlin: /^\s*(TODO\s*\(\s*\)|throw\s+NotImplementedError|error\s*\(\s*"not implemented")/,
  swift: /^\s*(fatalError\s*\(\s*"not implemented"|preconditionFailure\s*\(\s*"TODO")/,
};

// Per-language single-line comment prefixes.
const LINE_COMMENT_PREFIX = {
  python: '#',
  ruby: '#',
  perl: '#',
  shell: '#',
  java: '//',
  javascript: '//',
  typescript: '//',
  cpp: '//',
  c: '//',
  go: '//',
  rust: '//',
  kotlin: '//',
  swift: '//',
  scala: '//',
  csharp: '//',
  php: '//',
};

// Per-language function/class declaration matchers. Captures the NAME in $1
// (or $2 depending on pattern). Used to find the enclosing entity of a stub.
const ENTITY_DECL_RE = {
  python: /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/,
  java: /^\s*(?:public|private|protected|static|final|abstract|\s)*(?:class|interface|enum|void|[\w<>\[\],\s]+?)\s+(\w+)\s*[({]/,
  javascript: /^\s*(?:export\s+(?:default\s+)?)?(?:class|function|async\s+function)\s+(\w+)|^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:\(|async\s*\(|function)/,
  typescript: /^\s*(?:export\s+(?:default\s+)?)?(?:class|interface|function|async\s+function)\s+(\w+)|^\s*(?:const|let|var)\s+(\w+)\s*[:=]/,
  cpp: /^\s*(?:template\s*<[^>]*>\s*)?(?:[\w:*&<>,\s]+?)\s+(\w+)\s*\([^;]*\)\s*(?:const)?\s*\{|^\s*(?:class|struct|namespace)\s+(\w+)/,
  c: /^\s*(?:[\w*\s]+?)\s+(\w+)\s*\([^;]*\)\s*\{|^\s*(?:struct|union|enum)\s+(\w+)/,
  go: /^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)/,
  rust: /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+(\w+)/,
  ruby: /^\s*(?:class|module|def)\s+(\w+)/,
  kotlin: /^\s*(?:(?:public|private|internal|fun|val|var|class|interface|object)\s+)+(\w+)/,
  swift: /^\s*(?:(?:public|private|internal|fileprivate|func|var|let|class|struct|enum|protocol)\s+)+(\w+)/,
  scala: /^\s*(?:(?:def|val|var|class|trait|object)\s+)(\w+)/,
};

// Brace-language detection (uses `{` `}` for blocks).
const BRACE_LANGUAGES = new Set(['java', 'javascript', 'typescript', 'cpp', 'c', 'go', 'rust', 'kotlin', 'swift', 'scala', 'csharp', 'php']);

// Normalize a language hint to one of our supported keys.
function normalizeLang(lang) {
  const l = String(lang || '').toLowerCase().trim();
  if (l === 'py' || l === 'python3' || l === 'python2') return 'python';
  if (l === 'js' || l === 'node') return 'javascript';
  if (l === 'ts') return 'typescript';
  if (l === 'c++' || l === 'cxx') return 'cpp';
  if (l === 'rs') return 'rust';
  if (l === 'kt') return 'kotlin';
  if (l === 'rb') return 'ruby';
  if (l === 'cs' || l === 'c#') return 'csharp';
  return l;
}

// Get the comment prefix for a language, or null if unknown.
function commentPrefixFor(lang) {
  return LINE_COMMENT_PREFIX[lang] || null;
}

// Test if a line is a comment in the given language (single-line only).
function isCommentLine(line, lang) {
  const prefix = commentPrefixFor(lang);
  if (!prefix) return false;
  return new RegExp(`^\\s*${prefix.replace(/\//g, '\\/')}`).test(line);
}

// Strip a single-line comment prefix and return the text inside.
function stripCommentPrefix(line, lang) {
  const prefix = commentPrefixFor(lang);
  if (!prefix) return line.trim();
  return line.replace(new RegExp(`^\\s*${prefix.replace(/\//g, '\\/')}\\s?`), '').trim();
}

// Find the enclosing entity (class/function) for a given line index.
// Walks backwards from `lineIdx` looking for a declaration whose indent is
// less than (or equal to, in Python's case) the stub line's indent.
function findEnclosingEntity(lines, lineIdx, lang) {
  const declRe = ENTITY_DECL_RE[lang];
  if (!declRe) return null;
  const stubIndent = leadingIndent(lines[lineIdx] || '');
  for (let i = lineIdx - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    const lnIndent = leadingIndent(ln);
    if (lnIndent < stubIndent || (lang === 'python' && lnIndent === stubIndent && /^\s*(def|class|async)/.test(ln))) {
      const m = ln.match(declRe);
      if (m) return m[1] || m[2] || null;
    }
  }
  return null;
}

function leadingIndent(line) {
  const m = line.match(/^[\t ]*/);
  return m ? m[0].length : 0;
}

// Score a stub-comment run for stub-likelihood.
function scoreCommentStub(runLines, lang) {
  const reasons = [];
  let score = 0;

  // Concatenate the comment text (after stripping prefixes) for phrase matching.
  const combinedText = runLines.map(l => stripCommentPrefix(l, lang)).join(' ');

  if (STUB_PHRASE_RE.test(combinedText)) {
    score += 0.55;
    reasons.push('matched stub phrase');
  }
  if (EXPLANATORY_RE.test(combinedText)) {
    score -= 0.40;
    reasons.push('matched explanatory marker (penalty)');
  }

  // Each line of a stub tends to be short.
  const avgLen = combinedText.length / runLines.length;
  if (avgLen < 40) {
    score += 0.10;
    reasons.push('short comment lines');
  }

  // TODO/FIXME alone is a strong signal even without other phrases.
  if (/^\s*(?:#|\/\/)\s*(TODO|FIXME|XXX)\b/i.test(runLines[0])) {
    score += 0.15;
    reasons.push('TODO/FIXME marker');
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

// Find contiguous runs of comment lines.
function findCommentRuns(lines, lang) {
  const runs = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i], lang)) {
      if (!current) current = { start: i, end: i, lines: [lines[i]] };
      else { current.end = i; current.lines.push(lines[i]); }
    } else {
      if (current) { runs.push(current); current = null; }
    }
  }
  if (current) runs.push(current);
  return runs;
}

// Find body-literal stubs (pass, NotImplementedError, etc.).
function findBodyLiteralStubs(lines, lang) {
  const re = BODY_STUB_RE[lang];
  if (!re) return [];
  const stubs = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      stubs.push({ start: i, end: i, kind: 'body-literal', text: lines[i] });
    }
  }
  return stubs;
}

// Main detection function.
function detectStubs({ editorText, language }) {
  const lang = normalizeLang(language);
  const lines = String(editorText || '').replace(/\r\n/g, '\n').split('\n');
  const stubs = [];

  // Pass 1: body-literal stubs (pass, NotImplementedError, etc.)
  for (const lit of findBodyLiteralStubs(lines, lang)) {
    const parentName = findEnclosingEntity(lines, lit.start, lang);
    stubs.push({
      startLine: lit.start + 1,  // 1-indexed
      endLine: lit.end + 1,
      kind: 'body-literal',
      parentName,
      confidence: 0.85,
      stubText: lit.text.trim(),
      reasons: ['matched body-literal stub pattern'],
    });
  }

  // Pass 2: comment-run stubs
  for (const run of findCommentRuns(lines, lang)) {
    const { score, reasons } = scoreCommentStub(run.lines, lang);
    if (score < 0.40) continue;
    // Skip if a body-literal stub already covers this range.
    if (stubs.some(s => s.startLine <= run.start + 1 && s.endLine >= run.end + 1)) continue;
    const parentName = findEnclosingEntity(lines, run.start, lang);
    stubs.push({
      startLine: run.start + 1,
      endLine: run.end + 1,
      kind: 'comment',
      parentName,
      confidence: score,
      stubText: run.lines.join('\n').trim(),
      reasons,
    });
  }

  // Pass 3: detect entirely-empty function bodies (Python `def f(): pass` is
  // already in Pass 1, but brace-langs with `{ }` on adjacent lines need this).
  if (BRACE_LANGUAGES.has(lang)) {
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i].trimEnd();
      const next = lines[i + 1].trim();
      if (/\{\s*$/.test(cur) && next === '}') {
        const parentName = findEnclosingEntity(lines, i, lang);
        stubs.push({
          startLine: i + 2,
          endLine: i + 1,  // empty range — to be filled BETWEEN line i+1 and i+2
          kind: 'empty-body',
          parentName,
          confidence: 0.90,
          stubText: '',
          reasons: ['empty brace-body detected'],
        });
      }
    }
  }

  // Sort by line, dedup overlaps (prefer higher confidence).
  stubs.sort((a, b) => a.startLine - b.startLine || b.confidence - a.confidence);
  const dedup = [];
  for (const s of stubs) {
    const overlap = dedup.find(d => !(s.endLine < d.startLine || s.startLine > d.endLine));
    if (!overlap) dedup.push(s);
  }

  return {
    stubs: dedup,
    detected_count: dedup.length,
    language: lang,
  };
}

module.exports = { detectStubs, _test: { normalizeLang, leadingIndent, findEnclosingEntity, scoreCommentStub, BODY_STUB_RE, STUB_PHRASE_RE } };
