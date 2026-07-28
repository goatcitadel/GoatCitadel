import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const STORAGE_MIGRATION_MANIFEST_VERSION = 1;
// canonicalizeAstStructure records numeric SyntaxKind values from the
// lockfile-resolved TypeScript compiler (`ts.version`). A compiler upgrade
// requires a new algorithm id and an explicitly reviewed manifest transition.
export const STORAGE_MIGRATION_HASH_ALGORITHM = "sha256-typescript-ast-token-closure-and-runtime-payload-v4";
export const SQLITE_MIGRATION_SOURCE_PATH = "packages/storage/src/sqlite.ts";
export const POSTGRES_MIGRATION_SOURCE_PATH = "packages/storage/src/postgres/migrations.ts";

export const POSTGRES_V2_DYNAMIC_BOOTSTRAP_EXCEPTION = Object.freeze({
  dialect: "postgres",
  version: 2,
  kind: "dynamic-bootstrap-sql",
  protection: "definition-and-owner-only",
  reason:
    "Migration SQL remains generated dynamically from the append-only SQLite migration registry and blueprint. This manifest locks the direct v2 definition, runtime renderer modules, the direct SQLite blueprint wrapper, and the transitive local/relative database-extraction source closure through registry execution while treating the independently manifested SCHEMA_MIGRATION_GROUPS array as data; it does not claim generated SQL byte immutability.",
});

const POSTGRES_RUNTIME_INTEGRITY_LOCKS = Object.freeze([
  Object.freeze({
    version: 81,
    name: "scrub_legacy_remote_approval_bearers",
    sha256: "4187b1a0cc73330480192ee66650990775c53c35fe2c54a01559ab4af6631b0a",
  }),
  Object.freeze({
    version: 85,
    name: "scrub_legacy_remote_approval_bearers_from_effect_results",
    sha256: "ef8cc376dbcba14eb6dd496d5cf14be19183096bafcab2ae57395dedae76df74",
  }),
]);

const WORKSPACE_PACKAGE_SOURCE_ENTRYPOINTS = Object.freeze({
  "@goatcitadel/contracts": "packages/contracts/src/index.ts",
});

export async function loadStorageTypeScriptSourceFiles(repoRoot) {
  const resolvedRepoRoot = repoRoot instanceof URL ? fileURLToPath(repoRoot) : path.resolve(repoRoot);
  const sourceRoots = [
    path.join(resolvedRepoRoot, "packages", "storage", "src"),
    path.join(resolvedRepoRoot, "packages", "contracts", "src"),
  ];
  const sourceFiles = new Map();

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const sourcePath = normalizeSourcePath(path.relative(resolvedRepoRoot, absolutePath));
          sourceFiles.set(sourcePath, await fs.readFile(absolutePath, "utf8"));
        }
      }),
    );
  }

  await Promise.all(sourceRoots.map(visit));
  return sourceFiles;
}

export function extractSqliteMigrationRegistry(source, options = {}) {
  const sourcePath = normalizeSourcePath(options.sourcePath ?? SQLITE_MIGRATION_SOURCE_PATH);
  const sourceFile = parseTypeScriptSource(source, sourcePath);
  const sourceGraph = createSourceGraph(sourcePath, source, options.sourceFiles);
  const registry = requireTopLevelArrayRegistry(sourceFile, "SCHEMA_MIGRATION_GROUPS");
  const migrations = [];
  const groupNames = new Set();

  for (const [groupIndex, groupElement] of registry.elements.entries()) {
    const group = requireDirectObject(groupElement, `SCHEMA_MIGRATION_GROUPS group ${groupIndex}`);
    const properties = readObjectProperties(group, `SCHEMA_MIGRATION_GROUPS group ${groupIndex}`);
    const groupName = readStaticStringProperty(properties, "name", `SCHEMA_MIGRATION_GROUPS group ${groupIndex}`);
    if (groupNames.has(groupName)) {
      throw new Error(`SCHEMA_MIGRATION_GROUPS group name is duplicated: ${groupName}`);
    }
    groupNames.add(groupName);
    const migrationArray = requireArrayProperty(properties, "migrations", `SCHEMA_MIGRATION_GROUPS group ${groupName}`);

    for (const [migrationIndex, migrationElement] of migrationArray.elements.entries()) {
      const context = `SCHEMA_MIGRATION_GROUPS group ${groupName} migration ${migrationIndex}`;
      const migration = requireDirectObject(migrationElement, context);
      const migrationProperties = readObjectProperties(migration, context);
      const version = readStaticVersionProperty(migrationProperties, context);
      const name = readStaticStringProperty(migrationProperties, "name", context);
      const upImplementation = requirePropertyAssignmentInitializer(
        requireExplicitProperty(migrationProperties, "up", context),
        "up",
        context,
      );
      migrations.push({
        version,
        name,
        groupName,
        definitionSha256: hashDefinitionNode(migration),
        implementationSha256: hashSqliteUpImplementation(upImplementation, sourcePath, sourceGraph, context),
      });
    }
  }

  return finalizeRegistry({
    dialect: "sqlite",
    sourcePath,
    registryName: "SCHEMA_MIGRATION_GROUPS",
    migrations,
    requireContiguousFromOne: options.requireContiguousFromOne ?? true,
  });
}

export function extractPostgresMigrationRegistry(source, options = {}) {
  const sourcePath = normalizeSourcePath(options.sourcePath ?? POSTGRES_MIGRATION_SOURCE_PATH);
  const { sourceFile, migrations } = extractPostgresMigrationNodes(source, sourcePath);
  const records = migrations.map(({ node, properties }, index) => {
    const context = `POSTGRES_MIGRATIONS migration ${index}`;
    const version = readStaticVersionProperty(properties, context);
    const name = readStaticStringProperty(properties, "name", context);
    const sqlExpression = requirePropertyAssignmentInitializer(
      requireExplicitProperty(properties, "sql", context),
      "sql",
      context,
    );
    const integrityProperty = properties.get("integritySha256");
    const batchedStatementsProperty = properties.get("batchedStatements");
    let runtimeIntegritySha256;

    if (integrityProperty) {
      const initializer = requirePropertyAssignmentInitializer(integrityProperty, "integritySha256", context);
      runtimeIntegritySha256 = readStaticString(initializer, `${context} integritySha256`);
      if (!/^[a-f0-9]{64}$/.test(runtimeIntegritySha256)) {
        throw new Error(`${context} integritySha256 must be a lowercase 64-character SHA-256 digest.`);
      }
    }

    if (batchedStatementsProperty) {
      const batchedStatements = unwrapExpression(
        requirePropertyAssignmentInitializer(batchedStatementsProperty, "batchedStatements", context),
      );
      if (!ts.isArrayLiteralExpression(batchedStatements)) {
        throw new Error(`${context} batchedStatements must be a direct array literal.`);
      }
      for (const [batchIndex, batchElement] of batchedStatements.elements.entries()) {
        const batchContext = `${context} batchedStatements entry ${batchIndex}`;
        const batch = requireDirectObject(batchElement, batchContext);
        const batchProperties = readObjectProperties(batch, batchContext);
        readStaticStringProperty(batchProperties, "name", batchContext);
        requirePropertyAssignmentInitializer(
          requireExplicitProperty(batchProperties, "sql", batchContext),
          "sql",
          batchContext,
        );
      }
      if (!runtimeIntegritySha256) {
        throw new Error(`${context} batchedStatements requires an explicit integritySha256.`);
      }
    }

    const record = {
      version,
      name,
      definitionSha256: hashDefinitionNode(node),
    };
    const resolvedSqlPayload = resolveStaticStringExpression(sqlExpression, sourceFile);
    if (resolvedSqlPayload !== null) {
      record.sqlPayloadSha256 = hashRuntimePayload(resolvedSqlPayload);
    } else if (version !== 2 && !runtimeIntegritySha256) {
      throw new Error(
        `${context} SQL payload is dynamic and lacks an explicit integritySha256 or the documented Postgres v2 bootstrap exception.`,
      );
    }
    if (runtimeIntegritySha256) {
      record.runtimeIntegritySha256 = runtimeIntegritySha256;
    }
    return record;
  });

  const registry = finalizeRegistry({
    dialect: "postgres",
    sourcePath,
    registryName: "POSTGRES_MIGRATIONS",
    migrations: records,
    requireContiguousFromOne: options.requireContiguousFromOne ?? true,
  });
  if (records.some((migration) => migration.version === 2)) {
    registry.v2OwnerProvenance = buildPostgresV2OwnerProvenance(options);
  }
  return registry;
}

export function findMigrationParityErrors(sqliteNames, postgresNames) {
  const sqliteParity = sqliteNames.filter(isParityMigrationName);
  const postgresParity = postgresNames.filter(isParityMigrationName);
  const sqliteSet = new Set(sqliteParity);
  const postgresSet = new Set(postgresParity);
  const errors = [];

  for (const name of sqliteParity) {
    if (!postgresSet.has(name)) {
      errors.push(`SQLite parity migration missing from Postgres: ${name}`);
    }
  }
  for (const name of postgresParity) {
    if (!sqliteSet.has(name)) {
      errors.push(`Postgres parity migration missing from SQLite: ${name}`);
    }
  }

  const sharedSqliteOrder = sqliteParity.filter((name) => postgresSet.has(name));
  const sharedPostgresOrder = postgresParity.filter((name) => sqliteSet.has(name));
  if (sharedSqliteOrder.join("\n") !== sharedPostgresOrder.join("\n")) {
    errors.push("SQLite/Postgres parity migration ordering diverges.");
  }
  return errors;
}

export function findPostgresRuntimeIntegrityErrors(postgres) {
  const errors = [];
  for (const expected of POSTGRES_RUNTIME_INTEGRITY_LOCKS) {
    const actual = postgres.migrations.find((migration) => migration.version === expected.version);
    if (!actual || actual.name !== expected.name) {
      errors.push(`Protected Postgres runtime migration v${expected.version} is missing or renamed: ${expected.name}`);
      continue;
    }
    if (actual.runtimeIntegritySha256 !== expected.sha256) {
      errors.push(
        `Protected Postgres runtime migration v${expected.version} integrity digest changed: ${expected.name}`,
      );
    }
  }
  return errors;
}

export function createStorageMigrationManifest({ sqlite, postgres }) {
  requirePostgresV2BootstrapRecord(postgres);
  const ownerProvenance = requirePostgresV2OwnerProvenance(postgres);
  return {
    manifestVersion: STORAGE_MIGRATION_MANIFEST_VERSION,
    hashAlgorithm: STORAGE_MIGRATION_HASH_ALGORITHM,
    sources: {
      sqlite: toManifestSource(sqlite),
      postgres: toManifestSource(postgres),
    },
    exceptions: [{ ...POSTGRES_V2_DYNAMIC_BOOTSTRAP_EXCEPTION, ownerProvenance }],
  };
}

export function findStorageMigrationManifestErrors({ manifest, sqlite, postgres }) {
  let expected;
  try {
    expected = createStorageMigrationManifest({ sqlite, postgres });
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (canonicalJson(manifest) === canonicalJson(expected)) {
    return [];
  }
  const difference = findFirstDifference(expected, manifest, "manifest");
  return [
    `Storage migration manifest must exactly match every migration definition and resolved behavior digest${difference ? ` (${difference})` : ""}. Run the append-only updater only after proving all existing definitions are unchanged.`,
  ];
}

export function buildAppendOnlyStorageMigrationManifest({ manifest, sqlite, postgres }) {
  const existing = validateExistingManifest(manifest);
  assertAppendOnlyRegistry("SQLite", existing.sources.sqlite.migrations, sqlite.migrations);
  assertAppendOnlyRegistry("Postgres", existing.sources.postgres.migrations, postgres.migrations);
  const existingOwnerProvenance = existing.exceptions[0]?.ownerProvenance;
  if (canonicalJson(existingOwnerProvenance) !== canonicalJson(postgres.v2OwnerProvenance)) {
    throw new Error("Postgres v2 owner provenance drifted; the append-only updater cannot rewrite historical owners.");
  }
  return createStorageMigrationManifest({ sqlite, postgres });
}

export function findStorageMigrationLineageErrors({ baseManifest, sqlite, postgres }) {
  try {
    buildAppendOnlyStorageMigrationManifest({ manifest: baseManifest, sqlite, postgres });
    return [];
  } catch (error) {
    return [
      `Storage migration lineage diverged from the immutable base manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

export function findStorageMigrationSemanticOwnershipErrors({
  postgresMigrationsSource,
  runtimeSchemaSource,
  runtimeSchemaInternalSource,
}) {
  const errors = [];
  let postgresSourceFile;
  let postgresMigrationNodes;
  let runtimeSourceFile;
  let runtimeInternalSourceFile;

  try {
    postgresSourceFile = parseTypeScriptSource(postgresMigrationsSource, POSTGRES_MIGRATION_SOURCE_PATH);
    postgresMigrationNodes = extractPostgresMigrationNodes(
      postgresMigrationsSource,
      POSTGRES_MIGRATION_SOURCE_PATH,
    ).migrations;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    runtimeSourceFile = parseTypeScriptSource(runtimeSchemaSource, "packages/storage/src/postgres/runtime-schema.ts");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    runtimeInternalSourceFile = parseTypeScriptSource(
      runtimeSchemaInternalSource,
      "packages/storage/src/postgres/runtime-schema.internal.ts",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (postgresSourceFile && postgresMigrationNodes) {
    if (!hasNamedImport(postgresSourceFile, "./runtime-schema.js", "buildPostgresRuntimeSchemaSql")) {
      errors.push("Postgres migrations must import buildPostgresRuntimeSchemaSql from runtime-schema.js.");
    }

    const v2 = findMigrationNodeByVersion(postgresMigrationNodes, 2);
    const v2Sql = v2 ? getPropertyInitializer(v2.properties, "sql") : undefined;
    if (!v2Sql || !isZeroArgumentIdentifierCall(v2Sql, "buildPostgresRuntimeSchemaSql")) {
      errors.push(
        "Postgres v2 canonical runtime schema must be owned by a direct buildPostgresRuntimeSchemaSql() AST call.",
      );
    }

    const frozenV7Declaration = findTopLevelVariableDeclaration(postgresSourceFile, "POSTGRES_V7_FROZEN_SCHEMA_SQL");
    if (
      !frozenV7Declaration?.initializer ||
      !isStaticStringExpression(unwrapExpression(frozenV7Declaration.initializer))
    ) {
      errors.push(
        "Postgres v7 frozen runtime schema must be backed by a static POSTGRES_V7_FROZEN_SCHEMA_SQL declaration.",
      );
    }
    const v7 = findMigrationNodeByVersion(postgresMigrationNodes, 7);
    const v7Sql = v7 ? getPropertyInitializer(v7.properties, "sql") : undefined;
    if (
      !v7Sql ||
      !containsIdentifier(v7Sql, "POSTGRES_V7_FROZEN_SCHEMA_SQL") ||
      containsCallNamed(v7Sql, "buildPostgresRuntimeSchemaSql")
    ) {
      errors.push(
        "Postgres v7 runtime schema repair must reference the frozen schema constant and never the live builder.",
      );
    }
  }

  if (runtimeSourceFile) {
    if (!hasNamedImport(runtimeSourceFile, "../sqlite.js", "createSqliteSchemaBlueprint")) {
      errors.push("Postgres runtime schema must import createSqliteSchemaBlueprint from SQLite storage.");
    }
    if (
      !hasNamedImport(runtimeSourceFile, "./runtime-schema.internal.js", "buildPostgresRuntimeSchemaSqlFromBlueprint")
    ) {
      errors.push("Postgres runtime schema must import the blueprint renderer from runtime-schema.internal.js.");
    }
    const builder = findFunctionDeclaration(runtimeSourceFile, "buildPostgresRuntimeSchemaSql");
    if (!builder || !containsBlueprintRenderCall(builder)) {
      errors.push("buildPostgresRuntimeSchemaSql must render the direct createSqliteSchemaBlueprint() AST result.");
    }
  }

  if (runtimeInternalSourceFile) {
    for (const field of ["columns", "indexes", "foreignKeys", "seedRows"]) {
      if (!containsTablePropertyAccess(runtimeInternalSourceFile, field)) {
        errors.push(`Postgres runtime schema renderer must consume SQLite blueprint field through AST: table.${field}`);
      }
    }
  }
  return errors;
}

function createSourceGraph(mainSourcePath, mainSource, providedSourceFiles) {
  const sourceTexts = new Map();
  if (providedSourceFiles instanceof Map) {
    for (const [sourcePath, source] of providedSourceFiles) {
      sourceTexts.set(normalizeSourcePath(sourcePath), source);
    }
  } else if (providedSourceFiles && typeof providedSourceFiles === "object") {
    for (const [sourcePath, source] of Object.entries(providedSourceFiles)) {
      sourceTexts.set(normalizeSourcePath(sourcePath), source);
    }
  }
  sourceTexts.set(mainSourcePath, mainSource);
  return { sourceTexts, sourceFiles: new Map() };
}

function hashSqliteUpImplementation(upExpression, sourcePath, sourceGraph, context) {
  const root = unwrapExpression(upExpression);
  const closure = new Map();
  const visited = new Set();
  if (ts.isIdentifier(root)) {
    collectSymbolClosure(sourceGraph, sourcePath, root.text, closure, visited, context, true);
  } else if (ts.isArrowFunction(root) || ts.isFunctionExpression(root)) {
    collectReferencedSymbolClosures(root, sourceGraph, sourcePath, closure, visited, context);
  } else {
    throw new Error(`${context} up must be a direct identifier, arrow function, or function expression.`);
  }
  const closureRecords = orderClosureRecords(closure);
  return hashCanonicalValue({
    rootSourcePath: sourcePath,
    root: canonicalizeAstNode(root),
    closure: closureRecords,
  });
}

function hashSourceSymbolClosure(sourceGraph, sourcePath, symbolName, context, options = {}) {
  const closure = new Map();
  collectSymbolClosure(
    sourceGraph,
    sourcePath,
    symbolName,
    closure,
    new Set(),
    context,
    true,
    options.excludedClosureKeys ?? new Set(),
  );
  return hashCanonicalValue({
    rootSourcePath: sourcePath,
    rootSymbolName: symbolName,
    closure: orderClosureRecords(closure),
  });
}

function orderClosureRecords(closure) {
  return [...closure.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

function collectSymbolClosure(
  sourceGraph,
  modulePath,
  symbolName,
  closure,
  visited,
  context,
  required,
  excludedClosureKeys = new Set(),
) {
  const resolved = resolveSourceSymbol(sourceGraph, modulePath, symbolName, new Set());
  if (!resolved || resolved.kind === "external") {
    if (required) {
      throw new Error(
        `${context} up implementation ${symbolName} could not be resolved to a local or relative imported source declaration.`,
      );
    }
    return;
  }
  const key = `${resolved.modulePath}#${resolved.symbolName}`;
  if (excludedClosureKeys.has(key)) {
    return;
  }
  if (visited.has(key)) {
    return;
  }
  visited.add(key);
  closure.set(key, {
    key,
    definition: canonicalizeAstNode(resolved.declaration),
  });
  collectReferencedSymbolClosures(
    resolved.declaration,
    sourceGraph,
    resolved.modulePath,
    closure,
    visited,
    context,
    excludedClosureKeys,
  );
}

function collectReferencedSymbolClosures(
  node,
  sourceGraph,
  modulePath,
  closure,
  visited,
  context,
  excludedClosureKeys = new Set(),
) {
  walkAst(node, (candidate) => {
    if (!ts.isIdentifier(candidate) || shouldIgnoreReferenceIdentifier(candidate, node)) {
      return;
    }
    const resolved = resolveSourceSymbol(sourceGraph, modulePath, candidate.text, new Set());
    if (resolved?.kind === "declaration") {
      collectSymbolClosure(
        sourceGraph,
        modulePath,
        candidate.text,
        closure,
        visited,
        context,
        false,
        excludedClosureKeys,
      );
    }
  });
}

function resolveSourceSymbol(sourceGraph, modulePath, symbolName, resolving) {
  const resolutionKey = `${modulePath}#${symbolName}`;
  if (resolving.has(resolutionKey)) {
    return null;
  }
  resolving.add(resolutionKey);
  const sourceFile = getSourceGraphFile(sourceGraph, modulePath);
  const declaration = findTopLevelSymbolDeclaration(sourceFile, symbolName);
  if (declaration) {
    return { kind: "declaration", modulePath, symbolName, declaration };
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }
    let importedName;
    if (importClause.name?.text === symbolName) {
      importedName = "default";
    }
    const bindings = importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const element = bindings.elements.find((candidate) => candidate.name.text === symbolName);
      if (element) {
        importedName = (element.propertyName ?? element.name).text;
      }
    }
    if (!importedName) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const targetPath = resolveModuleSourcePath(sourceGraph, modulePath, moduleSpecifier);
    if (!targetPath) {
      return { kind: "external", modulePath: moduleSpecifier, symbolName: importedName };
    }
    return resolveSourceSymbol(sourceGraph, targetPath, importedName, resolving);
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const targetPath = resolveModuleSourcePath(sourceGraph, modulePath, moduleSpecifier);
    if (!targetPath) {
      continue;
    }
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const element = statement.exportClause.elements.find((candidate) => candidate.name.text === symbolName);
      if (!element) {
        continue;
      }
      return resolveSourceSymbol(
        sourceGraph,
        targetPath,
        (element.propertyName ?? element.name).text,
        new Set(resolving),
      );
    }
    if (!statement.exportClause) {
      const resolved = resolveSourceSymbol(sourceGraph, targetPath, symbolName, new Set(resolving));
      if (resolved) {
        return resolved;
      }
    }
  }
  return null;
}

function getSourceGraphFile(sourceGraph, sourcePath) {
  const normalizedPath = normalizeSourcePath(sourcePath);
  const cached = sourceGraph.sourceFiles.get(normalizedPath);
  if (cached) {
    return cached;
  }
  const source = sourceGraph.sourceTexts.get(normalizedPath);
  if (source === undefined) {
    throw new Error(`TypeScript source is not available to the migration verifier: ${normalizedPath}`);
  }
  const sourceFile = parseTypeScriptSource(source, normalizedPath);
  sourceGraph.sourceFiles.set(normalizedPath, sourceFile);
  return sourceFile;
}

function findTopLevelSymbolDeclaration(sourceFile, symbolName) {
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name?.text === symbolName
    ) {
      return statement;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === symbolName) {
          return declaration;
        }
      }
    }
  }
  return null;
}

function resolveRelativeSourcePath(sourceGraph, fromSourcePath, moduleSpecifier) {
  const fromDirectory = path.posix.dirname(normalizeSourcePath(fromSourcePath));
  const joined = path.posix.normalize(path.posix.join(fromDirectory, moduleSpecifier));
  const candidates = [
    joined,
    joined.replace(/\.(?:c|m)?js$/u, ".ts"),
    `${joined}.ts`,
    path.posix.join(joined, "index.ts"),
  ];
  return candidates.find((candidate) => sourceGraph.sourceTexts.has(candidate)) ?? null;
}

function resolveModuleSourcePath(sourceGraph, fromSourcePath, moduleSpecifier) {
  if (moduleSpecifier.startsWith(".")) {
    const resolved = resolveRelativeSourcePath(sourceGraph, fromSourcePath, moduleSpecifier);
    if (!resolved) {
      throw new Error(
        `Relative source imported from ${moduleSpecifier} in ${fromSourcePath} is not available to the migration verifier.`,
      );
    }
    return resolved;
  }
  const workspaceEntrypoint = WORKSPACE_PACKAGE_SOURCE_ENTRYPOINTS[moduleSpecifier];
  if (!workspaceEntrypoint) {
    if (moduleSpecifier.startsWith("@goatcitadel/")) {
      throw new Error(
        `Workspace source package ${moduleSpecifier} imported from ${fromSourcePath} is not configured in the migration verifier.`,
      );
    }
    return null;
  }
  if (!sourceGraph.sourceTexts.has(workspaceEntrypoint)) {
    throw new Error(
      `Workspace source imported from ${moduleSpecifier} in ${fromSourcePath} is not available to the migration verifier.`,
    );
  }
  return workspaceEntrypoint;
}

function shouldIgnoreReferenceIdentifier(identifier, root) {
  const parent = identifier.parent;
  if (!parent) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === identifier) ||
    ((ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent)) &&
      parent.name === identifier) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  ) {
    return true;
  }
  let current = identifier;
  while (current && current !== root) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function walkAst(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => {
    walkAst(child, visitor);
  });
}

function resolveStaticStringExpression(expression, sourceFile, resolving = new Set()) {
  const candidate = unwrapExpression(expression);
  if (isStaticStringExpression(candidate)) {
    return candidate.text;
  }
  if (ts.isTemplateExpression(candidate)) {
    let resolved = candidate.head.text;
    for (const span of candidate.templateSpans) {
      const expressionValue = resolveStaticPrimitiveExpression(span.expression, sourceFile, resolving);
      if (expressionValue === null) {
        return null;
      }
      resolved += expressionValue + span.literal.text;
    }
    return resolved;
  }
  if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticPrimitiveExpression(candidate.left, sourceFile, resolving);
    const right = resolveStaticPrimitiveExpression(candidate.right, sourceFile, resolving);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(candidate)) {
    if (resolving.has(candidate.text)) {
      return null;
    }
    const declaration = findTopLevelVariableDeclaration(sourceFile, candidate.text);
    if (!declaration?.initializer || !isConstVariableDeclaration(declaration)) {
      return null;
    }
    const nextResolving = new Set(resolving).add(candidate.text);
    return resolveStaticStringExpression(declaration.initializer, sourceFile, nextResolving);
  }
  return null;
}

function resolveStaticPrimitiveExpression(expression, sourceFile, resolving) {
  const candidate = unwrapExpression(expression);
  const stringValue = resolveStaticStringExpression(candidate, sourceFile, resolving);
  if (stringValue !== null) {
    return stringValue;
  }
  if (ts.isNumericLiteral(candidate)) {
    return candidate.text;
  }
  if (candidate.kind === ts.SyntaxKind.TrueKeyword) {
    return "true";
  }
  if (candidate.kind === ts.SyntaxKind.FalseKeyword) {
    return "false";
  }
  return null;
}

function isConstVariableDeclaration(declaration) {
  return Boolean(declaration.parent.flags & ts.NodeFlags.Const);
}

function hashRuntimePayload(payload) {
  return crypto.createHash("sha256").update(payload.replace(/\r\n/gu, "\n")).digest("hex");
}

function hashCanonicalValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeSourcePath(sourcePath) {
  return sourcePath.replaceAll("\\", "/");
}

function parseTypeScriptSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const compilerOptions = {
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const compilerHost = {
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "",
    getNewLine: () => "\n",
    getSourceFile: (candidate) => (candidate === fileName ? sourceFile : undefined),
    readFile: (candidate) => (candidate === fileName ? source : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {
      throw new Error("Storage migration syntax validation must never emit files.");
    },
  };
  const program = ts.createProgram([fileName], compilerOptions, compilerHost);
  const programSourceFile = program.getSourceFile(fileName);
  if (programSourceFile !== sourceFile) {
    throw new Error(`${fileName} could not be parsed as TypeScript: syntax diagnostics were unavailable.`);
  }
  const diagnostics = program.getSyntacticDiagnostics(programSourceFile);
  if (!Array.isArray(diagnostics)) {
    throw new Error(`${fileName} could not be parsed as TypeScript: syntax diagnostics were unavailable.`);
  }
  if (diagnostics.length > 0) {
    const detail = diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join("; ");
    throw new Error(`${fileName} could not be parsed as TypeScript: ${detail}`);
  }
  return sourceFile;
}

function requireTopLevelArrayRegistry(sourceFile, registryName) {
  const declaration = findTopLevelVariableDeclaration(sourceFile, registryName, true);
  if (!declaration.initializer) {
    throw new Error(`${registryName} must have a direct array literal initializer.`);
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`${registryName} must have a direct array literal initializer.`);
  }
  rejectSpreadElements(initializer, registryName);
  return initializer;
}

function findTopLevelVariableDeclaration(sourceFile, variableName, requireExactlyOne = false) {
  const matches = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName) {
        matches.push(declaration);
      }
    }
  }
  if (requireExactlyOne && matches.length !== 1) {
    throw new Error(`${variableName} must have exactly one top-level declaration; found ${matches.length}.`);
  }
  return matches[0];
}

function extractPostgresMigrationNodes(source, sourcePath) {
  const sourceFile = parseTypeScriptSource(source, sourcePath);
  const registry = requireTopLevelArrayRegistry(sourceFile, "POSTGRES_MIGRATIONS");
  const migrations = registry.elements.map((element, index) => {
    const context = `POSTGRES_MIGRATIONS migration ${index}`;
    const node = requireDirectObject(element, context);
    return { node, properties: readObjectProperties(node, context) };
  });
  return { sourceFile, migrations };
}

function requireDirectObject(element, context) {
  if (ts.isSpreadElement(element)) {
    throw new Error(`${context} cannot use a spread element; every definition must be direct and inspectable.`);
  }
  const expression = unwrapExpression(element);
  if (!ts.isObjectLiteralExpression(expression)) {
    throw new Error(`${context} must be a direct object literal.`);
  }
  return expression;
}

function readObjectProperties(object, context) {
  const properties = new Map();
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error(`${context} cannot use a spread property; every definition must be direct and inspectable.`);
    }
    const name = readStaticPropertyName(property.name, context);
    if (properties.has(name)) {
      throw new Error(`${context} property is duplicated: ${name}`);
    }
    properties.set(name, property);
  }
  return properties;
}

function readStaticPropertyName(name, context) {
  if (!name || ts.isComputedPropertyName(name)) {
    throw new Error(`${context} contains a dynamic or missing property name.`);
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error(`${context} contains an unsupported property name.`);
}

function readStaticVersionProperty(properties, context) {
  const property = requireExplicitProperty(properties, "version", context);
  const initializer = unwrapExpression(requirePropertyAssignmentInitializer(property, "version", context));
  if (!ts.isNumericLiteral(initializer)) {
    throw new Error(`${context} version must be an explicit positive integer numeric literal.`);
  }
  const version = Number(initializer.text);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`${context} version must be an explicit positive integer numeric literal.`);
  }
  return version;
}

function readStaticStringProperty(properties, propertyName, context) {
  const property = requireExplicitProperty(properties, propertyName, context);
  const initializer = requirePropertyAssignmentInitializer(property, propertyName, context);
  return readStaticString(initializer, `${context} ${propertyName}`);
}

function readStaticString(expression, context) {
  const value = unwrapExpression(expression);
  if (!isStaticStringExpression(value)) {
    throw new Error(`${context} must be a static string literal.`);
  }
  return value.text;
}

function isStaticStringExpression(expression) {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression);
}

function requireArrayProperty(properties, propertyName, context) {
  const property = requireExplicitProperty(properties, propertyName, context);
  if (!ts.isPropertyAssignment(property)) {
    throw new Error(`${context} ${propertyName} must be a direct array literal.`);
  }
  const initializer = unwrapExpression(requirePropertyAssignmentInitializer(property, propertyName, context));
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`${context} ${propertyName} must be a direct array literal.`);
  }
  rejectSpreadElements(initializer, `${context} ${propertyName}`);
  return initializer;
}

function rejectSpreadElements(array, context) {
  if (array.elements.some((element) => ts.isSpreadElement(element))) {
    throw new Error(`${context} cannot contain spread elements; every definition must be direct and inspectable.`);
  }
}

function requireExplicitProperty(properties, propertyName, context) {
  const property = properties.get(propertyName);
  if (!property) {
    throw new Error(`${context} is missing required property: ${propertyName}`);
  }
  return property;
}

function requirePropertyAssignmentInitializer(property, propertyName, context) {
  if (!ts.isPropertyAssignment(property)) {
    const requirement = propertyName === "version" ? "an explicit numeric literal" : "an explicit value";
    throw new Error(`${context} ${propertyName} must use a property assignment with ${requirement}.`);
  }
  return property.initializer;
}

function getPropertyInitializer(properties, propertyName) {
  const property = properties.get(propertyName);
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function hashDefinitionNode(node) {
  const canonicalDefinition = JSON.stringify(canonicalizeAstNode(node));
  return crypto.createHash("sha256").update(canonicalDefinition).digest("hex");
}

function canonicalizeAstNode(node) {
  const structure = canonicalizeAstStructure(node);
  const sourceFile = node.getSourceFile();
  const source = sourceFile.text.slice(node.getStart(sourceFile, false), node.end);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  const templateExpressions = [];
  while (true) {
    let token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) {
      break;
    }
    if (token === ts.SyntaxKind.TemplateHead) {
      tokens.push([token, scanner.getTokenText()]);
      templateExpressions.push({ braceDepth: 0 });
      continue;
    }
    const activeTemplate = templateExpressions.at(-1);
    if (activeTemplate && token === ts.SyntaxKind.OpenBraceToken) {
      activeTemplate.braceDepth += 1;
    } else if (activeTemplate && token === ts.SyntaxKind.CloseBraceToken) {
      if (activeTemplate.braceDepth > 0) {
        activeTemplate.braceDepth -= 1;
      } else {
        token = scanner.reScanTemplateToken(false);
        tokens.push([token, scanner.getTokenText()]);
        if (token === ts.SyntaxKind.TemplateTail) {
          templateExpressions.pop();
        }
        continue;
      }
    }
    tokens.push([token, scanner.getTokenText()]);
  }
  const canonicalTokens = tokens.filter(([token], index) => {
    if (token !== ts.SyntaxKind.CommaToken) {
      return true;
    }
    const nextToken = tokens[index + 1]?.[0];
    return ![ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseParenToken].includes(
      nextToken,
    );
  });
  return { structure, tokens: canonicalTokens };
}

function canonicalizeAstStructure(node) {
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(canonicalizeAstStructure(child));
  });
  let value = null;
  if (
    ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isJsxText(node)
  ) {
    value = node.text;
  }
  return [node.kind, value, children];
}

function finalizeRegistry({ dialect, sourcePath, registryName, migrations, requireContiguousFromOne }) {
  if (migrations.length === 0) {
    throw new Error(`${registryName} must contain at least one direct migration definition.`);
  }
  const seenVersions = new Set();
  for (const migration of migrations) {
    if (seenVersions.has(migration.version)) {
      throw new Error(`${registryName} migration version is duplicated: ${migration.version}`);
    }
    seenVersions.add(migration.version);
  }
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index].version <= migrations[index - 1].version) {
      throw new Error(`${registryName} migration versions must be strictly increasing.`);
    }
  }
  if (requireContiguousFromOne) {
    for (const [index, migration] of migrations.entries()) {
      const expectedVersion = index + 1;
      if (migration.version !== expectedVersion) {
        throw new Error(
          `${registryName} migration versions must be contiguous from 1: expected ${expectedVersion}, found ${migration.version}.`,
        );
      }
    }
  }
  return {
    dialect,
    sourcePath,
    registryName,
    firstVersion: migrations[0].version,
    lastVersion: migrations.at(-1).version,
    migrations,
  };
}

function toManifestSource(registry) {
  const migrations = registry.migrations.map((migration) => {
    if (registry.dialect === "sqlite") {
      return {
        version: migration.version,
        name: migration.name,
        groupName: migration.groupName,
        definitionSha256: migration.definitionSha256,
        implementationSha256: migration.implementationSha256,
      };
    }
    const record = {
      version: migration.version,
      name: migration.name,
      definitionSha256: migration.definitionSha256,
    };
    if (migration.sqlPayloadSha256) {
      record.sqlPayloadSha256 = migration.sqlPayloadSha256;
    }
    if (migration.runtimeIntegritySha256) {
      record.runtimeIntegritySha256 = migration.runtimeIntegritySha256;
    }
    return record;
  });
  return {
    path: registry.sourcePath,
    registryName: registry.registryName,
    expectedCount: migrations.length,
    expectedFirstVersion: migrations[0]?.version ?? null,
    expectedLastVersion: migrations.at(-1)?.version ?? null,
    migrations,
  };
}

function requirePostgresV2BootstrapRecord(postgres) {
  const v2 = postgres.migrations.find((migration) => migration.version === 2);
  if (!v2 || v2.name !== "canonical_runtime_schema") {
    throw new Error("Postgres migration v2 must remain the canonical_runtime_schema dynamic bootstrap.");
  }
}

function buildPostgresV2OwnerProvenance(options) {
  for (const field of ["runtimeSchemaSource", "runtimeSchemaInternalSource", "sqliteSource"]) {
    if (typeof options[field] !== "string") {
      throw new Error(`Postgres v2 owner provenance requires ${field}.`);
    }
  }
  const runtimeSchema = parseTypeScriptSource(
    options.runtimeSchemaSource,
    "packages/storage/src/postgres/runtime-schema.ts",
  );
  const runtimeSchemaInternal = parseTypeScriptSource(
    options.runtimeSchemaInternalSource,
    "packages/storage/src/postgres/runtime-schema.internal.ts",
  );
  const sqlite = parseTypeScriptSource(options.sqliteSource, SQLITE_MIGRATION_SOURCE_PATH);
  const sqliteSourceGraph = createSourceGraph(SQLITE_MIGRATION_SOURCE_PATH, options.sqliteSource, options.sourceFiles);
  const createBlueprint = findTopLevelSymbolDeclaration(sqlite, "createSqliteSchemaBlueprint");
  const createBlueprintFromDatabase = findTopLevelSymbolDeclaration(sqlite, "createSqliteSchemaBlueprintFromDatabase");
  if (!createBlueprint || !createBlueprintFromDatabase) {
    throw new Error(
      "Postgres v2 owner provenance requires direct createSqliteSchemaBlueprint and createSqliteSchemaBlueprintFromDatabase definitions.",
    );
  }
  return {
    runtimeSchemaModuleSha256: hashDefinitionNode(runtimeSchema),
    runtimeSchemaInternalModuleSha256: hashDefinitionNode(runtimeSchemaInternal),
    createSqliteSchemaBlueprintSha256: hashDefinitionNode(createBlueprint),
    createSqliteSchemaBlueprintFromDatabaseClosureSha256: hashSourceSymbolClosure(
      sqliteSourceGraph,
      SQLITE_MIGRATION_SOURCE_PATH,
      "createSqliteSchemaBlueprintFromDatabase",
      "Postgres v2 SQLite blueprint extraction",
      {
        excludedClosureKeys: new Set([`${SQLITE_MIGRATION_SOURCE_PATH}#SCHEMA_MIGRATION_GROUPS`]),
      },
    ),
  };
}

function requirePostgresV2OwnerProvenance(postgres) {
  const provenance = postgres.v2OwnerProvenance;
  const fields = [
    "runtimeSchemaModuleSha256",
    "runtimeSchemaInternalModuleSha256",
    "createSqliteSchemaBlueprintSha256",
    "createSqliteSchemaBlueprintFromDatabaseClosureSha256",
  ];
  if (
    !provenance ||
    fields.some((field) => typeof provenance[field] !== "string" || !/^[a-f0-9]{64}$/u.test(provenance[field]))
  ) {
    throw new Error("Postgres v2 dynamic bootstrap requires complete owner provenance digests.");
  }
  return Object.fromEntries(fields.map((field) => [field, provenance[field]]));
}

function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

function findFirstDifference(expected, actual, path) {
  if (Object.is(expected, actual)) {
    return null;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${path} has the wrong value type`;
    }
    if (expected.length !== actual.length) {
      return `${path} expected ${expected.length} entries, found ${actual.length}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = findFirstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) {
        return difference;
      }
    }
    return null;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") {
      return `${path} has the wrong value type`;
    }
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.join("\n") !== actualKeys.join("\n")) {
      return `${path} keys differ`;
    }
    for (const key of expectedKeys) {
      const difference = findFirstDifference(expected[key], actual[key], `${path}.${key}`);
      if (difference) {
        return difference;
      }
    }
    return null;
  }
  return `${path} expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`;
}

function validateExistingManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Existing storage migration manifest is missing or malformed.");
  }
  const sqliteSource = manifest.sources?.sqlite;
  const postgresSource = manifest.sources?.postgres;
  if (
    !sqliteSource ||
    !postgresSource ||
    !Array.isArray(sqliteSource.migrations) ||
    !Array.isArray(postgresSource.migrations)
  ) {
    throw new Error("Existing storage migration manifest is missing complete SQLite/Postgres migration arrays.");
  }
  const sqliteRegistry = manifestSourceToRegistry("sqlite", sqliteSource);
  const postgresRegistry = manifestSourceToRegistry("postgres", postgresSource);
  postgresRegistry.v2OwnerProvenance = manifest.exceptions?.find(
    (exception) => exception?.dialect === "postgres" && exception?.version === 2,
  )?.ownerProvenance;
  const rebuilt = createStorageMigrationManifest({ sqlite: sqliteRegistry, postgres: postgresRegistry });
  if (canonicalJson(rebuilt) !== canonicalJson(manifest)) {
    const difference = findFirstDifference(rebuilt, manifest, "manifest");
    throw new Error(
      `Existing storage migration manifest metadata or exception drifted${difference ? `: ${difference}` : "."}`,
    );
  }
  return rebuilt;
}

function manifestSourceToRegistry(dialect, source) {
  const migrations = source.migrations.map((migration) => ({ ...migration }));
  return {
    dialect,
    sourcePath: source.path,
    registryName: source.registryName,
    firstVersion: migrations[0]?.version,
    lastVersion: migrations.at(-1)?.version,
    migrations,
  };
}

function assertAppendOnlyRegistry(label, existingMigrations, currentMigrations) {
  if (currentMigrations.length < existingMigrations.length) {
    throw new Error(`Removed an existing ${label} migration; the manifest updater is append-only.`);
  }
  for (const [index, existing] of existingMigrations.entries()) {
    const current = currentMigrations[index];
    if (canonicalJson(existing) !== canonicalJson(current)) {
      throw new Error(
        `Existing ${label} migration v${existing.version ?? index + 1} drifted; author a new forward migration instead.`,
      );
    }
  }
  const previousVersion = existingMigrations.at(-1)?.version ?? 0;
  for (const [offset, migration] of currentMigrations.slice(existingMigrations.length).entries()) {
    const expectedVersion = previousVersion + offset + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `New ${label} migrations must be a contiguous suffix: expected v${expectedVersion}, found v${migration.version}.`,
      );
    }
  }
}

function isParityMigrationName(name) {
  return name.endsWith("_parity") || name.includes("_parity_");
}

function hasNamedImport(sourceFile, moduleName, importedName) {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => (element.propertyName ?? element.name).text === importedName)
    );
  });
}

function findMigrationNodeByVersion(migrations, expectedVersion) {
  return migrations.find(({ properties }) => {
    try {
      return readStaticVersionProperty(properties, "POSTGRES_MIGRATIONS semantic ownership") === expectedVersion;
    } catch {
      return false;
    }
  });
}

function isZeroArgumentIdentifierCall(expression, identifierName) {
  const candidate = unwrapExpression(expression);
  return (
    ts.isCallExpression(candidate) &&
    candidate.arguments.length === 0 &&
    ts.isIdentifier(candidate.expression) &&
    candidate.expression.text === identifierName
  );
}

function containsIdentifier(node, identifierName) {
  return containsNode(node, (candidate) => ts.isIdentifier(candidate) && candidate.text === identifierName);
}

function containsCallNamed(node, functionName) {
  return containsNode(
    node,
    (candidate) =>
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === functionName,
  );
}

function containsNode(node, predicate) {
  if (predicate(node)) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsNode(child, predicate)) {
      found = true;
    }
  });
  return found;
}

function findFunctionDeclaration(sourceFile, functionName) {
  return sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
  );
}

function containsBlueprintRenderCall(functionDeclaration) {
  return containsNode(functionDeclaration, (candidate) => {
    if (
      !ts.isCallExpression(candidate) ||
      !ts.isIdentifier(candidate.expression) ||
      candidate.expression.text !== "buildPostgresRuntimeSchemaSqlFromBlueprint" ||
      candidate.arguments.length !== 1
    ) {
      return false;
    }
    return isZeroArgumentIdentifierCall(candidate.arguments[0], "createSqliteSchemaBlueprint");
  });
}

function containsTablePropertyAccess(sourceFile, propertyName) {
  return containsNode(
    sourceFile,
    (candidate) =>
      ts.isPropertyAccessExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === "table" &&
      candidate.name.text === propertyName,
  );
}
