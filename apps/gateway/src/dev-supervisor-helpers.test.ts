import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
import {
  buildGatewayStartCommandForPlatform,
  formatSignatureEntry,
  isWatchableSourceFile,
  pruneFailureTimestamps,
  readPositiveInt,
  readReferenceSignatureCache,
  resolveReferenceBuildMode,
  resolveReferenceBuildSpawn,
  resolveGatewayHealthHost,
  sanitizeSpawnOutput,
  shouldBuildGatewayProjectReferences,
  shouldIgnoreWatchedEntryName,
  shouldUseWorkspaceTypeScriptGraph,
  writeReferenceSignatureCache,
} from "./dev-supervisor-helpers.js";

describe("dev supervisor helper decisions", () => {
  it("normalizes health probes for wildcard binds without changing explicit hosts", () => {
    expect(resolveGatewayHealthHost("0.0.0.0")).toBe("127.0.0.1");
    expect(resolveGatewayHealthHost("::")).toBe("127.0.0.1");
    expect(resolveGatewayHealthHost("[::]")).toBe("127.0.0.1");
    expect(resolveGatewayHealthHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveGatewayHealthHost("gateway.local")).toBe("gateway.local");
  });

  it("parses positive integer env knobs and preserves the documented fallback", () => {
    expect(readPositiveInt(undefined, 120_000)).toBe(120_000);
    expect(readPositiveInt("   ", 120_000)).toBe(120_000);
    expect(readPositiveInt("0", 120_000)).toBe(120_000);
    expect(readPositiveInt("-1", 120_000)).toBe(120_000);
    expect(readPositiveInt("45000", 120_000)).toBe(45_000);
    expect(readPositiveInt("45000ms", 120_000)).toBe(45_000);
  });

  it("keeps supervisor diagnostics bounded and omits empty spawn output", () => {
    expect(sanitizeSpawnOutput(undefined)).toBeUndefined();
    expect(sanitizeSpawnOutput(null)).toBeUndefined();
    expect(sanitizeSpawnOutput("   ")).toBeUndefined();
    expect(sanitizeSpawnOutput(Buffer.from("  build failed  "))).toBe("build failed");

    const long = `${"x".repeat(20)}${"tail".repeat(400)}`;
    expect(sanitizeSpawnOutput(long)).toBe(long.slice(-1200));
  });

  it("filters watch roots to source/config files and stable relative signatures", () => {
    expect(shouldIgnoreWatchedEntryName("node_modules")).toBe(true);
    expect(shouldIgnoreWatchedEntryName("dist")).toBe(true);
    expect(shouldIgnoreWatchedEntryName(".git")).toBe(true);
    expect(shouldIgnoreWatchedEntryName("src")).toBe(false);

    expect(isWatchableSourceFile("apps/gateway/src/main.ts")).toBe(true);
    expect(isWatchableSourceFile("apps/gateway/src/main.TSX")).toBe(true);
    expect(isWatchableSourceFile("config/local.json")).toBe(true);
    expect(isWatchableSourceFile("README.md")).toBe(false);

    expect(formatSignatureEntry("F:/code/personal-ai", "F:/code/personal-ai/apps/gateway/src/main.ts", 42)).toBe(
      "apps/gateway/src/main.ts:42",
    );
  });

  it("prunes restart failures outside the active supervisor budget window", () => {
    const failures = [1_000, 5_000, 30_000, 61_000];
    pruneFailureTimestamps(failures, 65_000, 60_000);
    expect(failures).toEqual([5_000, 30_000, 61_000]);

    pruneFailureTimestamps(failures, 130_001, 60_000);
    expect(failures).toEqual([]);

    const sparseFailures = [undefined as unknown as number, 10_000];
    pruneFailureTimestamps(sparseFailures, 70_000, 60_000);
    expect(sparseFailures).toEqual([undefined, 10_000]);
  });

  it("uses a cmd wrapper on Windows and direct pnpm execution elsewhere", () => {
    expect(buildGatewayStartCommandForPlatform("win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm exec tsx src/main.ts"],
    });
    expect(buildGatewayStartCommandForPlatform("win32", undefined)).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm exec tsx src/main.ts"],
    });
    expect(buildGatewayStartCommandForPlatform("linux", undefined)).toEqual({
      command: "pnpm",
      args: ["exec", "tsx", "src/main.ts"],
    });
  });

  it("recognizes workspace TypeScript graph env values and the legacy TS7 alias", () => {
    expect(shouldUseWorkspaceTypeScriptGraph({})).toBe(false);
    expect(shouldUseWorkspaceTypeScriptGraph({ GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH: "" })).toBe(false);
    expect(shouldUseWorkspaceTypeScriptGraph({ GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH: "no" })).toBe(false);
    expect(shouldUseWorkspaceTypeScriptGraph({ GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH: "0" })).toBe(false);
    expect(shouldUseWorkspaceTypeScriptGraph({ GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH: "1" })).toBe(true);
    expect(shouldUseWorkspaceTypeScriptGraph({ GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH: "true" })).toBe(true);
    expect(shouldUseWorkspaceTypeScriptGraph({ GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH: "On" })).toBe(true);
    expect(shouldUseWorkspaceTypeScriptGraph({ GOATCITADEL_DEV_TS7: "1" })).toBe(true);
  });

  it("routes the reference build through the workspace TS7 runner when opted in and shell-free tsc otherwise", () => {
    const gatewayDir = path.resolve(testFileDir, "..");
    const repoRoot = path.resolve(gatewayDir, "..", "..");
    const ts7Plan = resolveReferenceBuildSpawn({
      gatewayDir,
      repoRoot,
      useWorkspaceGraph: true,
      platform: "win32",
    });
    expect(ts7Plan.command).toBe(process.execPath);
    expect(ts7Plan.args[0]).toMatch(/run-ts7-workspace\.mjs$/u);
    expect(ts7Plan.args).toContain("--group");
    expect(ts7Plan.args).toContain("gateway");
    expect(ts7Plan.description).toContain("workspace graph");
    expect(ts7Plan.shell).toBe(false);

    const directPlan = resolveReferenceBuildSpawn({
      gatewayDir,
      repoRoot,
      useWorkspaceGraph: false,
      platform: "win32",
    });
    expect(directPlan.command).toBe(process.execPath);
    if (directPlan.description === "tsc -b (direct TypeScript 7)") {
      expect(directPlan.args[0]).toMatch(/typescript[\\/]bin[\\/]tsc$/u);
    } else {
      expect(directPlan.description).toBe("tsc -b (corepack pnpm exec)");
      expect(directPlan.args).toEqual(expect.arrayContaining(["pnpm", "exec", "tsc"]));
    }
    expect(directPlan.args).toEqual(expect.arrayContaining(["-b", "tsconfig.json", "--pretty", "false"]));
    expect(directPlan.cwd).toBe(gatewayDir);
    expect(directPlan.shell).toBe(false);
  });

  it("uses shell-free reference-build fallbacks and rejects Windows cmd shims", () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-helpers-"));
    try {
      const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
      const corepackEntrypoint = "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\corepack.js";
      const plan = resolveReferenceBuildSpawn({
        gatewayDir: isolatedDir,
        repoRoot: isolatedDir,
        useWorkspaceGraph: false,
        platform: "win32",
        nodeExecutable,
        fileExists: (targetPath) => targetPath === corepackEntrypoint,
      });
      expect(plan.command).toBe(nodeExecutable);
      expect(plan.args).toEqual([
        corepackEntrypoint,
        "pnpm",
        "exec",
        "tsc",
        "-b",
        "tsconfig.json",
        "--pretty",
        "false",
      ]);
      expect(plan.description).toBe("tsc -b (corepack pnpm exec)");
      expect(plan.shell).toBe(false);

      expect(() =>
        resolveReferenceBuildSpawn({
          gatewayDir: isolatedDir,
          repoRoot: isolatedDir,
          useWorkspaceGraph: false,
          platform: "win32",
          nodeExecutable,
          fileExists: () => false,
        }),
      ).toThrow(/shell-free pnpm entrypoint/u);

      const linuxFallback = resolveReferenceBuildSpawn({
        gatewayDir: isolatedDir,
        repoRoot: isolatedDir,
        useWorkspaceGraph: false,
        platform: "linux",
      });
      expect(linuxFallback.command).toBe("pnpm");
      expect(linuxFallback.args).toEqual(["exec", "tsc", "-b", "tsconfig.json", "--pretty", "false"]);
      expect(linuxFallback.shell).toBe(false);
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it("round-trips the reference-build signature through the cache helpers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cache-"));
    const cacheFile = path.join(dir, "nested", "ref-signature.json");
    try {
      expect(readReferenceSignatureCache(cacheFile)).toBeUndefined();
      writeReferenceSignatureCache(cacheFile, "abc:123|def:456");
      expect(readReferenceSignatureCache(cacheFile)).toBe("abc:123|def:456");

      fs.writeFileSync(cacheFile, "{ not valid json }", "utf8");
      expect(readReferenceSignatureCache(cacheFile)).toBeUndefined();

      fs.writeFileSync(cacheFile, JSON.stringify({ signature: 42 }), "utf8");
      expect(readReferenceSignatureCache(cacheFile)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes reference-build modes and skips duplicate builds for unchanged source signatures", () => {
    expect(resolveReferenceBuildMode(undefined)).toBe("auto");
    expect(resolveReferenceBuildMode("force")).toBe("always");
    expect(resolveReferenceBuildMode("false")).toBe("skip");
    expect(resolveReferenceBuildMode("surprise")).toBe("auto");

    expect(
      shouldBuildGatewayProjectReferences({
        mode: "auto",
        currentSignature: "same",
        lastSuccessfulSignature: "same",
      }),
    ).toEqual({
      build: false,
      reason: "source signature unchanged since last successful reference build",
    });
    expect(
      shouldBuildGatewayProjectReferences({
        mode: "auto",
        currentSignature: "next",
        lastSuccessfulSignature: "previous",
      }),
    ).toEqual({
      build: true,
      reason: "source signature changed or not built yet",
    });
    expect(
      shouldBuildGatewayProjectReferences({
        mode: "skip",
        currentSignature: "next",
      }),
    ).toEqual({
      build: false,
      reason: "forced by reference build mode",
    });
  });
});
