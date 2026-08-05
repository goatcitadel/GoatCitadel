import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const GATEWAY_SOURCE_RELATIVE_PATH = "apps/gateway/src";
const TYPESCRIPT_SOURCE_PATTERN = /\.(?:cts|mts|tsx?|d\.ts)$/u;
const TYPESCRIPT_TEST_PATTERN = /\.(?:test|spec)\.(?:cts|mts|tsx?)$/u;

export const APPROVED_POSTGRES_STORAGE_FACTORY_PATHS = new Set([
  "apps/gateway/src/storage-factory.ts",
]);

export const APPROVED_POSTGRES_NATIVE_CLIENT_PATHS = new Set([
  "apps/gateway/src/async-database-factory.ts",
  "apps/gateway/src/bundled-postgres-runtime.ts",
  "apps/gateway/src/services/database-cutover-service.ts",
]);

const APPROVED_POSTGRES_ASYNC_ADAPTER_PATHS = new Set([
  "apps/gateway/src/async-database-factory.ts",
]);

const POSTGRES_NATIVE_CLIENT_NAME = "PostgresDatabaseClient";
const POSTGRES_ASYNC_ADAPTER_NAME = "PostgresAsyncDatabaseClient";
const POSTGRES_CONSTRUCTOR_NAMES = new Set([POSTGRES_NATIVE_CLIENT_NAME, POSTGRES_ASYNC_ADAPTER_NAME]);
const POSTGRES_STORAGE_FACTORY_NAMES = new Set(["createPostgresRemoteStorage"]);
const SYNC_CLIENT_NAME = "PostgresSyncDatabaseClient";
const OWNED_BACKGROUND_PROMISE_CALL_NAMES = new Set([
  "registerBackgroundTask",
  "trackBackgroundTask",
]);

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizeAbsolutePath(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/").toLowerCase();
}

function pathIsWithin(filePath, directoryPath) {
  const normalizedFile = normalizeAbsolutePath(filePath);
  const normalizedDirectory = `${normalizeAbsolutePath(directoryPath).replace(/\/$/u, "")}/`;
  return normalizedFile.startsWith(normalizedDirectory);
}

function unwrapExpression(expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

export function isGatewayProductionTypeScriptPath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  return TYPESCRIPT_SOURCE_PATTERN.test(normalized) && !TYPESCRIPT_TEST_PATTERN.test(normalized);
}

function moduleSpecifierFromNode(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier : undefined;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  if (!ts.isCallExpression(node) || node.arguments.length < 1 || !ts.isStringLiteralLike(node.arguments[0])) {
    return undefined;
  }
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") return node.arguments[0];
  return undefined;
}

function isPostgresSyncModule(moduleSpecifier) {
  const normalized = moduleSpecifier.replaceAll("\\", "/").replace(/[?#].*$/u, "");
  return /(?:^|\/)postgres\/sync(?:\.[cm]?[jt]s)?$/u.test(normalized) ||
    /(?:^|\/)postgres-sync(?:\.[cm]?[jt]s)?$/u.test(normalized);
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function accessedProperty(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return { owner: expression.expression, name: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const argument = expression.argumentExpression;
    if (ts.isStringLiteralLike(argument)) return { owner: expression.expression, name: argument.text };
  }
  return undefined;
}

function isGlobalAtomicsExpression(expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  if (ts.isIdentifier(expression)) return expression.text === "Atomics";
  const access = accessedProperty(expression);
  return (
    access?.name === "Atomics" &&
    ts.isIdentifier(access.owner) &&
    (access.owner.text === "globalThis" || access.owner.text === "global")
  );
}

function isAtomicsWaitCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const access = accessedProperty(node.expression);
  return access?.name === "wait" && isGlobalAtomicsExpression(access.owner);
}

function importBindings(sourceFile) {
  const constructorAliases = new Set(POSTGRES_CONSTRUCTOR_NAMES);
  const postgresStorageFactoryAliases = new Set(POSTGRES_STORAGE_FACTORY_NAMES);
  const storageConstructorAliases = new Set(["Storage"]);
  const storageNamespaceAliases = new Set();

  const registerNamedBinding = (importedName, localName) => {
    if (POSTGRES_CONSTRUCTOR_NAMES.has(importedName)) constructorAliases.add(localName);
    if (POSTGRES_STORAGE_FACTORY_NAMES.has(importedName)) postgresStorageFactoryAliases.add(localName);
    if (importedName === "Storage") storageConstructorAliases.add(localName);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        storageNamespaceAliases.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          registerNamedBinding(element.propertyName?.text ?? element.name.text, element.name.text);
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      node.initializer.arguments[0] &&
      ts.isStringLiteralLike(node.initializer.arguments[0])
    ) {
      if (ts.isIdentifier(node.name)) {
        storageNamespaceAliases.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          registerNamedBinding(propertyNameText(element.propertyName) ?? element.name.text, element.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    constructorAliases,
    postgresStorageFactoryAliases,
    storageConstructorAliases,
    storageNamespaceAliases,
  };
}

function calledName(expression, aliases, namespaceAliases) {
  if (ts.isIdentifier(expression)) return aliases.has(expression.text) ? expression.text : undefined;
  const access = accessedProperty(expression);
  if (!access || !aliases.has(access.name)) return undefined;
  if (ts.isIdentifier(access.owner) && namespaceAliases.has(access.owner.text)) return access.name;
  return access.name;
}

function objectLiteralHasDatabaseProperty(expression) {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "db";
    return (
      (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      propertyNameText(property.name) === "db"
    );
  });
}

function directPostgresStorageConstruction(node, bindings) {
  if (ts.isNewExpression(node)) {
    const constructorName = calledName(
      node.expression,
      bindings.constructorAliases,
      bindings.storageNamespaceAliases,
    );
    if (constructorName) return { kind: "constructor", name: constructorName };

    const storageName = calledName(
      node.expression,
      bindings.storageConstructorAliases,
      bindings.storageNamespaceAliases,
    );
    if (storageName && objectLiteralHasDatabaseProperty(node.arguments?.[0])) {
      return { kind: "storage", name: `${storageName} with an explicit database client` };
    }
  }

  if (ts.isCallExpression(node)) {
    const factoryName = calledName(
      node.expression,
      bindings.postgresStorageFactoryAliases,
      bindings.storageNamespaceAliases,
    );
    if (factoryName) return { kind: "remote_storage", name: factoryName };
  }
  return undefined;
}

function approvedConstructionPaths(construction) {
  if (construction.kind === "remote_storage" || construction.kind === "storage") {
    return APPROVED_POSTGRES_STORAGE_FACTORY_PATHS;
  }
  if (construction.name === POSTGRES_NATIVE_CLIENT_NAME) return APPROVED_POSTGRES_NATIVE_CLIENT_PATHS;
  return APPROVED_POSTGRES_ASYNC_ADAPTER_PATHS;
}

function isExactPromiseType(checker, type) {
  if (type.isUnion()) {
    return type.types.some((member) => isExactPromiseType(checker, member));
  }
  const apparent = checker.getApparentType(type);
  const symbol = apparent.aliasSymbol ?? apparent.getSymbol();
  return symbol?.getName() === "Promise";
}

function callReturnsPromise(checker, call) {
  if (!isExactPromiseType(checker, checker.getTypeAtLocation(call))) return false;
  const declarationReturnType = checker.getResolvedSignature(call)?.declaration?.type;
  // Some callback APIs expose a union of callback and Promise parser shapes.
  // The contextual call type can consequently include Promise even when the
  // selected signature is explicitly void (Fastify's default JSON parser is
  // one such API). Honor that selected callback contract.
  return declarationReturnType?.kind !== ts.SyntaxKind.VoidKeyword;
}

function calledExpressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  return accessedProperty(expression)?.name;
}

function hasTerminalRejectionHandler(expression) {
  expression = unwrapExpression(expression);
  if (!ts.isCallExpression(expression)) return false;
  const access = accessedProperty(expression.expression);
  if (!access) return false;
  if (access.name === "catch" && expression.arguments.length >= 1) return true;
  if (access.name === "then" && expression.arguments.length >= 2) return true;
  return hasTerminalRejectionHandler(access.owner);
}

function promiseExpressionCall(expression) {
  expression = unwrapExpression(expression);
  if (ts.isVoidExpression(expression)) expression = unwrapExpression(expression.expression);
  return ts.isCallExpression(expression) ? expression : undefined;
}

function isOwnedBackgroundPromiseCall(node, child) {
  if (!ts.isCallExpression(node) || !node.arguments.includes(child)) return false;
  const name = calledExpressionName(node.expression);
  return name !== undefined && OWNED_BACKGROUND_PROMISE_CALL_NAMES.has(name);
}

function promiseVariableHasOwnedUse(checker, declaration, seenSymbols) {
  if (!ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol || seenSymbols.has(symbol)) return false;

  const nextSeenSymbols = new Set(seenSymbols);
  nextSeenSymbols.add(symbol);
  let owned = false;
  const visit = (node) => {
    if (owned) return;
    if (
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      checker.getSymbolAtLocation(node) === symbol &&
      isConsumedPromiseUse(checker, node, nextSeenSymbols)
    ) {
      owned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return owned;
}

function isConsumedPromiseUse(checker, node, seenSymbols = new Set()) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent)
    ) {
      current = parent;
      continue;
    }
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent) || ts.isYieldExpression(parent)) {
      return true;
    }
    if (ts.isArrowFunction(parent) && parent.body === current) {
      return true;
    }
    if (isOwnedBackgroundPromiseCall(parent, current)) {
      return true;
    }
    if (ts.isCallExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) {
      return hasTerminalRejectionHandler(current);
    }
    if (ts.isVariableDeclaration(parent)) {
      return (
        isExactPromiseType(checker, checker.getTypeAtLocation(parent.name)) &&
        promiseVariableHasOwnedUse(checker, parent, seenSymbols)
      );
    }
    if (ts.isPropertyAssignment(parent) || ts.isBinaryExpression(parent) || ts.isFunctionLike(parent)) {
      return false;
    }
    current = parent;
  }
  return false;
}

function resolvedCallSymbol(checker, call) {
  const expression = call.expression;
  let symbol;
  if (ts.isPropertyAccessExpression(expression)) {
    symbol = checker.getSymbolAtLocation(expression.name);
  } else if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    symbol = checker.getSymbolAtLocation(expression.argumentExpression);
  } else if (ts.isIdentifier(expression)) {
    symbol = checker.getSymbolAtLocation(expression);
  }
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function isStorageDeclaredPromiseCall(checker, call, storageRoot) {
  if (!callReturnsPromise(checker, call)) return false;
  const symbol = resolvedCallSymbol(checker, call);
  return Boolean(
    symbol?.declarations?.some((declaration) => pathIsWithin(declaration.getSourceFile().fileName, storageRoot)),
  );
}

export function scanGatewayPromiseUsage({ checker, sourceFile, filePath, repoRoot }) {
  const normalizedFilePath = normalizeRelativePath(filePath);
  const storageRoot = path.join(repoRoot, "packages", "storage");
  const diagnostics = [];
  const emitted = new Set();
  const floatingExpressionCalls = new Set();

  const emit = (code, node, message) => {
    const start = node.getStart(sourceFile, false);
    const key = `${code}:${start}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    diagnostics.push({
      code,
      filePath: normalizedFilePath,
      line: position.line + 1,
      column: position.character + 1,
      message,
    });
  };

  const visit = (node) => {
    if (ts.isExpressionStatement(node)) {
      const call = promiseExpressionCall(node.expression);
      if (
        call &&
        callReturnsPromise(checker, call) &&
        !hasTerminalRejectionHandler(call)
      ) {
        floatingExpressionCalls.add(call);
        emit(
          "floating_gateway_promise",
          call,
          "Promise-returning Gateway work must be awaited, returned, task-owned, or terminated with an explicit rejection handler.",
        );
      }
    }

    if (
      ts.isCallExpression(node) &&
      !floatingExpressionCalls.has(node) &&
      isStorageDeclaredPromiseCall(checker, node, storageRoot) &&
      !isConsumedPromiseUse(checker, node)
    ) {
      emit(
        "unconsumed_async_storage_call",
        node,
        "Promise-native storage work must cross an explicit await, return, Promise owner, or handled background boundary.",
      );
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return diagnostics.sort(
    (left, right) => left.line - right.line || left.column - right.column || left.code.localeCompare(right.code),
  );
}

export function scanGatewaySource({
  source,
  filePath,
  approvedFactoryPaths,
}) {
  const normalizedFilePath = normalizeRelativePath(filePath);
  const sourceFile = ts.createSourceFile(
    normalizedFilePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    normalizedFilePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = importBindings(sourceFile);
  const diagnostics = [];
  const emitted = new Set();

  const emit = (code, node, message) => {
    const start = node.getStart(sourceFile, false);
    const key = `${code}:${start}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    diagnostics.push({
      code,
      filePath: normalizedFilePath,
      line: position.line + 1,
      column: position.character + 1,
      message,
    });
  };

  for (const parseDiagnostic of sourceFile.parseDiagnostics ?? []) {
    const start = parseDiagnostic.start ?? 0;
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    diagnostics.push({
      code: "typescript_parse_error",
      filePath: normalizedFilePath,
      line: position.line + 1,
      column: position.character + 1,
      message: ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, " "),
    });
  }

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === SYNC_CLIENT_NAME) {
      emit(
        "postgres_sync_client_reference",
        node,
        `${SYNC_CLIENT_NAME} is forbidden in Gateway production source; use the Promise-based storage boundary.`,
      );
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === SYNC_CLIENT_NAME
    ) {
      emit(
        "postgres_sync_client_reference",
        node,
        `${SYNC_CLIENT_NAME} is forbidden in Gateway production source; use the Promise-based storage boundary.`,
      );
    }

    const moduleSpecifier = moduleSpecifierFromNode(node);
    if (moduleSpecifier && isPostgresSyncModule(moduleSpecifier.text)) {
      emit(
        "postgres_sync_module_import",
        moduleSpecifier,
        `PostgreSQL sync module import is forbidden in Gateway production source: ${JSON.stringify(moduleSpecifier.text)}.`,
      );
    }

    if (isAtomicsWaitCall(node)) {
      emit(
        "atomics_wait_call",
        node.expression,
        "Atomics.wait is forbidden in Gateway production source because it blocks the owning event loop.",
      );
    }

    const construction = directPostgresStorageConstruction(node, bindings);
    if (construction) {
      const approvedPaths = approvedFactoryPaths ?? approvedConstructionPaths(construction);
      if (!approvedPaths.has(normalizedFilePath)) {
        emit(
          "postgres_storage_construction_outside_factory",
          node,
          `Direct PostgreSQL storage construction (${construction.name}) is only allowed in ${[
            ...approvedPaths,
          ].join(" or ")}.`,
        );
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return diagnostics.sort(
    (left, right) => left.line - right.line || left.column - right.column || left.code.localeCompare(right.code),
  );
}

async function listProductionTypeScriptFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) return listProductionTypeScriptFiles(absolutePath);
      return entry.isFile() && isGatewayProductionTypeScriptPath(entry.name) ? [absolutePath] : [];
    }),
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

function readGatewayProgram(repoRoot, sourceFiles) {
  const configPath = path.join(repoRoot, "apps", "gateway", "tsconfig.json");
  if (ts.sys.fileExists(configPath)) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
    }
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    if (parsed.errors.length > 0) {
      throw new Error(
        parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"),
      );
    }
    const rootNames = [...new Set([...parsed.fileNames, ...sourceFiles])];
    return ts.createProgram({
      // The filesystem walk defines the enforcement boundary. Include every
      // production source even if a future tsconfig include/exclude change
      // would otherwise make the type-aware half of the check silently skip it.
      rootNames,
      options: { ...parsed.options, noEmit: true },
      projectReferences: parsed.projectReferences,
    });
  }
  return ts.createProgram({
    rootNames: sourceFiles,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
      noEmit: true,
      skipLibCheck: true,
    },
  });
}

function findProgramSourceFile(program, absolutePath) {
  const normalizedTarget = normalizeAbsolutePath(absolutePath);
  return program.getSourceFiles().find((sourceFile) => normalizeAbsolutePath(sourceFile.fileName) === normalizedTarget);
}

export async function verifyAsyncGatewayBoundary({ repoRoot = process.cwd() } = {}) {
  const gatewaySourcePath = path.join(repoRoot, ...GATEWAY_SOURCE_RELATIVE_PATH.split("/"));
  const sourceFiles = await listProductionTypeScriptFiles(gatewaySourcePath);
  const syntaxResults = await Promise.all(
    sourceFiles.map(async (absolutePath) => {
      const filePath = normalizeRelativePath(path.relative(repoRoot, absolutePath));
      const source = await fs.readFile(absolutePath, "utf8");
      return scanGatewaySource({ source, filePath });
    }),
  );
  const program = readGatewayProgram(repoRoot, sourceFiles);
  const checker = program.getTypeChecker();
  const promiseResults = sourceFiles.map((absolutePath) => {
    const sourceFile = findProgramSourceFile(program, absolutePath);
    if (!sourceFile) {
      throw new Error(`Type-aware Gateway boundary scan could not load ${path.relative(repoRoot, absolutePath)}.`);
    }
    return scanGatewayPromiseUsage({
      checker,
      sourceFile,
      filePath: normalizeRelativePath(path.relative(repoRoot, absolutePath)),
      repoRoot,
    });
  });
  const diagnostics = [...syntaxResults, ...promiseResults]
    .flat()
    .sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) ||
        left.line - right.line ||
        left.column - right.column ||
        left.code.localeCompare(right.code),
    );
  return { diagnostics, filesScanned: sourceFiles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyAsyncGatewayBoundary();
    if (result.diagnostics.length > 0) {
      console.error("Async Gateway boundary check failed:");
      for (const diagnostic of result.diagnostics) {
        console.error(
          `- ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} [${diagnostic.code}] ${diagnostic.message}`,
        );
      }
      process.exitCode = 1;
    } else {
      console.log(
        `Async Gateway boundary check passed (${result.filesScanned} production TypeScript files scanned).`,
      );
    }
  } catch (error) {
    console.error("Async Gateway boundary check failed:");
    console.error(`- ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
