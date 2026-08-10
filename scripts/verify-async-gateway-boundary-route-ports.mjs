import path from "node:path";
import ts from "typescript";

// The gateway route layer erases service signatures to `(...args: any[]) => any`
// (apps/gateway/src/services/route-service-factory.ts), so tsc cannot flag a
// sync->async service conversion left unawaited in a route handler. This module
// rebuilds the truth the erasure destroyed: it derives a per-service async/sync
// method map from the port builder sources (where the checker still sees the
// real underlying signatures) and then requires every promise-returning
// route-service call in apps/gateway/src/routes/** to cross an explicit
// ownership boundary (await, return, Promise combinator, chain, thunk, or
// tracked background task).

const GATEWAY_ROUTE_SERVICES_RELATIVE_PATH = "apps/gateway/src/services/gateway-route-services.ts";
const ROUTE_SERVICES_INTERFACE_NAME = "GatewayRouteServices";
const ROUTE_SERVICE_DEPENDENCIES_INTERFACE_NAME = "GatewayRouteServiceDependencies";
const GATEWAY_SOURCE_RELATIVE_PATH = "apps/gateway/src";
const TYPESCRIPT_TEST_PATTERN = /\.(?:test|spec)\.(?:cts|mts|tsx?)$/u;
const PROMISE_COMBINATOR_METHODS = new Set(["all", "allSettled", "any", "race", "resolve", "try"]);
const PROMISE_CHAIN_METHODS = new Set(["catch", "finally", "then"]);
const OWNED_BACKGROUND_PROMISE_CALL_NAMES = new Set(["registerBackgroundTask", "trackBackgroundTask"]);
const GENERIC_WRAPPER_SYMBOL_NAMES = new Set(["__object", "__type", "Readonly", "Record"]);
const EMPTY_NODE_SET = new Set();

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

function isExactPromiseType(checker, type) {
  if (type.isUnion()) {
    return type.types.some((member) => isExactPromiseType(checker, member));
  }
  const apparent = checker.getApparentType(type);
  const symbol = apparent.aliasSymbol ?? apparent.getSymbol();
  return symbol?.getName() === "Promise";
}

function classifyReturnType(checker, returnType) {
  if ((returnType.flags & ts.TypeFlags.Any) !== 0) return "erased";
  return isExactPromiseType(checker, returnType) ? "async" : "sync";
}

function classifyCallSignatures(checker, signatures) {
  let sawErased = false;
  for (const signature of signatures) {
    const classification = classifyReturnType(checker, checker.getReturnTypeOfSignature(signature));
    if (classification === "async") return "async";
    if (classification === "erased") sawErased = true;
  }
  return sawErased ? "erased" : "sync";
}

function isGatewayProductionSourceFile(sourceFile, gatewaySourceRoot) {
  if (sourceFile.isDeclarationFile) return false;
  if (!pathIsWithin(sourceFile.fileName, gatewaySourceRoot)) return false;
  return !TYPESCRIPT_TEST_PATTERN.test(sourceFile.fileName.replaceAll("\\", "/"));
}

function findInterfaceDeclaration(sourceFile, interfaceName) {
  return sourceFile.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  );
}

function mergeClassification(methods, methodName, classification) {
  if (classification === "erased") return;
  if (methods.get(methodName) === "async") return;
  methods.set(methodName, classification);
}

function classifyFunctionLikeInitializer(checker, initializer) {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    const signature = checker.getSignatureFromDeclaration(initializer);
    if (signature) return classifyReturnType(checker, checker.getReturnTypeOfSignature(signature));
  }
  const initializerType = checker.getTypeAtLocation(initializer);
  const signatures = initializerType.getCallSignatures();
  if (signatures.length === 0) return "erased";
  return classifyCallSignatures(checker, signatures);
}

function collectReturnedExpressions(functionNode) {
  if (!ts.isArrowFunction(functionNode) && !ts.isFunctionExpression(functionNode)) return [];
  if (!ts.isBlock(functionNode.body)) return [unwrapExpression(functionNode.body)];
  const returned = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returned.push(unwrapExpression(node.expression));
    ts.forEachChild(node, visit);
  };
  functionNode.body.statements.forEach(visit);
  return returned;
}

/**
 * An erased builder member can still name its true implementation indirectly:
 * `(input) => gateway.commsActivity(input)` or `gateway.x.bind(gateway)`, where
 * the receiver is a bridge or port surface. Resolve the referenced (service,
 * method) pair so the pending classification can be copied from it once the
 * harvest settles.
 */
function findDelegatedPortReference(context, initializer) {
  const candidates = [];
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    candidates.push(...collectReturnedExpressions(initializer));
  } else {
    candidates.push(initializer);
  }
  for (let candidate of candidates) {
    candidate = unwrapExpression(candidate);
    if (ts.isAwaitExpression(candidate)) candidate = unwrapExpression(candidate.expression);
    let reference = candidate;
    if (ts.isCallExpression(candidate)) {
      reference = unwrapExpression(candidate.expression);
      const bindAccess = accessedProperty(reference);
      if (bindAccess?.name === "bind") reference = unwrapExpression(bindAccess.owner);
    }
    const access = accessedProperty(reference);
    if (!access) continue;
    const ownerType = context.checker.getTypeAtLocation(unwrapExpression(access.owner)).getNonNullableType();
    const bridgeMembers = bridgeMembersForContextualType(context.bridges, ownerType);
    const bridgeMapping = bridgeMembers?.get(access.name);
    if (bridgeMapping) {
      return { methods: bridgeMapping.target.methods, methodName: bridgeMapping.methodName };
    }
    const portTarget = contextualPortTarget(context.portTypeIndex, ownerType);
    if (portTarget?.erasedMethods.has(access.name)) {
      return { methods: portTarget.methods, methodName: access.name };
    }
  }
  return undefined;
}

function recordErasedDelegation(context, initializer, methods, methodName) {
  const source = findDelegatedPortReference(context, initializer);
  if (source) context.pendingDelegations.push({ methods, methodName, source });
}

function harvestPortLiteral(context, objectLiteral, target) {
  const { checker } = context;
  for (const member of objectLiteral.properties) {
    if (ts.isPropertyAssignment(member)) {
      const methodName = propertyNameText(member.name);
      if (!methodName || !target.erasedMethods.has(methodName)) continue;
      const initializer = unwrapExpression(member.initializer);
      const classification = classifyFunctionLikeInitializer(checker, initializer);
      mergeClassification(target.methods, methodName, classification);
      if (classification === "erased") {
        recordErasedDelegation(context, initializer, target.methods, methodName);
      }
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      const methodName = propertyNameText(member.name);
      if (!methodName || !target.erasedMethods.has(methodName)) continue;
      const signature = checker.getSignatureFromDeclaration(member);
      if (signature) {
        mergeClassification(
          target.methods,
          methodName,
          classifyReturnType(checker, checker.getReturnTypeOfSignature(signature)),
        );
      }
      continue;
    }
    if (ts.isShorthandPropertyAssignment(member)) {
      const methodName = member.name.text;
      if (!target.erasedMethods.has(methodName)) continue;
      const memberType = checker.getTypeAtLocation(member.name);
      const signatures = memberType.getCallSignatures();
      if (signatures.length > 0) {
        mergeClassification(target.methods, methodName, classifyCallSignatures(checker, signatures));
      }
      continue;
    }
    if (ts.isSpreadAssignment(member)) {
      const spreadType = checker.getTypeAtLocation(member.expression);
      for (const property of spreadType.getProperties()) {
        const methodName = property.getName();
        if (!target.erasedMethods.has(methodName)) continue;
        const propertyType = checker.getTypeOfSymbolAtLocation(property, member.expression);
        const signatures = propertyType.getCallSignatures();
        if (signatures.length > 0) {
          mergeClassification(target.methods, methodName, classifyCallSignatures(checker, signatures));
        }
      }
    }
  }
}

function drillIndexedAccessBase(typeNode) {
  while (ts.isIndexedAccessTypeNode(typeNode)) {
    typeNode = typeNode.objectType;
  }
  return typeNode;
}

function isDependencyIndexedAlias(checker, typeName, verdictCache) {
  const symbol = checker.getSymbolAtLocation(typeName);
  if (!symbol) return false;
  const cached = verdictCache.get(symbol);
  if (cached !== undefined) return cached;
  const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
  let verdict = false;
  if (declaration && ts.isIndexedAccessTypeNode(declaration.type)) {
    const base = drillIndexedAccessBase(declaration.type);
    verdict =
      ts.isTypeReferenceNode(base) &&
      ts.isIdentifier(base.typeName) &&
      base.typeName.text === ROUTE_SERVICE_DEPENDENCIES_INTERFACE_NAME;
  }
  verdictCache.set(symbol, verdict);
  return verdict;
}

function bridgeDeclarationType(checker, container) {
  if (ts.isInterfaceDeclaration(container)) {
    const symbol = checker.getSymbolAtLocation(container.name);
    return symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  }
  if (ts.isTypeLiteralNode(container)) return checker.getTypeAtLocation(container);
  return undefined;
}

/**
 * Composition bridge surfaces type their members as
 * `RouteDependencyMethod<"key", "method">` (an indexed access into the erased
 * dependency ports), so the members are declared `any` while the builder
 * object literal carries the real bound implementations. The literal string
 * type arguments name the exact (service, method) pair, letting the harvest
 * classify those builders precisely.
 */
function collectDependencyBridges({ program, checker, gatewaySourceRoot, targetsByKey }) {
  const entries = [];
  const entriesByContainer = new Map();
  const memberNames = new Set();
  const aliasVerdictCache = new Map();
  const omitAliasCandidates = [];
  const register = (container, memberName, target, methodName) => {
    let entry = entriesByContainer.get(container);
    if (!entry) {
      const bridgeType = bridgeDeclarationType(checker, container);
      if (!bridgeType) return;
      entry = {
        types: new Set([bridgeType]),
        symbols: new Set([bridgeType.getSymbol()].filter(Boolean)),
        aliasSymbols: new Set(),
        members: new Map(),
      };
      entriesByContainer.set(container, entry);
      entries.push(entry);
    }
    entry.members.set(memberName, { target, methodName });
    memberNames.add(memberName);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!isGatewayProductionSourceFile(sourceFile, gatewaySourceRoot)) continue;
    const visit = (node) => {
      if (
        ts.isTypeAliasDeclaration(node) &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === "Omit" &&
        node.type.typeArguments?.[0] !== undefined &&
        ts.isTypeReferenceNode(node.type.typeArguments[0])
      ) {
        omitAliasCandidates.push(node);
      }
      if (
        ts.isPropertySignature(node) &&
        node.type &&
        ts.isTypeReferenceNode(node.type) &&
        (node.type.typeArguments?.length ?? 0) >= 2
      ) {
        const [keyArgument, methodArgument] = node.type.typeArguments;
        const keyName =
          ts.isLiteralTypeNode(keyArgument) && ts.isStringLiteralLike(keyArgument.literal)
            ? keyArgument.literal.text
            : undefined;
        const methodName =
          ts.isLiteralTypeNode(methodArgument) && ts.isStringLiteralLike(methodArgument.literal)
            ? methodArgument.literal.text
            : undefined;
        const memberName = propertyNameText(node.name);
        const target = keyName === undefined ? undefined : targetsByKey.get(keyName);
        if (
          memberName !== undefined &&
          methodName !== undefined &&
          target?.erasedMethods.has(methodName) &&
          isDependencyIndexedAlias(checker, node.type.typeName, aliasVerdictCache)
        ) {
          register(node.parent, memberName, target, methodName);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // Host aliases (`type Host = Omit<Bridge, ...>`) type the parameters through
  // which the real implementation object reaches the bridge builder; register
  // them so bridge-typed call arguments can be harvested from their actual
  // (fully typed) host classes.
  for (const aliasDeclaration of omitAliasCandidates) {
    const baseName = aliasDeclaration.type.typeArguments[0].typeName;
    const baseSymbol = ts.isIdentifier(baseName) ? checker.getSymbolAtLocation(baseName) : undefined;
    if (!baseSymbol) continue;
    const entry = entries.find((candidate) => candidate.symbols.has(baseSymbol));
    if (!entry) continue;
    const aliasSymbol = checker.getSymbolAtLocation(aliasDeclaration.name);
    if (aliasSymbol) {
      entry.aliasSymbols.add(aliasSymbol);
      entry.types.add(checker.getDeclaredTypeOfSymbol(aliasSymbol));
    }
  }
  return { entries, memberNames };
}

function bridgeMembersForContextualType(bridges, contextualType) {
  if (!contextualType) return undefined;
  const members = contextualType.isUnion() ? contextualType.types : [contextualType];
  for (const member of members) {
    for (const entry of bridges.entries) {
      if (entry.types.has(member)) return entry.members;
      const symbol = member.getSymbol();
      if (symbol && entry.symbols.has(symbol)) return entry.members;
      if (member.aliasSymbol && entry.aliasSymbols.has(member.aliasSymbol)) return entry.members;
    }
  }
  return undefined;
}

function classifyPortMembersFromActualType(checker, expression, target) {
  const actualType = checker.getTypeAtLocation(expression);
  if ((actualType.flags & ts.TypeFlags.Any) !== 0) return;
  for (const methodName of target.erasedMethods) {
    const property = actualType.getNonNullableType().getProperty(methodName);
    if (!property) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, expression);
    const signatures = propertyType.getCallSignatures();
    if (signatures.length > 0) {
      mergeClassification(target.methods, methodName, classifyCallSignatures(checker, signatures));
    }
  }
}

function harvestBridgeArgument(checker, bridges, argument) {
  const bridgeMembers = bridgeMembersForContextualType(bridges, checker.getContextualType(argument));
  if (!bridgeMembers) return;
  const actualType = checker.getTypeAtLocation(argument);
  if ((actualType.flags & ts.TypeFlags.Any) !== 0) return;
  for (const [memberName, mapping] of bridgeMembers) {
    const property = actualType.getNonNullableType().getProperty(memberName);
    if (!property) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, argument);
    const signatures = propertyType.getCallSignatures();
    if (signatures.length > 0) {
      mergeClassification(mapping.target.methods, mapping.methodName, classifyCallSignatures(checker, signatures));
    }
  }
}

function harvestBridgeLiteral(context, objectLiteral, bridgeMembers) {
  const { checker } = context;
  for (const member of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(member) && !ts.isMethodDeclaration(member) && !ts.isShorthandPropertyAssignment(member)) {
      continue;
    }
    const memberName = propertyNameText(member.name);
    const mapping = memberName === undefined ? undefined : bridgeMembers.get(memberName);
    if (!mapping) continue;
    let classification;
    if (ts.isPropertyAssignment(member)) {
      const initializer = unwrapExpression(member.initializer);
      classification = classifyFunctionLikeInitializer(checker, initializer);
      if (classification === "erased") {
        recordErasedDelegation(context, initializer, mapping.target.methods, mapping.methodName);
      }
    } else if (ts.isMethodDeclaration(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      classification = signature
        ? classifyReturnType(checker, checker.getReturnTypeOfSignature(signature))
        : "erased";
    } else {
      const memberType = checker.getTypeAtLocation(member.name);
      const signatures = memberType.getCallSignatures();
      classification = signatures.length > 0 ? classifyCallSignatures(checker, signatures) : "erased";
    }
    mergeClassification(mapping.target.methods, mapping.methodName, classification);
  }
}

function registerPortTypeCandidate(portTypeIndex, type, target) {
  if (!type) return;
  const members = type.isUnion() ? type.types : [type];
  for (const member of members) {
    portTypeIndex.byIdentity.set(member, target);
    if (member.aliasSymbol) portTypeIndex.byAliasSymbol.set(member.aliasSymbol, target);
  }
}

function conventionPortTypeForServiceAlias(checker, serviceType) {
  const aliasSymbol = serviceType.aliasSymbol;
  const aliasName = aliasSymbol?.getName();
  if (!aliasSymbol || !aliasName?.endsWith("RouteService")) return undefined;
  const declaration = aliasSymbol.declarations?.[0];
  if (!declaration) return undefined;
  const portAliasName = `${aliasName.slice(0, -"RouteService".length)}RoutePort`;
  const portDeclaration = declaration
    .getSourceFile()
    .statements.find((statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === portAliasName);
  if (!portDeclaration) return undefined;
  const portSymbol = checker.getSymbolAtLocation(portDeclaration.name);
  return portSymbol ? checker.getDeclaredTypeOfSymbol(portSymbol) : undefined;
}

function contextualPortTarget(portTypeIndex, contextualType) {
  if (!contextualType) return undefined;
  const members = contextualType.isUnion() ? contextualType.types : [contextualType];
  for (const member of members) {
    const byIdentity = portTypeIndex.byIdentity.get(member);
    if (byIdentity) return byIdentity;
    if (member.aliasSymbol) {
      const byAlias = portTypeIndex.byAliasSymbol.get(member.aliasSymbol);
      if (byAlias) return byAlias;
    }
  }
  return undefined;
}

/**
 * Derives the route-service async/sync method map from the composed
 * GatewayRouteServices interface plus every port builder object literal the
 * checker can see. Returns undefined when the composition module is absent
 * (fixture repositories); throws when an any-typed port method has no
 * scanner-visible builder, so the map cannot silently drift out of coverage.
 */
export function buildRouteServicePortMap({ program, checker, repoRoot }) {
  const compositionPath = normalizeAbsolutePath(
    path.join(repoRoot, ...GATEWAY_ROUTE_SERVICES_RELATIVE_PATH.split("/")),
  );
  const compositionFile = program
    .getSourceFiles()
    .find((sourceFile) => normalizeAbsolutePath(sourceFile.fileName) === compositionPath);
  if (!compositionFile) return undefined;
  const servicesInterface = findInterfaceDeclaration(compositionFile, ROUTE_SERVICES_INTERFACE_NAME);
  if (!servicesInterface) return undefined;
  const dependenciesInterface = findInterfaceDeclaration(
    compositionFile,
    ROUTE_SERVICE_DEPENDENCIES_INTERFACE_NAME,
  );

  const servicesSymbol = checker.getSymbolAtLocation(servicesInterface.name);
  const servicesType = servicesSymbol ? checker.getDeclaredTypeOfSymbol(servicesSymbol) : undefined;
  const byKey = new Map();
  const typeIdentityToKey = new Map();
  const typeNameToKey = new Map();
  const portTypeIndex = { byIdentity: new Map(), byAliasSymbol: new Map() };
  const erasedTargets = [];
  const erasedMethodNames = new Set();

  const dependencyTypesByKey = new Map();
  for (const member of dependenciesInterface?.members ?? []) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const key = propertyNameText(member.name);
    if (key) dependencyTypesByKey.set(key, checker.getTypeAtLocation(member.type).getNonNullableType());
  }

  for (const member of servicesInterface.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const key = propertyNameText(member.name);
    if (!key) continue;
    const serviceType = checker.getTypeAtLocation(member.type).getNonNullableType();
    typeIdentityToKey.set(serviceType, key);
    const aliasName = serviceType.aliasSymbol?.getName();
    if (aliasName && !GENERIC_WRAPPER_SYMBOL_NAMES.has(aliasName)) typeNameToKey.set(aliasName, key);
    const symbolName = serviceType.getSymbol()?.getName();
    if (symbolName && !GENERIC_WRAPPER_SYMBOL_NAMES.has(symbolName)) typeNameToKey.set(symbolName, key);
    if (ts.isTypeReferenceNode(member.type) && ts.isIdentifier(member.type.typeName)) {
      typeNameToKey.set(member.type.typeName.text, key);
    }

    const methods = new Map();
    const erasedMethods = new Set();
    for (const property of serviceType.getProperties()) {
      const propertyType = checker.getTypeOfSymbolAtLocation(property, member.type);
      const signatures = propertyType.getCallSignatures();
      if (signatures.length === 0) continue;
      const classification = classifyCallSignatures(checker, signatures);
      if (classification === "erased") {
        erasedMethods.add(property.getName());
        erasedMethodNames.add(property.getName());
      } else {
        methods.set(property.getName(), classification);
      }
    }
    byKey.set(key, methods);
    if (erasedMethods.size === 0) continue;

    const target = { key, erasedMethods, methods };
    erasedTargets.push(target);
    registerPortTypeCandidate(portTypeIndex, dependencyTypesByKey.get(key), target);
    registerPortTypeCandidate(portTypeIndex, conventionPortTypeForServiceAlias(checker, serviceType), target);
    // The erased service surface itself is a valid builder context: object
    // literals typed directly as the RouteService alias still carry real
    // inferred member signatures.
    registerPortTypeCandidate(portTypeIndex, serviceType, target);
  }

  if (erasedTargets.length > 0) {
    const gatewaySourceRoot = path.join(repoRoot, ...GATEWAY_SOURCE_RELATIVE_PATH.split("/"));
    const targetsByKey = new Map(erasedTargets.map((target) => [target.key, target]));
    const bridges = collectDependencyBridges({ program, checker, gatewaySourceRoot, targetsByKey });
    const harvestContext = { checker, portTypeIndex, bridges, pendingDelegations: [] };
    for (const sourceFile of program.getSourceFiles()) {
      if (!isGatewayProductionSourceFile(sourceFile, gatewaySourceRoot)) continue;
      const visit = (node) => {
        if (
          ts.isObjectLiteralExpression(node) &&
          node.properties.some((member) => {
            if (ts.isSpreadAssignment(member)) return true;
            const memberName = member.name ? propertyNameText(member.name) : undefined;
            return (
              memberName !== undefined &&
              (erasedMethodNames.has(memberName) ||
                bridges.memberNames.has(memberName) ||
                targetsByKey.has(memberName))
            );
          })
        ) {
          const contextualType = checker.getContextualType(node);
          const target = contextualPortTarget(portTypeIndex, contextualType);
          if (target) harvestPortLiteral(harvestContext, node, target);
          const bridgeMembers = bridgeMembersForContextualType(bridges, contextualType);
          if (bridgeMembers) harvestBridgeLiteral(harvestContext, node, bridgeMembers);
          // A port can also be satisfied by a whole pre-built object
          // (`voice: gateway.mediaVoiceService`); classify its erased methods
          // from the actual value type.
          for (const member of node.properties) {
            if (!ts.isPropertyAssignment(member) || ts.isObjectLiteralExpression(member.initializer)) continue;
            const memberName = propertyNameText(member.name);
            if (memberName === undefined || !targetsByKey.has(memberName)) continue;
            const memberTarget = contextualPortTarget(
              portTypeIndex,
              checker.getContextualType(member.initializer),
            );
            if (memberTarget) classifyPortMembersFromActualType(checker, member.initializer, memberTarget);
          }
        }
        if (ts.isCallExpression(node) && bridges.entries.length > 0) {
          for (const argument of node.arguments) {
            if (argument.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(argument)) {
              harvestBridgeArgument(checker, bridges, argument);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    // Delegated classifications may point at methods that settle later in the
    // walk (or via the host-argument harvest), so copy them to a fixpoint.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = harvestContext.pendingDelegations.length - 1; index >= 0; index -= 1) {
        const pending = harvestContext.pendingDelegations[index];
        const classification = pending.source.methods.get(pending.source.methodName);
        if (classification === undefined) continue;
        mergeClassification(pending.methods, pending.methodName, classification);
        harvestContext.pendingDelegations.splice(index, 1);
        progressed = true;
      }
    }
  }

  const unresolved = [];
  for (const target of erasedTargets) {
    for (const methodName of target.erasedMethods) {
      if (!target.methods.has(methodName)) unresolved.push(`${target.key}.${methodName}`);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Route-service async map could not classify ${unresolved.sort().join(", ")}: no port builder ` +
        "object literal with checker-visible member signatures was found in apps/gateway/src. Teach " +
        "scripts/verify-async-gateway-boundary-route-ports.mjs the new builder shape or route the port " +
        "through a builder the scanner can see.",
    );
  }

  return { byKey, typeIdentityToKey, typeNameToKey, servicesType };
}

function isServicesExpression(checker, expression, portMap) {
  const unwrapped = unwrapExpression(expression);
  if (accessedProperty(unwrapped)?.name === "services") return true;
  const expressionType = checker.getTypeAtLocation(unwrapped).getNonNullableType();
  if (portMap.servicesType && expressionType === portMap.servicesType) return true;
  return expressionType.getSymbol()?.getName() === ROUTE_SERVICES_INTERFACE_NAME;
}

function resolveServiceKey(checker, ownerExpression, portMap) {
  const owner = unwrapExpression(ownerExpression);
  const ownerType = checker.getTypeAtLocation(owner).getNonNullableType();
  const byIdentity = portMap.typeIdentityToKey.get(ownerType);
  if (byIdentity) return byIdentity;
  const aliasName = ownerType.aliasSymbol?.getName();
  if (aliasName && portMap.typeNameToKey.has(aliasName)) return portMap.typeNameToKey.get(aliasName);
  const symbolName = ownerType.getSymbol()?.getName();
  if (symbolName && portMap.typeNameToKey.has(symbolName)) return portMap.typeNameToKey.get(symbolName);
  const access = accessedProperty(owner);
  if (access && isServicesExpression(checker, access.owner, portMap)) return access.name;
  return undefined;
}

function identifyRouteServiceCall(checker, call, portMap) {
  const callee = unwrapExpression(call.expression);
  const access = accessedProperty(callee);
  if (access) {
    const serviceKey = resolveServiceKey(checker, access.owner, portMap);
    return serviceKey === undefined ? undefined : { serviceKey, methodName: access.name };
  }
  if (!ts.isIdentifier(callee)) return undefined;
  const declaration = checker.getSymbolAtLocation(callee)?.valueDeclaration;
  if (!declaration || !ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) {
    return undefined;
  }
  const variableDeclaration = declaration.parent.parent;
  if (!ts.isVariableDeclaration(variableDeclaration) || !variableDeclaration.initializer) return undefined;
  const serviceKey = resolveServiceKey(checker, variableDeclaration.initializer, portMap);
  if (serviceKey === undefined) return undefined;
  const methodName = propertyNameText(declaration.propertyName ?? declaration.name);
  return methodName === undefined ? undefined : { serviceKey, methodName };
}

function callReturnsRealPromise(checker, call) {
  return isExactPromiseType(checker, checker.getTypeAtLocation(call));
}

function isAsyncRouteServiceCall(checker, call, identified, portMap) {
  const classification = portMap.byKey.get(identified.serviceKey)?.get(identified.methodName);
  if (classification === "async") return true;
  if (classification === "sync") return false;
  return callReturnsRealPromise(checker, call);
}

function isPromiseCombinatorCall(call) {
  const access = accessedProperty(call.expression);
  if (!access || !PROMISE_COMBINATOR_METHODS.has(access.name)) return false;
  const owner = unwrapExpression(access.owner);
  return ts.isIdentifier(owner) && owner.text === "Promise";
}

function isOwnedBackgroundCall(call) {
  const callee = unwrapExpression(call.expression);
  const name = ts.isIdentifier(callee) ? callee.text : accessedProperty(callee)?.name;
  return name !== undefined && OWNED_BACKGROUND_PROMISE_CALL_NAMES.has(name);
}

function variableHasOwnedPromiseUse(checker, declaration, seenSymbols) {
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
      judgePromiseUse(checker, node, nextSeenSymbols) === undefined
    ) {
      owned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return owned;
}

/**
 * Walks upward from a promise-valued expression and returns undefined when the
 * promise crosses an explicit ownership boundary, or a short violation phrase
 * describing how the pending promise leaks.
 */
function judgePromiseUse(checker, expressionNode, seenSymbols = new Set(), ignoreCalls = EMPTY_NODE_SET) {
  let current = expressionNode;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent)
    ) {
      current = parent;
      continue;
    }
    if (ts.isAwaitExpression(parent) || ts.isYieldExpression(parent) || ts.isReturnStatement(parent)) {
      return undefined;
    }
    if (ts.isArrowFunction(parent)) {
      return parent.body === current ? undefined : "not awaited";
    }
    if (ts.isForOfStatement(parent)) {
      if (parent.expression !== current) return undefined;
      return parent.awaitModifier ? undefined : "iterated without for-await";
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      if (parent.expression !== current) {
        current = parent;
        continue;
      }
      const chainName = ts.isPropertyAccessExpression(parent)
        ? parent.name.text
        : accessedProperty(parent)?.name;
      if (
        chainName !== undefined &&
        PROMISE_CHAIN_METHODS.has(chainName) &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        return undefined;
      }
      return "projected before resolution";
    }
    if (ts.isCallExpression(parent)) {
      if (parent.expression === current) return "invoked before resolution";
      if (isPromiseCombinatorCall(parent)) {
        // Promise.all/resolve/... adopt the promise; ownership is judged at
        // the combinator's own result (already reported when the floating
        // rule flagged that result).
        if (ignoreCalls.has(parent)) return undefined;
        current = parent;
        continue;
      }
      if (isOwnedBackgroundCall(parent)) return undefined;
      return "passed while pending";
    }
    if (ts.isVariableDeclaration(parent)) {
      return variableHasOwnedPromiseUse(checker, parent, seenSymbols)
        ? undefined
        : "assigned without a consuming use";
    }
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
      return "nested in an object literal";
    }
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition === current) return "used as a truthy gate";
      current = parent;
      continue;
    }
    if (
      ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isCaseClause(parent) ||
      ts.isPrefixUnaryExpression(parent)
    ) {
      return "used as a truthy gate";
    }
    if (ts.isBinaryExpression(parent) || ts.isTemplateSpan(parent) || ts.isTaggedTemplateExpression(parent)) {
      return "used in an expression before resolution";
    }
    if (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) {
      return "left floating";
    }
    if (ts.isFunctionLike(parent) || ts.isBlock(parent) || ts.isSourceFile(parent)) {
      return "not awaited";
    }
    current = parent;
  }
  return "not awaited";
}

/**
 * Finds route-service calls whose promise leaks without an ownership boundary.
 * ignoreCalls carries statement-position calls the floating-promise rule
 * already reported, so a defect is never double-flagged.
 */
export function findUnawaitedRouteServiceCalls({ checker, sourceFile, portMap, ignoreCalls }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && !ignoreCalls.has(node)) {
      const identified = identifyRouteServiceCall(checker, node, portMap);
      if (identified && isAsyncRouteServiceCall(checker, node, identified, portMap)) {
        const violation = judgePromiseUse(checker, node, new Set(), ignoreCalls);
        if (violation !== undefined) findings.push({ node, ...identified, violation });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
