// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CONNECTIVE BATTERY — the whole class, or the whack-a-mole resumes.
//
//  The sentence-initial waiver failed five separate times on the same
//  grammatical class (Additionally -> Success -> Early/Late/Please ->
//  Thus), each time costing a correct cover, each time fixed by adding the
//  one word that bit. This battery asserts the CLASS: every suffix-less
//  discourse connective and judgement opener a technical cover genuinely
//  starts with, in the guard's STRICTEST mode — no knowledge base, where
//  the question is the only allowed vocabulary and this list is the only
//  protection a good cover has. That is exactly the mode the live "Thus"
//  rejection happened in.
//
//  The controls are the other half of the bargain: completing the closed
//  class must not soften the OPEN class, where the fabrication risk lives.
//  Apple and Oracle are dictionary words; they are also employers, and
//  they must stay caught — which is why the fix was never "waive any
//  English word".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unverifiedProperNouns } = require('../src/services/groundingGuard.js');

// The strict no-KB shape from routes/ai.js: vocabulary absent, so the
// question itself is what the guard checks against.
const Q = 'How would you guarantee delivery when the sink cannot deduplicate?';
const strict = (cover) => unverifiedProperNouns(Q, cover, Q);

const OPENERS = [
  // the five historic escapees, so the file reads as its own history
  ['Additionally', 'Additionally, the retry path has to be idempotent.'],
  ['Success',      'Success signals only say the job ran, not that it ran correctly.'],
  ['Early',        'Early signals matter more than the final number here.'],
  ['Please',       'Please say which part you mean and I will take it from there.'],
  ['Thus',         'Thus, the guarantee has to live upstream of the sink.'],
  // the completion — suffix-less connectives
  ['Hence',        'Hence the deduplication has to happen before the write.'],
  ['Indeed',       'Indeed, the sink is the one place you cannot enforce it.'],
  ['Yet',          'Yet the pipeline being green proves nothing about the data.'],
  ['Only',         'Only the producer side can make that promise.'],
  ['Further',      'Further, every retry multiplies the duplicate risk.'],
  ['Thereby',      'Thereby the staging table absorbs the retries.'],
  ['Thereafter',   'Thereafter each batch carries a deterministic key.'],
  ['Henceforth',   'Henceforth every write goes through the outbox.'],
  ['Whereby',      'Whereby the offset commit happens after the publish.'],
  ['Wherein',      'Wherein the real constraint is the non-idempotent sink.'],
  ['Albeit',       'Albeit slower, the staging path is the one that holds.'],
  ['Whilst',       'Whilst the jobs are green, the numbers can still be wrong.'],
  ['Nonetheless',  'Nonetheless the guarantee cannot sit at the sink boundary.'],
  ['Nevertheless', 'Nevertheless a dedup key upstream closes the gap.'],
  ['Elsewhere',    'Elsewhere in the pipeline you still have room to dedupe.'],
  ['Altogether',   'Altogether that rules out relying on the warehouse.'],
  ['Together',     'Together the outbox and the key give you the guarantee.'],
  ['Aside',        'Aside from cost, the constraint is the sink itself.'],
  ['Apart',        'Apart from retries, nothing else duplicates rows here.'],
  ['Somehow',      'Somehow the duplicates survive the load, which points upstream.'],
  ['Somewhat',     'Somewhat counterintuitively, the fix lives at the producer.'],
  ['Quite',        'Quite simply, the sink cannot be trusted to drop duplicates.'],
  ['Twice',        'Twice-delivered events are the expected case, not the edge case.'],
  ['Worse',        'Worse, a blind retry turns one duplicate into many.'],
  // judgement adjectives morphology cannot reach
  ['Critical',     'Critical here is whether the write path is idempotent.'],
  ['Common',       'Common practice is a staging table with a dedup key.'],
  ['Likely',       'Likely the duplicates enter at the retry boundary.'],
  ['Unlikely',     'Unlikely as it sounds, the warehouse is not the problem.'],
  ['Possible',     'Possible fixes all live upstream of the sink.'],
  ['Impossible',   'Impossible at the sink means mandatory at the source.'],
  ['Necessary',    'Necessary but not sufficient: ordering alone will not save you.'],
  ['Zero',         'Zero duplicates at the sink means dedup before the sink.'],
  ['Single',       'Single-writer topology is what makes the guarantee cheap.'],
  ['Double',       'Double writes are the symptom; the retry policy is the cause.'],
];

describe('every connective-opened cover passes the strict no-KB guard', () => {
  for (const [word, cover] of OPENERS) {
    it(`"${word}, …" is English, not an employer`, () => {
      expect(strict(cover), `"${word}" was reported as an invented name`).toEqual([]);
    });
  }
});

describe('the open class is not softened — a fabricated employer is still caught', () => {
  const CONTROLS = [
    ['Google',   'Google is where I spent most of my time on that.'],
    ['Apple',    'Apple is where I ran the ingestion team.'],       // dictionary word AND a company
    ['Oracle',   'Oracle was my main environment for years.'],      // same trap
    ['Fidelity', 'Fidelity is where the streaming work happened.'],
    ['Accenture','Accenture staffed me on that programme.'],
  ];
  for (const [name, cover] of CONTROLS) {
    it(`"${name} is where…" stays caught`, () => {
      expect(strict(cover)).toContain(name);
    });
  }
});
