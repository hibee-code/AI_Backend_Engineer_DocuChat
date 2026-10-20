/*
  Warnings:

  - You are about to drop the column `reviewStatus` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the `ReviewItem` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ReviewPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- DropForeignKey
ALTER TABLE "ReviewItem" DROP CONSTRAINT "ReviewItem_messageId_fkey";

-- (Removed Prisma's DROP INDEX "Chunk_embedding_idx": see the note in schema.prisma)

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "reviewStatus";

-- DropTable
DROP TABLE "ReviewItem";

-- CreateTable
CREATE TABLE "ReviewQueue" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "documentId" TEXT,
    "question" TEXT NOT NULL,
    "generatedAnswer" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sources" JSONB NOT NULL,
    "reason" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "ReviewPriority" NOT NULL DEFAULT 'NORMAL',
    "reviewedBy" TEXT,
    "editedAnswer" TEXT,
    "reviewerNotes" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "slaDeadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewQueue_messageId_key" ON "ReviewQueue"("messageId");

-- CreateIndex
CREATE INDEX "ReviewQueue_status_priority_createdAt_idx" ON "ReviewQueue"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewQueue_reviewedBy_idx" ON "ReviewQueue"("reviewedBy");

-- CreateIndex
CREATE INDEX "ReviewQueue_slaDeadline_idx" ON "ReviewQueue"("slaDeadline");

-- AddForeignKey
ALTER TABLE "ReviewQueue" ADD CONSTRAINT "ReviewQueue_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewQueue" ADD CONSTRAINT "ReviewQueue_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewQueue" ADD CONSTRAINT "ReviewQueue_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
