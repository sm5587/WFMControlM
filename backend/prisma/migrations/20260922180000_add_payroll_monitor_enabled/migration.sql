-- Per-client Payroll Monitor opt-in (default on so existing clients keep current behavior)
ALTER TABLE "Client" ADD COLUMN "payrollMonitorEnabled" BOOLEAN NOT NULL DEFAULT true;
