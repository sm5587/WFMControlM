-- Add DB2 username and password columns to Client table
-- Credentials are populated by the import-db2-creds.ts script from existing txt files.
-- Once Keeper is integrated, db2Password will be replaced by Keeper lookups.

ALTER TABLE "Client" ADD COLUMN "db2Username" TEXT;
ALTER TABLE "Client" ADD COLUMN "db2Password" TEXT;
