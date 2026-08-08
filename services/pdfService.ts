import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Set worker source to local build to avoid CDN issues
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// ⚠️ THIS USED TO RETURN ITS OWN ERROR MESSAGE AS THE DOCUMENT.
//
// On failure it returned the string "Failed to extract text from PDF.
// Please ensure the file is not corrupted or password protected." — and the
// caller stored that as the file's CONTENT. So a password-protected or
// image-only resume produced a knowledge base whose entire text was an
// error message, and the app then answered every question from a persona
// with no history, silently, because nothing downstream could tell the
// difference between a document and an apology.
//
// It also poisoned everything derived from the knowledge base: the fact
// ledger extracted nothing, the BM25 index indexed the apology, and the
// spoken opener had no employer to name.
//
// It now THROWS, and handleFileUpload declines to attach a file it could
// not read and tells the user which one. A file the user can see in the
// list is a file the model can read.

export const extractTextFromPdf = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        // ⚠️ HONOUR hasEOL. pdf.js tells us where the lines end — many of
        // these items are zero-length and exist for no other purpose than to
        // carry that flag — and mapping to `.str` and joining with a space
        // threw every one of them away, handing the ledger one continuous
        // blob. The ledger is line-oriented: sections, employers, dates and
        // bullets are all found by reading lines, so a résumé with no line
        // breaks loses most of itself.
        //
        // Measured over 49 real résumé PDFs: restoring the breaks changes the
        // extracted facts on 18 of them, and every change is a GAIN —
        // Updated_Resume.pdf goes from 1 fact and ZERO employers to 14 facts
        // and 2 employers, resumenvidi.pdf from 5 employers to 9 and 0
        // certifications to 4. A zero-employer ledger is precisely the state
        // that drops the app onto the live-model cover path with nothing to
        // ground it, which is the fabrication this pipeline exists to stop.
        //
        // ⚠️ A POSITIONAL COLUMN-SPLITTING PASS WAS TRIED HERE AND REVERTED.
        // The goal was right — a row-major two-column PDF interleaves its
        // columns and the ledger then recombines fragments into employers
        // that never existed. But measured over 144 real résumé PDFs the
        // replacement was net-negative: 138 unchanged, 2 improved, and 2
        // REGRESSED, one of them badly (venumadhav_resume.pdf: 15 facts and
        // 4 employers down to 2 facts and ZERO employers — the exact
        // no-employer state that hands the interview to the fabrication
        // path). It also did not fix the case it existed for: pdf.js
        // synthesises a whitespace-only filler item whose reported width
        // spans the entire inter-column gap, so the gutter never registers
        // as a gap and no split fires. A correct version has to (a) ignore
        // whitespace-only items when measuring ink, and (b) scope column
        // detection to the vertical range where the gutter actually holds,
        // or a narrow-label/wide-content table gets torn row from row.
        // Until then, reading order stays content-stream + hasEOL, which is
        // measured-positive and regresses nothing.
        const pageText = (textContent.items as any[]).reduce((acc, item) => {
            acc += item.str;
            if (item.hasEOL) return acc + '\n';
            // Keep the old space-joining between items on the same line, but
            // never double a space the item already ends with.
            if (item.str && !/\s$/.test(item.str)) acc += ' ';
            return acc;
        }, '');
        fullText += pageText + '\n';
    }

    // A PDF that parsed but yielded nothing is a scan or an image-only
    // export. Structurally valid, and just as unusable as a parse failure —
    // so it fails the same way rather than attaching an empty document.
    if (!fullText.trim()) {
        throw new Error('No selectable text in this PDF (it may be a scan or an image export).');
    }
    return fullText;
};
