// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AN UNREADABLE FILE MUST NOT BECOME THE KNOWLEDGE BASE
//
//  extractTextFromPdf used to CATCH its own failure and return the string
//
//    "Failed to extract text from PDF. Please ensure the file is not
//     corrupted or password protected."
//
//  …which handleFileUpload then stored as the file's `content`. So a
//  password-protected or scanned resume produced a knowledge base whose
//  entire text was an apology, and nothing downstream could tell the
//  difference between a document and an error message:
//
//    · the fact ledger extracted no employer, so the spoken opener had
//      nobody to name
//    · the BM25 index indexed the apology
//    · the answer prompt printed it under "KNOWLEDGE BASE (Resume/JD/Notes)"
//    · and the user saw the file sitting in the attached list, looking fine
//
//  Both extractors now throw, and the upload path declines to attach a file
//  it could not read and reports the COUNT (never the filename — a native
//  dialog is not covered by setContentProtection and would leak it to a
//  screen-share, which is why the failure was silent in the first place).
//
//  Source-level assertions, because the browser APIs these functions use
//  (File.arrayBuffer, pdfjs workers, mammoth) are not available here and
//  the contract that broke was "what does it do on failure", not "does it
//  parse a PDF".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (...p) => fs.readFileSync(path.resolve(process.cwd(), '..', ...p), 'utf8');
const PDF_SRC = read('services', 'pdfService.ts');
const DOCX_SRC = read('services', 'docxService.ts');
const APP_SRC = read('App.tsx');

describe('the extractors no longer return their own error text as a document', () => {
  it('the apology strings are gone', () => {
    expect(PDF_SRC).not.toMatch(/return "Failed to extract text from PDF/);
    expect(DOCX_SRC).not.toMatch(/return 'Failed to extract text from Word document/);
  });

  it('pdf: no catch that swallows the failure, and empty text throws', () => {
    const fn = /export const extractTextFromPdf[\s\S]*?\n};/.exec(PDF_SRC)[0];
    expect(fn).not.toMatch(/catch/);
    expect(fn).toMatch(/if \(!fullText\.trim\(\)\)/);
    expect(fn).toMatch(/throw new Error/);
    // A scan parses fine and yields nothing — same outcome as a parse
    // failure, because an empty document is just as unusable.
    expect(fn).toMatch(/scan or an image export/);
  });

  it('docx: same contract', () => {
    const fn = /export const extractTextFromDocx[\s\S]*?\n};/.exec(DOCX_SRC)[0];
    expect(fn).not.toMatch(/catch/);
    expect(fn).toMatch(/throw new Error/);
  });
});

describe('the upload path counts failures and surfaces them in-app', () => {
  it('both catch blocks increment the counter', () => {
    const handler = /const handleFileUpload = async[\s\S]*?\n  \};/.exec(APP_SRC)[0];
    const bumps = (handler.match(/unreadable\+\+;/g) || []).length;
    expect(bumps, 'expected the PDF and DOCX catch blocks to both count').toBe(2);
    // Reset per batch — the notice describes THIS upload, not a past one.
    expect(handler).toMatch(/setUnreadableCount\(0\);/);
    expect(handler).toMatch(/if \(unreadable > 0\) setUnreadableCount\(unreadable\);/);
  });

  it('the file is still NOT attached — counting it is not accepting it', () => {
    const handler = /const handleFileUpload = async[\s\S]*?\n  \};/.exec(APP_SRC)[0];
    // addContextFile must sit in the try, never in the catch.
    const pdfBranch = /if \(isPdf\) \{[\s\S]*?\n      \} else if \(isDocx\)/.exec(handler)[0];
    const catchBody = /\} catch \(err\) \{[\s\S]*?\n        \} finally/.exec(pdfBranch)[0];
    expect(catchBody).not.toMatch(/addContextFile/);
  });

  it('the notice is rendered, and reports a count rather than a filename', () => {
    expect(APP_SRC).toMatch(/const UnreadableFilesNotice = /);
    expect(APP_SRC).toMatch(/\{unreadableCount > 0 && \(/);
    const notice = /const UnreadableFilesNotice = [\s\S]*?\n\);/.exec(APP_SRC)[0];
    // It takes a count and nothing else — there is no filename to leak.
    expect(notice).toMatch(/\{ count, onDismiss \}: \{ count: number; onDismiss: \(\) => void \}/);
    expect(notice).not.toMatch(/file\.name|fileName|filename/);
    // And it is in-app, not a native dialog.
    expect(notice).not.toMatch(/alert\(|confirm\(/);
    expect(notice).toMatch(/role="status"/);
  });

  it('no native dialog in the extraction branches', () => {
    // Scoped to the PDF/DOCX branches on purpose. The wider function also
    // contains handleModalPaste's 500K-char paste guard, which DOES use
    // alert() — that one predates this work, names no file, and is about
    // paste size rather than an unreadable document. Widening this
    // assertion to the whole function only produces a false alarm about
    // unrelated, correct code.
    const handler = /const handleFileUpload = async[\s\S]*?\n  \};/.exec(APP_SRC)[0];
    const branches = /if \(isPdf\) \{[\s\S]*?\n      \} else if \(isText\)/.exec(handler)[0];
    // Comments stripped: the catch block's own comment EXPLAINS why a native
    // alert() would be wrong here, and matching that sentence is not the
    // same as finding a call. (It failed on exactly that the first time.)
    const code = branches.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\balert\(/);
    expect(code).not.toMatch(/\bconfirm\(/);
    // and both extraction branches are represented in that slice
    expect(branches).toMatch(/extractTextFromPdf/);
    expect(branches).toMatch(/extractTextFromDocx/);
  });
});
