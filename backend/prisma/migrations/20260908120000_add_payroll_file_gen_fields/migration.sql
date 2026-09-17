-- Payroll: file-split PF, prior-period adj flags (frequency stays on payrollCycle)
ALTER TABLE "Client" ADD COLUMN "payrollFileGen" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Client" ADD COLUMN "priorPeriodEdit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Client" ADD COLUMN "priorPeriodEditLimit" INTEGER NOT NULL DEFAULT 0;
