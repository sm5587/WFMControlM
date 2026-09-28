-- Remove the columnName field from CustomAlert.
-- Custom alert queries are now aggregate-only and return a single value, so a
-- separate "track column" is no longer needed.
ALTER TABLE "CustomAlert" DROP COLUMN "columnName";
