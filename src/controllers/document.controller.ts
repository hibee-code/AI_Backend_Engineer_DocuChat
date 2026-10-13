import type { Request, Response } from 'express';
import type { z } from 'zod';
import path from 'path';
import * as documentService from '../services/document.service';
import { detectFormat } from '../lib/documentExtractor';
import { AppError } from '../middleware/error-handler';
import type {
  createDocumentSchema,
  documentParamsSchema,
  listDocumentsSchema,
  uploadDocumentSchema,
} from '../validators/document.validator';

// Request shapes after validate() has run (see validators/document.validator.ts)
type ListQuery = z.infer<typeof listDocumentsSchema>['query'];
type CreateBody = z.infer<typeof createDocumentSchema>['body'];
type DocumentParams = z.infer<typeof documentParamsSchema>['params'];
type UploadBody = z.infer<typeof uploadDocumentSchema>['body'];

// Express 5 forwards rejected promises to the error handler, so no try/catch needed.

export async function listDocuments(req: Request, res: Response) {
  const { page, limit, status } = req.query as unknown as ListQuery;
  const result = await documentService.listDocuments(req.user!.id, {
    page,
    limit,
    status,
  });
  res.json(result);
}

export async function createDocument(req: Request<unknown, unknown, CreateBody>, res: Response) {
  const result = await documentService.createDocument({
    userId: req.user!.id,
    title: req.body.title,
    content: req.body.content,
    correlationId: req.correlationId,
  });
  // 202 Accepted: the document is saved but still being processed in the background
  res.status(202).json(result);
}

// File upload (.txt, .md, .pdf). Text formats are stored as UTF-8; PDFs as
// base64, which the worker's extractText decodes.
export async function uploadDocument(req: Request<unknown, unknown, UploadBody>, res: Response) {
  const file = req.file;
  if (!file) throw new AppError(400, 'No file uploaded (use the "file" form field)');

  const filename = path.basename(file.originalname);
  const format = detectFormat(filename);

  if (format === 'pdf' && file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError(415, 'File is not a valid PDF');
  }

  const content = format === 'pdf' ? file.buffer.toString('base64') : file.buffer.toString('utf-8');
  if (!content.trim()) throw new AppError(400, 'File is empty');

  const result = await documentService.createDocument({
    userId: req.user!.id,
    title: req.body.title ?? path.parse(filename).name,
    content,
    filename,
    correlationId: req.correlationId,
  });
  // 202 Accepted: the document is saved but still being processed in the background
  res.status(202).json(result);
}

export async function getDocument(req: Request<DocumentParams>, res: Response) {
  res.json(await documentService.getDocument(req.user!.id, req.params.id));
}

export async function deleteDocument(req: Request<DocumentParams>, res: Response) {
  await documentService.deleteDocument(req.user!.id, req.params.id, req.correlationId);
  res.status(204).end();
}
