// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A TERM OF THE TRADE IS NOT AN INVENTED EMPLOYER — AND THE
//  DIFFERENCE IS THE CLAIM, NOT THE WORD.
//
//  ── WHAT THIS FILE USED TO PIN, AND WHY IT WAS WRONG ──
//
//  Measured 2026-08-16 against the real question corpus: 29.2% of covers
//  that generated were discarded by the guard, and almost none of them was
//  a fabrication. They were correct sentences rejected over ordinary terms
//  of the trade — RAG, SLA, ETL, CDC, SLO each reported as an invented
//  company. The fix at the time was a list of ~150 waived acronyms.
//
//  It worked for the two industries it was written for. Measured live on
//  2026-08-20 against a telecom résumé, both of these were REJECTED and
//  both are textbook 3GPP:
//
//    invented=[UE, Request]  "UE initiates attach by sending Attach
//                             Request to the MME."
//    invented=[TEID]         "First, verify the tunnel integrity and TEID
//                             matching."
//
//  There is no UE, TEID, PDU, gNB, AMF, SMF or UPF on that list, and there
//  never could be: every new field is a new pull request and every new
//  language is a new list. Nor could the list simply be widened — "UE" and
//  "IBM" are the same shape. Nothing about the TOKEN separates a term of
//  art from a fabricated employer.
//
//  ── WHAT REPLACED IT ──
//
//  Only the sentence's CLAIM separates them, so that is what is checked.
//  A cover that says something about the candidate's own history must hand
//  back the words it read that from, and those words must really occur in
//  what the model was shown. A cover that says nothing about the candidate
//  is talking about the subject, where an unfamiliar term is a term of art.
//
//  These tests therefore drive coverVerdict — the real, shared decision —
//  rather than unverifiedProperNouns on its own. unverifiedProperNouns
//  still flags SLA and UE when it is called; the point is that on a
//  framing sentence it is not called.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unverifiedProperNouns, hasMetaLeak } = require('../src/services/groundingGuard.js');
const { coverVerdict } = require('../src/routes/ai.js')._test;

// What a real résumé supplies. Deliberately NOT containing any of the
// acronyms under test — the point is that they pass without help.
const SHOWN = [
  '===== resume.pdf =====',
  'Venu Madhav — Data Engineer',
  'Data Engineer | Apollo Hospitals | Jan 2022 - Dec 2023',
  'Built Kafka pipelines processing 3 million clinical events daily.',
  'Skills: Python, Airflow, Snowflake, PostgreSQL.',
  'M.S. Health Informatics, Indiana University.',
].join('\n');
const VOCAB = 'apollo hospitals kafka python airflow snowflake indiana university postgresql';
const Q = 'what would you check first?';

const verdictOf = (cover, { citation = '', question = Q, shown = SHOWN } = {}) =>
  coverVerdict({ cover, citation, shown, vocabulary: VOCAB, allowed: question });

describe('a sentence about the SUBJECT may use the vocabulary of any field', () => {
  const cases = [
    ['RAG, named in lower case by the question',
      'how can you define rags?',
      'RAG is retrieval-augmented generation — you ground a model in documents.'],
    ['SLA, with nothing in the question to lean on',
      'how do you keep costs down?',
      'SLA targets are what decide the design here, not the raw cost number.'],
    ['ETL / CDC / SLO together',
      'walk me through your approach',
      'ETL jobs land raw, then CDC keeps it current against the SLO agreed.'],
    ['HSM and PAN on a payments question',
      'what about compliance here?',
      'PAN data never lands in the warehouse; the HSM boundary decides that.'],
    ['a pluralised acronym',
      'are the pipelines healthy?',
      'DAGs being green only tells you the jobs ran, not that the numbers are right.'],
    // ── The three the old list could not have known ──
    ['3GPP attach, the sentence the acronym list rejected',
      'walk me through the 5G registration procedure',
      'UE initiates attach by sending Attach Request to the MME.'],
    ['TEID, likewise',
      'a bearer is up but no data flows — where do you look?',
      'Tunnel integrity and TEID matching are what decide whether traffic moves.'],
    ['a pharmaceutical term, from a third industry again',
      'what does a balance qualification actually establish?',
      'Minimum weight is calculated; smallest net weight is user-defined.'],
  ];
  for (const [label, question, cover] of cases) {
    it(label, () => {
      expect(verdictOf(cover, { question })).toBe('');
    });
  }
});

describe('…and the same words inside a CLAIM are not free', () => {
  it('an uncited claim about the candidate is dropped, acronym or not', () => {
    expect(verdictOf('I spent three years at IBM.')).toBe('uncitedClaim');
    expect(verdictOf('We ran the whole platform on AWS at the time.')).toBe('uncitedClaim');
    // The catastrophic case the acronym waiver would have let through:
    // IBM and AWS are exactly as acronym-shaped as UE and TEID above.
  });

  it('a cited claim still cannot introduce a name the documents lack', () => {
    expect(verdictOf('I built Kafka pipelines at Accenture.', {
      citation: 'Built Kafka pipelines processing 3 million clinical events daily',
    })).toBe('invented=[Accenture]');
  });

  it('a cited claim that stays inside the documents is spoken', () => {
    expect(verdictOf('I built Kafka pipelines at Apollo Hospitals.', {
      citation: 'Built Kafka pipelines processing 3 million clinical events daily',
    })).toBe('');
  });
});

describe('the citation has to be real', () => {
  it('a quotation the document does not contain kills the whole cover', () => {
    // Not merely unsupported — the model INVENTED ITS OWN EVIDENCE, which
    // is a worse signal than an unsupported sentence. Measured shape: on
    // the pharmaceutical run the cover claimed "I led a similar
    // mid-deployment relocation at Evonik", a scenario the INTERVIEWER had
    // invented one question earlier and which appears nowhere in the file.
    expect(verdictOf('I led a similar mid-deployment relocation there.', {
      citation: 'led a similar mid-deployment relocation with zero downtime',
    })).toBe('confabulatedCitation');
  });

  it('re-punctuation and Unicode are not forgery', () => {
    // The model quotes; it does not photocopy. Case, spacing, curly
    // apostrophes and the U+2011 hyphen all differ between what a document
    // holds and what a model writes, and each of those has already thrown
    // away a correct cover in this codebase.
    expect(verdictOf('I built Kafka pipelines at Apollo Hospitals.', {
      citation: 'built kafka pipelines, processing 3 million clinical events — daily',
    })).toBe('');
  });

  it('a scrap of a citation proves nothing and is refused', () => {
    // Under 12 normalised characters cannot be evidence: "the", "yes", a
    // bare number occur in every document and would license any sentence.
    // It reports as a confabulation rather than as a missing citation,
    // which is right - the model DID answer the question, with something
    // that is not an answer.
    expect(verdictOf('I worked at Apollo Hospitals.', { citation: 'Data' }))
      .toBe('confabulatedCitation');
  });

  it('a surplus citation on a FRAMING sentence is IGNORED, not fatal', () => {
    // The first draft rejected this, reasoning that a model which invents a
    // quotation should not be trusted with the sentence either. Measured
    // across three resumes that caught nothing and cost correct covers -
    // most plainly a textbook definition of calibration versus
    // qualification, thrown away over a three-word paraphrase in CITE that
    // nothing in the sentence rested on. The claim rule is the guarantee;
    // this was superstition stacked on top of it.
    expect(verdictOf('A green pipeline only tells you the tasks finished.', {
      citation: 'a green pipeline only means the tasks finished',
    })).toBe('');
  });
});

describe('absence can never be cited, so it can never be said', () => {
  // The most expensive error the cover has made, twice, in two different
  // fields: denying to an interviewer work the candidate had actually done.
  //   "I haven't used Kneat."          — Kneat is a main part of that job
  //   "I haven't worked directly with LLMs." — said in front of an answer
  //                                     that then described two LLM projects
  // No quotation can show that something did NOT happen.
  //
  // ⚠️ AND THE CITATION RULE ALONE WAS NOT ENOUGH TO STOP THEM. It proves
  // the model read SOMETHING, not that it read THIS. Measured live and
  // accepted before deniesOwnHistory existed: "No, I haven't worked with
  // Kubernetes directly. My virtualization experience has been with VMware
  // ESXi and Hyper-V..." - it cited the real VMware line and the citation
  // held, so a denial rode in on evidence for a different sentence. True
  // that time, by luck. So a denial is refused outright, cited or not.
  for (const denial of [
    "I haven't used Kneat.",
    "I haven't worked directly with LLMs.",
    'No, I have not worked with Kubernetes in production.',
    "I didn't run a lyophilizer there.",
    // …and a citation that really does hold does not rescue one.
  ]) {
    it(`refuses: ${denial}`, () => {
      expect(verdictOf(denial)).toBe('deniedOwnHistory');
    });
  }

  it('a real citation for a DIFFERENT sentence does not rescue a denial', () => {
    expect(verdictOf("No, I haven't worked with Kubernetes; my work has been Kafka pipelines.", {
      citation: 'Built Kafka pipelines processing 3 million clinical events daily',
    })).toBe('deniedOwnHistory');
  });

  it('…while a negation ABOUT THE SUBJECT is untouched', () => {
    expect(verdictOf('A green pipeline does not tell you the numbers are right.')).toBe('');
    expect(verdictOf('The constraint is not throughput, it is consistency.')).toBe('');
  });

  it('the negator has to be ATTACHED to the person, not merely present', () => {
    // Measured live, and it cost a good cover: this was thrown away as a
    // denial because "can't" is a negator and something later in the
    // sentence referred to the speaker. It is a statement about
    // subscribers, and a strong one.
    expect(verdictOf(
      "If a subscriber attaches successfully but can't browse, the problem is almost "
      + "always the IP path to the internet, and I'd start there.",
    )).toBe('');
  });

  it('a NEGATED MODAL is a stance, not a denial', () => {
    // Found by auditing a real interview in the app's own database. This is
    // one of the strongest things a candidate can say about AI in a
    // controlled environment, and the rule was refusing it:
    expect(verdictOf(
      "I also wouldn't let a model approve an audit conclusion or execute a "
      + 'consequential action.',
    )).toBe('');
    expect(verdictOf("I wouldn't assume the remote call had failed.")).toBe('');
    expect(verdictOf("I couldn't tell you the exact number without checking.")).toBe('');
    // …and it was INCONSISTENT before the fix: "I can't" was already being
    // stripped by accident, because `can` matches the "can" of "can't"
    // while `would` does not match the "would" of "wouldn't".
    expect(verdictOf("I can't see that being the bottleneck here.")).toBe('');
  });

  it('…but the hard forms are untouched, adverb or not', () => {
    expect(verdictOf("I also haven't used Terraform.")).toBe('deniedOwnHistory');
    expect(verdictOf('I never ran that.')).toBe('deniedOwnHistory');
  });

  it('…and a contraction of the pronoun does not hide one', () => {
    // "I've" is a single token, and the pronoun is only its first half.
    expect(verdictOf("No, I've worked on 4G EPC rather than that.")).toBe('deniedOwnHistory');
  });
});

describe('an ordinary word opening a sentence is not a company', () => {
  for (const [label, cover] of [
    ['Consistency', 'Consistency is what the design has to give up here.'],
    ['Latency', 'Latency is the constraint, not throughput.'],
    ['Throughput', 'Throughput and correctness are being conflated in that number.'],
  ]) {
    it(label, () => { expect(verdictOf(cover)).toBe(''); });
  }
});

describe('what the interviewer said counts, however it was transcribed', () => {
  it('a lower-case mention in the question licenses the capitalised echo', () => {
    expect(unverifiedProperNouns(VOCAB, 'Snowflake handles that with micro-partitions.', 'how does snowflake do pruning?'))
      .toEqual([]);
  });
  it('a name that appears NOWHERE — not the docs, not the question — is still caught', () => {
    expect(unverifiedProperNouns(VOCAB, 'Databricks would handle that differently.', 'how does snowflake do pruning?'))
      .toEqual(['Databricks']);
  });
});

describe('a fabricated employer is still caught', () => {
  it('bare capitalised company names, mid-sentence and sentence-initial', () => {
    expect(unverifiedProperNouns(VOCAB, 'At Google we hit this exact problem, and at Accenture before that.', Q))
      .toEqual(['Google', 'Accenture']);
    expect(unverifiedProperNouns(VOCAB, 'Google is where I spent most of that time.', Q))
      .toEqual(['Google']);
  });

  it('the hyphen rules did not become "any known segment clears it"', () => {
    expect(unverifiedProperNouns(VOCAB, 'Google-scale is the wrong frame for this.', Q))
      .toEqual(['Google-scale']);
    expect(unverifiedProperNouns(VOCAB, 'It was an Accenture-led programme.', Q))
      .toEqual(['Accenture-led']);
  });

  it('an empty knowledge base abstains in the guard — and the LANE catches it', () => {
    // unverifiedProperNouns abstains with no vocabulary, which is right for
    // the main answer and exactly backwards for the cover: a session with
    // no documents is precisely when a fast model reaches for a name.
    // Measured live with nothing attached, both spoken:
    //   "At my previous role at Google, we experienced a major outage…"
    //   "I've worked at IBM and then spent several years at Accenture…"
    expect(unverifiedProperNouns('', 'At IBM we did this.', 'what happened?')).toEqual([]);
    // The citation rule closes it, because an empty document cannot
    // support any citation at all.
    expect(coverVerdict({
      cover: "I've worked at IBM and then spent several years at Accenture.",
      citation: '', shown: '', vocabulary: '', allowed: 'what happened?',
    })).toBe('uncitedClaim');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER NEVER DESCRIBES THE INTERVIEW IT IS INSIDE
//
//  Unchanged by any of the above: this is about who is speaking, not about
//  what is true, so it runs before the two rules and on both lanes.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the cover never describes the interview it is inside', () => {
  for (const bad of [
    'The interviewer is asking about specific work I have done.',
    'The candidate should describe a concrete example here.',
    'Based on the background provided, the answer is about pipelines.',
  ]) {
    it(`catches: ${bad.slice(0, 52)}...`, () => {
      expect(hasMetaLeak(bad)).toBeTruthy();
      expect(verdictOf(bad)).toMatch(/^metaLeak=/);
    });
  }

  for (const good of [
    'A green pipeline only tells you the tasks finished, not that the numbers are right.',
    'The constraint is the boundary, not the throughput.',
  ]) {
    it(`spares: ${good.slice(0, 52)}...`, () => {
      expect(hasMetaLeak(good)).toBeFalsy();
    });
  }

  it('KNOWN GAP: "I would need more context" is not caught by anything here', () => {
    // Pinned as a gap rather than left implicit. COVER_SYSTEM forbids this
    // shape in capitals; no CHECK enforces it, and it never did - hasMetaLeak
    // matches third-person references to the interview, not a stall. The
    // citation rule does not reach it either: strip the hypothetical "I
    // would" and nothing is left that claims anything, so it is a framing
    // sentence that happens to be useless rather than false.
    //
    // Left alone deliberately. It is a STYLE failure, and this file is
    // about truth; wiring a phrase list for it would be the same mistake
    // as the acronym list, one layer over.
    expect(hasMetaLeak('I would need more context to answer that properly.')).toBeFalsy();
    expect(verdictOf('I would need more context to answer that properly.')).toBe('');
  });
});
