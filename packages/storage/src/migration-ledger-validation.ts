export interface MigrationDefinitionIdentity {
  version: number;
  name: string;
}

export interface AppliedMigrationLedgerRow {
  version: number;
  name: string;
}

export function assertValidMigrationDefinitions(
  definitions: readonly MigrationDefinitionIdentity[],
  dialectLabel: string,
): void {
  let previousVersion: number | undefined;
  for (const [index, definition] of definitions.entries()) {
    if (!Number.isSafeInteger(definition.version) || definition.version <= 0) {
      throw new Error(
        `${dialectLabel} migration at index ${index} must use a safe positive integer version; found ${String(definition.version)}.`,
      );
    }
    if (typeof definition.name !== "string" || definition.name.trim().length === 0) {
      throw new Error(`${dialectLabel} migration ${definition.version} must define a non-blank name.`);
    }
    if (previousVersion !== undefined && definition.version !== previousVersion + 1) {
      throw new Error(
        `${dialectLabel} migration registry must be strictly ascending and contiguous: ` +
          `expected version ${previousVersion + 1} after ${previousVersion}, found ${definition.version}.`,
      );
    }
    previousVersion = definition.version;
  }
}

export function assertValidAppliedMigrationLedger(
  definitions: readonly MigrationDefinitionIdentity[],
  appliedRows: readonly AppliedMigrationLedgerRow[],
  dialectLabel: string,
): Map<number, string> {
  assertValidMigrationDefinitions(definitions, dialectLabel);
  const definitionsByVersion = new Map(definitions.map((definition) => [definition.version, definition.name]));
  const applied = new Map<number, string>();

  for (const [index, row] of appliedRows.entries()) {
    if (!Number.isSafeInteger(row.version) || row.version <= 0) {
      throw new Error(
        `${dialectLabel} migration ledger row at index ${index} must use a safe positive integer version; found ${String(row.version)}.`,
      );
    }
    if (typeof row.name !== "string" || row.name.trim().length === 0) {
      throw new Error(`${dialectLabel} migration ledger row for version ${row.version} must have a non-blank name.`);
    }
    if (applied.has(row.version)) {
      throw new Error(`${dialectLabel} migration ledger contains duplicate version ${row.version}.`);
    }

    const definedName = definitionsByVersion.get(row.version);
    if (definedName === undefined) {
      throw new Error(
        `${dialectLabel} migration ledger contains unknown version ${row.version} ("${row.name}"); ` +
          "this build's migration registry does not define it.",
      );
    }
    if (definedName !== row.name) {
      throw new Error(
        `${dialectLabel} migration ledger mismatch at version ${row.version}: database recorded "${row.name}" ` +
          `but this build defines "${definedName}". Refusing to run migrations until the ledger is reconciled.`,
      );
    }
    applied.set(row.version, row.name);
  }

  return applied;
}
