import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import viteConfig, {
  buildManagedUiHealthPayload,
  buildWorkspaceSourceAliases,
  WORKSPACE_SOURCE_PACKAGES,
  DEV_OPTIMIZE_DEPS_ESBUILD_TARGET,
  managedUiHealthPlugin,
  resolveViteAllowedHosts,
} from "./vite.config";

describe("mission-control-next vite config", () => {
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
