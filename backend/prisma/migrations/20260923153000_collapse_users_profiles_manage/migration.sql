-- Collapse USERS_MANAGE → USERS_VIEW write, PROFILES_MANAGE → PROFILES_VIEW write
-- Keep stable function IDs (USERS_VIEW / PROFILES_VIEW); remove the *-MANAGE functions.

-- Preserve manage write onto the VIEW rows (nested SELECT avoids SQLite same-table UPDATE issue)
UPDATE "Permission"
SET "canWrite" = 1
WHERE "functionId" = 'USERS_VIEW'
  AND "profileId" IN (
    SELECT "profileId" FROM (
      SELECT "profileId" FROM "Permission"
      WHERE "functionId" = 'USERS_MANAGE' AND "canWrite" = 1
    )
  );

UPDATE "Permission"
SET "canWrite" = 1
WHERE "functionId" = 'PROFILES_VIEW'
  AND "profileId" IN (
    SELECT "profileId" FROM (
      SELECT "profileId" FROM "Permission"
      WHERE "functionId" = 'PROFILES_MANAGE' AND "canWrite" = 1
    )
  );

-- Ensure VIEW row exists when only MANAGE existed
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p."profileId", 'USERS_VIEW', 1, CASE WHEN p."canWrite" = 1 THEN 1 ELSE 0 END
FROM "Permission" p
WHERE p."functionId" = 'USERS_MANAGE';

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p."profileId", 'PROFILES_VIEW', 1, CASE WHEN p."canWrite" = 1 THEN 1 ELSE 0 END
FROM "Permission" p
WHERE p."functionId" = 'PROFILES_MANAGE';

DELETE FROM "Permission" WHERE "functionId" IN ('USERS_MANAGE', 'PROFILES_MANAGE');
DELETE FROM "AppFunction" WHERE "id" IN ('USERS_MANAGE', 'PROFILES_MANAGE');

UPDATE "AppFunction"
SET "description" = 'Read: view users & access requests. Write: edit users, approve/reject requests, revoke sessions.'
WHERE "id" = 'USERS_VIEW';

UPDATE "AppFunction"
SET "description" = 'Read: view profiles. Write: create/edit/delete profiles (permission matrix still needs Config write).'
WHERE "id" = 'PROFILES_VIEW';
