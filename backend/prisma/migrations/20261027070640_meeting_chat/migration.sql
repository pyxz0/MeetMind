-- CreateTable
CREATE TABLE "meeting_chat_messages" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "role" VARCHAR(16) NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_chat_messages_meeting_id_created_at_idx" ON "meeting_chat_messages"("meeting_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "meeting_chat_messages" ADD CONSTRAINT "meeting_chat_messages_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_chat_messages" ADD CONSTRAINT "meeting_chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
