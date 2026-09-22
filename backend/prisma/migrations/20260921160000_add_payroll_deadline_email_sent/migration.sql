-- Track when a payroll deadline alert was emailed to notification recipients
ALTER TABLE "PayrollDeadlineAlert" ADD COLUMN "emailSentAt" DATETIME;
