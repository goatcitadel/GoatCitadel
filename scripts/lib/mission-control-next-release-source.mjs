import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const SECTION_TYPES = new Map([
  ["cowork", "CoworkSection"],
  ["library", "LibrarySection"],
  ["ops", "OpsSection"],
  ["settings", "SettingsSection"],
]);
const SCOPE_FIELDS = ["area", "section", "status", "releaseAction", "verification", "note"];
const appDirectory = "apps/mission-control-next/src/app";

/** Read canonical TypeScript literals without importing or executing application code. */
export async function readMissionControlNextReleaseAuthority(repoRoot, options = {}) {
  const directory = path.resolve(repoRoot, appDirectory);
  const modelFile = path.join(directory, "route-model.ts");
  const readSource = options.readSource ?? ((file) => readFile(file, "utf8"));
  const sources = new Map();
  function local(file) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(directory + path.sep) || path.extname(resolved) !== ".ts") {
      throw new Error("Canonical route metadata must use a local TypeScript owner.");
    }
    return resolved;
  }
  async function source(file) {
    file = local(file);
    if (!sources.has(file)) {
      if (sources.size >= 16) throw new Error("Canonical route source graph exceeds the supported ownership boundary.");
      const text = await readSource(file);
      if (typeof text !== "string") throw new Error(`Missing canonical route source: ${path.basename(file)}.`);
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      if (ast.parseDiagnostics.length) throw new Error(`Canonical route source has invalid syntax: ${path.basename(file)}.`);
      sources.set(file, ast);
    }
    return sources.get(file);
  }
  async function resolveExport(file, name, visited = new Set()) {
    file = local(file);
    const key = file + ":" + name;
    if (visited.has(key)) throw new Error(`Canonical route export cycle: ${name}.`);
    const next = new Set(visited); next.add(key);
    const ast = await source(file), declarations = [], reexports = [];
    for (const statement of ast.statements) {
      const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isVariableStatement(statement) && exported) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            if (!(statement.declarationList.flags & ts.NodeFlags.Const)) throw new Error(`Canonical route literal ${name} must be const.`);
            declarations.push(declaration);
          }
        }
      } else if (ts.isTypeAliasDeclaration(statement) && exported && statement.name.text === name) {
        declarations.push(statement);
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const entry of statement.exportClause.elements) {
          if (entry.name.text === name) {
            if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new Error(`Unsupported route source export: ${name}.`);
            reexports.push({ module: statement.moduleSpecifier.text, name: entry.propertyName?.text ?? entry.name.text });
          }
        }
      }
    }
    if (declarations.length + reexports.length !== 1) throw new Error(`Canonical route owner must export ${name} exactly once.`);
    if (declarations.length) return { file, declaration: declarations[0] };
    const target = reexports[0];
    if (!target.module.startsWith("./") || target.module.includes("\\")) throw new Error(`Nonlocal canonical route export: ${name}.`);
    const moduleName = target.module.replace(/\.(?:[cm]?js|ts)$/u, "");
    return resolveExport(local(path.resolve(path.dirname(file), moduleName + ".ts")), target.name, next);
  }
  function unwrap(node) {
    while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
  }
  function string(node, label) {
    node = unwrap(node);
    if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) || !node.text.trim()) {
      throw new Error(`Canonical route ${label} must be a nonempty string literal.`);
    }
    return node.text;
  }
  async function union(name) {
    const owner = await resolveExport(modelFile, name);
    if (!ts.isTypeAliasDeclaration(owner.declaration)) throw new Error(`Canonical route ${name} must be a literal type union.`);
    const nodes = ts.isUnionTypeNode(owner.declaration.type) ? owner.declaration.type.types : [owner.declaration.type];
    const values = nodes.map((node) => {
      if (!ts.isLiteralTypeNode(node)) throw new Error(`Canonical route ${name} must contain only string literal types.`);
      return string(node.literal, name);
    });
    if (!values.length || new Set(values).size !== values.length) throw new Error(`Canonical route ${name} has missing or duplicate literals.`);
    return values;
  }
  const areas = await union("PrimaryArea"), statuses = await union("ReleaseSurfaceStatus");
  const sectionsByArea = new Map();
  for (const [area, type] of SECTION_TYPES) {
    if (!areas.includes(area)) throw new Error(`Canonical route area ${area} is missing.`);
    sectionsByArea.set(area, await union(type));
  }
  const routeKeys = areas.flatMap((area) => (sectionsByArea.get(area) ?? ["root"]).map((section) => area + "/" + section));
  const owner = await resolveExport(modelFile, "ROUTE_RELEASE_SCOPE");
  if (!ts.isVariableDeclaration(owner.declaration)) throw new Error("Canonical release scope must be an exported literal array.");
  const value = unwrap(owner.declaration.initializer);
  if (!value || !ts.isArrayLiteralExpression(value) || !value.elements.length) throw new Error("Canonical release scope must be a nonempty literal array.");
  const seen = new Set();
  const scopes = value.elements.map((element) => {
    element = unwrap(element);
    if (!ts.isObjectLiteralExpression(element)) throw new Error("Canonical release scope rows must be ordinary object literals.");
    const row = new Map();
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error("Canonical release scope properties must be literal assignments.");
      const name = property.name.text;
      if (!SCOPE_FIELDS.includes(name) || row.has(name)) throw new Error(`Canonical release scope has unknown or duplicate field ${name}.`);
      row.set(name, string(property.initializer, name));
    }
    if (SCOPE_FIELDS.some((field) => !row.has(field))) throw new Error("Canonical release scope is missing required record fields.");
    const key = row.get("area") + "/" + row.get("section");
    if (seen.has(key)) throw new Error(`Canonical release scope repeats route ${key}.`);
    seen.add(key);
    if (!statuses.includes(row.get("status"))) throw new Error(`Canonical release scope uses unsupported status ${row.get("status")}.`);
    return { expectedArea: row.get("area"), expectedSection: row.get("section"), status: row.get("status"), releaseAction: row.get("releaseAction"), verification: row.get("verification"), note: row.get("note") };
  });
  const required = new Set(routeKeys);
  for (const key of required) if (!seen.has(key)) throw new Error(`Canonical release scope is missing route ${key}.`);
  for (const key of seen) if (!required.has(key)) throw new Error(`Canonical release scope includes unknown route ${key}.`);
  return { routeKeys, scopes, areas, sectionsByArea: Object.fromEntries(sectionsByArea), scopeOwner: path.relative(repoRoot, owner.file).split(path.sep).join("/") };
}
