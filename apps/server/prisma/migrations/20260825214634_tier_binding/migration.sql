-- AlterTable
ALTER TABLE "Dispatch" ADD COLUMN     "model" TEXT,
ADD COLUMN     "tier" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "model" TEXT,
ADD COLUMN     "tier" TEXT;
