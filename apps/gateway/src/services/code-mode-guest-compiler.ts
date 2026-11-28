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
  type BindingElement,
  type Expression,
  type Identifier,
  type Node,
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
  let forbiddenLabel: string | undefined;
  const visit = (node: Node): void => {
    if (forbiddenLabel) {
      return;
    }
    if (ast.isImportDeclaration(node) || ast.isImportEqualsDeclaration(node)) {
      forbiddenLabel = "import statements";
      return;
    }
    if (ast.isExportDeclaration(node) && node.moduleSpecifier) {
      forbiddenLabel = "module re-exports";
      return;
    }
    if (ast.isCallExpression(node)) {
      forbiddenLabel = readBlockedGuestSourceCallLabel(node.expression);
      if (forbiddenLabel) {
        return;
      }
    }
    if (ast.isPropertyAccessExpression(node) || ast.isElementAccessExpression(node)) {
      const name = readStaticGuestPropertyName(node);
      if (name === "process" || isProcessGuestSourceExpression(node.expression)) {
        forbiddenLabel = "process";
        return;
      }
      if (name && isGuestGlobalReceiver(node.expression)) {
        forbiddenLabel = readBlockedGuestSourceIdentifierLabel(name);
        if (forbiddenLabel) {
          return;
        }
      }
    }
    if (ast.isBindingElement(node)) {
      forbiddenLabel = readBlockedGuestSourceBindingLabel(node);
      if (forbiddenLabel) {
        return;
      }
    }
    if (ast.isIdentifier(node) && isBlockedGuestSourceIdentifierReference(node)) {
      forbiddenLabel = readBlockedGuestSourceIdentifierLabel(node.text);
      if (forbiddenLabel) {
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(root);
  return forbiddenLabel;
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
  const key = binding.propertyName ?? binding.name;
  if (!key) {
    return undefined;
  }
  if (ast.isIdentifier(key)) {
    return readBlockedGuestSourceIdentifierLabel(key.text);
  }
  const expression = ast.isComputedPropertyName(key) ? unwrapGuestSourceExpression(key.expression) : key;
  if (ast.isStringLiteral(expression) || ast.isNoSubstitutionTemplateLiteral(expression)) {
    return readBlockedGuestSourceIdentifierLabel(expression.text);
  }
  return undefined;
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
  if (isProcessGuestSourceExpression(expression)) {
    return "process";
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

function isProcessGuestSourceExpression(expression: Expression): boolean {
  expression = unwrapGuestSourceExpression(expression);
  if (ast.isIdentifier(expression)) {
    return expression.text === "process";
  }
  if (ast.isPropertyAccessExpression(expression) || ast.isElementAccessExpression(expression)) {
    return (
      readStaticGuestPropertyName(expression) === "process" || isProcessGuestSourceExpression(expression.expression)
    );
  }
  return false;
}

function readStaticGuestPropertyName(expression: Expression): string | undefined {
  if (ast.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ast.isElementAccessExpression(expression)) {
    const key = unwrapGuestSourceExpression(expression.argumentExpression);
    if (ast.isStringLiteral(key) || ast.isNoSubstitutionTemplateLiteral(key)) {
      return key.text;
    }
  }
  return undefined;
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
  if (ast.isPropertyAccessExpression(parent) && parent.name === identifier) {
    return false;
  }
  if (ast.isPropertyAssignment(parent) && parent.name === identifier) {
    return false;
  }
  if (
    (ast.isPropertySignatureDeclaration(parent) || ast.isMethodSignatureDeclaration(parent)) &&
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
