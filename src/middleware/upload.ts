import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { detectFormat } from '../lib/documentExtractor';
import { AppError } from './error-handler';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// Keep the file in memory: it is stored in Document.content, not on disk
const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    try {
      detectFormat(file.originalname); // Throws 415 for unsupported extensions
      cb(null, true);
    } catch (error) {
      cb(error as Error);
    }
  },
}).single('file');

// Parses a multipart upload with one file in the "file" field. Multer's own
// errors (too large, wrong field) become 4xx responses instead of 500s.
export function uploadDocumentFile(req: Request, res: Response, next: NextFunction) {
  multerUpload(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? `File too large (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB)`
          : `Invalid upload: ${error.message}`;
      return next(new AppError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, message));
    }
    next(error);
  });
}
