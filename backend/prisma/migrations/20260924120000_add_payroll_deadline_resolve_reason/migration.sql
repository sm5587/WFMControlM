-- Manual "Resolve with reason" for payroll deadline alerts (Escalated → Reports)
ALTER TABLE "PayrollDeadlineAlert" ADD COLUMN "resolvedBy" TEXT;
ALTER TABLE "PayrollDeadlineAlert" ADD COLUMN "resolveReason" TEXT;
