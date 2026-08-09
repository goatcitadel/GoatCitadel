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
      "notNull" pg_catalog.boolean,
      "hasDefault" pg_catalog.boolean,
      generated pg_catalog.boolean
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
      "unique" pg_catalog.boolean,
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
                  pg_catalog.pg_get_indexdef(index_row.indexrelid, key_position, true),
                  '::(?:pg_catalog\\.)?(?:text|bigint|integer|double precision|boolean|date|timestamp with time zone)',
                  '',
                  'gi'
                ),
                '\\s+ASC$',
                '',
                'i'
              ),
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
        AND pg_catalog.lower(
          pg_catalog.regexp_replace(
            pg_catalog.regexp_replace(
              COALESCE(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false), ''),
              '::(?:pg_catalog\\.)?(?:text|bigint|integer|double precision|boolean|date|timestamp with time zone)',
              '',
              'gi'
            ),
            '[\\s()]',
            '',
            'g'
          )
        ) OPERATOR(pg_catalog.<>) expected."predicateFingerprint"
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
  )
  SELECT issue FROM relation_issues
  UNION ALL SELECT issue FROM column_issues
  UNION ALL SELECT issue FROM unexpected_column_issues
  UNION ALL SELECT issue FROM constraint_issues
  UNION ALL SELECT issue FROM index_issues
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

const manifestCache = new WeakMap<readonly PostgresMigration[], PostgresSchemaShapeManifest>();

export function buildPostgresSchemaShapeManifest(
  migrations: readonly PostgresMigration[],
): PostgresSchemaShapeManifest {
  const cached = manifestCache.get(migrations);
  if (cached) return cached;

  const tables = new Map<string, MutableTable>();
  const indexes = new Map<string, PostgresSchemaShapeIndex>();
  for (const migration of migrations) {
    collectDroppedTables(migration.sql, tables, indexes);
    collectCreateTables(migration.sql, tables);
    collectAddedColumns(migration.sql, tables);
    collectCreateIndexes(migration.sql, indexes);
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

function collectDroppedTables(
  sql: string,
  tables: Map<string, MutableTable>,
  indexes: Map<string, PostgresSchemaShapeIndex>,
): void {
  const pattern = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/gi;
  for (const match of sql.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const end = findStatementEnd(sql, match.index + match[0].length);
    const body = sql
      .slice(match.index + match[0].length, end)
      .replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, "");
    for (const rawName of splitTopLevel(body, ",")) {
      const tableName = normalizeIdentifier(lastQualifiedIdentifier(rawName.replace(/\s*\*\s*$/u, "")));
      if (!isCanonicalIdentifier(tableName)) continue;
      tables.delete(tableName);
      for (const [indexName, index] of indexes) {
        if (index.tableName === tableName) indexes.delete(indexName);
      }
    }
  }
}

function collectCreateTables(sql: string, tables: Map<string, MutableTable>): void {
  const pattern =
    /\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+((?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*))?)/gi;
  for (const match of sql.matchAll(pattern)) {
    const rawName = match[1];
    if (!rawName || match.index === undefined) continue;
    const open = skipWhitespace(sql, match.index + match[0].length);
    if (sql[open] !== "(") continue;
    const balanced = readBalanced(sql, open);
    if (!balanced) continue;
    const tableName = normalizeIdentifier(lastQualifiedIdentifier(rawName));
    if (!isCanonicalIdentifier(tableName)) continue;
    const table = getOrCreateTable(tables, tableName);
    for (const definition of splitTopLevel(balanced.content, ",")) {
      const column = parseColumnDefinition(definition);
      if (column) {
        table.columns.set(column.name, column);
        const inlineConstraints = parseInlineColumnConstraints(definition, tableName, column.name);
        for (const constraint of inlineConstraints) {
          table.constraints.set(constraintKey(constraint), constraint);
        }
        continue;
      }
      const constraint = parseTableConstraint(definition, tableName);
      if (constraint) table.constraints.set(constraintKey(constraint), constraint);
    }
    for (const constraint of table.constraints.values()) {
      if (constraint.type !== "p") continue;
      for (const columnName of constraint.columns) {
        const column = table.columns.get(columnName);
        if (column) table.columns.set(columnName, { ...column, notNull: true });
      }
    }
  }
}

function collectAddedColumns(sql: string, tables: Map<string, MutableTable>): void {
  const pattern =
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*))?)/gi;
  for (const match of sql.matchAll(pattern)) {
    const rawName = match[1];
    if (!rawName || match.index === undefined) continue;
    const tableName = normalizeIdentifier(lastQualifiedIdentifier(rawName));
    if (!isCanonicalIdentifier(tableName)) continue;
    const end = findStatementEnd(sql, match.index + match[0].length);
    const body = sql.slice(match.index + match[0].length, end);
    for (const clause of splitTopLevel(body, ",")) {
      const addMatch =
        /^\s*ADD\s+(?:COLUMN\s+)?IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_$]*|"(?:[^"]|"")+")\s+([\s\S]+)$/i.exec(
          clause,
        );
      if (!addMatch) continue;
      const column = parseColumnDefinition(`${addMatch[1]} ${addMatch[2]}`);
      if (!column) continue;
      getOrCreateTable(tables, tableName).columns.set(column.name, column);
    }
  }
}

function collectCreateIndexes(sql: string, indexes: Map<string, PostgresSchemaShapeIndex>): void {
  const pattern =
    /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+((?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*))?)\s+ON\s+(?:ONLY\s+)?((?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*))?)/gi;
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
    indexes.set(indexName, {
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
    });
  }
}

function getOrCreateTable(tables: Map<string, MutableTable>, name: string): MutableTable {
  const existing = tables.get(name);
  if (existing) return existing;
  const created = { name, columns: new Map(), constraints: new Map() } satisfies MutableTable;
  tables.set(name, created);
  return created;
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
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(modifiers);
  const generated = /\bGENERATED\s+ALWAYS\s+AS\b/i.test(modifiers);
  return {
    name,
    type: normalizePostgresType(rawType),
    notNull: primaryKey || /\bNOT\s+NULL\b/i.test(modifiers),
    hasDefault: /^bigserial$/i.test(rawType) || generated || /\bDEFAULT\b/i.test(modifiers),
    generated,
  };
}

function findColumnTypeEnd(input: string): number {
  const boundary =
    /\b(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|CONSTRAINT|GENERATED|COLLATE)\b/gi;
  for (const match of input.matchAll(boundary)) {
    if (match.index !== undefined && nestingDepthAt(input, match.index) === 0) return match.index;
  }
  return input.length;
}

function parseInlineColumnConstraints(
  definition: string,
  tableName: string,
  columnName: string,
): PostgresSchemaShapeConstraint[] {
  const constraints: PostgresSchemaShapeConstraint[] = [];
  if (/\bPRIMARY\s+KEY\b/i.test(definition)) {
    constraints.push(baseConstraint("p", [columnName]));
  }
  const reference = /\bREFERENCES\s+([a-zA-Z_][a-zA-Z0-9_$]*|"(?:[^"]|"")+")\s*\(([^)]+)\)/i.exec(definition);
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
  return input
    .trim()
    .replace(/\s+/g, " ")
    .replaceAll('"', "")
    .replace(/\s+asc$/i, "")
    .toLowerCase();
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
  return predicate
    .replace(/::(?:pg_catalog\.)?(?:text|bigint|integer|double precision|boolean|date|timestamp with time zone)/gi, "")
    .replace(/[\s()]/g, "")
    .toLowerCase();
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

function nestingDepthAt(input: string, end: number): number {
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
  return depth;
}
