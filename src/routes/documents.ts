import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { uploadLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { uploadDocumentFile } from '../middleware/upload';
import { prisma } from '../lib/prisma';
import { documentQueue } from '../queues/document.queue';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  uploadDocument,
} from '../controllers/document.controller';

import {
  createDocumentSchema,
  listDocumentsSchema,
  documentParamsSchema,
  uploadDocumentSchema,
} from '../validators/document.validator';

const router = Router();
router.use(authenticate); // All document routes require auth

/**
 * @swagger
 * /documents:
 *   get:
 *     summary: List user's documents
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, ready, failed]
 *     responses:
 *       200:
 *         description: List of documents
 *       401:
 *         description: Not authenticated
 */
router.get('/', validate(listDocumentsSchema), listDocuments);

router.post(
  '/',
  uploadLimiter, // Upload-specific limit
  requirePermission('documents:create'),
  validate(createDocumentSchema),
  createDocument,
);

/**
 * @swagger
 * /documents/upload:
 *   post:
 *     summary: Upload a document file (.txt, .md or .pdf, max 10 MB)
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               title:
 *                 type: string
 *                 description: Defaults to the file name
 *     responses:
 *       202:
 *         description: Saved and queued for processing
 *       400:
 *         description: No file, empty file, or invalid upload
 *       413:
 *         description: File too large
 *       415:
 *         description: Unsupported file type
 */
router.post(
  '/upload',
  uploadLimiter,
  requirePermission('documents:create'),
  uploadDocumentFile, // Parses multipart: fills req.file and req.body
  validate(uploadDocumentSchema),
  uploadDocument,
);

router.get('/:id', validate(documentParamsSchema), getDocument);

router.delete('/:id', validate(documentParamsSchema), deleteDocument);

router.get(
  '/:id/processing-status',
  authenticate,
  requirePermission('documents:read'),
  async (req, res) => {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, status: true, error: true, userId: true },
    });

    if (!doc || doc.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Document not found' },
      });
    }

    // Try to find the active job for this document
    const jobs = await documentQueue.getJobs(['active', 'waiting']);
    const activeJob = jobs.find((j) => j.data.documentId === req.params.id);

    res.json({
      success: true,
      data: {
        status: doc.status,
        error: doc.error,
        progress: activeJob ? await activeJob.progress : null,
      },
    });
  },
);

export default router;
