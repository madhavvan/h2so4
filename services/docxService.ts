import mammoth from 'mammoth';

// Throws rather than returning its own error text as the document — see the
// note in pdfService.ts for what that cost. An unreadable file must not
// become a knowledge base whose only content is an apology.
export const extractTextFromDocx = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  const text = result?.value || '';
  if (!text.trim()) {
    throw new Error('No text found in this Word document.');
  }
  return text;
};
