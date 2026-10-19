import { PDFParse } from 'pdf-parse';
import { AppError } from '../middleware/error-handler';

export type SupportedFormat = 'text' | 'pdf' | 'markdown';

export function detectFormat(filename: string): SupportedFormat {
  // "notes" has no extension; without this check split('.').pop() would
  // return the whole name and report it as ".notes"
  const dotIndex = filename.lastIndexOf('.');
  const ext = dotIndex > 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';

  switch (ext) {
    case 'txt':
      return 'text';
    case 'md':
      return 'markdown';
    case 'pdf':
      return 'pdf';
    default:
      // 415 Unsupported Media Type: a client mistake, not a server error.
      // A plain Error would reach the error handler as a 500.
      throw new AppError(
        415,
        ext ? `Unsupported file format: .${ext}` : 'File has no extension',
      );
  }
}

export async function extractText(
  content: Buffer | string,
  format: SupportedFormat,
): Promise<{ text: string; pageCount?: number }> {
  switch (format) {
    case 'text':
      return {
        text: typeof content === 'string' ? content : content.toString('utf-8'),
      };
    case 'markdown': {
      // Strip markdown formatting, keep the text
      const raw = typeof content === 'string' ? content : content.toString('utf-8');
      return {
        text: stripMarkdown(raw),
      };
    }
    case 'pdf': {
      const buffer = typeof content === 'string' ? Buffer.from(content, 'base64') : content;
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      return {
        text: cleanExtractedText(parsed.text),
        pageCount: parsed.total,
      };
    }
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '') // Headers
    .replace(/\*{1,3}(.*?)\*{1,3}/g, '$1') // Bold/italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // Code blocks
    .replace(/^[-*+]\s+/gm, '') // List markers
    .trim();
}

function cleanExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\n{3,}/g, '\n\n') // Collapse excessive newlines
    .replace(/\s{3,}/g, ' ') // Collapse excessive spaces
    .trim();
}
