-- LDAP access requests: store AD sAMAccountName for correct user provisioning on approve
ALTER TABLE "AccessRequest" ADD COLUMN "requestedUsername" TEXT;
