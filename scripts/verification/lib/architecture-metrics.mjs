import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { repoRoot } from "./shared.mjs";

function getArchitectureBaselinePath(rootDir = repoRoot) {
  return path.join(rootDir, "scripts", "verification", "baselines", "architecture-metrics.json");
}

const ARCHITECTURE_BASELINE_PATH = getArchitectureBaselinePath(repoRoot);
const ARCHITECTURE_BASELINE_SCHEMA_VERSION = 2;
const GUARDED_BASELINE_SCALAR_KEYS = [
  "gatewayLineCount",
  "gatewayPublicMethodCount",
  "gatewayServiceImportConsumerCount",
  "fastifyGatewayCallSites",
  "gatewayInternalPublicCount",
  "gatewayRuntimePortFullStorageCount",
  "gatewayRuntimeFactoryRawServiceReturnCount",
  "fastifyGatewayRuntimeStorageAccessCount",
  "boundGatewayRoutePortMethodCount",
  "chatTurnRuntimeConstructedWithGatewayCount",
  "fastifyGatewayDecoratorReferenceCount",
  "serviceContextConsumerCount",
  "gatewayRouteCompositionUnsafeCastCount",
  "gatewayRouteCompositionAnyAliasCount",
  "gatewayRouteCompositionWideningCount",
  "gatewayRouteCompositionVariadicAnyMethodCount",
  "gatewayRouteCompositionFactoryExternalConsumerCount",
  "gatewayRouteCompositionPortMemberCount",
  "legacyRouteServiceFactoryVariadicAnyCount",
  "legacyRoutePortAliasCount",
  "settingsHostCallbackCount",
  "chatHostCallbackCount",
  "totalHostCallbacks",
  "totalDependencyMemberAccesses",
  "routeFacingServiceCount",
];
const GUARDED_BASELINE_MAP_KEYS = [
  "fastifyGatewayCallSitesByRouteFile",
  "hostCallbacksByFile",
  "dependencyMemberAccessesByFile",
];
const ROUTE_COMPOSITION_PRIVATE_DEPENDENCY_NAMES = [
  "addonsService",
  "approvalRuntime",
  "assemblyService",
  "backupRetentionService",
  "capabilityPackService",
  "capabilitySystemService",
  "chatMessageRouteRuntimeHost",
  "chatProjectService",
  "chatTurnRuntime",
  "databaseCutoverService",
  "devDiagnostics",
  "durableOperatorService",
  "evidenceEnvelopeService",
  "guidanceService",
  "improvementService",
  "mediaVoiceService",
  "obsidianVaultService",
  "onboardingStateHost",
  "promptPackService",
  "realtimeEventService",
  "researchService",
  "runtimeLifecycleReadService",
  "taskLifecycleService",
  "toolInvocationCoordinator",
];
// Matches whitespace, line comments, and non-nested block comments in valid TS/JS source.
// Nested block comments are invalid JavaScript/TypeScript syntax, so this intentionally does not parse them.
const WHITESPACE_AND_COMMENTS_PATTERN = String.raw`(?:\s|\/\/[^\r\n]*\r?\n|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*`;
const MAX_ARRAY_EXPRESSION_UNWRAP_DEPTH = 100;
const METHOD_LEADING_WHITESPACE_PATTERN_SOURCE = String.raw`^\s*`;
const METHOD_INTERNAL_MARKER_PATTERN_SOURCE = String.raw`(?<internal>/\*\* @internal \*/\s*)?`;
const METHOD_PUBLIC_KEYWORD_PATTERN_SOURCE = String.raw`public\s+`;
const METHOD_ASYNC_KEYWORD_PATTERN_SOURCE = String.raw`(?:async\s+)?`;
const METHOD_ACCESSOR_KEYWORD_PATTERN_SOURCE = String.raw`(?:(?:get|set)\s+)?`;
const METHOD_NAME_PATTERN_SOURCE = String.raw`(?<name>[$A-Z_a-z][$\w]*)`;
const METHOD_OPEN_PAREN_PATTERN_SOURCE = String.raw`\s*\(`;
const GATEWAY_PUBLIC_METHOD_PATTERN_SOURCE = String.raw`${METHOD_LEADING_WHITESPACE_PATTERN_SOURCE}${METHOD_INTERNAL_MARKER_PATTERN_SOURCE}${METHOD_PUBLIC_KEYWORD_PATTERN_SOURCE}${METHOD_ASYNC_KEYWORD_PATTERN_SOURCE}${METHOD_ACCESSOR_KEYWORD_PATTERN_SOURCE}${METHOD_NAME_PATTERN_SOURCE}${METHOD_OPEN_PAREN_PATTERN_SOURCE}`;
const SETTINGS_AUTH_SERVICE_PATH_KEY = path
  .join("apps", "gateway", "src", "services", "settings-auth-service.ts")
  .replaceAll("\\", "/");
const ROUTE_COMPOSITION_PRIVATE_DEPENDENCY_UNION_LINES = ROUTE_COMPOSITION_PRIVATE_DEPENDENCY_NAMES.map(
  (dependencyName) => `  | "${dependencyName}"`,
);
const EXPECTED_ROUTE_COMPOSITION_PRIVATE_DEPENDENCIES_ALIAS = [
  "export type GatewayRouteCompositionPrivateDependencies = Pick<",
  "  GatewayRouteCompositionPort,",
  ...ROUTE_COMPOSITION_PRIVATE_DEPENDENCY_UNION_LINES,
  ">;",
].join("\n");

/** Escapes regex metacharacters so a string can be embedded as a literal RegExp fragment. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createMetricsSourceFile(source) {
  return ts.createSourceFile("architecture-metrics-source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Counts member reads rooted at a symbol named `host` whose declaration has an
 * explicit host/port object type. This narrow compatibility metric preserves
 * the historical host-callback ratchet while ignoring URL.host and lexical
 * lookalikes. The broader dependency-member metric below closes naming gaps.
 */
export function countHostMemberAccesses(source, fileName = "architecture-metrics-source.ts") {
  const { checker, sourceFile } = createSingleFileTypeContext(source, fileName);
  return countResolvedMemberAccesses(
    sourceFile,
    (expression) => resolvesToNarrowTypedHost(expression, checker, sourceFile),
    (declaration) => isTypedHostDestructuredParameter(declaration, sourceFile),
  );
}

/**
 * Counts direct member reads rooted at an explicitly typed dependency
 * container, including host, deps, ports, service/storage roots and bags,
 * composition inputs, object destructuring, and aliases. Classification
 * requires an explicit dependency-container name/type or a dependency-shaped
 * member; callback count alone is not evidence of a dependency boundary. This
 * intentionally ignores text, comments, URL.host, primitive/domain inputs,
 * shadowed inferred objects, unconventional callback bags, and untyped
 * callback variables. Dynamic element reads and mutable aliases count once a
 * root is classified.
 */
export function countDependencyMemberAccesses(source, fileName = "architecture-metrics-source.ts") {
  const { checker, sourceFile } = createSingleFileTypeContext(source, fileName);
  const assignmentAliases = collectAssignmentAliases(sourceFile, checker);
  const dependencySymbolCache = new Map();
  const resolutionContext = {
    assignmentAliases,
    dependencySymbolCache,
  };
  return countResolvedMemberAccesses(
    sourceFile,
    (expression) => resolvesToDependencyContainer(expression, checker, sourceFile, resolutionContext),
    (declaration) => isDependencyContainerDeclaration(declaration, checker, sourceFile),
  );
}

function createSingleFileTypeContext(source, fileName) {
  const normalizedFileName = path.resolve(fileName);
  const compilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const sourceFile = ts.createSourceFile(normalizedFileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  compilerHost.fileExists = (requestedFileName) => path.resolve(requestedFileName) === normalizedFileName;
  compilerHost.readFile = (requestedFileName) =>
    path.resolve(requestedFileName) === normalizedFileName ? source : undefined;
  compilerHost.getSourceFile = (requestedFileName) =>
    path.resolve(requestedFileName) === normalizedFileName ? sourceFile : undefined;
  const program = ts.createProgram([normalizedFileName], compilerOptions, compilerHost);
  const checker = program.getTypeChecker();
  const boundSourceFile = program.getSourceFile(normalizedFileName) ?? sourceFile;
  return { checker, sourceFile: boundSourceFile };
}

function countResolvedMemberAccesses(sourceFile, resolves, resolvesTypedBinding = () => false) {
  let count = 0;

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (resolves(node.expression)) {
        count += 1;
      }
    } else if (ts.isElementAccessExpression(node) && resolves(node.expression)) {
      count += 1;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      resolves(node.initializer)
    ) {
      count += countBindingPatternMemberAccesses(node.name);
    } else if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name) && resolvesTypedBinding(node)) {
      count += countBindingPatternMemberAccesses(node.name);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isAssignmentPattern(node.left) &&
      resolves(node.right)
    ) {
      count += countAssignmentPatternMemberAccesses(node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function isAssignmentPattern(expression) {
  const candidate = unwrapAliasExpression(expression);
  return ts.isObjectLiteralExpression(candidate) || ts.isArrayLiteralExpression(candidate);
}

function countAssignmentPatternMemberAccesses(expression) {
  const candidate = unwrapAliasExpression(expression);
  if (ts.isObjectLiteralExpression(candidate)) {
    let count = 0;
    for (const property of candidate.properties) {
      count += 1;
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isObjectLiteralExpression(property.initializer) || ts.isArrayLiteralExpression(property.initializer))
      ) {
        count += countAssignmentPatternMemberAccesses(property.initializer);
      }
    }
    return count;
  }
  if (ts.isArrayLiteralExpression(candidate)) {
    let count = 0;
    for (const element of candidate.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      count += 1;
      if (ts.isObjectLiteralExpression(element) || ts.isArrayLiteralExpression(element)) {
        count += countAssignmentPatternMemberAccesses(element);
      }
    }
    return count;
  }
  return 0;
}

function countBindingPatternMemberAccesses(pattern) {
  let count = 0;
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) {
      continue;
    }
    count += 1;
    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      count += countBindingPatternMemberAccesses(element.name);
    }
  }
  return count;
}

function resolvesToNarrowTypedHost(expression, checker, sourceFile, seenSymbols = new Set()) {
  const candidate = unwrapAliasExpression(expression);
  if (ts.isIdentifier(candidate)) {
    const symbol = checker.getSymbolAtLocation(candidate);
    if (candidate.text === "host" && isTypedHostSymbol(symbol, sourceFile)) {
      return true;
    }
    if (!symbol || seenSymbols.has(symbol)) {
      return false;
    }

    const nextSeenSymbols = new Set(seenSymbols);
    nextSeenSymbols.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        isInitializedAliasDeclaration(declaration) &&
        resolvesToNarrowTypedHost(declaration.initializer, checker, sourceFile, nextSeenSymbols)
      ) {
        return true;
      }
    }
    return false;
  }

  if (
    ts.isPropertyAccessExpression(candidate) &&
    candidate.name.text === "host" &&
    candidate.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return isTypedHostSymbol(checker.getSymbolAtLocation(candidate.name), sourceFile);
  }
  const thisElementProperty = getStaticThisElementProperty(candidate, checker);
  if (thisElementProperty?.name === "host") {
    return isTypedHostSymbol(thisElementProperty.symbol, sourceFile);
  }
  return false;
}

function resolvesToDependencyContainer(expression, checker, sourceFile, context, seenSymbols = new Set()) {
  const candidate = unwrapAliasExpression(expression);
  if (ts.isIdentifier(candidate)) {
    const symbol = checker.getSymbolAtLocation(candidate);
    if (isDependencyContainerSymbol(symbol, checker, sourceFile, context.dependencySymbolCache)) {
      return true;
    }
    if (!symbol || seenSymbols.has(symbol)) {
      return false;
    }

    const nextSeenSymbols = new Set(seenSymbols);
    nextSeenSymbols.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        isInitializedAliasDeclaration(declaration) &&
        resolvesToDependencyContainer(declaration.initializer, checker, sourceFile, context, new Set(nextSeenSymbols))
      ) {
        return true;
      }
    }
    for (const initializer of context.assignmentAliases.get(symbol) ?? []) {
      if (resolvesToDependencyContainer(initializer, checker, sourceFile, context, new Set(nextSeenSymbols))) {
        return true;
      }
    }
    return false;
  }

  if (ts.isPropertyAccessExpression(candidate) && candidate.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return isDependencyContainerSymbol(
      checker.getSymbolAtLocation(candidate.name),
      checker,
      sourceFile,
      context.dependencySymbolCache,
    );
  }
  const thisElementProperty = getStaticThisElementProperty(candidate, checker);
  if (thisElementProperty) {
    return isDependencyContainerSymbol(thisElementProperty.symbol, checker, sourceFile, context.dependencySymbolCache);
  }
  return false;
}

function getStaticThisElementProperty(expression, checker) {
  if (
    !ts.isElementAccessExpression(expression) ||
    expression.expression.kind !== ts.SyntaxKind.ThisKeyword ||
    !expression.argumentExpression ||
    (!ts.isStringLiteralLike(expression.argumentExpression) && !ts.isPrivateIdentifier(expression.argumentExpression))
  ) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(expression.argumentExpression);
  if (!symbol) {
    return undefined;
  }
  return { name: symbol.name.replace(/^#/, ""), symbol };
}

function collectAssignmentAliases(sourceFile, checker) {
  const aliases = new Map();
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) {
        const existing = aliases.get(symbol) ?? [];
        existing.push(node.right);
        aliases.set(symbol, existing);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function unwrapAliasExpression(expression) {
  let candidate = expression;
  while (
    ts.isParenthesizedExpression(candidate) ||
    ts.isAsExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isNonNullExpression(candidate) ||
    ts.isSatisfiesExpression(candidate)
  ) {
    candidate = candidate.expression;
  }
  return candidate;
}

function isInitializedAliasDeclaration(declaration) {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return false;
  }
  return true;
}

function isTypedHostSymbol(symbol, sourceFile) {
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      if (!declaration.type) {
        return false;
      }
      const typeText = declaration.type.getText(sourceFile);
      return /\b[$A-Z_a-z][$\w]*Host[$\w]*\b/.test(typeText) || ts.isTypeLiteralNode(declaration.type);
    }),
  );
}

function isTypedHostDestructuredParameter(declaration, sourceFile) {
  if (!declaration.type) {
    return false;
  }
  return /\b[$A-Z_a-z][$\w]*Host[$\w]*\b/.test(declaration.type.getText(sourceFile));
}

function isDependencyContainerSymbol(symbol, checker, sourceFile, cache) {
  if (!symbol) {
    return false;
  }
  if (cache.has(symbol)) {
    return cache.get(symbol);
  }

  // Break recursive aliases while their structure is being inspected.
  cache.set(symbol, false);
  const result = Boolean(
    symbol.declarations?.some((declaration) => isDependencyContainerDeclaration(declaration, checker, sourceFile)),
  );
  cache.set(symbol, result);
  return result;
}

function isDependencyContainerDeclaration(declaration, checker, sourceFile) {
  if (!declaration.type) {
    return false;
  }
  const declarationName = getDeclarationName(declaration);
  const analysis = analyzeDependencyTypeNode(declaration.type, checker, sourceFile, new Set());
  const semanticDeclarationName = isDependencyContainerName(declarationName);
  const hasDependencyShape =
    !analysis.resolvedDefinition || analysis.callableMemberCount > 0 || analysis.dependencyMemberCount > 0;
  return (
    analysis.dependencyMemberCount > 0 ||
    (analysis.objectLike &&
      hasDependencyShape &&
      (semanticDeclarationName || analysis.semanticTypeName || analysis.callableSemanticTypeName))
  );
}

function analyzeDependencyTypeNode(typeNode, checker, sourceFile, seenTypeSymbols) {
  if (!typeNode) {
    return emptyDependencyTypeAnalysis();
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return analyzeDependencyTypeNode(typeNode.type, checker, sourceFile, seenTypeSymbols);
  }
  if (ts.isTypeOperatorNode(typeNode)) {
    return analyzeDependencyTypeNode(typeNode.type, checker, sourceFile, seenTypeSymbols);
  }
  if (ts.isIndexedAccessTypeNode(typeNode)) {
    return analyzeDependencyTypeNode(typeNode.objectType, checker, sourceFile, seenTypeSymbols);
  }
  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.reduce(
      (analysis, item) =>
        mergeDependencyTypeAnalysis(analysis, analyzeDependencyTypeNode(item, checker, sourceFile, seenTypeSymbols)),
      emptyDependencyTypeAnalysis(),
    );
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return analyzeDependencyMembers(typeNode.members, checker, sourceFile, seenTypeSymbols);
  }
  if (!ts.isTypeReferenceNode(typeNode)) {
    return emptyDependencyTypeAnalysis();
  }

  const typeName = typeNode.typeName.getText(sourceFile);
  let analysis = {
    ...emptyDependencyTypeAnalysis(),
    objectLike: true,
    semanticTypeName: isDependencyContainerTypeName(typeName),
    callableSemanticTypeName: isCallableDependencyContainerTypeName(typeName),
  };
  if (isTransparentDependencyTypeWrapper(typeName) && typeNode.typeArguments?.[0]) {
    analysis = mergeDependencyTypeAnalysis(
      analysis,
      analyzeDependencyTypeNode(typeNode.typeArguments[0], checker, sourceFile, seenTypeSymbols),
    );
  }
  const symbol = resolveTypeSymbol(checker.getSymbolAtLocation(typeNode.typeName), checker);
  if (!symbol || seenTypeSymbols.has(symbol)) {
    return analysis;
  }
  const nextSeen = new Set(seenTypeSymbols);
  nextSeen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      analysis.resolvedDefinition = true;
      analysis = mergeDependencyTypeAnalysis(
        analysis,
        analyzeDependencyMembers(declaration.members, checker, sourceFile, nextSeen),
      );
      for (const clause of declaration.heritageClauses ?? []) {
        for (const heritageType of clause.types) {
          analysis = mergeDependencyTypeAnalysis(
            analysis,
            analyzeDependencyTypeNode(heritageType, checker, sourceFile, nextSeen),
          );
        }
      }
    } else if (ts.isTypeAliasDeclaration(declaration)) {
      analysis.resolvedDefinition = true;
      analysis = mergeDependencyTypeAnalysis(
        analysis,
        analyzeDependencyTypeNode(declaration.type, checker, sourceFile, nextSeen),
      );
    }
  }
  return analysis;
}

function analyzeDependencyMembers(members, checker, sourceFile, seenTypeSymbols) {
  const analysis = {
    ...emptyDependencyTypeAnalysis(),
    objectLike: true,
    resolvedDefinition: true,
  };
  for (const member of members) {
    if (
      ts.isMethodSignature(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isCallSignatureDeclaration(member) ||
      ts.isConstructSignatureDeclaration(member)
    ) {
      analysis.callableMemberCount += 1;
      continue;
    }
    if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) {
      continue;
    }
    if (member.type && ts.isFunctionTypeNode(member.type)) {
      analysis.callableMemberCount += 1;
      continue;
    }
    if (isDependencyMember(member, checker, sourceFile, seenTypeSymbols)) {
      analysis.dependencyMemberCount += 1;
    }
  }
  return analysis;
}

function isDependencyMember(member, checker, sourceFile, seenTypeSymbols) {
  if (!member.type) {
    return false;
  }
  const name = getPropertyNameText(member.name);
  const typeText = member.type.getText(sourceFile);
  const objectLike = isObjectLikeTypeNode(member.type, checker, sourceFile, seenTypeSymbols);
  if (!objectLike) {
    return false;
  }
  return (
    /^(?:storage|store)$/i.test(name) ||
    /(?:Service|Storage|Repository|Repo|Client|Runtime|Executor|Gateway|Provider|Queue|Store|Coordinator|Classifier|Maintenance|Control|Review|Port)$/i.test(
      name,
    ) ||
    /(?:Service|Storage|Repository|Repo|Client|Runtime|Executor|Gateway|Provider|Queue|Store|Coordinator|Classifier|Maintenance|Control|Review|Port)\b/.test(
      typeText,
    )
  );
}

function isObjectLikeTypeNode(typeNode, checker, sourceFile, seenTypeSymbols) {
  if (!typeNode) {
    return false;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isObjectLikeTypeNode(typeNode.type, checker, sourceFile, seenTypeSymbols);
  }
  if (
    ts.isTypeLiteralNode(typeNode) ||
    ts.isTypeReferenceNode(typeNode) ||
    ts.isFunctionTypeNode(typeNode) ||
    ts.isArrayTypeNode(typeNode) ||
    ts.isTupleTypeNode(typeNode)
  ) {
    return true;
  }
  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some((item) => isObjectLikeTypeNode(item, checker, sourceFile, seenTypeSymbols));
  }
  return false;
}

function resolveTypeSymbol(symbol, checker) {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) {
    return symbol;
  }
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function getDeclarationName(declaration) {
  return "name" in declaration ? getPropertyNameText(declaration.name) : "";
}

function getPropertyNameText(name) {
  if (!name) {
    return "";
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return "";
}

function isDependencyContainerName(name) {
  return /(?:host|deps|dependencies|services?|storage|stores?|repositories|repository|repos?|ports?|clients?)$/i.test(
    name,
  );
}

function isDependencyContainerTypeName(name) {
  return /(?:Host|Deps|Dependencies|CompositionInput|Port|Storage|Service|Repository|Repo|Client|Executor|Gateway|Queue|Store|Coordinator|Classifier|Maintenance|Control)$/i.test(
    name,
  );
}

function isCallableDependencyContainerTypeName(name) {
  return /(?:Runtime|Provider)$/i.test(name);
}

function isTransparentDependencyTypeWrapper(name) {
  return /^(?:Readonly|Required|Partial|Pick|Omit|NonNullable)$/.test(name.split(".").at(-1) ?? "");
}

function emptyDependencyTypeAnalysis() {
  return {
    objectLike: false,
    semanticTypeName: false,
    callableSemanticTypeName: false,
    resolvedDefinition: false,
    callableMemberCount: 0,
    dependencyMemberCount: 0,
  };
}

function mergeDependencyTypeAnalysis(left, right) {
  return {
    objectLike: left.objectLike || right.objectLike,
    semanticTypeName: left.semanticTypeName || right.semanticTypeName,
    callableSemanticTypeName: left.callableSemanticTypeName || right.callableSemanticTypeName,
    resolvedDefinition: left.resolvedDefinition || right.resolvedDefinition,
    callableMemberCount: left.callableMemberCount + right.callableMemberCount,
    dependencyMemberCount: left.dependencyMemberCount + right.dependencyMemberCount,
  };
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Extracts a complete exported TypeScript type alias declaration, or an empty string when missing. */
function extractExportedTypeAlias(source, aliasName) {
  const sourceFile = createMetricsSourceFile(source);
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement) && statement.name.text === aliasName) {
      return source.slice(statement.getStart(sourceFile), statement.end);
    }
  }
  return "";
}

/** Extracts the body of an exported TypeScript interface by slicing its parsed declaration braces. */
function extractInterfaceBody(source, interfaceName) {
  const sourceFile = createMetricsSourceFile(source);
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && hasExportModifier(statement) && statement.name.text === interfaceName) {
      const start = statement.getStart(sourceFile);
      const openBraceIndex = source.indexOf("{", start);
      const closeBraceIndex = source.lastIndexOf("}", statement.end);
      if (openBraceIndex === -1 || closeBraceIndex <= openBraceIndex) {
        return "";
      }
      return source.slice(openBraceIndex + 1, closeBraceIndex);
    }
  }
  return "";
}

/** Collects architecture-boundary metrics used by the baseline comparison gate. */
export async function collectArchitectureMetrics(rootDir = repoRoot) {
  const gatewaySrcDir = path.join(rootDir, "apps", "gateway", "src");
  const routesDir = path.join(rootDir, "apps", "gateway", "src", "routes");
  const servicesDir = path.join(rootDir, "apps", "gateway", "src", "services");
  const gatewayServicePath = path.join(servicesDir, "gateway-service.ts");
  const gatewayRuntimeFactoryPath = path.join(servicesDir, "gateway-runtime-factory.ts");
  const serviceContextPath = path.join(servicesDir, "service-context.ts");
  const buildServiceContextPath = path.join(servicesDir, "gateway", "build-service-context.ts");

  const [routeFiles, gatewaySourceFiles, serviceFiles, measuredSourceSha256] = await Promise.all([
    listFiles(routesDir, (filePath) => filePath.endsWith(".ts")),
    listFiles(gatewaySrcDir, (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts")),
    listFiles(servicesDir, (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts")),
    collectMeasuredSourceSha256(rootDir, gatewaySrcDir),
  ]);
  const routeFacingServiceFiles = serviceFiles.filter((filePath) => filePath.endsWith("-route-service.ts"));
  const gatewayServiceSource = await fs.readFile(gatewayServicePath, "utf8");
  const gatewayRuntimeFactorySource = await fs.readFile(gatewayRuntimeFactoryPath, "utf8");

  const hostCallbacksByFile = {};
  const dependencyMemberAccessesByFile = {};
  let totalHostCallbacks = 0;
  let totalDependencyMemberAccesses = 0;
  for (const filePath of serviceFiles) {
    if (filePath === gatewayServicePath) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const relativePath = path.relative(rootDir, filePath).replaceAll("\\", "/");
    const hostCallbackCount = countHostMemberAccesses(content, filePath);
    if (hostCallbackCount > 0) {
      hostCallbacksByFile[relativePath] = hostCallbackCount;
      totalHostCallbacks += hostCallbackCount;
    }
    const dependencyMemberAccessCount = countDependencyMemberAccesses(content, filePath);
    if (dependencyMemberAccessCount > 0) {
      dependencyMemberAccessesByFile[relativePath] = dependencyMemberAccessCount;
      totalDependencyMemberAccesses += dependencyMemberAccessCount;
    }
  }

  const fastifyGatewayCallSitesByRouteFile = await countPatternByFile(routeFiles, /fastify\.gateway\./g, rootDir);
  const fastifyGatewayCallSites = Object.values(fastifyGatewayCallSitesByRouteFile).reduce(
    (total, count) => total + count,
    0,
  );
  const gatewayInternalPublicCount = countMatches(gatewayServiceSource, /\/\*\* @internal \*\/ public/g);
  const gatewayPublicMethodsByRegion = countGatewayPublicMethodsByRegion(gatewayServiceSource);
  const gatewayInternalPublicByRegion = countGatewayInternalPublicByRegion(gatewayServiceSource);
  const gatewayRuntimePortSource = extractInterfaceBody(gatewayRuntimeFactorySource, "GatewayRuntimePort");
  const gatewayRuntimePortFullStorageCount = countMatches(gatewayRuntimePortSource, /\breadonly\s+storage\b/g);
  const gatewayRuntimeFactoryRawServiceReturnCount = countMatches(
    gatewayRuntimeFactorySource,
    /export function createGateway(?:Admin)?Runtime[\s\S]*?return new GatewayService\(config\)/g,
  );
  const fastifyGatewayRuntimeStorageAccessCount = await countPatternAcrossFiles(
    gatewaySourceFiles,
    /\bgatewayRuntime\.storage\b/g,
  );
  const gatewayLineCount = countLines(gatewayServiceSource);
  const largeServiceDebt = await collectLargeServiceDebt(serviceFiles, rootDir);
  const gatewayPublicMethodCount = countMatches(
    gatewayServiceSource,
    new RegExp(GATEWAY_PUBLIC_METHOD_PATTERN_SOURCE, "gm"),
  );
  const boundGatewayRoutePortMethodCount = await countBoundGatewayRoutePortMethods(
    await fs.readFile(path.join(servicesDir, "gateway-route-services.ts"), "utf8"),
    serviceFiles,
  );
  const chatTurnRuntimeConstructedWithGatewayCount = countMatches(
    gatewayServiceSource,
    /new\s+ChatTurnRuntimeService\s*\(\s*this\s*\)/g,
  );
  const fastifyGatewayDecoratorReferenceCount = await countFastifyGatewayDecoratorReferences(gatewaySrcDir);
  const gatewayServiceImportConsumers = await collectImportConsumers({
    rootDir,
    filePaths: gatewaySourceFiles,
    excludedPaths: new Set([gatewayServicePath, gatewayRuntimeFactoryPath]),
    importPattern: /from\s+["'][^"']*gateway-service\.js["']/,
  });
  const serviceContextConsumers = await collectImportConsumers({
    rootDir,
    filePaths: serviceFiles,
    excludedPaths: new Set([serviceContextPath, buildServiceContextPath]),
    importPattern: /from\s+["'][^"']*service-context\.js["']/,
  });
  const routeCompositionPath = path.join(servicesDir, "gateway-route-service-composition.ts");
  const routeCompositionPortPath = path.join(servicesDir, "gateway-route-composition-port.ts");
  const routeCompositionPortSource = await fs.readFile(routeCompositionPortPath, "utf8");
  const routeServiceFactorySource = await fs.readFile(path.join(servicesDir, "route-service-factory.ts"), "utf8");
  const gatewaySource = (await Promise.all(gatewaySourceFiles.map((filePath) => fs.readFile(filePath, "utf8")))).join(
    "\n",
  );
  const gatewayRouteCompositionUnsafeCastCount = countMatches(
    gatewaySource,
    /\bas\s+(?:any\s+as\s+|unknown\s+as\s+)?GatewayRouteCompositionPort\b|<\s*GatewayRouteCompositionPort\s*>/g,
  );
  const gatewayRouteCompositionAnyAliasCount = countMatches(
    routeCompositionPortSource,
    /\btype\s+GatewayRouteComposition(?:Source|Port|Service|Callable)\s*=\s*any\b/g,
  );
  const gatewayRouteCompositionTypeAliasSource = [
    extractExportedTypeAlias(routeCompositionPortSource, "GatewayRouteCompositionPrivateDependencies"),
    extractExportedTypeAlias(routeCompositionPortSource, "GatewayRouteCompositionHost"),
  ].join("\n");
  const gatewayRouteCompositionWideningCount =
    countMatches(routeCompositionPortSource, /export\s+interface\s+GatewayRouteCompositionPort\s+extends\b/g) +
    countMatches(gatewayRouteCompositionTypeAliasSource, /\b(?:any|unknown|Partial\s*<|Record\s*<)/g) +
    countGatewayRouteCompositionShapeViolations(routeCompositionPortSource, gatewayServiceSource);
  const gatewayRouteCompositionVariadicAnyMethodCount = countMatches(
    routeCompositionPortSource,
    /\bGatewayRouteCompositionPort[\s\S]*?\(\s*\.\.\.args\s*:\s*any\[\]\s*\)\s*:\s*any/g,
  );
  const gatewayRouteCompositionFactoryExternalConsumers = await collectImportConsumers({
    rootDir,
    filePaths: gatewaySourceFiles,
    excludedPaths: new Set([gatewayServicePath, routeCompositionPath, routeCompositionPortPath]),
    importPattern: /\bcreateGatewayRouteCompositionPort\b/,
  });
  const gatewayRouteCompositionPortSource = extractInterfaceBody(
    routeCompositionPortSource,
    "GatewayRouteCompositionPort",
  );
  const gatewayRouteCompositionPortMemberCount = countMatches(
    gatewayRouteCompositionPortSource,
    /^\s+(?:readonly\s+)?[A-Za-z_]\w+\??[:(]/gm,
  );
  const legacyRouteServiceFactoryVariadicAnyCount = countMatches(
    routeServiceFactorySource,
    /\.\.\.args\s*:\s*any\[\]/g,
  );
  const legacyRoutePortAliasCount = countMatches(
    gatewaySource,
    /\bexport\s+type\s+\w+RoutePort\s*=\s*RoutePort<\w+RouteMethod>/g,
  );

  return {
    generatedAt: new Date().toISOString(),
    measuredSourceSha256,
    gatewayLineCount,
    largeServiceDebt,
    gatewayPublicMethodCount,
    gatewayPublicMethodsByRegion,
    gatewayServiceImportConsumerCount: gatewayServiceImportConsumers.length,
    gatewayServiceImportConsumers,
    fastifyGatewayCallSites,
    fastifyGatewayCallSitesByRouteFile,
    gatewayInternalPublicCount,
    gatewayInternalPublicByRegion,
    gatewayRuntimePortFullStorageCount,
    gatewayRuntimeFactoryRawServiceReturnCount,
    fastifyGatewayRuntimeStorageAccessCount,
    boundGatewayRoutePortMethodCount,
    chatTurnRuntimeConstructedWithGatewayCount,
    fastifyGatewayDecoratorReferenceCount,
    serviceContextConsumerCount: serviceContextConsumers.length,
    serviceContextConsumers,
    gatewayRouteCompositionUnsafeCastCount,
    gatewayRouteCompositionAnyAliasCount,
    gatewayRouteCompositionWideningCount,
    gatewayRouteCompositionVariadicAnyMethodCount,
    gatewayRouteCompositionFactoryExternalConsumerCount: gatewayRouteCompositionFactoryExternalConsumers.length,
    gatewayRouteCompositionFactoryExternalConsumers,
    gatewayRouteCompositionPortMemberCount,
    legacyRouteServiceFactoryVariadicAnyCount,
    legacyRoutePortAliasCount,
    totalHostCallbacks,
    hostCallbacksByFile,
    totalDependencyMemberAccesses,
    dependencyMemberAccessesByFile,
    settingsHostCallbackCount: hostCallbacksByFile[SETTINGS_AUTH_SERVICE_PATH_KEY] ?? 0,
    chatHostCallbackCount: sumMatchingValues(hostCallbacksByFile, /^apps\/gateway\/src\/services\/chat-/),
    routeFacingServiceCount: routeFacingServiceFiles.length,
    routeFacingServiceFiles: routeFacingServiceFiles
      .map((filePath) => path.relative(rootDir, filePath).replaceAll("\\", "/"))
      .sort(),
  };
}

export async function readArchitectureMetricsBaseline(rootDir = repoRoot) {
  const baselinePath = getArchitectureBaselinePath(rootDir);
  try {
    const raw = await fs.readFile(baselinePath, "utf8");
    return validateArchitectureMetricsBaseline(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Failed to load architecture metrics baseline at "${baselinePath}". Ensure the file exists and contains valid JSON.`,
      { cause: error },
    );
  }
}

export function assertArchitectureMetricsCaptureClean(statusOutput) {
  const raw = Buffer.isBuffer(statusOutput) ? statusOutput.toString("utf8") : String(statusOutput ?? "");
  if (raw.length === 0) {
    return;
  }
  const dirtyEntries = raw
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const visibleEntries = dirtyEntries.slice(0, 12);
  const hiddenCount = dirtyEntries.length - visibleEntries.length;
  throw new Error(
    `Architecture baseline capture refuses to snapshot dirty measured source: ${visibleEntries.join(", ")}` +
      (hiddenCount > 0 ? `, and ${hiddenCount} more` : ""),
  );
}

export function createArchitectureMetricsBaseline(metrics, sourceRevision, options = {}) {
  if (typeof sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error("Architecture metrics baseline source revision must be a full lowercase Git revision.");
  }
  if (!isCanonicalIsoTimestamp(metrics?.generatedAt)) {
    throw new Error("Architecture metrics collection generatedAt must be a canonical ISO timestamp.");
  }
  const {
    schemaVersion: _ignoredSchemaVersion,
    hostCallbackCollectorCorrectedAt: _ignoredHostCorrection,
    hostCallbackSourceRevision: _ignoredHostRevision,
    dependencyMemberCollectorCapturedAt: _ignoredDependencyCapture,
    dependencyMemberSourceRevision: _ignoredDependencyRevision,
    ...snapshot
  } = metrics;
  const baseline = {
    schemaVersion: ARCHITECTURE_BASELINE_SCHEMA_VERSION,
    ...snapshot,
    sourceTreeState: options.sourceTreeState ?? "clean",
    hostCallbackCollectorCorrectedAt: metrics.generatedAt,
    hostCallbackSourceRevision: sourceRevision,
    dependencyMemberCollectorCapturedAt: metrics.generatedAt,
    dependencyMemberSourceRevision: sourceRevision,
  };
  return validateArchitectureMetricsBaseline(baseline);
}

export function validateArchitectureMetricsBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("Architecture metrics baseline must be an object.");
  }
  if (baseline.schemaVersion !== ARCHITECTURE_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Architecture metrics baseline schemaVersion must be ${ARCHITECTURE_BASELINE_SCHEMA_VERSION}; ` +
        `received ${JSON.stringify(baseline.schemaVersion)}.`,
    );
  }
  for (const key of ["generatedAt", "hostCallbackCollectorCorrectedAt", "dependencyMemberCollectorCapturedAt"]) {
    if (!isCanonicalIsoTimestamp(baseline[key])) {
      throw new Error(`Architecture metrics baseline ${key} must be a canonical ISO timestamp.`);
    }
  }
  for (const key of ["hostCallbackSourceRevision", "dependencyMemberSourceRevision"]) {
    if (typeof baseline[key] !== "string" || !/^[0-9a-f]{40}$/.test(baseline[key])) {
      throw new Error(`Architecture metrics baseline ${key} must be a full lowercase Git revision.`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(baseline.measuredSourceSha256 ?? "")) {
    throw new Error("Architecture metrics baseline measuredSourceSha256 must be a lowercase SHA-256 digest.");
  }
  if (baseline.sourceTreeState !== "clean" && baseline.sourceTreeState !== "dirty") {
    throw new Error('Architecture metrics baseline sourceTreeState must be either "clean" or "dirty".');
  }
  for (const key of GUARDED_BASELINE_SCALAR_KEYS) {
    if (!isNonNegativeSafeInteger(baseline[key])) {
      throw new Error(`Architecture metrics baseline ${key} must be a non-negative safe integer.`);
    }
  }
  for (const key of GUARDED_BASELINE_MAP_KEYS) {
    validateBaselineCountMap(baseline[key], key);
  }

  assertBaselineTotal(
    baseline,
    "fastifyGatewayCallSites",
    sumObjectValues(baseline.fastifyGatewayCallSitesByRouteFile),
  );
  assertBaselineTotal(baseline, "totalHostCallbacks", sumObjectValues(baseline.hostCallbacksByFile));
  assertBaselineTotal(
    baseline,
    "totalDependencyMemberAccesses",
    sumObjectValues(baseline.dependencyMemberAccessesByFile),
  );
  assertBaselineTotal(
    baseline,
    "settingsHostCallbackCount",
    baseline.hostCallbacksByFile[SETTINGS_AUTH_SERVICE_PATH_KEY] ?? 0,
  );
  assertBaselineTotal(
    baseline,
    "chatHostCallbackCount",
    sumMatchingValues(baseline.hostCallbacksByFile, /^apps\/gateway\/src\/services\/chat-/),
  );
  validateBaselineArrayCount(baseline, "gatewayServiceImportConsumers", "gatewayServiceImportConsumerCount");
  validateBaselineArrayCount(baseline, "serviceContextConsumers", "serviceContextConsumerCount");
  validateBaselineArrayCount(
    baseline,
    "gatewayRouteCompositionFactoryExternalConsumers",
    "gatewayRouteCompositionFactoryExternalConsumerCount",
  );
  validateBaselineArrayCount(baseline, "routeFacingServiceFiles", "routeFacingServiceCount");
  return baseline;
}

export function compareArchitectureMetrics(metrics, baseline) {
  validateArchitectureMetricsBaseline(baseline);
  const regressions = [];
  const improvements = [];
  const largeServiceDebt = Array.isArray(metrics.largeServiceDebt) ? metrics.largeServiceDebt : [];
  const debtNotes = [
    "Architecture metrics are an architecture debt guard, not proof that broad GatewayService decomposition is complete.",
    ...largeServiceDebt
      .slice(0, 5)
      .map((item) => `Large-service debt: ${item.path} (${item.lineCount} lines, ${item.bytes} bytes)`),
  ];
  const deltas = {
    gatewayLineCount: metrics.gatewayLineCount - baseline.gatewayLineCount,
    gatewayPublicMethodCount: metrics.gatewayPublicMethodCount - baseline.gatewayPublicMethodCount,
    gatewayServiceImportConsumerCount:
      metrics.gatewayServiceImportConsumerCount - baseline.gatewayServiceImportConsumerCount,
    fastifyGatewayCallSites: metrics.fastifyGatewayCallSites - baseline.fastifyGatewayCallSites,
    gatewayInternalPublicCount: metrics.gatewayInternalPublicCount - baseline.gatewayInternalPublicCount,
    gatewayRuntimePortFullStorageCount: deltaOrCurrentFallback(
      metrics.gatewayRuntimePortFullStorageCount,
      baseline.gatewayRuntimePortFullStorageCount,
    ),
    gatewayRuntimeFactoryRawServiceReturnCount: deltaOrCurrentFallback(
      metrics.gatewayRuntimeFactoryRawServiceReturnCount,
      baseline.gatewayRuntimeFactoryRawServiceReturnCount,
    ),
    fastifyGatewayRuntimeStorageAccessCount: deltaOrCurrentFallback(
      metrics.fastifyGatewayRuntimeStorageAccessCount,
      baseline.fastifyGatewayRuntimeStorageAccessCount,
    ),
    boundGatewayRoutePortMethodCount: deltaOrCurrentFallback(
      metrics.boundGatewayRoutePortMethodCount,
      baseline.boundGatewayRoutePortMethodCount,
    ),
    chatTurnRuntimeConstructedWithGatewayCount: deltaOrCurrentFallback(
      metrics.chatTurnRuntimeConstructedWithGatewayCount,
      baseline.chatTurnRuntimeConstructedWithGatewayCount,
    ),
    fastifyGatewayDecoratorReferenceCount: deltaOrCurrentFallback(
      metrics.fastifyGatewayDecoratorReferenceCount,
      baseline.fastifyGatewayDecoratorReferenceCount,
    ),
    serviceContextConsumerCount: metrics.serviceContextConsumerCount - baseline.serviceContextConsumerCount,
    gatewayRouteCompositionUnsafeCastCount: deltaOrCurrentFallback(
      metrics.gatewayRouteCompositionUnsafeCastCount,
      baseline.gatewayRouteCompositionUnsafeCastCount,
    ),
    gatewayRouteCompositionAnyAliasCount: deltaOrCurrentFallback(
      metrics.gatewayRouteCompositionAnyAliasCount,
      baseline.gatewayRouteCompositionAnyAliasCount,
    ),
    gatewayRouteCompositionWideningCount: deltaOrCurrentFallback(
      metrics.gatewayRouteCompositionWideningCount,
      baseline.gatewayRouteCompositionWideningCount,
    ),
    gatewayRouteCompositionVariadicAnyMethodCount: deltaOrCurrentFallback(
      metrics.gatewayRouteCompositionVariadicAnyMethodCount,
      baseline.gatewayRouteCompositionVariadicAnyMethodCount,
    ),
    gatewayRouteCompositionFactoryExternalConsumerCount: deltaOrCurrentFallback(
      metrics.gatewayRouteCompositionFactoryExternalConsumerCount,
      baseline.gatewayRouteCompositionFactoryExternalConsumerCount,
    ),
    gatewayRouteCompositionPortMemberCount: deltaOrCurrentFallback(
      metrics.gatewayRouteCompositionPortMemberCount,
      baseline.gatewayRouteCompositionPortMemberCount,
    ),
    legacyRouteServiceFactoryVariadicAnyCount: deltaOrCurrentFallback(
      metrics.legacyRouteServiceFactoryVariadicAnyCount,
      baseline.legacyRouteServiceFactoryVariadicAnyCount,
    ),
    legacyRoutePortAliasCount: deltaOrCurrentFallback(
      metrics.legacyRoutePortAliasCount,
      baseline.legacyRoutePortAliasCount,
    ),
    totalHostCallbacks: metrics.totalHostCallbacks - baseline.totalHostCallbacks,
    totalDependencyMemberAccesses: deltaOrCurrentFallback(
      metrics.totalDependencyMemberAccesses,
      baseline.totalDependencyMemberAccesses,
    ),
    settingsHostCallbackCount: deltaOrCurrentFallback(
      metrics.settingsHostCallbackCount,
      baseline.settingsHostCallbackCount,
    ),
    chatHostCallbackCount: deltaOrCurrentFallback(metrics.chatHostCallbackCount, baseline.chatHostCallbackCount),
    routeFacingServiceCount: metrics.routeFacingServiceCount - baseline.routeFacingServiceCount,
  };

  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayLineCount",
    label: "GatewayService line count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayPublicMethodCount",
    label: "GatewayService public method count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayServiceImportConsumerCount",
    label: "gateway-service.js import consumer count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "fastifyGatewayCallSites",
    label: "fastify.gateway.* call sites",
    regressions,
    improvements,
  });
  comparePerFileNonIncreasingMetric({
    metricsByFile: metrics.fastifyGatewayCallSitesByRouteFile,
    baselineByFile: baseline.fastifyGatewayCallSitesByRouteFile,
    label: "fastify.gateway.* route call sites",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayInternalPublicCount",
    label: "GatewayService @internal public count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRuntimePortFullStorageCount",
    label: "GatewayRuntimePort full-storage member count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRuntimeFactoryRawServiceReturnCount",
    label: "Gateway runtime factory raw-service return count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "fastifyGatewayRuntimeStorageAccessCount",
    label: "fastify gatewayRuntime.storage access count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "boundGatewayRoutePortMethodCount",
    label: "Gateway-bound route port method count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "chatTurnRuntimeConstructedWithGatewayCount",
    label: "ChatTurnRuntimeService full-gateway construction count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "fastifyGatewayDecoratorReferenceCount",
    label: "fastify.gateway decorator/reference count outside compatibility tests",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "serviceContextConsumerCount",
    label: "broad ServiceContext consumer count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRouteCompositionUnsafeCastCount",
    label: "unsafe GatewayRouteCompositionPort cast count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRouteCompositionAnyAliasCount",
    label: "GatewayRouteComposition any-alias count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRouteCompositionWideningCount",
    label: "GatewayRouteComposition widening count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRouteCompositionVariadicAnyMethodCount",
    label: "GatewayRouteComposition variadic-any method count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRouteCompositionFactoryExternalConsumerCount",
    label: "GatewayRouteComposition factory external consumer count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayRouteCompositionPortMemberCount",
    label: "GatewayRouteCompositionPort member count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "legacyRouteServiceFactoryVariadicAnyCount",
    label: "legacy route-service factory variadic-any count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "legacyRoutePortAliasCount",
    label: "legacy RoutePort alias count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "settingsHostCallbackCount",
    label: "settings/auth typed host callback count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "chatHostCallbackCount",
    label: "chat typed host callback count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "totalHostCallbacks",
    label: "Extracted-service typed host callbacks",
    regressions,
    improvements,
  });
  comparePerFileNonIncreasingMetric({
    metricsByFile: metrics.hostCallbacksByFile,
    baselineByFile: baseline.hostCallbacksByFile,
    label: "Extracted-service typed host callbacks",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "totalDependencyMemberAccesses",
    label: "Extracted-service typed dependency member accesses",
    regressions,
    improvements,
  });
  comparePerFileNonIncreasingMetric({
    metricsByFile: metrics.dependencyMemberAccessesByFile,
    baselineByFile: baseline.dependencyMemberAccessesByFile,
    label: "Extracted-service typed dependency member accesses",
    regressions,
    improvements,
  });

  if (metrics.routeFacingServiceCount < baseline.routeFacingServiceCount) {
    regressions.push(
      `Route-facing service count decreased from ${baseline.routeFacingServiceCount} to ${metrics.routeFacingServiceCount}`,
    );
  } else if (metrics.routeFacingServiceCount > baseline.routeFacingServiceCount) {
    improvements.push(
      `Route-facing service count increased from ${baseline.routeFacingServiceCount} to ${metrics.routeFacingServiceCount}`,
    );
  }

  return {
    baselinePath: ARCHITECTURE_BASELINE_PATH,
    deltas,
    largeServiceDebt,
    debtNotes,
    regressions,
    improvements,
    status: regressions.length > 0 ? "failed" : "passed",
  };
}

async function listFiles(rootDir, predicate) {
  const files = [];
  const directoriesToVisit = [rootDir];

  while (directoriesToVisit.length > 0) {
    const currentDir = directoriesToVisit.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        directoriesToVisit.push(fullPath);
        continue;
      }
      if (predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function collectMeasuredSourceSha256(rootDir, gatewaySrcDir) {
  const gatewayFiles = await listFiles(gatewaySrcDir, (filePath) => filePath.endsWith(".ts"));
  const ownerFiles = [
    path.join(rootDir, "package.json"),
    path.join(rootDir, "scripts", "update-architecture-metrics-baseline.mjs"),
    path.join(rootDir, "scripts", "verification", "lib", "architecture-metrics.mjs"),
    path.join(rootDir, "scripts", "verification", "lib", "architecture-metrics.test.mjs"),
    path.join(rootDir, "scripts", "verification", "lib", "scenarios", "architecture-metrics-lane.mjs"),
  ];
  const measuredFiles = [...new Set([...gatewayFiles, ...ownerFiles])].sort((left, right) => left.localeCompare(right));
  const digest = createHash("sha256");
  for (const filePath of measuredFiles) {
    const content = await fs.readFile(filePath);
    const relativePath = path.relative(rootDir, filePath).replaceAll("\\", "/");
    digest.update(relativePath, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(content.length), "utf8");
    digest.update("\0", "utf8");
    digest.update(content);
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

async function countPatternAcrossFiles(filePaths, pattern) {
  let total = 0;
  for (const filePath of filePaths) {
    const content = await fs.readFile(filePath, "utf8");
    total += countMatches(content, pattern);
  }
  return total;
}

async function countPatternByFile(filePaths, pattern, rootDir) {
  const counts = {};
  const sortedFilePaths = [...filePaths].sort();
  for (const filePath of sortedFilePaths) {
    const content = await fs.readFile(filePath, "utf8");
    const count = countMatches(content, pattern);
    if (count > 0) {
      counts[path.relative(rootDir, filePath).replaceAll("\\", "/")] = count;
    }
  }
  return counts;
}

async function collectLargeServiceDebt(filePaths, rootDir) {
  const entries = await Promise.all(
    filePaths.map(async (filePath) => {
      const content = await fs.readFile(filePath, "utf8");
      const stats = await fs.stat(filePath);
      return {
        path: path.relative(rootDir, filePath).replaceAll("\\", "/"),
        lineCount: countLines(content),
        bytes: stats.size,
      };
    }),
  );
  return entries
    .sort(
      (left, right) =>
        right.lineCount - left.lineCount || right.bytes - left.bytes || left.path.localeCompare(right.path),
    )
    .slice(0, 10);
}

function countGatewayPublicMethodsByRegion(source) {
  const counts = {};
  for (const method of collectGatewayPublicMethods(source)) {
    const region = classifyGatewayMethodRegion(method.name);
    counts[region] = (counts[region] ?? 0) + 1;
  }
  return sortObjectByKey(counts);
}

function countGatewayInternalPublicByRegion(source) {
  const counts = {};
  for (const method of collectGatewayPublicMethods(source)) {
    if (!method.internal) {
      continue;
    }
    const region = classifyGatewayMethodRegion(method.name);
    counts[region] = (counts[region] ?? 0) + 1;
  }
  return sortObjectByKey(counts);
}

function collectGatewayPublicMethods(source) {
  const methods = [];
  const pattern = new RegExp(GATEWAY_PUBLIC_METHOD_PATTERN_SOURCE, "gm");
  for (const match of source.matchAll(pattern)) {
    const name = match.groups?.name;
    if (!name) {
      continue;
    }
    methods.push({
      name,
      internal: Boolean(match.groups?.internal),
    });
  }
  return methods;
}

function splitMethodNames(value) {
  return value.trim().split(/\s+/);
}

function buildMethodPrefixPattern(methodNames, { exact = false } = {}) {
  const alternation = methodNames.map(escapeRegExp).join("|");
  return new RegExp(`^(?:${alternation})${exact ? "$" : ""}`);
}

const GATEWAY_METHOD_REGION_PATTERN_SOURCES = [
  {
    region: "lifecycle",
    exact: true,
    methodNames: splitMethodNames(`
      init initCritical startDeferredInit close attachDevDiagnosticsLogger isDevDiagnosticsEnabled
    `),
  },
  {
    region: "approvals",
    methodNames: splitMethodNames(`
      createApproval resolveApproval listApprovals getApproval ensureApproval enqueueApproval primeApproval
      buildApproval findProactiveDurableRunIdsForApproval consumeRemoteActionToken
    `),
  },
  {
    region: "chat-turn-runtime",
    methodNames: splitMethodNames(`
      agentSendChatMessage retryChatTurn editChatTurn cancelChatTurn routePreflight resumeAgentChatTurnStream
      answerChatUserInputPrompt prepareAgentChatTurn beginActiveChatTurn endActiveChatTurn getActiveChatTurn
      registerActiveChatTurn completeActiveChatTurn closeActiveChatTurn persistChatStreamChunk
      createHydratedChatTurnTrace markChatTurnCancelled loadChatTurn requireChatTurn buildChat resolvePreparedTurn
      collectSpecialist extractAndPersistLearnedMemory ensureChatSessionRuntimeGrants inheritDelegatedSessionToolGrants
      runPromptPackFromChat
    `),
  },
  {
    region: "chat-sessions",
    methodNames: splitMethodNames(`
      listChat createChat updateChat pinChat unpinChat archiveChat restoreChat deleteChat assignChat getChatSession
      getChatThread selectChatBranch setChatSession respondToExistingChatMessage uploadChatAttachment
      getChatAttachment readChatAttachment listChatGenerated createChatGenerated getChatGenerated attachChatThread
      removeChatThread listChatThread
    `),
  },
  {
    region: "prompt-packs",
    methodNames: splitMethodNames(`
      listPromptPack importPromptPack runPromptPack scorePromptPack reviewPromptPack autoScorePromptPack
      getPromptPack cancelPromptPack exportPromptPack resetPromptPack
    `),
  },
  {
    region: "durable",
    methodNames: splitMethodNames(`
      getDurable listDurable createDurable pauseDurable resumeDurable cancelDurable retryDurable wakeDurable
      recoverDurable beginDurable finalizeDurable requestDurable updateDurable computeDurable recordDurable
      createCheckpoint
    `),
  },
  {
    region: "memory",
    methodNames: splitMethodNames(`
      getMemory patchMemory listMemory runMemory acceptMemory rejectMemory forgetMemory composeMemory listRunContexts
      listRecentMemory persistContext resolveMemory
    `),
  },
  {
    region: "settings-auth",
    methodNames: splitMethodNames(`
      getSettings updateSettings getAuth updateAuth resolveGatewayInstallToken createDeviceAccess getDeviceAccess
      listDeviceAccess revokeDeviceAccess validateDeviceAccess exchangeCompanion rotateCompanion getCompanion
      listCompanion revokeCompanion validateCompanion verifyCompanion resolveDeviceAccess expireDeviceAccess
      recordApprovalResolution
    `),
  },
  {
    region: "integrations",
    methodNames: splitMethodNames(`
      listIntegration getIntegration createIntegration updateIntegration deleteIntegration invokeIntegration runIntegration
      listChannel createChannel updateChannel validateChannel testChannel finalizeChannel retestChannel listDiscord
      approveDiscord revokeDiscord getDiscord reconnectDiscord emitDiscord emitTelegram syncDiscord ingestChannel
      assertDiscord readDiscord writeDiscord resolveDiscord ensureDiscord startNewDiscord handleDiscord readConnection
      resolveConnection recordConnector pickConnector buildIntegration runIntegrationConnectionLiveChecks listConnector
    `),
  },
  {
    region: "mcp",
    methodNames: splitMethodNames(`
      listMcp runMcp createMcp updateMcp deleteMcp connectMcp disconnectMcp startMcp completeMcp invokeMcp
      readMcp writeMcp requireMcp patchMcp resolveConnectedMcp
    `),
  },
  {
    region: "tools-comms",
    methodNames: splitMethodNames(`
      invokeTool listTool evaluateTool createToolGrant revokeToolGrant ensureSessionInternalToolGrant
      requireExecutedToolResult comms knowledge
    `),
  },
  {
    region: "skills",
    methodNames: splitMethodNames(`
      listSkills reloadSkills executeCodeMode listChatPendingApprovals getSkill updateSkill setSkill bulkSetSkill
      resolveSkill listSkill lookupSkill validateSkill installSkill
    `),
  },
  {
    region: "dashboard-workspace",
    methodNames: splitMethodNames(`
      getDashboard getSystem listOperators listCron getCron createCron updateCron setCron deleteCron runCron retryCron
      uploadWorkspace listWorkspace createWorkspace updateWorkspace archiveWorkspace restoreWorkspace listFile
      createWorkspaceFile downloadWorkspace listGlobalGuidance listWorkspaceGuidance updateGlobalGuidance
      updateWorkspaceGuidance getTranscript getSessionSummary listSessionTimeline getRuntimeLifecycle listSessions
      getSession getLatestFollowOn rememberFollowOn getPackaging getVoice
    `),
  },
  {
    region: "runtime-provider",
    methodNames: splitMethodNames(`
      listLlm getLlm updateLlm previewLlm createChatCompletion resolveFallbackTargets saveProviderSecret
      deleteProviderSecret getProviderSecret listLlama getLlama startLlama stopLlama refreshLlama detectLlama adviseLlama
      cancelLlama listNpu getNpu startNpu stopNpu refreshNpu generateImage createAssembly listAssembly getAssembly
    `),
  },
  {
    region: "realtime-events",
    methodNames: splitMethodNames(`
      publishRealtime subscribeRealtime listRealtime getRealtime openRealtime touchRealtime closeRealtime ingestEvent
      listDev subscribeDev recordDev
    `),
  },
  {
    region: "orchestration",
    methodNames: splitMethodNames(`
      createOrchestration runOrchestration approvePhase getRun listRunCheckpoints allocateOrchestration
      executeDurableOrchestration scheduleOrchestration parseOrchestration applyOrchestration
    `),
  },
  {
    region: "composition-helpers",
    exact: true,
    methodNames: splitMethodNames(`
      isFeatureEnabled requireFeatureEnabled updateFeatureFlags readFeatureFlags persist assert runCheaper
      fetchWithDiagnosticsTimeout isConnectionUrlAllowlisted isUrlAllowlistedInList normalizeWorkspaceId
      resolveChatCompletionHookWorkspaceId resolveApprovalHookWorkspaceId parseLlm mergeLlm applyLlm
      resolveRuntimeGuidance routeFromSession buildLlmMessagesFromBranchPath gatewaySql
    `),
  },
];

const GATEWAY_METHOD_REGION_PATTERNS = GATEWAY_METHOD_REGION_PATTERN_SOURCES.map(
  ({ exact = false, methodNames, region }) => ({
    region,
    pattern: buildMethodPrefixPattern(methodNames, { exact }),
  }),
);

function classifyGatewayMethodRegion(methodName) {
  for (const { region, pattern } of GATEWAY_METHOD_REGION_PATTERNS) {
    if (pattern.test(methodName)) {
      return region;
    }
  }
  return "other";
}

async function countBoundGatewayRoutePortMethods(source, serviceFiles) {
  const sourceFile = createMetricsSourceFile(source);
  const targetFunction = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      hasExportModifier(statement) &&
      statement.name?.text === "createBoundGatewayRouteServiceDependencies",
  );
  if (!targetFunction?.body) {
    return 0;
  }

  const functionSource = source.slice(targetFunction.body.getStart(sourceFile), targetFunction.body.end);
  let total = 0;
  for (const call of functionSource.matchAll(/bindRoutePort\(\s*source\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
    const methodsName = call[1];
    const declaration = await findExportedConstArrayDeclaration(methodsName, serviceFiles);
    if (!declaration) {
      continue;
    }
    total += countMatches(declaration, /"[^"]+"/g);
  }
  return total;
}

async function findExportedConstArrayDeclaration(name, serviceFiles) {
  for (const filePath of serviceFiles) {
    const source = await fs.readFile(filePath, "utf8");
    const declaration = extractExportedConstArrayInitializer(source, name);
    if (declaration !== undefined) {
      return declaration;
    }
  }
  return undefined;
}

function extractExportedConstArrayInitializer(source, constName) {
  const sourceFile = createMetricsSourceFile(source);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== constName || !declaration.initializer) {
        continue;
      }
      const arrayInitializer = unwrapArrayExpression(declaration.initializer);
      if (arrayInitializer) {
        return source.slice(arrayInitializer.getStart(sourceFile) + 1, arrayInitializer.end - 1);
      }
    }
  }
  return undefined;
}

function unwrapArrayExpression(expression) {
  let currentExpression = expression;
  for (let depth = 0; depth < MAX_ARRAY_EXPRESSION_UNWRAP_DEPTH; depth += 1) {
    if (ts.isArrayLiteralExpression(currentExpression)) {
      return currentExpression;
    }
    if (!isArrayWrapperExpression(currentExpression)) {
      return undefined;
    }
    currentExpression = currentExpression.expression;
  }
  return undefined;
}

function isArrayWrapperExpression(expression) {
  return (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  );
}

async function countFastifyGatewayDecoratorReferences(gatewaySrcDir) {
  const files = await listFiles(
    gatewaySrcDir,
    (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"),
  );
  let total = 0;
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    total += countMatches(content, /\b(?:fastify|app|built|next)\.gateway\b/g);
    total += countMatches(content, /\bFastifyInstance\s*&\s*\{\s*gateway(?:\?)?\s*:/g);
    total += countMatches(content, /decorate\(\s*["']gateway["']/g);
  }
  return total;
}

function sumMatchingValues(record, pattern) {
  return Object.entries(record).reduce((total, [key, value]) => (pattern.test(key) ? total + value : total), 0);
}

function sortObjectByKey(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function countGatewayRouteCompositionShapeViolations(routeCompositionSource, gatewayServiceSource) {
  let violations = 0;
  const privateDependencyAlias = extractExportedTypeAlias(
    routeCompositionSource,
    "GatewayRouteCompositionPrivateDependencies",
  );
  if (
    normalizeTypeAlias(privateDependencyAlias) !==
    normalizeTypeAlias(EXPECTED_ROUTE_COMPOSITION_PRIVATE_DEPENDENCIES_ALIAS)
  ) {
    violations += 1;
  }

  const hostAlias = extractExportedTypeAlias(routeCompositionSource, "GatewayRouteCompositionHost");
  const expectedHostAlias = [
    "export type GatewayRouteCompositionHost = Omit<",
    "  GatewayRouteCompositionPort,",
    "  keyof GatewayRouteCompositionPrivateDependencies",
    ">;",
  ].join("\n");
  if (normalizeTypeAlias(hostAlias) !== normalizeTypeAlias(expectedHostAlias)) {
    violations += 1;
  }
  if (
    /\bas\s+(?:any\s+as\s+|unknown\s+as\s+)?GatewayRouteComposition(?:PrivateDependencies|Host)\b/.test(
      gatewayServiceSource,
    )
  ) {
    violations += 1;
  }
  if (/<\s*GatewayRouteComposition(?:PrivateDependencies|Host)\s*>/.test(gatewayServiceSource)) {
    violations += 1;
  }
  const createPortCallPattern = new RegExp(
    String.raw`createGatewayRouteCompositionPort\(${WHITESPACE_AND_COMMENTS_PATTERN}this${WHITESPACE_AND_COMMENTS_PATTERN},${WHITESPACE_AND_COMMENTS_PATTERN}\{`,
  );
  if (!createPortCallPattern.test(gatewayServiceSource)) {
    violations += 1;
  }
  return violations;
}

function normalizeTypeAlias(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\S\r\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

const countMatchesRegexCache = new Map();

function getCachedGlobalRegex(pattern) {
  const flagSet = new Set(pattern.flags.split(""));
  flagSet.add("g");
  const flags = [...flagSet].join("");
  const cacheKey = `${pattern.source}\u0000${flags}`;
  let regex = countMatchesRegexCache.get(cacheKey);
  if (!regex) {
    regex = new RegExp(pattern.source, flags);
    countMatchesRegexCache.set(cacheKey, regex);
  }
  return regex;
}

function countMatches(content, pattern) {
  const regex = getCachedGlobalRegex(pattern);
  regex.lastIndex = 0;
  let count = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    count += 1;
    if (match[0] === "") {
      // Zero-width global matches do not advance lastIndex, so advance manually to avoid an infinite loop.
      regex.lastIndex += 1;
    }
  }
  return count;
}

function deltaOrCurrentFallback(current, baselineValue) {
  return current - (baselineValue ?? current);
}

function countLines(content) {
  // Empty content has no source lines for architecture-size metrics.
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

async function collectImportConsumers({ rootDir, filePaths, excludedPaths, importPattern }) {
  const consumers = [];
  for (const filePath of [...filePaths].sort()) {
    if (excludedPaths.has(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    if (importPattern.test(content)) {
      consumers.push(path.relative(rootDir, filePath).replaceAll("\\", "/"));
    }
  }
  return consumers;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateBaselineCountMap(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Architecture metrics baseline ${key} must be an object map.`);
  }
  for (const [filePath, count] of Object.entries(value)) {
    if (
      filePath.length === 0 ||
      filePath.includes("\\") ||
      path.isAbsolute(filePath) ||
      filePath.split("/").includes("..")
    ) {
      throw new Error(`Architecture metrics baseline ${key} contains invalid path ${JSON.stringify(filePath)}.`);
    }
    if (!isNonNegativeSafeInteger(count)) {
      throw new Error(
        `Architecture metrics baseline ${key}[${JSON.stringify(filePath)}] must be a non-negative safe integer.`,
      );
    }
  }
}

function sumObjectValues(value) {
  return Object.values(value).reduce((total, count) => total + count, 0);
}

function assertBaselineTotal(baseline, key, expected) {
  if (baseline[key] !== expected) {
    throw new Error(
      `Architecture metrics baseline ${key}=${baseline[key]} does not match its derived total ${expected}.`,
    );
  }
}

function validateBaselineArrayCount(baseline, arrayKey, countKey) {
  const values = baseline[arrayKey];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`Architecture metrics baseline ${arrayKey} must be an array of non-empty strings.`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`Architecture metrics baseline ${arrayKey} must not contain duplicate entries.`);
  }
  if (values.length !== baseline[countKey]) {
    throw new Error(
      `Architecture metrics baseline ${countKey}=${baseline[countKey]} does not match ${arrayKey}.length=${values.length}.`,
    );
  }
}

function compareNonIncreasingMetric({ metrics, baseline, key, label, regressions, improvements }) {
  if (typeof baseline[key] !== "number") {
    return;
  }
  if (metrics[key] > baseline[key]) {
    regressions.push(`${label} increased from ${baseline[key]} to ${metrics[key]}`);
  } else if (metrics[key] < baseline[key]) {
    improvements.push(`${label} decreased from ${baseline[key]} to ${metrics[key]}`);
  }
}

function comparePerFileNonIncreasingMetric({
  metricsByFile = {},
  baselineByFile = {},
  label,
  regressions,
  improvements,
}) {
  const filePaths = new Set([...Object.keys(metricsByFile), ...Object.keys(baselineByFile)]);
  for (const filePath of [...filePaths].sort()) {
    const current = metricsByFile[filePath] ?? 0;
    const previous = baselineByFile[filePath] ?? 0;
    if (current > previous) {
      regressions.push(`${label} increased in ${filePath} from ${previous} to ${current}`);
    } else if (current < previous) {
      improvements.push(`${label} decreased in ${filePath} from ${previous} to ${current}`);
    }
  }
}
