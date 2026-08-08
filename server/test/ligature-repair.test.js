// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE LIGATURE BUG THAT CLAIMED THREE EMPLOYERS
//
//  Some PDF generators emit fi/fl/ff as separate glyph runs, so pdfjs
//  hands the extractor "Certi fi ed" instead of "Certified".
//
//  That single broken word is what turned a CERTIFICATIONS block into
//  EMPLOYMENT. CERT_RE (`/\bcertified\b/i`) is the only thing standing
//  between the two, and it cannot match across a space. On one real
//  résumé the line
//
//      AWS Certi fi ed Solutions Architect - Associate | Amazon Web Services | Jun 2023
//
//  fell past the certification branch into the employer branch, and the
//  candidate's spoken opener became "…at Amazon Web Services in 2023.
//  Before that, Microsoft and Databricks." Three employers they never
//  had, said first, out loud, in an interview — while the real ones lost
//  on date order.
//
//  A parse failure that yields NOTHING is safe: the opener defers and the
//  model answers. A parse failure that yields the WRONG FACTS is spoken
//  instantly and with confidence. This suite pins the difference.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

const { repairLigatures, buildLedger, resetLedger } = await import('../../services/factLedger.ts');

describe('repairLigatures — the split forms pdfjs actually produces', () => {
  it('rejoins the exact string that caused the fabrication', () => {
    expect(repairLigatures('AWS Certi fi ed Solutions Architect')).toBe('AWS Certified Solutions Architect');
  });

  it('rejoins the other observed casualties', () => {
    expect(repairLigatures('Snow fl ake')).toBe('Snowflake');
    expect(repairLigatures('e ffi ciency')).toBe('efficiency');
    expect(repairLigatures('sta ff ing')).toBe('staffing');
    expect(repairLigatures('in fl uence')).toBe('influence');
  });

  it('normalises real Unicode ligature codepoints too', () => {
    expect(repairLigatures('Certiﬁed')).toBe('Certified');
    expect(repairLigatures('Snowﬂake')).toBe('Snowflake');
    expect(repairLigatures('eﬃciency')).toBe('efficiency');
  });

  it('leaves genuine English phrases alone', () => {
    // The whole reason the preceding word is captured and checked by name.
    expect(repairLigatures('sci fi movie')).toBe('sci fi movie');
    expect(repairLigatures('hi fi audio')).toBe('hi fi audio');
    // A capital on either side is never a broken word.
    expect(repairLigatures('Wi Fi network')).toBe('Wi Fi network');
  });

  it('never corrupts numbers — the placeholder trap', () => {
    // An earlier draft swapped guarded phrases for a numeric placeholder and
    // restored by index, which would have rewritten every real date and
    // metric in the résumé. These are the strings that would have broken.
    const dates = 'Jun 2023 to Present, 3 million events, 94 % uptime, 400 DAGs';
    expect(repairLigatures(dates)).toBe(dates);
    const mixed = 'Certi fi ed in 2023 with 3 million records and 45 minutes';
    expect(repairLigatures(mixed)).toBe('Certified in 2023 with 3 million records and 45 minutes');
  });

  it('is a no-op on text with no ligature damage', () => {
    const clean = 'Data Engineer at Apollo Hospitals | Kafka, Airflow | 2022-2024';
    expect(repairLigatures(clean)).toBe(clean);
    expect(repairLigatures('')).toBe('');
  });
});

describe('the fabrication itself — a certification must never become an employer', () => {
  const RESUME_WITH_BROKEN_CERTS = `
VENU MADHAV

PROFESSIONAL EXPERIENCE

Data Engineer | Apollo Hospitals | Jan 2022 - Dec 2023
Built Kafka pipelines processing 3 million clinical events daily.

Data Analyst | KIMS Hospitals | Jun 2020 - Dec 2021
Owned reporting for the cardiology unit.

CERTIFICATIONS

AWS Certi fi ed Solutions Architect - Associate | Amazon Web Services | Jun 2024
Microsoft Certi fi ed: Azure Data Engineer Associate | Microsoft | Mar 2024
`.trim();

  const file = (content) => [{ id: 'f1', name: 'resume.pdf', content }];

  it('does not report Amazon Web Services or Microsoft as employers', () => {
    resetLedger();
    const ledger = buildLedger(file(RESUME_WITH_BROKEN_CERTS));
    const employers = (ledger.employers || []).map((e) => String(e.subject || '').toLowerCase());
    // The whole point of the fix.
    expect(employers.join(' | ')).not.toMatch(/amazon web services/);
    expect(employers.join(' | ')).not.toMatch(/microsoft/);
  });

  it('still finds the REAL employers, which is what makes the fix worth having', () => {
    // Suppressing the certs is only half the job — a fix that also lost
    // Apollo and KIMS would just be a different kind of broken.
    resetLedger();
    const ledger = buildLedger(file(RESUME_WITH_BROKEN_CERTS));
    const employers = (ledger.employers || []).map((e) => String(e.subject || '').toLowerCase()).join(' | ');
    expect(employers).toMatch(/apollo/);
    expect(employers).toMatch(/kims/);
  });

  it('files the broken-ligature certs as certifications', () => {
    resetLedger();
    const ledger = buildLedger(file(RESUME_WITH_BROKEN_CERTS));
    const certs = JSON.stringify(ledger.certifications || []).toLowerCase();
    expect(certs).toMatch(/solutions architect|azure data engineer/);
  });

  it('never speaks a split ligature — no "Certi fi ed" reaches the vocabulary', () => {
    resetLedger();
    const ledger = buildLedger(file(RESUME_WITH_BROKEN_CERTS));
    const everything = JSON.stringify(ledger).toLowerCase();
    expect(everything).not.toMatch(/certi fi ed/);
    expect(everything).not.toMatch(/\bfi\b\s+ed\b/);
  });
});
