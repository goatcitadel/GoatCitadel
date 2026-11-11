# Upgrade a WIN1252 GoatCitadel PostgreSQL database to UTF8

Migration 116 cannot create its Unicode whitespace helper on a WIN1252 database. An offline logical copy lets PostgreSQL transcode the database while retaining its migration history. The existing GoatCitadel migrator then upgrades the UTF8 copy. Keep the original database as the rollback point. [PostgreSQL dump options](https://www.postgresql.org/docs/16/app-pgdump.html) · [PostgreSQL restore options](https://www.postgresql.org/docs/16/app-pgrestore.html)

## Rehearse and back up

1. Record the source database version, server encoding, collation and character classification, active schema, migration table and latest migration, extensions, database and role settings, and application role privileges. Use a PostgreSQL dump utility compatible with the source and destination versions.
2. Preserve the GoatCitadel runtime configuration, key custody, and external files referenced by the database, along with a recoverable backup of the original database. PostgreSQL's per-database dump covers the database. Provision cluster-global roles, memberships, and any required tablespaces separately. [PostgreSQL backup scope](https://www.postgresql.org/docs/16/app-pgdump.html)
3. Rehearse on a separate server or cluster. For the final copy, stop the Gateway and all other writers, including background workers. Keep them stopped through validation and the connection switch. Use authenticated connections and restrict access to the archive as you would the database.

## Copy, validate, and upgrade

Create an empty UTF8 database from `template0` on the destination. Choose a UTF8-compatible locale appropriate for the deployment and check application ordering and uniqueness if collation changes. Pre-provision owners and ACL roles and make the required extension versions available. Reapply the source's applicable database-level permissions and settings to the new database. The archive restore below targets the already created UTF8 database and retains object ownership and grants. [PostgreSQL database creation](https://www.postgresql.org/docs/16/manage-ag-createdb.html) · [PostgreSQL restore options](https://www.postgresql.org/docs/16/app-pgrestore.html)

```powershell
# Set these to the verified source and new destination connections.
# Supply authentication through your normal PostgreSQL credential mechanism.
pg_dump --format=custom --encoding=UTF8 --file=goatcitadel-utf8.dump --dbname=$source
if ($LASTEXITCODE -ne 0) { throw "Source dump failed" }
pg_restore --single-transaction --exit-on-error --dbname=$target goatcitadel-utf8.dump
if ($LASTEXITCODE -ne 0) { throw "Destination restore failed" }
```

Check each command's exit status before continuing. Record the archive hash. If the dump fails to convert a value, diagnose that value on a copy. Keep the archive and source bytes intact. If restore fails, fix the destination prerequisite and repeat against an empty destination.

On the destination, confirm `SHOW server_encoding` returns `UTF8`. Before starting migration, compare the entire migration ledger with the source, compare table counts and key application records or content digests, and check sequence state, owner roles, ACLs, and representative multilingual text. Keep the original checksummed migration files and ledger.

Run the normal GoatCitadel migration flow against the destination only. Confirm that it reaches the expected version, preserves the prior ledger entries and representative records, and is idempotent on a second initialization. Check application connectivity and readiness in isolation with provider dispatch and external mutations disabled. Only then point the production Gateway and workers to the destination and reopen writes.

## Rollback boundary

Until writes resume on the new database, stop the candidate and restore the old connection and its compatible application version. Preserve both databases until the cutover is accepted. After new writes begin, reconcile destination-only changes before any rollback so they are not lost.

## Verification boundary

The rehearsal on merge `c6c6377fb4e3ea89cef08bf49593f2172cd94445` used two disposable PostgreSQL 16.13 clusters with C locale. The WIN1252 source was migrated through version 115 with the actual GoatCitadel registry. Its direct migration 116 attempt rolled back at the Unicode literal. The UTF8 restore matched counts and row-content digests across 379 tables, the complete source migration ledger, sequence state, and a sample grant. The normal migrator reached version 231 on the restored copy, preserved the original ledger prefix and legacy text and JSON, accepted Unicode whitespace in the heartbeat helper and an emoji in a subsequent write, and applied nothing on a second run. The legacy database was still intact and both fixture clusters shut down.

The data was synthetic. Rehearse each production database's roles, extensions, encoding conversion, collation, volume, and recovery process before its cutover.
