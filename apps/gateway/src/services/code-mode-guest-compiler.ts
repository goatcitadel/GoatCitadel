import { ValidationError, type CodeModeLanguage } from "@goatcitadel/contracts";
import {
  API,
  DiagnosticCategory,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  type TranspileOptions,
} from "typescript-7/async";
import { ScriptKind, ScriptTarget, SyntaxKind, type Expression, type Identifier, type Node } from "typescript-7/ast";
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

export async function validateGuestSource(source: string): Promise<void> {
  await using compiler = new API();
  // The beta's standalone AST lease has no diagnostics. Ask its isolated transpiler for TSX syntax errors.
  await checkTranspile(
    compiler,
    source,
    {
      fileName: "code-mode-source.tsx",
      compilerOptions: { ...compilerOptions, jsx: JsxEmit.Preserve },
      reportDiagnostics: true,
    },
    "Code Mode source could not be parsed",
  );
  await using parsed = await compiler.createSourceFile("code-mode-source.tsx", source, { scriptKind: ScriptKind.TSX });
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
    if (ast.isCallExpression(node)) {
      forbiddenLabel = readBlockedGuestSourceCallLabel(node.expression);
      if (forbiddenLabel) {
        return;
      }
    }
    if (ast.isPropertyAccessExpression(node) && isProcessGuestSourceExpression(node.expression)) {
      forbiddenLabel = "process";
      return;
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

function readBlockedGuestSourceCallLabel(expression: Expression): string | undefined {
  if (expression.kind === SyntaxKind.ImportKeyword) {
    return "dynamic import";
  }
  if (isProcessGuestSourceExpression(expression)) {
    return "process";
  }
  if (ast.isIdentifier(expression)) {
    return readBlockedGuestSourceIdentifierLabel(expression.text);
  }
  if (ast.isPropertyAccessExpression(expression)) {
    return readBlockedGuestSourceIdentifierLabel(expression.name.text);
  }
  return undefined;
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
  if (ast.isIdentifier(expression)) {
    return expression.text === "process";
  }
  if (ast.isPropertyAccessExpression(expression)) {
    return expression.name.text === "process" || isProcessGuestSourceExpression(expression.expression);
  }
  return false;
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
  if (ast.isBindingElement(parent) && parent.name === identifier) {
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
