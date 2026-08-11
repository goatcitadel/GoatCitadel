/* eslint-disable max-lines -- ordered DDL simulation and both steady/destructive catalog validators share one normalized manifest contract. */

import type { PostgresMigration } from "./migrations.js";
import { quotePostgresIdentifier, type PostgresMigrationSchemaIdentity } from "./migration-ledger-compatibility.js";

const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

export interface PostgresSchemaShapeColumn {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
}

export interface PostgresSchemaShapeConstraint {
  name: string | null;
  type: "p" | "u" | "f" | "c";
  columns: string[];
  referencedTable: string | null;
  referencedColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface PostgresSchemaShapeTable {
  name: string;
  columns: PostgresSchemaShapeColumn[];
  constraints: PostgresSchemaShapeConstraint[];
}

export interface PostgresSchemaShapeIndex {
  name: string;
  tableName: string;
  unique: boolean;
  method: string;
  keys: string[];
  predicate: string | null;
  predicateTerms: string[];
  predicateMode: "none" | "exact" | "membership";
  predicateFingerprint: string | null;
}

export interface PostgresSchemaShapeManifest {
  tables: PostgresSchemaShapeTable[];
  indexes: PostgresSchemaShapeIndex[];
}

export interface PostgresSchemaShapeIssueRow {
  issue?: unknown;
}

/**
 * Catalog validation is intentionally structural rather than a comparison of
 * migration text. PostgreSQL is free to rewrite defaults, predicates, and
 * constraint DDL when it stores them, while these fields remain stable:
 * relation kind/OID, owner, ordered columns, constraint keys, index access
 * method/keys, and the material predicate terms.
 */
export const POSTGRES_SCHEMA_SHAPE_VALIDATION_SQL = `
  /* goatcitadel_postgres_schema_shape_validation */
  WITH expected_tables AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset(@tablesJson::pg_catalog.jsonb) AS expected(
      name pg_catalog.text,
      columns pg_catalog.jsonb,
      constraints pg_catalog.jsonb
    )
  ),
  expected_columns AS (
    SELECT
      expected_table.name AS table_name,
      expected_column.name,
      expected_column.type,
      expected_column."notNull" AS not_null,
      expected_column."hasDefault" AS has_default,
      expected_column.generated
    FROM expected_tables AS expected_table
    CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(expected_table.columns) AS expected_column(
      name pg_catalog.text,
      type pg_catalog.text,
      "notNull" pg_catalog.bool,
      "hasDefault" pg_catalog.bool,
      generated pg_catalog.bool
    )
  ),
  expected_constraints AS (
    SELECT
      expected_table.name AS table_name,
      expected_constraint.name,
      expected_constraint.type,
      expected_constraint.columns,
      expected_constraint."referencedTable" AS referenced_table,
      expected_constraint."referencedColumns" AS referenced_columns,
      expected_constraint."onDelete" AS on_delete,
      expected_constraint."onUpdate" AS on_update
    FROM expected_tables AS expected_table
    CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(expected_table.constraints) AS expected_constraint(
      name pg_catalog.text,
      type pg_catalog.text,
      columns pg_catalog.jsonb,
      "referencedTable" pg_catalog.text,
      "referencedColumns" pg_catalog.jsonb,
      "onDelete" pg_catalog.text,
      "onUpdate" pg_catalog.text
    )
  ),
  expected_indexes AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset(@indexesJson::pg_catalog.jsonb) AS expected(
      name pg_catalog.text,
      "tableName" pg_catalog.text,
      "unique" pg_catalog.bool,
      method pg_catalog.text,
      keys pg_catalog.jsonb,
      predicate pg_catalog.text,
      "predicateTerms" pg_catalog.jsonb,
      "predicateMode" pg_catalog.text,
      "predicateFingerprint" pg_catalog.text
    )
  ),
  relation_issues AS (
    SELECT pg_catalog.format('table %I is missing or is not an owned ordinary relation', expected.name) AS issue
    FROM expected_tables AS expected
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND relation.relname OPERATOR(pg_catalog.=) expected.name
    WHERE relation.oid IS NULL
      OR relation.relkind OPERATOR(pg_catalog.<>) 'r'
      OR relation.relowner OPERATOR(pg_catalog.<>) CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
  ),
  column_issues AS (
    SELECT pg_catalog.format('column %I.%I has a non-canonical shape', expected.table_name, expected.name) AS issue
    FROM expected_columns AS expected
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND relation.relname OPERATOR(pg_catalog.=) expected.table_name
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      AND attribute.attname OPERATOR(pg_catalog.=) expected.name
      AND attribute.attnum OPERATOR(pg_catalog.>) 0
      AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid OPERATOR(pg_catalog.=) relation.oid
      AND default_value.adnum OPERATOR(pg_catalog.=) attribute.attnum
    WHERE attribute.attrelid IS NULL
      OR pg_catalog.lower(pg_catalog.format_type(attribute.atttypid, attribute.atttypmod))
        OPERATOR(pg_catalog.<>) expected.type
      OR attribute.attnotnull IS DISTINCT FROM expected.not_null
      OR (default_value.oid IS NOT NULL) IS DISTINCT FROM expected.has_default
      OR (attribute.attgenerated OPERATOR(pg_catalog.<>) '') IS DISTINCT FROM expected.generated
  ),
  unexpected_column_issues AS (
    SELECT pg_catalog.format('table %I has unexpected column %I', expected_table.name, attribute.attname) AS issue
    FROM expected_tables AS expected_table
    JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND relation.relname OPERATOR(pg_catalog.=) expected_table.name
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      AND attribute.attnum OPERATOR(pg_catalog.>) 0
      AND NOT attribute.attisdropped
    WHERE NOT EXISTS (
      SELECT 1
      FROM expected_columns AS expected_column
      WHERE expected_column.table_name OPERATOR(pg_catalog.=) expected_table.name
        AND expected_column.name OPERATOR(pg_catalog.=) attribute.attname
    )
  ),
  constraint_issues AS (
    SELECT pg_catalog.format('constraint on %I has a non-canonical shape (%s)', expected.table_name, expected.type) AS issue
    FROM expected_constraints AS expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_constraint AS constraint_row
        ON constraint_row.conrelid OPERATOR(pg_catalog.=) relation.oid
      WHERE relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
        AND relation.relname OPERATOR(pg_catalog.=) expected.table_name
        AND constraint_row.contype::pg_catalog.text OPERATOR(pg_catalog.=) expected.type
        AND (expected.name IS NULL OR constraint_row.conname OPERATOR(pg_catalog.=) expected.name)
        AND (
          expected.type OPERATOR(pg_catalog.<>) 'c'
          OR (constraint_row.convalidated AND NOT constraint_row.connoinherit)
        )
        AND (
          expected.type OPERATOR(pg_catalog.=) 'c'
          OR COALESCE((
            SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
            FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
            JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
              AND attribute.attnum OPERATOR(pg_catalog.=) key_column.attnum
          ), '[]'::pg_catalog.jsonb) OPERATOR(pg_catalog.=) expected.columns
        )
        AND (
          expected.type OPERATOR(pg_catalog.<>) 'f'
          OR (
            (SELECT referenced_relation.relnamespace FROM pg_catalog.pg_class AS referenced_relation
              WHERE referenced_relation.oid OPERATOR(pg_catalog.=) constraint_row.confrelid)
              OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
            AND
            (SELECT referenced_relation.relname FROM pg_catalog.pg_class AS referenced_relation
              WHERE referenced_relation.oid OPERATOR(pg_catalog.=) constraint_row.confrelid)
              OPERATOR(pg_catalog.=) expected.referenced_table
            AND COALESCE((
              SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
              FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid OPERATOR(pg_catalog.=) constraint_row.confrelid
                AND attribute.attnum OPERATOR(pg_catalog.=) key_column.attnum
            ), '[]'::pg_catalog.jsonb) OPERATOR(pg_catalog.=) expected.referenced_columns
            AND constraint_row.confdeltype::pg_catalog.text OPERATOR(pg_catalog.=) expected.on_delete
            AND constraint_row.confupdtype::pg_catalog.text OPERATOR(pg_catalog.=) expected.on_update
          )
        )
    )
  ),
  index_issues AS (
    SELECT pg_catalog.format('index %I has a non-canonical shape', expected.name) AS issue
    FROM expected_indexes AS expected
    LEFT JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND index_relation.relname OPERATOR(pg_catalog.=) expected.name
    LEFT JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid OPERATOR(pg_catalog.=) index_relation.oid
    LEFT JOIN pg_catalog.pg_class AS table_relation
      ON table_relation.oid OPERATOR(pg_catalog.=) index_row.indrelid
    LEFT JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid OPERATOR(pg_catalog.=) index_relation.relam
    WHERE index_relation.oid IS NULL
      OR index_relation.relkind NOT IN ('i', 'I')
      OR index_relation.relowner OPERATOR(pg_catalog.<>) CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
      OR table_relation.relnamespace OPERATOR(pg_catalog.<>) @schemaOid::pg_catalog.oid
      OR table_relation.relname OPERATOR(pg_catalog.<>) expected."tableName"
      OR index_row.indisunique IS DISTINCT FROM expected."unique"
      OR NOT index_row.indisvalid
      OR NOT index_row.indisready
      OR access_method.amname OPERATOR(pg_catalog.<>) expected.method
      OR COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.lower(
            pg_catalog.regexp_replace(
              pg_catalog.regexp_replace(
                pg_catalog.regexp_replace(
                  pg_catalog.replace(
                    pg_catalog.pg_get_indexdef(index_row.indexrelid, key_position, true),
                    '"',
                    ''
                  ),
                  '::(?:pg_catalog\\.)?(?:text|bigint|integer|double precision|boolean|date|timestamp with time zone)',
                  '',
                  'gi'
                ),
                '\\s+(?:ASC|DESC)(?:\\s+NULLS\\s+(?:FIRST|LAST))?$|\\s+NULLS\\s+(?:FIRST|LAST)$',
                '',
                'i'
              ) OPERATOR(pg_catalog.||) CASE (
                COALESCE(index_row.indoption[key_position - 1], 0)::pg_catalog.int4
                  OPERATOR(pg_catalog.&) 3
              )
                WHEN 3 THEN ' desc'
                WHEN 2 THEN ' nulls first'
                WHEN 1 THEN ' desc nulls last'
                ELSE ''
              END,
              '\\s+',
              ' ',
              'g'
            )
          )
          ORDER BY key_position
        )
        FROM pg_catalog.generate_series(1, index_row.indnkeyatts) AS key_position
      ), '[]'::pg_catalog.jsonb) OPERATOR(pg_catalog.<>) expected.keys
      OR (pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false) IS NULL)
        IS DISTINCT FROM (expected.predicate IS NULL)
      OR (
        expected."predicateMode" OPERATOR(pg_catalog.=) 'exact'
        AND COALESCE((
          SELECT pg_catalog.string_agg(
            CASE
              WHEN pg_catalog.left((predicate_token.parts)[1], 1) OPERATOR(pg_catalog.=) ''''
                THEN (predicate_token.parts)[1]
              ELSE pg_catalog.lower(
                pg_catalog.regexp_replace(
                  pg_catalog.regexp_replace(
                    (predicate_token.parts)[1],
                    '::(?:pg_catalog\\.)?(?:text|bigint|integer|double precision|boolean|date|timestamp with time zone)',
                    '',
                    'gi'
                  ),
                  '[\\s()"]',
                  '',
                  'g'
                )
              )
            END,
            '' ORDER BY predicate_token.ordinality
          )
          FROM pg_catalog.regexp_matches(
            COALESCE(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false), ''),
            '(''(?:''''|[^''])*''|[^'']+)',
            'g'
          ) WITH ORDINALITY AS predicate_token(parts, ordinality)
        ), '') OPERATOR(pg_catalog.<>) expected."predicateFingerprint"
      )
      OR (
        expected."predicateMode" OPERATOR(pg_catalog.=) 'membership'
        AND pg_catalog.strpos(
          pg_catalog.lower(COALESCE(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false), '')),
          'any'
        ) OPERATOR(pg_catalog.=) 0
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements_text(expected."predicateTerms") AS predicate_term(term)
        WHERE pg_catalog.strpos(
          pg_catalog.lower(COALESCE(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false), '')),
          pg_catalog.lower(predicate_term.term)
        ) OPERATOR(pg_catalog.=) 0
      )
      OR (
        expected."predicateMode" OPERATOR(pg_catalog.=) 'membership'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.regexp_matches(
            COALESCE(expected.predicate, ''),
            '(''(?:''''|[^''])*'')',
            'g'
          ) AS expected_literal(parts)
          WHERE pg_catalog.strpos(
            COALESCE(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false), ''),
            (expected_literal.parts)[1]
          ) OPERATOR(pg_catalog.=) 0
        )
      )
  )
  SELECT issue FROM relation_issues
  UNION ALL SELECT issue FROM column_issues
  UNION ALL SELECT issue FROM unexpected_column_issues
  UNION ALL SELECT issue FROM constraint_issues
  UNION ALL SELECT issue FROM index_issues
  ORDER BY issue
`;

/**
 * Destructive bootstrap replacement requires a closed owned-object inventory.
 * The steady-state validator intentionally permits additive operator indexes,
 * but an empty compatibility table is about to be dropped here, so any
 * unmodeled constraint, independent index, extended statistics, inheritance,
 * rewrite rule, publication membership, trigger, policy, relation posture, or
 * RLS posture must stop the replacement instead of being silently destroyed.
 * External dependencies remain protected by PostgreSQL's default DROP
 * RESTRICT.
 */
export const POSTGRES_SCHEMA_SHAPE_REPLACEMENT_VALIDATION_SQL = `
  /* goatcitadel_postgres_schema_shape_replacement_validation */
  WITH expected_tables AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset(@tablesJson::pg_catalog.jsonb) AS expected(
      name pg_catalog.text,
      columns pg_catalog.jsonb,
      constraints pg_catalog.jsonb
    )
  ),
  expected_columns AS (
    SELECT
      expected_table.name AS table_name,
      expected_column.name,
      expected_item.ordinality
    FROM expected_tables AS expected_table
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(expected_table.columns) WITH ORDINALITY
      AS expected_item(value, ordinality)
    CROSS JOIN LATERAL pg_catalog.jsonb_to_record(expected_item.value) AS expected_column(
      name pg_catalog.text,
      type pg_catalog.text,
      "notNull" pg_catalog.bool,
      "hasDefault" pg_catalog.bool,
      generated pg_catalog.bool
    )
  ),
  expected_constraints AS (
    SELECT
      expected_table.name AS table_name,
      expected_constraint.name,
      expected_constraint.type,
      expected_constraint.columns,
      expected_constraint."referencedTable" AS referenced_table,
      expected_constraint."referencedColumns" AS referenced_columns,
      expected_constraint."onDelete" AS on_delete,
      expected_constraint."onUpdate" AS on_update
    FROM expected_tables AS expected_table
    CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(expected_table.constraints) AS expected_constraint(
      name pg_catalog.text,
      type pg_catalog.text,
      columns pg_catalog.jsonb,
      "referencedTable" pg_catalog.text,
      "referencedColumns" pg_catalog.jsonb,
      "onDelete" pg_catalog.text,
      "onUpdate" pg_catalog.text
    )
  ),
  expected_indexes AS (
    SELECT *
    FROM pg_catalog.jsonb_to_recordset(@indexesJson::pg_catalog.jsonb) AS expected(
      name pg_catalog.text,
      "tableName" pg_catalog.text,
      "unique" pg_catalog.bool,
      method pg_catalog.text,
      keys pg_catalog.jsonb,
      predicate pg_catalog.text,
      "predicateTerms" pg_catalog.jsonb,
      "predicateMode" pg_catalog.text,
      "predicateFingerprint" pg_catalog.text
    )
  ),
  target_relations AS (
    SELECT
      relation.oid,
      relation.relname,
      relation.relkind,
      relation.relpersistence,
      relation.relreplident,
      relation.relispartition,
      relation.reltablespace,
      relation.reloptions,
      relation.relacl,
      relation.relowner,
      relation.reltype,
      relation.reltoastrelid,
      relation.relam,
      relation.reloftype,
      relation.relrowsecurity,
      relation.relforcerowsecurity
    FROM expected_tables AS expected
    JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
      AND relation.relname OPERATOR(pg_catalog.=) expected.name
  ),
  unexpected_column_posture_issues AS (
    SELECT pg_catalog.format('column %I.%I has unexpected physical posture', relation.relname, attribute.attname)
      AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      AND attribute.attnum OPERATOR(pg_catalog.>) 0
      AND NOT attribute.attisdropped
    JOIN pg_catalog.pg_type AS column_type
      ON column_type.oid OPERATOR(pg_catalog.=) attribute.atttypid
    LEFT JOIN expected_columns AS expected_column
      ON expected_column.table_name OPERATOR(pg_catalog.=) relation.relname
      AND expected_column.name OPERATOR(pg_catalog.=) attribute.attname
    WHERE expected_column.ordinality IS NULL
      OR attribute.attnum OPERATOR(pg_catalog.<>) expected_column.ordinality
      OR NOT attribute.attislocal
      OR attribute.attinhcount OPERATOR(pg_catalog.<>) 0
      OR attribute.attstattarget OPERATOR(pg_catalog.<>) -1
      OR attribute.attstorage OPERATOR(pg_catalog.<>) column_type.typstorage
      OR attribute.attcompression OPERATOR(pg_catalog.<>) ''
      OR attribute.attacl IS NOT NULL
      OR attribute.attoptions IS NOT NULL
      OR attribute.attfdwoptions IS NOT NULL
      OR attribute.atthasmissing
      OR attribute.attmissingval IS NOT NULL
      OR attribute.attidentity OPERATOR(pg_catalog.<>) ''
      OR attribute.attcollation IS DISTINCT FROM column_type.typcollation
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_description AS description
        WHERE description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
          AND description.objoid OPERATOR(pg_catalog.=) relation.oid
          AND description.objsubid OPERATOR(pg_catalog.=) attribute.attnum
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
          AND security_label.objoid OPERATOR(pg_catalog.=) relation.oid
          AND security_label.objsubid OPERATOR(pg_catalog.=) attribute.attnum
      )
  ),
  unexpected_dropped_column_issues AS (
    SELECT pg_catalog.format(
      'table %I has dropped-column catalog residue at attribute %s',
      relation.relname,
      attribute.attnum
    ) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      AND attribute.attnum OPERATOR(pg_catalog.>) 0
      AND attribute.attisdropped
  ),
  actual_constraints AS (
    SELECT
      relation.relname AS table_name,
      constraint_row.oid AS constraint_oid,
      constraint_row.conname AS name,
      constraint_row.contype::pg_catalog.text AS type,
      COALESCE((
        SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
          AND attribute.attnum OPERATOR(pg_catalog.=) key_column.attnum
      ), '[]'::pg_catalog.jsonb) AS columns,
      referenced_relation.relname AS referenced_table,
      referenced_relation.relnamespace AS referenced_schema_oid,
      COALESCE((
        SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid OPERATOR(pg_catalog.=) constraint_row.confrelid
          AND attribute.attnum OPERATOR(pg_catalog.=) key_column.attnum
      ), '[]'::pg_catalog.jsonb) AS referenced_columns,
      constraint_row.confdeltype::pg_catalog.text AS on_delete,
      constraint_row.confupdtype::pg_catalog.text AS on_update,
      backing_index.relname AS backing_index_name,
      (
        constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
        AND constraint_row.conislocal
        AND constraint_row.coninhcount OPERATOR(pg_catalog.=) 0
        AND constraint_row.connoinherit OPERATOR(pg_catalog.=) (constraint_row.contype OPERATOR(pg_catalog.<>) 'c')
        AND (
          constraint_row.contype OPERATOR(pg_catalog.<>) 'f'
          OR constraint_row.confmatchtype OPERATOR(pg_catalog.=) 's'
        )
        AND (
          constraint_row.contype NOT IN ('p', 'u')
          OR NOT COALESCE(backing_index_shape.indnullsnotdistinct, false)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_description AS description
          WHERE description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_constraint'::pg_catalog.regclass
            AND description.objoid OPERATOR(pg_catalog.=) constraint_row.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_seclabel AS security_label
          WHERE security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_constraint'::pg_catalog.regclass
            AND security_label.objoid OPERATOR(pg_catalog.=) constraint_row.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_constraint'::pg_catalog.regclass
            AND dependency.objid OPERATOR(pg_catalog.=) constraint_row.oid
            AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
        )
        AND (
          constraint_row.contype OPERATOR(pg_catalog.<>) 'f'
          OR (
            (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS trigger_row
              WHERE trigger_row.tgconstraint OPERATOR(pg_catalog.=) constraint_row.oid)
              OPERATOR(pg_catalog.=) 4
            AND NOT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_trigger AS trigger_row
              WHERE trigger_row.tgconstraint OPERATOR(pg_catalog.=) constraint_row.oid
                AND (
                  trigger_row.tgname IS DISTINCT FROM pg_catalog.format(
                    'RI_ConstraintTrigger_%s_%s',
                    CASE
                      WHEN (
                        SELECT trigger_function.proname
                        FROM pg_catalog.pg_proc AS trigger_function
                        WHERE trigger_function.oid OPERATOR(pg_catalog.=) trigger_row.tgfoid
                      ) LIKE 'RI_FKey_check_%' THEN 'c'
                      WHEN (
                        SELECT trigger_function.proname
                        FROM pg_catalog.pg_proc AS trigger_function
                        WHERE trigger_function.oid OPERATOR(pg_catalog.=) trigger_row.tgfoid
                      ) LIKE 'RI_FKey_%' THEN 'a'
                      ELSE '?'
                    END,
                    trigger_row.oid
                  )
                  OR trigger_row.tgenabled OPERATOR(pg_catalog.<>) 'O'
                  OR EXISTS (
                    SELECT 1 FROM pg_catalog.pg_description AS description
                    WHERE description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_trigger'::pg_catalog.regclass
                      AND description.objoid OPERATOR(pg_catalog.=) trigger_row.oid
                  )
                  OR EXISTS (
                    SELECT 1 FROM pg_catalog.pg_seclabel AS security_label
                    WHERE security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_trigger'::pg_catalog.regclass
                      AND security_label.objoid OPERATOR(pg_catalog.=) trigger_row.oid
                  )
                )
            )
          )
        )
      ) AS canonical_posture
    FROM target_relations AS relation
    JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid OPERATOR(pg_catalog.=) relation.oid
    LEFT JOIN pg_catalog.pg_class AS referenced_relation
      ON referenced_relation.oid OPERATOR(pg_catalog.=) constraint_row.confrelid
    LEFT JOIN pg_catalog.pg_class AS backing_index
      ON backing_index.oid OPERATOR(pg_catalog.=) constraint_row.conindid
    LEFT JOIN pg_catalog.pg_index AS backing_index_shape
      ON backing_index_shape.indexrelid OPERATOR(pg_catalog.=) constraint_row.conindid
  ),
  constraint_multiplicity_issues AS (
    SELECT pg_catalog.format(
      'constraint on %I has a non-canonical multiplicity (%s)',
      expected.table_name,
      expected.type
    ) AS issue
    FROM expected_constraints AS expected
    WHERE (
      SELECT pg_catalog.count(*)
      FROM actual_constraints AS actual
      WHERE actual.table_name OPERATOR(pg_catalog.=) expected.table_name
        AND actual.type OPERATOR(pg_catalog.=) expected.type
        AND actual.canonical_posture
        AND (expected.name IS NULL OR actual.name OPERATOR(pg_catalog.=) expected.name)
        AND (expected.type OPERATOR(pg_catalog.=) 'c' OR actual.columns OPERATOR(pg_catalog.=) expected.columns)
        AND (
          expected.type OPERATOR(pg_catalog.<>) 'f'
          OR (
            actual.referenced_schema_oid OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
            AND actual.referenced_table OPERATOR(pg_catalog.=) expected.referenced_table
            AND actual.referenced_columns OPERATOR(pg_catalog.=) expected.referenced_columns
            AND actual.on_delete OPERATOR(pg_catalog.=) expected.on_delete
            AND actual.on_update OPERATOR(pg_catalog.=) expected.on_update
          )
        )
    ) OPERATOR(pg_catalog.<>) 1
  ),
  unexpected_constraint_issues AS (
    SELECT pg_catalog.format('table %I has unexpected constraint %I', actual.table_name, actual.name) AS issue
    FROM actual_constraints AS actual
    WHERE NOT EXISTS (
      SELECT 1
      FROM expected_constraints AS expected
      WHERE actual.table_name OPERATOR(pg_catalog.=) expected.table_name
        AND actual.type OPERATOR(pg_catalog.=) expected.type
        AND actual.canonical_posture
        AND (expected.name IS NULL OR actual.name OPERATOR(pg_catalog.=) expected.name)
        AND (expected.type OPERATOR(pg_catalog.=) 'c' OR actual.columns OPERATOR(pg_catalog.=) expected.columns)
        AND (
          expected.type OPERATOR(pg_catalog.<>) 'f'
          OR (
            actual.referenced_schema_oid OPERATOR(pg_catalog.=) @schemaOid::pg_catalog.oid
            AND actual.referenced_table OPERATOR(pg_catalog.=) expected.referenced_table
            AND actual.referenced_columns OPERATOR(pg_catalog.=) expected.referenced_columns
            AND actual.on_delete OPERATOR(pg_catalog.=) expected.on_delete
            AND actual.on_update OPERATOR(pg_catalog.=) expected.on_update
          )
        )
    )
      AND NOT (
        actual.type OPERATOR(pg_catalog.=) 'u'
        AND actual.canonical_posture
        AND EXISTS (
          SELECT 1
          FROM expected_indexes AS expected_index
          WHERE expected_index."tableName" OPERATOR(pg_catalog.=) actual.table_name
            AND expected_index."unique"
            AND expected_index.name OPERATOR(pg_catalog.=) actual.backing_index_name
        )
      )
  ),
  unexpected_index_issues AS (
    SELECT pg_catalog.format('table %I has unexpected index %I', relation.relname, index_relation.relname) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indrelid OPERATOR(pg_catalog.=) relation.oid
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid OPERATOR(pg_catalog.=) index_row.indexrelid
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conindid OPERATOR(pg_catalog.=) index_relation.oid
    )
      AND NOT EXISTS (
        SELECT 1 FROM expected_indexes AS expected
        WHERE expected."tableName" OPERATOR(pg_catalog.=) relation.relname
          AND expected.name OPERATOR(pg_catalog.=) index_relation.relname
      )
  ),
  unexpected_index_posture_issues AS (
    SELECT pg_catalog.format('table %I has index %I with unexpected posture', relation.relname, index_relation.relname)
      AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indrelid OPERATOR(pg_catalog.=) relation.oid
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid OPERATOR(pg_catalog.=) index_row.indexrelid
    WHERE index_relation.relkind OPERATOR(pg_catalog.<>) 'i'
      OR index_relation.relpersistence OPERATOR(pg_catalog.<>) 'p'
      OR index_relation.relispartition
      OR index_relation.reltablespace OPERATOR(pg_catalog.<>) 0
      OR index_relation.reloptions IS NOT NULL
      OR index_relation.relacl IS NOT NULL
      OR index_relation.relowner OPERATOR(pg_catalog.<>) CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
      OR NOT index_row.indisvalid
      OR index_row.indcheckxmin
      OR NOT index_row.indisready
      OR NOT index_row.indislive
      OR NOT index_row.indimmediate
      OR index_row.indnatts OPERATOR(pg_catalog.<>) index_row.indnkeyatts
      OR index_row.indisclustered
      OR index_row.indisreplident
      OR index_row.indisexclusion
      OR index_row.indnullsnotdistinct
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_description AS description
        WHERE description.objoid OPERATOR(pg_catalog.=) index_relation.oid
          AND description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.objoid OPERATOR(pg_catalog.=) index_relation.oid
          AND security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency.objid OPERATOR(pg_catalog.=) index_relation.oid
          AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
      )
  ),
  unexpected_statistics_issues AS (
    SELECT pg_catalog.format('table %I has unexpected extended statistics %I', relation.relname, statistics.stxname) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_statistic_ext AS statistics
      ON statistics.stxrelid OPERATOR(pg_catalog.=) relation.oid
  ),
  unexpected_owned_sequence_issues AS (
    SELECT pg_catalog.format(
      'table %I column %I has unexpected owned sequence %I',
      relation.relname,
      attribute.attname,
      owned_sequence.relname
    ) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
      AND attribute.attnum OPERATOR(pg_catalog.>) 0
      AND NOT attribute.attisdropped
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.refclassid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.refobjid OPERATOR(pg_catalog.=) relation.oid
      AND dependency.refobjsubid OPERATOR(pg_catalog.=) attribute.attnum
      AND dependency.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class AS owned_sequence
      ON owned_sequence.oid OPERATOR(pg_catalog.=) dependency.objid
      AND owned_sequence.relkind OPERATOR(pg_catalog.=) 'S'
  ),
  unexpected_inheritance_issues AS (
    SELECT pg_catalog.format(
      'table %I has unexpected inheritance relation with %I',
      relation.relname,
      related_relation.relname
    ) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhrelid OPERATOR(pg_catalog.=) relation.oid
      OR inheritance.inhparent OPERATOR(pg_catalog.=) relation.oid
    JOIN pg_catalog.pg_class AS related_relation
      ON related_relation.oid OPERATOR(pg_catalog.=) CASE
        WHEN inheritance.inhrelid OPERATOR(pg_catalog.=) relation.oid THEN inheritance.inhparent
        ELSE inheritance.inhrelid
      END
  ),
  unexpected_rule_issues AS (
    SELECT pg_catalog.format('table %I has unexpected rewrite rule %I', relation.relname, rewrite_rule.rulename) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_rewrite AS rewrite_rule
      ON rewrite_rule.ev_class OPERATOR(pg_catalog.=) relation.oid
  ),
  unexpected_publication_issues AS (
    SELECT pg_catalog.format(
      'table %I has unexpected publication membership in %I',
      relation.relname,
      publication.pubname
    ) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_publication_rel AS membership
      ON membership.prrelid OPERATOR(pg_catalog.=) relation.oid
    JOIN pg_catalog.pg_publication AS publication
      ON publication.oid OPERATOR(pg_catalog.=) membership.prpubid
  ),
  unexpected_trigger_issues AS (
    SELECT pg_catalog.format('table %I has unexpected trigger %I', relation.relname, trigger_row.tgname) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid OPERATOR(pg_catalog.=) relation.oid
      AND NOT trigger_row.tgisinternal
  ),
  unexpected_policy_issues AS (
    SELECT pg_catalog.format('table %I has unexpected row-security policy %I', relation.relname, policy.polname) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_policy AS policy
      ON policy.polrelid OPERATOR(pg_catalog.=) relation.oid
    UNION ALL
    SELECT pg_catalog.format('table %I has unexpected row-security posture', relation.relname) AS issue
    FROM target_relations AS relation
    WHERE relation.relrowsecurity OR relation.relforcerowsecurity
  ),
  unexpected_relation_posture_issues AS (
    SELECT pg_catalog.format('table %I has unexpected relation posture', relation.relname) AS issue
    FROM target_relations AS relation
    WHERE relation.relkind OPERATOR(pg_catalog.<>) 'r'
      OR relation.relpersistence OPERATOR(pg_catalog.<>) 'p'
      OR relation.relreplident OPERATOR(pg_catalog.<>) 'd'
      OR relation.relispartition
      OR relation.relam IS DISTINCT FROM (
        SELECT access_method.oid
        FROM pg_catalog.pg_am AS access_method
        WHERE access_method.amname OPERATOR(pg_catalog.=) 'heap'
          AND access_method.amtype OPERATOR(pg_catalog.=) 't'
      )
      OR relation.reloftype OPERATOR(pg_catalog.<>) 0
      OR relation.reltablespace OPERATOR(pg_catalog.<>) 0
      OR relation.reloptions IS NOT NULL
      OR relation.relacl IS NOT NULL
      OR relation.relowner OPERATOR(pg_catalog.<>) CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_description AS description
        WHERE description.objoid OPERATOR(pg_catalog.=) relation.oid
          AND description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.objoid OPERATOR(pg_catalog.=) relation.oid
          AND security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_description AS description
        WHERE description.objoid IN (
            relation.reltype,
            (SELECT row_type.typarray FROM pg_catalog.pg_type AS row_type WHERE row_type.oid = relation.reltype)
          )
          AND description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_type'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.objoid IN (
            relation.reltype,
            (SELECT row_type.typarray FROM pg_catalog.pg_type AS row_type WHERE row_type.oid = relation.reltype)
          )
          AND security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_type'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_type AS row_type
        WHERE row_type.oid OPERATOR(pg_catalog.=) relation.reltype
          AND row_type.typacl IS NOT NULL
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
          AND attribute.attnum OPERATOR(pg_catalog.>) 0
          AND NOT attribute.attisdropped
          AND (attribute.attacl IS NOT NULL OR attribute.attoptions IS NOT NULL)
      )
  ),
  unexpected_toast_posture_issues AS (
    SELECT pg_catalog.format('table %I has unexpected TOAST posture', relation.relname) AS issue
    FROM target_relations AS relation
    JOIN pg_catalog.pg_class AS toast_relation
      ON toast_relation.oid OPERATOR(pg_catalog.=) relation.reltoastrelid
    WHERE toast_relation.relkind OPERATOR(pg_catalog.<>) 't'
      OR toast_relation.relpersistence OPERATOR(pg_catalog.<>) 'p'
      OR toast_relation.reltablespace OPERATOR(pg_catalog.<>) 0
      OR toast_relation.reloptions IS NOT NULL
      OR toast_relation.relacl IS NOT NULL
      OR toast_relation.relowner OPERATOR(pg_catalog.<>) CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_description AS description
        WHERE description.objoid OPERATOR(pg_catalog.=) toast_relation.oid
          AND description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.objoid OPERATOR(pg_catalog.=) toast_relation.oid
          AND security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency.objid OPERATOR(pg_catalog.=) toast_relation.oid
          AND dependency.deptype OPERATOR(pg_catalog.=) 'e'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index AS toast_index
        JOIN pg_catalog.pg_class AS index_relation
          ON index_relation.oid OPERATOR(pg_catalog.=) toast_index.indexrelid
        WHERE toast_index.indrelid OPERATOR(pg_catalog.=) toast_relation.oid
          AND (
            index_relation.relkind OPERATOR(pg_catalog.<>) 'i'
            OR index_relation.relpersistence OPERATOR(pg_catalog.<>) 'p'
            OR index_relation.reltablespace OPERATOR(pg_catalog.<>) 0
            OR index_relation.reloptions IS NOT NULL
            OR index_relation.relacl IS NOT NULL
            OR index_relation.relowner OPERATOR(pg_catalog.<>) CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
            OR NOT toast_index.indisvalid
            OR NOT toast_index.indisready
            OR NOT toast_index.indislive
            OR toast_index.indisclustered
            OR toast_index.indisreplident
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_description AS description
              WHERE description.objoid OPERATOR(pg_catalog.=) index_relation.oid
                AND description.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
            )
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_seclabel AS security_label
              WHERE security_label.objoid OPERATOR(pg_catalog.=) index_relation.oid
                AND security_label.classoid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass
            )
          )
      )
  )
  SELECT issue FROM constraint_multiplicity_issues
  UNION ALL SELECT issue FROM unexpected_column_posture_issues
  UNION ALL SELECT issue FROM unexpected_dropped_column_issues
  UNION ALL SELECT issue FROM unexpected_constraint_issues
  UNION ALL SELECT issue FROM unexpected_index_issues
  UNION ALL SELECT issue FROM unexpected_index_posture_issues
  UNION ALL SELECT issue FROM unexpected_statistics_issues
  UNION ALL SELECT issue FROM unexpected_owned_sequence_issues
  UNION ALL SELECT issue FROM unexpected_inheritance_issues
  UNION ALL SELECT issue FROM unexpected_rule_issues
  UNION ALL SELECT issue FROM unexpected_publication_issues
  UNION ALL SELECT issue FROM unexpected_trigger_issues
  UNION ALL SELECT issue FROM unexpected_policy_issues
  UNION ALL SELECT issue FROM unexpected_relation_posture_issues
  UNION ALL SELECT issue FROM unexpected_toast_posture_issues
  ORDER BY issue
`;

export function buildPostgresSchemaShapeValidationSql(
  tablesPlaceholder: string,
  indexesPlaceholder: string,
  schemaOidPlaceholder: string,
): string {
  return POSTGRES_SCHEMA_SHAPE_VALIDATION_SQL.replaceAll("@tablesJson", tablesPlaceholder)
    .replaceAll("@indexesJson", indexesPlaceholder)
    .replaceAll("@schemaOid", schemaOidPlaceholder);
}

export function buildPostgresSchemaShapeReplacementValidationSql(
  tablesPlaceholder: string,
  indexesPlaceholder: string,
  schemaOidPlaceholder: string,
): string {
  return POSTGRES_SCHEMA_SHAPE_REPLACEMENT_VALIDATION_SQL.replaceAll("@tablesJson", tablesPlaceholder)
    .replaceAll("@indexesJson", indexesPlaceholder)
    .replaceAll("@schemaOid", schemaOidPlaceholder);
}

const manifestCache = new WeakMap<readonly PostgresMigration[], PostgresSchemaShapeManifest>();

export function buildPostgresSchemaShapeManifest(
  migrations: readonly PostgresMigration[],
): PostgresSchemaShapeManifest {
  const cached = manifestCache.get(migrations);
  if (cached) return cached;

  const tables = new Map<string, MutableTable>();
  const indexes = new Map<string, PostgresSchemaShapeIndex>();
  for (const migration of migrations) {
    collectSchemaShapeOperations(migration.sql, tables, indexes);
  }

  const manifest: PostgresSchemaShapeManifest = {
    tables: [...tables.values()]
      .map((table) => ({
        name: table.name,
        columns: [...table.columns.values()],
        // The live v2 renderer names SQLite-derived UNIQUE constraints after
        // their backing indexes, while older additive lineages can own the
        // same canonical unique index without a pg_constraint row. The named
        // index signature below is the cross-lineage authority for those.
        constraints: [...table.constraints.values()].filter(
          (constraint) => constraint.type !== "u" || constraint.name === null,
        ),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    indexes: [...indexes.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
  manifestCache.set(migrations, manifest);
  return manifest;
}

export function buildPostgresSchemaShapeRelationLockSql(
  migrationSchema: PostgresMigrationSchemaIdentity,
  manifest: PostgresSchemaShapeManifest,
): string {
  if (manifest.tables.length === 0) return "";
  const schema = quotePostgresIdentifier(migrationSchema.name);
  const relations = manifest.tables.map((table) => `${schema}.${quotePostgresIdentifier(table.name)}`).join(", ");
  return `LOCK TABLE ${relations} IN ACCESS SHARE MODE`;
}

export function buildPostgresSchemaShapeReplacementLockSql(
  migrationSchema: PostgresMigrationSchemaIdentity,
  manifest: PostgresSchemaShapeManifest,
): string {
  if (manifest.tables.length === 0) return "";
  const schema = quotePostgresIdentifier(migrationSchema.name);
  const relations = [
    ...new Set([
      ...manifest.tables.map((table) => table.name),
      ...manifest.tables.flatMap((table) =>
        table.constraints.flatMap((constraint) =>
          constraint.type === "f" && constraint.referencedTable ? [constraint.referencedTable] : [],
        ),
      ),
    ]),
  ]
    .sort()
    .map((tableName) => `${schema}.${quotePostgresIdentifier(tableName)}`)
    .join(", ");
  return `LOCK TABLE ${relations} IN ACCESS EXCLUSIVE MODE`;
}

export function assertPostgresSchemaShapeIssues(rows: readonly PostgresSchemaShapeIssueRow[]): void {
  const issues = rows
    .map((row) => (typeof row.issue === "string" ? row.issue.trim() : ""))
    .filter((issue) => issue.length > 0);
  if (issues.length > 0) {
    throw new Error(`Postgres canonical schema-shape validation failed: ${issues.join("; ")}.`);
  }
}

interface MutableTable {
  name: string;
  columns: Map<string, PostgresSchemaShapeColumn>;
  constraints: Map<string, PostgresSchemaShapeConstraint>;
}

interface QueuedSchemaShapeOperation {
  offset: number;
  order: number;
  apply: () => void;
}

const POSTGRES_IDENTIFIER_SOURCE = String.raw`(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)`;
const POSTGRES_QUALIFIED_IDENTIFIER_SOURCE = String.raw`${POSTGRES_IDENTIFIER_SOURCE}(?:\s*\.\s*${POSTGRES_IDENTIFIER_SOURCE})?`;

function collectSchemaShapeOperations(
  sql: string,
  tables: Map<string, MutableTable>,
  indexes: Map<string, PostgresSchemaShapeIndex>,
): void {
  const operations: QueuedSchemaShapeOperation[] = [];
  queueDroppedTables(sql, tables, indexes, operations);
  queueCreateTables(sql, tables, operations);
  queueAlterTables(sql, tables, operations);
  queueDroppedIndexes(sql, indexes, operations);
  queueCreateIndexes(sql, indexes, operations);
  operations.sort((left, right) => left.offset - right.offset || left.order - right.order);
  for (const operation of operations) operation.apply();
}

function queueDroppedTables(
  sql: string,
  tables: Map<string, MutableTable>,
  indexes: Map<string, PostgresSchemaShapeIndex>,
  operations: QueuedSchemaShapeOperation[],
): void {
  const pattern = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/gi;
  for (const match of sql.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const end = findStatementEnd(sql, match.index + match[0].length);
    const body = sql.slice(match.index + match[0].length, end).replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, "");
    const tableNames = splitTopLevel(body, ",")
      .map((rawName) => normalizeIdentifier(lastQualifiedIdentifier(rawName.replace(/\s*\*\s*$/u, ""))))
      .filter(isCanonicalIdentifier);
    operations.push({
      offset: match.index,
      order: 0,
      apply: () => {
        for (const tableName of tableNames) {
          tables.delete(tableName);
          for (const [indexName, index] of indexes) {
            if (index.tableName === tableName) indexes.delete(indexName);
          }
        }
      },
    });
  }
}

function queueCreateTables(
  sql: string,
  tables: Map<string, MutableTable>,
  operations: QueuedSchemaShapeOperation[],
): void {
  const pattern = new RegExp(
    String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${POSTGRES_QUALIFIED_IDENTIFIER_SOURCE})`,
    "gi",
  );
  for (const match of sql.matchAll(pattern)) {
    const rawName = match[1];
    if (!rawName || match.index === undefined) continue;
    const open = skipWhitespace(sql, match.index + match[0].length);
    if (sql[open] !== "(") continue;
    const balanced = readBalanced(sql, open);
    if (!balanced) continue;
    const tableName = normalizeIdentifier(lastQualifiedIdentifier(rawName));
    if (!isCanonicalIdentifier(tableName)) continue;
    operations.push({
      offset: match.index,
      order: 1,
      apply: () => {
        // PostgreSQL's IF NOT EXISTS is first-wins. An ordinary CREATE that
        // reaches an existing relation would abort, so it must not mutate an
        // already-established manifest shape either.
        if (tables.has(tableName)) return;
        const table = { name: tableName, columns: new Map(), constraints: new Map() } satisfies MutableTable;
        for (const definition of splitTopLevel(balanced.content, ",")) {
          const column = parseColumnDefinition(definition);
          if (column) {
            if (!table.columns.has(column.name)) table.columns.set(column.name, column);
            for (const constraint of parseInlineColumnConstraints(definition, tableName, column.name)) {
              addConstraintFirstWins(table, constraint);
            }
            continue;
          }
          const constraint = parseTableConstraint(definition, tableName);
          if (constraint) addConstraintFirstWins(table, constraint);
        }
        applyPrimaryKeyNotNull(table);
        tables.set(tableName, table);
      },
    });
  }
}

function queueAlterTables(
  sql: string,
  tables: Map<string, MutableTable>,
  operations: QueuedSchemaShapeOperation[],
): void {
  const pattern = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${POSTGRES_QUALIFIED_IDENTIFIER_SOURCE})`,
    "gi",
  );
  for (const match of sql.matchAll(pattern)) {
    const rawName = match[1];
    if (!rawName || match.index === undefined) continue;
    const tableName = normalizeIdentifier(lastQualifiedIdentifier(rawName));
    if (!isCanonicalIdentifier(tableName)) continue;
    const end = findStatementEnd(sql, match.index + match[0].length);
    const body = sql.slice(match.index + match[0].length, end);
    operations.push({
      offset: match.index,
      order: 2,
      apply: () => {
        const table = tables.get(tableName);
        if (!table) return;
        for (const clause of splitTopLevel(body, ",")) applyAlterTableClause(clause, table);
      },
    });
  }
}

function applyAlterTableClause(clause: string, table: MutableTable): void {
  const dropConstraint = new RegExp(
    String.raw`^\s*DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${POSTGRES_IDENTIFIER_SOURCE})(?=\s|$)`,
    "i",
  ).exec(clause);
  if (dropConstraint?.[1]) {
    const constraintName = truncatePostgresIdentifier(normalizeIdentifier(dropConstraint[1]));
    for (const [key, constraint] of table.constraints) {
      if (constraint.name === constraintName) table.constraints.delete(key);
    }
    return;
  }

  const dropColumn = new RegExp(
    String.raw`^\s*DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${POSTGRES_IDENTIFIER_SOURCE})(?=\s|$)`,
    "i",
  ).exec(clause);
  if (dropColumn?.[1]) {
    const columnName = normalizeIdentifier(dropColumn[1]);
    table.columns.delete(columnName);
    for (const [key, constraint] of table.constraints) {
      if (constraint.columns.includes(columnName)) table.constraints.delete(key);
    }
    return;
  }

  const addConstraint = new RegExp(
    String.raw`^\s*ADD\s+CONSTRAINT\s+(${POSTGRES_IDENTIFIER_SOURCE})\s+([\s\S]+)$`,
    "i",
  ).exec(clause);
  if (addConstraint?.[1] && addConstraint[2]) {
    const constraint = parseTableConstraint(`CONSTRAINT ${addConstraint[1]} ${addConstraint[2]}`, table.name);
    if (constraint) {
      addConstraintFirstWins(table, constraint);
      applyPrimaryKeyNotNull(table);
    }
    return;
  }

  const alterNotNull = new RegExp(
    String.raw`^\s*ALTER\s+(?:COLUMN\s+)?(${POSTGRES_IDENTIFIER_SOURCE})\s+(SET|DROP)\s+NOT\s+NULL\b`,
    "i",
  ).exec(clause);
  if (alterNotNull?.[1] && alterNotNull[2]) {
    const columnName = normalizeIdentifier(alterNotNull[1]);
    const column = table.columns.get(columnName);
    if (column) table.columns.set(columnName, { ...column, notNull: /^SET$/i.test(alterNotNull[2]) });
    return;
  }

  const addColumn = new RegExp(
    String.raw`^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${POSTGRES_IDENTIFIER_SOURCE})\s+([\s\S]+)$`,
    "i",
  ).exec(clause);
  if (!addColumn?.[1] || !addColumn[2]) return;
  const column = parseColumnDefinition(`${addColumn[1]} ${addColumn[2]}`);
  if (!column || table.columns.has(column.name)) return;
  table.columns.set(column.name, column);
  for (const constraint of parseInlineColumnConstraints(clause, table.name, column.name)) {
    addConstraintFirstWins(table, constraint);
  }
  applyPrimaryKeyNotNull(table);
}

function queueDroppedIndexes(
  sql: string,
  indexes: Map<string, PostgresSchemaShapeIndex>,
  operations: QueuedSchemaShapeOperation[],
): void {
  const pattern = /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?/gi;
  for (const match of sql.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const end = findStatementEnd(sql, match.index + match[0].length);
    const body = sql.slice(match.index + match[0].length, end).replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, "");
    const indexNames = splitTopLevel(body, ",")
      .map((rawName) => truncatePostgresIdentifier(normalizeIdentifier(lastQualifiedIdentifier(rawName))))
      .filter(isCanonicalIdentifier);
    operations.push({
      offset: match.index,
      order: 3,
      apply: () => {
        for (const indexName of indexNames) indexes.delete(indexName);
      },
    });
  }
}

function queueCreateIndexes(
  sql: string,
  indexes: Map<string, PostgresSchemaShapeIndex>,
  operations: QueuedSchemaShapeOperation[],
): void {
  const pattern = new RegExp(
    String.raw`\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${POSTGRES_QUALIFIED_IDENTIFIER_SOURCE})\s+ON\s+(?:ONLY\s+)?(${POSTGRES_QUALIFIED_IDENTIFIER_SOURCE})`,
    "gi",
  );
  for (const match of sql.matchAll(pattern)) {
    if (match.index === undefined || !match[2] || !match[3]) continue;
    const indexName = truncatePostgresIdentifier(normalizeIdentifier(lastQualifiedIdentifier(match[2])));
    const tableName = normalizeIdentifier(lastQualifiedIdentifier(match[3]));
    if (!isCanonicalIdentifier(indexName) || !isCanonicalIdentifier(tableName)) continue;
    let cursor = skipWhitespace(sql, match.index + match[0].length);
    let method = "btree";
    const methodMatch = /^USING\s+([a-zA-Z_][a-zA-Z0-9_$]*)/i.exec(sql.slice(cursor));
    if (methodMatch?.[1]) {
      method = methodMatch[1].toLowerCase();
      cursor = skipWhitespace(sql, cursor + methodMatch[0].length);
    }
    if (sql[cursor] !== "(") continue;
    const balanced = readBalanced(sql, cursor);
    if (!balanced) continue;
    const end = findStatementEnd(sql, balanced.end + 1);
    const tail = sql.slice(balanced.end + 1, end);
    const predicateMatch = /\bWHERE\s+([\s\S]+)$/i.exec(tail);
    const predicate = predicateMatch?.[1]?.trim().replace(/\s+END\s+IF\s*$/i, "") ?? null;
    const predicateMode = predicate ? (/\bIN\s*\(/i.test(predicate) ? "membership" : "exact") : "none";
    const index: PostgresSchemaShapeIndex = {
      name: indexName,
      tableName,
      unique: Boolean(match[1]),
      method,
      keys: splitTopLevel(balanced.content, ",").map(normalizeIndexKey),
      predicate,
      predicateTerms: predicate ? extractPredicateTerms(predicate) : [],
      predicateMode,
      predicateFingerprint:
        predicate !== null && predicateMode === "exact" ? normalizePredicateFingerprint(predicate) : null,
    };
    operations.push({
      offset: match.index,
      order: 4,
      apply: () => {
        if (!indexes.has(indexName)) indexes.set(indexName, index);
      },
    });
  }
}

function addConstraintFirstWins(table: MutableTable, constraint: PostgresSchemaShapeConstraint): void {
  if (
    constraint.name !== null &&
    [...table.constraints.values()].some((existing) => existing.name === constraint.name)
  ) {
    return;
  }
  const key = constraintKey(constraint);
  if (!table.constraints.has(key)) table.constraints.set(key, constraint);
}

function applyPrimaryKeyNotNull(table: MutableTable): void {
  for (const constraint of table.constraints.values()) {
    if (constraint.type !== "p") continue;
    for (const columnName of constraint.columns) {
      const column = table.columns.get(columnName);
      if (column) table.columns.set(columnName, { ...column, notNull: true });
    }
  }
}

function parseColumnDefinition(definition: string): PostgresSchemaShapeColumn | undefined {
  const trimmed = definition.trim();
  if (/^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|CHECK\b)/i.test(trimmed)) return undefined;
  const match = /^("(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)\s+([\s\S]+)$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return undefined;
  const name = normalizeIdentifier(match[1]);
  const remainder = match[2];
  const typeEnd = findColumnTypeEnd(remainder);
  const rawType = remainder.slice(0, typeEnd).trim();
  if (!rawType) return undefined;
  const modifiers = remainder.slice(typeEnd);
  const primaryKey = hasTopLevelMatch(modifiers, /\bPRIMARY\s+KEY\b/i);
  const generated = hasTopLevelMatch(modifiers, /\bGENERATED\s+ALWAYS\s+AS\b/i);
  return {
    name,
    type: normalizePostgresType(rawType),
    notNull: primaryKey || hasTopLevelMatch(modifiers, /\bNOT\s+NULL\b/i),
    hasDefault: /^bigserial$/i.test(rawType) || generated || hasTopLevelMatch(modifiers, /\bDEFAULT\b/i),
    generated,
  };
}

function findColumnTypeEnd(input: string): number {
  const boundary =
    /\b(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|CONSTRAINT|GENERATED|COLLATE)\b/gi;
  for (const match of input.matchAll(boundary)) {
    if (match.index !== undefined && isTopLevelAt(input, match.index)) return match.index;
  }
  return input.length;
}

function parseInlineColumnConstraints(
  definition: string,
  tableName: string,
  columnName: string,
): PostgresSchemaShapeConstraint[] {
  const constraints: PostgresSchemaShapeConstraint[] = [];
  if (hasTopLevelMatch(definition, /\bPRIMARY\s+KEY\b/i)) {
    constraints.push(baseConstraint("p", [columnName]));
  }
  const reference = findTopLevelMatch(
    definition,
    /\bREFERENCES\s+([a-zA-Z_][a-zA-Z0-9_$]*|"(?:[^"]|"")+")\s*\(([^)]+)\)/i,
  );
  if (reference?.[1] && reference[2]) {
    constraints.push({
      ...baseConstraint("f", [columnName]),
      referencedTable: normalizeIdentifier(reference[1]),
      referencedColumns: parseIdentifierList(reference[2]),
      onDelete: parseReferenceAction(definition, "DELETE"),
      onUpdate: parseReferenceAction(definition, "UPDATE"),
    });
  }
  void tableName;
  return constraints;
}

function parseTableConstraint(definition: string, tableName: string): PostgresSchemaShapeConstraint | undefined {
  let trimmed = definition.trim();
  let name: string | null = null;
  const named = /^CONSTRAINT\s+("(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)\s+([\s\S]+)$/i.exec(trimmed);
  if (named?.[1] && named[2]) {
    name = truncatePostgresIdentifier(normalizeIdentifier(named[1]));
    trimmed = named[2].trim();
  }
  const key = /^(PRIMARY\s+KEY|UNIQUE)\s*\(([^)]+)\)/i.exec(trimmed);
  if (key?.[1] && key[2]) {
    return { ...baseConstraint(/^PRIMARY/i.test(key[1]) ? "p" : "u", parseIdentifierList(key[2])), name };
  }
  const foreign =
    /^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+("(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)\s*\(([^)]+)\)/i.exec(trimmed);
  if (foreign?.[1] && foreign[2] && foreign[3]) {
    return {
      ...baseConstraint("f", parseIdentifierList(foreign[1])),
      name,
      referencedTable: normalizeIdentifier(foreign[2]),
      referencedColumns: parseIdentifierList(foreign[3]),
      onDelete: parseReferenceAction(trimmed, "DELETE"),
      onUpdate: parseReferenceAction(trimmed, "UPDATE"),
    };
  }
  if (/^CHECK\b/i.test(trimmed) && name) return { ...baseConstraint("c", []), name };
  void tableName;
  return undefined;
}

function baseConstraint(type: PostgresSchemaShapeConstraint["type"], columns: string[]): PostgresSchemaShapeConstraint {
  return {
    name: null,
    type,
    columns,
    referencedTable: null,
    referencedColumns: [],
    onDelete: type === "f" ? "a" : null,
    onUpdate: type === "f" ? "a" : null,
  };
}

function constraintKey(constraint: PostgresSchemaShapeConstraint): string {
  return [constraint.name ?? "", constraint.type, ...constraint.columns, constraint.referencedTable ?? ""].join(
    "\u0000",
  );
}

function parseReferenceAction(input: string, action: "DELETE" | "UPDATE"): string {
  const match = new RegExp(
    `\\bON\\s+${action}\\s+(NO\\s+ACTION|RESTRICT|CASCADE|SET\\s+NULL|SET\\s+DEFAULT)`,
    "i",
  ).exec(input);
  switch (match?.[1]?.replace(/\s+/g, " ").toUpperCase()) {
    case "RESTRICT":
      return "r";
    case "CASCADE":
      return "c";
    case "SET NULL":
      return "n";
    case "SET DEFAULT":
      return "d";
    default:
      return "a";
  }
}

function normalizePostgresType(input: string): string {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized === "bigserial" || normalized === "int8") return "bigint";
  if (normalized === "int" || normalized === "int4") return "integer";
  if (normalized === "timestamptz") return "timestamp with time zone";
  if (normalized === "float8") return "double precision";
  if (normalized === "bool") return "boolean";
  return normalized;
}

function normalizeIndexKey(input: string): string {
  const normalized = input.trim().replace(/\s+/g, " ").replaceAll('"', "").toLowerCase();
  if (/\s+desc\s+nulls\s+last$/i.test(normalized)) return normalized;
  return normalized
    .replace(/\s+asc\s+nulls\s+first$/i, " nulls first")
    .replace(/\s+asc(?:\s+nulls\s+last)?$/i, "")
    .replace(/\s+desc\s+nulls\s+first$/i, " desc")
    .replace(/\s+nulls\s+last$/i, "");
}

function extractPredicateTerms(predicate: string): string[] {
  const terms = new Set<string>();
  for (const match of predicate.matchAll(/'(?:''|[^'])*'|\b[a-zA-Z_][a-zA-Z0-9_$]*\b|\b\d+(?:\.\d+)?\b/g)) {
    const term = match[0].toLowerCase();
    if (!PREDICATE_KEYWORDS.has(term)) terms.add(term.replace(/^'|'$/g, ""));
  }
  return [...terms].filter((term) => term.length > 0).sort();
}

function normalizePredicateFingerprint(predicate: string): string {
  return [...predicate.matchAll(/'(?:''|[^'])*'|[^']+/g)]
    .map((match) => {
      const token = match[0];
      if (token.startsWith("'")) return token;
      return token
        .replace(
          /::(?:pg_catalog\.)?(?:text|bigint|integer|double precision|boolean|date|timestamp with time zone)/gi,
          "",
        )
        .replace(/[\s()"]+/g, "")
        .toLowerCase();
    })
    .join("");
}

const PREDICATE_KEYWORDS = new Set(["and", "or", "not", "null", "is", "in", "any", "array", "true", "false"]);

function parseIdentifierList(input: string): string[] {
  return splitTopLevel(input, ",").map((value) => normalizeIdentifier(value.trim()));
}

function lastQualifiedIdentifier(input: string): string {
  const parts = splitTopLevel(input, ".");
  return parts[parts.length - 1]?.trim() ?? input.trim();
}

function normalizeIdentifier(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed.toLowerCase();
}

function isCanonicalIdentifier(input: string): boolean {
  return input.length > 0 && !input.includes("%") && !input.includes("{") && !input.includes("}");
}

function truncatePostgresIdentifier(input: string): string {
  if (Buffer.byteLength(input, "utf8") <= POSTGRES_IDENTIFIER_MAX_BYTES) return input;
  let output = "";
  for (const character of input) {
    if (Buffer.byteLength(output + character, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES) break;
    output += character;
  }
  return output;
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (/\s/.test(input[cursor] ?? "")) cursor += 1;
  return cursor;
}

function findStatementEnd(input: string, start: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let cursor = start; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (quote) {
      if (character === quote && input[cursor + 1] === quote) {
        cursor += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (character === ";" && depth === 0) return cursor;
  }
  return input.length;
}

function readBalanced(input: string, open: number): { content: string; end: number } | undefined {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let cursor = open; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (quote) {
      if (character === quote && input[cursor + 1] === quote) {
        cursor += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return { content: input.slice(open + 1, cursor), end: cursor };
    }
  }
  return undefined;
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (quote) {
      if (character === quote && input[cursor + 1] === quote) cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      parts.push(input.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function findTopLevelMatch(input: string, pattern: RegExp): RegExpMatchArray | undefined {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of input.matchAll(matcher)) {
    if (match.index !== undefined && isTopLevelAt(input, match.index)) return match;
  }
  return undefined;
}

function hasTopLevelMatch(input: string, pattern: RegExp): boolean {
  return findTopLevelMatch(input, pattern) !== undefined;
}

function isTopLevelAt(input: string, end: number): boolean {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let cursor = 0; cursor < end; cursor += 1) {
    const character = input[cursor];
    if (quote) {
      if (character === quote && input[cursor + 1] === quote) cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
  }
  return depth === 0 && quote === null;
}
