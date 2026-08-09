import type { DatabaseSync } from "node:sqlite";

export interface SqliteSchemaShapeEntry {
  type: "index" | "table";
  name: string;
  tableName: string;
  signature: string;
}

export interface SqliteSchemaShapeManifest {
  entries: SqliteSchemaShapeEntry[];
}

/**
 * SQLite has no per-relation ownership catalog. PRAGMA metadata supplies the
 * stable cross-version signature: ordered columns, PK/unique/FK/check
 * constraints, and explicit index keys/predicates. Default expressions are
 * intentionally excluded because SQLite preserves authoring text and older
 * canonical lineages may retain an equivalent historical literal spelling.
 */
export function readSqliteSchemaShape(db: DatabaseSync): SqliteSchemaShapeManifest {
  const tableRows = db
    .prepare(
      `
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND sql IS NOT NULL
        ORDER BY name ASC
      `,
    )
    .all() as Array<{ name: string; sql: string }>;
  const entries: SqliteSchemaShapeEntry[] = [];
  for (const table of tableRows) {
    const quotedTable = quoteSqliteIdentifier(table.name);
    const columns = db.prepare(`PRAGMA table_xinfo(${quotedTable})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      pk: number;
      hidden: number;
    }>;
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quotedTable})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>;
    const indexRows = db.prepare(`PRAGMA index_list(${quotedTable})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    const uniqueConstraints = indexRows
      .filter((index) => index.origin === "u")
      .map((index) => readSqliteIndexKeys(db, index.name))
      .sort(compareStringArrays);
    entries.push({
      type: "table",
      name: table.name,
      tableName: table.name,
      signature: JSON.stringify({
        columns: columns
          .filter((column) => column.cid >= 0)
          // ALTER TABLE appends columns while a fresh canonical CREATE may
          // place the same column earlier. Column order is not a SQLite shape
          // invariant; PK position and index key order are recorded separately.
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((column) => ({
            name: column.name,
            type: column.type.trim().toUpperCase(),
            notNull: column.notnull === 1,
            primaryKeyPosition: column.pk,
            hidden: column.hidden,
          })),
        foreignKeys: foreignKeys
          .sort((left, right) => left.id - right.id || left.seq - right.seq)
          .map((foreignKey) => ({
            id: foreignKey.id,
            seq: foreignKey.seq,
            table: foreignKey.table,
            from: foreignKey.from,
            to: foreignKey.to,
            onUpdate: foreignKey.on_update.toUpperCase(),
            onDelete: foreignKey.on_delete.toUpperCase(),
            match: foreignKey.match.toUpperCase(),
          })),
        uniqueConstraints,
        checks: extractSqliteCheckConstraints(table.sql),
      }),
    });

    for (const index of indexRows.filter((candidate) => candidate.origin === "c")) {
      const indexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name) as
        | { sql?: string | null }
        | undefined;
      if (!indexSql?.sql) continue;
      entries.push({
        type: "index",
        name: index.name,
        tableName: table.name,
        signature: JSON.stringify({
          unique: index.unique === 1,
          keys: readSqliteIndexKeys(db, index.name),
          predicate: extractSqliteIndexPredicate(indexSql.sql),
        }),
      });
    }
  }
  return { entries: entries.sort((left, right) => entryIdentity(left).localeCompare(entryIdentity(right))) };
}

export function assertSqliteSchemaShape(actual: SqliteSchemaShapeManifest, expected: SqliteSchemaShapeManifest): void {
  const actualByIdentity = new Map(actual.entries.map((entry) => [entryIdentity(entry), entry]));
  const expectedByIdentity = new Map(expected.entries.map((entry) => [entryIdentity(entry), entry]));
  const issues: string[] = [];

  for (const [identity, expectedEntry] of expectedByIdentity) {
    const actualEntry = actualByIdentity.get(identity);
    if (!actualEntry) {
      issues.push(`missing ${expectedEntry.type} ${expectedEntry.name}`);
      continue;
    }
    if (actualEntry.tableName !== expectedEntry.tableName || actualEntry.signature !== expectedEntry.signature) {
      issues.push(`non-canonical ${expectedEntry.type} ${expectedEntry.name}`);
    }
  }
  if (issues.length > 0) {
    throw new Error(`SQLite canonical schema-shape validation failed: ${issues.slice(0, 12).join("; ")}.`);
  }
}

function entryIdentity(entry: Pick<SqliteSchemaShapeEntry, "name" | "type">): string {
  return `${entry.type}\u0000${entry.name}`;
}

function normalizeSqliteExpression(sql: string): string {
  let output = "";
  let pendingWhitespace = false;
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
      } else if (character === quote && sql[index + 1] === quote) {
        output += sql[index + 1];
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (pendingWhitespace && output.length > 0) output += " ";
      pendingWhitespace = false;
      quote = character;
      output += character;
      continue;
    }
    if (character === "[") {
      if (pendingWhitespace && output.length > 0) output += " ";
      pendingWhitespace = false;
      quote = "]";
      output += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingWhitespace = true;
      continue;
    }
    if (pendingWhitespace && output.length > 0 && !"(),;".includes(character) && !output.endsWith("(")) output += " ";
    pendingWhitespace = false;
    output += character.toLowerCase();
  }
  return output.trim();
}

function readSqliteIndexKeys(db: DatabaseSync, indexName: string): string[] {
  return (
    db.prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(indexName)})`).all() as Array<{
      seqno: number;
      cid: number;
      name: string | null;
      desc: number;
      coll: string | null;
      key: number;
    }>
  )
    .filter((column) => column.key === 1)
    .sort((left, right) => left.seqno - right.seqno)
    .map((column) => `${column.name ?? ""}:${column.desc}:${(column.coll ?? "").toUpperCase()}`);
}

function extractSqliteIndexPredicate(sql: string): string | null {
  const match = /\bWHERE\s+([\s\S]+)$/i.exec(sql);
  return match?.[1] ? normalizeSqliteExpression(match[1]) : null;
}

function extractSqliteCheckConstraints(sql: string): string[] {
  const checks: string[] = [];
  const pattern = /\bCHECK\s*\(/gi;
  for (const match of sql.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const open = sql.indexOf("(", match.index);
    if (open < 0) continue;
    const expression = readBalancedExpression(sql, open);
    if (expression) checks.push(normalizeSqliteExpression(expression));
  }
  return checks.sort();
}

function readBalancedExpression(sql: string, open: number): string | undefined {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = open; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      if (character === quote && sql[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, index);
    }
  }
  return undefined;
}

function compareStringArrays(left: string[], right: string[]): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
