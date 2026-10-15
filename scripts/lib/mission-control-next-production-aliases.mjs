import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourceOwners = [
  ["contracts", "source-exported contracts alias"],
  ["threaded-surface-core", "source-exported threaded-surface-core alias"],
  ["mission-control-shared", "source-exported mission-control-shared alias"],
];

/** Inspect actual exported production aliases; never execute a Vite config or scan unrelated metadata. */
export function findProductionSourceExportAliases(filePath, source) {
  try {
    const replacements = filePath.endsWith(".json")
      ? readTsconfigPaths(filePath, source)
      : readViteAliases(filePath, source);
    return sourceOwners.flatMap(([owner, label]) => {
      const pattern = new RegExp(`(?:^|/)packages/${owner}/src(?:/|$)`, "u");
      const count = replacements.filter((value) => pattern.test(value.replaceAll("\\", "/"))).length;
      return count ? [{ filePath, label, count }] : [];
    });
  } catch (error) {
    return [
      {
        filePath,
        label: "unresolved production source-export alias configuration",
        count: 1,
        reason: String(error.message).slice(0, 400),
      },
    ];
  }
}

function readTsconfigPaths(filePath, source) {
  const parsed = ts.parseConfigFileTextToJson(filePath, source);
  if (parsed.error) throw new Error("Cannot parse the production tsconfig.");
  const options = parsed.config?.compilerOptions;
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)))
    throw new Error("Unsupported tsconfig compilerOptions.");
  if (options?.paths === undefined) return [];
  if (!options.paths || typeof options.paths !== "object" || Array.isArray(options.paths))
    throw new Error("Unsupported tsconfig paths.");
  if (options.baseUrl !== undefined && typeof options.baseUrl !== "string")
    throw new Error("Unsupported tsconfig baseUrl.");
  return Object.values(options.paths).flatMap((values) => {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
      throw new Error("Unsupported tsconfig path replacement.");
    return values.map((value) => path.resolve(path.dirname(filePath), options.baseUrl ?? ".", value));
  });
}

function readViteAliases(filePath, text) {
  const ast = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error("Cannot parse the production Vite config.");
  const imports = new Map();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (statement.importClause?.name)
      imports.set(statement.importClause.name.text, [module, "default", statement.importClause.name]);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const entry of bindings.elements)
        imports.set(entry.name.text, [module, entry.propertyName?.text ?? entry.name.text, entry.name]);
    if (bindings && ts.isNamespaceImport(bindings))
      imports.set(bindings.name.text, [module, "namespace", bindings.name]);
  }
  const exports = ast.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0].isExportEquals) throw new Error("Expected one production default config.");
  const reachedData = new Set();
  const reachedHelpers = new Set();
  function binds(name, binding) {
    if (ts.isIdentifier(binding)) return binding.text === name;
    if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding))
      return binding.elements.some((element) => ts.isBindingElement(element) && binds(name, element.name));
    return false;
  }
  function localBinding(node) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (
        ts.isFunctionLike(scope) &&
        (scope.parameters.some((parameter) => binds(node.text, parameter.name)) || scope.name?.text === node.text)
      )
        return { unsupported: true, item: scope };
      if (ts.isCatchClause(scope) && scope.variableDeclaration && binds(node.text, scope.variableDeclaration.name))
        return { unsupported: true, item: scope.variableDeclaration };
      if (
        (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
        scope.initializer &&
        ts.isVariableDeclarationList(scope.initializer)
      ) {
        const item = scope.initializer.declarations.find((entry) => binds(node.text, entry.name));
        if (item) return { unsupported: true, item };
      }
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      const callable = scope.statements.find(
        (statement) =>
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === node.text,
      );
      if (callable) return { unsupported: true, item: callable };
      const matches = scope.statements.flatMap((statement) =>
        ts.isVariableStatement(statement)
          ? statement.declarationList.declarations
              .filter((item) => binds(node.text, item.name))
              .map((item) => ({ statement, item }))
          : [],
      );
      if (matches.length) return matches.length === 1 ? matches[0] : { unsupported: true };
    }
    return undefined;
  }
  function imported(node, module, originalNames, record = true) {
    if (!ts.isIdentifier(node)) return false;
    const binding = imports.get(node.text);
    const proven = Boolean(
      binding && binding[0] === module && originalNames.includes(binding[1]) && !localBinding(node),
    );
    if (proven && record && module !== "vite") {
      // Sibling imports from one Node helper module do not isolate its observable state.
      for (const entry of imports.values()) if (entry[0] === module) reachedHelpers.add(entry[2]);
    }
    return proven;
  }
  function unwrap(node) {
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node))
    )
      node = node.expression;
    return node;
  }
  function reference(node, visited) {
    node = unwrap(node);
    if (!ts.isIdentifier(node)) return node;
    if (visited.has(node)) throw new Error("Cyclic production alias definition.");
    visited.add(node);
    const binding = localBinding(node);
    if (
      !binding ||
      binding.unsupported ||
      !ts.isIdentifier(binding.item.name) ||
      !(binding.statement.declarationList.flags & ts.NodeFlags.Const) ||
      !binding.item.initializer
    )
      throw new Error("Unresolved, runtime, destructured or mutable production alias definition.");
    const value = reference(binding.item.initializer, visited);
    if (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value)) reachedData.add(binding.item);
    return value;
  }
  function propertyName(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
    if (ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression)) return node.expression.text;
    throw new Error("Unsupported computed config property.");
  }
  function object(node, visited = new Set()) {
    node = reference(node, visited);
    if (!ts.isObjectLiteralExpression(node)) throw new Error("Expected a literal config object.");
    const values = new Map();
    for (const member of node.properties) {
      const rows = ts.isSpreadAssignment(member)
        ? object(member.expression, new Set(visited))
        : [
            [
              propertyName(member.name),
              ts.isPropertyAssignment(member)
                ? member.initializer
                : ts.isShorthandPropertyAssignment(member)
                  ? member.name
                  : member,
            ],
          ];
      for (const [key, value] of rows) {
        if (values.has(key)) throw new Error("Ambiguous duplicate config property.");
        values.set(key, value);
      }
    }
    return values;
  }
  function string(node, visited = new Set()) {
    node = reference(node, visited);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return string(node.left, new Set(visited)) + string(node.right, new Set(visited));
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans.map((span) => string(span.expression, new Set(visited)) + span.literal.text).join("")
      );
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === "url"
    )
      return pathToFileURL(filePath).href;
    if (
      ts.isCallExpression(node) &&
      imported(node.expression, "node:url", ["fileURLToPath"]) &&
      node.arguments.length === 1
    )
      return fileURLToPath(string(node.arguments[0], new Set(visited)));
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      imported(node.expression.expression, "node:path", ["default", "namespace"])
    ) {
      const args = node.arguments.map((item) => string(item, new Set(visited)));
      if (node.expression.name.text === "resolve") return path.resolve(path.dirname(filePath), ...args);
      if (node.expression.name.text === "join") return path.join(...args);
      if (node.expression.name.text === "dirname" && args.length === 1) return path.dirname(args[0]);
    }
    throw new Error("Unsupported production alias replacement.");
  }
  function aliases(node, visited = new Set()) {
    node = reference(node, visited);
    if (ts.isArrayLiteralExpression(node))
      return node.elements.flatMap((entry) => {
        if (ts.isSpreadElement(entry)) return aliases(entry.expression, new Set(visited));
        const values = object(entry, new Set(visited));
        if ([...values.keys()].some((key) => key !== "find" && key !== "replacement"))
          throw new Error("Unsupported production alias entry resolver field.");
        const replacement = values.get("replacement");
        if (!replacement) throw new Error("Alias entry has no replacement.");
        return [string(replacement)];
      });
    return [...object(node, visited).values()].map((replacement) => string(replacement));
  }
  function roots(node, visited = new Set()) {
    node = reference(node, visited);
    if (ts.isCallExpression(node) && imported(node.expression, "vite", ["defineConfig"]) && node.arguments.length === 1)
      return roots(node.arguments[0], visited);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (!ts.isBlock(node.body)) return roots(node.body, visited);
      const returned = [];
      function visit(current) {
        if (ts.isFunctionLike(current)) return;
        if (ts.isReturnStatement(current)) {
          if (!current.expression) throw new Error("Empty production config return.");
          returned.push(...roots(current.expression, new Set(visited)));
          return;
        }
        ts.forEachChild(current, visit);
      }
      visit(node.body);
      if (!returned.length) throw new Error("Missing production config return.");
      return returned;
    }
    if (ts.isConditionalExpression(node))
      return [...roots(node.whenTrue, new Set(visited)), ...roots(node.whenFalse, new Set(visited))];
    return [object(node, visited)];
  }
  const replacements = roots(exports[0].expression).flatMap((config) => {
    const resolve = config.get("resolve");
    if (!resolve) return [];
    const alias = object(resolve).get("alias");
    return alias ? aliases(alias) : [];
  });
  rejectAliasDataMutation(reachedData);
  rejectAliasDataMutation(reachedHelpers, true);
  return replacements;

  function isPureImportedHelperCall(node) {
    if (!ts.isCallExpression(node)) return false;
    if (imported(node.expression, "node:url", ["fileURLToPath"], false)) return true;
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      imported(node.expression.expression, "node:path", ["default", "namespace"], false) &&
      ["resolve", "join", "dirname", "extname"].includes(node.expression.name.text)
    );
  }

  function rejectAliasDataMutation(bindings, helperCustody = false) {
    if (!bindings.size) return;
    const assignments = new Set(
      [
        "EqualsToken",
        "PlusEqualsToken",
        "MinusEqualsToken",
        "AsteriskEqualsToken",
        "AsteriskAsteriskEqualsToken",
        "SlashEqualsToken",
        "PercentEqualsToken",
        "LessThanLessThanEqualsToken",
        "GreaterThanGreaterThanEqualsToken",
        "GreaterThanGreaterThanGreaterThanEqualsToken",
        "AmpersandEqualsToken",
        "BarEqualsToken",
        "CaretEqualsToken",
        "BarBarEqualsToken",
        "AmpersandAmpersandEqualsToken",
        "QuestionQuestionEqualsToken",
      ].map((name) => ts.SyntaxKind[name]),
    );
    const nodes = [];
    function collect(node) {
      nodes.push(node);
      ts.forEachChild(node, collect);
    }
    collect(ast);
    function valueReference(node) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
      if (
        (ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
        parent.name === node
      )
        return false;
      if (
        (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) &&
        parent.name === node
      )
        return false;
      return true;
    }
    function usesData(node) {
      let found = false;
      function visit(current) {
        if (found || ts.isTypeNode(current)) return;
        if (helperCustody && isPureImportedHelperCall(current)) {
          for (const argument of current.arguments) visit(argument);
          return;
        }
        if (ts.isIdentifier(current) && valueReference(current) && bindings.has(bindingOwner(current))) {
          found = true;
          return;
        }
        ts.forEachChild(current, visit);
      }
      visit(node);
      return found;
    }
    function bindingOwner(node) {
      const local = localBinding(node);
      return local ? local.item : helperCustody ? imports.get(node.text)?.[2] : undefined;
    }
    function receiver(node) {
      node = unwrap(node);
      while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = unwrap(node.expression);
      return ts.isIdentifier(node) ? bindingOwner(node) : undefined;
    }
    // Track pointer aliases/containers so a second name cannot launder the same mutable alias data.
    let changed;
    do {
      changed = false;
      for (const node of nodes) {
        if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && usesData(node.expression)) {
          const targets = ts.isVariableDeclarationList(node.initializer)
            ? node.initializer.declarations
            : [receiver(node.initializer)];
          if (targets.some((target) => !target))
            throw new Error("Alias data escapes into an unknown iterator binding.");
          for (const target of targets)
            if (!bindings.has(target)) {
              bindings.add(target);
              changed = true;
            }
        }
        if (ts.isVariableDeclaration(node) && node.initializer && usesData(node.initializer) && !bindings.has(node)) {
          bindings.add(node);
          changed = true;
        }
        if (ts.isFunctionDeclaration(node) && node.body && usesData(node.body) && !bindings.has(node)) {
          bindings.add(node);
          changed = true;
        }
        if (ts.isBinaryExpression(node) && assignments.has(node.operatorToken.kind) && usesData(node.right)) {
          const target = receiver(node.left);
          if (!target) throw new Error("Alias data escapes into an unknown assignment owner.");
          if (!bindings.has(target)) {
            bindings.add(target);
            changed = true;
          }
        }
      }
    } while (changed);
    for (const node of nodes) {
      if (ts.isBinaryExpression(node) && assignments.has(node.operatorToken.kind) && bindings.has(receiver(node.left)))
        throw new Error("Production alias data is written after initialization.");
      if (ts.isDeleteExpression(node) && bindings.has(receiver(node.expression)))
        throw new Error("Production alias data is deleted.");
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        bindings.has(receiver(node.operand))
      )
        throw new Error("Production alias data is updated.");
      if (ts.isTaggedTemplateExpression(node)) {
        if (bindings.has(receiver(node.tag)) || usesData(node.template))
          throw new Error("Production alias data escapes through a tagged template.");
        continue;
      }
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) continue;
      const pureHelper = helperCustody && isPureImportedHelperCall(node);
      if (bindings.has(receiver(node.expression)) && !pureHelper)
        throw new Error("Production alias data or a related closure is invoked.");
      if (
        (node.arguments ?? []).some(usesData) &&
        !(ts.isCallExpression(node) && imported(node.expression, "vite", ["defineConfig"]))
      )
        throw new Error("Production alias data escapes to an unknown function or constructor.");
    }
  }
}
