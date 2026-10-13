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

it.each(["remote-worker-ops", "remote-worker-runtime-read", "remote-worker-inference", "secret-redaction", "channel-sanitizer", "durable-child-watcher-bounds", "change-plan"])("keeps %s at its actual lazy destination despite a discarded contract barrel", (name) => {
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

it.each(["tooltip", "tabs"])("leaves lazy-only Radix %s placement to actual imports and keeps native menu ownership", name => {
  const optional = "C:/repo/node_modules/@radix-ui/react-" + name + "/dist/index.mjs";
  const menu = "C:/repo/node_modules/@radix-ui/react-menu/dist/index.mjs";
  const modules = new Map([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["radix-barrel"] }],
    ["radix-barrel", { isIncluded: false, importedIds: [optional, menu] }],
    [optional, { isIncluded: true, importedIds: [] }],
    [menu, { isIncluded: true, importedIds: [] }],
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  expect(select(optional, graph)).toBeUndefined();
  expect(select(optional.replaceAll("/", "\\"), graph)).toBeUndefined();
  expect(select(menu, graph)).toBe("cockpit-runtime");
  expect(createCockpitBootChunkSelector()(optional)).toBeUndefined();
});

it("leaves confirmed destination owners to Rollup while keeping mandatory Native controls and regular queries grouped", () => {
  const prefix = "C:/repo/apps/mission-control-next/src/features/native-routes/primitives/";
  const automatic = ["C:/repo/packages/contracts/dist/ops-board.js", "C:/repo/packages/mission-control-shared/dist/api/memory.js", prefix + "ErrorState.tsx", "C:/repo/node_modules/@tanstack/query-core/build/modern/infiniteQueryObserver.js"];
  const mandatory = [prefix + "NativeButton.tsx", prefix + "EmptyState.tsx", prefix + "StatusChip.tsx", "C:/repo/node_modules/@tanstack/react-query/build/modern/useQuery.js", "C:/repo/node_modules/@tanstack/query-core/build/modern/queryObserver.js"];
  const modules = new Map<string, { isIncluded: boolean; importedIds: string[] }>([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["discarded-barrel"] }],
    ["discarded-barrel", { isIncluded: false, importedIds: [...automatic, ...mandatory] }],
    ...[...automatic, ...mandatory].map(id => [id, { isIncluded: true, importedIds: [] }] as [string, { isIncluded: boolean; importedIds: string[] }]),
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  for (const id of automatic) {
    expect(select(id, graph)).toBeUndefined();
    expect(createCockpitBootChunkSelector()(id)).toBeUndefined();
  }
  for (const id of mandatory) expect(select(id, graph)).toBe(id.includes("/node_modules/") ? "cockpit-runtime" : "cockpit-entry");
});

it.each(["src", "dist"])("keeps optional external-source owners at their destination and mandatory %s Chat validation grouped", directory => {
  const prefix = "C:/repo/packages/";
  const optional = [prefix + "contracts/" + directory + "/external-sources.js", prefix + "mission-control-shared/" + directory + "/api/external-sources.js"];
  const mandatory = [prefix + "contracts/" + directory + "/external-source-chat.js", prefix + "contracts/" + directory + "/external-source-validation.js", prefix + "mission-control-shared/" + directory + "/api/external-source-chat.js"];
  const modules = new Map<string, { isIncluded: boolean; importedIds: string[] }>([
    ["C:/repo/src/cockpit-entry.tsx", { isIncluded: true, importedIds: ["discarded-barrel", ...mandatory] }],
    ["discarded-barrel", { isIncluded: false, importedIds: optional }],
    ...[...optional, ...mandatory].map(id => [id, { isIncluded: true, importedIds: [] }] as [string, { isIncluded: boolean; importedIds: string[] }]),
  ]);
  const graph = { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null };
  const select = createCockpitBootChunkSelector();
  for (const id of optional) {
    expect(select(id, graph)).toBeUndefined();
    expect(select(id.replaceAll("/", "\\"), graph)).toBeUndefined();
  }
  for (const id of mandatory) expect(select(id, graph)).toBe("cockpit-foundation");
});
