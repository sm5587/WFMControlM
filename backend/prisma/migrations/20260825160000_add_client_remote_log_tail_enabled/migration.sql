-- Per-client switch to disable remote log tail (SSH) for data sovereignty
ALTER TABLE "Client" ADD COLUMN "remoteLogTailEnabled" BOOLEAN NOT NULL DEFAULT true;
