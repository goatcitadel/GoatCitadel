/** Rollup's source graph is build-only; uncertain metadata keeps the existing ownership. */
export interface CockpitBootModuleGraph {
  getModuleIds: () => IterableIterator<string>;
  getModuleInfo: (id: string) => { isIncluded: boolean | null; importedIds: readonly string[]; ast?: unknown } | null;
}
const normalize = (id: string) => id.replaceAll("\\", "/");
const isIcon = (id: string) => /\/node_modules\/lucide-react\/dist\/esm\/icons\/[^/]+\.js$/.test(normalize(id));
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
function programBody(ast: unknown): unknown[] | undefined {
  const node = record(ast);
  return node?.type === "Program" && Array.isArray(node.body) ? node.body : undefined;
}
function symbolName(value: unknown): string | undefined {
  const node = record(value);
  if (node?.type === "Identifier" && typeof node.name === "string") return node.name;
  if ((node?.type === "Literal" || node?.type === "StringLiteral") && typeof node.value === "string") return node.value;
  return undefined;
}

/** Leave globally retained lazy icon leaves with their destinations, preserving exact current boot imports. */
export function findLazyOnlyCockpitIcons(graph: CockpitBootModuleGraph, bootModules: ReadonlySet<string>): Set<string> | undefined {
  const barrelId = [...graph.getModuleIds()].find(id => /\/node_modules\/lucide-react\/dist\/esm\/lucide-react\.js$/.test(normalize(id)));
  const barrel = barrelId ? graph.getModuleInfo(barrelId) : null;
  const body = programBody(barrel?.ast);
  if (!barrel || !body) return undefined;
  const exports = new Map<string, string>();
  for (const value of body) {
    const node = record(value);
    if (!node || typeof node.type !== "string") return undefined;
    const source = record(node.source);
    if (typeof source?.value !== "string" || !source.value.startsWith("./icons/")) continue;
    // The installed public barrel exposes a namespace alongside its named leaf exports.
    // A Native import of that public namespace is deliberately unresolved below and keeps all icons.
    if (node.type === "ImportDeclaration" && source.value === "./icons/index.js" &&
      Array.isArray(node.specifiers) && node.specifiers.length === 1 &&
      record(node.specifiers[0])?.type === "ImportNamespaceSpecifier" &&
      record(record(node.specifiers[0])?.local)?.type === "Identifier" &&
      symbolName(record(node.specifiers[0])?.local)) continue;
    if (node.type !== "ExportNamedDeclaration" || !Array.isArray(node.specifiers)) return undefined;
    const suffix = "/" + source.value.slice(2);
    const owner = barrel.importedIds.find(id => normalize(id).endsWith(suffix));
    if (!owner) return undefined;
    for (const value of node.specifiers) {
      const specifier = record(value);
      const name = symbolName(specifier?.exported);
      if (specifier?.type !== "ExportSpecifier" || !name) return undefined;
      const previous = exports.get(name);
      if (previous && previous !== owner) return undefined;
      exports.set(name, owner);
    }
  }
  const needed = new Set<string>();
  for (const id of bootModules) {
    if (normalize(id).includes("/node_modules/") || id.startsWith("\0")) continue;
    // Stylesheet modules cannot declare runtime icon imports; their absence of a JS AST is expected.
    if (/\.(?:css|scss|sass|less|styl)$/i.test(normalize(id).split("?", 1)[0]!)) continue;
    const info = graph.getModuleInfo(id);
    const body = programBody(info?.ast);
    if (!info || !body) return undefined;
    // Direct icon subpaths and local re-exports remain eager without relying on a symbol naming convention.
    for (const dependency of info.importedIds) if (isIcon(dependency)) needed.add(dependency);
    for (const value of body) {
      const node = record(value);
      if (!node || typeof node.type !== "string") return undefined;
      const source = record(node.source);
      if (source?.value !== "lucide-react") continue;
      if (node.type !== "ImportDeclaration" || !Array.isArray(node.specifiers)) return undefined;
      for (const value of node.specifiers) {
        const specifier = record(value);
        const name = symbolName(specifier?.imported);
        if (specifier?.type !== "ImportSpecifier" || !name) return undefined;
        const owner = exports.get(name);
        if (!owner) return undefined;
        needed.add(owner);
      }
    }
  }
  return new Set(barrel.importedIds.filter(id => isIcon(id) && graph.getModuleInfo(id)?.isIncluded && !needed.has(id)));
}

// A write:false comparison with Rollup's static closure confirmed these destination owners.
// Leave them to automatic placement; a real Native import still loads its code and validation.
const AUTOMATIC_CONTRACT_OWNERS = new Set([
  "ops-board", "hooks", "work-passport", "citadels", "openai-model-controls", "memory", "notifications", "chat-session-status",
]);
const AUTOMATIC_API_OWNERS = new Set([
  "memory", "browser-sessions", "improvement", "cron", "channel-setup-operations", "capabilities-scope", "ops-quality",
  "engineering-learnings", "channel-oauth", "orchestration-recipes", "skill-hub", "diagnostics", "workflow-skill-capture", "provider-transport", "demo",
]);
const AUTOMATIC_NATIVE_PRIMITIVES = new Set([
  "FilterPillGroup", "ContextStrip", "NativeTable", "ErrorState", "KbdHint", "ThreePartChip", "NativeMetricGrid", "Notice",
]);

/** Exact build owners only; unknown files and ordinary Native primitives keep existing grouping. */
export function usesAutomaticCockpitPlacement(id: string): boolean {
  const normalized = normalize(id);
  const contract = normalized.match(/\/packages\/contracts\/(?:dist|src)\/([^/]+)\.[jt]s$/);
  if (contract && AUTOMATIC_CONTRACT_OWNERS.has(contract[1]!)) return true;
  const api = normalized.match(/\/packages\/mission-control-shared\/(?:dist|src)\/api\/([^/]+)\.[jt]s$/);
  if (api && AUTOMATIC_API_OWNERS.has(api[1]!)) return true;
  const primitive = normalized.match(/\/apps\/mission-control-next\/src\/features\/native-routes\/primitives\/([^/]+)\.tsx$/);
  if (primitive && AUTOMATIC_NATIVE_PRIMITIVES.has(primitive[1]!)) return true;
  return /\/node_modules\/@tanstack\/query-core\/build\/modern\/infiniteQueryObserver\.js$/.test(normalized) ||
    /\/node_modules\/@tanstack\/react-query\/build\/modern\/useInfiniteQuery\.js$/.test(normalized) ||
    /\/node_modules\/@radix-ui\/react-visually-hidden\/dist\/index\.mjs$/.test(normalized) ||
    /\/node_modules\/use-sync-external-store\/shim\/index\.js(?:\?(?:commonjs-es-import|commonjs-module))?$/.test(normalized) ||
    /\/node_modules\/use-sync-external-store\/cjs\/use-sync-external-store-shim\.production\.js(?:\?commonjs-exports)?$/.test(normalized);
}
