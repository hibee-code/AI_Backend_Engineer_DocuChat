-- (Removed Prisma's DROP INDEX "Chunk_embedding_idx": see the note in schema.prisma)

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "costUsd" DECIMAL(10,6),
ADD COLUMN     "documentId" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "promptTokens" INTEGER;

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
