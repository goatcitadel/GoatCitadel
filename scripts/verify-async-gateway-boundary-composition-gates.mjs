import path from "node:path";
import ts from "typescript";

// Route composition modules (apps/gateway/src/services/gateway-route-composition-*.ts)
// read GatewayService through GatewayRouteCompositionPort, whose members are
// largely typed `RouteDependencyMethod<"key", "method">` -- an indexed access
// into the erased `(...args: any[]) => any` route ports. A promise-returning
// GatewayService method therefore reads as `any` there, so tsc and the floating
// promise scan both miss `if (!gateway.isFeatureEnabled(flag))` (a pending
// Promise is truthy: the gate fails open) and `gateway.isFeatureEnabled(flag)
// === true` (a Promise never equals true: the gate fails closed). This module
// recovers async-ness from GatewayService's real class signatures and flags
// unresolved promises used as booleans inside those composition modules.

const GATEWAY_SERVICE_RELATIVE_PATH = "apps/gateway/src/services/gateway-service.ts";
const GATEWAY_SERVICE_CLASS_NAME = "GatewayService";
const COMPOSITION_PORT_RELATIVE_PATH = "apps/gateway/src/services/gateway-route-composition-port.ts";
const COMPOSITION_PORT_INTERFACE_NAME = "GatewayRouteCompositionPort";
const COMPOSITION_MODULE_PATTERN = /^apps\/gateway\/src\/services\/gateway-route-composition-[^/]+\.ts$/u;
const EQUALITY_OPERATORS = new Map([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "==="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!=="],
  [ts.SyntaxKind.EqualsEqualsToken, "=="],
  [ts.SyntaxKind.ExclamationEqualsToken, "!="],
]);
const LOGICAL_OPERATORS = new Map([
  [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
  [ts.SyntaxKind.BarBarToken, "||"],
  [ts.SyntaxKind.QuestionQuestionToken, "??"],
]);

function normalizeAbsolutePath(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/").toLowerCase();
}

function isTransparentWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function unwrapExpression(expression) {
  while (isTransparentWrapper(expression)) expression = expression.expression;
  return expression;
}

function isExactPromiseType(checker, type) {
  if (type.isUnion()) return type.types.some((member) => isExactPromiseType(checker, member));
  const apparent = checker.getApparentType(type);
  const symbol = apparent.aliasSymbol ?? apparent.getSymbol();
  return symbol?.getName() === "Promise";
}

function classifySignatures(checker, signatures) {
  let sawErased = false;
  for (const signature of signatures) {
    const returnType = checker.getReturnTypeOfSignature(signature);
    if ((returnType.flags & ts.TypeFlags.Any) !== 0) {
      sawErased = true;
      continue;
    }
    if (isExactPromiseType(checker, returnType)) return "async";
  }
  return sawErased ? "erased" : "sync";
}

function findProgramFile(program, repoRoot, relativePath) {
  const target = normalizeAbsolutePath(path.join(repoRoot, ...relativePath.split("/")));
  return program.getSourceFiles().find((sourceFile) => normalizeAbsolutePath(sourceFile.fileName) === target);
}

function findNamedStatement(sourceFile, predicate, name) {
  return sourceFile?.statements.find((statement) => predicate(statement) && statement.name?.text === name);
}

function classifyTypeMembers(checker, type, location) {
  const methods = new Map();
  for (const property of type.getProperties()) {
    const signatures = checker.getTypeOfSymbolAtLocation(property, location).getCallSignatures();
    if (signatures.length > 0) methods.set(property.getName(), classifySignatures(checker, signatures));
  }
  return methods;
}

/**
 * Builds the GatewayService method async map used to judge composition-port
 * reads. Returns undefined when GatewayService is absent (fixture repositories).
 * Throws when a composition-port method is erased to `any` and GatewayService
 * has no real signature for it, so the rule cannot silently lose coverage.
 */
export function buildCompositionGateMap({ program, checker, repoRoot }) {
  const serviceFile = findProgramFile(program, repoRoot, GATEWAY_SERVICE_RELATIVE_PATH);
  const serviceClass = findNamedStatement(serviceFile, ts.isClassDeclaration, GATEWAY_SERVICE_CLASS_NAME);
  if (!serviceClass?.name) return undefined;
  const classSymbol = checker.getSymbolAtLocation(serviceClass.name);
  if (!classSymbol) return undefined;
  const methods = classifyTypeMembers(checker, checker.getDeclaredTypeOfSymbol(classSymbol), serviceClass);

  const portFile = findProgramFile(program, repoRoot, COMPOSITION_PORT_RELATIVE_PATH);
  const portInterface = findNamedStatement(portFile, ts.isInterfaceDeclaration, COMPOSITION_PORT_INTERFACE_NAME);
  const portSymbol = portInterface ? checker.getSymbolAtLocation(portInterface.name) : undefined;
  if (portInterface && portSymbol) {
    const portMethods = classifyTypeMembers(checker, checker.getDeclaredTypeOfSymbol(portSymbol), portInterface);
    const unresolved = [...portMethods]
      .filter(([name, classification]) => classification === "erased" && !["async", "sync"].includes(methods.get(name)))
      .map(([name]) => name)
      .sort();
    if (unresolved.length > 0) {
      throw new Error(
        `Composition-port gate map could not classify ${unresolved.join(", ")}: these ` +
          `${COMPOSITION_PORT_INTERFACE_NAME} members are erased to \`any\` and ${GATEWAY_SERVICE_CLASS_NAME} has no ` +
          "checker-visible signature for them. If the list is large, workspace package types are probably " +
          "unresolved — run `pnpm install` and `pnpm --filter @goatcitadel/gateway typecheck` first. Otherwise " +
          "teach scripts/verify-async-gateway-boundary-composition-gates.mjs where the method now lives.",
      );
    }
  }
  return { methods };
}

export function isCompositionModulePath(filePath) {
  return COMPOSITION_MODULE_PATTERN.test(filePath);
}

function isCompositionPortProperty(symbol) {
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      const container = declaration.parent;
      if (ts.isInterfaceDeclaration(container)) return container.name.text === COMPOSITION_PORT_INTERFACE_NAME;
      if (ts.isClassDeclaration(container)) return container.name?.text === GATEWAY_SERVICE_CLASS_NAME;
      return false;
    }),
  );
}

/**
 * Identifies `gateway.method(...)` and destructured `method(...)` calls whose
 * callee is a GatewayRouteCompositionPort (or GatewayService) member, including
 * through Pick/Omit/intersection views of the port.
 */
function identifyCompositionPortCall(checker, call) {
  const callee = unwrapExpression(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    return isCompositionPortProperty(checker.getSymbolAtLocation(callee.name))
      ? { receiver: callee.expression.getText(), methodName: callee.name.text }
      : undefined;
  }
  if (!ts.isIdentifier(callee)) return undefined;
  const declaration = checker.getSymbolAtLocation(callee)?.valueDeclaration;
  if (!declaration || !ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) {
    return undefined;
  }
  const variable = declaration.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer) return undefined;
  const nameNode = declaration.propertyName ?? declaration.name;
  if (!ts.isIdentifier(nameNode)) return undefined;
  const property = checker.getTypeAtLocation(variable.initializer).getNonNullableType().getProperty(nameNode.text);
  return isCompositionPortProperty(property)
    ? { receiver: variable.initializer.getText(), methodName: nameNode.text }
    : undefined;
}

function isAsyncCompositionPortCall(checker, call, identified, gateMap) {
  const classification = gateMap.methods.get(identified.methodName);
  if (classification === "async") return true;
  if (classification === "sync") return false;
  return isExactPromiseType(checker, checker.getTypeAtLocation(call));
}

function enclosingFunctionIsAsync(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return Boolean(current?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

/**
 * A logical expression whose right operand is a promise evaluates to
 * `falsy | Promise`. That is only safe when the whole expression is awaited, or
 * returned from an async function (which adopts it).
 */
function logicalValueIsResolved(logical) {
  let current = logical;
  while (current.parent && isTransparentWrapper(current.parent)) current = current.parent;
  const parent = current.parent;
  if (ts.isAwaitExpression(parent)) return true;
  if (ts.isReturnStatement(parent)) return enclosingFunctionIsAsync(parent);
  if (ts.isArrowFunction(parent) && parent.body === current) {
    return Boolean(parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
  }
  return false;
}

function isConditionOf(parent, node) {
  return (
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === node) ||
    (ts.isForStatement(parent) && parent.condition === node) ||
    (ts.isConditionalExpression(parent) && parent.condition === node)
  );
}

/**
 * Returns a violation phrase when the promise-valued node is consumed as a
 * boolean before resolution, or undefined when this rule has nothing to say
 * (other uses belong to the floating-promise rules).
 */
function judgeBooleanUse(node) {
  let current = node;
  while (current.parent && isTransparentWrapper(current.parent)) current = current.parent;
  const parent = current.parent;
  if (!parent) return undefined;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return "negated with '!' (a pending Promise is always truthy, so the gate fails open)";
  }
  if (isConditionOf(parent, current)) {
    return "used as a condition (a pending Promise is always truthy, so the gate fails open)";
  }
  if (!ts.isBinaryExpression(parent)) return undefined;
  const equality = EQUALITY_OPERATORS.get(parent.operatorToken.kind);
  if (equality) {
    return `compared with '${equality}' (a pending Promise never equals a boolean, so the gate is stuck)`;
  }
  const logical = LOGICAL_OPERATORS.get(parent.operatorToken.kind);
  if (!logical) return undefined;
  if (parent.left === current) {
    return logical === "??"
      ? "used as the left side of '??' (a Promise is never nullish, so the fallback never applies)"
      : `used as the left operand of '${logical}' (a pending Promise is always truthy)`;
  }
  if (logical === "??" || logicalValueIsResolved(parent)) return undefined;
  return `used as the right operand of '${logical}' without awaiting it (the result is a Promise, not a boolean)`;
}

function judgeAssignedPromise(checker, call) {
  let current = call;
  while (current.parent && isTransparentWrapper(current.parent)) current = current.parent;
  const declaration = current.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== current) return [];
  if (!ts.isIdentifier(declaration.name)) return [];
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return [];
  const violations = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node !== declaration.name && checker.getSymbolAtLocation(node) === symbol) {
      const violation = judgeBooleanUse(node);
      if (violation) violations.push({ node, violation });
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return violations;
}

/**
 * Finds promise-returning composition-port reads used as booleans before
 * resolution, directly or through a local variable.
 */
export function findUnawaitedCompositionGates({ checker, sourceFile, gateMap }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const identified = identifyCompositionPortCall(checker, node);
      if (identified && isAsyncCompositionPortCall(checker, node, identified, gateMap)) {
        const direct = judgeBooleanUse(node);
        if (direct) findings.push({ node, ...identified, violation: direct });
        for (const indirect of judgeAssignedPromise(checker, node)) {
          findings.push({ ...identified, ...indirect, violation: `${indirect.violation} via a local variable` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
