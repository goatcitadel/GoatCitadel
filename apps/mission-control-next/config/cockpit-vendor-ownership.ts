/** Rollup's source graph is build-only; uncertain metadata keeps the existing ownership. */
export interface CockpitBootModuleGraph {
  getModuleIds: () => IterableIterator<string>;
  getModuleInfo: (id: string) => { isIncluded: boolean | null; importedIds: readonly string[]; ast?: unknown } | null;
}
const normalize = (id: string) => id.replaceAll("\\", "/");
const isIcon = (id: string) => /\/node_modules\/lucide-react\/dist\/esm\/icons\/[^/]+\.js$/.test(normalize(id));
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
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
export function findLazyOnlyCockpitIcons(
  graph: CockpitBootModuleGraph,
  bootModules: ReadonlySet<string>,
): Set<string> | undefined {
  const barrelId = [...graph.getModuleIds()].find((id) =>
    /\/node_modules\/lucide-react\/dist\/esm\/lucide-react\.js$/.test(normalize(id)),
  );
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
    if (
      node.type === "ImportDeclaration" &&
      source.value === "./icons/index.js" &&
      Array.isArray(node.specifiers) &&
      node.specifiers.length === 1 &&
      record(node.specifiers[0])?.type === "ImportNamespaceSpecifier" &&
      record(record(node.specifiers[0])?.local)?.type === "Identifier" &&
      symbolName(record(node.specifiers[0])?.local)
    )
      continue;
    if (node.type !== "ExportNamedDeclaration" || !Array.isArray(node.specifiers)) return undefined;
    const suffix = "/" + source.value.slice(2);
    const owner = barrel.importedIds.find((id) => normalize(id).endsWith(suffix));
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
  return new Set(
    barrel.importedIds.filter((id) => isIcon(id) && graph.getModuleInfo(id)?.isIncluded && !needed.has(id)),
  );
}

// A write:false comparison with Rollup's static closure confirmed these destination owners.
// Leave them to automatic placement; a real Native import still loads its code and validation.
const AUTOMATIC_CONTRACT_OWNERS = new Set([
  "ops-board",
  "hooks",
  "work-passport",
  "citadels",
  "openai-model-controls",
  "memory",
  "notifications",
  "chat-session-status",
  "workspace-path-bridge",
  "durable-chat-turn-payload",
]);
const AUTOMATIC_API_OWNERS = new Set([
  "memory",
  "browser-sessions",
  "improvement",
  "cron",
  "channel-setup-operations",
  "capabilities-scope",
  "ops-quality",
  "engineering-learnings",
  "channel-oauth",
  "orchestration-recipes",
  "skill-hub",
  "diagnostics",
  "workflow-skill-capture",
  "provider-transport",
  "demo",
  "integrations-operations",
  "platform-operations",
  "capabilities-operations",
  "citadels-operations",
  "tasks-operations",
  "prompt-packs-operations",
  "mcp-operations",
  "system-operations",
  "skills-operations",
  "voice-operations",
  "settings-operations",
  "operators-agents-files-operations",
  "personal-ops-operations",
  "workspaces-operations",
  "capabilities-query",
  "tasks-query",
  "chat-workbench-operations",
]);
const AUTOMATIC_NATIVE_PRIMITIVES = new Set([
  "FilterPillGroup",
  "ContextStrip",
  "NativeTable",
  "ErrorState",
  "KbdHint",
  "ThreePartChip",
  "NativeMetricGrid",
  "Notice",
]);

// These leaves have no direct cold importer outside their own optional SDK cluster.
// Dialog, Slot and focus/scroll ownership remain governed by actual imports.
const AUTOMATIC_OPTIONAL_SDK_LEAVES = [
  "react-roving-focus",
  "react-collection",
  "react-use-size",
  "react-arrow",
  "react-direction",
].map((name) => "/node_modules/@radix-ui/" + name + "/dist/index.mjs");

/** Exact build owners only; unknown files and ordinary Native primitives keep existing grouping. */
export function usesAutomaticCockpitPlacement(id: string): boolean {
  const normalized = normalize(id);
  if (AUTOMATIC_OPTIONAL_SDK_LEAVES.some((suffix) => normalized.endsWith(suffix))) return true;
  const contract = normalized.match(/\/packages\/contracts\/(?:dist|src)\/([^/]+)\.[jt]s$/);
  if (contract && AUTOMATIC_CONTRACT_OWNERS.has(contract[1]!)) return true;
  const api = normalized.match(/\/packages\/mission-control-shared\/(?:dist|src)\/api\/([^/]+)\.[jt]s$/);
  if (api && AUTOMATIC_API_OWNERS.has(api[1]!)) return true;
  const primitive = normalized.match(
    /\/apps\/mission-control-next\/src\/features\/native-routes\/primitives\/([^/]+)\.tsx$/,
  );
  if (primitive && AUTOMATIC_NATIVE_PRIMITIVES.has(primitive[1]!)) return true;
  return (
    /\/node_modules\/@tanstack\/query-core\/build\/modern\/infiniteQueryObserver\.js$/.test(normalized) ||
    /\/node_modules\/@tanstack\/react-query\/build\/modern\/useInfiniteQuery\.js$/.test(normalized) ||
    /\/node_modules\/@radix-ui\/react-visually-hidden\/dist\/index\.mjs$/.test(normalized) ||
    /\/node_modules\/use-sync-external-store\/shim\/index\.js(?:\?(?:commonjs-es-import|commonjs-module))?$/.test(
      normalized,
    ) ||
    /\/node_modules\/use-sync-external-store\/cjs\/use-sync-external-store-shim\.production\.js(?:\?commonjs-exports)?$/.test(
      normalized,
    )
  );
}

/**
 * Follow requested value bindings through known export owners, rather than
 * treating every globally retained sibling behind a discarded barrel as boot.
 * This changes chunk ownership only. Rollup still owns inclusion and execution.
 * Namespace imports, missing/ambiguous ownership and unsupported ASTs retain
 * the previous conservative static traversal.
 */
export function collectCockpitBootBindings(
  graph: CockpitBootModuleGraph,
  rootId: string,
  namedBindings?: Set<string>,
): Set<string> {
  type Binding = { id: string; name: string };
  const result = new Set<string>(),
    owned = new Set<string>(),
    legacy = new Set<string>();
  const key = (id: string) =>
    normalize(id)
      .split("?", 1)[0]!
      .replace(/\.[cm]?[jt]sx?$/u, "");
  function sourceOwner(importer: string, source: string): string | undefined {
    const info = graph.getModuleInfo(importer);
    if (!info) return undefined;
    let candidates = info.importedIds.filter((id) => id === source);
    if (!candidates.length && source.startsWith(".")) {
      const parts = normalize(importer).split("?", 1)[0]!.split("/");
      parts.pop();
      for (const part of source.split("/")) {
        if (part === "..") parts.pop();
        else if (part && part !== ".") parts.push(part);
      }
      const expected = key(parts.join("/"));
      candidates = info.importedIds.filter((id) => key(id) === expected || key(id) === expected + "/index");
    }
    if (!candidates.length && source.startsWith("@next/")) {
      const suffix = "/apps/mission-control-next/src/" + key(source.slice(6));
      candidates = info.importedIds.filter((id) => key(id).endsWith(suffix));
    }
    const workspace = source.match(/^@goatcitadel\/([^/]+)(?:\/(.+))?$/u);
    if (!candidates.length && workspace) {
      const owners = info.importedIds.filter((id) => normalize(id).includes("/packages/" + workspace[1] + "/"));
      const suffix = workspace[2] ? "/" + key(workspace[2]) : "/index";
      candidates = owners.filter((id) => key(id).endsWith(suffix));
      if (!candidates.length && owners.length === 1) candidates = owners;
    }
    if (!candidates.length && !source.startsWith(".")) {
      const segments = source.split("/"),
        count = source.startsWith("@") ? 2 : 1;
      const packageName = segments.slice(0, count).join("/");
      const owners = info.importedIds.filter((id) => normalize(id).includes("/node_modules/" + packageName + "/"));
      const subpath = segments.slice(count).join("/");
      const exact = owners.filter((id) => key(id).endsWith(subpath ? "/" + key(subpath) : "/index"));
      candidates = exact.length ? exact : owners;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  function conservative(id: string): void {
    if (legacy.has(id)) return;
    legacy.add(id);
    const info = graph.getModuleInfo(id);
    if (!info) return;
    if (info.isIncluded) result.add(id);
    for (const dependency of info.importedIds) conservative(dependency);
  }
  function importedName(specifier: Record<string, unknown>): string | undefined {
    return specifier.type === "ImportDefaultSpecifier"
      ? "default"
      : specifier.type === "ImportSpecifier"
        ? symbolName(specifier.imported)
        : undefined;
  }
  function binding(id: string, name: string, seen = new Set<string>()): Binding[] | undefined {
    const stamp = id + "\0" + name;
    if (seen.has(stamp)) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(stamp);
    const body = programBody(graph.getModuleInfo(id)?.ast);
    if (!body) return undefined;
    const direct: Binding[] = [],
      stars: string[] = [];
    for (const value of body) {
      const node = record(value);
      if (!node) return undefined;
      const source = record(node.source)?.value;
      if (node.type === "ExportDefaultDeclaration" && name === "default") direct.push({ id, name });
      if (node.type === "ExportAllDeclaration") {
        if (typeof source !== "string" || node.exported) return undefined;
        const owner = sourceOwner(id, source);
        if (!owner) return undefined;
        stars.push(owner);
        continue;
      }
      if (node.type !== "ExportNamedDeclaration") continue;
      const declaration = record(node.declaration);
      if (declaration) {
        if (symbolName(declaration.id) === name) direct.push({ id, name });
        if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
          for (const value of declaration.declarations) {
            const declarator = record(value);
            if (!symbolName(declarator?.id)) return undefined;
            if (symbolName(declarator?.id) === name) direct.push({ id, name });
          }
        }
      }
      if (!Array.isArray(node.specifiers)) return undefined;
      for (const value of node.specifiers) {
        const specifier = record(value);
        if (!specifier) return undefined;
        if (symbolName(specifier.exported) !== name) continue;
        const local = symbolName(specifier.local);
        if (!local) return undefined;
        if (typeof source === "string") {
          const owner = sourceOwner(id, source);
          if (!owner) return undefined;
          const resolved = binding(owner, local, nextSeen);
          if (!resolved?.length) return undefined;
          direct.push(...resolved);
          continue;
        }
        const imported = body.flatMap((value) => {
          const candidate = record(value);
          if (candidate?.type !== "ImportDeclaration" || !Array.isArray(candidate.specifiers)) return [];
          return candidate.specifiers.flatMap((value) => {
            const specifier = record(value);
            return symbolName(specifier?.local) === local ? [{ node: candidate, specifier }] : [];
          });
        });
        if (!imported.length) direct.push({ id, name });
        else {
          if (imported.length !== 1) return undefined;
          const item = imported[0]!,
            importedSource = record(item.node.source)?.value;
          const requested = item.specifier ? importedName(item.specifier) : undefined;
          if (typeof importedSource !== "string" || !requested) return undefined;
          const owner = sourceOwner(id, importedSource);
          if (!owner) return undefined;
          const resolved = binding(owner, requested, nextSeen);
          if (!resolved?.length) return undefined;
          direct.push(...resolved);
        }
      }
    }
    if (direct.length) return direct;
    const indirect: Binding[] = [];
    for (const owner of stars) {
      const resolved = binding(owner, name, nextSeen);
      if (!resolved) return undefined;
      indirect.push(...resolved);
    }
    const unique = new Map(indirect.map((item) => [item.id + "\0" + item.name, item]));
    return unique.size > 1 ? undefined : [...unique.values()];
  }
  function requested(id: string, name: string): void {
    const owners = binding(id, name);
    if (!owners?.length) {
      conservative(id);
      return;
    }
    // Publish proof only after the complete export chain resolves to one included
    // owner. Conservative, namespace, incomplete and ambiguous paths prove none.
    if (owners.length === 1 && graph.getModuleInfo(owners[0]!.id)?.isIncluded === true)
      namedBindings?.add(owners[0]!.id);
    for (const owner of owners) visitOwn(owner.id);
  }
  function visitOwn(id: string): void {
    if (owned.has(id)) return;
    owned.add(id);
    const info = graph.getModuleInfo(id),
      body = programBody(info?.ast);
    if (!info) return;
    if (!body) {
      conservative(id);
      return;
    }
    if (info.isIncluded) result.add(id);
    const accounted = new Set<string>();
    for (const value of body) {
      const node = record(value);
      if (!node) {
        conservative(id);
        return;
      }
      const source = record(node.source)?.value;
      if (typeof source !== "string") continue;
      if (!["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(String(node.type))) {
        conservative(id);
        return;
      }
      const owner = sourceOwner(id, source);
      if (!owner) {
        conservative(id);
        return;
      }
      accounted.add(owner);
      if (node.type !== "ImportDeclaration") continue;
      if (!Array.isArray(node.specifiers)) {
        conservative(owner);
        continue;
      }
      if (!node.specifiers.length) {
        conservative(owner);
        continue;
      }
      for (const value of node.specifiers) {
        const specifier = record(value),
          name = specifier ? importedName(specifier) : undefined;
        if (name) requested(owner, name);
        else conservative(owner);
      }
    }
    // Synthetic plugin edges or unsupported source metadata are not evidence
    // that a dependency can move; preserve the old reachability in that case.
    for (const dependency of info.importedIds) if (!accounted.has(dependency)) conservative(dependency);
  }
  visitOwn(rootId);
  return result;
}
