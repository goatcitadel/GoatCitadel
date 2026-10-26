import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import viteConfig, {
  createCockpitBootChunkSelector,
  buildManagedUiHealthPayload,
  buildWorkspaceSourceAliases,
  WORKSPACE_SOURCE_PACKAGES,
  DEV_OPTIMIZE_DEPS_ESBUILD_TARGET,
  managedUiHealthPlugin,
  resolveViteAllowedHosts,
  readDevResetId,
} from "./vite.config";

describe("mission-control-next vite config", () => {
  it("supplies reset IDs only to the dev server, and ignores missing or malformed markers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-dev-reset-"));
    try {
      expect(readDevResetId("serve", root)).toBe("");
      fs.mkdirSync(path.join(root, "runtime"));
      const marker = path.join(root, "runtime/dev-reset-id");
      fs.writeFileSync(marker, "a2680ff0-cd94-4113-8aa1-cdb075e6e596\r\n");
      expect(readDevResetId("serve", root)).toBe("a2680ff0-cd94-4113-8aa1-cdb075e6e596");
      expect(readDevResetId("build", root)).toBe("");
      fs.writeFileSync(marker, "not a reset ID");
      expect(readDevResetId("serve", root)).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the dev dependency optimizer on a modern target", async () => {
    const config =
      typeof viteConfig === "function"
        ? await viteConfig({ command: "serve", mode: "development", isPreview: false, isSsrBuild: false })
        : await viteConfig;

    expect(DEV_OPTIMIZE_DEPS_ESBUILD_TARGET).toBe("esnext");
    expect(config.optimizeDeps?.esbuildOptions?.target).toBe(DEV_OPTIMIZE_DEPS_ESBUILD_TARGET);
  });

  it("resolves the shared package to source so tests never read a stale dist", async () => {
    const config =
      typeof viteConfig === "function"
        ? await viteConfig({ command: "serve", mode: "test", isPreview: false, isSsrBuild: false })
        : await viteConfig;

    const aliases = config.test?.alias as Array<{ find: RegExp; replacement: string }> | undefined;
    expect(aliases).toEqual(buildWorkspaceSourceAliases());

    const fakeRoot = path.resolve("/repo");
    const [shared] = buildWorkspaceSourceAliases(fakeRoot);
    const sharedSrc = `${path.resolve(fakeRoot, "packages/mission-control-shared/src").replaceAll("\\", "/")}`;
    expect(
      "@goatcitadel/mission-control-shared/content/approval-helpers".replace(shared.find, shared.replacement),
    ).toBe(`${sharedSrc}/content/approval-helpers`);
    expect("@goatcitadel/mission-control-shared".replace(shared.find, shared.replacement)).toBe(`${sharedSrc}/`);
    // A package that remaps subpaths must not be aliased: src/<subpath> would be a
    // different module than the export map picks. threaded-surface-core is one.
    expect(WORKSPACE_SOURCE_PACKAGES).not.toContain("threaded-surface-core");
  });

  it("keeps every aliased package's export map subpath-faithful", () => {
    const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    for (const packageName of WORKSPACE_SOURCE_PACKAGES) {
      const manifest = JSON.parse(
        fs.readFileSync(path.resolve(workspaceRoot, "packages", packageName, "package.json"), "utf8"),
      ) as { exports: Record<string, string | { default: string }> };

      for (const [subpath, target] of Object.entries(manifest.exports)) {
        const resolved = typeof target === "string" ? target : target.default;
        const bare = subpath === "." ? "index" : subpath.replace(/^[.][/]/, "");
        expect([`./dist/${bare}.js`, `./dist/${bare}/index.js`]).toContain(resolved);
      }
    }
  });

  it("keeps default loopback and tailnet allowed hosts", () => {
    expect(resolveViteAllowedHosts({})).toEqual(["localhost", "127.0.0.1", "::1", ".ts.net"]);
    expect(resolveViteAllowedHosts({ GOATCITADEL_VITE_ALLOWED_HOSTS: "dev.example.test, localhost" })).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      ".ts.net",
      "dev.example.test",
    ]);
  });

  it("serves an exact managed Mission Control identity from the source UI health route", () => {
    const instanceId = "123e4567-e89b-42d3-a456-426614174000";
    const env = {
      GOATCITADEL_MANAGED_INSTANCE_ID: instanceId,
      GOATCITADEL_MANAGED_SERVICE: "mission-control",
    };
    expect(buildManagedUiHealthPayload(env)).toEqual({
      status: "ok",
      service: "mission-control",
      managedInstanceId: instanceId,
      managedProcessId: process.pid,
    });
    expect(buildManagedUiHealthPayload({ ...env, GOATCITADEL_MANAGED_SERVICE: "gateway" })).toEqual({
      status: "ok",
      service: "mission-control",
    });

    type Middleware = (
      request: { url?: string },
      response: {
        statusCode: number;
        setHeader(name: string, value: string): void;
        end(value?: string): void;
      },
      next: () => void,
    ) => void;
    let middleware: Middleware | undefined;
    const server = {
      middlewares: {
        use(handler: Middleware) {
          middleware = handler;
        },
      },
    };
    const configureServer = managedUiHealthPlugin(env).configureServer;
    expect(typeof configureServer).toBe("function");
    (configureServer as (value: typeof server) => void)(server);

    const headers = new Map<string, string>();
    let body = "";
    const next = vi.fn();
    expect(middleware).toBeTypeOf("function");
    middleware?.(
      { url: "/health?launcher=1" },
      {
        statusCode: 0,
        setHeader(name, value) {
          headers.set(name, value);
        },
        end(value) {
          body = value ?? "";
        },
      },
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(headers.get("Cache-Control")).toContain("no-store");
    expect(JSON.parse(body)).toEqual({
      status: "ok",
      service: "mission-control",
      managedInstanceId: instanceId,
      managedProcessId: process.pid,
    });
  });

  it("uses two safe Terser passes with the existing production browser targets", async () => {
    const config =
      typeof viteConfig === "function"
        ? await viteConfig({ command: "build", mode: "production", isPreview: false, isSsrBuild: false })
        : await viteConfig;

    expect(config.build?.target).toEqual(["chrome120", "edge120", "firefox120", "safari17"]);
    expect(config.build?.minify).toBe("terser");
    // Keep Vite's module, Safari, source-map and identifier-mangling defaults.
    // An exact options assertion also rejects unsafe compression/property mangling.
    expect(config.build?.terserOptions).toStrictEqual({ compress: { passes: 2 } });
    expect(config.build?.chunkSizeWarningLimit).toBe(900);
  });

  it("pins the measured minifier as an app build dependency", () => {
    const configDir = path.dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(fs.readFileSync(path.join(configDir, "package.json"), "utf8"));

    expect(packageJson.devDependencies.terser).toBe("5.51.2");
    expect(packageJson.dependencies).not.toHaveProperty("terser");
  });

  it("splits assistant-ui and markdown renderer dependencies into focused lazy chunks", async () => {
    const config =
      typeof viteConfig === "function"
        ? await viteConfig({ command: "build", mode: "production", isPreview: false, isSsrBuild: false })
        : await viteConfig;
    const output = config.build?.rollupOptions?.output;
    const manualChunks = (Array.isArray(output) ? output[0] : output)?.manualChunks;

    expect(typeof manualChunks).toBe("function");
    expect(
      (manualChunks as (id: string) => string | undefined)("C:/repo/node_modules/@assistant-ui/react/index.js"),
    ).toBe("vendor-assistant-ui");
    expect((manualChunks as (id: string) => string | undefined)("C:/repo/node_modules/react-markdown/index.js")).toBe(
      "vendor-markdown",
    );
    expect((manualChunks as (id: string) => string | undefined)("C:/repo/node_modules/remark-gfm/index.js")).toBe(
      "vendor-markdown",
    );
  });
});

it("groups retained static Cockpit modules without assigning dynamic destinations or discarded barrels", () => {
  const modules = new Map([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["bridge", "barrel", "shared-preference"] }],
    ["C:/repo/src/main.tsx", { isIncluded: true, importedIds: ["shared-preference"] }],
    ["shared-preference", { isIncluded: true, importedIds: [] }],
    ["bridge", { isIncluded: true, importedIds: ["react"] }],
    ["react", { isIncluded: true, importedIds: ["bridge"] }],
    ["barrel", { isIncluded: false, importedIds: ["leaf"] }],
    ["leaf", { isIncluded: true, importedIds: [] }],
    ["optional-workbench", { isIncluded: true, importedIds: [] }],
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  expect(select("bridge", graph)).toBe("cockpit-entry");
  expect(select("react", graph)).toBe("cockpit-entry");
  expect(select("leaf", graph)).toBe("cockpit-entry");
  expect(select("barrel", graph)).toBeUndefined();
  expect(select("shared-preference", graph)).toBeUndefined();
  expect(select("C:/repo/src/main.tsx", graph)).toBeUndefined();
  expect(select("optional-workbench", graph)).toBeUndefined();
  expect(createCockpitBootChunkSelector()("optional-workbench", graph)).toBeUndefined();
});

it.each([
  "remote-worker-ops",
  "remote-worker-runtime-read",
  "remote-worker-inference",
  "secret-redaction",
  "channel-sanitizer",
  "durable-child-watcher-bounds",
  "change-plan",
])("keeps %s at its actual lazy destination despite a discarded contract barrel", (name) => {
  const optional = "C:/repo/packages/contracts/dist/" + name + ".js";
  const required = "C:/repo/packages/contracts/dist/session-control.js";
  const modules = new Map([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["barrel"] }],
    ["barrel", { isIncluded: false, importedIds: [optional, required] }],
    [optional, { isIncluded: true, importedIds: [] }],
    [required, { isIncluded: true, importedIds: [] }],
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  expect(select(optional, graph)).toBeUndefined();
  expect(select(required, graph)).toBe("cockpit-foundation");
  expect(select(optional.replaceAll("/", "\\"), graph)).toBeUndefined();
});

it.each(["tooltip", "tabs", "switch"])(
  "leaves lazy-only Radix %s placement to actual imports and keeps mandatory native Dialog ownership",
  (name) => {
    const optional = "C:/repo/node_modules/@radix-ui/react-" + name + "/dist/index.mjs";
    const dialog = "C:/repo/node_modules/@radix-ui/react-dialog/dist/index.mjs";
    const modules = new Map([
      ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["radix-barrel"] }],
      ["radix-barrel", { isIncluded: false, importedIds: [optional, dialog] }],
      [optional, { isIncluded: true, importedIds: [] }],
      [dialog, { isIncluded: true, importedIds: [] }],
    ]);
    const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
    const select = createCockpitBootChunkSelector();
    expect(select(optional, graph)).toBeUndefined();
    expect(select(optional.replaceAll("/", "\\"), graph)).toBeUndefined();
    expect(select(dialog, graph)).toBe("cockpit-runtime");
    expect(createCockpitBootChunkSelector()(optional)).toBeUndefined();
  },
);

it("leaves confirmed destination owners to Rollup while keeping mandatory Native controls and regular queries grouped", () => {
  const prefix = "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/";
  const automatic = [
    "C:/repo/packages/contracts/dist/ops-board.js",
    "C:/repo/packages/mission-control-shared/dist/api/memory.js",
    prefix + "ErrorState.tsx",
    "C:/repo/node_modules/@tanstack/query-core/build/modern/infiniteQueryObserver.js",
  ];
  const mandatory = [
    prefix + "NativeButton.tsx",
    prefix + "EmptyState.tsx",
    prefix + "StatusChip.tsx",
    "C:/repo/node_modules/@tanstack/react-query/build/modern/useQuery.js",
    "C:/repo/node_modules/@tanstack/query-core/build/modern/queryObserver.js",
  ];
  const modules = new Map<string, { isIncluded: boolean; importedIds: string[] }>([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["discarded-barrel"] }],
    ["discarded-barrel", { isIncluded: false, importedIds: [...automatic, ...mandatory] }],
    ...[...automatic, ...mandatory].map(
      (id) => [id, { isIncluded: true, importedIds: [] }] as [string, { isIncluded: boolean; importedIds: string[] }],
    ),
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  for (const id of automatic) {
    expect(select(id, graph)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(id)).toBeUndefined();
  }
  for (const id of mandatory)
    expect(select(id, graph)).toBe(id.includes("/node_modules/") ? "cockpit-runtime" : "cockpit-entry");
});

it.each(["src", "dist"])(
  "keeps optional external-source owners at their destination and mandatory %s Chat validation grouped",
  (directory) => {
    const prefix = "C:/repo/packages/";
    const optional = [
      prefix + "contracts/" + directory + "/external-sources.js",
      prefix + "mission-control-shared/" + directory + "/api/external-sources.js",
    ];
    const mandatory = [
      prefix + "contracts/" + directory + "/external-source-chat.js",
      prefix + "contracts/" + directory + "/external-source-validation.js",
      prefix + "mission-control-shared/" + directory + "/api/external-source-chat.js",
    ];
    const modules = new Map<string, { isIncluded: boolean; importedIds: string[] }>([
      ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["discarded-barrel", ...mandatory] }],
      ["discarded-barrel", { isIncluded: false, importedIds: optional }],
      ...[...optional, ...mandatory].map(
        (id) => [id, { isIncluded: true, importedIds: [] }] as [string, { isIncluded: boolean; importedIds: string[] }],
      ),
    ]);
    const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
    const select = createCockpitBootChunkSelector();
    for (const id of optional) {
      expect(select(id, graph)).toBeUndefined();
      expect(select(id.replaceAll("/", "\\"), graph)).toBeUndefined();
    }
    for (const id of mandatory) expect(select(id, graph)).toBe("cockpit-foundation");
  },
);

it("automatically places only the exact optional menu/popover SDK leaves and keeps mandatory SDK owners grouped", () => {
  const suffixes = [
    "/node_modules/@radix-ui/react-dropdown-menu/dist/index.mjs",
    "/node_modules/@radix-ui/react-menu/dist/index.mjs",
    "/node_modules/@radix-ui/react-popover/dist/index.mjs",
    "/node_modules/@radix-ui/react-popper/dist/index.mjs",
    "/node_modules/@floating-ui/core/dist/floating-ui.core.mjs",
    "/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs",
    "/node_modules/@floating-ui/react-dom/dist/floating-ui.react-dom.mjs",
    "/node_modules/@floating-ui/utils/dist/floating-ui.utils.dom.mjs",
    "/node_modules/@floating-ui/utils/dist/floating-ui.utils.mjs",
  ];
  const optional = suffixes.map((suffix) => "C:/repo" + suffix);
  const mandatory = [
    "C:/repo/node_modules/@radix-ui/react-dialog/dist/index.mjs",
    "C:/repo/node_modules/@radix-ui/react-slot/dist/index.mjs",
    "C:/repo/node_modules/@radix-ui/react-focus-scope/dist/index.mjs",
    "C:/repo/node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs",
    "C:/repo/node_modules/react-dom/client.js",
  ];
  const unrecognized = [
    "C:/repo/node_modules/@radix-ui/react-menu/dist/index.js",
    "C:/repo/node_modules/@radix-ui/react-menu/dist/other.mjs",
    "C:/repo/node_modules/@floating-ui/unknown/dist/index.mjs",
    "C:/repo/node_modules/@floating-ui/utils/dist/floating-ui.utils.extra.mjs",
    "C:/repo/node_modules/@radix-ui/react-menu-custom/dist/index.mjs",
  ];
  const modules = new Map<string, { isIncluded: boolean; importedIds: string[] }>([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["discarded-radix-barrel"] }],
    ["discarded-radix-barrel", { isIncluded: false, importedIds: [...optional, ...mandatory, ...unrecognized] }],
    ...[...optional, ...mandatory, ...unrecognized].map(
      (id) => [id, { isIncluded: true, importedIds: [] }] as [string, { isIncluded: boolean; importedIds: string[] }],
    ),
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  for (const id of optional) {
    expect(select(id, graph)).toBeUndefined();
    expect(select(id.replaceAll("/", "\\"), graph)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(id)).toBeUndefined();
  }
  for (const id of [...mandatory, ...unrecognized]) expect(select(id, graph)).toBe("cockpit-runtime");
});

it("automatically places only the installed optional Sheet SDK, preserving mandatory dialog and unknown files", () => {
  const optional = "C:/repo/node_modules/.pnpm/vaul@1.1.2_peer-hash/node_modules/vaul/dist/index.mjs";
  const mandatory = "C:/repo/node_modules/@radix-ui/react-dialog/dist/index.mjs";
  const unknown = [
    "C:/repo/node_modules/vaul/dist/index.js",
    "C:/repo/node_modules/vaul/dist/other.mjs",
    "C:/repo/node_modules/vaul-custom/dist/index.mjs",
  ];
  const modules = new Map<string, { isIncluded: boolean; importedIds: string[] }>([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["discarded-sheet-sdk-barrel"] }],
    ["discarded-sheet-sdk-barrel", { isIncluded: false, importedIds: [optional, mandatory, ...unknown] }],
    ...[optional, mandatory, ...unknown].map(
      (id) => [id, { isIncluded: true, importedIds: [] }] as [string, { isIncluded: boolean; importedIds: string[] }],
    ),
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  expect(select(optional, graph)).toBeUndefined();
  expect(select(optional.replaceAll("/", "\\"), graph)).toBeUndefined();
  expect(createCockpitBootChunkSelector()(optional)).toBeUndefined();
  for (const id of [mandatory, ...unknown]) expect(select(id, graph)).toBe("cockpit-runtime");
});

it.each([true, false])(
  "groups the sole canonical release table only when a boot value binding requests it (%s)",
  (requested) => {
    for (const windows of [false, true]) {
      const id = (value: string) => (windows ? value.replaceAll("/", "\\") : value);
      const root = id("C:/repo/apps/mission-control-next/src/cockpit-entry.tsx");
      const table = id("C:/repo/apps/mission-control-next/src/app/route-release-scope.ts");
      const name = { type: "Identifier", name: "ROUTE_RELEASE_SCOPE" };
      const statement = requested
        ? {
            type: "ImportDeclaration",
            source: { type: "Literal", value: table },
            specifiers: [{ type: "ImportSpecifier", imported: name, local: name }],
          }
        : {
            type: "ExportNamedDeclaration",
            source: { type: "Literal", value: table },
            specifiers: [{ type: "ExportSpecifier", exported: name, local: name }],
          };
      const modules = new Map<string, { isIncluded: boolean; importedIds: string[]; ast: unknown }>([
        [root, { isIncluded: true, importedIds: [table], ast: { type: "Program", body: [statement] } }],
        [
          table,
          {
            isIncluded: true,
            importedIds: [],
            ast: {
              type: "Program",
              body: [
                {
                  type: "ExportNamedDeclaration",
                  specifiers: [],
                  declaration: {
                    type: "VariableDeclaration",
                    declarations: [{ type: "VariableDeclarator", id: name }],
                  },
                },
              ],
            },
          },
        ],
      ]);
      const graph = {
        getModuleIds: () => modules.keys(),
        getModuleInfo: (value: string) => modules.get(value) ?? null,
      };
      expect(createCockpitBootChunkSelector()(table, graph)).toBe(requested ? "cockpit-entry" : undefined);
      expect(createCockpitBootChunkSelector()(table)).toBeUndefined();
    }
  },
);

it.each([
  ["dist", "/"],
  ["dist", String.fromCharCode(92)],
  ["src", "/"],
  ["src", String.fromCharCode(92)],
])(
  "co-locates retained %s Core and foundation owners for %s paths without importing optional destinations",
  (directory, separator) => {
    const normalize = (id: string) => id.replaceAll("/", separator);
    const root = normalize("C:/repo/src/cockpit-entry.tsx");
    const main = normalize("C:/repo/src/main.tsx");
    const core = normalize(
      "C:/repo/packages/threaded-surface-core/" +
        directory +
        "/chat/useChatSessionControls." +
        (directory === "src" ? "ts" : "js"),
    );
    const foundation = normalize(
      "C:/repo/packages/mission-control-shared/" +
        directory +
        "/api/client-core." +
        (directory === "src" ? "ts" : "js"),
    );
    const runtime = normalize("C:/repo/node_modules/react/dist/index.js");
    const nativeEntry = normalize("C:/repo/apps/mission-control-next/src/cockpit/CockpitApp.tsx");
    const sharedPreference = normalize(
      "C:/repo/packages/mission-control-shared/" +
        directory +
        "/state/ui-preferences." +
        (directory === "src" ? "ts" : "js"),
    );
    const optional = normalize(
      "C:/repo/packages/threaded-surface-core/" +
        directory +
        "/chat/workbench-action-code." +
        (directory === "src" ? "ts" : "js"),
    );
    const discarded = normalize(
      "C:/repo/packages/threaded-surface-core/" + directory + "/discarded." + (directory === "src" ? "ts" : "js"),
    );
    const modules = new Map([
      [
        root,
        {
          isIncluded: true,
          importedIds: [core, foundation, runtime, nativeEntry, sharedPreference, discarded],
          dynamicImportedIds: [optional],
        },
      ],
      [main, { isIncluded: true, importedIds: [sharedPreference] }],
      [core, { isIncluded: true, importedIds: [foundation] }],
      [foundation, { isIncluded: true, importedIds: [] }],
      [runtime, { isIncluded: true, importedIds: [] }],
      [nativeEntry, { isIncluded: true, importedIds: [] }],
      [sharedPreference, { isIncluded: true, importedIds: [] }],
      [optional, { isIncluded: true, importedIds: [] }],
      [discarded, { isIncluded: false, importedIds: [] }],
    ]);
    const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
    const select = createCockpitBootChunkSelector();
    expect(select(core, graph)).toBe("cockpit-foundation");
    expect(select(foundation, graph)).toBe("cockpit-foundation");
    expect(select(runtime, graph)).toBe("cockpit-runtime");
    expect(select(nativeEntry, graph)).toBe("cockpit-entry");
    expect(select(sharedPreference, graph)).toBeUndefined();
    expect(select(discarded, graph)).toBeUndefined();
    expect(select(optional, graph)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(core)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(foundation)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(optional)).toBeUndefined();
  },
);

describe("canonical memory API named cold placement", () => {
  const identifier = (name: string) => ({ type: "Identifier", name });
  const program = (body: unknown[]) => ({ type: "Program", body });
  const imported = (source: string, name = "fetchMemoryItems") => ({
    type: "ImportDeclaration",
    source: { type: "Literal", value: source },
    specifiers: [{ type: "ImportSpecifier", imported: identifier(name), local: identifier("readMemory") }],
  });
  const exported = (name = "fetchMemoryItems") => ({
    type: "ExportNamedDeclaration",
    specifiers: [],
    declaration: { type: "FunctionDeclaration", id: identifier(name) },
  });
  type Info = { isIncluded: boolean | null; importedIds: string[]; ast?: unknown };
  const fixture = (directory: string, separator: string) => {
    const id = (value: string) => value.replaceAll("/", separator);
    const root = id("C:/repo/apps/mission-control-next/src/cockpit-entry.tsx");
    const memory = id(
      "C:/repo/packages/mission-control-shared/" + directory + "/api/memory." + (directory === "src" ? "ts" : "js"),
    );
    const modules = new Map<string, Info>([
      [root, { isIncluded: true, importedIds: [memory], ast: program([imported(memory)]) }],
      [memory, { isIncluded: true, importedIds: [], ast: program([exported()]) }],
    ]);
    const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (value: string) => modules.get(value) ?? null };
    return { id, root, memory, modules, graph };
  };

  it.each([
    ["src", "/"],
    ["src", String.fromCharCode(92)],
    ["dist", "/"],
    ["dist", String.fromCharCode(92)],
  ])("co-locates only a fully resolved included %s memory value for %s paths", (directory, separator) => {
    const f = fixture(directory, separator);
    expect(createCockpitBootChunkSelector()(f.memory, f.graph)).toBe("cockpit-foundation");
    expect(createCockpitBootChunkSelector()(f.memory)).toBeUndefined();
    const barrel = f.id(
      "C:/repo/packages/mission-control-shared/" + directory + "/api/client." + (directory === "src" ? "ts" : "js"),
    );
    f.modules.set(f.root, { isIncluded: true, importedIds: [barrel], ast: program([imported(barrel, "memoryAlias")]) });
    f.modules.set(barrel, {
      isIncluded: false,
      importedIds: [f.memory],
      ast: program([
        {
          type: "ExportNamedDeclaration",
          source: { type: "Literal", value: f.memory },
          specifiers: [
            { type: "ExportSpecifier", local: identifier("fetchMemoryItems"), exported: identifier("memoryAlias") },
          ],
        },
      ]),
    });
    expect(createCockpitBootChunkSelector()(f.memory, f.graph)).toBe("cockpit-foundation");
  });

  it.each([
    "namespace",
    "unknown-export",
    "no-root-ast",
    "no-owner-ast",
    "not-included",
    "unknown-inclusion",
    "missing-owner",
    "noncold",
    "unrequested-forward",
    "ambiguous-stars",
  ])("keeps %s memory ownership automatic without named cold proof", (condition) => {
    const f = fixture("dist", "/");
    if (condition === "namespace")
      f.modules.get(f.root)!.ast = program([
        {
          type: "ImportDeclaration",
          source: { type: "Literal", value: f.memory },
          specifiers: [{ type: "ImportNamespaceSpecifier", local: identifier("memory") }],
        },
      ]);
    if (condition === "unknown-export") f.modules.get(f.root)!.ast = program([imported(f.memory, "unknownMemoryRead")]);
    if (condition === "no-root-ast") delete f.modules.get(f.root)!.ast;
    if (condition === "no-owner-ast") delete f.modules.get(f.memory)!.ast;
    if (condition === "not-included") f.modules.get(f.memory)!.isIncluded = false;
    if (condition === "unknown-inclusion") f.modules.get(f.memory)!.isIncluded = null;
    if (condition === "missing-owner") f.modules.delete(f.memory);
    if (condition === "noncold") f.modules.set(f.root, { isIncluded: true, importedIds: [], ast: program([]) });
    if (condition === "unrequested-forward")
      f.modules.get(f.root)!.ast = program([
        {
          type: "ExportNamedDeclaration",
          source: { type: "Literal", value: f.memory },
          specifiers: [
            {
              type: "ExportSpecifier",
              local: identifier("fetchMemoryItems"),
              exported: identifier("fetchMemoryItems"),
            },
          ],
        },
      ]);
    if (condition === "ambiguous-stars") {
      const barrel = "C:/repo/packages/mission-control-shared/dist/api/client.js";
      const second = "C:/repo/packages/mission-control-shared/dist/api/other-memory.js";
      f.modules.set(f.root, { isIncluded: true, importedIds: [barrel], ast: program([imported(barrel)]) });
      f.modules.set(second, { isIncluded: true, importedIds: [], ast: program([exported()]) });
      f.modules.set(barrel, {
        isIncluded: false,
        importedIds: [f.memory, second],
        ast: program(
          [f.memory, second].map((source) => ({
            type: "ExportAllDeclaration",
            source: { type: "Literal", value: source },
          })),
        ),
      });
    }
    expect(createCockpitBootChunkSelector()(f.memory, f.graph)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(f.memory)).toBeUndefined();
  });

  it("preserves automatic contract memory and ordinary unknown sibling ownership", () => {
    const f = fixture("dist", "/");
    const contract = "C:/repo/packages/contracts/dist/memory.js";
    const sibling = "C:/repo/packages/mission-control-shared/dist/api/memory-new.js";
    f.modules.set(contract, { isIncluded: true, importedIds: [], ast: program([exported("memorySchema")]) });
    f.modules.set(sibling, { isIncluded: true, importedIds: [], ast: program([exported("futureMemoryRead")]) });
    f.modules.set(f.root, {
      isIncluded: true,
      importedIds: [contract, sibling],
      ast: program([imported(contract, "memorySchema"), imported(sibling, "futureMemoryRead")]),
    });
    expect(createCockpitBootChunkSelector()(contract, f.graph)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(sibling, f.graph)).toBe("cockpit-foundation");
    expect(createCockpitBootChunkSelector()(sibling)).toBeUndefined();
  });
});
