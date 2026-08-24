-- AlterTable
ALTER TABLE "Dispatch" ADD COLUMN     "instruction" TEXT,
ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "statusReason" TEXT,
ALTER COLUMN "status" SET DEFAULT 'draft';

-- CreateIndex
CREATE INDEX "Dispatch_status_statusChangedAt_idx" ON "Dispatch"("status", "statusChangedAt");

-- Backfill: 既存行の statusChangedAt を updatedAt から復元する
-- （新規追加した statusChangedAt は ALTER TABLE 時点で全行 CURRENT_TIMESTAMP になるため）。
-- 本 devlog 作成時点で Dispatch は 0 行・書き手ゼロだが、将来このマイグレーションが
-- populated な DB に対して再適用されるケースへの防御として残す。
UPDATE "Dispatch" SET "statusChangedAt" = "updatedAt";

-- Backfill: サイクル1.7 ③-1 で状態機械から 'pending' を除外した
-- （doc/orchestrator-layer3-design.md §2 の権威ある10状態列挙に 'pending' は含まれないため）。
-- 'pending' の行が存在した場合は新しい既定の入口状態 'draft' へ寄せる。
UPDATE "Dispatch" SET "status" = 'draft' WHERE "status" = 'pending';
