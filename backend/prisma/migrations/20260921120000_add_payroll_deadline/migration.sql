-- Payroll: per-client SLA deadline (days after week end + local HH:mm)
ALTER TABLE "Client" ADD COLUMN "payrollDeadlineDaysAfterWeekEnd" INTEGER;
ALTER TABLE "Client" ADD COLUMN "payrollDeadlineLocalTime" TEXT;
