-- サイクル1.28: チャット入力へのテキスト添付（フェーズ1）の永続化。
-- 【重要】このファイルは `prisma migrate dev` ではなく手書きしたものである
-- （厳守事項によりこのサイクルでは `prisma migrate dev` を実行しない）。
-- DB への適用は人間が `prisma migrate deploy` で行うこと。

-- CreateTable
CREATE TABLE "DispatchAttachment" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DispatchAttachment_dispatchId_idx" ON "DispatchAttachment"("dispatchId");

-- AddForeignKey
ALTER TABLE "DispatchAttachment" ADD CONSTRAINT "DispatchAttachment_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
