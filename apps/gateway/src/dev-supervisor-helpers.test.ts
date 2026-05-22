import { describe, expect, it } from "vitest";
import {
  buildGatewayStartCommandForPlatform,
  formatSignatureEntry,
  isWatchableSourceFile,
  pruneFailureTimestamps,
  readPositiveInt,
  resolveReferenceBuildMode,
  resolveGatewayHealthHost,
  sanitizeSpawnOutput,
  shouldBuildGatewayProjectReferences,
  shouldIgnoreWatchedEntryName,
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
