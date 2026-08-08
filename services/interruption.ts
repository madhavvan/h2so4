// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  INTERRUPTION HANDLING — backchannel immunity + follow-up context
//
//  Two live-interview realities this module models:
//
//  1. BACKCHANNELS. While the candidate speaks, the interviewer emits
//     listening sounds — "hmm", "okay", "right", "got it". With
//     auto-send on, each of those used to fire executeSend, which
//     CANCELLED the in-flight streaming answer (executeSend starts with
//     cancelActiveStream) and burned a full model call just for the
//     noise gate to reply "...". The candidate watched their own answer
//     vanish mid-sentence because the interviewer said "mm-hm".
//     isBackchannelOnly() is a strict client-side filter: the ENTIRE
//     buffered transcript must consist of known acknowledgment tokens
//     (≤4 words) — "okay, now design a cache" contains real content and
//     passes through untouched. Deliberately conservative: dropping a
//     legitimate question is far worse than one wasted noise-gate call,
//     which remains the server-side backstop for anything missed.
//
//  2. FOLLOW-UPS MID-ANSWER. The interviewer often asks the next
//     question seconds into the answer. The model needs to know: what
//     was asked before, what answer was on screen, how far the
//     candidate plausibly got SAYING it aloud (~2.3 words/sec — text
//     streams far faster than speech), and that the new input may be a
//     follow-up, a narrowing, or a redirect. buildInterruptionContext()
//     packages exactly that; it rides on the outgoing user message
//     (never the system prompt — prompt-cache stability) while the
//     visible chat bubble keeps only the clean transcript.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Conversational speaking rate. 140 wpm is the low-middle of normal
// speech — underestimating slightly is safer: the model then assumes a
// bit LESS was said aloud, and re-grounding early beats skipping ahead.
export const SPOKEN_WORDS_PER_SEC = 2.3;

// Every token here is a pure listening acknowledgment. Words that could
// open a real question or carry an answer ("no", "why", "wait", "what")
// are deliberately absent.
const BACKCHANNEL_TOKENS = new Set([
  'hmm', 'hm', 'mm', 'mmm', 'mhm', 'mm-hmm', 'mmhmm', 'uh-huh', 'uhhuh', 'huh',
  'okay', 'ok', 'kay', 'yeah', 'yep', 'yes', 'ya', 'right', 'sure', 'alright',
  'cool', 'nice', 'great', 'good', 'perfect', 'fine', 'awesome', 'excellent',
  'gotcha', 'got', 'it', 'i', 'see', 'understood', 'interesting', 'correct',
  'exactly', 'makes', 'sense', 'true', 'fair', 'agreed', 'indeed',
  'go', 'ahead', 'keep', 'going', 'continue', 'carry', 'on', 'please',
  'thanks', 'thank', 'you', 'so',
]);

export function isBackchannelOnly(text: string): boolean {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z'\- ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.every(w => BACKCHANNEL_TOKENS.has(w));
}

export interface SpokenSplit {
  spoken: string;      // the prefix the candidate plausibly said aloud
  spokenWords: number;
  totalWords: number;
}

// Estimate how much of the on-screen answer was actually SAID by the
// time the interruption arrived. Streaming text outruns speech by 5-20x,
// so "what's on screen" and "what was heard" diverge fast.
export function estimateSpokenSplit(answerText: string, elapsedMs: number): SpokenSplit {
  const words = String(answerText || '').trim().split(/\s+/).filter(Boolean);
  const spokenWords = Math.max(0, Math.min(words.length, Math.floor((elapsedMs / 1000) * SPOKEN_WORDS_PER_SEC)));
  return {
    spoken: words.slice(0, spokenWords).join(' '),
    spokenWords,
    totalWords: words.length,
  };
}

// Cap the on-screen answer we replay to the model: head carries the
// commitments, tail carries where it stopped. Middle elision is fine —
// the full text is already in chat history.
function capAnswer(text: string): string {
  const t = String(text || '').trim();
  if (t.length <= 900) return t;
  return `${t.slice(0, 650)} [...] ${t.slice(-200)}`;
}

export function buildInterruptionContext(args: {
  prevQuestion: string;
  answerSoFar: string;
  elapsedMs: number;
}): string {
  const { prevQuestion, answerSoFar, elapsedMs } = args;
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  const split = estimateSpokenSplit(answerSoFar, elapsedMs);
  const spokenLine = split.spokenWords === 0
    ? 'You had NOT started speaking it aloud yet — the interviewer cut in immediately.'
    : split.spokenWords >= split.totalWords
      ? 'You had likely finished saying all of it aloud.'
      : `At a natural speaking pace you likely only said aloud: "${split.spoken}" — the rest was on screen but probably NOT spoken yet.`;

  return `[INTERRUPTION CONTEXT — the interviewer spoke while you were mid-answer.
Previous question: "${String(prevQuestion || '').slice(0, 400)}"
Your answer so far (visible on screen): "${capAnswer(answerSoFar)}"
The interruption came about ${secs}s in. ${spokenLine}

First decide what the new input actually is, then answer accordingly:
- ADD-ON to the previous question — an example, a constraint, or a narrowed scope ("for a payment API", "like Instagram specifically", "for example, credit-card fraud", "but with millions of users"). This is the common case. Treat the PREVIOUS QUESTION and this addition as ONE combined question and answer THAT combined question. Carry over the approach you already committed to and specialize it to the addition — do NOT answer the addition as a separate topic, and do NOT restart from scratch. Continue from the part you actually said aloud, then go deeper on the specifics the addition introduces.
- FOLLOW-UP that builds on your answer — continue naturally from where you actually got to, without repeating what you already said.
- REDIRECT to a genuinely new topic — pivot cleanly and don't force the old answer in.

Then answer directly and fully, reasoning over the combined intent. Never re-deliver sentences from the previous answer.]`;
}
