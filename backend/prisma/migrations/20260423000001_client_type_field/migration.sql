-- Remove description column from Client
ALTER TABLE "Client" DROP COLUMN "description";

-- Rename owner → clientType (carries existing values over; default new rows to 'BAU')
ALTER TABLE "Client" RENAME COLUMN "owner" TO "clientType";

-- Remove team column
ALTER TABLE "Client" DROP COLUMN "team";

-- Ensure any NULL clientType values become 'BAU'
UPDATE "Client" SET "clientType" = 'BAU' WHERE "clientType" IS NULL OR "clientType" = '';
