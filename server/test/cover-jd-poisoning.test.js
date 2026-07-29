// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE SPOKEN OPENER MUST NEVER QUOTE THE JOB DESCRIPTION
//
//  From a real reported session. The shape of the upload is what matters,
//  so the filenames are described rather than reproduced — they carried a
//  customer's name and address and do not belong in a repository:
//      702  a short personal-details note
//    5,717  the JOB DESCRIPTION for the role being interviewed for
//    7,278  the candidate's actual resume
//   82,074  their own interview prep notes
//
//  The bug is entirely in the SIZES: the JD was smaller than the resume.
//
//  buildCoverContext treated the JD as an identity document, ordered
//  smallest-file-first, and capped at 1,200 chars — so the 5.7K posting
//  outranked the 7.3K resume and was the ONLY thing the cover ever saw.
//  Asked "what have you worked on the most?", the app spoke the hiring
//  company's own overview back as the candidate's career:
//    "…we specialize in solid, semi-solid, and liquid dosage forms,
//     particularly with controlled substances"
//  — said to the very company that wrote it.
//
//  Run against the files themselves, exported from the app's database,
//  so this cannot pass on a sanitised fixture.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener(){}, removeEventListener(){} });
globalThis.__APP_VERSION__ = '0.0.0';
const { buildCoverContext } = await import('../../services/aiProxyService.ts');

const FIXTURE = path.join(os.tmpdir(), 'real-session-files.json');
const real = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : null;

// ⚠️ NO REAL NAMES IN THIS FILE.
//
// These blocks run against a session exported from a live database, so
// everything they look for belongs to an actual person — their job title,
// their employers, the company they were interviewing with. Hardcoding
// any of it would put a stranger's employment history in a repository
// permanently, and git history does not forget.
//
// So the specifics come from the environment beside the fixture, never
// from here. Set them when you export a session:
//
//   COVER_FIXTURE_TITLE="…"        a phrase from the resume's first line
//   COVER_FIXTURE_EMPLOYERS="A,B"  employers that must survive the cap
//   COVER_FIXTURE_HIRER="A,B"      the hiring company, which must NOT appear
//
// Unset, each assertion skips rather than passing vacuously.
const envList = (k) => (process.env[k] || '').split(',').map(s => s.trim()).filter(Boolean);
const FIX_TITLE     = (process.env.COVER_FIXTURE_TITLE || '').trim();
const FIX_EMPLOYERS = envList('COVER_FIXTURE_EMPLOYERS');
const FIX_HIRER     = envList('COVER_FIXTURE_HIRER');

describe.skipIf(!real)('the real session that produced the bad answers', () => {
  it.skipIf(!FIX_TITLE)('picks the resume, not the job description', () => {
    const ctx = buildCoverContext(real);
    expect(ctx).toBeTruthy();
    // The resume's opening line.
    expect(ctx.toLowerCase()).toContain(FIX_TITLE.toLowerCase());
  });

  it('contains nothing from the hiring company’s posting', () => {
    const ctx = buildCoverContext(real).toLowerCase();
    // Phrases that exist ONLY in the JD. Any of them reaching the cover
    // is the candidate about to claim the interviewer's business as their
    // own.
    for (const jdPhrase of [
      'company overview',
      'solid, semi-solid',
      'controlled substances',
      'long-standing commercial relationships',
    ]) {
      expect(ctx, `JD phrase leaked into the spoken opener: "${jdPhrase}"`).not.toContain(jdPhrase);
    }
  });

  it.skipIf(!FIX_HIRER.length)('never mentions the company being interviewed with', () => {
    const ctx = buildCoverContext(real).toLowerCase();
    for (const company of FIX_HIRER) {
      expect(ctx, `the hiring company leaked into the spoken opener: "${company}"`)
        .not.toContain(company.toLowerCase());
    }
  });
});

describe('the rule, independent of that one session', () => {
  const resume = {
    id: 'r', name: 'Someone_Resume.docx', type: 'custom',
    content: 'PROFESSIONAL SUMMARY\nSterile Manufacturing Operator with 10+ years in GMP environments. Aseptic processing, sterile filtration.',
  };
  const jd = {
    id: 'j', name: 'Operator- JD.pdf', type: 'custom',
    content: 'COMPANY OVERVIEW\nAcme has long-standing commercial relationships with major pharmaceutical companies.\nResponsibilities: aseptic filling.\nQualifications: 5 years.',
  };

  it('drops the JD even when it is the smaller file', () => {
    // The exact shape that broke: a short posting beside a longer resume.
    const ctx = buildCoverContext([jd, resume]);
    expect(ctx).toContain('PROFESSIONAL SUMMARY');
    expect(ctx).not.toContain('COMPANY OVERVIEW');
    expect(ctx).not.toContain('Acme');
  });

  it('returns nothing when the JD is the only document', () => {
    // Better a careful generic opener than one built from the other side
    // of the table.
    expect(buildCoverContext([jd])).toBe('');
  });

  it('recognises a posting that is not named like one', () => {
    const disguised = { ...jd, name: 'attachment-2.pdf' };
    expect(buildCoverContext([disguised])).toBe('');
  });

  it('prefers a file named like a resume over one merely shaped like one', () => {
    const notes = {
      id: 'n', name: 'prep-notes.md', type: 'custom',
      content: 'My experience and education and skills are summarised here for study purposes. '.repeat(30),
    };
    const ctx = buildCoverContext([notes, resume]);
    expect(ctx.startsWith('PROFESSIONAL SUMMARY')).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CAP MUST REACH THE EMPLOYERS
//
//  Second half of the same incident. With the JD excluded, the cover
//  still said that the candidate's own CURRENT EMPLOYER "isn't a name
//  that comes up in my experience". Cause: the context was capped at
//  1,200 characters, which on a real resume is the summary and the
//  skills list. Measured on the actual document: the first employer name
//  appears at character 1,272, seventy-two past the cap, and the rest at
//  2,755 / 4,114 / 5,699.
//
//  Then a SECOND cap, in the server's prompt builder, kept slicing to
//  1,200 after the client cap was raised — so the fix appeared to do
//  nothing. Both are asserted here, because a limit in two places is a
//  limit that will disagree.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { userPrompt, COVER_SYSTEM: SYS } = req('../src/services/coverAnswer.js');

describe.skipIf(!real || !FIX_EMPLOYERS.length)('the cover reaches the employment history', () => {
  it('sends enough of the resume to include every employer', () => {
    const ctx = buildCoverContext(real);
    const resume = real.find(f => /resume/i.test(f.name)).content;
    for (const employer of FIX_EMPLOYERS) {
      // Only assert on names the document actually contains.
      if (!resume.includes(employer)) continue;
      expect(ctx, `"${employer}" was cut off before the cover could see it`).toContain(employer);
    }
  });

  it('survives the server-side cap too', () => {
    // The client can send a full resume and the server can still slice
    // the employers off. This is the check that catches that.
    const ctx = buildCoverContext(real);
    const prompt = userPrompt(`What did you do at ${FIX_EMPLOYERS[0]}?`, 'other', ctx);
    const resume = real.find(f => /resume/i.test(f.name)).content;
    for (const employer of FIX_EMPLOYERS) {
      if (!resume.includes(employer)) continue;
      expect(prompt, `"${employer}" is cut off by the server-side cap`).toContain(employer);
    }
  });
});

describe('never deny knowing something out loud', () => {
  it('the prompt forbids it', () => {
    // "I'm not familiar with <the hiring company>" — said out loud TO
    // that company. The background is the candidate's own history; it
    // says nothing about who they are talking to, and absence is not
    // evidence of unfamiliarity.
    expect(SYS).toMatch(/NEVER DENY KNOWING SOMETHING THE INTERVIEWER NAMED/);
    expect(SYS).toMatch(/Absence from it is NOT evidence/);
    expect(SYS).toMatch(/Never say you have not heard of, do not know, or\s*\n?are not familiar with anything/);
  });
});
