import { createSqliteSchemaBlueprint } from "../sqlite.js";
import { buildPostgresRuntimeSchemaSqlFromBlueprint } from "./runtime-schema.internal.js";

let cachedRuntimeSchemaSql: string | undefined;

export function buildPostgresRuntimeSchemaSql(): string {
  if (cachedRuntimeSchemaSql) {
    return cachedRuntimeSchemaSql;
  }

  cachedRuntimeSchemaSql = buildPostgresRuntimeSchemaSqlFromBlueprint(createSqliteSchemaBlueprint());
  return cachedRuntimeSchemaSql;
}
