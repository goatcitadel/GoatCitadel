/* eslint-disable max-lines -- keep async/sync migration, bootstrap replacement, and final catalog fencing in one transaction owner. */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseClient } from "../db.js";
import { assertValidAppliedMigrationLedger, assertValidMigrationDefinitions } from "../migration-ledger-validation.js";
import {
  assertPostgresMigrationLockReleased,
  buildPostgresMigrationTryLockSql,
  buildPostgresMigrationUnlockSql,
  parsePostgresMigrationTryLockResult,
  PostgresDatabaseClient,
} from "./client.js";
import {
  assertPostgresHistoryRepairTempRelationAvailable,
  assertPostgresHistoryRepairTempViewOwnsResolution,
  assertPostgresHistoryRepairRegistryIntegrity,
  assertLegacyCompoundV124Catalog,
  assertLegacyCompoundV124LedgerRepairResult,
  assertPostgresMigrationCurrentSchemaIsDurable,
  assertPostgresMigrationLedgerNotShadowed,
  assertPostgresMigrationSessionIsIdle,
  assertPostgresMigrationTransactionProbeAcquired,
  assertPostgresMigrationSchemaIdentityMatches,
  assertPostgresMigrationSearchPathConfigured,
  assertPostgresMigrationSessionHasNoTempObjects,
  buildPostgresMigrationLedgerGuardLockSql,
  buildPostgresMigrationSchemaIdentityCheckSql,
  buildPostgresMigrationSearchPath,
  buildPostgresMigrationSetLocalSearchPathSql,
  buildPostgresMigrationTransactionDatabaseClassificationSql,
  buildPostgresQualifiedMigrationLedger,
  buildPostgresMigrationLedgerTempShadowPreflightSql,
  buildPostgresHistoryRepairTempViewSql,
  buildPostgresLegacyCompoundLedgerRepairLockSql,
  buildPostgresLegacyCompoundLedgerRepairSql,
  classifyLegacyCompoundV124Ledger,
  isPostgresHistoryRepairMigration,
  normalizePostgresMigrationLedgerForHistoricalRepair,
  parsePostgresMigrationActiveTransactionIds,
  selectPostgresMigrationPreexistingTransactionIds,
  classifyPostgresMigrationTransactionDatabase,
  POSTGRES_HISTORY_REPAIR_TEMP_RELATION_PREFLIGHT_SQL,
  POSTGRES_HISTORY_REPAIR_TEMP_VIEW_DROP_SQL,
  POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL,
  POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL,
  POSTGRES_LEGACY_COMPOUND_V124_RELATION_LOCK_SQL,
  PostgresMigrationSessionContaminationError,
  POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL,
  POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL,
  POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_TEMP_OBJECT_PREFLIGHT_SQL,
  type PostgresMigrationSchemaIdentity,
  quotePostgresIdentifier,
  requiresPostgresHistoryRepairLedgerBridge,
} from "./migration-ledger-compatibility.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration, type PostgresMigrationBatchStatement } from "./migrations.js";
import {
  assertPostgresSchemaShapeIssues,
  buildPostgresSchemaShapeManifest,
  buildPostgresSchemaShapeRelationLockSql,
  buildPostgresSchemaShapeReplacementLockSql,
  buildPostgresSchemaShapeReplacementValidationSql,
  buildPostgresSchemaShapeValidationSql,
  POSTGRES_SCHEMA_SHAPE_REPLACEMENT_VALIDATION_SQL,
  POSTGRES_SCHEMA_SHAPE_VALIDATION_SQL,
  type PostgresSchemaShapeManifest,
  type PostgresSchemaShapeIssueRow,
} from "./schema-shape.js";
import type { PostgresPinnedSessionControls } from "./sync.js";

const POSTGRES_MIGRATION_LOCK_RETRY_MS = 100;
const POSTGRES_MIGRATION_QUIESCENCE_RETRY_MS = 50;
const POSTGRES_MIGRATION_QUIESCENCE_TIMEOUT_MS = 5_000;
const POSTGRES_MIGRATION_LOCK_RETRY_STATE = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const GOVERNED_REMEDIATION_FOUNDATION_VERSION = 134;
const GOVERNED_REMEDIATION_FOUNDATION_NAME = "governed_remediation_durable_owner";
const GOVERNED_REMEDIATION_AUTHORITY_VERSION = 135;
const GOVERNED_REMEDIATION_AUTHORITY_NAME = "governed_remediation_recipe_and_phase_authority";
const GOVERNED_REMEDIATION_BOOTSTRAP_TABLES = [
  "governed_remediation_states",
  "governed_remediation_receipts",
  "governed_remediation_failures",
  "governed_remediation_reconciliations",
  "governed_remediation_cas_transitions",
  "governed_remediation_phase_claims",
  "governed_remediation_phase_claim_acquisitions",
] as const;
const GOVERNED_REMEDIATION_BOOTSTRAP_DROP_ORDER = [
  "governed_remediation_phase_claim_acquisitions",
  "governed_remediation_phase_claims",
  "governed_remediation_cas_transitions",
  "governed_remediation_reconciliations",
  "governed_remediation_failures",
  "governed_remediation_receipts",
  "governed_remediation_states",
] as const;
const REMOTE_WORKER_MESH_AUTHORITY_VERSION = 137;
const REMOTE_WORKER_MESH_AUTHORITY_NAME = "remote_worker_mesh_node_admission_authority";
const REMOTE_WORKER_MESH_BOOTSTRAP_TABLES = [
  "mesh_capability_node_admissions",
  "remote_worker_mesh_join_authorities",
  "remote_worker_mesh_join_authority_revocations",
  "remote_worker_mesh_node_bindings",
  "remote_worker_mesh_node_admission_attempts",
] as const;
const REMOTE_WORKER_MESH_BOOTSTRAP_DROP_ORDER = [
  "remote_worker_mesh_node_admission_attempts",
  "remote_worker_mesh_node_bindings",
  "remote_worker_mesh_join_authority_revocations",
  "remote_worker_mesh_join_authorities",
] as const;
const MOBILE_PUSH_AUTHORITY_VERSION = 138;
const MOBILE_PUSH_AUTHORITY_NAME = "mobile_push_registration_and_delivery_owner";
const DURABLE_HEARTBEAT_AUTHORITY_VERSION = 116;
const DURABLE_HEARTBEAT_AUTHORITY_NAME = "durable_heartbeat_occurrence_authority";
const SECURE_CONFIGURATION_REPAIR_VERSION = 132;
const SECURE_CONFIGURATION_REPAIR_NAME = "repair_durable_chat_secure_configuration_reservations";
const CANONICAL_SCHEMA_AUTHORITY_VERSION = 140;
const CANONICAL_SCHEMA_AUTHORITY_NAME = "canonical_postgres_schema_authority";
const CANONICAL_SCHEMA_AUTHORITY_CHECKS = [
  { tableName: "assembly_runs", name: "assembly_runs_run_kind_check" },
  { tableName: "assembly_runs", name: "assembly_runs_generation_check" },
  { tableName: "chat_routed_context_snapshots", name: "chat_routed_context_snapshots_schema_version_v2_check" },
  { tableName: "external_source_configs", name: "external_source_configs_input_flavor_posix_check" },
  { tableName: "external_source_configs", name: "external_source_configs_target_flavor_posix_check" },
  { tableName: "model_usage_events", name: "model_usage_events_cap_retry_lineage_check" },
  { tableName: "workspace_path_bridge_snapshots", name: "workspace_path_bridge_snapshots_input_flavor_posix_check" },
  { tableName: "workspace_path_bridge_snapshots", name: "workspace_path_bridge_snapshots_target_flavor_posix_check" },
] as const;
const MOBILE_PUSH_BOOTSTRAP_TABLES = ["mobile_push_registrations", "mobile_push_deliveries"] as const;
const MOBILE_PUSH_BOOTSTRAP_DROP_ORDER = ["mobile_push_deliveries", "mobile_push_registrations"] as const;

const POSTGRES_GOVERNED_REMEDIATION_BOOTSTRAP_PREFLIGHT_SQL = `
  /* goatcitadel_governed_remediation_bootstrap_preflight */
  SELECT
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
        AND relation.relname OPERATOR(pg_catalog.=) 'governed_remediation_states'
        AND relation.relkind OPERATOR(pg_catalog.=) 'r'
    ) AS state_table_exists,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
        AND relation.relname OPERATOR(pg_catalog.=) 'governed_remediation_states'
        AND relation.relkind OPERATOR(pg_catalog.=) 'r'
        AND attribute.attname OPERATOR(pg_catalog.=) 'approval_id'
        AND attribute.attnum OPERATOR(pg_catalog.>) 0
        AND NOT attribute.attisdropped
    ) AS legacy_approval_column_exists
`;

const POSTGRES_REMOTE_WORKER_MESH_BOOTSTRAP_PREFLIGHT_SQL = `
  /* goatcitadel_remote_worker_mesh_bootstrap_preflight */
  SELECT
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
        AND relation.relname OPERATOR(pg_catalog.=) 'mesh_capability_node_admissions'
        AND relation.relkind OPERATOR(pg_catalog.=) 'r'
    ) AS admission_table_exists,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
        AND relation.relname OPERATOR(pg_catalog.=) 'mesh_capability_node_admissions'
        AND relation.relkind OPERATOR(pg_catalog.=) 'r'
        AND attribute.attname OPERATOR(pg_catalog.=) 'provenance_kind'
        AND attribute.attnum OPERATOR(pg_catalog.>) 0
        AND NOT attribute.attisdropped
    ) AS final_provenance_column_exists
`;

const POSTGRES_REMOTE_WORKER_MESH_PROVENANCE_DEPENDENCY_PREFLIGHT_SQL = `
  /* goatcitadel_remote_worker_mesh_provenance_dependency_preflight */
  WITH target AS (
    SELECT
      relation.oid AS relation_oid,
      attribute.attnum,
      attribute.atttypid,
      attribute.attnotnull,
      attribute.atthasdef,
      attribute.atthasmissing,
      attribute.attmissingval,
      attribute.attidentity,
      attribute.attgenerated,
      attribute.attislocal,
      attribute.attinhcount,
      attribute.attcollation,
      attribute.attstorage,
      attribute.attcompression,
      attribute.attstattarget,
      attribute.attacl,
      attribute.attoptions,
      attribute.attfdwoptions,
      pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false) AS default_expression
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid OPERATOR(pg_catalog.=) relation.oid
      AND default_value.adnum OPERATOR(pg_catalog.=) attribute.attnum
    WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND relation.relname OPERATOR(pg_catalog.=) 'mesh_capability_node_admissions'
      AND relation.relkind OPERATOR(pg_catalog.=) 'r'
      AND attribute.attname OPERATOR(pg_catalog.=) 'provenance_kind'
      AND attribute.attnum OPERATOR(pg_catalog.>) 0
      AND NOT attribute.attisdropped
  )
  SELECT EXISTS (
    SELECT 1
    FROM target
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.refclassid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.refobjid OPERATOR(pg_catalog.=) target.relation_oid
      AND dependency.refobjsubid OPERATOR(pg_catalog.=) target.attnum
    WHERE NOT (
      dependency.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_attrdef'::pg_catalog.regclass
      AND dependency.deptype OPERATOR(pg_catalog.=) 'a'
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attrdef AS default_value
        WHERE default_value.oid OPERATOR(pg_catalog.=) dependency.objid
          AND default_value.adrelid OPERATOR(pg_catalog.=) target.relation_oid
          AND default_value.adnum OPERATOR(pg_catalog.=) target.attnum
      )
    )
  ) OR EXISTS (
    SELECT 1
    FROM target
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhrelid OPERATOR(pg_catalog.=) target.relation_oid
      OR inheritance.inhparent OPERATOR(pg_catalog.=) target.relation_oid
  ) OR EXISTS (
    SELECT 1
    FROM target
    JOIN pg_catalog.pg_attribute AS dropped_attribute
      ON dropped_attribute.attrelid OPERATOR(pg_catalog.=) target.relation_oid
      AND dropped_attribute.attnum OPERATOR(pg_catalog.>) 0
      AND dropped_attribute.attisdropped
  ) OR EXISTS (
    SELECT 1
    FROM target
    WHERE target.attnum IS DISTINCT FROM 11
      OR target.atttypid OPERATOR(pg_catalog.<>) 'pg_catalog.text'::pg_catalog.regtype
      OR NOT target.attnotnull
      OR NOT target.atthasdef
      OR target.atthasmissing
      OR target.attmissingval IS NOT NULL
      OR target.attidentity OPERATOR(pg_catalog.<>) ''
      OR target.attgenerated OPERATOR(pg_catalog.<>) ''
      OR NOT target.attislocal
      OR target.attinhcount OPERATOR(pg_catalog.<>) 0
      OR target.attcollation IS DISTINCT FROM (
        SELECT collation_row.oid
        FROM pg_catalog.pg_collation AS collation_row
        WHERE collation_row.collnamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace
          AND collation_row.collname OPERATOR(pg_catalog.=) 'default'
      )
      OR target.attstorage OPERATOR(pg_catalog.<>) 'x'
      OR target.attcompression OPERATOR(pg_catalog.<>) ''
      OR target.attstattarget OPERATOR(pg_catalog.<>) -1
      OR target.attacl IS NOT NULL
      OR target.attoptions IS NOT NULL
      OR target.attfdwoptions IS NOT NULL
      OR target.default_expression IS DISTINCT FROM '''legacy''::text'
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_description AS description
        WHERE description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
          AND description.objoid OPERATOR(pg_catalog.=) target.relation_oid
          AND description.objsubid OPERATOR(pg_catalog.=) target.attnum
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
          AND security_label.objoid OPERATOR(pg_catalog.=) target.relation_oid
          AND security_label.objsubid OPERATOR(pg_catalog.=) target.attnum
      )
  ) AS unexpected_owned_dependency_exists
`;

const POSTGRES_MOBILE_PUSH_BOOTSTRAP_PREFLIGHT_SQL = `
  /* goatcitadel_mobile_push_bootstrap_preflight */
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND relation.relname OPERATOR(pg_catalog.=) 'mobile_push_registrations'
      AND relation.relkind OPERATOR(pg_catalog.=) 'r'
  ) AS registration_table_exists
`;

const POSTGRES_MOBILE_PUSH_BOOTSTRAP_DEFAULTS_SQL = `
  /* goatcitadel_mobile_push_bootstrap_defaults */
  WITH expected_defaults(column_name, default_expression) AS (
    VALUES
      ('attempt_count'::pg_catalog.text, '0'::pg_catalog.text),
      ('max_attempts'::pg_catalog.text, '5'::pg_catalog.text),
      ('version'::pg_catalog.text, '1'::pg_catalog.text)
  ),
  actual_defaults AS (
    SELECT
      attribute.attname AS column_name,
      pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false) AS default_expression
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      AND attribute.attnum OPERATOR(pg_catalog.>) 0
      AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid OPERATOR(pg_catalog.=) relation.oid
      AND default_value.adnum OPERATOR(pg_catalog.=) attribute.attnum
    WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND relation.relname OPERATOR(pg_catalog.=) 'mobile_push_deliveries'
      AND attribute.attname IN ('attempt_count', 'max_attempts', 'version')
  )
  SELECT
    pg_catalog.count(*) OPERATOR(pg_catalog.=) 3
      AND pg_catalog.bool_and(
        actual.default_expression IS NOT DISTINCT FROM expected.default_expression
      ) AS defaults_exact
  FROM expected_defaults AS expected
  LEFT JOIN actual_defaults AS actual
    ON actual.column_name OPERATOR(pg_catalog.=) expected.column_name
`;

export interface PostgresMigrationRunResult {
  appliedVersions: number[];
  latestVersion: number;
}

export async function runPostgresMigrations(
  client: PostgresDatabaseClient,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
): Promise<PostgresMigrationRunResult> {
  assertValidPostgresMigrationRegistry(migrations);
  return client.withMigrationLock(async (pinnedClient) => {
    const migrationSchema = await client.assertMigrationsTableNotShadowed(pinnedClient);
    await client.awaitMigrationSchemaQuiescence(pinnedClient);
    const { applied, compatibility } = await client.transaction(async (tx) => {
      await client.configureMigrationTransaction(tx, migrationSchema, false);
      const appliedRows = await reconcileLegacyCompoundV124Ledger(
        client,
        tx,
        migrationSchema,
        migrations,
        await client.getAppliedMigrationRows(tx, migrationSchema),
      );
      const normalizedCompatibility = normalizePostgresMigrationLedgerForHistoricalRepair({
        definitions: migrations,
        appliedRows,
      });
      const result = {
        compatibility: normalizedCompatibility,
        applied: assertValidAppliedMigrationLedger(migrations, normalizedCompatibility.appliedRows, "Postgres"),
      };
      await client.assertMigrationSchemaIdentity(tx, migrationSchema);
      if (result.applied.size === migrations.length) {
        await assertCanonicalPostgresSchemaShape(tx, migrationSchema, migrations);
      }
      return result;
    }, pinnedClient);
    const newlyApplied: number[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      if (migration.batchedStatements) {
        await runBatchedMigration(client, pinnedClient, migrationSchema, migration, migration.batchedStatements);
        await client.transaction(async (tx) => {
          await client.configureMigrationTransaction(tx, migrationSchema, false);
          if (applied.size + newlyApplied.length + 1 === migrations.length) {
            await assertCanonicalPostgresSchemaShape(tx, migrationSchema, migrations);
          }
          await markApplied(tx, client, migrationSchema, migration.version, migration.name);
          if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
            await assertStrictPostgresLedger(client, tx, migrationSchema, migrations);
          }
          await client.assertMigrationSchemaIdentity(tx, migrationSchema);
        }, pinnedClient);
        newlyApplied.push(migration.version);
        continue;
      }
      await client.transaction(async (tx) => {
        const bridgeRequired = requiresPostgresHistoryRepairLedgerBridge(client.getMigrationsTableName(), migration);
        await client.configureMigrationTransaction(tx, migrationSchema, bridgeRequired);
        const bridgeActive = await executePostgresAtomicMigration(
          tx,
          migrationSchema,
          client.getMigrationsTableName(),
          migration,
        );
        if (applied.size + newlyApplied.length + 1 === migrations.length) {
          await assertCanonicalPostgresSchemaShape(tx, migrationSchema, migrations);
        }
        await markApplied(tx, client, migrationSchema, migration.version, migration.name);
        if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
          await assertStrictPostgresLedger(client, tx, migrationSchema, migrations);
        }
        if (bridgeActive) {
          await tx.query(POSTGRES_HISTORY_REPAIR_TEMP_VIEW_DROP_SQL);
        }
        await client.assertMigrationSchemaIdentity(tx, migrationSchema);
      }, pinnedClient);
      newlyApplied.push(migration.version);
    }

    return {
      appliedVersions: newlyApplied,
      latestVersion: migrations[migrations.length - 1]?.version ?? 0,
    };
  });
}

async function assertCanonicalPostgresSchemaShape(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migrations: readonly PostgresMigration[],
): Promise<void> {
  const manifest = buildCanonicalPostgresSchemaShapeManifest(migrations);
  if (manifest.tables.length === 0) return;
  const relationLockSql = buildPostgresSchemaShapeRelationLockSql(migrationSchema, manifest);
  if (relationLockSql) await tx.query(relationLockSql);
  const validation = await tx.query<PostgresSchemaShapeIssueRow>(
    buildPostgresSchemaShapeValidationSql("$1", "$2", "$3"),
    [JSON.stringify(manifest.tables), JSON.stringify(manifest.indexes), migrationSchema.oid],
  );
  assertPostgresSchemaShapeIssues(validation.rows);
}

function isCanonicalMigration(migration: PostgresMigration, version: number, name: string): boolean {
  const canonical = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === version && candidate.name === name);
  return (
    canonical !== undefined &&
    migration.version === canonical.version &&
    migration.name === canonical.name &&
    migration.sql === canonical.sql &&
    migration.integritySha256 === canonical.integritySha256
  );
}

function isCanonicalGovernedRemediationFoundationMigration(migration: PostgresMigration): boolean {
  return isCanonicalMigration(migration, GOVERNED_REMEDIATION_FOUNDATION_VERSION, GOVERNED_REMEDIATION_FOUNDATION_NAME);
}

function isCanonicalRemoteWorkerMeshAuthorityMigration(migration: PostgresMigration): boolean {
  return isCanonicalMigration(migration, REMOTE_WORKER_MESH_AUTHORITY_VERSION, REMOTE_WORKER_MESH_AUTHORITY_NAME);
}

function isCanonicalMobilePushAuthorityMigration(migration: PostgresMigration): boolean {
  return isCanonicalMigration(migration, MOBILE_PUSH_AUTHORITY_VERSION, MOBILE_PUSH_AUTHORITY_NAME);
}

function isCanonicalDurableHeartbeatAuthorityMigration(migration: PostgresMigration): boolean {
  return isCanonicalMigration(migration, DURABLE_HEARTBEAT_AUTHORITY_VERSION, DURABLE_HEARTBEAT_AUTHORITY_NAME);
}

function isCanonicalSecureConfigurationRepairMigration(migration: PostgresMigration): boolean {
  return isCanonicalMigration(migration, SECURE_CONFIGURATION_REPAIR_VERSION, SECURE_CONFIGURATION_REPAIR_NAME);
}

function isCanonicalSchemaAuthorityMigration(migration: PostgresMigration): boolean {
  return isCanonicalMigration(migration, CANONICAL_SCHEMA_AUTHORITY_VERSION, CANONICAL_SCHEMA_AUTHORITY_NAME);
}

const POSTGRES_SCHEMA_SHAPE_SIMULATION_IDENTITY: PostgresMigrationSchemaIdentity = {
  name: "goatcitadel_schema_shape_simulation",
  oid: "0",
};

export function buildCanonicalPostgresSchemaShapeManifest(
  migrations: readonly PostgresMigration[],
): PostgresSchemaShapeManifest {
  const simulatedMigrations: PostgresMigration[] = [];
  for (const migration of migrations) {
    if (isCanonicalGovernedRemediationFoundationMigration(migration)) {
      simulatedMigrations.push({
        version: migration.version,
        name: "governed_remediation_bootstrap_replacement_shape",
        sql: buildGovernedRemediationBootstrapDropSql(POSTGRES_SCHEMA_SHAPE_SIMULATION_IDENTITY),
      });
    }
    if (isCanonicalRemoteWorkerMeshAuthorityMigration(migration)) {
      simulatedMigrations.push({
        version: migration.version,
        name: "remote_worker_mesh_bootstrap_replacement_shape",
        sql: buildRemoteWorkerMeshBootstrapResetSql(POSTGRES_SCHEMA_SHAPE_SIMULATION_IDENTITY),
      });
    }
    if (isCanonicalMobilePushAuthorityMigration(migration)) {
      simulatedMigrations.push({
        version: migration.version,
        name: "mobile_push_bootstrap_replacement_shape",
        sql: buildMobilePushBootstrapDropSql(POSTGRES_SCHEMA_SHAPE_SIMULATION_IDENTITY),
      });
    }
    simulatedMigrations.push(migration);
  }

  let manifest = buildPostgresSchemaShapeManifest(simulatedMigrations);
  manifest = applyCanonicalSchemaAuthorityCheckPostconditions(
    manifest,
    migrations.some(isCanonicalSchemaAuthorityMigration),
  );
  if (migrations.some(isCanonicalDurableHeartbeatAuthorityMigration)) {
    manifest = applyDurableHeartbeatCatalogPostconditions(manifest);
  }
  if (migrations.some(isCanonicalSecureConfigurationRepairMigration)) {
    manifest = applySecureConfigurationCatalogPostconditions(manifest, null);
  }
  if (migrations.some(isCanonicalSchemaAuthorityMigration)) {
    manifest = applySecureConfigurationCatalogPostconditions(
      manifest,
      "chat_turn_secure_configuration_reservations_reconciled_by_fkey",
    );
  }
  return manifest;
}

function applyCanonicalSchemaAuthorityCheckPostconditions(
  manifest: PostgresSchemaShapeManifest,
  canonicalAuthorityApplied: boolean,
): PostgresSchemaShapeManifest {
  const expectedByTable = new Map<string, string[]>();
  for (const expected of CANONICAL_SCHEMA_AUTHORITY_CHECKS) {
    const names = expectedByTable.get(expected.tableName) ?? [];
    names.push(expected.name);
    expectedByTable.set(expected.tableName, names);
  }
  const reservedNames = new Set<string>(CANONICAL_SCHEMA_AUTHORITY_CHECKS.map((expected) => expected.name));
  return {
    ...manifest,
    tables: manifest.tables.map((table) => {
      const constraints = table.constraints.filter(
        (constraint) => constraint.type !== "c" || constraint.name === null || !reservedNames.has(constraint.name),
      );
      if (!canonicalAuthorityApplied) return { ...table, constraints };
      return {
        ...table,
        constraints: [
          ...constraints,
          ...(expectedByTable.get(table.name) ?? []).map((name) => ({
            name,
            type: "c" as const,
            columns: [],
            referencedTable: null,
            referencedColumns: [],
            onDelete: null,
            onUpdate: null,
          })),
        ],
      };
    }),
  };
}

function applyDurableHeartbeatCatalogPostconditions(
  manifest: PostgresSchemaShapeManifest,
): PostgresSchemaShapeManifest {
  return {
    ...manifest,
    tables: manifest.tables.map((table) => {
      if (table.name === "chat_heartbeat_occurrences") {
        return {
          ...table,
          constraints: [
            ...table.constraints.filter((constraint) => constraint.type !== "f"),
            buildCanonicalForeignKey(
              "fk_chat_heartbeat_occurrence_admission",
              "admission_id",
              "chat_session_mutation_admissions",
              "admission_id",
            ),
            buildCanonicalForeignKey(
              "fk_chat_heartbeat_occurrence_durable_run",
              "durable_run_id",
              "durable_runs",
              "run_id",
            ),
            buildCanonicalForeignKey(
              "fk_chat_heartbeat_occurrence_capability_profile",
              "capability_profile_id",
              "chat_turn_capability_profiles",
              "profile_id",
            ),
          ],
        };
      }
      if (table.name === "chat_turn_capability_profile_incarnation_bindings") {
        return {
          ...table,
          constraints: [
            ...table.constraints.filter(
              (constraint) =>
                constraint.type !== "f" ||
                constraint.columns.length !== 1 ||
                constraint.columns[0] !== "profile_id" ||
                constraint.referencedTable !== "chat_turn_capability_profiles",
            ),
            buildCanonicalForeignKey(
              "fk_chat_turn_cap_profile_binding_profile",
              "profile_id",
              "chat_turn_capability_profiles",
              "profile_id",
            ),
          ],
        };
      }
      return table;
    }),
  };
}

function applySecureConfigurationCatalogPostconditions(
  manifest: PostgresSchemaShapeManifest,
  constraintName: string | null,
): PostgresSchemaShapeManifest {
  return {
    ...manifest,
    tables: manifest.tables.map((table) => {
      if (table.name !== "chat_turn_secure_configuration_reservations") return table;
      return {
        ...table,
        constraints: [
          ...table.constraints.filter(
            (constraint) =>
              constraint.type !== "f" ||
              constraint.columns.length !== 1 ||
              constraint.columns[0] !== "reconciled_by_reservation_id" ||
              constraint.referencedTable !== "chat_turn_secure_configuration_reservations",
          ),
          buildCanonicalForeignKey(
            constraintName,
            "reconciled_by_reservation_id",
            "chat_turn_secure_configuration_reservations",
            "reservation_id",
            "r",
          ),
        ],
      };
    }),
  };
}

function buildCanonicalForeignKey(
  name: string | null,
  column: string,
  referencedTable: string,
  referencedColumn: string,
  onDelete: "a" | "r" = "a",
): PostgresSchemaShapeManifest["tables"][number]["constraints"][number] {
  return {
    name,
    type: "f",
    columns: [column],
    referencedTable,
    referencedColumns: [referencedColumn],
    onDelete,
    onUpdate: "a",
  };
}

function buildGovernedRemediationBootstrapManifest(): PostgresSchemaShapeManifest {
  const authority = POSTGRES_MIGRATIONS.find(
    (migration) =>
      migration.version === GOVERNED_REMEDIATION_AUTHORITY_VERSION &&
      migration.name === GOVERNED_REMEDIATION_AUTHORITY_NAME,
  );
  if (!authority) {
    throw new Error("Postgres governed-remediation bootstrap compatibility is missing canonical migration 135.");
  }
  const complete = buildPostgresSchemaShapeManifest([authority]);
  const tableNames = new Set<string>(GOVERNED_REMEDIATION_BOOTSTRAP_TABLES);
  const manifest: PostgresSchemaShapeManifest = {
    tables: complete.tables.filter((table) => tableNames.has(table.name)),
    indexes: complete.indexes.filter((index) => tableNames.has(index.tableName)),
  };
  const actualNames = manifest.tables.map((table) => table.name).sort();
  const expectedNames = [...GOVERNED_REMEDIATION_BOOTSTRAP_TABLES].sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error("Postgres governed-remediation bootstrap compatibility manifest is incomplete.");
  }
  return manifest;
}

function buildRemoteWorkerMeshBootstrapManifest(): PostgresSchemaShapeManifest {
  const tableNames = new Set<string>(REMOTE_WORKER_MESH_BOOTSTRAP_TABLES);
  const bootstrap = POSTGRES_MIGRATIONS.find(
    (migration) => migration.version === 2 && migration.name === "canonical_runtime_schema",
  );
  if (!bootstrap) {
    throw new Error("Postgres remote-worker mesh bootstrap compatibility is missing canonical migration 2.");
  }
  const complete = buildPostgresSchemaShapeManifest([bootstrap]);
  const manifest: PostgresSchemaShapeManifest = {
    tables: complete.tables.filter((table) => tableNames.has(table.name)),
    indexes: complete.indexes.filter((index) => tableNames.has(index.tableName)),
  };
  const actualNames = manifest.tables.map((table) => table.name).sort();
  const expectedNames = [...REMOTE_WORKER_MESH_BOOTSTRAP_TABLES].sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error("Postgres remote-worker mesh bootstrap compatibility manifest is incomplete.");
  }
  return manifest;
}

function buildMobilePushBootstrapManifest(): PostgresSchemaShapeManifest {
  const bootstrap = POSTGRES_MIGRATIONS.find(
    (migration) => migration.version === 2 && migration.name === "canonical_runtime_schema",
  );
  if (!bootstrap) {
    throw new Error("Postgres mobile-push bootstrap compatibility is missing canonical migration 2.");
  }
  const tableNames = new Set<string>(MOBILE_PUSH_BOOTSTRAP_TABLES);
  const complete = buildPostgresSchemaShapeManifest([bootstrap]);
  const manifest: PostgresSchemaShapeManifest = {
    tables: complete.tables.filter((table) => tableNames.has(table.name)),
    indexes: complete.indexes.filter((index) => tableNames.has(index.tableName)),
  };
  const actualNames = manifest.tables.map((table) => table.name).sort();
  const expectedNames = [...MOBILE_PUSH_BOOTSTRAP_TABLES].sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error("Postgres mobile-push bootstrap compatibility manifest is incomplete.");
  }
  return manifest;
}

function selectPostgresSchemaShapeTables(
  manifest: PostgresSchemaShapeManifest,
  tableNames: readonly string[],
): PostgresSchemaShapeManifest {
  const selected = new Set(tableNames);
  return {
    tables: manifest.tables.filter((table) => selected.has(table.name)),
    indexes: manifest.indexes.filter((index) => selected.has(index.tableName)),
  };
}

function buildBootstrapRowsSql(
  migrationSchema: PostgresMigrationSchemaIdentity,
  tables: readonly string[],
  marker: string,
): string {
  const schema = quotePostgresIdentifier(migrationSchema.name);
  const rowSources = tables
    .map((table) => `SELECT 1 FROM ${schema}.${quotePostgresIdentifier(table)}`)
    .join(" UNION ALL ");
  return `/* ${marker} */ SELECT EXISTS (${rowSources}) AS has_rows`;
}

function buildGovernedRemediationBootstrapRowsSql(migrationSchema: PostgresMigrationSchemaIdentity): string {
  return buildBootstrapRowsSql(
    migrationSchema,
    GOVERNED_REMEDIATION_BOOTSTRAP_TABLES,
    "goatcitadel_governed_remediation_bootstrap_rows",
  );
}

function buildGovernedRemediationBootstrapDropSql(migrationSchema: PostgresMigrationSchemaIdentity): string {
  const schema = quotePostgresIdentifier(migrationSchema.name);
  return GOVERNED_REMEDIATION_BOOTSTRAP_DROP_ORDER.map(
    (table) => `DROP TABLE ${schema}.${quotePostgresIdentifier(table)}`,
  ).join(";\n");
}

function buildRemoteWorkerMeshBootstrapRowsSql(migrationSchema: PostgresMigrationSchemaIdentity): string {
  return buildBootstrapRowsSql(
    migrationSchema,
    REMOTE_WORKER_MESH_BOOTSTRAP_TABLES,
    "goatcitadel_remote_worker_mesh_bootstrap_rows",
  );
}

function buildRemoteWorkerMeshBootstrapResetSql(migrationSchema: PostgresMigrationSchemaIdentity): string {
  const schema = quotePostgresIdentifier(migrationSchema.name);
  const drops = REMOTE_WORKER_MESH_BOOTSTRAP_DROP_ORDER.map(
    (table) => `DROP TABLE ${schema}.${quotePostgresIdentifier(table)}`,
  );
  drops.push(
    `ALTER TABLE ${schema}.${quotePostgresIdentifier("mesh_capability_node_admissions")} DROP COLUMN ${quotePostgresIdentifier("provenance_kind")}`,
  );
  return drops.join(";\n");
}

function buildMobilePushBootstrapRowsSql(migrationSchema: PostgresMigrationSchemaIdentity): string {
  return buildBootstrapRowsSql(migrationSchema, MOBILE_PUSH_BOOTSTRAP_TABLES, "goatcitadel_mobile_push_bootstrap_rows");
}

async function assertPostgresBootstrapReplacementShape(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  manifest: PostgresSchemaShapeManifest,
  replacedRelations: PostgresSchemaShapeManifest = manifest,
): Promise<void> {
  const parameters = [JSON.stringify(manifest.tables), JSON.stringify(manifest.indexes), migrationSchema.oid];
  const shape = await tx.query<PostgresSchemaShapeIssueRow>(
    buildPostgresSchemaShapeValidationSql("$1", "$2", "$3"),
    parameters,
  );
  assertPostgresSchemaShapeIssues(shape.rows);
  const ownedObjects = await tx.query<PostgresSchemaShapeIssueRow>(
    buildPostgresSchemaShapeReplacementValidationSql("$1", "$2", "$3"),
    [JSON.stringify(replacedRelations.tables), JSON.stringify(replacedRelations.indexes), migrationSchema.oid],
  );
  assertPostgresSchemaShapeIssues(ownedObjects.rows);
}

async function assertRemoteWorkerMeshProvenanceResetOwnsEveryDependency(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
): Promise<void> {
  const dependencies = await tx.query<{ unexpected_owned_dependency_exists: boolean }>(
    POSTGRES_REMOTE_WORKER_MESH_PROVENANCE_DEPENDENCY_PREFLIGHT_SQL.replaceAll("@schemaOid", "$1"),
    [migrationSchema.oid],
  );
  if (dependencies.rows[0]?.unexpected_owned_dependency_exists !== false) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap provenance column has unexpected posture or a local dependency; refusing automatic replacement.",
    );
  }
}

function buildMobilePushBootstrapDropSql(migrationSchema: PostgresMigrationSchemaIdentity): string {
  const schema = quotePostgresIdentifier(migrationSchema.name);
  return MOBILE_PUSH_BOOTSTRAP_DROP_ORDER.map((table) => `DROP TABLE ${schema}.${quotePostgresIdentifier(table)}`).join(
    ";\n",
  );
}

async function prepareGovernedRemediationBootstrapForFoundation(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migration: PostgresMigration,
): Promise<void> {
  if (!isCanonicalGovernedRemediationFoundationMigration(migration)) return;

  const preflight = await tx.query<{
    state_table_exists: boolean;
    legacy_approval_column_exists: boolean;
  }>(POSTGRES_GOVERNED_REMEDIATION_BOOTSTRAP_PREFLIGHT_SQL.replaceAll("@schemaOid", "$1"), [migrationSchema.oid]);
  const state = preflight.rows[0];
  if (!state?.state_table_exists || state.legacy_approval_column_exists) return;

  // The generated v2 fresh schema is intentionally current. It can therefore
  // contain the final empty v135 governed-remediation slice before the frozen
  // v134/v135 forward ledger is replayed. Prove that exact empty shape, remove
  // only those empty relations transactionally, then let both frozen migrations
  // install their own constraints, triggers, and ledger evidence normally.
  const manifest = buildGovernedRemediationBootstrapManifest();
  const replacementLockSql = buildPostgresSchemaShapeReplacementLockSql(migrationSchema, manifest);
  if (replacementLockSql) await tx.query(replacementLockSql);
  const lockedPreflight = await tx.query<{
    state_table_exists: boolean;
    legacy_approval_column_exists: boolean;
  }>(POSTGRES_GOVERNED_REMEDIATION_BOOTSTRAP_PREFLIGHT_SQL.replaceAll("@schemaOid", "$1"), [migrationSchema.oid]);
  const lockedState = lockedPreflight.rows[0];
  if (!lockedState?.state_table_exists || lockedState.legacy_approval_column_exists) {
    throw new Error(
      "Postgres governed-remediation bootstrap classification changed while acquiring its replacement lock; refusing automatic replacement.",
    );
  }
  try {
    await assertPostgresBootstrapReplacementShape(tx, migrationSchema, manifest);
  } catch (error) {
    throw new Error(
      "Postgres governed-remediation bootstrap relations are neither the legacy v134 shape nor the exact current empty v135 shape; refusing automatic replacement.",
      { cause: error },
    );
  }
  const rows = await tx.query<{ has_rows: boolean }>(buildGovernedRemediationBootstrapRowsSql(migrationSchema));
  if (rows.rows[0]?.has_rows !== false) {
    throw new Error(
      "Postgres governed-remediation bootstrap relations contain rows; refusing to replace authority-bearing state.",
    );
  }
  await tx.query(buildGovernedRemediationBootstrapDropSql(migrationSchema));
}

async function prepareRemoteWorkerMeshBootstrapForAuthority(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migration: PostgresMigration,
): Promise<void> {
  if (!isCanonicalRemoteWorkerMeshAuthorityMigration(migration)) return;

  const preflight = await tx.query<{
    admission_table_exists: boolean;
    final_provenance_column_exists: boolean;
  }>(POSTGRES_REMOTE_WORKER_MESH_BOOTSTRAP_PREFLIGHT_SQL.replaceAll("@schemaOid", "$1"), [migrationSchema.oid]);
  const state = preflight.rows[0];
  if (!state?.admission_table_exists || !state.final_provenance_column_exists) return;

  // As with governed remediation, the generated v2 schema can pre-create the
  // current empty v137 shape. Validate every affected relation and index, prove
  // there is no authority-bearing row, unwind only v137's additions, and then
  // execute the frozen migration so its constraints and triggers remain the
  // canonical owner.
  const manifest = buildRemoteWorkerMeshBootstrapManifest();
  const replacedRelations = selectPostgresSchemaShapeTables(manifest, REMOTE_WORKER_MESH_BOOTSTRAP_DROP_ORDER);
  const replacementLockSql = buildPostgresSchemaShapeReplacementLockSql(migrationSchema, manifest);
  if (replacementLockSql) await tx.query(replacementLockSql);
  const lockedPreflight = await tx.query<{
    admission_table_exists: boolean;
    final_provenance_column_exists: boolean;
  }>(POSTGRES_REMOTE_WORKER_MESH_BOOTSTRAP_PREFLIGHT_SQL.replaceAll("@schemaOid", "$1"), [migrationSchema.oid]);
  const lockedState = lockedPreflight.rows[0];
  if (!lockedState?.admission_table_exists || !lockedState.final_provenance_column_exists) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap classification changed while acquiring its replacement lock; refusing automatic replacement.",
    );
  }
  try {
    await assertPostgresBootstrapReplacementShape(tx, migrationSchema, manifest, replacedRelations);
    await assertRemoteWorkerMeshProvenanceResetOwnsEveryDependency(tx, migrationSchema);
  } catch (error) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap relations are not the exact current empty v137 shape; refusing automatic replacement.",
      { cause: error },
    );
  }
  const rows = await tx.query<{ has_rows: boolean }>(buildRemoteWorkerMeshBootstrapRowsSql(migrationSchema));
  if (rows.rows[0]?.has_rows !== false) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap relations contain rows; refusing to replace authority state.",
    );
  }
  await tx.query(buildRemoteWorkerMeshBootstrapResetSql(migrationSchema));
}

async function prepareMobilePushBootstrapForAuthority(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migration: PostgresMigration,
): Promise<void> {
  if (!isCanonicalMobilePushAuthorityMigration(migration)) return;

  const preflight = await tx.query<{ registration_table_exists: boolean }>(
    POSTGRES_MOBILE_PUSH_BOOTSTRAP_PREFLIGHT_SQL.replaceAll("@schemaOid", "$1"),
    [migrationSchema.oid],
  );
  if (!preflight.rows[0]?.registration_table_exists) return;

  const manifest = buildMobilePushBootstrapManifest();
  const replacementLockSql = buildPostgresSchemaShapeReplacementLockSql(migrationSchema, manifest);
  if (replacementLockSql) await tx.query(replacementLockSql);
  const lockedPreflight = await tx.query<{ registration_table_exists: boolean }>(
    POSTGRES_MOBILE_PUSH_BOOTSTRAP_PREFLIGHT_SQL.replaceAll("@schemaOid", "$1"),
    [migrationSchema.oid],
  );
  if (!lockedPreflight.rows[0]?.registration_table_exists) {
    throw new Error(
      "Postgres mobile-push bootstrap classification changed while acquiring its replacement lock; refusing automatic replacement.",
    );
  }
  try {
    await assertPostgresBootstrapReplacementShape(tx, migrationSchema, manifest);
    const defaults = await tx.query<{ defaults_exact: boolean }>(
      POSTGRES_MOBILE_PUSH_BOOTSTRAP_DEFAULTS_SQL.replaceAll("@schemaOid", "$1"),
      [migrationSchema.oid],
    );
    if (defaults.rows[0]?.defaults_exact !== true) {
      throw new Error("Postgres mobile-push bootstrap defaults are not canonical.");
    }
  } catch (error) {
    throw new Error(
      "Postgres mobile-push bootstrap relations are not the exact current empty v138 shape; refusing automatic replacement.",
      { cause: error },
    );
  }
  const rows = await tx.query<{ has_rows: boolean }>(buildMobilePushBootstrapRowsSql(migrationSchema));
  if (rows.rows[0]?.has_rows !== false) {
    throw new Error("Postgres mobile-push bootstrap relations contain rows; refusing to replace authority state.");
  }
  await tx.query(buildMobilePushBootstrapDropSql(migrationSchema));
}

async function reconcileLegacyCompoundV124Ledger(
  client: PostgresDatabaseClient,
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migrations: readonly PostgresMigration[],
  appliedRows: readonly { version: number; name: string }[],
): Promise<Array<{ version: number; name: string }>> {
  const initialClassification = classifyLegacyCompoundV124Ledger({ definitions: migrations, appliedRows });
  if (initialClassification === "none") {
    return [...appliedRows];
  }
  if (initialClassification === "invalid-candidate") {
    throw new Error(
      "Postgres legacy compound-engineering v124 ledger claim is not the exact repairable deployed state; refusing automatic reconciliation.",
    );
  }

  const qualifiedMigrationsTable = buildPostgresQualifiedMigrationLedger(
    migrationSchema,
    client.getMigrationsTableName(),
  );
  await tx.query(buildPostgresLegacyCompoundLedgerRepairLockSql(qualifiedMigrationsTable));
  const lockedRows = await client.getAppliedMigrationRows(tx, migrationSchema);
  const lockedClassification = classifyLegacyCompoundV124Ledger({ definitions: migrations, appliedRows: lockedRows });
  if (lockedClassification === "none") {
    return lockedRows;
  }
  if (lockedClassification !== "exact-candidate") {
    throw new Error(
      "Postgres legacy compound-engineering v124 ledger changed while the repair lock was acquired; refusing automatic reconciliation.",
    );
  }

  const catalogBeforeLock = await tx.query<{ matches_expected: boolean }>(POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL);
  assertLegacyCompoundV124Catalog(catalogBeforeLock.rows[0]);
  await tx.query(POSTGRES_LEGACY_COMPOUND_V124_RELATION_LOCK_SQL);
  const catalogAfterLock = await tx.query<{ matches_expected: boolean }>(POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL);
  assertLegacyCompoundV124Catalog(catalogAfterLock.rows[0]);
  const repair = await tx.query(buildPostgresLegacyCompoundLedgerRepairSql(qualifiedMigrationsTable, "$1"), [
    "compound_engineering_foundation",
  ]);
  assertLegacyCompoundV124LedgerRepairResult(repair.rows);
  await client.assertMigrationSchemaIdentity(tx, migrationSchema);
  return client.getAppliedMigrationRows(tx, migrationSchema);
}

async function executePostgresAtomicMigration(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migrationsTable: string,
  migration: PostgresMigration,
): Promise<boolean> {
  if (!requiresPostgresHistoryRepairLedgerBridge(migrationsTable, migration)) {
    await prepareGovernedRemediationBootstrapForFoundation(tx, migrationSchema, migration);
    await prepareRemoteWorkerMeshBootstrapForAuthority(tx, migrationSchema, migration);
    await prepareMobilePushBootstrapForAuthority(tx, migrationSchema, migration);
    await tx.query(migration.sql);
    return false;
  }

  const preflight = await tx.query<{ relation: string | null }>(POSTGRES_HISTORY_REPAIR_TEMP_RELATION_PREFLIGHT_SQL);
  assertPostgresHistoryRepairTempRelationAvailable(preflight.rows[0]);
  await tx.query(buildPostgresHistoryRepairTempViewSql(migrationsTable, migrationSchema));
  const resolution = await tx.query<{ bridge_active: boolean | null }>(
    POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL,
  );
  assertPostgresHistoryRepairTempViewOwnsResolution(resolution.rows[0]);
  await tx.query(migration.sql);
  return true;
}

async function assertStrictPostgresLedger(
  client: PostgresDatabaseClient,
  pinnedClient: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migrations: readonly PostgresMigration[],
): Promise<void> {
  const appliedRows = await client.getAppliedMigrationRows(pinnedClient, migrationSchema);
  assertValidAppliedMigrationLedger(migrations, appliedRows, "Postgres");
}

function assertValidPostgresMigrationRegistry(migrations: readonly PostgresMigration[]): void {
  assertValidMigrationDefinitions(migrations, "Postgres");
  for (const migration of migrations) {
    assertMigrationDefinitionIsExecutable(migration);
    assertPostgresMigrationIntegrity(migration);
  }
  assertPostgresHistoryRepairRegistryIntegrity(migrations);
}

async function runBatchedMigration(
  client: PostgresDatabaseClient,
  pinnedClient: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migration: PostgresMigration,
  statements: readonly PostgresMigrationBatchStatement[],
): Promise<void> {
  let changedRows: number;
  do {
    changedRows = 0;
    for (const statement of statements) {
      changedRows += await client.transaction(async (tx) => {
        await client.configureMigrationTransaction(tx, migrationSchema, false);
        const result = await tx.query(statement.sql);
        const affectedRows = assertAffectedRowCount(migration, statement, result.rowCount);
        await client.assertMigrationSchemaIdentity(tx, migrationSchema);
        return affectedRows;
      }, pinnedClient);
    }
  } while (changedRows > 0);
}

function assertMigrationDefinitionIsExecutable(migration: PostgresMigration): void {
  const hasAtomicSql = migration.sql.trim().length > 0;
  const statements = migration.batchedStatements;
  if (!statements) {
    if (!hasAtomicSql) {
      throw new Error(
        `Postgres migration ${migration.version} (${migration.name}) must define atomic SQL or batched statements.`,
      );
    }
    return;
  }
  if (hasAtomicSql) {
    throw new Error(
      `Postgres migration ${migration.version} (${migration.name}) cannot define both atomic SQL and batched statements.`,
    );
  }
  if (statements.length === 0) {
    throw new Error(
      `Postgres migration ${migration.version} (${migration.name}) must define at least one batched statement.`,
    );
  }
  const names = new Set<string>();
  for (const statement of statements) {
    const name = statement.name.trim();
    if (!name || !statement.sql.trim()) {
      throw new Error(
        `Postgres migration ${migration.version} (${migration.name}) contains an unnamed or empty batched statement.`,
      );
    }
    if (names.has(name)) {
      throw new Error(
        `Postgres migration ${migration.version} (${migration.name}) contains duplicate batched statement name "${name}".`,
      );
    }
    names.add(name);
  }
}

export function assertPostgresMigrationIntegrity(migration: PostgresMigration): void {
  if (!migration.integritySha256) {
    return;
  }
  const content = migration.batchedStatements
    ? `batched\n${migration.batchedStatements
        .map((statement) => `${statement.name}\n${normalizeMigrationSql(statement.sql)}`)
        .join("\n-- goatcitadel migration batch --\n")}`
    : `atomic\n${normalizeMigrationSql(migration.sql)}`;
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== migration.integritySha256) {
    throw new Error(
      `Postgres migration ${migration.version} (${migration.name}) integrity hash mismatch: expected ${migration.integritySha256}, found ${actual}.`,
    );
  }
}

function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n").trim();
}

function assertAffectedRowCount(
  migration: PostgresMigration,
  statement: PostgresMigrationBatchStatement,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Postgres batched migration ${migration.version} (${migration.name}) statement "${statement.name}" did not report a valid affected-row count.`,
    );
  }
  return value;
}

async function markApplied(
  tx: PoolClient,
  client: PostgresDatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  version: number,
  name: string,
): Promise<void> {
  await client.markMigrationApplied(version, name, tx, migrationSchema);
}

export function applyPostgresMigrationsSync(
  db: DatabaseClient,
  input?: {
    migrationsTable?: string;
    migrations?: readonly PostgresMigration[];
  },
): void {
  const migrationsTable = input?.migrationsTable ?? "schema_migrations";
  const migrations = input?.migrations ?? POSTGRES_MIGRATIONS;
  quotePostgresIdentifier(migrationsTable);
  assertValidPostgresMigrationRegistry(migrations);
  if (db.dialect === "postgres") {
    const pinnedDb = requirePinnedSessionDatabase(db);
    pinnedDb.withPinnedSession((controls) => {
      applyPostgresMigrationsSyncWithLock(db, migrationsTable, migrations, controls);
    });
    return;
  }
  applyPostgresMigrationsSyncLocked(db, migrationsTable, migrations);
}

function applyPostgresMigrationsSyncWithLock(
  db: DatabaseClient,
  migrationsTable: string,
  migrations: readonly PostgresMigration[],
  controls: PostgresPinnedSessionControls,
): void {
  let lockKey: string;
  try {
    const transactionProbe = db
      .prepare(POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL)
      .get<{ transaction_probe_acquired: boolean }>();
    assertPostgresMigrationTransactionProbeAcquired(transactionProbe);
    const transactionState = db
      .prepare(POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL)
      .get<{ transaction_open: boolean; existing_advisory_lock: boolean }>();
    assertPostgresMigrationSessionIsIdle(transactionState);
    lockKey = acquirePostgresMigrationLockSync(db, migrationsTable);
  } catch (error) {
    controls.destroyOnRelease();
    throw error;
  }

  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    const migrationSchema = assertSyncMigrationsTableNotShadowed(db, migrationsTable);
    waitForPostgresMigrationSchemaQuiescenceSync(db);
    applyPostgresMigrationsSyncLocked(db, migrationsTable, migrations, migrationSchema);
  } catch (error) {
    controls.destroyOnRelease();
    primaryError = error;
    hasPrimaryError = true;
  }

  try {
    const unlockRow = db.prepare(buildPostgresMigrationUnlockSql("@lockKey")).get({ lockKey });
    assertPostgresMigrationLockReleased(unlockRow);
  } catch (error) {
    controls.destroyOnRelease();
    if (!hasPrimaryError) {
      primaryError = error;
      hasPrimaryError = true;
    }
  }

  if (hasPrimaryError) {
    throw primaryError;
  }
}

function assertSyncMigrationsTableNotShadowed(
  db: DatabaseClient,
  migrationsTable: string,
): PostgresMigrationSchemaIdentity {
  const row = db
    .prepare(buildPostgresMigrationLedgerTempShadowPreflightSql("@migrationsTable"))
    .get({ migrationsTable });
  assertPostgresMigrationLedgerNotShadowed(row, migrationsTable);
  const tempObjects = db.prepare(POSTGRES_MIGRATION_TEMP_OBJECT_PREFLIGHT_SQL).get<{
    existing_temp_relation: string | null;
    existing_temp_type: string | null;
  }>();
  assertPostgresMigrationSessionHasNoTempObjects(tempObjects);
  const currentSchema = db.prepare(POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL).get<{
    current_schema_is_temp: boolean;
    current_schema_name: string;
    current_schema_oid: string;
    current_schema_owned_by_current_user: boolean;
    current_schema_has_exclusive_create_authority: boolean;
    existing_unowned_relation: string | null;
  }>();
  return assertPostgresMigrationCurrentSchemaIsDurable(currentSchema);
}

function acquirePostgresMigrationLockSync(db: DatabaseClient, migrationsTable: string): string {
  const tryLock = db.prepare(buildPostgresMigrationTryLockSql("@migrationsTable"));
  for (;;) {
    const attempt = parsePostgresMigrationTryLockResult(tryLock.get({ migrationsTable }));
    if (attempt.locked) {
      return attempt.lockKey;
    }
    Atomics.wait(POSTGRES_MIGRATION_LOCK_RETRY_STATE, 0, 0, POSTGRES_MIGRATION_LOCK_RETRY_MS);
  }
}

function waitForPostgresMigrationSchemaQuiescenceSync(db: DatabaseClient): void {
  const barrier = parsePostgresMigrationActiveTransactionIds(
    db.prepare(POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL).all<{ active_xid: string }>(),
  );
  if (barrier.length !== 1) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction-epoch barrier did not return exactly one transaction id.",
    );
  }
  const snapshot = parsePostgresMigrationActiveTransactionIds(
    db.prepare(POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL).all<{ active_xid: string }>(),
  );
  const pending = new Set(selectPostgresMigrationPreexistingTransactionIds(barrier[0]!, snapshot));
  const deadline = Date.now() + POSTGRES_MIGRATION_QUIESCENCE_TIMEOUT_MS;
  while (pending.size > 0) {
    for (const transactionId of [...pending]) {
      const result = db.prepare(buildPostgresMigrationTransactionDatabaseClassificationSql("@transactionId")).get<{
        transaction_status: string;
        observed_database_count: string;
        current_database_observed: boolean;
      }>({ transactionId });
      const classification = classifyPostgresMigrationTransactionDatabase(result);
      if (classification === "complete" || classification === "other") {
        pending.delete(transactionId);
      }
    }
    if (pending.size === 0) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new PostgresMigrationSessionContaminationError(
        `Postgres migration schema did not become quiescent before timeout; active transactions: ${[...pending].join(
          ", ",
        )}.`,
      );
    }
    Atomics.wait(POSTGRES_MIGRATION_LOCK_RETRY_STATE, 0, 0, POSTGRES_MIGRATION_QUIESCENCE_RETRY_MS);
  }
}

function applyPostgresMigrationsSyncLocked(
  db: DatabaseClient,
  migrationsTable: string,
  migrations: readonly PostgresMigration[],
  migrationSchema?: PostgresMigrationSchemaIdentity,
): void {
  // Quote the table name as a Postgres identifier (double-quote, doubling any
  // embedded quotes) so it is splice-safe even though it is interpolated into DDL.
  const quotedMigrationsTable = quotePostgresIdentifier(migrationsTable);
  const migrationLedger =
    db.dialect === "postgres" && migrationSchema
      ? buildPostgresQualifiedMigrationLedger(migrationSchema, migrationsTable)
      : quotedMigrationsTable;
  const { applied, compatibility } = db.transaction("immediate", () => {
    configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, false);
    if (db.dialect !== "postgres") {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${quotedMigrationsTable} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
    const appliedRows = reconcileLegacyCompoundV124LedgerSync(
      db,
      migrationSchema,
      migrationsTable,
      migrations,
      db.prepare(`SELECT version, name FROM ${migrationLedger} ORDER BY version ASC`).all() as Array<{
        version: number;
        name: string;
      }>,
    );
    const normalizedAppliedRows = appliedRows.map((row) => ({ version: Number(row.version), name: row.name }));
    const normalizedCompatibility =
      db.dialect === "postgres"
        ? normalizePostgresMigrationLedgerForHistoricalRepair({
            definitions: migrations,
            appliedRows: normalizedAppliedRows,
          })
        : { appliedRows: normalizedAppliedRows, requiresHistoryRepairValidation: false };
    const result = {
      compatibility: normalizedCompatibility,
      applied: assertValidAppliedMigrationLedger(migrations, normalizedCompatibility.appliedRows, "Postgres"),
    };
    assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
    if (result.applied.size === migrations.length) {
      assertCanonicalPostgresSchemaShapeSync(db, migrationSchema, migrations);
    }
    return result;
  });

  let newlyAppliedCount = 0;
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    if (migration.batchedStatements) {
      runBatchedMigrationSync(db, migrationSchema, migrationsTable, migration, migration.batchedStatements);
      db.transaction("immediate", () => {
        configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, false);
        if (applied.size + newlyAppliedCount + 1 === migrations.length) {
          assertCanonicalPostgresSchemaShapeSync(db, migrationSchema, migrations);
        }
        markMigrationAppliedSync(db, migrationLedger, migration);
        if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
          assertStrictPostgresLedgerSync(db, migrationLedger, migrations);
        }
        assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
      });
      newlyAppliedCount += 1;
      continue;
    }
    db.transaction("immediate", () => {
      const bridgeRequired =
        db.dialect === "postgres" && requiresPostgresHistoryRepairLedgerBridge(migrationsTable, migration);
      configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, bridgeRequired);
      const bridgeActive = executePostgresAtomicMigrationSync(db, migrationSchema, migrationsTable, migration);
      if (applied.size + newlyAppliedCount + 1 === migrations.length) {
        assertCanonicalPostgresSchemaShapeSync(db, migrationSchema, migrations);
      }
      markMigrationAppliedSync(db, migrationLedger, migration);
      if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
        assertStrictPostgresLedgerSync(db, migrationLedger, migrations);
      }
      if (bridgeActive) {
        db.exec(POSTGRES_HISTORY_REPAIR_TEMP_VIEW_DROP_SQL);
      }
      assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
    });
    newlyAppliedCount += 1;
  }
}

function assertCanonicalPostgresSchemaShapeSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrations: readonly PostgresMigration[],
): void {
  if (db.dialect !== "postgres" || !migrationSchema) return;
  const manifest = buildCanonicalPostgresSchemaShapeManifest(migrations);
  if (manifest.tables.length === 0) return;
  const relationLockSql = buildPostgresSchemaShapeRelationLockSql(migrationSchema, manifest);
  if (relationLockSql) db.exec(relationLockSql);
  const issues = db.prepare(POSTGRES_SCHEMA_SHAPE_VALIDATION_SQL).all<PostgresSchemaShapeIssueRow>({
    tablesJson: JSON.stringify(manifest.tables),
    indexesJson: JSON.stringify(manifest.indexes),
    schemaOid: migrationSchema.oid,
  });
  assertPostgresSchemaShapeIssues(issues);
}

function assertPostgresBootstrapReplacementShapeSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  manifest: PostgresSchemaShapeManifest,
  replacedRelations: PostgresSchemaShapeManifest = manifest,
): void {
  const parameters = {
    tablesJson: JSON.stringify(manifest.tables),
    indexesJson: JSON.stringify(manifest.indexes),
    schemaOid: migrationSchema.oid,
  };
  const shape = db.prepare(POSTGRES_SCHEMA_SHAPE_VALIDATION_SQL).all<PostgresSchemaShapeIssueRow>(parameters);
  assertPostgresSchemaShapeIssues(shape);
  const ownedObjects = db.prepare(POSTGRES_SCHEMA_SHAPE_REPLACEMENT_VALIDATION_SQL).all<PostgresSchemaShapeIssueRow>({
    tablesJson: JSON.stringify(replacedRelations.tables),
    indexesJson: JSON.stringify(replacedRelations.indexes),
    schemaOid: migrationSchema.oid,
  });
  assertPostgresSchemaShapeIssues(ownedObjects);
}

function assertRemoteWorkerMeshProvenanceResetOwnsEveryDependencySync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
): void {
  const dependencies = db
    .prepare(POSTGRES_REMOTE_WORKER_MESH_PROVENANCE_DEPENDENCY_PREFLIGHT_SQL)
    .get<{ unexpected_owned_dependency_exists: boolean }>({ schemaOid: migrationSchema.oid });
  if (dependencies?.unexpected_owned_dependency_exists !== false) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap provenance column has unexpected posture or a local dependency; refusing automatic replacement.",
    );
  }
}

function prepareGovernedRemediationBootstrapForFoundationSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migration: PostgresMigration,
): void {
  if (db.dialect !== "postgres" || !isCanonicalGovernedRemediationFoundationMigration(migration)) return;
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }

  const state = db.prepare(POSTGRES_GOVERNED_REMEDIATION_BOOTSTRAP_PREFLIGHT_SQL).get<{
    state_table_exists: boolean;
    legacy_approval_column_exists: boolean;
  }>({ schemaOid: migrationSchema.oid });
  if (!state?.state_table_exists || state.legacy_approval_column_exists) return;

  const manifest = buildGovernedRemediationBootstrapManifest();
  const replacementLockSql = buildPostgresSchemaShapeReplacementLockSql(migrationSchema, manifest);
  if (replacementLockSql) db.exec(replacementLockSql);
  const lockedState = db.prepare(POSTGRES_GOVERNED_REMEDIATION_BOOTSTRAP_PREFLIGHT_SQL).get<{
    state_table_exists: boolean;
    legacy_approval_column_exists: boolean;
  }>({ schemaOid: migrationSchema.oid });
  if (!lockedState?.state_table_exists || lockedState.legacy_approval_column_exists) {
    throw new Error(
      "Postgres governed-remediation bootstrap classification changed while acquiring its replacement lock; refusing automatic replacement.",
    );
  }
  try {
    assertPostgresBootstrapReplacementShapeSync(db, migrationSchema, manifest);
  } catch (error) {
    throw new Error(
      "Postgres governed-remediation bootstrap relations are neither the legacy v134 shape nor the exact current empty v135 shape; refusing automatic replacement.",
      { cause: error },
    );
  }
  const rows = db.prepare(buildGovernedRemediationBootstrapRowsSql(migrationSchema)).get<{ has_rows: boolean }>();
  if (rows?.has_rows !== false) {
    throw new Error(
      "Postgres governed-remediation bootstrap relations contain rows; refusing to replace authority-bearing state.",
    );
  }
  db.exec(buildGovernedRemediationBootstrapDropSql(migrationSchema));
}

function prepareRemoteWorkerMeshBootstrapForAuthoritySync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migration: PostgresMigration,
): void {
  if (db.dialect !== "postgres" || !isCanonicalRemoteWorkerMeshAuthorityMigration(migration)) return;
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }

  const state = db.prepare(POSTGRES_REMOTE_WORKER_MESH_BOOTSTRAP_PREFLIGHT_SQL).get<{
    admission_table_exists: boolean;
    final_provenance_column_exists: boolean;
  }>({ schemaOid: migrationSchema.oid });
  if (!state?.admission_table_exists || !state.final_provenance_column_exists) return;

  const manifest = buildRemoteWorkerMeshBootstrapManifest();
  const replacedRelations = selectPostgresSchemaShapeTables(manifest, REMOTE_WORKER_MESH_BOOTSTRAP_DROP_ORDER);
  const replacementLockSql = buildPostgresSchemaShapeReplacementLockSql(migrationSchema, manifest);
  if (replacementLockSql) db.exec(replacementLockSql);
  const lockedState = db.prepare(POSTGRES_REMOTE_WORKER_MESH_BOOTSTRAP_PREFLIGHT_SQL).get<{
    admission_table_exists: boolean;
    final_provenance_column_exists: boolean;
  }>({ schemaOid: migrationSchema.oid });
  if (!lockedState?.admission_table_exists || !lockedState.final_provenance_column_exists) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap classification changed while acquiring its replacement lock; refusing automatic replacement.",
    );
  }
  try {
    assertPostgresBootstrapReplacementShapeSync(db, migrationSchema, manifest, replacedRelations);
    assertRemoteWorkerMeshProvenanceResetOwnsEveryDependencySync(db, migrationSchema);
  } catch (error) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap relations are not the exact current empty v137 shape; refusing automatic replacement.",
      { cause: error },
    );
  }
  const rows = db.prepare(buildRemoteWorkerMeshBootstrapRowsSql(migrationSchema)).get<{ has_rows: boolean }>();
  if (rows?.has_rows !== false) {
    throw new Error(
      "Postgres remote-worker mesh bootstrap relations contain rows; refusing to replace authority state.",
    );
  }
  db.exec(buildRemoteWorkerMeshBootstrapResetSql(migrationSchema));
}

function prepareMobilePushBootstrapForAuthoritySync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migration: PostgresMigration,
): void {
  if (db.dialect !== "postgres" || !isCanonicalMobilePushAuthorityMigration(migration)) return;
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }

  const state = db
    .prepare(POSTGRES_MOBILE_PUSH_BOOTSTRAP_PREFLIGHT_SQL)
    .get<{ registration_table_exists: boolean }>({ schemaOid: migrationSchema.oid });
  if (!state?.registration_table_exists) return;

  const manifest = buildMobilePushBootstrapManifest();
  const replacementLockSql = buildPostgresSchemaShapeReplacementLockSql(migrationSchema, manifest);
  if (replacementLockSql) db.exec(replacementLockSql);
  const lockedState = db
    .prepare(POSTGRES_MOBILE_PUSH_BOOTSTRAP_PREFLIGHT_SQL)
    .get<{ registration_table_exists: boolean }>({ schemaOid: migrationSchema.oid });
  if (!lockedState?.registration_table_exists) {
    throw new Error(
      "Postgres mobile-push bootstrap classification changed while acquiring its replacement lock; refusing automatic replacement.",
    );
  }
  try {
    assertPostgresBootstrapReplacementShapeSync(db, migrationSchema, manifest);
    const defaults = db
      .prepare(POSTGRES_MOBILE_PUSH_BOOTSTRAP_DEFAULTS_SQL)
      .get<{ defaults_exact: boolean }>({ schemaOid: migrationSchema.oid });
    if (defaults?.defaults_exact !== true) {
      throw new Error("Postgres mobile-push bootstrap defaults are not canonical.");
    }
  } catch (error) {
    throw new Error(
      "Postgres mobile-push bootstrap relations are not the exact current empty v138 shape; refusing automatic replacement.",
      { cause: error },
    );
  }
  const rows = db.prepare(buildMobilePushBootstrapRowsSql(migrationSchema)).get<{ has_rows: boolean }>();
  if (rows?.has_rows !== false) {
    throw new Error("Postgres mobile-push bootstrap relations contain rows; refusing to replace authority state.");
  }
  db.exec(buildMobilePushBootstrapDropSql(migrationSchema));
}

function reconcileLegacyCompoundV124LedgerSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrationsTable: string,
  migrations: readonly PostgresMigration[],
  appliedRows: readonly { version: number; name: string }[],
): Array<{ version: number; name: string }> {
  if (db.dialect !== "postgres") {
    return [...appliedRows];
  }
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }

  const initialClassification = classifyLegacyCompoundV124Ledger({ definitions: migrations, appliedRows });
  if (initialClassification === "none") {
    return [...appliedRows];
  }
  if (initialClassification === "invalid-candidate") {
    throw new Error(
      "Postgres legacy compound-engineering v124 ledger claim is not the exact repairable deployed state; refusing automatic reconciliation.",
    );
  }

  const qualifiedMigrationsTable = buildPostgresQualifiedMigrationLedger(migrationSchema, migrationsTable);
  db.exec(buildPostgresLegacyCompoundLedgerRepairLockSql(qualifiedMigrationsTable));
  const lockedRows = db
    .prepare(`SELECT version, name FROM ${qualifiedMigrationsTable} ORDER BY version ASC`)
    .all() as Array<{ version: number; name: string }>;
  const lockedClassification = classifyLegacyCompoundV124Ledger({ definitions: migrations, appliedRows: lockedRows });
  if (lockedClassification === "none") {
    return lockedRows;
  }
  if (lockedClassification !== "exact-candidate") {
    throw new Error(
      "Postgres legacy compound-engineering v124 ledger changed while the repair lock was acquired; refusing automatic reconciliation.",
    );
  }

  assertLegacyCompoundV124Catalog(
    db.prepare(POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL).get<{ matches_expected: boolean }>(),
  );
  db.exec(POSTGRES_LEGACY_COMPOUND_V124_RELATION_LOCK_SQL);
  assertLegacyCompoundV124Catalog(
    db.prepare(POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL).get<{ matches_expected: boolean }>(),
  );
  const repairedRows = db
    .prepare(buildPostgresLegacyCompoundLedgerRepairSql(qualifiedMigrationsTable, "@legacyName"))
    .all({ legacyName: "compound_engineering_foundation" });
  assertLegacyCompoundV124LedgerRepairResult(repairedRows);
  assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
  return db.prepare(`SELECT version, name FROM ${qualifiedMigrationsTable} ORDER BY version ASC`).all() as Array<{
    version: number;
    name: string;
  }>;
}

function markMigrationAppliedSync(
  db: DatabaseClient,
  quotedMigrationsTable: string,
  migration: PostgresMigration,
): void {
  db.prepare(
    `INSERT INTO ${quotedMigrationsTable} (version, name, applied_at) ` + "VALUES (@version, @name, CURRENT_TIMESTAMP)",
  ).run({
    version: migration.version,
    name: migration.name,
  });
}

function configurePostgresMigrationTransactionSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrationsTable: string,
  historyRepairBridge: boolean,
): void {
  if (db.dialect !== "postgres") {
    return;
  }
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }
  const searchPath = buildPostgresMigrationSearchPath(migrationSchema, historyRepairBridge);
  const row = db
    .prepare(buildPostgresMigrationSetLocalSearchPathSql("@searchPath"))
    .get<{ migration_search_path: string }>({ searchPath });
  assertPostgresMigrationSearchPathConfigured(row, searchPath);
  assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
  const qualifiedMigrationsTable = buildPostgresQualifiedMigrationLedger(migrationSchema, migrationsTable);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${qualifiedMigrationsTable} (
      version pg_catalog.int4 PRIMARY KEY,
      name pg_catalog.text NOT NULL,
      applied_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now()
    );
  `);
  db.exec(buildPostgresMigrationLedgerGuardLockSql(qualifiedMigrationsTable));
  assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
}

function assertPostgresMigrationTransactionSchemaIdentitySync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
): void {
  if (db.dialect !== "postgres") {
    return;
  }
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }
  const identity = db.prepare(buildPostgresMigrationSchemaIdentityCheckSql("@schemaName")).get<{
    current_schema_name: string;
    current_schema_oid: string;
    current_schema_owned_by_current_user: boolean;
    current_schema_has_exclusive_create_authority: boolean;
    existing_unowned_relation: string | null;
  }>({ schemaName: migrationSchema.name });
  assertPostgresMigrationSchemaIdentityMatches(identity, migrationSchema);
}

function executePostgresAtomicMigrationSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrationsTable: string,
  migration: PostgresMigration,
): boolean {
  if (db.dialect !== "postgres" || !requiresPostgresHistoryRepairLedgerBridge(migrationsTable, migration)) {
    prepareGovernedRemediationBootstrapForFoundationSync(db, migrationSchema, migration);
    prepareRemoteWorkerMeshBootstrapForAuthoritySync(db, migrationSchema, migration);
    prepareMobilePushBootstrapForAuthoritySync(db, migrationSchema, migration);
    db.exec(migration.sql);
    return false;
  }

  const preflight = db.prepare(POSTGRES_HISTORY_REPAIR_TEMP_RELATION_PREFLIGHT_SQL).get<{ relation: string | null }>();
  assertPostgresHistoryRepairTempRelationAvailable(preflight);
  db.exec(buildPostgresHistoryRepairTempViewSql(migrationsTable, migrationSchema));
  const resolution = db
    .prepare(POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL)
    .get<{ bridge_active: boolean | null }>();
  assertPostgresHistoryRepairTempViewOwnsResolution(resolution);
  db.exec(migration.sql);
  return true;
}

function assertStrictPostgresLedgerSync(
  db: DatabaseClient,
  quotedMigrationsTable: string,
  migrations: readonly PostgresMigration[],
): void {
  const appliedRows = db
    .prepare(`SELECT version, name FROM ${quotedMigrationsTable} ORDER BY version ASC`)
    .all() as Array<{ version: number; name: string }>;
  assertValidAppliedMigrationLedger(
    migrations,
    appliedRows.map((row) => ({ version: Number(row.version), name: row.name })),
    "Postgres",
  );
}

interface PinnedSessionDatabaseClient extends DatabaseClient {
  withPinnedSession<T>(callback: (controls: PostgresPinnedSessionControls) => T): T;
}

function requirePinnedSessionDatabase(db: DatabaseClient): PinnedSessionDatabaseClient {
  const candidate = db as Partial<PinnedSessionDatabaseClient>;
  if (typeof candidate.withPinnedSession !== "function") {
    throw new Error("Postgres migrations require a database client with pinned-session support.");
  }
  return candidate as PinnedSessionDatabaseClient;
}

function runBatchedMigrationSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrationsTable: string,
  migration: PostgresMigration,
  statements: readonly PostgresMigrationBatchStatement[],
): void {
  let changedRows: number;
  do {
    changedRows = 0;
    for (const statement of statements) {
      changedRows += db.transaction("immediate", () => {
        configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, false);
        const affectedRows = assertAffectedRowCount(migration, statement, db.prepare(statement.sql).run().changes);
        assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
        return affectedRows;
      });
    }
  } while (changedRows > 0);
}
