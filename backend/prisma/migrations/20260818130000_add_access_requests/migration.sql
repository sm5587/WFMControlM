-- SSO/MFA access requests: capture LB email, admin approve/reject with profile assignment
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "sourceIp" TEXT,
    "userId" TEXT,
    CONSTRAINT "AccessRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AccessRequest_email_key" ON "AccessRequest"("email");
CREATE UNIQUE INDEX "AccessRequest_userId_key" ON "AccessRequest"("userId");
CREATE INDEX "AccessRequest_status_idx" ON "AccessRequest"("status");
CREATE INDEX "AccessRequest_requestedAt_idx" ON "AccessRequest"("requestedAt");
