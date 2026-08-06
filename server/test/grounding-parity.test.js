// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TWO GUARDS, ONE VERDICT
//
//  The fabrication check exists twice: in services/factLedger.ts, where the
//  client composes its own opener and self-checks it, and in
//  server/src/services/groundingGuard.js, where the server polices a
//  fallback model's cover. They cannot be one module — the client half is
//  TypeScript compiled into the renderer bundle, the server half is CommonJS
//  required by a plain node process.
//
//  A duplicated guard that DRIFTS is worse than no guard, because it would
//  pass precisely the sentences its twin rejects, and the failure would show
//  up only as a fabrication in someone's interview. So this suite runs both
//  over the same corpus and asserts identical verdicts, word for word.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const require = createRequire(import.meta.url);
const guard = require('../src/services/groundingGuard.js');
const { buildLedger, unverifiedProperNouns } = await import('../../services/factLedger.ts');
const { ledgerVocabulary } = await import('../../services/instantOpener.ts');

const RESUME = [
  'VENU MADHAV  Data Engineer | AWS Warehousing, Spark Pipelines',
  'TECHNICAL SKILLS',
  '●   AWS Data Platform:   S3, Glue, Redshift, EMR, Lambda, Athena',
  '●   Streaming & Event Processing:   Apache Kafka, Kinesis, Debezium',
  'PROFESSIONAL EXPERIENCE  Data Engineer   |   Siemens, Dallas, TX   |   April 2026 – Present',
  '●   Rebuilt the lakehouse ETL path and cut query latency ~40%.',
  'Data Engineer   |   Apollo Hospitals, Hyderabad, India   |   Sep 2022 – December 2023',
  '●   Owned Kafka and Python pipelines at 3M records a day.',
  'Data Engineer   |   KIMS Hospitals, Hyderabad, India   |   June 2016 – August 2017',
  'EDUCATION  Master of Science in Health Informatics   |   Indiana University   |   2025',
  'PROJECTS',
  'PipelineGuard — Agentic data-pipeline triage | Python, Elasticsearch, ES|QL',
].join('  ');

const ledger = buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content: RESUME }]);
const vocab = ledgerVocabulary(ledger);

// Sentences a cover model plausibly emits, including every one the app
// actually spoke on 2026-07-29, split by the verdict each one is owed.
//
// INVENTED — a name the knowledge base cannot support. Both guards must
// report every one of these, under every context that does not itself name
// the company.
//
// The last four are the SENTENCE-INITIAL cases. A capitalised word at the
// head of a sentence used to be waived unless it was an acronym, so "I built
// that at Google" was caught and "Google is where I spent most of my time on
// that." was not — while the cover prompt instructs the model to start
// ANSWERING from the first word and to name the employer, which puts the
// fabrication in the one place nothing was looking. "Snowflake, mostly"
// belongs here rather than among the grounded sentences: neither Snowflake
// nor Databricks appears anywhere in RESUME, and the opening word of it went
// unreported until now because only the mid-sentence one was ever checked.
const INVENTED = [
  "I've worked mostly on Linux and Windows, and my favorite project was at IBM, building a cloud-based system for data analytics.",
  "I've spent several years at IBM, working on various projects and systems.",
  'That was based on my experience with their systems at Accenture, where I worked on several projects.',
  "I've spent most of my time on AWS and Kubernetes, building infrastructure that scales.",
  'Google is where I spent most of my time on that.',
  'Yeah. Accenture was the place.',
  'Goldman was where I did most of the streaming work.',
  'Snowflake, mostly — plus a bit of Databricks.',
];

// Every name is in the knowledge base, or is an ordinary word that merely
// happens to open a sentence. Both guards must pass all of these — a false
// positive here is a cover thrown away and a silence the interviewer hears.
//
// "PipelineGuard is the one I keep coming back to." stays in this list on
// purpose even though it is sentence-initial and capitalised: RESUME names
// the project, so it is in the vocabulary and it passes the ordinary check
// rather than the waiver. That is the distinction the fix turns on.
const GROUNDED = [
  'At Apollo Hospitals I owned the Kafka and Python path for around 3M records a day.',
  "No, I haven't — my roles have been Siemens, Apollo Hospitals and KIMS Hospitals.",
  'Yeah, so the Debezium side of that was mine — Kinesis for the rest.',
  'PipelineGuard is the one I keep coming back to.',
  'Most of it has been AWS Data Platform — S3, Glue, Redshift.',
  'Sure, that was mostly Kafka.',
  'Honestly, it was a small team.',
  'That was the hard part.',
  'Um, so at Siemens the lakehouse work was ETL on S3 and Glue.',
  'Nothing capitalised here at all.',
  "Yeah. Kafka. Apollo Hospitals. Siemens. Done.",
];

// Mixed and degenerate inputs. Not asserted either way — they are here so
// the two implementations are compared over them, which is the point of the
// suite.
const MIXED = [
  'Honestly, Terraform was never really my side of it.',
  'IBM was where I did that.',
  'Right — most of that was Structured Streaming on EMR.',
  'I did my Master of Science at Indiana University.',
  'We ran it on GCP with BigQuery behind Looker.',
  '',
  '   ',
  'A. B. C.',
];

const CORPUS = [...INVENTED, ...GROUNDED, ...MIXED];

const ALLOWED = [undefined, 'have you worked at Goldman Sachs?', 'tell me about Terraform',
  'what about IBM and Accenture?', 'do you know GCP?'];

describe('client and server guards agree exactly', () => {
  it('every sentence, every allowed-context', () => {
    let checked = 0;
    let disagreements = 0;
    for (const text of CORPUS) {
      for (const allowed of ALLOWED) {
        const client = unverifiedProperNouns(ledger, text, allowed);
        const server = guard.unverifiedProperNouns(vocab, text, allowed);
        checked++;
        if (JSON.stringify(client) !== JSON.stringify(server)) {
          disagreements++;
          console.log(`   DISAGREE text="${text.slice(0, 60)}" allowed="${allowed}"`);
          console.log(`     client=[${client}]  server=[${server}]`);
        }
        expect(server, `text="${text}" allowed="${allowed}"`).toEqual(client);
      }
    }
    console.log(`   ${checked} (sentence x context) pairs checked, ${disagreements} disagreements`);
    expect(disagreements).toBe(0);
  });

  it('the fabrications are rejected by BOTH', () => {
    for (const bad of INVENTED) {
      const c = unverifiedProperNouns(ledger, bad);
      const s = guard.unverifiedProperNouns(vocab, bad);
      console.log(`   client[${c.join(',')}] server[${s.join(',')}]  <- ${bad.slice(0, 54)}...`);
      expect(c.length, `passed the client: ${bad}`).toBeGreaterThan(0);
      expect(s.length, `passed the server: ${bad}`).toBeGreaterThan(0);
    }
  });

  it('grounded sentences pass BOTH', () => {
    for (const good of GROUNDED) {
      expect(unverifiedProperNouns(ledger, good), good).toEqual([]);
      expect(guard.unverifiedProperNouns(vocab, good), good).toEqual([]);
    }
  });

  // ── THE OPENING SLOT ──
  //
  // The waiver for sentence-initial capitals is the whole of this test. It
  // has to hold in both directions at once: the name the model invented is
  // named, and the ordinary word that opens a spoken sentence is left alone.
  // Named individually rather than counted, because "something was flagged"
  // would pass even if the guard reported the wrong word.
  it('names a company in the opening slot, and only the company', () => {
    const cases = [
      ['Google is where I spent most of my time on that.', 'Google'],
      ['Yeah. Accenture was the place.', 'Accenture'],
      ['Goldman was where I did most of the streaming work.', 'Goldman'],
      // The claim moved one clause later — caught before the fix, and it
      // must still be caught after it.
      ['I built that at Google.', 'Google'],
      // An acronym opening a sentence was the one case the old waiver did
      // check, and it stays checked.
      ['IBM was where I first hit that.', 'IBM'],
    ];
    for (const [bad, name] of cases) {
      expect(guard.unverifiedProperNouns(vocab, bad), bad).toEqual([name]);
      expect(unverifiedProperNouns(ledger, bad), bad).toEqual([name]);
    }
  });

  it('an ordinary word that opens a sentence is not a company', () => {
    const ok = [
      'Sure, that was mostly Kafka.',
      'Honestly, it was a small team.',
      'That was the hard part.',
      'Typically I start from consumer lag rather than the broker.',
      'Probably three months, end to end.',
      "Doesn't matter which one — the pattern is the same.",
      'Whenever that happened we rolled back first and read the logs after.',
      // "Throughput" is in neither word list and in neither document, and it
      // does not need to be: the same word appears lowercased later in the
      // sentence, which is something a company name never does.
      'Throughput was the constraint here — throughput on the write path, not read.',
    ];
    for (const good of ok) {
      const flagged = guard.unverifiedProperNouns(vocab, good, undefined);
      if (flagged.length) console.log(`   FALSE POSITIVE [${flagged}] in: ${good}`);
      expect(flagged, `false positive: ${good}`).toEqual([]);
      expect(unverifiedProperNouns(ledger, good), `false positive (client): ${good}`).toEqual([]);
    }
  });

  it('no vocabulary -> both abstain (a KB-less session is never blocked)', () => {
    for (const text of CORPUS) {
      expect(guard.unverifiedProperNouns('', text)).toEqual([]);
      expect(guard.unverifiedProperNouns(new Set(), text)).toEqual([]);
    }
  });

  // ── THE LEDGER THE GUARD IS BUILT FROM ──
  //
  // The abstention above is why a misfiled document is a fabrication
  // forwarded rather than a fact merely lost. isJobDescription used to test
  // the filename before reading a character of the file, and its pattern
  // matched the bare word "role" — so a resume named the way people name
  // resumes was skipped whole, the vocabulary came out empty, and the guard
  // then had no opinion about anything the model said.
  it('a resume named like a posting still reaches the guard', () => {
    const named = buildLedger([
      { id: 'r', name: 'Venu Pentala - Data Engineer Role.pdf', type: 'custom', content: RESUME },
    ]);
    expect(named.jdCount, 'the resume was read as a job description').toBe(0);
    expect(named.charCount).toBeGreaterThan(0);
    expect(named.vocabulary.size).toBeGreaterThan(0);
    const v = ledgerVocabulary(named);
    expect(guard.unverifiedProperNouns(v, 'Google is where I spent most of my time on that.')).toEqual(['Google']);
    expect(unverifiedProperNouns(named, 'At Apollo Hospitals I owned the Kafka and Python path for around 3M records a day.')).toEqual([]);
  });

  // ── THE NO-KB COVER, WHICH IS THE STRICTEST CASE ──
  // routes/ai.js passes the QUESTION as the vocabulary when the knowledge
  // base is empty, because a no-documents session is exactly when a fast
  // model invents an employer — and the abstention above would wave it
  // through. Verified live before this: with no files attached the cover
  // produced "At my previous role at Google…" and "I've worked at IBM and
  // then spent several years at Accenture…", both unchallenged.
  it('question-as-vocabulary catches an employer invented out of nothing', () => {
    const q = 'tell me about a time you fixed a hard production issue';
    const invented = [
      'At my previous role at Google, we experienced a major outage in our cloud infrastructure.',
      "I've worked at IBM and then spent several years at Accenture, that's where I've been before.",
      "I've spent most of my career in software development at IBM, working on various projects.",
      // Same fabrication, moved into the opening slot, which is where the
      // cover prompt asks the model to start answering from.
      'Google was where I fixed the worst one of those.',
      'Yeah. Accenture had the same problem on their side.',
    ];
    for (const bad of invented) {
      const flagged = guard.unverifiedProperNouns(q, bad, q);
      console.log(`   FLAGGED [${flagged.join(', ')}]  <- ${bad.slice(0, 52)}...`);
      expect(flagged.length, `passed with no KB: ${bad}`).toBeGreaterThan(0);
    }
    expect(guard.unverifiedProperNouns(q, invented[0], q)).toContain('Google');
    expect(guard.unverifiedProperNouns(q, invented[1], q)).toEqual(
      expect.arrayContaining(['IBM', 'Accenture']));
  });

  it('…while an approach-only cover, which is what it should produce, passes', () => {
    const q = 'tell me about a time you fixed a hard production issue';
    const ok = [
      'The way I handle incidents like that is to separate mitigation from diagnosis.',
      "Before I touch anything I'd want to know whether it's real user impact or measurement noise.",
      'First thing is reducing blast radius, then building a timeline from deploy and config events.',
    ];
    for (const good of ok) {
      const flagged = guard.unverifiedProperNouns(q, good, q);
      if (flagged.length) console.log(`   FALSE POSITIVE [${flagged}] in: ${good}`);
      expect(flagged, `false positive: ${good}`).toEqual([]);
    }
  });

  it('a name the interviewer used is still allowed with no KB', () => {
    const q = 'have you used Kubernetes in production?';
    expect(guard.unverifiedProperNouns(q, "Kubernetes — that's mostly been resource tuning for me.", q)).toEqual([]);
  });

  // Both word lists, not just the older one: SENTENCE_OPENERS decides which
  // capitalised first words are waived, so a member present on one side and
  // missing on the other is the same class of bug — one guard passing the
  // sentence its twin rejects.
  it('the discourse lists are identical, not merely similar', async () => {
    const fs = await import('node:fs');
    const tsSrc = fs.readFileSync(new URL('../../services/factLedger.ts', import.meta.url), 'utf8');
    const jsSrc = fs.readFileSync(new URL('../src/services/groundingGuard.js', import.meta.url), 'utf8');
    const grab = (src, name) => {
      const m = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(src);
      return new Set((m[1].match(/'[^']+'/g) || []).map((x) => x.slice(1, -1)));
    };
    for (const name of ['DISCOURSE', 'SENTENCE_OPENERS']) {
      const a = grab(tsSrc, name);
      const b = grab(jsSrc, name);
      const onlyTs = [...a].filter((x) => !b.has(x));
      const onlyJs = [...b].filter((x) => !a.has(x));
      console.log(`   ${name}: client ${a.size} words, server ${b.size} words; drift: ts-only=[${onlyTs}] js-only=[${onlyJs}]`);
      expect(a.size, `${name} is missing from one side`).toBeGreaterThan(0);
      expect(onlyTs, `${name} drifted`).toEqual([]);
      expect(onlyJs, `${name} drifted`).toEqual([]);
    }
  });

  // ── THE HOUSE PHRASE ──
  // COVER_SYSTEM already forbids these in capital letters and 61 of the last
  // 400 answers (15.3%) opened with one anyway. Three began with the
  // identical words "Most of my time's been on" — one of them in front of a
  // question about concurrency in RAG systems.
  it('rejects the openers the prompt asked it not to produce', () => {
    const SHIPPED = [
      "Most of my time's been on Azure Data Platform, I've worked with concurrency in C#/.NET and Python.",
      'Most of my time has been on building streaming and batch platforms, recently at Fidelity Investments.',
      "I've worked mostly on Linux and Windows, and my favorite project was at IBM.",
      "First thing I'd look at is defining concurrency in the context of RAG principles.",
      "I've spent most of my time on AWS and Kubernetes, building infrastructure that scales.",
      "That's a great question — let me walk you through it.",
      'Certainly, the way I would approach that is...',
    ];
    for (const bad of SHIPPED) {
      const hit = guard.hasBannedOpener(bad);
      console.log(`   BANNED "${hit}"  <- ${bad.slice(0, 56)}...`);
      expect(hit, `should have been rejected: ${bad}`).not.toBe('');
    }
  });

  it('lets a real opening through', () => {
    const GOOD = [
      'At Apollo Hospitals I owned the Kafka and Python path for around 3M records a day.',
      "No, I haven't — my roles have been Siemens, Apollo Hospitals and KIMS Hospitals.",
      'Token bucket per user, Redis-backed — the edge is clock skew between hosts.',
      'Yeah, so the Debezium side of that was mine.',
      "Concurrency is about overlapping work rather than simultaneous work — that's the distinction that matters here.",
      'PipelineGuard, easily — it cut incident triage by about 45 minutes a case.',
      // "most of my time" mid-sentence is ordinary speech; only the OPENING
      // is the tell, because an opening that fits every question answers none.
      'The Kafka work is where most of my time went, at Apollo Hospitals.',
    ];
    for (const good of GOOD) {
      const hit = guard.hasBannedOpener(good);
      if (hit) console.log(`   FALSE POSITIVE "${hit}" in: ${good}`);
      expect(hit, `false positive on: ${good}`).toBe('');
    }
  });

  it('leading quotes and dashes do not smuggle a banned opener past it', () => {
    expect(guard.hasBannedOpener('  "Most of my time\'s been on Azure.')).not.toBe('');
    expect(guard.hasBannedOpener('— Great question, so...')).not.toBe('');
    expect(guard.hasBannedOpener('')).toBe('');
    expect(guard.hasBannedOpener(null)).toBe('');
  });

  it('the server guard is fast enough to sit in front of a stream', () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) guard.unverifiedProperNouns(vocab, CORPUS[i % CORPUS.length], 'a question');
    const us = Number(process.hrtime.bigint() - t0) / 1000 / 2000;
    console.log(`   ${us.toFixed(1)}us per check`);
    expect(us).toBeLessThan(500);
  });
});
