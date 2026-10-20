-- (Removed Prisma's DROP INDEX "Chunk_embedding_idx": see the note in schema.prisma)

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "reviewStatus" TEXT;

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "documentId" TEXT,
    "question" TEXT NOT NULL,
    "generatedAnswer" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "sources" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewItem_messageId_key" ON "ReviewItem"("messageId");

-- CreateIndex
CREATE INDEX "ReviewItem_status_dueAt_idx" ON "ReviewItem"("status", "dueAt");

-- CreateIndex
CREATE INDEX "ReviewItem_userId_createdAt_idx" ON "ReviewItem"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
