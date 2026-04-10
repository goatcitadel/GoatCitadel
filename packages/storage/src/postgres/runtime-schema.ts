import { createSqliteSchemaBlueprint, type SqliteSchemaBlueprint, type SqliteSchemaTableBlueprint } from "../sqlite.js";

let cachedRuntimeSchemaSql: string | undefined;

export function buildPostgresRuntimeSchemaSql(): string {
  if (cachedRuntimeSchemaSql) {
    return cachedRuntimeSchemaSql;
  }

  const blueprint = createSqliteSchemaBlueprint();
  const tables = blueprint.tables.filter((table) => table.name !== "schema_migrations");
  const orderedTables = topologicallySortTables(tables);
  const statements: string[] = [];

  for (const table of orderedTables) {
    statements.push(renderCreateTable(table));
  }

  for (const table of orderedTables) {
    for (const index of table.indexes) {
      if (index.columns.length === 0 || index.origin === "pk") {
        continue;
      }
      statements.push(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${index.name} ON ${table.name}(${index.columns.join(", ")});`,
      );
    }
  }

  for (const table of orderedTables) {
    if (table.seedRows.length === 0) {
      continue;
    }
    const primaryKeys = table.columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
      .map((column) => column.name);
    for (const row of table.seedRows) {
      statements.push(renderSeedInsert(table.name, row, primaryKeys));
    }
  }

  cachedRuntimeSchemaSql = statements.join("\n");
  return cachedRuntimeSchemaSql;
}

function renderCreateTable(table: SqliteSchemaTableBlueprint): string {
  const primaryKeys = table.columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
    .map((column) => column.name);
  const columnDefs = table.columns.map((column) => renderColumn(table, column.name, primaryKeys));
  const foreignKeyDefs = groupForeignKeys(table)
    .map((group) => renderForeignKey(group));
  const tableConstraints: string[] = [];
  if (primaryKeys.length > 1) {
    tableConstraints.push(`PRIMARY KEY (${primaryKeys.join(", ")})`);
  }
  tableConstraints.push(...foreignKeyDefs);
  const allDefs = [...columnDefs, ...tableConstraints];
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n  ${allDefs.join(",\n  ")}\n);`;
}

function renderColumn(table: SqliteSchemaTableBlueprint, columnName: string, primaryKeys: string[]): string {
  const column = table.columns.find((candidate) => candidate.name === columnName);
  if (!column) {
    throw new Error(`Unknown SQLite column ${columnName} on ${table.name}`);
  }
  const parts = [`${column.name} ${mapColumnType(column)}`];
  if (column.primaryKeyPosition === 1 && primaryKeys.length === 1) {
    parts.push("PRIMARY KEY");
  }
  if (column.notNull && !(column.primaryKeyPosition === 1 && primaryKeys.length === 1)) {
    parts.push("NOT NULL");
  }
  if (column.defaultValue !== null && !column.autoIncrement) {
    parts.push(`DEFAULT ${normalizeDefaultValue(column.defaultValue)}`);
  }
  return parts.join(" ");
}

function mapColumnType(column: SqliteSchemaTableBlueprint["columns"][number]): string {
  const normalized = column.type.trim().toUpperCase();
  if (column.autoIncrement) {
    return "BIGSERIAL";
  }
  if (normalized.includes("INT")) {
    return "BIGINT";
  }
  if (normalized === "REAL" || normalized === "DOUBLE" || normalized === "DOUBLE PRECISION") {
    return "DOUBLE PRECISION";
  }
  if (normalized === "BLOB") {
    return "BYTEA";
  }
  return "TEXT";
}

function normalizeDefaultValue(value: string): string {
  const normalized = value.trim();
  if (/^current_timestamp$/i.test(normalized)) {
    return "CURRENT_TIMESTAMP";
  }
  return normalized;
}

function groupForeignKeys(table: SqliteSchemaTableBlueprint) {
  const grouped = new Map<number, SqliteSchemaTableBlueprint["foreignKeys"]>();
  for (const foreignKey of table.foreignKeys) {
    const list = grouped.get(foreignKey.id) ?? [];
    list.push(foreignKey);
    grouped.set(foreignKey.id, list);
  }
  return [...grouped.values()].map((list) => list.sort((left, right) => left.seq - right.seq));
}

function renderForeignKey(group: SqliteSchemaTableBlueprint["foreignKeys"]): string {
  const first = group[0];
  if (!first) {
    throw new Error("Expected at least one foreign key");
  }
  const from = group.map((item) => item.from).join(", ");
  const to = group.map((item) => item.to).join(", ");
  const clauses = [
    `FOREIGN KEY (${from}) REFERENCES ${first.referencedTable}(${to})`,
  ];
  if (first.onDelete && first.onDelete !== "NO ACTION") {
    clauses.push(`ON DELETE ${first.onDelete}`);
  }
  if (first.onUpdate && first.onUpdate !== "NO ACTION") {
    clauses.push(`ON UPDATE ${first.onUpdate}`);
  }
  return clauses.join(" ");
}

function renderSeedInsert(tableName: string, row: Record<string, unknown>, primaryKeys: string[]): string {
  const entries = Object.entries(row);
  const columns = entries.map(([column]) => column).join(", ");
  const values = entries.map(([, value]) => serializeLiteral(value)).join(", ");
  const conflictClause = primaryKeys.length > 0 ? ` ON CONFLICT (${primaryKeys.join(", ")}) DO NOTHING` : "";
  return `INSERT INTO ${tableName} (${columns}) VALUES (${values})${conflictClause};`;
}

function serializeLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function topologicallySortTables(tables: SqliteSchemaBlueprint["tables"]): SqliteSchemaBlueprint["tables"] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const remaining = new Set(tables.map((table) => table.name));
  const sorted: SqliteSchemaBlueprint["tables"] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((name) => byName.get(name))
      .filter((table): table is SqliteSchemaTableBlueprint => Boolean(table))
      .filter((table) =>
        table.foreignKeys.every((foreignKey) =>
          !remaining.has(foreignKey.referencedTable) || foreignKey.referencedTable === table.name
        )
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    if (ready.length === 0) {
      const fallback = [...remaining]
        .map((name) => byName.get(name))
        .filter((table): table is SqliteSchemaTableBlueprint => Boolean(table))
        .sort((left, right) => left.name.localeCompare(right.name));
      sorted.push(...fallback);
      break;
    }

    for (const table of ready) {
      remaining.delete(table.name);
      sorted.push(table);
    }
  }

  return sorted;
}
