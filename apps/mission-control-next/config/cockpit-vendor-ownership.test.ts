import { expect, it } from "vitest";
import { createCockpitBootChunkSelector } from "../vite.config";
import { findLazyOnlyCockpitIcons, usesAutomaticCockpitPlacement, type CockpitBootModuleGraph } from "./cockpit-vendor-ownership";
const root = "C:/repo/src/cockpit-entry.tsx";
const consumer = "C:/repo/src/cockpit/app/CurrentNativeControl.tsx";
const lazyConsumer = "C:/repo/src/cockpit/app/LazyDestination.tsx";
const barrel = "C:/repo/node_modules/lucide-react/dist/esm/lucide-react.js";
const icon = (name: string) => "C:/repo/node_modules/lucide-react/dist/esm/icons/" + name + ".js";
const identifier = (name: string) => ({ type: "Identifier", name });
const literal = (value: string) => ({ type: "Literal", value });
const program = (body: unknown[]) => ({ type: "Program", body });
const imports = (names: string[]) => ({ type: "ImportDeclaration", source: literal("lucide-react"), specifiers: names.map(name => ({ type: "ImportSpecifier", imported: identifier(name), local: identifier(name) })) });
const installedNamespace = () => ({ type: "ImportDeclaration", source: literal("./icons/index.js"), specifiers: [{ type: "ImportNamespaceSpecifier", local: identifier("index") }] });
const namespaceExport = () => ({ type: "ExportNamedDeclaration", source: null, specifiers: [{ type: "ExportSpecifier", local: identifier("index"), exported: identifier("icons") }] });
const exported = (name: string, owner: string) => ({ type: "ExportNamedDeclaration", source: literal("./icons/" + owner + ".js"), specifiers: [{ type: "ExportSpecifier", local: identifier("default"), exported: identifier(name) }] });
type Info = NonNullable<ReturnType<CockpitBootModuleGraph["getModuleInfo"]>>;
function fixture(names = ["MoreHorizontal", "AlertTriangle", "XIcon", "FutureGlyph"]) {
  const modules = new Map<string, Info>([
    [root, { isIncluded: true, importedIds: [consumer], ast: program([]) }],
    [consumer, { isIncluded: true, importedIds: [barrel], ast: program([imports(names)]) }],
    [barrel, { isIncluded: false, importedIds: [icon("ellipsis"), icon("triangle-alert"), icon("x"), icon("new-glyph"), icon("cpu")], ast: program([installedNamespace(), namespaceExport(), exported("MoreHorizontal", "ellipsis"), exported("AlertTriangle", "triangle-alert"), exported("XIcon", "x"), exported("FutureGlyph", "new-glyph"), exported("Cpu", "cpu")]) }],
    [lazyConsumer, { isIncluded: true, importedIds: [barrel], ast: program([imports(["Cpu"])]) }],
  ]);
  for (const name of ["ellipsis", "triangle-alert", "x", "new-glyph", "cpu"]) modules.set(icon(name), { isIncluded: true, importedIds: [], ast: program([]) });
  const graph: CockpitBootModuleGraph = { getModuleIds: () => modules.keys(), getModuleInfo: id => modules.get(id) ?? null };
  return { modules, graph, boot: new Set([root, consumer, ...modules.get(barrel)!.importedIds]) };
}

it("keeps installed alias targets and new Native symbols without a hardcoded icon list", () => {
  const { graph, boot } = fixture();
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("cpu")]));
  const select = createCockpitBootChunkSelector();
  for (const name of ["ellipsis", "triangle-alert", "x", "new-glyph"]) expect(select(icon(name), graph)).toBe("cockpit-runtime");
  expect(select(icon("cpu"), graph)).toBeUndefined();
});

it("keeps a directly imported SVG subpath and excludes only globally included unused leaves", () => {
  const { modules, graph, boot } = fixture();
  modules.set(consumer, { isIncluded: true, importedIds: [barrel, icon("cpu")], ast: program([imports(["MoreHorizontal"]), { type: "ImportDeclaration", source: literal("lucide-react/dist/esm/icons/cpu.js"), specifiers: [{ type: "ImportDefaultSpecifier", local: identifier("Cpu") }] }]) });
  modules.get(icon("x"))!.isIncluded = false;
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("triangle-alert"), icon("new-glyph")]));
});

it("does not let a namespace import in a lazy destination change actual Native ownership", () => {
  const { modules, graph, boot } = fixture();
  modules.get(lazyConsumer)!.ast = program([{ type: "ImportDeclaration", source: literal("lucide-react"), specifiers: [{ type: "ImportNamespaceSpecifier", local: identifier("Icons") }] }]);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toEqual(new Set([icon("cpu")]));
});

it.each(["namespace", "default", "unknown-symbol", "unsupported-symbol", "missing-native-ast", "unsupported-native-ast", "missing-barrel-ast", "unsupported-export", "missing-export-owner", "conflicting-alias", "re-export"])("preserves existing icon ownership when %s metadata cannot prove exact imports", reason => {
  const { modules, graph, boot } = fixture();
  const native = modules.get(consumer)!, exports = modules.get(barrel)!;
  if (reason === "namespace" || reason === "default") native.ast = program([{ type: "ImportDeclaration", source: literal("lucide-react"), specifiers: [{ type: reason === "namespace" ? "ImportNamespaceSpecifier" : "ImportDefaultSpecifier", local: identifier("Icons") }] }]);
  if (reason === "unknown-symbol") native.ast = program([imports(["UnknownFutureExport"])]);
  if (reason === "unsupported-symbol") native.ast = program([{ type: "ImportDeclaration", source: literal("lucide-react"), specifiers: [{ type: "ImportSpecifier", imported: { type: "UnknownNode", name: "MoreHorizontal" } }] }]);
  if (reason === "missing-native-ast") delete native.ast;
  if (reason === "unsupported-native-ast") native.ast = { type: "Program", body: {} };
  if (reason === "missing-barrel-ast") delete exports.ast;
  if (reason === "unsupported-export") exports.ast = program([{ type: "ExportAllDeclaration", source: literal("./icons/ellipsis.js") }]);
  if (reason === "missing-export-owner") exports.ast = program([exported("MoreHorizontal", "missing")]);
  if (reason === "conflicting-alias") exports.ast = program([exported("MoreHorizontal", "ellipsis"), exported("MoreHorizontal", "cpu")]);
  if (reason === "re-export") native.ast = program([{ type: "ExportAllDeclaration", source: literal("lucide-react") }]);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(icon("cpu"), graph)).toBe("cockpit-runtime");
});

it("returns the conservative ownership fallback without a supported installed public barrel", () => {
  const { modules, graph, boot } = fixture(); modules.delete(barrel);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
});

it("accepts expected non-JavaScript stylesheet metadata without weakening unknown JS fallback", () => {
  const { modules, graph, boot } = fixture();
  const stylesheet = "C:/repo/src/cockpit/styles/chat.css?inline";
  modules.set(stylesheet, { isIncluded: true, importedIds: [] }); boot.add(stylesheet);
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
  const wrapper = { ...installedNamespace(), specifiers: [{ type: "ImportDefaultSpecifier", local: identifier("index") }] };
  modules.get(barrel)!.ast = program([wrapper, exported("MoreHorizontal", "ellipsis")]);
  expect(findLazyOnlyCockpitIcons(graph, boot)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(icon("cpu"), graph)).toBe("cockpit-runtime");
});

const measuredAutomaticOwners = [
  ...["ops-board", "hooks", "work-passport", "citadels", "openai-model-controls", "memory", "notifications", "chat-session-status"].map(name => "C:/repo/packages/contracts/dist/" + name + ".js"),
  ...["memory", "browser-sessions", "improvement", "cron", "channel-setup-operations", "capabilities-scope", "ops-quality", "engineering-learnings", "channel-oauth", "orchestration-recipes", "skill-hub", "diagnostics", "workflow-skill-capture", "provider-transport", "demo"].map(name => "C:/repo/packages/mission-control-shared/dist/api/" + name + ".js"),
  ...["FilterPillGroup", "ContextStrip", "NativeTable", "ErrorState", "KbdHint", "ThreePartChip", "NativeMetricGrid", "Notice"].map(name => "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/" + name + ".tsx"),
  "C:/repo/node_modules/@tanstack/query-core/build/modern/infiniteQueryObserver.js",
  "C:/repo/node_modules/@tanstack/react-query/build/modern/useInfiniteQuery.js",
  "C:/repo/node_modules/@radix-ui/react-visually-hidden/dist/index.mjs",
  "C:/repo/node_modules/use-sync-external-store/shim/index.js",
  "C:/repo/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js",
  "\0C:/repo/node_modules/use-sync-external-store/shim/index.js?commonjs-es-import",
  "\0C:/repo/node_modules/use-sync-external-store/shim/index.js?commonjs-module",
  "\0C:/repo/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js?commonjs-exports",
];

it.each(measuredAutomaticOwners)("leaves exact measured owner %s to actual Rollup imports across Windows and package versions", id => {
  expect(usesAutomaticCockpitPlacement(id)).toBe(true);
  expect(usesAutomaticCockpitPlacement(id.replaceAll("/", "\\"))).toBe(true);
  if (id.includes("/packages/") && id.includes("/dist/")) expect(usesAutomaticCockpitPlacement(id.replace("/dist/", "/src/").replace(/\.js$/, ".ts"))).toBe(true);
  if (id.includes("/node_modules/")) expect(usesAutomaticCockpitPlacement(id.replace("/node_modules/", "/node_modules/.pnpm/changed-version/node_modules/"))).toBe(true);
});

it.each([
  "C:/repo/packages/contracts/dist/session-control.js",
  "C:/repo/packages/contracts/dist/external-sources.js",
  "C:/repo/packages/contracts/dist/ops-board-new.js",
  "C:/repo/packages/mission-control-shared/dist/api/chat.js",
  "C:/repo/packages/mission-control-shared/dist/api/startup-reads.js",
  "C:/repo/packages/mission-control-shared/dist/api/memory-new.js",
  ...["NativeButton", "EmptyState", "StatusChip"].map(name => "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/" + name + ".tsx"),
  "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/NoticeAction.tsx",
  "C:/repo/apps/another-app/src/features/native-routes/primitives/ErrorState.tsx",
  "C:/repo/node_modules/@tanstack/query-core/build/modern/queryObserver.js",
  "C:/repo/node_modules/@tanstack/react-query/build/modern/useQuery.js",
  "C:/repo/node_modules/@tanstack/query-core/build/legacy/infiniteQueryObserver.js",
  "C:/repo/node_modules/@radix-ui/react-menu/dist/index.mjs",
  "C:/repo/node_modules/use-sync-external-store/shim/index.js?unknown-wrapper",
  "C:/repo/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js?commonjs-module",
])( "retains existing grouping for unknown or mandatory Native owner %s", id => {
  expect(usesAutomaticCockpitPlacement(id)).toBe(false);
  expect(usesAutomaticCockpitPlacement(id.replaceAll("/", "\\"))).toBe(false);
});
