// Frozen forward-only metadata convergence for the PostgreSQL v115 lineage.
// Renames exact existing UNIQUE backing indexes; preserves rows, constraints and FKs.
// Rollback is a reviewed forward migration or restoration of the pre-migration backup.
interface UniqueConstraintIndexSpec {
  name: string;
  tableName: string;
  keys: readonly string[];
}
const SESSION_CONTROL_INDEX_SPECS = [
  {
    name: "idx_chat_session_control_auth_revoke_operation_tar_6e00b3afbc47",
    tableName: "chat_session_control_auth_revoke_operation_targets",
    keys: ["event_idempotency_key"],
  },
  {
    name: "idx_chat_session_control_auth_revoke_operation_tar_ce3f109ee890",
    tableName: "chat_session_control_auth_revoke_operation_targets",
    keys: ["operation_idempotency_key", "target_kind", "session_id", "request_id", "generation"],
  },
  {
    name: "idx_chat_session_control_auth_revoke_operation_tar_e8095a5ef8be",
    tableName: "chat_session_control_auth_revoke_operation_targets",
    keys: ["event_id"],
  },
  {
    name: "idx_chat_session_lifecycle_intents_event_id_unique",
    tableName: "chat_session_lifecycle_intents",
    keys: ["event_id"],
  },
  {
    name: "idx_chat_session_lifecycle_intents_idempotency_key_unique",
    tableName: "chat_session_lifecycle_intents",
    keys: ["idempotency_key"],
  },
  {
    name: "idx_chat_session_lifecycle_intents_workspace_id_se_8faaded8c241",
    tableName: "chat_session_lifecycle_intents",
    keys: ["workspace_id", "session_id", "intent_kind", "next_generation"],
  },
  {
    name: "idx_chat_session_mutation_admission_events_admissi_1d1c81ae04a6",
    tableName: "chat_session_mutation_admission_events",
    keys: ["admission_id", "event_sequence"],
  },
  {
    name: "idx_chat_session_mutation_admission_events_idempot_009a2f3f904c",
    tableName: "chat_session_mutation_admission_events",
    keys: ["idempotency_key"],
  },
  {
    name: "idx_chat_session_mutation_admissions_admit_event_id_unique",
    tableName: "chat_session_mutation_admissions",
    keys: ["admit_event_id"],
  },
  {
    name: "idx_chat_session_mutation_admissions_idempotency_key_unique",
    tableName: "chat_session_mutation_admissions",
    keys: ["idempotency_key"],
  },
  {
    name: "idx_chat_session_mutation_admissions_terminal_event_id_unique",
    tableName: "chat_session_mutation_admissions",
    keys: ["terminal_event_id"],
  },
  {
    name: "idx_chat_session_mutation_admissions_terminal_idem_d71f116f03cd",
    tableName: "chat_session_mutation_admissions",
    keys: ["terminal_idempotency_key"],
  },
  {
    name: "idx_chat_session_mutation_admissions_turn_id_unique",
    tableName: "chat_session_mutation_admissions",
    keys: ["turn_id"],
  },
  {
    name: "idx_chat_turn_capability_profile_incarnation_bindi_391f940e7c00",
    tableName: "chat_turn_capability_profile_incarnation_bindings",
    keys: ["turn_id"],
  },
  {
    name: "idx_chat_turn_mutation_admission_durable_bindings__aa101cdd10e5",
    tableName: "chat_turn_mutation_admission_durable_bindings",
    keys: ["durable_run_id"],
  },
  {
    name: "idx_chat_turn_mutation_admission_durable_bindings__bb84ecb0a18a",
    tableName: "chat_turn_mutation_admission_durable_bindings",
    keys: ["turn_id"],
  },
  {
    name: "idx_chat_turn_session_incarnation_bindings_admission_id_unique",
    tableName: "chat_turn_session_incarnation_bindings",
    keys: ["admission_id"],
  },
  {
    name: "idx_chat_turn_user_input_continuation_seals_admiss_5f799f2ba2ad",
    tableName: "chat_turn_user_input_continuation_seals",
    keys: ["admission_id", "durable_run_id", "prompt_id"],
  },
  {
    name: "idx_chat_turn_user_input_continuation_seals_durabl_44e3c4d683dc",
    tableName: "chat_turn_user_input_continuation_seals",
    keys: ["durable_run_id", "prompt_id"],
  },
] as const satisfies readonly UniqueConstraintIndexSpec[];

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
  return `DO $gc_v211_unique_index$
DECLARE
  target_relation pg_catalog.regclass;
  matching_constraints BIGINT;
  legacy_index RECORD;
BEGIN
  target_relation := pg_catalog.to_regclass(${quotePostgresLiteral(spec.tableName)});
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Postgres v211 authority is missing table ${spec.tableName}' USING ERRCODE = '23514';
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
      RAISE EXCEPTION 'Postgres v211 authority found unsupported unique-constraint lineage for ${spec.name}'
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
      RAISE EXCEPTION 'Postgres v211 authority found drifted unique-constraint index ${spec.name}'
        USING ERRCODE = '23514';
    END IF;

    EXECUTE pg_catalog.format(
      'ALTER INDEX %I RENAME TO %I',
      legacy_index.index_name,
      ${quotePostgresLiteral(spec.name)}
    );
  END IF;
END
$gc_v211_unique_index$;`;
}

export function buildPostgresV211SessionControlIndexAuthoritySql(): string {
  return SESSION_CONTROL_INDEX_SPECS.map(renderUniqueConstraintIndexRepair).join("\n\n");
}
