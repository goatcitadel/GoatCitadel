import { describe, expect, it } from "vitest";
import viteConfig, { DEV_OPTIMIZE_DEPS_ESBUILD_TARGET, resolveViteAllowedHosts } from "./vite.config";

describe("mission-control-next vite config", () => {
  it("keeps the dev dependency optimizer on a modern target", async () => {
    const config =
      typeof viteConfig === "function"
        ? await viteConfig({ command: "serve", mode: "development", isPreview: false, isSsrBuild: false })
        : await viteConfig;

    expect(DEV_OPTIMIZE_DEPS_ESBUILD_TARGET).toBe("esnext");
    expect(config.optimizeDeps?.esbuildOptions?.target).toBe(DEV_OPTIMIZE_DEPS_ESBUILD_TARGET);
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
