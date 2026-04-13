import mammoth from 'mammoth';

export const extractTextFromDocx = async (file: File): Promise<string> => {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value || '';
  } catch (error) {
    console.error('Error extracting text from DOCX:', error);
    return 'Failed to extract text from Word document. Please ensure the file is not corrupted.';
  }
};
