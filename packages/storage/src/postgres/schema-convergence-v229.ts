// Pure SQL/rendering owner: no database client, typed reads, or dependency allowance.
const SNAPSHOT_V3_AUTHORITY = `
  (schema_version IN ('chat.routed-context-snapshot.v1', 'chat.routed-context-snapshot.v2')
    AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL
    AND admission_id IS NULL AND session_incarnation_id IS NULL AND admission_material_sha256 IS NULL
    AND admission_aggregate_revision IS NULL AND admission_controller_generation IS NULL)
  OR (schema_version = 'chat.routed-context-snapshot.v3'
    AND capability_profile_id IS NULL AND capability_profile_hash IS NULL
    AND admission_id IS NOT NULL AND session_incarnation_id IS NOT NULL AND admission_material_sha256 IS NOT NULL
    AND admission_aggregate_revision IS NOT NULL AND admission_controller_generation IS NOT NULL)`;

function migrationRelation(schemaName: string, table: string) {
  const sql = `"${schemaName.replaceAll('"', '""')}"."${table}"`;
  const literal = `E'${sql.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  return { sql, literal };
}

/** Project only the three qualified relation spellings in verified frozen v122 SQL. */
export function scopePathFlavorV122Sql(sql: string, schemaName: string): string {
  for (const table of ["workspace_path_bridge_snapshots", "external_source_configs"]) {
    const relation = migrationRelation(schemaName, table);
    const replacements = [
      [`'public.${table}'`, relation.literal, 6],
      [
        `format('ALTER TABLE public.${table} DROP CONSTRAINT %I', frozen_constraint)`,
        `format('ALTER TABLE ONLY %s DROP CONSTRAINT %I', ${relation.literal}, frozen_constraint)`,
        2,
      ],
      [`ALTER TABLE public.${table}\n`, `ALTER TABLE ONLY ${relation.sql}\n`, 2],
    ] as const;
    for (const [historical, scoped, count] of replacements) {
      if (sql.split(historical).length !== count + 1) {
        throw new Error("Postgres migration 122 compatibility boundary changed.");
      }
      sql = sql.replaceAll(historical, () => scoped);
    }
  }
  return sql;
}

/** Exact historical v128 operation, bound to the already-validated migration schema. */
export function buildScopedRoutedContextV128Sql(schemaName: string): string {
  const { literal } = migrationRelation(schemaName, "chat_routed_context_snapshots");
  return `DO $routed_context_v2$
DECLARE
  target_relation pg_catalog.regclass := pg_catalog.to_regclass(${literal});
  constraint_name TEXT;
BEGIN
  IF target_relation IS NULL THEN RETURN; END IF;
  FOR constraint_name IN SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid = target_relation AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%schema_version%'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE ONLY %s DROP CONSTRAINT %I', target_relation, constraint_name);
  END LOOP;
  EXECUTE pg_catalog.format('ALTER TABLE ONLY %s ADD CONSTRAINT chat_routed_context_snapshots_schema_version_v2_check CHECK(schema_version IN (''chat.routed-context-snapshot.v1'', ''chat.routed-context-snapshot.v2''))', target_relation);
END
$routed_context_v2$;`;
}

// PG-only convergence to the existing logical PG204 / SQLite257 authority.
// Historical SQL/checksums stay frozen. Unknown constraint drift is never repair authority.
export const POSTGRES_SCHEMA_CONVERGENCE_V229_SQL = `
DO $context_authority_convergence$
DECLARE
  target_relation pg_catalog.regclass := pg_catalog.to_regclass('chat_routed_context_snapshots');
  v3_expression TEXT := $authority$${SNAPSHOT_V3_AUTHORITY}$authority$;
  v2_expression TEXT := $legacy$schema_version IN ('chat.routed-context-snapshot.v1', 'chat.routed-context-snapshot.v2')$legacy$;
  expected_v3 TEXT;
  expected_v2 TEXT;
  canonical_check RECORD;
  legacy_check RECORD;
BEGIN
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Context authority convergence requires the canonical snapshot relation' USING ERRCODE='23514';
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE ONLY %s IN ACCESS EXCLUSIVE MODE', target_relation);
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=target_relation OR inhparent=target_relation) THEN
    RAISE EXCEPTION 'Context authority convergence refuses an inherited snapshot relation' USING ERRCODE='23514';
  END IF;
  -- The observed damaged lineage has exactly one CHECK, the old v2 gate.
  -- An intact v3 installation may retain checks from an older table lineage.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=target_relation
    AND conname='chat_routed_context_snapshot_authority_v3')
    AND (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid=target_relation AND contype='c') <> 1 THEN
    RAISE EXCEPTION 'Context authority convergence found unknown damaged CHECK inventory' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=target_relation
    AND conname IN ('gc_v229_context_v3_probe','gc_v229_context_v2_probe')) THEN
    RAISE EXCEPTION 'Context authority convergence found a reserved probe constraint' USING ERRCODE='23514';
  END IF;
  EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT gc_v229_context_v3_probe CHECK(%s) NOT VALID', target_relation, v3_expression);
  EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT gc_v229_context_v2_probe CHECK(%s) NOT VALID', target_relation, v2_expression);
  SELECT pg_catalog.pg_get_expr(conbin,conrelid,false) INTO expected_v3
    FROM pg_catalog.pg_constraint WHERE conrelid=target_relation AND conname='gc_v229_context_v3_probe';
  SELECT pg_catalog.pg_get_expr(conbin,conrelid,false) INTO expected_v2
    FROM pg_catalog.pg_constraint WHERE conrelid=target_relation AND conname='gc_v229_context_v2_probe';
  SELECT contype, pg_catalog.pg_get_expr(conbin,conrelid,false) AS expression,
    convalidated,connoinherit,conislocal,coninhcount INTO canonical_check
    FROM pg_catalog.pg_constraint WHERE conrelid=target_relation AND conname='chat_routed_context_snapshot_authority_v3';
  SELECT contype, pg_catalog.pg_get_expr(conbin,conrelid,false) AS expression,
    convalidated,connoinherit,conislocal,coninhcount INTO legacy_check
    FROM pg_catalog.pg_constraint WHERE conrelid=target_relation AND conname='chat_routed_context_snapshots_schema_version_v2_check';
  IF canonical_check.contype IS NOT NULL THEN
    IF legacy_check.contype IS NOT NULL OR canonical_check.contype <> 'c'
      OR canonical_check.expression IS DISTINCT FROM expected_v3
      OR canonical_check.convalidated IS DISTINCT FROM TRUE
      OR canonical_check.connoinherit IS DISTINCT FROM FALSE
      OR canonical_check.conislocal IS DISTINCT FROM TRUE OR canonical_check.coninhcount IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Context authority convergence found unknown canonical constraint drift' USING ERRCODE='23514';
    END IF;
  ELSE
    IF legacy_check.contype IS DISTINCT FROM 'c' OR legacy_check.expression IS DISTINCT FROM expected_v2
      OR legacy_check.convalidated IS DISTINCT FROM TRUE OR legacy_check.connoinherit IS DISTINCT FROM FALSE
      OR legacy_check.conislocal IS DISTINCT FROM TRUE OR legacy_check.coninhcount IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Context authority convergence found unknown legacy constraint drift' USING ERRCODE='23514';
    END IF;
    EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT chat_routed_context_snapshot_authority_v3 CHECK(%s)', target_relation, v3_expression);
    EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT chat_routed_context_snapshots_schema_version_v2_check', target_relation);
  END IF;
  EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT gc_v229_context_v3_probe', target_relation);
  EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT gc_v229_context_v2_probe', target_relation);
END
$context_authority_convergence$;
`;
