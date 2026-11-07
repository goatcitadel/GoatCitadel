import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveMonacoAssetPath } from "./config/monaco-assets.js";
import {
  findLazyOnlyCockpitIcons,
  findColdCockpitRuntimeVendors,
  usesAutomaticCockpitPlacement,
  collectCockpitBootBindings,
  type CockpitBootModuleGraph,
} from "./config/cockpit-vendor-ownership.js";

// Vitest 4 trimmed the built-in `exclude` down to node_modules/.git only, so the
// compiled `dist/**/*.test.js` files this app emits would otherwise be collected and
// run alongside their `src` sources. Restore the vitest 3 build-output exclusions.
// Inlined (rather than importing the shared list) so vite.config stays inside this
// project's tsconfig and `vite build` does not reach across the workspace root.
const RESTORED_TEST_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/coverage/**",
  "**/build/**",
  "**/.{idea,cache,output,temp}/**",
];

// Inlined copy of `resolveLocalTestMaxWorkers` from the root vitest.shared.ts, for the
// same tsconfig reason: cap local fork workers so parallel sessions cannot page the
// machine; CI keeps vitest's default.
function resolveLocalTestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const override = Number.parseInt(env.GOATCITADEL_TEST_MAX_WORKERS ?? "", 10);
  if (Number.isInteger(override) && override > 0) {
    return override;
  }
  return env.CI ? undefined : 2;
}

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1", ".ts.net"];
export const DEV_OPTIMIZE_DEPS_ESBUILD_TARGET = "esnext";
const MONACO_PUBLIC_BASE = "/vendor/monaco/vs";
const MANAGED_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");

// `pnpm test` is the only script here that does not run `build:deps` first, so
// without this alias vitest resolves the shared package through its export map
// into `dist/`. A source export that has not been compiled yet then surfaces as a
// misleading "No <name> export is defined on the mock" failure from any
// `vi.mock` that spreads `importOriginal()`, pointing at the mock rather than at
// the stale build. Resolving to source keeps tests honest without making `test`
// depend on `build:deps`. Test-only: `vite dev` and `vite build` still go
// through the export maps, which `build:deps` refreshes.
//
// Only packages whose export map is subpath-faithful (`./x/y` -> `./dist/x/y.js`)
// belong here, so that `src/x/y` is the same module the map would have picked.
// `threaded-surface-core` is deliberately absent: it remaps subpaths
// (`./work-trust` -> `./dist/chat/work-trust.js`), so a source alias would
// silently resolve to a different file. The guard in vite.config.test.ts fails if
// an aliased package ever gains a remapping export.
export const WORKSPACE_SOURCE_PACKAGES = ["mission-control-shared"] as const;

/** Test-only vitest aliases mapping each WORKSPACE_SOURCE_PACKAGES import to that package's `src/`. */
export function buildWorkspaceSourceAliases(
  workspaceRoot: string = repoRoot,
): Array<{ find: RegExp; replacement: string }> {
  return WORKSPACE_SOURCE_PACKAGES.map((packageName) => ({
    find: new RegExp("^@goatcitadel/" + packageName + "(?:/(.*))?$"),
    replacement: path.resolve(workspaceRoot, "packages", packageName, "src").replaceAll("\\", "/") + "/$1",
  }));
}

const packageJson = JSON.parse(fs.readFileSync(path.resolve(configDir, "./package.json"), "utf8")) as {
  version?: string;
};
type StreamableResponse = NodeJS.WritableStream & {
  destroyed?: boolean;
  headersSent?: boolean;
  statusCode?: number;
  destroy(error?: Error): void;
};

function getContentType(filePath: string): string {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function streamMonacoAsset(res: StreamableResponse, assetPath: string): void {
  void pipeline(fs.createReadStream(assetPath), res).catch((error) => {
    if (res.destroyed) {
      return;
    }
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
      return;
    }
    res.destroy(error instanceof Error ? error : undefined);
  });
}

function copyDirectory(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function resolveMonacoVsDirectory(packageRoot: string): string {
  const candidateDirectories = [
    path.resolve(packageRoot, "node_modules/monaco-editor/min/vs"),
    path.resolve(packageRoot, "../../node_modules/monaco-editor/min/vs"),
  ];
  for (const candidate of candidateDirectories) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve Monaco AMD assets for ${packageRoot}.`);
}

function monacoAmdAssetsPlugin(packageRoot: string): Plugin {
  const sourceDir = resolveMonacoVsDirectory(packageRoot);
  let viteConfig: ResolvedConfig | null = null;

  return {
    name: "goatcitadel-monaco-amd-assets",
    configResolved(config) {
      viteConfig = config;
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = req.url?.split("?")[0] ?? "";
        if (!requestUrl.startsWith(`${MONACO_PUBLIC_BASE}/`)) {
          next();
          return;
        }

        const resolvedAssetPath = resolveMonacoAssetPath(sourceDir, requestUrl.slice(MONACO_PUBLIC_BASE.length));
        if (!resolvedAssetPath || !fs.existsSync(resolvedAssetPath) || !fs.statSync(resolvedAssetPath).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }

        res.setHeader("Content-Type", getContentType(resolvedAssetPath));
        streamMonacoAsset(res, resolvedAssetPath);
      });
    },
    writeBundle() {
      if (!viteConfig) {
        return;
      }
      const outputDir = path.resolve(viteConfig.root, viteConfig.build.outDir);
      const targetDir = path.join(outputDir, "vendor", "monaco", "vs");
      copyDirectory(sourceDir, targetDir);
    },
  };
}

export function buildManagedUiHealthPayload(env: Record<string, string | undefined> = process.env): {
  status: "ok";
  service: "mission-control";
  managedInstanceId?: string;
  managedProcessId?: number;
} {
  const instanceId = env.GOATCITADEL_MANAGED_INSTANCE_ID?.trim();
  return {
    status: "ok",
    service: "mission-control",
    ...(env.GOATCITADEL_MANAGED_SERVICE === "mission-control" &&
    instanceId &&
    MANAGED_INSTANCE_ID_PATTERN.test(instanceId)
      ? { managedInstanceId: instanceId, managedProcessId: process.pid }
      : {}),
  };
}

export function managedUiHealthPlugin(env: Record<string, string | undefined> = process.env): Plugin {
  const payload = buildManagedUiHealthPayload(env);
  return {
    name: "goatcitadel-managed-ui-health",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if ((req.url?.split("?", 1)[0] ?? "") !== "/health") {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
        res.end(JSON.stringify(payload));
      });
    },
  };
}

export function resolveViteAllowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.GOATCITADEL_VITE_ALLOWED_HOSTS?.trim();
  if (!raw) {
    return [...DEFAULT_ALLOWED_HOSTS];
  }
  const fromEnv = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...fromEnv])];
}

export function readDevResetId(command: string, rootDir: string = repoRoot): string {
  if (command !== "serve") return "";
  try {
    const resetId = fs.readFileSync(path.join(rootDir, "runtime/dev-reset-id"), "utf8").trim();
    return MANAGED_INSTANCE_ID_PATTERN.test(resetId) ? resetId : "";
  } catch {
    // A checkout that has never been cleared has no reset marker.
    return "";
  }
}

// These exact optional SDK leaves stay with their real public menu/popover
// importers. Actual Rollup imports still retain a future eager consumer.
const AUTOMATIC_COCKPIT_OVERLAY_SDK_SUFFIXES = [
  "/node_modules/@radix-ui/react-dialog/dist/index.mjs",
  "/node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs",
  "/node_modules/@radix-ui/react-focus-scope/dist/index.mjs",
  "/node_modules/@radix-ui/react-focus-guards/dist/index.mjs",
  "/node_modules/@radix-ui/react-dropdown-menu/dist/index.mjs",
  "/node_modules/@radix-ui/react-menu/dist/index.mjs",
  "/node_modules/@radix-ui/react-popover/dist/index.mjs",
  "/node_modules/@radix-ui/react-tooltip/dist/index.mjs",
  "/node_modules/@radix-ui/react-popper/dist/index.mjs",
  "/node_modules/@floating-ui/core/dist/floating-ui.core.mjs",
  "/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs",
  "/node_modules/@floating-ui/react-dom/dist/floating-ui.react-dom.mjs",
  "/node_modules/@floating-ui/utils/dist/floating-ui.utils.dom.mjs",
  "/node_modules/@floating-ui/utils/dist/floating-ui.utils.mjs",
  "/node_modules/vaul/dist/index.mjs",
] as const;

// Dialog scroll/focus helpers belong to the same on-demand overlay graph.
const AUTOMATIC_COCKPIT_DIALOG_SUPPORT =
  /\/node_modules\/(?:react-remove-scroll(?:-bar)?|aria-hidden|use-sidecar|use-callback-ref)\/dist\/es2015\/[^/]+\.js$/u;

const COCKPIT_APPROVAL_BODY_OWNER_SUFFIXES = [
  ["/apps/mission-control-next/src/cockpit/areas/chat/ChatApprovalRendererBody.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalDecisionBar.tsx"],
  [
    "/packages/mission-control-shared/dist/content/approval-generic-evidence.js",
    "/packages/mission-control-shared/src/content/approval-generic-evidence.ts",
  ],
  ["/apps/mission-control-next/src/cockpit/ui/evidence-scroll.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalSettlement.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/inbox-approval-attempts.ts"],
  [
    "/packages/mission-control-shared/dist/content/communications-approval-evidence.js",
    "/packages/mission-control-shared/src/content/communications-approval-evidence.ts",
  ],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/specialist-approval-evidence.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/SpecialistApprovalReview.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalReviewSummaryContent.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalAction.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/inbox-approval-guard.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/approval-settlement.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/approval-follow-on.ts"],
  ["/apps/mission-control-next/src/features/native-routes/ops/native-runtime-approval-evidence.ts"],
  [
    "/packages/mission-control-shared/dist/content/external-source-approval-evidence.js",
    "/packages/mission-control-shared/src/content/external-source-approval-evidence.ts",
  ],
] as const;

// Canonical execution payload authority keeps its placement independently of optional presentation code.
const COCKPIT_APPROVAL_AUTHORITY_OWNER_SUFFIXES = [
  "/packages/contracts/dist/durable-chat-turn-payload.js",
  "/packages/contracts/src/durable-chat-turn-payload.ts",
] as const;

// These owners render the settled receipt. The pending decision and tool body do not import them.
const COCKPIT_APPROVAL_SETTLEMENT_OWNER_SUFFIXES = [
  "/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalSettlement.tsx",
  "/apps/mission-control-next/src/cockpit/areas/inbox/approval-follow-on.ts",
  "/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalChangePlanOutcome.tsx",
  ...COCKPIT_APPROVAL_AUTHORITY_OWNER_SUFFIXES,
] as const;

// These exact first-use tool/approval owners otherwise emit nine separate demand requests.
// Keep the existing approval group as fallback when this larger optional boundary is unproved.
const COCKPIT_CHAT_DEMAND_OWNER_SUFFIXES = [
  ["/apps/mission-control-next/src/cockpit/areas/chat/code-mode-request-copy.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/ChatToolApprovalLine.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/approval-settlement.ts"],
  ["/apps/mission-control-next/src/cockpit/ui/RecordedErrorDetails.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/approval-actor.ts"],
  [
    "/packages/mission-control-shared/dist/components/chat/chat-tool-diff.js",
    "/packages/mission-control-shared/src/components/chat/chat-tool-diff.ts",
  ],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/SpecialistApprovalReview.tsx"],
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

// A separately proved shared async closure. Its clock and attempt locks retain one ESM identity.
// Library, Work, Settings and Classic also consume these owners; destination costs need measurement.
const COCKPIT_APPROVAL_RESIDUAL_OWNER_SUFFIXES = [
  [
    "/packages/mission-control-shared/dist/content/approval-generic-evidence.js",
    "/packages/mission-control-shared/src/content/approval-generic-evidence.ts",
  ],
  [
    "/packages/mission-control-shared/dist/content/external-source-approval-evidence.js",
    "/packages/mission-control-shared/src/content/external-source-approval-evidence.ts",
  ],
  [
    "/packages/mission-control-shared/dist/content/communications-approval-evidence.js",
    "/packages/mission-control-shared/src/content/communications-approval-evidence.ts",
  ],
  [
    "/packages/mission-control-shared/dist/content/skill-state-approval-evidence.js",
    "/packages/mission-control-shared/src/content/skill-state-approval-evidence.ts",
  ],
  [
    "/packages/mission-control-shared/dist/content/code-mode-request-input.js",
    "/packages/mission-control-shared/src/content/code-mode-request-input.ts",
  ],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/inbox-approval-attempts.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/inbox-approval-guard.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/use-minute-clock.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/ApprovalReviewSummaryContent.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/specialist-approval-key.ts"],
  ["/apps/mission-control-next/src/cockpit/areas/inbox/use-approval-review-evidence.ts"],
  ["/apps/mission-control-next/src/cockpit/ui/evidence-scroll.ts"],
  ["/apps/mission-control-next/src/cockpit/ui/TypedConfirmation.tsx"],
  ["/apps/mission-control-next/src/cockpit/areas/chat/RiskApprovalAction.tsx"],
] as const;

/** Group retained static Cockpit dependencies; dynamic destinations keep their own chunks. */
export function createCockpitBootChunkSelector() {
  let coldRuntimeVendors: Set<string> | null | undefined;
  let bootModules: Set<string> | undefined;
  let namedBootBindings: Set<string> | undefined;
  let lazyOnlyIcons: Set<string> | undefined;
  let lazyApprovalBodyModules: Set<string> | undefined;
  let lazyChatDemandModules: Set<string> | undefined;
  let lazyApprovalResidualModules: Set<string> | undefined;
  return (id: string, graph?: CockpitBootModuleGraph): string | undefined => {
    const normalizedId = id.replaceAll("\\", "/");
    // A pending generic approval must not preload kind-specific evidence or specialist renderers.
    const kindSpecificApprovalOwner =
      /\/packages\/mission-control-shared\/(?:dist|src)\/content\/(?:approval-purpose-evidence|external-source-approval-evidence|communications-approval-evidence|skill-state-approval-evidence|code-mode-request-input)\.[jt]s$/u.test(normalizedId) ||
      /\/apps\/mission-control-next\/src\/(?:cockpit\/areas\/inbox\/(?:SpecialistApprovalReview\.tsx|specialist-approval-evidence\.ts)|features\/native-routes\/ops\/native-runtime-approval-evidence\.ts)$/u.test(normalizedId);
    // Cache both success and failure before existing automatic placement rules.
    if (graph && coldRuntimeVendors === undefined) coldRuntimeVendors = findColdCockpitRuntimeVendors(graph);
    // Exact optional overlay owners stay automatic even when a discarded umbrella
    // makes the legacy cold-vendor grouping reachable. Real imports still load them.
    if (
      AUTOMATIC_COCKPIT_OVERLAY_SDK_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix)) ||
      AUTOMATIC_COCKPIT_DIALOG_SUPPORT.test(normalizedId)
    )
      return undefined;
    // The idle operator projection is eager. Full session-control validation and
    // its Zod runtime follow their actual imports, even when a barrel reaches them.
    if (
      normalizedId.includes("/node_modules/zod/v4/") ||
      normalizedId.includes("/node_modules/@noble/hashes/") ||
      /\/packages\/contracts\/(?:dist|src)\/(?:session-control|run-variables|sha256)\.[jt]s$/u.test(normalizedId)
    )
      return undefined;
    if (coldRuntimeVendors?.has(id)) return "cockpit-runtime";
    // A discarded contract barrel can reach modules retained only by lazy destinations.
    // Let Rollup place those modules; actual imports still preserve their validation.
    if (
      /\/packages\/contracts\/(?:dist|src)\/(?:remote-worker-[^/]+|secret-redaction|channel-sanitizer|durable-child-watcher-bounds|change-plan|external-sources)\.[jt]s$/.test(
        normalizedId,
      )
    )
      return undefined;
    // These primitives belong to Gallery, Library, Settings and Capabilities; actual imports still determine loading.
    // Switch reaches boot only through the radix-ui barrel; in cockpit-runtime its automatic react-use-size leaf
    // would import React back from cockpit-runtime and form a chunk cycle that blanks the production build.
    if (/\/node_modules\/@radix-ui\/react-(?:tooltip|tabs|switch)\//.test(normalizedId)) return undefined;
    // Library transport stays at its actual destination; the eager Chat leaf remains grouped.
    if (/\/packages\/mission-control-shared\/(?:dist|src)\/api\/external-sources\.[jt]s$/.test(normalizedId))
      return undefined;
    // Actual cold capability value owners share the existing foundation.
    // Globally retained destination-only siblings still use automatic placement.
    const boundCapabilityOwner =
      /\/packages\/mission-control-shared\/(?:dist|src)\/api\/capabilities-(?:operations|query)\.[jt]s$/u.test(
        normalizedId,
      );
    // Only fully resolved cold memory reads share foundation; destination and ambiguous ownership stay automatic.
    const boundMemoryOwner = /\/packages\/mission-control-shared\/(?:dist|src)\/api\/memory\.[jt]s$/u.test(
      normalizedId,
    );
    // Only these exact approval owners may reach the existing all-or-none lazy graph guard.
    // A genuine boot binding still receives ordinary boot ownership.
    const knownApprovalOwner =
      COCKPIT_APPROVAL_BODY_OWNER_SUFFIXES.some((suffixes) =>
        suffixes.some((suffix) => normalizedId.endsWith(suffix)),
      ) || COCKPIT_APPROVAL_AUTHORITY_OWNER_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix));
    if (usesAutomaticCockpitPlacement(id) && !boundCapabilityOwner && !boundMemoryOwner && !knownApprovalOwner)
      return undefined;
    if (graph) {
      if (!bootModules) {
        bootModules = new Set<string>();
        namedBootBindings = new Set<string>();
        const initialModules = new Set<string>();
        const roots = [...graph.getModuleIds()];
        const visit = (moduleId: string, target: Set<string>, seen: Set<string>, retainedOnly: boolean) => {
          if (seen.has(moduleId)) return;
          seen.add(moduleId);
          const info = graph.getModuleInfo(moduleId);
          if (!info) return;
          if (!retainedOnly || info.isIncluded) target.add(moduleId);
          for (const dependency of info.importedIds) visit(dependency, target, seen, retainedOnly);
        };
        for (const moduleId of roots) {
          const normalized = moduleId.replaceAll("\\", "/");
          if (normalized.endsWith("/src/main.tsx")) visit(moduleId, initialModules, new Set(), false);
          if (normalized.endsWith("/src/cockpit-entry.tsx"))
            for (const owner of collectCockpitBootBindings(graph, moduleId, namedBootBindings)) bootModules.add(owner);
        }
        // Shared preference/reset helpers must not make main.tsx initialize a shell before storage reset.
        for (const moduleId of initialModules) bootModules.delete(moduleId);
        lazyOnlyIcons = findLazyOnlyCockpitIcons(graph, bootModules);
        // Consolidate only this known lazy code boundary, never a boot dependency.
        const approvalOwners = COCKPIT_APPROVAL_BODY_OWNER_SUFFIXES.map((suffixes) =>
          roots.filter((moduleId) => suffixes.some((suffix) => moduleId.replaceAll("\\", "/").endsWith(suffix))),
        );
        if (approvalOwners.every((owners) => owners.length === 1)) {
          const knownLazyOwners = approvalOwners.flat();
          if (
            knownLazyOwners.every((moduleId) => {
              const info = graph.getModuleInfo(moduleId);
              const ast = info?.ast as { type?: unknown; body?: unknown } | undefined;
              return (
                info?.isIncluded !== null &&
                info?.isIncluded !== undefined &&
                (!usesAutomaticCockpitPlacement(moduleId) || info.isIncluded === true) &&
                ast?.type === "Program" &&
                Array.isArray(ast.body) &&
                !bootModules!.has(moduleId)
              );
            })
          )
            lazyApprovalBodyModules = new Set(knownLazyOwners);
        }
        // Prove every observed demand owner together; uncertain metadata keeps all prior placement rules.
        const demandOwners = COCKPIT_CHAT_DEMAND_OWNER_SUFFIXES.map((suffixes) =>
          roots.filter((moduleId) => suffixes.some((suffix) => moduleId.replaceAll("\\", "/").endsWith(suffix))),
        );
        if (demandOwners.every((owners) => owners.length === 1)) {
          const knownDemandOwners = demandOwners.flat();
          if (
            knownDemandOwners.every((moduleId) => {
              const normalized = moduleId.replaceAll("\\", "/");
              const info = graph.getModuleInfo(moduleId);
              const ast = info?.ast as { type?: unknown; body?: unknown } | undefined;
              const emptyBarrel = normalized.endsWith(
                "/apps/mission-control-next/src/cockpit/areas/chat/ChatApprovalRendererBody.ts",
              );
              const authority = COCKPIT_APPROVAL_AUTHORITY_OWNER_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
              return (
                (info?.isIncluded === true || (emptyBarrel && info?.isIncluded === false)) &&
                ast?.type === "Program" &&
                Array.isArray(ast.body) &&
                !namedBootBindings!.has(moduleId) &&
                !initialModules.has(moduleId) &&
                (!bootModules!.has(moduleId) || authority)
              );
            })
          )
            lazyChatDemandModules = new Set(knownDemandOwners);
        }
        // An incomplete or cold residual owner never weakens either existing group.
        if (lazyChatDemandModules) {
          const residualOwners = COCKPIT_APPROVAL_RESIDUAL_OWNER_SUFFIXES.map((suffixes) =>
            roots.filter((moduleId) => suffixes.some((suffix) => moduleId.replaceAll("\\", "/").endsWith(suffix))),
          );
          if (residualOwners.every((owners) => owners.length === 1)) {
            const knownResidualOwners = residualOwners.flat();
            if (
              knownResidualOwners.every((moduleId) => {
                const info = graph.getModuleInfo(moduleId);
                const ast = info?.ast as { type?: unknown; body?: unknown } | undefined;
                return (
                  info?.isIncluded === true &&
                  ast?.type === "Program" &&
                  Array.isArray(ast.body) &&
                  !bootModules!.has(moduleId) &&
                  !namedBootBindings!.has(moduleId) &&
                  !initialModules.has(moduleId)
                );
              })
            )
              lazyApprovalResidualModules = new Set(knownResidualOwners);
          }
        }
      }
      if (kindSpecificApprovalOwner && !namedBootBindings?.has(id)) return undefined;
      // Pending approval summaries use the shared workspace labels on first render.
      // Keep the small shared hook outside the approval chunk used by other destinations.
      if (
        lazyApprovalResidualModules &&
        normalizedId.endsWith("/apps/mission-control-next/src/cockpit/data/use-workspace-name.ts") &&
        graph.getModuleInfo(id)?.isIncluded === true
      )
        return "cockpit-entry";
      if (lazyApprovalResidualModules?.has(id) || lazyChatDemandModules?.has(id) || lazyApprovalBodyModules?.has(id)) {
        return COCKPIT_APPROVAL_SETTLEMENT_OWNER_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix))
          ? "ChatApprovalRendererSettlement"
          : "ChatApprovalRendererBody";
      }
      // Conservative barrel reachability cannot override an existing automatic owner.
      // Only a fully resolved included value binding proves ordinary cold ownership.
      if (knownApprovalOwner && usesAutomaticCockpitPlacement(id) && !namedBootBindings?.has(id)) return undefined;
      if (boundMemoryOwner && !namedBootBindings?.has(id)) return undefined;
      // Schema and helper exports used by lazy destinations can remain reachable
      // behind a discarded contracts barrel. Actual imports keep their automatic
      // placement unless a named cold binding proves ordinary boot ownership.
      if (
        /\/packages\/contracts\/(?:dist|src)\/(?:config-schemas|chat-feature-references|plugins|browser-errand-approval-conversation|capability-connectors|capability-plugins|change-plan-feature-flag-labels|channel-access|channel-address-host|google-workspace|mcp|operator-write-access|personal-ops|public-web-address|skill-categories|skill-packs|web-search)\.[jt]s$/u.test(
          normalizedId,
        ) &&
        !namedBootBindings?.has(id)
      )
        return undefined;
      if (lazyOnlyIcons?.has(id)) return undefined;
      if (bootModules.has(id)) {
        const normalized = id.replaceAll("\\", "/");
        // Keep the existing per-chunk cap; partition along the current one-way ownership dependencies.
        if (normalized.includes("/node_modules/") || id.startsWith("\0")) return "cockpit-runtime";
        if (normalized.includes("/packages/threaded-surface-core/")) return "cockpit-foundation";
        if (normalized.includes("/packages/")) return "cockpit-foundation";
        return "cockpit-entry";
      }
    }
    if (boundCapabilityOwner || boundMemoryOwner) return undefined;
    const normalized = id.replaceAll("\\", "/");
    if (!normalized.includes("/node_modules/")) {
      return undefined;
    }
    if (normalized.includes("/node_modules/react-dom/") || normalized.includes("/node_modules/react/")) {
      return "vendor-react";
    }
    if (normalized.includes("/node_modules/@radix-ui/")) {
      return "vendor-radix";
    }
    if (normalized.includes("/node_modules/@react-three/")) {
      return "vendor-r3f";
    }
    if (normalized.includes("/node_modules/three/")) {
      return "vendor-three";
    }
    if (normalized.includes("/node_modules/@assistant-ui/")) {
      return "vendor-assistant-ui";
    }
    if (normalized.includes("/node_modules/react-markdown/") || normalized.includes("/node_modules/remark-gfm/")) {
      return "vendor-markdown";
    }
    return undefined;
  };
}

/** Co-locate the eager application bindings while keeping the runtime dependency direction. */
export function createCockpitOutputChunkSelector() {
  const selectOwner = createCockpitBootChunkSelector();
  return (id: string, graph?: CockpitBootModuleGraph): string | undefined => {
    const owner = selectOwner(id, graph);
    if (owner !== "cockpit-foundation") return owner;
    return id.replaceAll("\\", "/").includes("/packages/contracts/") ? "cockpit-runtime" : "cockpit-entry";
  };
}

export default defineConfig(({ mode, command }) => {
  const env = {
    ...process.env,
    ...loadEnv(mode, repoRoot, ""),
  };
  const buildId = `${packageJson.version ?? "dev"}-${mode}`;

  return {
    envDir: repoRoot,
    define: {
      __GC_BUILD_ID__: JSON.stringify(buildId),
      __GC_DEV_RESET_ID__: JSON.stringify(mode === "test" ? "" : readDevResetId(command)),
    },
    // Managed ownership is a per-process launch identity. Do not let a repo
    // .env file replace the environment injected into this Vite process.
    plugins: [
      managedUiHealthPlugin(process.env),
      monacoAmdAssetsPlugin(configDir),
      tailwindcss(),
      react(),
    ],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        {
          find: "@next",
          replacement: path.resolve(configDir, "./src"),
        },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      allowedHosts: resolveViteAllowedHosts(env),
      hmr: {
        overlay: false,
      },
    },
    optimizeDeps: {
      esbuildOptions: {
        target: DEV_OPTIMIZE_DEPS_ESBUILD_TARGET,
      },
    },
    build: {
      target: ["chrome120", "edge120", "firefox120", "safari17"],
      minify: "terser",
      terserOptions: {
        maxWorkers: 2,
        compress: { passes: 2 },
      },
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          onlyExplicitManualChunks: true,
          manualChunks: createCockpitOutputChunkSelector(),
        },
      },
    },
    test: {
      alias: buildWorkspaceSourceAliases(),
      exclude: RESTORED_TEST_EXCLUDE,
      maxWorkers: resolveLocalTestMaxWorkers(),
      setupFiles: "./src/test/setup.ts",
      testTimeout: 20000,
    },
  };
});
