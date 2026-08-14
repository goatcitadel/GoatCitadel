interface OrderedIndexKey {
  column: string;
  direction?: "DESC";
}

interface OrderedIndexSpec {
  name: string;
  tableName: string;
  keys: readonly OrderedIndexKey[];
}

interface UniqueConstraintIndexSpec {
  name: string;
  tableName: string;
  keys: readonly string[];
}

// FROZEN WITH POSTGRES V149. These PostgreSQL-owned migrations intentionally
// preserve descending scan order that the SQLite-derived bootstrap renderer
// cannot represent. New changes require a new forward migration.
const POSTGRES_V149_ORDERED_INDEX_SPECS = [
  {
    name: "idx_change_plans_session_created",
    tableName: "change_plans",
    keys: [
      { column: "workspace_id" },
      { column: "session_id" },
      { column: "created_at", direction: "DESC" },
      { column: "plan_id", direction: "DESC" },
    ],
  },
  {
    name: "idx_change_plans_workspace_created",
    tableName: "change_plans",
    keys: [
      { column: "workspace_id" },
      { column: "created_at", direction: "DESC" },
      { column: "plan_id", direction: "DESC" },
    ],
  },
  {
    name: "idx_chat_change_plans_session",
    tableName: "chat_change_plans",
    keys: [
      { column: "session_id" },
      { column: "created_at", direction: "DESC" },
      { column: "plan_id", direction: "DESC" },
    ],
  },
  {
    name: "idx_managed_source_installs_status_updated",
    tableName: "managed_source_installs",
    keys: [
      { column: "status" },
      { column: "updated_at", direction: "DESC" },
      { column: "install_id", direction: "DESC" },
    ],
  },
  {
    name: "idx_product_source_update_manifests_install",
    tableName: "product_source_update_manifests",
    keys: [
      { column: "install_id" },
      { column: "created_at", direction: "DESC" },
      { column: "manifest_id", direction: "DESC" },
    ],
  },
] as const satisfies readonly OrderedIndexSpec[];

// The dynamic v2 bootstrap creates independent named unique indexes. The
// later PostgreSQL owners expressed the same invariant as UNIQUE constraints.
// Renaming the backing indexes preserves the constraints (and any dependent
// foreign keys) while satisfying the canonical catalog identity.
const POSTGRES_V149_UNIQUE_CONSTRAINT_INDEX_SPECS = [
  {
    name: "idx_change_plan_events_plan_id_sequence_unique",
    tableName: "change_plan_events",
    keys: ["plan_id", "sequence"],
  },
  {
    name: "idx_chat_fanout_invocations_parent_run_id_tool_run_id_unique",
    tableName: "chat_fanout_invocations",
    keys: ["parent_run_id", "tool_run_id"],
  },
  {
    name: "idx_chat_turn_secure_configuration_reservations_ad_dd7fd40b1194",
    tableName: "chat_turn_secure_configuration_reservations",
    keys: ["admission_id", "durable_run_id", "prompt_id", "waiting_run_version"],
  },
  {
    name: "idx_product_source_update_events_manifest_id_idemp_82af46ec9c3b",
    tableName: "product_source_update_events",
    keys: ["manifest_id", "idempotency_key"],
  },
  {
    name: "idx_product_source_update_events_manifest_id_sequence_unique",
    tableName: "product_source_update_events",
    keys: ["manifest_id", "sequence"],
  },
  {
    name: "idx_product_source_update_manifests_plan_id_unique",
    tableName: "product_source_update_manifests",
    keys: ["plan_id"],
  },
  {
    name: "idx_remote_worker_protected_admission_evidence_env_93408bc24247",
    tableName: "remote_worker_protected_admission_evidence",
    keys: ["envelope_sha256"],
  },
  {
    name: "idx_remote_worker_protected_admission_evidence_evi_b24527dc42f7",
    tableName: "remote_worker_protected_admission_evidence",
    keys: ["evidence_nonce_sha256"],
  },
  {
    name: "idx_remote_worker_protected_admission_evidence_ope_e63f547a0089",
    tableName: "remote_worker_protected_admission_evidence",
    keys: ["operation_id_base64url"],
  },
  {
    name: "idx_remote_worker_protected_admission_signer_pins__d621b497c5d6",
    tableName: "remote_worker_protected_admission_signer_pins",
    keys: ["registry_workspace_id", "worker_id", "keyset_generation"],
  },
] as const satisfies readonly UniqueConstraintIndexSpec[];

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quotePostgresLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderAttributeNumber(tableName: string, columnName: string): string {
  return `(
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = target_relation
            AND attribute.attname = ${quotePostgresLiteral(columnName)}
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )`;
}

function renderOrderedIndexRepair(spec: OrderedIndexSpec, ordinal: number): string {
  const canonicalSortOptions = spec.keys.map((key) => (key.direction === "DESC" ? 3 : 0)).join(" ");
  const bootstrapSortOptions = spec.keys.map(() => 0).join(" ");
  const renderedKeys = spec.keys
    .map((key) => `${quotePostgresIdentifier(key.column)}${key.direction === "DESC" ? " DESC" : ""}`)
    .join(", ");
  const keyChecks = spec.keys
    .map(
      (key, index) =>
        `frozen_index.indkey[${index}] IS DISTINCT FROM ${renderAttributeNumber(spec.tableName, key.column)}`,
    )
    .join("\n    OR ");
  const reservedName = `gc_v149_ordered_${ordinal.toString().padStart(2, "0")}`;
  const reservedIdentifier = quotePostgresIdentifier(reservedName);
  const indexIdentifier = quotePostgresIdentifier(spec.name);
  const tableIdentifier = quotePostgresIdentifier(spec.tableName);
  return `DO $gc_v149_ordered_index$
DECLARE
  target_relation pg_catalog.regclass;
  frozen_index RECORD;
  original_default_tablespace TEXT;
BEGIN
  target_relation := pg_catalog.to_regclass(${quotePostgresLiteral(spec.tableName)});
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Postgres v149 authority is missing table ${spec.tableName}' USING ERRCODE = '23514';
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE %s IN SHARE MODE', target_relation);
  IF pg_catalog.to_regclass(${quotePostgresLiteral(reservedName)}) IS NOT NULL THEN
    RAISE EXCEPTION 'Postgres v149 authority found reserved index ${reservedName}' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.to_regclass(${quotePostgresLiteral(spec.name)}) IS NULL THEN
    RAISE EXCEPTION 'Postgres v149 authority is missing ordered index ${spec.name}' USING ERRCODE = '23514';
  END IF;

  SELECT
      index_relation.oid AS index_oid,
      index_relation.relkind AS index_relkind,
      index_relation.relpersistence AS index_relpersistence,
      index_relation.relispartition AS index_relispartition,
      index_relation.reloptions AS index_reloptions,
      index_relation.relacl AS index_relacl,
      index_relation.relowner AS index_relowner,
      CASE WHEN index_relation.reltablespace = 0 THEN '' ELSE tablespace.spcname END AS replacement_default_tablespace,
      access_method.amname,
      index_row.indnatts,
      index_row.indnkeyatts,
      index_row.indisunique,
      index_row.indisprimary,
      index_row.indimmediate,
      index_row.indisexclusion,
      index_row.indisclustered,
      index_row.indisvalid,
      index_row.indcheckxmin,
      index_row.indisready,
      index_row.indislive,
      index_row.indisreplident,
      index_row.indnullsnotdistinct,
      index_row.indkey,
      index_row.indoption,
      index_row.indexprs,
      pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false) AS predicate_expression
    INTO frozen_index
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row ON index_row.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
    LEFT JOIN pg_catalog.pg_tablespace AS tablespace ON tablespace.oid = index_relation.reltablespace
    WHERE index_relation.relnamespace = (
        SELECT target_class.relnamespace FROM pg_catalog.pg_class AS target_class WHERE target_class.oid = target_relation
      )
      AND index_relation.relname = ${quotePostgresLiteral(spec.name)}
      AND index_row.indrelid = target_relation;

  IF NOT FOUND
    OR frozen_index.index_relkind IS DISTINCT FROM 'i'
    OR frozen_index.index_relpersistence IS DISTINCT FROM 'p'
    OR frozen_index.index_relispartition IS DISTINCT FROM FALSE
    OR frozen_index.index_reloptions IS NOT NULL
    OR frozen_index.index_relacl IS NOT NULL
    OR frozen_index.index_relowner IS DISTINCT FROM CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
    OR frozen_index.replacement_default_tablespace IS NULL
    OR frozen_index.amname IS DISTINCT FROM 'btree'
    OR frozen_index.indnatts IS DISTINCT FROM ${spec.keys.length}
    OR frozen_index.indnkeyatts IS DISTINCT FROM ${spec.keys.length}
    OR frozen_index.indisunique IS DISTINCT FROM FALSE
    OR frozen_index.indisprimary IS DISTINCT FROM FALSE
    OR frozen_index.indimmediate IS DISTINCT FROM TRUE
    OR frozen_index.indisexclusion IS DISTINCT FROM FALSE
    OR frozen_index.indisclustered IS DISTINCT FROM FALSE
    OR frozen_index.indisvalid IS DISTINCT FROM TRUE
    OR frozen_index.indcheckxmin IS DISTINCT FROM FALSE
    OR frozen_index.indisready IS DISTINCT FROM TRUE
    OR frozen_index.indislive IS DISTINCT FROM TRUE
    OR frozen_index.indisreplident IS DISTINCT FROM FALSE
    OR frozen_index.indnullsnotdistinct IS DISTINCT FROM FALSE
    OR frozen_index.indexprs IS NOT NULL
    OR frozen_index.predicate_expression IS NOT NULL
    OR (
      frozen_index.indoption IS DISTINCT FROM ${quotePostgresLiteral(canonicalSortOptions)}::pg_catalog.int2vector
      AND frozen_index.indoption IS DISTINCT FROM ${quotePostgresLiteral(bootstrapSortOptions)}::pg_catalog.int2vector
    )
    OR ${keyChecks}
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row WHERE constraint_row.conindid = frozen_index.index_oid
    )
  THEN
    RAISE EXCEPTION 'Postgres v149 authority found drifted ordered index ${spec.name}' USING ERRCODE = '23514';
  END IF;

  ALTER INDEX ${indexIdentifier} RENAME TO ${reservedIdentifier};
  DROP INDEX IF EXISTS ${indexIdentifier};
  IF frozen_index.indoption IS NOT DISTINCT FROM ${quotePostgresLiteral(canonicalSortOptions)}::pg_catalog.int2vector THEN
    ALTER INDEX ${reservedIdentifier} RENAME TO ${indexIdentifier};
  ELSE
    original_default_tablespace := pg_catalog.current_setting('default_tablespace');
    PERFORM pg_catalog.set_config('default_tablespace', frozen_index.replacement_default_tablespace, true);
    DROP INDEX ${reservedIdentifier};
    CREATE INDEX ${indexIdentifier} ON ${tableIdentifier} (${renderedKeys});
    PERFORM pg_catalog.set_config('default_tablespace', original_default_tablespace, true);
  END IF;
END
$gc_v149_ordered_index$;`;
}

function renderUniqueConstraintIndexRepair(spec: UniqueConstraintIndexSpec): string {
  const expectedKeyArray = `ARRAY[${spec.keys
    .map((columnName) => renderAttributeNumber(spec.tableName, columnName))
    .join(", ")}]::SMALLINT[]`;
  const keyChecks = spec.keys
    .map(
      (columnName, index) =>
        `legacy_index.indkey[${index}] IS DISTINCT FROM ${renderAttributeNumber(spec.tableName, columnName)}`,
    )
    .join("\n    OR ");
  return `DO $gc_v149_unique_index$
DECLARE
  target_relation pg_catalog.regclass;
  matching_constraints BIGINT;
  legacy_index RECORD;
BEGIN
  target_relation := pg_catalog.to_regclass(${quotePostgresLiteral(spec.tableName)});
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Postgres v149 authority is missing table ${spec.tableName}' USING ERRCODE = '23514';
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE %s IN SHARE MODE', target_relation);

  IF pg_catalog.to_regclass(${quotePostgresLiteral(spec.name)}) IS NULL THEN
    SELECT pg_catalog.count(*)
      INTO matching_constraints
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = target_relation
        AND constraint_row.contype = 'u'
        AND constraint_row.conkey = ${expectedKeyArray};
    IF matching_constraints IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Postgres v149 authority found unsupported unique-constraint lineage for ${spec.name}'
        USING ERRCODE = '23514';
    END IF;

    SELECT
        index_relation.relname AS index_name,
        index_relation.relkind AS index_relkind,
        index_relation.relpersistence AS index_relpersistence,
        index_relation.relispartition AS index_relispartition,
        index_relation.reloptions AS index_reloptions,
        index_relation.relacl AS index_relacl,
        index_relation.relowner AS index_relowner,
        access_method.amname,
        index_row.indnatts,
        index_row.indnkeyatts,
        index_row.indisunique,
        index_row.indisprimary,
        index_row.indimmediate,
        index_row.indisexclusion,
        index_row.indisclustered,
        index_row.indisvalid,
        index_row.indcheckxmin,
        index_row.indisready,
        index_row.indislive,
        index_row.indisreplident,
        index_row.indnullsnotdistinct,
        index_row.indkey,
        index_row.indoption,
        index_row.indexprs,
        pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false) AS predicate_expression
      INTO legacy_index
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = constraint_row.conindid
      JOIN pg_catalog.pg_index AS index_row ON index_row.indexrelid = index_relation.oid
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
      WHERE constraint_row.conrelid = target_relation
        AND constraint_row.contype = 'u'
        AND constraint_row.conkey = ${expectedKeyArray};

    IF NOT FOUND
      OR legacy_index.index_relkind IS DISTINCT FROM 'i'
      OR legacy_index.index_relpersistence IS DISTINCT FROM 'p'
      OR legacy_index.index_relispartition IS DISTINCT FROM FALSE
      OR legacy_index.index_reloptions IS NOT NULL
      OR legacy_index.index_relacl IS NOT NULL
      OR legacy_index.index_relowner IS DISTINCT FROM CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
      OR legacy_index.amname IS DISTINCT FROM 'btree'
      OR legacy_index.indnatts IS DISTINCT FROM ${spec.keys.length}
      OR legacy_index.indnkeyatts IS DISTINCT FROM ${spec.keys.length}
      OR legacy_index.indisunique IS DISTINCT FROM TRUE
      OR legacy_index.indisprimary IS DISTINCT FROM FALSE
      OR legacy_index.indimmediate IS DISTINCT FROM TRUE
      OR legacy_index.indisexclusion IS DISTINCT FROM FALSE
      OR legacy_index.indisclustered IS DISTINCT FROM FALSE
      OR legacy_index.indisvalid IS DISTINCT FROM TRUE
      OR legacy_index.indcheckxmin IS DISTINCT FROM FALSE
      OR legacy_index.indisready IS DISTINCT FROM TRUE
      OR legacy_index.indislive IS DISTINCT FROM TRUE
      OR legacy_index.indisreplident IS DISTINCT FROM FALSE
      OR legacy_index.indnullsnotdistinct IS DISTINCT FROM FALSE
      OR legacy_index.indexprs IS NOT NULL
      OR legacy_index.predicate_expression IS NOT NULL
      OR legacy_index.indoption IS DISTINCT FROM ${quotePostgresLiteral(spec.keys.map(() => 0).join(" "))}::pg_catalog.int2vector
      OR ${keyChecks}
    THEN
      RAISE EXCEPTION 'Postgres v149 authority found drifted unique-constraint index ${spec.name}'
        USING ERRCODE = '23514';
    END IF;

    EXECUTE pg_catalog.format(
      'ALTER INDEX %I RENAME TO %I',
      legacy_index.index_name,
      ${quotePostgresLiteral(spec.name)}
    );
  END IF;
END
$gc_v149_unique_index$;`;
}

const POSTGRES_V149_MANAGED_SOURCE_REVISION_SQL = `
DO $gc_v149_managed_source_revision$
DECLARE
  target_relation pg_catalog.regclass;
  revision_type pg_catalog.oid;
  revision_not_null BOOLEAN;
  revision_has_default BOOLEAN;
BEGIN
  target_relation := pg_catalog.to_regclass('managed_source_installs');
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Postgres v149 authority is missing table managed_source_installs' USING ERRCODE = '23514';
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE %s IN SHARE MODE', target_relation);
  SELECT attribute.atttypid, attribute.attnotnull, default_value.oid IS NOT NULL
    INTO revision_type, revision_not_null, revision_has_default
    FROM pg_catalog.pg_attribute AS attribute
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
      AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = target_relation
      AND attribute.attname = 'revision'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
  IF NOT FOUND OR revision_not_null IS DISTINCT FROM TRUE OR revision_has_default IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Postgres v149 authority found invalid managed-source revision column' USING ERRCODE = '23514';
  END IF;
  IF revision_type = 'integer'::pg_catalog.regtype::pg_catalog.oid THEN
    NULL;
  ELSIF revision_type = 'bigint'::pg_catalog.regtype::pg_catalog.oid THEN
    IF EXISTS (
      SELECT 1
      FROM managed_source_installs
      WHERE revision < -2147483648 OR revision > 2147483647
    ) THEN
      RAISE EXCEPTION 'Postgres v149 authority cannot safely narrow managed-source revision' USING ERRCODE = '22003';
    END IF;
    ALTER TABLE "managed_source_installs"
      ALTER COLUMN "revision" TYPE INTEGER USING "revision"::INTEGER;
  ELSE
    RAISE EXCEPTION 'Postgres v149 authority found unsupported managed-source revision type' USING ERRCODE = '23514';
  END IF;
END
$gc_v149_managed_source_revision$;
`.trim();

export function buildPostgresV149CanonicalSchemaAuthoritySql(): string {
  return [
    POSTGRES_V149_MANAGED_SOURCE_REVISION_SQL,
    ...POSTGRES_V149_ORDERED_INDEX_SPECS.map(renderOrderedIndexRepair),
    ...POSTGRES_V149_UNIQUE_CONSTRAINT_INDEX_SPECS.map(renderUniqueConstraintIndexRepair),
  ].join("\n");
}
