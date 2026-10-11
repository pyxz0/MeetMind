-- CreateEnum
CREATE TYPE "MeetingCompletionStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "completionStatus" "MeetingCompletionStatus" NOT NULL DEFAULT 'NOT_STARTED';
