-- Per-client JDBC TLS flag (IBM JCC sslConnection=true)
ALTER TABLE "Client" ADD COLUMN "db2SslEnabled" BOOLEAN NOT NULL DEFAULT false;
