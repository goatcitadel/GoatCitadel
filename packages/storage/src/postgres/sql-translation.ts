export interface PostgresTranslatedSql {
  sql: string;
  params: unknown[];
}

/**
 * Translate the SQLite-style placeholders used by the shared repositories to
 * PostgreSQL positional parameters. SQL without bindings is preserved exactly
 * because PostgreSQL string literals and regular expressions may contain `?`.
 */
export function translateSqlForPostgres(sql: string, params: unknown[]): PostgresTranslatedSql {
  if (params.length === 0) {
    return { sql, params };
  }
  const namedMatch = /@([a-zA-Z_][a-zA-Z0-9_]*)/.test(sql);
  if (namedMatch) {
    const first = params[0];
    const record = isRecord(first) ? first : {};
    const values: unknown[] = [];
    let index = 0;
    return {
      sql: sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
        index += 1;
        values.push(record[name]);
        return `$${index}`;
      }),
      params: values,
    };
  }

  let index = 0;
  return {
    sql: sql.replace(/\?/g, () => {
      index += 1;
      return `$${index}`;
    }),
    params,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
