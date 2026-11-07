import { expect, it, vi } from "vitest";
import { createCockpitBootChunkSelector } from "../vite.config";
import {
  findLazyOnlyCockpitIcons,
  findColdCockpitRuntimeVendors,
  usesAutomaticCockpitPlacement,
  collectCockpitBootBindings,
  type CockpitBootModuleGraph,
} from "./cockpit-vendor-ownership";
const root = "C:/repo/src/cockpit-entry.tsx";
const consumer = "C:/repo/src/cockpit/app/CurrentNativeControl.tsx";
const lazyConsumer = "C:/repo/src/cockpit/app/LazyDestination.tsx";
const barrel = "C:/repo/node_modules/lucide-react/dist/esm/lucide-react.js";
const icon = (name: string) => "C:/repo/node_modules/lucide-react/dist/esm/icons/" + name + ".js";
const identifier = (name: string) => ({ type: "Identifier", name });
const literal = (value: string) => ({ type: "Literal", value });
const program = (body: unknown[]) => ({ type: "Program", body });

const optionalContractOwners = [
  "config-schemas",
  "chat-feature-references",
  "plugins",
  "browser-errand-approval-conversation",
  "capability-connectors",
  "capability-plugins",
  "change-plan-feature-flag-labels",
  "channel-access",
  "channel-address-host",
  "google-workspace",
  "mcp",
  "operator-write-access",
  "personal-ops",
  "public-web-address",
  "skill-categories",
  "skill-packs",
  "web-search",
] as const;
function optionalContractFixture(
  name: string,
  directory: "src" | "dist",
  mode: "direct" | "namespace" | "discarded" | "missing",
) {
  const owner = `C:/repo/packages/contracts/${directory}/${name}.${directory === "src" ? "ts" : "js"}`;
  const importValue = {
    type: "ImportDeclaration",
    source: literal(owner),
    specifiers:
      mode === "namespace"
        ? [{ type: "ImportNamespaceSpecifier", local: identifier("contract") }]
        : [{ type: "ImportSpecifier", imported: identifier("schema"), local: identifier("schema") }],
  };
  const rootInfo: Info = { isIncluded: true, importedIds: [owner] };
  if (mode !== "missing") rootInfo.ast = program(mode === "discarded" ? [] : [importValue]);
  const modules = new Map<string, Info>([
    [root, rootInfo],
    [
      owner,
      {
        isIncluded: true,
        importedIds: [],
        ast: program([
          {
            type: "ExportNamedDeclaration",
            source: null,
            specifiers: [],
            declaration: { type: "FunctionDeclaration", id: identifier("schema") },
          },
        ]),
      },
    ],
  ]);
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  return { owner, graph };
}

it.each(
  optionalContractOwners.flatMap((name) => (["src", "dist"] as const).map((directory) => [name, directory] as const)),
)(
  "places %s from %s automatically when a discarded barrel, namespace, or missing AST gives no named proof",
  (name, directory) => {
    for (const mode of ["discarded", "namespace", "missing"] as const) {
      const f = optionalContractFixture(name, directory, mode),
        proof = new Set<string>();
      // Conservative reachability remains intact. Automatic placement lets
      // Rollup follow actual imports without forcing a shared boot chunk.
      expect(collectCockpitBootBindings(f.graph, root, proof).has(f.owner)).toBe(true);
      expect(proof.has(f.owner)).toBe(false);
      expect(createCockpitBootChunkSelector()(f.owner, f.graph)).toBeUndefined();
    }
  },
);
it.each(
  optionalContractOwners.flatMap((name) => (["src", "dist"] as const).map((directory) => [name, directory] as const)),
)("preserves a genuine named cold %s binding from %s in foundation", (name, directory) => {
  const f = optionalContractFixture(name, directory, "direct"),
    proof = new Set<string>();
  expect(collectCockpitBootBindings(f.graph, root, proof).has(f.owner)).toBe(true);
  expect(proof.has(f.owner)).toBe(true);
  expect(createCockpitBootChunkSelector()(f.owner, f.graph)).toBe("cockpit-foundation");
});
it.each(["src", "dist"] as const)("preserves the existing automatic hooks owner from %s", (directory) => {
  const f = optionalContractFixture("hooks", directory, "direct"),
    proof = new Set<string>();
  expect(collectCockpitBootBindings(f.graph, root, proof).has(f.owner)).toBe(true);
  expect(proof.has(f.owner)).toBe(true);
  expect(createCockpitBootChunkSelector()(f.owner, f.graph)).toBeUndefined();
});
const imports = (names: string[]) => ({
  type: "ImportDeclaration",
  source: literal("lucide-react"),
  specifiers: names.map((name) => ({ type: "ImportSpecifier", imported: identifier(name), local: identifier(name) })),
});
const installedNamespace = () => ({
  type: "ImportDeclaration",
  source: literal("./icons/index.js"),
  specifiers: [{ type: "ImportNamespaceSpecifier", local: identifier("index") }],
});
const namespaceExport = () => ({
  type: "ExportNamedDeclaration",
  source: null,
  specifiers: [{ type: "ExportSpecifier", local: identifier("index"), exported: identifier("icons") }],
});
const exported = (name: string, owner: string) => ({
  type: "ExportNamedDeclaration",
  source: literal("./icons/" + owner + ".js"),
  specifiers: [{ type: "ExportSpecifier", local: identifier("default"), exported: identifier(name) }],
});
type Info = NonNullable<ReturnType<CockpitBootModuleGraph["getModuleInfo"]>>;
function fixture(names = ["MoreHorizontal", "AlertTriangle", "XIcon", "FutureGlyph"]) {
  const modules = new Map<string, Info>([
    [root, { isIncluded: true, importedIds: [consumer], ast: program([]) }],
    [consumer, { isIncluded: true, importedIds: [barrel], ast: program([imports(names)]) }],
    [
      barrel,
      {
        isIncluded: false,
        importedIds: [icon("ellipsis"), icon("triangle-alert"), icon("x"), icon("new-glyph"), icon("cpu")],
        ast: program([
          installedNamespace(),
          namespaceExport(),
          exported("MoreHorizontal", "ellipsis"),
          exported("AlertTriangle", "triangle-alert"),
          exported("XIcon", "x"),
          exported("FutureGlyph", "new-glyph"),
          exported("Cpu", "cpu"),
        ]),
      },
    ],
    [lazyConsumer, { isIncluded: true, importedIds: [barrel], ast: program([imports(["Cpu"])]) }],
  ]);
  for (const name of ["ellipsis", "triangle-alert", "x", "new-glyph", "cpu"])
    modules.set(icon(name), { isIncluded: true, importedIds: [], ast: program([]) });
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  return { modules, graph, boot: new Set([root, consumer, ...modules.get(barrel)!.importedIds]) };
}

it("keeps installed alias targets and new Native symbols without a hardcoded icon list", () => {
  const { graph, boot } = fixture();
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("cpu")]));
  const select = createCockpitBootChunkSelector();
  for (const name of ["ellipsis", "triangle-alert", "x", "new-glyph"])
    expect(select(icon(name), graph)).toBe("cockpit-runtime");
  expect(select(icon("cpu"), graph)).toBeUndefined();
});

it("keeps a directly imported SVG subpath and excludes only globally included unused leaves", () => {
  const { modules, graph, boot } = fixture();
  modules.set(consumer, {
    isIncluded: true,
    importedIds: [barrel, icon("cpu")],
    ast: program([
      imports(["MoreHorizontal"]),
      {
        type: "ImportDeclaration",
        source: literal("lucide-react/dist/esm/icons/cpu.js"),
        specifiers: [{ type: "ImportDefaultSpecifier", local: identifier("Cpu") }],
      },
    ]),
  });
  modules.get(icon("x"))!.isIncluded = false;
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("triangle-alert"), icon("new-glyph")]));
});

it("does not let a namespace import in a lazy destination change actual Native ownership", () => {
  const { modules, graph, boot } = fixture();
  modules.get(lazyConsumer)!.ast = program([
    {
      type: "ImportDeclaration",
      source: literal("lucide-react"),
      specifiers: [{ type: "ImportNamespaceSpecifier", local: identifier("Icons") }],
    },
  ]);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("cpu")]));
});

it.each([
  "namespace",
  "default",
  "unknown-symbol",
  "unsupported-symbol",
  "missing-native-ast",
  "unsupported-native-ast",
  "missing-barrel-ast",
  "unsupported-export",
  "missing-export-owner",
  "conflicting-alias",
  "re-export",
])("preserves existing icon ownership when %s metadata cannot prove exact imports", (reason) => {
  const { modules, graph, boot } = fixture();
  const native = modules.get(consumer)!,
    exports = modules.get(barrel)!;
  if (reason === "namespace" || reason === "default")
    native.ast = program([
      {
        type: "ImportDeclaration",
        source: literal("lucide-react"),
        specifiers: [
          {
            type: reason === "namespace" ? "ImportNamespaceSpecifier" : "ImportDefaultSpecifier",
            local: identifier("Icons"),
          },
        ],
      },
    ]);
  if (reason === "unknown-symbol") native.ast = program([imports(["UnknownFutureExport"])]);
  if (reason === "unsupported-symbol")
    native.ast = program([
      {
        type: "ImportDeclaration",
        source: literal("lucide-react"),
        specifiers: [{ type: "ImportSpecifier", imported: { type: "UnknownNode", name: "MoreHorizontal" } }],
      },
    ]);
  if (reason === "missing-native-ast") delete native.ast;
  if (reason === "unsupported-native-ast") native.ast = { type: "Program", body: {} };
  if (reason === "missing-barrel-ast") delete exports.ast;
  if (reason === "unsupported-export")
    exports.ast = program([{ type: "ExportAllDeclaration", source: literal("./icons/ellipsis.js") }]);
  if (reason === "missing-export-owner") exports.ast = program([exported("MoreHorizontal", "missing")]);
  if (reason === "conflicting-alias")
    exports.ast = program([exported("MoreHorizontal", "ellipsis"), exported("MoreHorizontal", "cpu")]);
  if (reason === "re-export") native.ast = program([{ type: "ExportAllDeclaration", source: literal("lucide-react") }]);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(icon("cpu"), graph)).toBe("cockpit-runtime");
});

it("returns the conservative ownership fallback without a supported installed public barrel", () => {
  const { modules, graph, boot } = fixture();
  modules.delete(barrel);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
});

it("accepts expected non-JavaScript stylesheet metadata without weakening unknown JS fallback", () => {
  const { modules, graph, boot } = fixture();
  const stylesheet = "C:/repo/src/cockpit/styles/chat.css?inline";
  modules.set(stylesheet, { isIncluded: true, importedIds: [] });
  boot.add(stylesheet);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("cpu")]));
  modules.get(consumer)!.ast = undefined;
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
});

it("handles the actual installed internal namespace while a Native public namespace still keeps all icons", () => {
  const { modules, graph, boot } = fixture();
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("cpu")]));
  modules.get(consumer)!.ast = program([imports(["icons"])]);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(icon("cpu"), graph)).toBe("cockpit-runtime");
});

it("keeps all icons when the installed internal namespace wrapper has an unsupported shape", () => {
  const { modules, graph, boot } = fixture();
  const wrapper = {
    ...installedNamespace(),
    specifiers: [{ type: "ImportDefaultSpecifier", local: identifier("index") }],
  };
  modules.get(barrel)!.ast = program([wrapper, exported("MoreHorizontal", "ellipsis")]);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(icon("cpu"), graph)).toBe("cockpit-runtime");
});

const measuredAutomaticOwners = [
  ...[
    "ops-board",
    "hooks",
    "work-passport",
    "citadels",
    "openai-model-controls",
    "memory",
    "notifications",
    "chat-session-status",
  ].map((name) => "C:/repo/packages/contracts/dist/" + name + ".js"),
  ...[
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
  ].map((name) => "C:/repo/packages/mission-control-shared/dist/api/" + name + ".js"),
  ...[
    "FilterPillGroup",
    "ContextStrip",
    "NativeTable",
    "ErrorState",
    "KbdHint",
    "ThreePartChip",
    "NativeMetricGrid",
    "Notice",
  ].map((name) => "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/" + name + ".tsx"),
  "C:/repo/node_modules/@tanstack/query-core/build/modern/infiniteQueryObserver.js",
  "C:/repo/node_modules/@tanstack/react-query/build/modern/useInfiniteQuery.js",
  "C:/repo/node_modules/@radix-ui/react-visually-hidden/dist/index.mjs",
  "C:/repo/node_modules/use-sync-external-store/shim/index.js",
  "C:/repo/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js",
  "\0C:/repo/node_modules/use-sync-external-store/shim/index.js?commonjs-es-import",
  "\0C:/repo/node_modules/use-sync-external-store/shim/index.js?commonjs-module",
  "\0C:/repo/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js?commonjs-exports",
];

it.each(measuredAutomaticOwners)(
  "leaves exact measured owner %s to actual Rollup imports across Windows and package versions",
  (id) => {
    expect(usesAutomaticCockpitPlacement(id)).toBe(true);
    expect(usesAutomaticCockpitPlacement(id.replaceAll("/", "\\"))).toBe(true);
    if (id.includes("/packages/") && id.includes("/dist/"))
      expect(usesAutomaticCockpitPlacement(id.replace("/dist/", "/src/").replace(/\.js$/, ".ts"))).toBe(true);
    if (id.includes("/node_modules/"))
      expect(
        usesAutomaticCockpitPlacement(
          id.replace("/node_modules/", "/node_modules/.pnpm/changed-version/node_modules/"),
        ),
      ).toBe(true);
  },
);

it.each([
  "C:/repo/packages/contracts/dist/session-control.js",
  "C:/repo/packages/contracts/dist/external-sources.js",
  "C:/repo/packages/contracts/dist/ops-board-new.js",
  "C:/repo/packages/mission-control-shared/dist/api/chat.js",
  "C:/repo/packages/mission-control-shared/dist/api/startup-reads.js",
  "C:/repo/packages/mission-control-shared/dist/api/memory-new.js",
  ...["NativeButton", "EmptyState", "StatusChip"].map(
    (name) => "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/" + name + ".tsx",
  ),
  "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/NoticeAction.tsx",
  "C:/repo/apps/another-app/src/features/native-routes/primitives/ErrorState.tsx",
  "C:/repo/node_modules/@tanstack/query-core/build/modern/queryObserver.js",
  "C:/repo/node_modules/@tanstack/react-query/build/modern/useQuery.js",
  "C:/repo/node_modules/@tanstack/query-core/build/legacy/infiniteQueryObserver.js",
  "C:/repo/node_modules/@radix-ui/react-menu/dist/index.mjs",
  "C:/repo/node_modules/use-sync-external-store/shim/index.js?unknown-wrapper",
  "C:/repo/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js?commonjs-module",
])("retains existing grouping for unknown or mandatory Native owner %s", (id) => {
  expect(usesAutomaticCockpitPlacement(id)).toBe(false);
  expect(usesAutomaticCockpitPlacement(id.replaceAll("/", "\\"))).toBe(false);
});

const remainingOptionalOwners = [
  "C:/repo/packages/contracts/dist/workspace-path-bridge.js",
  "C:/repo/packages/contracts/dist/durable-chat-turn-payload.js",
  ...["react-roving-focus", "react-collection", "react-use-size", "react-arrow", "react-direction", "react-switch"].map(
    (name) => "C:/repo/node_modules/@radix-ui/" + name + "/dist/index.mjs",
  ),
];

it.each(remainingOptionalOwners)(
  "leaves proved lazy-only leaf %s to Rollup without weakening exact path matching",
  (id) => {
    expect(usesAutomaticCockpitPlacement(id)).toBe(true);
    expect(usesAutomaticCockpitPlacement(id.replaceAll("/", "\\"))).toBe(true);
    if (id.includes("/packages/")) {
      expect(usesAutomaticCockpitPlacement(id.replace("/dist/", "/src/").replace(/\.js$/, ".ts"))).toBe(true);
    } else {
      expect(
        usesAutomaticCockpitPlacement(
          id.replace("/node_modules/", "/node_modules/.pnpm/another-version/node_modules/"),
        ),
      ).toBe(true);
    }
  },
);

it("avoids pulling lazy validators and SDK leaves through a discarded barrel while retaining mandatory Native owners", () => {
  const discarded = "C:/repo/discarded-barrel.js";
  const mandatory = [
    "C:/repo/packages/contracts/dist/session-control.js",
    "C:/repo/packages/contracts/dist/run-variables.js",
    "C:/repo/packages/mission-control-shared/dist/api/chat.js",
    "C:/repo/node_modules/@radix-ui/react-dialog/dist/index.mjs",
    "C:/repo/node_modules/@radix-ui/react-slot/dist/index.mjs",
    "C:/repo/node_modules/@radix-ui/react-focus-scope/dist/index.mjs",
    "C:/repo/node_modules/zod/v3/types.js",
  ];
  const modules = new Map<string, Info>([
    [root, { isIncluded: true, importedIds: [discarded, ...mandatory], ast: program([]) }],
    [discarded, { isIncluded: false, importedIds: remainingOptionalOwners, ast: program([]) }],
    [lazyConsumer, { isIncluded: true, importedIds: remainingOptionalOwners, ast: program([]) }],
  ]);
  for (const id of [...remainingOptionalOwners, ...mandatory]) {
    modules.set(id, { isIncluded: true, importedIds: [], ast: program([]) });
  }
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  const select = createCockpitBootChunkSelector();
  for (const id of remainingOptionalOwners) expect(select(id, graph), id).toBeUndefined();
  for (const id of mandatory) {
    expect(usesAutomaticCockpitPlacement(id), id).toBe(false);
    expect(select(id, graph), id).toBe(id.includes("/packages/") ? "cockpit-foundation" : "cockpit-runtime");
  }
});

it.each([
  "C:/repo/packages/contracts/dist/workspace-path-bridge-new.js",
  "C:/repo/packages/contracts/dist/durable-chat-turn-payload-new.js",
  "C:/repo/other-package/dist/workspace-path-bridge.js",
  "C:/repo/node_modules/@radix-ui/react-roving-focus/dist/index.js",
  "C:/repo/node_modules/@radix-ui/react-roving-focus/dist/other.mjs",
  "C:/repo/node_modules/@radix-ui/react-roving-focus-new/dist/index.mjs",
  "C:/repo/node_modules/@radix-ui/react-slot/dist/index.mjs",
  "C:/repo/node_modules/@radix-ui/react-dialog/dist/index.mjs",
  "C:/repo/node_modules/@radix-ui/react-focus-scope/dist/index.mjs",
])("keeps unknown lookalikes and mandatory overlay leaf %s under existing grouping", (id) => {
  expect(usesAutomaticCockpitPlacement(id)).toBe(false);
});

it.each([
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
])("leaves exact optional API owner %s to actual imports", (owner) => {
  const id = "C:/repo/packages/mission-control-shared/dist/api/" + owner + ".js";
  expect(usesAutomaticCockpitPlacement(id)).toBe(true);
  expect(usesAutomaticCockpitPlacement(id.replaceAll("/", "\\"))).toBe(true);
  expect(usesAutomaticCockpitPlacement(id.replace("/dist/", "/src/").replace(/\.js$/, ".ts"))).toBe(true);
});

it.each([
  "C:/repo/packages/mission-control-shared/dist/api/integrations.js",
  "C:/repo/packages/mission-control-shared/dist/api/platform.js",
  "C:/repo/packages/mission-control-shared/dist/api/capabilities.js",
  "C:/repo/packages/mission-control-shared/dist/api/citadels.js",
  "C:/repo/packages/mission-control-shared/dist/api/tasks.js",
  "C:/repo/packages/mission-control-shared/dist/api/prompt-packs.js",
  "C:/repo/packages/mission-control-shared/dist/api/mcp.js",
  "C:/repo/packages/mission-control-shared/dist/api/system.js",
  "C:/repo/packages/mission-control-shared/dist/api/skills.js",
  "C:/repo/packages/mission-control-shared/dist/api/voice.js",
  "C:/repo/packages/mission-control-shared/dist/api/settings.js",
  "C:/repo/packages/mission-control-shared/dist/api/operators-agents-files.js",
  "C:/repo/packages/mission-control-shared/dist/api/personal-ops.js",
  "C:/repo/packages/mission-control-shared/dist/api/workspaces.js",
  "C:/repo/packages/mission-control-shared/dist/api/integrations-operations-new.js",
  "C:/repo/packages/another-package/dist/api/platform-operations.js",
  "C:/repo/packages/mission-control-shared/dist/api/citadels-query.js",
])("retains cold and unknown API ownership %s", (id) => {
  expect(usesAutomaticCockpitPlacement(id)).toBe(false);
});

function boundFixture(kind: "named" | "namespace" | "missing" = "named") {
  const root = "C:/repo/src/cockpit-entry.tsx",
    barrel = "C:/repo/src/shared/index.js";
  const needed = "C:/repo/src/shared/needed.js",
    lazy = "C:/repo/src/shared/lazy.js";
  const exportedOwn = (name: string) => ({
    type: "ExportNamedDeclaration",
    declaration: { type: "FunctionDeclaration", id: identifier(name) },
    specifiers: [],
    source: null,
  });
  const forward = (name: string, file: string) => ({
    type: "ExportNamedDeclaration",
    source: literal("./" + file + ".js"),
    specifiers: [{ type: "ExportSpecifier", local: identifier(name), exported: identifier(name) }],
  });
  const modules = new Map<string, Info>([
    [
      root,
      {
        isIncluded: true,
        importedIds: [barrel],
        ast: program([
          {
            type: "ImportDeclaration",
            source: literal("./shared/index.js"),
            specifiers: [
              {
                type: kind === "namespace" ? "ImportNamespaceSpecifier" : "ImportSpecifier",
                local: identifier("value"),
                imported: identifier("needed"),
              },
            ],
          },
        ]),
      },
    ],
    [
      barrel,
      {
        isIncluded: false,
        importedIds: [needed, lazy],
        ast: program([forward("needed", "needed"), forward("lazy", "lazy")]),
      },
    ],
    [needed, { isIncluded: true, importedIds: [], ast: program([exportedOwn("needed")]) }],
    [lazy, { isIncluded: true, importedIds: [], ast: program([exportedOwn("lazy")]) }],
  ]);
  if (kind === "missing") delete modules.get(barrel)!.ast;
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  return { root, barrel, needed, lazy, modules, graph, exportedOwn, forward };
}
it("traces the actual Native value through a discarded barrel without grouping a globally retained lazy sibling", () => {
  const f = boundFixture();
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed]));
});
it.each(["namespace", "missing"] as const)("preserves every retained sibling for conservative %s metadata", (kind) => {
  const f = boundFixture(kind);
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed, f.lazy]));
});
it("follows a named export through export-star chains and retains the used validator owner", () => {
  const f = boundFixture(),
    intermediate = "C:/repo/src/shared/middle.js";
  f.modules.set(f.barrel, {
    isIncluded: false,
    importedIds: [intermediate, f.lazy],
    ast: program([{ type: "ExportAllDeclaration", source: literal("./middle.js") }, f.forward("lazy", "lazy")]),
  });
  f.modules.set(intermediate, {
    isIncluded: false,
    importedIds: [f.needed],
    ast: program([f.forward("needed", "needed")]),
  });
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed]));
});
it("preserves unknown names and ambiguous export-star ownership", () => {
  const f = boundFixture();
  f.modules.get(f.needed)!.ast = program([f.exportedOwn("other")]);
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed, f.lazy]));
  f.modules.get(f.barrel)!.ast = program([
    { type: "ExportAllDeclaration", source: literal("./needed.js") },
    { type: "ExportAllDeclaration", source: literal("./lazy.js") },
  ]);
  f.modules.get(f.needed)!.ast = program([f.exportedOwn("needed")]);
  f.modules.get(f.lazy)!.ast = program([f.exportedOwn("needed")]);
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed, f.lazy]));
});
it("follows imported aliases exported under another public name", () => {
  const f = boundFixture();
  f.modules.get(f.barrel)!.ast = program([
    {
      type: "ImportDeclaration",
      source: literal("./needed.js"),
      specifiers: [{ type: "ImportSpecifier", imported: identifier("needed"), local: identifier("internal") }],
    },
    {
      type: "ExportNamedDeclaration",
      source: null,
      specifiers: [{ type: "ExportSpecifier", local: identifier("internal"), exported: identifier("needed") }],
    },
    f.forward("lazy", "lazy"),
  ]);
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed]));
});
it("keeps an included facade's own request dependencies without pulling its unrequested optional forwards into boot", () => {
  const f = boundFixture(),
    transport = "C:/repo/src/shared/transport.js";
  f.modules.set(f.barrel, {
    isIncluded: true,
    importedIds: [transport, f.lazy],
    ast: program([
      {
        type: "ImportDeclaration",
        source: literal("./transport.js"),
        specifiers: [{ type: "ImportSpecifier", imported: identifier("request"), local: identifier("request") }],
      },
      f.exportedOwn("needed"),
      f.forward("lazy", "lazy"),
    ]),
  });
  f.modules.set(transport, { isIncluded: true, importedIds: [], ast: program([f.exportedOwn("request")]) });
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.barrel, transport]));
});
it("preserves side-effect imports and unmatched synthetic graph edges", () => {
  const f = boundFixture();
  f.modules.get(f.needed)!.importedIds = [f.lazy];
  f.modules.get(f.needed)!.ast = program([
    f.exportedOwn("needed"),
    { type: "ImportDeclaration", source: literal("./lazy.js"), specifiers: [] },
  ]);
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed, f.lazy]));
  f.modules.get(f.needed)!.ast = program([f.exportedOwn("needed")]);
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, f.needed, f.lazy]));
});

it("distinguishes bare package roots from JSX subpaths before pruning a shared barrel", () => {
  const f = boundFixture(),
    react = "C:/repo/node_modules/react/index.js",
    jsx = "C:/repo/node_modules/react/jsx-runtime.js";
  const rootInfo = f.modules.get(f.root)!;
  rootInfo.importedIds = [react, jsx, f.barrel];
  (rootInfo.ast as { body: unknown[] }).body.unshift(
    {
      type: "ImportDeclaration",
      source: literal("react"),
      specifiers: [{ type: "ImportDefaultSpecifier", local: identifier("React") }],
    },
    {
      type: "ImportDeclaration",
      source: literal("react/jsx-runtime"),
      specifiers: [{ type: "ImportSpecifier", imported: identifier("jsx"), local: identifier("jsx") }],
    },
  );
  f.modules.set(react, {
    isIncluded: true,
    importedIds: [],
    ast: program([{ type: "ExportDefaultDeclaration", declaration: { type: "Identifier", name: "React" } }]),
  });
  f.modules.set(jsx, { isIncluded: true, importedIds: [], ast: program([f.exportedOwn("jsx")]) });
  expect(collectCockpitBootBindings(f.graph, f.root)).toEqual(new Set([f.root, react, jsx, f.needed]));
});

function capabilityOwnerFixture(required: boolean) {
  const root = "C:/repo/src/cockpit-entry.tsx";
  const api = "C:/repo/packages/mission-control-shared/dist/api/";
  const facade = api + "capabilities.js",
    operations = api + "capabilities-operations.js",
    query = api + "capabilities-query.js",
    core = api + "client-core.js";
  const own = (name: string) => ({
    type: "ExportNamedDeclaration",
    source: null,
    specifiers: [],
    declaration: { type: "FunctionDeclaration", id: identifier(name) },
  });
  const namedImport = (source: string, name: string) => ({
    type: "ImportDeclaration",
    source: literal(source),
    specifiers: [{ type: "ImportSpecifier", imported: identifier(name), local: identifier(name) }],
  });
  const modules = new Map<string, Info>([
    [
      root,
      {
        isIncluded: true,
        importedIds: [facade],
        ast: program([
          namedImport(
            "../packages/mission-control-shared/dist/api/capabilities.js",
            required ? "fetchCandidate" : "createRun",
          ),
        ]),
      },
    ],
    [
      facade,
      {
        isIncluded: true,
        importedIds: [core, operations],
        ast: program([
          namedImport("./client-core.js", "request"),
          own("createRun"),
          {
            type: "ExportNamedDeclaration",
            source: literal("./capabilities-operations.js"),
            specifiers: [
              { type: "ExportSpecifier", local: identifier("fetchCandidate"), exported: identifier("fetchCandidate") },
            ],
          },
        ]),
      },
    ],
    [
      operations,
      {
        isIncluded: true,
        importedIds: [core, query],
        ast: program([
          namedImport("./client-core.js", "request"),
          namedImport("./capabilities-query.js", "scope"),
          own("fetchCandidate"),
        ]),
      },
    ],
    [query, { isIncluded: true, importedIds: [], ast: program([own("scope")]) }],
    [core, { isIncluded: true, importedIds: [], ast: program([own("request")]) }],
  ]);
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  return { root, operations, query, graph };
}
it("groups only bound capability operations and their query dependency with the same foundation request owner", () => {
  const f = capabilityOwnerFixture(true),
    boot = collectCockpitBootBindings(f.graph, f.root),
    select = createCockpitBootChunkSelector();
  expect(boot.has(f.operations)).toBe(true);
  expect(boot.has(f.query)).toBe(true);
  expect(select(f.operations, f.graph)).toBe("cockpit-foundation");
  expect(select(f.query, f.graph)).toBe("cockpit-foundation");
});
it("leaves globally retained capability operations and query automatic when the actual boot binding needs only the facade", () => {
  const f = capabilityOwnerFixture(false),
    boot = collectCockpitBootBindings(f.graph, f.root),
    select = createCockpitBootChunkSelector();
  expect(boot.has(f.operations)).toBe(false);
  expect(boot.has(f.query)).toBe(false);
  expect(select(f.operations, f.graph)).toBeUndefined();
  expect(select(f.query, f.graph)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(f.operations)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(f.query)).toBeUndefined();
});

const approvalChunks = ["ChatApprovalRendererBody", "ChatApprovalRendererSettlement"] as const;
function expectedApprovalChunk(owner: string) {
  return /\/(?:ApprovalSettlement\.tsx|approval-follow-on\.ts|ApprovalChangePlanOutcome\.tsx|durable-chat-turn-payload\.[jt]s)$/u.test(owner)
    ? approvalChunks[1]
    : approvalChunks[0];
}

function approvalBodyOwnerFixture(bootOwner = false) {
  const root = "C:/repo/src/cockpit-entry.tsx",
    app = "C:/repo/apps/mission-control-next/src/cockpit/";
  const body = app + "areas/chat/ChatApprovalRendererBody.ts",
    decision = app + "areas/inbox/ApprovalDecisionBar.tsx";
  const helpers = "C:/repo/packages/mission-control-shared/dist/content/approval-helpers.js",
    scroll = app + "ui/evidence-scroll.ts";
  const settlement = app + "areas/inbox/ApprovalSettlement.tsx",
    attempts = app + "areas/inbox/inbox-approval-attempts.ts";
  const communications = "C:/repo/packages/mission-control-shared/dist/content/communications-approval-evidence.js";
  const specialist = "C:/repo/apps/mission-control-next/src/cockpit/areas/inbox/specialist-approval-evidence.ts";
  const specialistReview = "C:/repo/apps/mission-control-next/src/cockpit/areas/inbox/SpecialistApprovalReview.tsx";
  const reviewSummary = "C:/repo/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalReviewSummary.tsx";
  const risk = "C:/repo/apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalAction.tsx";
  const guard = "C:/repo/apps/mission-control-next/src/cockpit/areas/inbox/inbox-approval-guard.ts";
  const outcome = "C:/repo/apps/mission-control-next/src/cockpit/areas/inbox/approval-settlement.ts";
  const followOn = "C:/repo/apps/mission-control-next/src/cockpit/areas/inbox/approval-follow-on.ts";
  const runtimeEvidence =
    "C:/repo/apps/mission-control-next/src/features/native-routes/ops/native-runtime-approval-evidence.ts";
  const externalEvidence = "C:/repo/packages/mission-control-shared/dist/content/external-source-approval-evidence.js";
  const durableAuthority = "C:/repo/packages/contracts/dist/durable-chat-turn-payload.js";
  const own = (name: string) => ({
    type: "ExportNamedDeclaration",
    source: null,
    specifiers: [],
    declaration: { type: "FunctionDeclaration", id: identifier(name) },
  });
  const namedImport = (source: string, name: string) => ({
    type: "ImportDeclaration",
    source: literal(source),
    specifiers: [{ type: "ImportSpecifier", imported: identifier(name), local: identifier(name) }],
  });
  const modules = new Map<string, Info>([
    [
      root,
      {
        isIncluded: true,
        importedIds: bootOwner ? [decision] : [],
        ast: program(
          bootOwner
            ? [
                namedImport(
                  "../apps/mission-control-next/src/cockpit/areas/inbox/ApprovalDecisionBar.tsx",
                  "ApprovalDecisionBar",
                ),
              ]
            : [],
        ),
      },
    ],
    [
      body,
      {
        isIncluded: false,
        importedIds: [decision, settlement],
        ast: program([
          {
            type: "ExportNamedDeclaration",
            source: literal("../inbox/ApprovalDecisionBar"),
            specifiers: [
              {
                type: "ExportSpecifier",
                local: identifier("ApprovalDecisionBar"),
                exported: identifier("ApprovalDecisionBar"),
              },
            ],
          },
          {
            type: "ExportNamedDeclaration",
            source: literal("../inbox/ApprovalSettlement"),
            specifiers: [
              {
                type: "ExportSpecifier",
                local: identifier("ApprovalSettlement"),
                exported: identifier("ApprovalSettlement"),
              },
            ],
          },
        ]),
      },
    ],
    [
      decision,
      {
        isIncluded: true,
        importedIds: [helpers, scroll, attempts],
        ast: program([
          namedImport(
            "@goatcitadel/mission-control-shared/content/approval-helpers",
            "buildApprovalRequestReviewEvidenceModel",
          ),
          namedImport("../../ui/evidence-scroll", "handleEvidenceScrollKeyDown"),
          namedImport("./inbox-approval-attempts", "useInboxApprovalAttempt"),
          own("ApprovalDecisionBar"),
        ]),
      },
    ],
    [
      helpers,
      {
        isIncluded: true,
        importedIds: [communications],
        ast: program([
          namedImport("./communications-approval-evidence.js", "communicationsMailSendApprovalEvidence"),
          own("buildApprovalRequestReviewEvidenceModel"),
        ]),
      },
    ],
    [scroll, { isIncluded: true, importedIds: [], ast: program([own("handleEvidenceScrollKeyDown")]) }],
    [settlement, { isIncluded: true, importedIds: [], ast: program([own("ApprovalSettlement")]) }],
    [attempts, { isIncluded: true, importedIds: [], ast: program([own("useInboxApprovalAttempt")]) }],
    [
      communications,
      { isIncluded: true, importedIds: [], ast: program([own("communicationsMailSendApprovalEvidence")]) },
    ],
    [specialist, { isIncluded: true, importedIds: [], ast: program([own("specialistEvidenceMatches")]) }],
    [specialistReview, { isIncluded: true, importedIds: [], ast: program([own("SpecialistApprovalReview")]) }],
    [reviewSummary, { isIncluded: true, importedIds: [], ast: program([own("ApprovalReviewSummary")]) }],
    [risk, { isIncluded: true, importedIds: [], ast: program([own("RiskApprovalAction")]) }],
    [guard, { isIncluded: true, importedIds: [], ast: program([own("canResolveInboxApproval")]) }],
    [outcome, { isIncluded: true, importedIds: [], ast: program([own("approvalDecisionMessage")]) }],
    [followOn, { isIncluded: true, importedIds: [], ast: program([own("readApprovalFollowOn")]) }],
    [runtimeEvidence, { isIncluded: true, importedIds: [], ast: program([own("nativeRuntimeReviewForApproval")]) }],
    [
      externalEvidence,
      { isIncluded: true, importedIds: [], ast: program([own("externalSourceKnowledgeApprovalEvidence")]) },
    ],
    [
      durableAuthority,
      { isIncluded: true, importedIds: [], ast: program([own("readDurableChatTurnExecutionPayloadAuthority")]) },
    ],
  ]);
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  return {
    root,
    body,
    decision,
    helpers,
    scroll,
    settlement,
    attempts,
    communications,
    specialist,
    specialistReview,
    reviewSummary,
    risk,
    guard,
    outcome,
    followOn,
    runtimeEvidence,
    externalEvidence,
    durableAuthority,
    owners: [
      body,
      decision,
      helpers,
      scroll,
      settlement,
      attempts,
      communications,
      specialist,
      specialistReview,
      reviewSummary,
      risk,
      guard,
      outcome,
      followOn,
      runtimeEvidence,
      externalEvidence,
    ],
    modules,
    graph,
  };
}
it("consolidates the sixteen proven approval presentation owners into pending and settled boundaries", () => {
  const f = approvalBodyOwnerFixture(),
    select = createCockpitBootChunkSelector(),
    boot = collectCockpitBootBindings(f.graph, f.root);
  for (const owner of f.owners) {
    expect(boot.has(owner)).toBe(false);
    expect(select(owner, f.graph)).toBe(expectedApprovalChunk(owner));
    expect(createCockpitBootChunkSelector()(owner)).toBeUndefined();
  }
});
it("keeps a genuine eager approval owner under boot ownership and disables the whole lazy consolidation", () => {
  const f = approvalBodyOwnerFixture(true),
    select = createCockpitBootChunkSelector();
  expect(select(f.decision, f.graph)).toBe("cockpit-entry");
  expect(select(f.helpers, f.graph)).toBe("cockpit-foundation");
  expect(select(f.scroll, f.graph)).toBe("cockpit-entry");
  expect(select(f.body, f.graph)).toBeUndefined();
});
const approvalOwnerNames = [
  "body",
  "decision",
  "helpers",
  "scroll",
  "settlement",
  "attempts",
  "communications",
  "specialist",
  "specialistReview",
  "reviewSummary",
  "risk",
  "guard",
  "outcome",
  "followOn",
  "runtimeEvidence",
  "externalEvidence",
] as const;
const unprovedApprovalMetadata = ["missing", "unknown-inclusion", "unsupported-ast", "ambiguous-owner"] as const;
it.each(approvalOwnerNames.flatMap((owner) => unprovedApprovalMetadata.map((kind) => [owner, kind] as const)))(
  "preserves automatic placement for all approval owners when %s has %s group metadata",
  (name, kind) => {
    const f = approvalBodyOwnerFixture(),
      owner = f[name],
      info = f.modules.get(owner)!;
    if (kind === "missing") f.modules.delete(owner);
    if (kind === "unknown-inclusion") info.isIncluded = null;
    if (kind === "unsupported-ast") delete info.ast;
    if (kind === "ambiguous-owner") {
      const duplicate = owner.includes("/dist/")
        ? owner.replace("/dist/", "/src/").replace(/\.js$/, ".ts")
        : owner.replace("C:/repo", "D:/duplicate");
      f.modules.set(duplicate, { ...info });
    }
    const select = createCockpitBootChunkSelector();
    for (const candidate of f.owners) expect(select(candidate, f.graph)).toBeUndefined();
  },
);

it.each([
  ["settlement", "ApprovalSettlement", "cockpit-entry"],
  ["attempts", "useInboxApprovalAttempt", "cockpit-entry"],
  ["communications", "communicationsMailSendApprovalEvidence", "cockpit-foundation"],
  ["specialist", "specialistEvidenceMatches", "cockpit-entry"],
  ["specialistReview", "SpecialistApprovalReview", "cockpit-entry"],
  ["reviewSummary", "ApprovalReviewSummary", "cockpit-entry"],
  ["risk", "RiskApprovalAction", "cockpit-entry"],
  ["guard", "canResolveInboxApproval", "cockpit-entry"],
  ["outcome", "approvalDecisionMessage", "cockpit-entry"],
  ["followOn", "readApprovalFollowOn", "cockpit-entry"],
  ["runtimeEvidence", "nativeRuntimeReviewForApproval", "cockpit-entry"],
  ["externalEvidence", "externalSourceKnowledgeApprovalEvidence", "cockpit-foundation"],
] as const)(
  "keeps a genuine cold %s binding eager and disables the complete approval group",
  (name, exportedName, chunk) => {
    const f = approvalBodyOwnerFixture(),
      owner = f[name];
    f.modules.set(f.root, {
      isIncluded: true,
      importedIds: [owner],
      ast: program([
        {
          type: "ImportDeclaration",
          source: literal(owner),
          specifiers: [
            { type: "ImportSpecifier", imported: identifier(exportedName), local: identifier(exportedName) },
          ],
        },
      ]),
    });
    expect(collectCockpitBootBindings(f.graph, f.root).has(owner)).toBe(true);
    const select = createCockpitBootChunkSelector();
    expect(select(owner, f.graph)).toBe(chunk);
    for (const candidate of f.owners) expect(approvalChunks).not.toContain(select(candidate, f.graph));
  },
);

it("keeps conservative payload authority automatic while consolidating all sixteen proven optional owners", () => {
  const f = approvalBodyOwnerFixture(),
    proof = new Set<string>();
  // An unaccounted dependency must retain conservative traversal, matching the actual R5 guard trace.
  f.modules.set(f.root, { isIncluded: true, importedIds: [f.durableAuthority], ast: program([]) });
  expect(collectCockpitBootBindings(f.graph, f.root, proof).has(f.durableAuthority)).toBe(true);
  expect(proof.has(f.durableAuthority)).toBe(false);
  const select = createCockpitBootChunkSelector();
  expect(select(f.durableAuthority, f.graph)).toBeUndefined();
  for (const owner of f.owners) expect(select(owner, f.graph)).toBe(expectedApprovalChunk(owner));
});
it("keeps a genuine future payload-authority value binding cold independently of the optional presentation group", () => {
  const f = approvalBodyOwnerFixture(),
    proof = new Set<string>();
  const name = "readDurableChatTurnExecutionPayloadAuthority";
  f.modules.set(f.root, {
    isIncluded: true,
    importedIds: [f.durableAuthority],
    ast: program([
      {
        type: "ImportDeclaration",
        source: literal(f.durableAuthority),
        specifiers: [{ type: "ImportSpecifier", imported: identifier(name), local: identifier(name) }],
      },
    ]),
  });
  expect(collectCockpitBootBindings(f.graph, f.root, proof).has(f.durableAuthority)).toBe(true);
  expect(proof.has(f.durableAuthority)).toBe(true);
  const select = createCockpitBootChunkSelector();
  expect(select(f.durableAuthority, f.graph)).toBe("cockpit-foundation");
  for (const owner of f.owners) expect(select(owner, f.graph)).toBe(expectedApprovalChunk(owner));
});
it.each(unprovedApprovalMetadata)(
  "retains the shared authority's automatic fallback when its own %s metadata is unproved",
  (kind) => {
    const f = approvalBodyOwnerFixture(),
      owner = f.durableAuthority,
      info = f.modules.get(owner)!;
    if (kind === "missing") f.modules.delete(owner);
    if (kind === "unknown-inclusion") info.isIncluded = null;
    if (kind === "unsupported-ast") delete info.ast;
    if (kind === "ambiguous-owner")
      f.modules.set(owner.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), { ...info });
    const select = createCockpitBootChunkSelector();
    expect(select(owner, f.graph)).toBeUndefined();
    for (const candidate of f.owners) expect(select(candidate, f.graph)).toBe(expectedApprovalChunk(candidate));
  },
);

it.each(["direct", "alias", "star"] as const)(
  "records only the resolved included owner after a complete %s value-export chain",
  (kind) => {
    const f = boundFixture(),
      proof = new Set<string>();
    if (kind === "direct")
      f.modules.get(f.root)!.ast = program([
        {
          type: "ImportDeclaration",
          source: literal(f.needed),
          specifiers: [{ type: "ImportSpecifier", imported: identifier("needed"), local: identifier("value") }],
        },
      ]);
    if (kind === "direct") f.modules.get(f.root)!.importedIds = [f.needed];
    if (kind === "alias")
      f.modules.get(f.barrel)!.ast = program([
        {
          type: "ImportDeclaration",
          source: literal("./needed.js"),
          specifiers: [{ type: "ImportSpecifier", imported: identifier("needed"), local: identifier("internal") }],
        },
        {
          type: "ExportNamedDeclaration",
          source: null,
          specifiers: [{ type: "ExportSpecifier", local: identifier("internal"), exported: identifier("needed") }],
        },
        f.forward("lazy", "lazy"),
      ]);
    if (kind === "star")
      f.modules.get(f.barrel)!.ast = program([
        { type: "ExportAllDeclaration", source: literal("./needed.js") },
        f.forward("lazy", "lazy"),
      ]);
    const original = collectCockpitBootBindings(f.graph, f.root);
    expect(collectCockpitBootBindings(f.graph, f.root, proof)).toEqual(original);
    expect(proof).toEqual(new Set([f.needed]));
    expect(proof.has(f.barrel)).toBe(false);
    expect(proof.has(f.lazy)).toBe(false);
  },
);
it.each([
  "namespace",
  "missing",
  "unknown",
  "ambiguous-star",
  "incomplete-star",
  "duplicate-direct",
  "nonpositive",
  "synthetic",
  "bare",
] as const)("preserves the original conservative Set without positively proving %s ownership", (kind) => {
  const f = boundFixture(kind === "namespace" || kind === "missing" ? kind : "named"),
    proof = new Set<string>();
  if (kind === "unknown") f.modules.get(f.needed)!.ast = program([f.exportedOwn("other")]);
  if (kind === "ambiguous-star" || kind === "incomplete-star") {
    f.modules.get(f.barrel)!.ast = program([
      { type: "ExportAllDeclaration", source: literal("./needed.js") },
      { type: "ExportAllDeclaration", source: literal("./lazy.js") },
    ]);
    if (kind === "ambiguous-star") f.modules.get(f.lazy)!.ast = program([f.exportedOwn("needed")]);
    else delete f.modules.get(f.lazy)!.ast;
  }
  if (kind === "duplicate-direct") {
    f.modules.get(f.barrel)!.ast = program([f.forward("needed", "needed"), f.forward("needed", "lazy")]);
    f.modules.get(f.lazy)!.ast = program([f.exportedOwn("needed")]);
  }
  if (kind === "nonpositive") f.modules.get(f.needed)!.isIncluded = false;
  if (kind === "synthetic") f.modules.get(f.root)!.ast = program([]);
  if (kind === "bare")
    f.modules.get(f.root)!.ast = program([
      { type: "ImportDeclaration", source: literal("./shared/index.js"), specifiers: [] },
    ]);
  const original = collectCockpitBootBindings(f.graph, f.root);
  expect(collectCockpitBootBindings(f.graph, f.root, proof)).toEqual(original);
  expect(proof).toEqual(new Set());
});
it("leaves known automatic approval authority automatic when its boot membership is only a discarded synthetic edge", () => {
  const f = approvalBodyOwnerFixture(),
    discarded = "C:/repo/discarded.js";
  f.modules.set(f.root, { isIncluded: true, importedIds: [discarded], ast: program([]) });
  f.modules.set(discarded, { isIncluded: false, importedIds: [f.durableAuthority], ast: program([]) });
  const proof = new Set<string>(),
    boot = collectCockpitBootBindings(f.graph, f.root, proof);
  expect(boot.has(f.durableAuthority)).toBe(true);
  expect(proof.has(f.durableAuthority)).toBe(false);
  expect(createCockpitBootChunkSelector()(f.durableAuthority, f.graph)).toBeUndefined();
});
it("retains the known lazy presentation group when an ordinary owner is discarded", () => {
  const f = approvalBodyOwnerFixture();
  f.modules.get(f.externalEvidence)!.isIncluded = false;
  expect(usesAutomaticCockpitPlacement(f.externalEvidence)).toBe(false);
  const select = createCockpitBootChunkSelector();
  expect(select(f.externalEvidence, f.graph)).toBe("ChatApprovalRendererBody");
  for (const candidate of f.owners) expect(select(candidate, f.graph)).toBe(expectedApprovalChunk(candidate));
});
it("keeps nonpositive shared authority automatic without disabling proven optional presentation owners", () => {
  const f = approvalBodyOwnerFixture();
  f.modules.get(f.durableAuthority)!.isIncluded = false;
  const select = createCockpitBootChunkSelector();
  expect(select(f.durableAuthority, f.graph)).toBeUndefined();
  for (const candidate of f.owners) expect(select(candidate, f.graph)).toBe(expectedApprovalChunk(candidate));
});

const workbenchOperationNames = [
  "createChatSessionWorkbenchWorktree",
  "saveChatSessionWorkbenchFile",
  "previewChatSessionWorkbenchFileOperation",
  "runChatSessionWorkbenchFileOperation",
  "runChatSessionWorkbenchCommand",
  "applyChatSessionWorkbenchPatch",
  "exportChatSessionWorkbenchPatch",
  "revertChatSessionWorkbenchFile",
  "revertChatSessionWorkbenchChanges",
];
it.each(["dist/api/chat-workbench-operations.js", "src/api/chat-workbench-operations.ts"])(
  "lets the exact optional workbench owner %s follow actual Rollup imports",
  (relative) => {
    const id = "C:/repo/packages/mission-control-shared/" + relative;
    expect(usesAutomaticCockpitPlacement(id)).toBe(true);
    expect(usesAutomaticCockpitPlacement(id.replaceAll("/", String.fromCharCode(92)))).toBe(true);
    expect(createCockpitBootChunkSelector()(id)).toBeUndefined();
  },
);
it.each([
  "C:/repo/packages/mission-control-shared/dist/api/chat.js",
  "C:/repo/packages/mission-control-shared/dist/api/chat-workbench-operations-new.js",
  "C:/repo/packages/mission-control-shared/dist/api/chat-workbench-operations.js.map",
  "C:/repo/packages/another-package/dist/api/chat-workbench-operations.js",
])("does not register a facade or lookalike workbench owner %s", (id) => {
  expect(usesAutomaticCockpitPlacement(id)).toBe(false);
  expect(usesAutomaticCockpitPlacement(id.replaceAll("/", String.fromCharCode(92)))).toBe(false);
});
function workbenchOperationFixture(
  requestedName = "fetchChatSessionWorkbench",
  metadata: "named" | "namespace" | "missing" = "named",
) {
  const api = "C:/repo/packages/mission-control-shared/dist/api/",
    facade = api + "chat.js",
    operations = api + "chat-workbench-operations.js",
    core = api + "client-core.js";
  const own = (name: string) => ({
    type: "ExportNamedDeclaration",
    source: null,
    specifiers: [],
    declaration: { type: "FunctionDeclaration", id: identifier(name) },
  });
  const namedImport = (source: string, name: string) => ({
    type: "ImportDeclaration",
    source: literal(source),
    specifiers: [{ type: "ImportSpecifier", imported: identifier(name), local: identifier(name) }],
  });
  const modules = new Map<string, Info>([
    [
      root,
      {
        isIncluded: true,
        importedIds: [facade],
        ast: program([
          {
            type: "ImportDeclaration",
            source: literal("../packages/mission-control-shared/dist/api/chat.js"),
            specifiers: [
              {
                type: metadata === "namespace" ? "ImportNamespaceSpecifier" : "ImportSpecifier",
                imported: identifier(requestedName),
                local: identifier("api"),
              },
            ],
          },
        ]),
      },
    ],
    [
      facade,
      {
        isIncluded: true,
        importedIds: [core, operations],
        ast: program([
          namedImport("./client-core.js", "request"),
          own("fetchChatSessionWorkbench"),
          {
            type: "ExportNamedDeclaration",
            source: literal("./chat-workbench-operations.js"),
            specifiers: workbenchOperationNames.map((name) => ({
              type: "ExportSpecifier",
              local: identifier(name),
              exported: identifier(name),
            })),
          },
        ]),
      },
    ],
    [
      operations,
      {
        isIncluded: true,
        importedIds: [core],
        ast: program([namedImport("./client-core.js", "request"), ...workbenchOperationNames.map(own)]),
      },
    ],
    [core, { isIncluded: true, importedIds: [], ast: program([own("request")]) }],
  ]);
  if (metadata === "missing") delete modules.get(facade)!.ast;
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  return { graph, facade, operations, core };
}
it("keeps the eager workbench GET and transport without grouping its unrequested operation forwards", () => {
  const f = workbenchOperationFixture(),
    proof = new Set<string>();
  expect(collectCockpitBootBindings(f.graph, root, proof)).toEqual(new Set([root, f.facade, f.core]));
  expect(proof.has(f.operations)).toBe(false);
  expect(createCockpitBootChunkSelector()(f.operations, f.graph)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(f.facade, f.graph)).toBe("cockpit-foundation");
});
it.each(workbenchOperationNames)(
  "preserves the real named cold binding %s even though its placement is automatic",
  (name) => {
    const f = workbenchOperationFixture(name),
      proof = new Set<string>();
    expect(collectCockpitBootBindings(f.graph, root, proof)).toEqual(new Set([root, f.operations, f.core]));
    expect(proof.has(f.operations)).toBe(true);
    expect(createCockpitBootChunkSelector()(f.operations, f.graph)).toBeUndefined();
  },
);
it.each(["namespace", "missing"] as const)(
  "keeps conservative workbench inclusion and absence of positive proof for %s metadata",
  (metadata) => {
    const f = workbenchOperationFixture("fetchChatSessionWorkbench", metadata),
      proof = new Set<string>();
    expect(collectCockpitBootBindings(f.graph, root, proof)).toEqual(new Set([root, f.facade, f.operations, f.core]));
    expect(proof.has(f.operations)).toBe(false);
    expect(createCockpitBootChunkSelector()(f.operations, f.graph)).toBeUndefined();
  },
);

it.each(["v4/core/schemas.js", "v4/mini/schemas.js"])(
  "lets the real Zod owner %s use automatic placement even with a named cold binding",
  (suffix) => {
    const owner = "C:/repo/node_modules/zod/" + suffix;
    const modules = new Map<string, Info>([
      [
        root,
        {
          isIncluded: true,
          importedIds: [owner],
          ast: program([
            {
              type: "ImportDeclaration",
              source: literal(owner),
              specifiers: [{ type: "ImportSpecifier", imported: identifier("schema"), local: identifier("schema") }],
            },
          ]),
        },
      ],
      [
        owner,
        {
          isIncluded: true,
          importedIds: [],
          ast: program([
            {
              type: "ExportNamedDeclaration",
              source: null,
              specifiers: [],
              declaration: { type: "FunctionDeclaration", id: identifier("schema") },
            },
          ]),
        },
      ],
    ]);
    const graph: CockpitBootModuleGraph = {
      getModuleIds: () => modules.keys(),
      getModuleInfo: (id) => modules.get(id) ?? null,
    };
    const named = new Set<string>();
    expect(collectCockpitBootBindings(graph, root, named).has(owner)).toBe(true);
    expect(named.has(owner)).toBe(true);
    expect(createCockpitBootChunkSelector()(owner, graph)).toBeUndefined();
  },
);

// Exact source-owned first-use modules; independent of the older sixteen-owner fallback fixture.
const chatDemandOwnerAliases = [
  ["/apps/mission-control-next/src/cockpit/areas/chat/code-mode-request-copy.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/ChatToolApprovalLine.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/approval-settlement.ts"],
  ["/apps/mission-control-next/src/cockpit/ui/RecordedErrorDetails.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/inbox-vocabulary.ts"],
  [
    "/packages/mission-control-shared/dist/components/chat/chat-tool-diff.js",
    "/packages/mission-control-shared/src/components/chat/chat-tool-diff.ts",
  ],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/SpecialistApprovalReview.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/prepare-approve.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalDecisionBar.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/ChatToolRunSummary.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/chat-tool-run-groups.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/chat-tool-run-change-stats.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/ChatToolActivityBody.tsx"],
  ["/packages/contracts/dist/durable-chat-turn-payload.js", "/packages/contracts/src/durable-chat-turn-payload.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/approval-follow-on.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalChangePlanOutcome.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalSettlement.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/ChatApprovalRendererBody.ts"],
] as const;

// Observed graph447 residual approval closure. Existing eighteen-owner tests remain unchanged.
const residualApprovalAliases = [
  ["/packages/mission-control-shared/dist/content/approval-helpers.js", "/packages/mission-control-shared/src/content/approval-helpers.ts"],
  ["/packages/mission-control-shared/dist/content/external-source-approval-evidence.js", "/packages/mission-control-shared/src/content/external-source-approval-evidence.ts"],
  ["/packages/mission-control-shared/dist/content/communications-approval-evidence.js", "/packages/mission-control-shared/src/content/communications-approval-evidence.ts"],
  ["/packages/mission-control-shared/dist/content/skill-state-approval-evidence.js", "/packages/mission-control-shared/src/content/skill-state-approval-evidence.ts"],
  ["/packages/mission-control-shared/dist/content/code-mode-request-input.js", "/packages/mission-control-shared/src/content/code-mode-request-input.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/inbox-approval-attempts.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/inbox-approval-guard.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/use-minute-clock.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalReviewSummary.tsx"],
  ["/apps/mission-control-next/src/cockpit/ui/evidence-scroll.ts"],
  ["/apps/mission-control-next/src/cockpit/ui/TypedConfirmation.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalAction.tsx"],
] as const;
function residualApprovalFixture(directory: "src" | "dist" = "dist") {
  const f = chatDemandFixture(directory);
  const residual = residualApprovalAliases.map(aliases => "C:/repo" + (directory === "src" && aliases.length === 2 ? aliases[1] : aliases[0]));
  for (const owner of residual) f.modules.set(owner, { isIncluded: true, importedIds: [], ast: program([{
    type: "ExportNamedDeclaration", source: null, specifiers: [],
    declaration: { type: "FunctionDeclaration", id: identifier("residualValue") },
  }]) });
  // Existing lazy decision owner consumes this closure; no initial/main edge is introduced.
  f.modules.get(f.owners[8]!)!.importedIds = [...residual];
  return { ...f, residual };
}
it.each(["src", "dist"] as const)("joins the exact twelve proven residual approval owners with the existing demand chunk (%s)", directory => {
  const f = residualApprovalFixture(directory), select = createCockpitBootChunkSelector();
  const named = new Set<string>(), boot = collectCockpitBootBindings(f.graph, root, named);
  for (const owner of f.residual) {
    expect(boot.has(owner)).toBe(false); expect(named.has(owner)).toBe(false);
    expect(select(owner, f.graph)).toBe(expectedApprovalChunk(owner));
    expect(createCockpitBootChunkSelector()(owner)).toBeUndefined();
  }
  for (const owner of f.owners) expect(select(owner, f.graph)).toBe(expectedApprovalChunk(owner));
});
const residualFailures = ["missing", "discarded", "unknown", "ast", "body", "duplicate", "cold", "conservative", "initial"] as const;
it.each(residualApprovalAliases.flatMap((_, index) => residualFailures.map(kind => [index, kind] as const)))(
  "refuses the whole residual cohort for owner %s with %s while retaining the independent demand guard", (index, kind) => {
    const f = residualApprovalFixture(), owner = f.residual[index]!, info = f.modules.get(owner)!;
    if (kind === "missing") f.modules.delete(owner);
    if (kind === "discarded") info.isIncluded = false;
    if (kind === "unknown") info.isIncluded = null;
    if (kind === "ast") info.ast = { type: "Unknown", body: [] };
    if (kind === "body") info.ast = { type: "Program", body: null };
    if (kind === "duplicate") f.modules.set(owner.includes("/dist/") ? owner.replace("/dist/", "/src/").replace(/\.js$/u, ".ts") : owner.replace("C:/repo", "D:/other"), { ...info });
    if (kind === "cold") f.modules.set(root, { isIncluded: true, importedIds: [owner], ast: program([{
      type: "ImportDeclaration", source: literal(owner),
      specifiers: [{ type: "ImportSpecifier", imported: identifier("residualValue"), local: identifier("residualValue") }],
    }]) });
    if (kind === "initial") f.modules.set("C:/repo/src/main.tsx", { isIncluded: true, importedIds: [owner], ast: program([]) });
    if (kind === "conservative") f.modules.set(root, { isIncluded: true, importedIds: [owner], ast: program([]) });
    const select = createCockpitBootChunkSelector();
    for (const candidate of f.residual) expect(approvalChunks).not.toContain(select(candidate, f.graph));
    for (const candidate of f.owners) expect(select(candidate, f.graph)).toBe(expectedApprovalChunk(candidate));
  },
);
it("does not form the residual group without the proven eighteen-owner demand anchor", () => {
  const f = residualApprovalFixture(); f.modules.delete(f.owners[12]!);
  const select = createCockpitBootChunkSelector();
  for (const owner of f.residual) expect(approvalChunks).not.toContain(select(owner, f.graph));
});
function chatDemandFixture(directory: "src" | "dist" = "dist") {
  const owners = chatDemandOwnerAliases.map(
    (aliases) => "C:/repo" + (aliases.length === 2 && directory === "src" ? aliases[1] : aliases[0]),
  );
  const modules = new Map<string, Info>([[root, { isIncluded: true, importedIds: [], ast: program([]) }]]);
  const own = {
    type: "ExportNamedDeclaration",
    source: null,
    specifiers: [],
    declaration: { type: "FunctionDeclaration", id: identifier("demandValue") },
  };
  for (const owner of owners)
    modules.set(owner, { isIncluded: owner !== owners[17], importedIds: [], ast: program([own]) });
  const graph: CockpitBootModuleGraph = {
    getModuleIds: () => modules.keys(),
    getModuleInfo: (id) => modules.get(id) ?? null,
  };
  return { owners, modules, graph };
}
it.each(["src", "dist"] as const)(
  "coalesces all eighteen proven lazy demand owners using %s package aliases without adding them to static Chat",
  (directory) => {
    const f = chatDemandFixture(directory),
      select = createCockpitBootChunkSelector(),
      named = new Set<string>();
    const cold = collectCockpitBootBindings(f.graph, root, named);
    expect(cold).toEqual(new Set([root]));
    for (const owner of f.owners) {
      expect(cold.has(owner)).toBe(false);
      expect(named.has(owner)).toBe(false);
      expect(select(owner, f.graph)).toBe(expectedApprovalChunk(owner));
      expect(createCockpitBootChunkSelector()(owner)).toBeUndefined();
    }
  },
);
it.each(chatDemandOwnerAliases.map((_, index) => index))(
  "preserves a genuine named cold binding for demand owner %s and rejects the larger consolidation",
  (index) => {
    const f = chatDemandFixture(),
      owner = f.owners[index]!;
    f.modules.get(owner)!.isIncluded = true;
    f.modules.set(root, {
      isIncluded: true,
      importedIds: [owner],
      ast: program([
        {
          type: "ImportDeclaration",
          source: literal(owner),
          specifiers: [
            { type: "ImportSpecifier", imported: identifier("demandValue"), local: identifier("demandValue") },
          ],
        },
      ]),
    });
    const named = new Set<string>();
    collectCockpitBootBindings(f.graph, root, named);
    expect(named.has(owner)).toBe(true);
    const select = createCockpitBootChunkSelector();
    expect(select(owner, f.graph)).toBe(owner.includes("/packages/") ? "cockpit-foundation" : "cockpit-entry");
    for (const candidate of f.owners) expect(approvalChunks).not.toContain(select(candidate, f.graph));
  },
);
const demandMetadataFailures = [
  "missing",
  "unknown-inclusion",
  "missing-ast",
  "unsupported-ast",
  "malformed-body",
  "ambiguous-owner",
] as const;
it.each(chatDemandOwnerAliases.flatMap((_, index) => demandMetadataFailures.map((kind) => [index, kind] as const)))(
  "rejects the larger demand group when owner %s has %s metadata",
  (index, kind) => {
    const f = chatDemandFixture(),
      owner = f.owners[index]!,
      info = f.modules.get(owner)!;
    if (kind === "missing") f.modules.delete(owner);
    if (kind === "unknown-inclusion") info.isIncluded = null;
    if (kind === "missing-ast") delete info.ast;
    if (kind === "unsupported-ast") info.ast = { type: "ExpressionStatement", body: [] };
    if (kind === "malformed-body") info.ast = { type: "Program", body: null };
    if (kind === "ambiguous-owner") f.modules.set(owner.replace("C:/repo/", "C:/duplicate/"), { ...info });
    const select = createCockpitBootChunkSelector();
    for (const candidate of f.owners) expect(approvalChunks).not.toContain(select(candidate, f.graph));
  },
);
it.each(chatDemandOwnerAliases.map((_, index) => index).filter((index) => index !== 17))(
  "does not accept a discarded real implementation for owner %s",
  (index) => {
    const f = chatDemandFixture();
    f.modules.get(f.owners[index]!)!.isIncluded = false;
    const select = createCockpitBootChunkSelector();
    for (const owner of f.owners) expect(approvalChunks).not.toContain(select(owner, f.graph));
  },
);
it.each(chatDemandOwnerAliases.map((_, index) => index))(
  "allows conservative boot reachability only for durable authority, owner %s",
  (index) => {
    const f = chatDemandFixture(),
      owner = f.owners[index]!;
    f.modules.get(owner)!.isIncluded = true;
    f.modules.set(root, { isIncluded: true, importedIds: [owner], ast: program([]) });
    const named = new Set<string>(),
      cold = collectCockpitBootBindings(f.graph, root, named);
    expect(cold.has(owner)).toBe(true);
    expect(named.has(owner)).toBe(false);
    const select = createCockpitBootChunkSelector();
    for (const candidate of f.owners) {
      if (index === 13) expect(select(candidate, f.graph)).toBe(expectedApprovalChunk(candidate));
      else expect(approvalChunks).not.toContain(select(candidate, f.graph));
    }
  },
);
it("keeps reset/bootstrap imports outside the optional demand group", () => {
  const f = chatDemandFixture(),
    owner = f.owners[12]!;
  f.modules.set("C:/repo/src/main.tsx", { isIncluded: true, importedIds: [owner], ast: program([]) });
  const select = createCockpitBootChunkSelector();
  for (const candidate of f.owners) expect(approvalChunks).not.toContain(select(candidate, f.graph));
});
it("rejects simultaneous source and dist aliases rather than arbitrarily selecting one", () => {
  const f = chatDemandFixture();
  for (const index of [5, 13]) {
    const alias = "C:/repo" + chatDemandOwnerAliases[index]![1];
    f.modules.set(alias, { isIncluded: true, importedIds: [], ast: program([]) });
  }
  const select = createCockpitBootChunkSelector();
  for (const owner of f.owners) expect(approvalChunks).not.toContain(select(owner, f.graph));
});
it("retains the older sixteen-owner fallback when a new demand-only owner is missing", () => {
  const f = approvalBodyOwnerFixture();
  const select = createCockpitBootChunkSelector();
  expect(f.modules.has("C:/repo" + chatDemandOwnerAliases[12]![0])).toBe(false);
  for (const owner of f.owners) expect(select(owner, f.graph)).toBe(expectedApprovalChunk(owner));
  expect(select(f.durableAuthority, f.graph)).toBeUndefined();
});

const coldRuntimeVendorSuffixes = [
  "/node_modules/@radix-ui/react-visually-hidden/dist/index.mjs",
  "/node_modules/@radix-ui/react-use-size/dist/index.mjs",
  "/node_modules/@floating-ui/utils/dist/floating-ui.utils.mjs",
  "/node_modules/@floating-ui/core/dist/floating-ui.core.mjs",
  "/node_modules/@floating-ui/utils/dist/floating-ui.utils.dom.mjs",
  "/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs",
  "/node_modules/@floating-ui/react-dom/dist/floating-ui.react-dom.mjs",
  "/node_modules/@radix-ui/react-arrow/dist/index.mjs",
  "/node_modules/@radix-ui/react-popper/dist/index.mjs",
  "/node_modules/@radix-ui/react-popover/dist/index.mjs",
  "/node_modules/@radix-ui/react-tooltip/dist/index.mjs",
  "/node_modules/zod/v4/core/util.js",
  "/node_modules/zod/v4/core/core.js",
  "/node_modules/zod/v4/core/errors.js",
  "/node_modules/zod/v4/core/parse.js",
  "/node_modules/zod/v4/core/regexes.js",
  "/node_modules/zod/v4/core/checks.js",
  "/node_modules/zod/v4/core/doc.js",
  "/node_modules/zod/v4/core/versions.js",
  "/node_modules/zod/v4/core/schemas.js",
  "/node_modules/zod/v4/core/api.js",
  "/node_modules/zod/v4/mini/schemas.js",
] as const;
function coldRuntimeVendorFixture() {
  const owners = coldRuntimeVendorSuffixes.map((suffix) => "C:/repo/node_modules/.pnpm/fixture" + suffix);
  const main = "C:/repo/src/main.tsx";
  const own = {
    type: "ExportNamedDeclaration",
    source: null,
    specifiers: [],
    declaration: { type: "FunctionDeclaration", id: identifier("coldVendor") },
  };
  const modules = new Map<string, Info>([
    [root, { isIncluded: true, importedIds: owners, ast: program([]) }],
    [main, { isIncluded: true, importedIds: [], ast: program([]) }],
    ...owners.map((owner) => [owner, { isIncluded: true, importedIds: [], ast: program([own]) }] as [string, Info]),
  ]);
  const scans = vi.fn(() => modules.keys());
  const graph: CockpitBootModuleGraph = { getModuleIds: scans, getModuleInfo: (id) => modules.get(id) ?? null };
  return { owners, main, modules, scans, graph };
}
it("groups exactly the complete already-cold vendor set, with no bootstrap or optional siblings", () => {
  const f = coldRuntimeVendorFixture();
  const sibling = "C:/repo/node_modules/.pnpm/fixture/node_modules/@floating-ui/dom/dist/lazy-sibling.mjs";
  f.modules.set(sibling, { isIncluded: true, importedIds: [], ast: program([]) });
  expect(findColdCockpitRuntimeVendors(f.graph)).toEqual(new Set(f.owners));
  const select = createCockpitBootChunkSelector();
  f.scans.mockClear();
  for (const owner of f.owners)
    expect(select(owner, f.graph)).toBe(optionalOverlayVendorSuffixes.some((suffix) => owner.endsWith(suffix)) ? undefined : "cockpit-runtime");
  expect(f.scans).toHaveBeenCalledOnce();
  expect(select(f.main, f.graph)).toBeUndefined();
  expect(select(sibling, f.graph)).not.toBe("cockpit-runtime");
});
const coldVendorFailures = [
  "missing",
  "duplicate",
  "unknown-inclusion",
  "excluded",
  "missing-ast",
  "unsupported-ast",
  "malformed-body",
  "named",
  "direct-main",
] as const;
it.each(coldRuntimeVendorSuffixes.flatMap((_, index) => coldVendorFailures.map((kind) => [index, kind] as const)))(
  "keeps existing automatic fallback when vendor %s has %s proof",
  (index, kind) => {
    const f = coldRuntimeVendorFixture(),
      owner = f.owners[index]!,
      info = f.modules.get(owner)!;
    if (kind === "missing") f.modules.delete(owner);
    if (kind === "duplicate") f.modules.set(owner.replace("C:/repo/", "C:/duplicate/"), { ...info });
    if (kind === "unknown-inclusion") info.isIncluded = null;
    if (kind === "excluded") info.isIncluded = false;
    if (kind === "missing-ast") delete info.ast;
    if (kind === "unsupported-ast") info.ast = { type: "ExpressionStatement", body: [] };
    if (kind === "malformed-body") info.ast = { type: "Program", body: null };
    if (kind === "named")
      f.modules.get(root)!.ast = program([
        {
          type: "ImportDeclaration",
          source: literal(owner),
          specifiers: [
            { type: "ImportSpecifier", imported: identifier("coldVendor"), local: identifier("coldVendor") },
          ],
        },
      ]);
    if (kind === "direct-main") f.modules.get(f.main)!.importedIds = [owner];
    expect(findColdCockpitRuntimeVendors(f.graph)).toBeNull();
    const select = createCockpitBootChunkSelector();
    // These two retain their independent, unconditional Zod/SDK automatic boundaries when proof fails.
    expect(select(f.owners[8]!, f.graph)).toBeUndefined();
    expect(select(f.owners[19]!, f.graph)).toBeUndefined();
  },
);
it("caches failed vendor proof once and leaves later calls under existing placement rules", () => {
  const f = coldRuntimeVendorFixture();
  f.modules.delete(f.owners[0]!);
  const select = createCockpitBootChunkSelector();
  for (let index = 0; index < 30; index++) expect(select(f.owners[8]!, f.graph)).toBeUndefined();
  expect(f.scans).toHaveBeenCalledOnce();
});
it("does not cache absent graph metadata before a real build graph is provided", () => {
  const f = coldRuntimeVendorFixture(),
    select = createCockpitBootChunkSelector();
  expect(select(f.owners[8]!)).toBeUndefined();
  expect(f.scans).not.toHaveBeenCalled();
  expect(select(f.owners[8]!, f.graph)).toBeUndefined();
  expect(f.scans).toHaveBeenCalledOnce();
});
it.each(["missing-main", "duplicate-main", "missing-cockpit", "duplicate-cockpit", "unknown-main-dependency"] as const)(
  "rejects incomplete bootstrap/root proof: %s",
  (kind) => {
    const f = coldRuntimeVendorFixture();
    if (kind === "missing-main") f.modules.delete(f.main);
    if (kind === "duplicate-main")
      f.modules.set("C:/duplicate/src/main.tsx", { isIncluded: true, importedIds: [], ast: program([]) });
    if (kind === "missing-cockpit") f.modules.delete(root);
    if (kind === "duplicate-cockpit")
      f.modules.set("C:/duplicate/src/cockpit-entry.tsx", { isIncluded: true, importedIds: [], ast: program([]) });
    if (kind === "unknown-main-dependency") f.modules.get(f.main)!.importedIds = ["C:/repo/unknown-bootstrap.js"];
    expect(findColdCockpitRuntimeVendors(f.graph)).toBeNull();
  },
);

// Measured graph 53: these exact SDK owners are retained only by discarded
// umbrella reachability. The complete legacy fixture must not repin them.
const optionalOverlayVendorSuffixes = [
  "/node_modules/@radix-ui/react-popper/dist/index.mjs",
  "/node_modules/@radix-ui/react-popover/dist/index.mjs",
  "/node_modules/@radix-ui/react-tooltip/dist/index.mjs",
  "/node_modules/@floating-ui/utils/dist/floating-ui.utils.mjs",
  "/node_modules/@floating-ui/core/dist/floating-ui.core.mjs",
  "/node_modules/@floating-ui/utils/dist/floating-ui.utils.dom.mjs",
  "/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs",
  "/node_modules/@floating-ui/react-dom/dist/floating-ui.react-dom.mjs",
] as const;

it.each(optionalOverlayVendorSuffixes)(
  "does not let the complete legacy cold-vendor group repin optional overlay %s",
  (suffix) => {
    const f = coldRuntimeVendorFixture();
    const owner = f.owners.find((id) => id.endsWith(suffix))!;
    const proof = new Set<string>();
    expect(collectCockpitBootBindings(f.graph, root, proof).has(owner)).toBe(true);
    expect(proof.has(owner)).toBe(false);
    expect(findColdCockpitRuntimeVendors(f.graph)?.has(owner)).toBe(true);
    expect(createCockpitBootChunkSelector()(owner, f.graph)).toBeUndefined();
  },
);
it.each(optionalOverlayVendorSuffixes.flatMap((suffix) =>
  (["named-cold", "namespace-cold", "missing-ast", "bootstrap", "lazy-only"] as const).map((mode) => [suffix, mode] as const),
))(
  "keeps real import semantics automatic for overlay %s under %s graph proof",
  (suffix, mode) => {
    const f = coldRuntimeVendorFixture();
    const owner = f.owners.find((id) => id.endsWith(suffix))!;
    if (mode === "named-cold" || mode === "namespace-cold") {
      f.modules.get(root)!.ast = program([{
        type: "ImportDeclaration",
        source: literal(owner),
        specifiers: mode === "named-cold"
          ? [{ type: "ImportSpecifier", imported: identifier("coldVendor"), local: identifier("coldVendor") }]
          : [{ type: "ImportNamespaceSpecifier", local: identifier("overlay") }],
      }]);
    }
    if (mode === "missing-ast") delete f.modules.get(root)!.ast;
    if (mode === "bootstrap") f.modules.get(f.main)!.importedIds = [owner];
    if (mode === "lazy-only") f.modules.get(root)!.importedIds = f.owners.filter((id) => id !== owner);
    const proof = new Set<string>();
    const cold = collectCockpitBootBindings(f.graph, root, proof);
    expect(proof.has(owner)).toBe(mode === "named-cold");
    expect(cold.has(owner)).toBe(mode !== "lazy-only");
    expect(findColdCockpitRuntimeVendors(f.graph)?.has(owner) ?? false)
      .toBe(mode === "namespace-cold" || mode === "missing-ast");
    expect(createCockpitBootChunkSelector()(owner, f.graph)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(owner)).toBeUndefined();
  },
);

const optionalDelegationCommands = ["runChatDelegation", "runChatResearch", "streamChatDelegation", "suggestChatDelegation", "triggerChatProactive"] as const;
it.each(["dist/api/chat-optional-actions.js", "src/api/chat-optional-actions.ts"])("places only the exact optional delegation owner %s automatically", relative => {
  const owner = "C:/repo/packages/mission-control-shared/" + relative;
  expect(usesAutomaticCockpitPlacement(owner)).toBe(true);
  expect(usesAutomaticCockpitPlacement(owner.replaceAll("/", String.fromCharCode(92)))).toBe(true);
  expect(createCockpitBootChunkSelector()(owner)).toBeUndefined();
});
it.each([
  "C:/repo/packages/mission-control-shared/dist/api/chat.js",
  "C:/repo/packages/mission-control-shared/dist/api/client.js",
  "C:/repo/packages/mission-control-shared/dist/api/chat-optional-actions-extra.js",
  "C:/repo/packages/mission-control-shared/dist/api/chat-optional-actions.js.map",
  "C:/repo/packages/another-package/dist/api/chat-optional-actions.js",
])("retains exact optional API placement boundaries for %s", owner => {
  expect(usesAutomaticCockpitPlacement(owner)).toBe(false);
  expect(usesAutomaticCockpitPlacement(owner.replaceAll("/", String.fromCharCode(92)))).toBe(false);
});
function optionalDelegationFixture(requested = "fetchChatDelegationRun", metadata: "named" | "namespace" | "missing" = "named") {
  const prefix = "C:/repo/packages/mission-control-shared/dist/api/";
  const facade = prefix + "chat.js", optional = prefix + "chat-optional-actions.js", core = prefix + "client-core.js";
  const own = (name: string) => ({ type: "ExportNamedDeclaration", source: null, specifiers: [], declaration: { type: "FunctionDeclaration", id: identifier(name) } });
  const named = (source: string, name: string) => ({ type: "ImportDeclaration", source: literal(source), specifiers: [{ type: "ImportSpecifier", imported: identifier(name), local: identifier(name) }] });
  const modules = new Map<string, Info>([
    [root, { isIncluded: true, importedIds: [facade], ast: program([{ type: "ImportDeclaration", source: literal(facade), specifiers: [{ type: metadata === "namespace" ? "ImportNamespaceSpecifier" : "ImportSpecifier", imported: identifier(requested), local: identifier("api") }] }]) }],
    [facade, { isIncluded: true, importedIds: [core, optional], ast: program([named("./client-core.js", "request"), own("fetchChatDelegationRun"), { type: "ExportNamedDeclaration", source: literal("./chat-optional-actions.js"), specifiers: optionalDelegationCommands.map(name => ({ type: "ExportSpecifier", local: identifier(name), exported: identifier(name) })) }]) }],
    [optional, { isIncluded: true, importedIds: [core], ast: program([named("./client-core.js", "request"), ...optionalDelegationCommands.map(own)]) }],
    [core, { isIncluded: true, importedIds: [], ast: program([own("request")]) }],
  ]);
  if (metadata === "missing") delete modules.get(facade)!.ast;
  const graph: CockpitBootModuleGraph = { getModuleIds: () => modules.keys(), getModuleInfo: id => modules.get(id) ?? null };
  return { graph, facade, optional, core };
}
it("keeps mandatory delegation history and transport without an unused optional facade edge", () => {
  const f = optionalDelegationFixture(), proof = new Set<string>();
  expect(collectCockpitBootBindings(f.graph, root, proof)).toEqual(new Set([root, f.facade, f.core]));
  expect(proof.has(f.optional)).toBe(false);
  expect(createCockpitBootChunkSelector()(f.optional, f.graph)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(f.facade, f.graph)).toBe("cockpit-foundation");
});
it.each(optionalDelegationCommands)("records a real named cold binding to %s without forcing its placement", name => {
  const f = optionalDelegationFixture(name), proof = new Set<string>();
  expect(collectCockpitBootBindings(f.graph, root, proof)).toEqual(new Set([root, f.optional, f.core]));
  expect(proof.has(f.optional)).toBe(true);
  expect(createCockpitBootChunkSelector()(f.optional, f.graph)).toBeUndefined();
});
it.each(["namespace", "missing"] as const)("retains conservative inclusion without named proof for optional %s metadata", metadata => {
  const f = optionalDelegationFixture("fetchChatDelegationRun", metadata), proof = new Set<string>();
  expect(collectCockpitBootBindings(f.graph, root, proof)).toEqual(new Set([root, f.facade, f.optional, f.core]));
  expect(proof.has(f.optional)).toBe(false);
  expect(createCockpitBootChunkSelector()(f.optional, f.graph)).toBeUndefined();
});
