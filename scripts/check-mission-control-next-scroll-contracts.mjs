#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_SCAN_ROOT = path.join(repoRoot, "apps", "mission-control-next", "src", "features", "native-routes");

const BOUNDED_BY_DEFAULT = new Set([
  "NativeSelectableList",
  "SettingsActionList",
  "LibraryActionList",
  "LibrarySelectableList",
]);
const OPTIONALLY_BOUNDED = new Set(["NativeList"]);

function jsxTagName(tagName) {
  return ts.isIdentifier(tagName) ? tagName.text : tagName.getText();
}

function findAttribute(attributes, name) {
  return attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === name);
}

function booleanAttributeEnabled(attribute) {
  if (!attribute) {
    return false;
  }
  if (!attribute.initializer) {
    return true;
  }
  if (!ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.text !== "false";
  }
  const expression = attribute.initializer.expression;
  return expression ? expression.kind !== ts.SyntaxKind.FalseKeyword : false;
}

function isExplicitlyUnbounded(attribute) {
  if (!attribute?.initializer) {
    return false;
  }
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text.length === 0;
  }
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
    return false;
  }
  const expression = attribute.initializer.expression;
  return (
    (ts.isStringLiteral(expression) && expression.text.length === 0) ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined")
  );
}

function isBoundedCollection(openingElement) {
  const name = jsxTagName(openingElement.tagName);
  if (!BOUNDED_BY_DEFAULT.has(name) && !OPTIONALLY_BOUNDED.has(name)) {
    return null;
  }
  const maxHeight = findAttribute(openingElement.attributes, "maxHeight");
  if (isExplicitlyUnbounded(maxHeight)) {
    return null;
  }
  if (BOUNDED_BY_DEFAULT.has(name) || maxHeight) {
    return name;
  }
  return null;
}

function findBoundedDescendants(node) {
  const names = new Set();
  const visit = (child) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      const openingElement = ts.isJsxElement(child) ? child.openingElement : child;
      const name = isBoundedCollection(openingElement);
      if (name) {
        names.add(name);
      }
    }
    ts.forEachChild(child, visit);
  };
  node.children.forEach(visit);
  return [...names].sort();
}

export function findNativeScrollContractViolations(filePath, contents) {
  const source = ts.createSourceFile(filePath, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];
  const visit = (node) => {
    if (ts.isJsxElement(node) && jsxTagName(node.openingElement.tagName) === "NativeCard") {
      const scrollBody = findAttribute(node.openingElement.attributes, "scrollBody");
      if (booleanAttributeEnabled(scrollBody)) {
        const boundedDescendants = findBoundedDescendants(node);
        if (boundedDescendants.length > 0) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push({
            file: filePath,
            line: position.line + 1,
            boundedDescendants,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

async function walk(directory, files) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "dist-node") {
        await walk(target, files);
      }
    } else if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      files.push(target);
    }
  }
}

export async function collectNativeScrollContractViolations({ scanRoot = DEFAULT_SCAN_ROOT } = {}) {
  const files = [];
  await walk(scanRoot, files);
  const violations = [];
  for (const file of files) {
    violations.push(...findNativeScrollContractViolations(file, await fs.readFile(file, "utf8")));
  }
  return { files, violations };
}

async function main() {
  const { files, violations } = await collectNativeScrollContractViolations();
  if (violations.length === 0) {
    console.log(`scroll-contracts: ok (${files.length} TSX files scanned)`);
    return;
  }
  console.error(`scroll-contracts: ${violations.length} double-scroll NativeCard context(s) found.`);
  console.error("A NativeCard may own a bounded body or contain a bounded collection, never both.\n");
  for (const violation of violations) {
    const relativeFile = path.relative(repoRoot, violation.file).split(path.sep).join("/");
    console.error(`  ${relativeFile}:${violation.line} (${violation.boundedDescendants.join(", ")})`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("scroll-contracts: script error", error);
    process.exitCode = 2;
  });
}
