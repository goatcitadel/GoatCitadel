import { ValidationError, type CodeModeLanguage } from "@goatcitadel/contracts";
import {
  API,
  DiagnosticCategory,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  type TranspileOptions,
} from "typescript-7/async";
import {
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type BinaryExpression,
  type BindingElement,
  type Expression,
  type Identifier,
  type Node,
  type PropertyName,
} from "typescript-7/ast";
import * as ast from "typescript-7/ast/is";

const compilerOptions = {
  target: ScriptTarget.ES2022,
  module: ModuleKind.ESNext,
  isolatedModules: true,
  moduleResolution: ModuleResolutionKind.Bundler,
  noResolve: true,
  removeComments: false,
  sourceMap: false,
  inlineSourceMap: false,
  inlineSources: false,
};

export async function validateGuestSource(language: CodeModeLanguage, source: string): Promise<void> {
  await using compiler = new API();
  const isTypeScript = language === "typescript";
  let fileName = isTypeScript ? "code-mode-source.ts" : "code-mode-source.js";
  let scriptKind = isTypeScript ? ScriptKind.TS : ScriptKind.JS;
  // The beta's standalone AST lease has no diagnostics. Ask its isolated transpiler to check syntax.
  const syntaxError = "Code Mode source could not be parsed";
  try {
    await checkTranspile(compiler, source, { fileName, compilerOptions, reportDiagnostics: true }, syntaxError);
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    // Preserve the existing JSX admission contract. The execution compiler still owns emission.
    fileName = isTypeScript ? "code-mode-source.tsx" : "code-mode-source.jsx";
    scriptKind = isTypeScript ? ScriptKind.TSX : ScriptKind.JSX;
    await checkTranspile(
      compiler,
      source,
      { fileName, compilerOptions: { ...compilerOptions, jsx: JsxEmit.Preserve }, reportDiagnostics: true },
      syntaxError,
    );
  }
  await using parsed = await compiler.createSourceFile(fileName, source, { scriptKind });
  const forbiddenLabel = findForbiddenGuestSourceReference(parsed.sourceFile);
  if (forbiddenLabel) {
    throw new ValidationError({ message: `Code Mode source may not reference ${forbiddenLabel}.` });
  }
}

export async function transpileGuestSource(language: CodeModeLanguage, source: string): Promise<string> {
  if (language === "javascript") {
    return source;
  }
  await using compiler = new API();
  return await checkTranspile(
    compiler,
    source,
    {
      compilerOptions,
      reportDiagnostics: true,
    },
    "TypeScript transpilation failed",
  );
}

async function checkTranspile(
  compiler: API,
  source: string,
  options: TranspileOptions,
  errorMessage: string,
): Promise<string> {
  const result = await compiler.transpileModule(source, options);
  const error = result.diagnostics?.find((diagnostic) => diagnostic.category === DiagnosticCategory.Error);
  if (error) {
    throw new ValidationError({ message: `${errorMessage}: ${error.text}` });
  }
  return result.outputText;
}

function findForbiddenGuestSourceReference(root: Node): string | undefined {
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    const label = readBlockedGuestSourceNodeLabel(node);
    if (label) {
      return label;
    }
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    for (const child of children.reverse()) {
      pending.push(child);
    }
  }
  return undefined;
}

function readBlockedGuestSourceNodeLabel(node: Node): string | undefined {
  if (ast.isImportDeclaration(node) || ast.isImportEqualsDeclaration(node)) {
    return "import statements";
  }
  if (ast.isExportDeclaration(node) && node.moduleSpecifier) {
    return "module re-exports";
  }
  if (ast.isCallExpression(node)) {
    return readBlockedGuestSourceCallLabel(node.expression);
  }
  if (ast.isPropertyAccessExpression(node) || ast.isElementAccessExpression(node)) {
    // The traversal visits the receiver separately, including every segment of a member chain.
    const name = readStaticGuestPropertyName(node);
    if (name === "process") {
      return "process";
    }
    if (isGuestGlobalReceiver(node.expression)) {
      return readBlockedGuestGlobalPropertyLabel(name);
    }
  }
  if (ast.isBindingElement(node)) {
    return readBlockedGuestSourceBindingLabel(node);
  }
  if (ast.isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    return readBlockedGuestSourceAssignmentLabel(node);
  }
  if (ast.isIdentifier(node)) {
    const label = readBlockedGuestSourceIdentifierLabel(node.text);
    return label && isBlockedGuestSourceIdentifierReference(node) ? label : undefined;
  }
  return undefined;
}

function readBlockedGuestSourceBindingLabel(binding: BindingElement): string | undefined {
  const pattern = binding.parent;
  const declaration = pattern?.parent;
  if (
    binding.dotDotDotToken ||
    !pattern ||
    !ast.isObjectBindingPattern(pattern) ||
    !declaration ||
    (!ast.isVariableDeclaration(declaration) && !ast.isParameterDeclaration(declaration)) ||
    !declaration.initializer ||
    !isGuestGlobalReceiver(declaration.initializer)
  ) {
    return undefined;
  }
  if (binding.propertyName) {
    return readBlockedGuestGlobalPatternLabel(binding.propertyName);
  }
  return binding.name && ast.isIdentifier(binding.name)
    ? readBlockedGuestSourceIdentifierLabel(binding.name.text)
    : undefined;
}

function readBlockedGuestSourceAssignmentLabel(assignment: BinaryExpression): string | undefined {
  const pattern = unwrapGuestSourceExpression(assignment.left);
  if (!ast.isObjectLiteralExpression(pattern) || !isGuestGlobalReceiver(assignment.right)) {
    return undefined;
  }
  let label: string | undefined;
  pattern.forEachChild((property) => {
    if (!label && (ast.isPropertyAssignment(property) || ast.isShorthandPropertyAssignment(property))) {
      label = readBlockedGuestGlobalPatternLabel(property.name);
    }
  });
  return label;
}

function readBlockedGuestGlobalPatternLabel(key: PropertyName): string | undefined {
  if (ast.isComputedPropertyName(key)) {
    return readBlockedGuestGlobalPropertyLabel(readStaticGuestKey(key.expression));
  }
  if (ast.isIdentifier(key) || ast.isStringLiteral(key)) {
    return readBlockedGuestSourceIdentifierLabel(key.text);
  }
  return undefined;
}

function readBlockedGuestGlobalPropertyLabel(name: string | undefined): string | undefined {
  return name === undefined
    ? "computed global properties with unresolved names"
    : readBlockedGuestSourceIdentifierLabel(name);
}

function isGuestGlobalReceiver(expression: Expression): boolean {
  const receiver = unwrapGuestSourceExpression(expression);
  return ast.isIdentifier(receiver) && (receiver.text === "globalThis" || receiver.text === "global");
}

function readBlockedGuestSourceCallLabel(expression: Expression): string | undefined {
  expression = unwrapGuestSourceExpression(expression);
  if (expression.kind === SyntaxKind.ImportKeyword) {
    return "dynamic import";
  }
  if (ast.isIdentifier(expression)) {
    return readBlockedGuestSourceIdentifierLabel(expression.text);
  }
  const name = readStaticGuestPropertyName(expression);
  return name ? readBlockedGuestSourceIdentifierLabel(name) : undefined;
}

function readBlockedGuestSourceIdentifierLabel(text: string): string | undefined {
  if (text === "require") {
    return "require";
  }
  if (text === "process") {
    return "process";
  }
  if (text === "fetch") {
    return "fetch";
  }
  if (text === "setTimeout" || text === "setInterval" || text === "setImmediate" || text === "queueMicrotask") {
    return "timers or schedulers";
  }
  return undefined;
}

function readStaticGuestPropertyName(expression: Expression): string | undefined {
  if (ast.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ast.isElementAccessExpression(expression)) {
    return readStaticGuestKey(expression.argumentExpression);
  }
  return undefined;
}

function readStaticGuestKey(expression: Expression): string | undefined {
  const root = unwrapGuestSourceExpression(expression);
  if (ast.isNumericLiteral(root)) {
    return root.text;
  }
  const pending = [root];
  const parts: string[] = [];
  for (let current = pending.pop(); current; current = pending.pop()) {
    const key = unwrapGuestSourceExpression(current);
    if (ast.isStringLiteral(key) || ast.isNoSubstitutionTemplateLiteral(key)) {
      parts.push(key.text);
    } else if (ast.isBinaryExpression(key) && key.operatorToken.kind === SyntaxKind.PlusToken) {
      pending.push(key.right, key.left);
    } else {
      return undefined;
    }
  }
  return parts.join("");
}

function unwrapGuestSourceExpression(expression: Expression): Expression {
  while (
    ast.isParenthesizedExpression(expression) ||
    ast.isAsExpression(expression) ||
    ast.isTypeAssertion(expression) ||
    ast.isNonNullExpression(expression) ||
    ast.isSatisfiesExpression(expression) ||
    ast.isExpressionWithTypeArguments(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function isBlockedGuestSourceIdentifierReference(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) {
    return true;
  }
  if (
    (ast.isPropertyAccessExpression(parent) ||
      ast.isPropertyAssignment(parent) ||
      ast.isPropertySignatureDeclaration(parent) ||
      ast.isMethodSignatureDeclaration(parent) ||
      ast.isPropertyDeclaration(parent) ||
      ast.isMethodDeclaration(parent) ||
      ast.isGetAccessorDeclaration(parent) ||
      ast.isSetAccessorDeclaration(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (ast.isBindingElement(parent) && (parent.name === identifier || parent.propertyName === identifier)) {
    return false;
  }
  if (ast.isVariableDeclaration(parent) && parent.name === identifier) {
    return false;
  }
  if (ast.isParameterDeclaration(parent) && parent.name === identifier) {
    return false;
  }
  if (ast.isFunctionDeclaration(parent) && parent.name === identifier) {
    return false;
  }
  if (ast.isImportSpecifier(parent) || ast.isImportClause(parent) || ast.isNamespaceImport(parent)) {
    return false;
  }
  return true;
}
