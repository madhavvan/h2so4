// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE IDENTITY LEAD IS NOT THE DOCUMENT'S TITLE (2026-08-22)
//
//  selectCoverEvidence always ships an opening block — retrieval answers
//  "which passages match this question", never "who is this person", so
//  without it the model gets three paragraphs about lyophilisation and no
//  name. That block travels on EVERY question, which makes whatever is in
//  it what the model believes about the candidate all day.
//
//  Measured on a real 166 KB prep dossier, the first 900 characters were
//  entirely scaffolding:
//
//      # DEEP KNOWLEDGE — CQV Lead (Laboratory Instruments) @ Eli Lilly
//      ### Panel-round preparation dossier for Venu Pentala
//      **Compiled:** … **Source inputs:** `Venu_Resume.docx` …
//      # PART 0 — SOURCE DOCUMENTS (VERBATIM)
//      ## 0.A — RESUME: `Venu_Resume.docx` (full text)
//
//  The candidate's actual résumé header began at character 901 and never
//  travelled. The one substantive line named the company they were
//  INTERVIEWING WITH, and the cover duly said, in the running app, "I
//  worked at Eli Lilly as CQV Lead for laboratory instruments" — to a
//  Lilly panel. Their real employers (Evonik ×37, Cook MyoSite ×20,
//  MSN ×15) were never in front of the model.
//
//  Telling the model in the system prompt not to do this did NOT hold: the
//  fabrication returned as soon as the rule was shortened, because the
//  evidence still said Lilly and the prompt was arguing with the evidence.
//  So the fix is on the evidence, and this pins it.
//
//  Measured against the live cover model, 9 samples per arm:
//    old lead (headings kept)     — 4/9 covers produced, 5 binned by the guard
//    new lead (headings stripped) — 9/9 produced, employers correct every time
//  Stripping the scaffolding more than DOUBLED the hit rate, because the
//  guard was rejecting covers written from polluted evidence.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';

const { selectCoverEvidence } = await import('../../services/coverSource.ts');

const file = (content, name = 'kb.md') => [{ id: 'k', name, type: 'custom', content }];

// A prep dossier shaped like the real one: a title naming the TARGET
// company, section scaffolding, then the candidate's own history. Padded
// past COVER_SELECT_FROM (9,000) so selection actually runs.
const PAD = '\nRoutine qualification narrative. '.repeat(400);
const DOSSIER = [
  '# DEEP KNOWLEDGE — CQV Lead (Laboratory Instruments) @ Northwind Pharma, Indiana',
  '### Panel-round preparation dossier for Dana Reyes',
  '**Compiled:** 2026-08-09 · **Source inputs:** `Dana_Resume.docx`',
  '',
  '---',
  '',
  '# PART 0 — SOURCE DOCUMENTS (VERBATIM)',
  '',
  '## 0.A — RESUME: `Dana_Resume.docx` (full text)',
  '',
  'Dana Reyes — dana@example.com',
  'CQV Lead at Vertexia Bio since 2021. Before that, Halcyon Labs and Meridian Sciences.',
  'Qualified HPLC, UPLC and dissolution systems across three sites.',
  PAD,
].join('\n');

describe('the identity lead carries the person, not the document title', () => {
  const evidence = selectCoverEvidence(file(DOSSIER), 'Have you qualified HPLC systems?');

  it('the evidence does not open by naming the company being interviewed with', () => {
    // The lead is the first ~900 chars of what ships. The target company
    // must not be in it — that is the exact span the model reads as "who
    // this person is".
    const lead = evidence.slice(0, 900);
    expect(lead).not.toMatch(/Northwind Pharma/);
  });

  it('and the real employer survives into the evidence', () => {
    expect(evidence).toMatch(/Vertexia Bio/);
  });

  it('markdown scaffolding headings are not the identity', () => {
    const lead = evidence.slice(0, 900);
    expect(lead).not.toMatch(/PART 0 — SOURCE DOCUMENTS/);
    expect(lead).not.toMatch(/DEEP KNOWLEDGE/);
  });

  it('a plain résumé with no headings is completely unaffected', () => {
    // The common case by a wide margin. identityLead only strips markdown
    // heading lines, and an ordinary .docx résumé has none — so this must
    // pass through byte-identical to the old behaviour.
    const RESUME = [
      'Priya Raman — priya@example.com — +1 555 0100',
      'Senior Data Engineer, Helios Systems, 2021–2025',
      'Built Kafka and Airflow pipelines at 3M records a day.',
      PAD,
    ].join('\n');
    const ev = selectCoverEvidence(file(RESUME, 'resume.docx'), 'Tell me about your pipelines.');
    expect(ev.slice(0, 200)).toMatch(/Priya Raman/);
    expect(ev).toMatch(/Helios Systems/);
  });

  it('a document that is nothing but headings still ships something', () => {
    // Fallback guard: an empty identity block is worse than an imperfect
    // one, so identityLead returns the raw text when stripping empties it.
    const ONLY_HEADINGS = ['# A', '## B', '### C', PAD].join('\n');
    const ev = selectCoverEvidence(file(ONLY_HEADINGS), 'anything at all?');
    expect(ev.length).toBeGreaterThan(0);
  });
});
