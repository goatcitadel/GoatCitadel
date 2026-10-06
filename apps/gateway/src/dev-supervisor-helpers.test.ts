import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
import {
  buildGatewayStartCommandForPlatform,
  formatSignatureEntry,
  isProcessGroupAlive,
  isWatchableSourceFile,
  type ProcessSignalSender,
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
  terminateProcessGroup,
  writeReferenceSignatureCache,
} from "./dev-supervisor-helpers.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code });
}

function createVirtualClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    sleeps,
  };
}

/**
 * A fake POSIX process table for one supervised child spawned with `detached: true`: the
 * group leader is the `pnpm exec` wrapper (its pid is the group id) and the rest of the
 * group is tsx plus the real gateway. pnpm exits on SIGTERM at once; the descendants take
 * `descendantExitAfterSigtermMs` to finish shutting down (Infinity models a shutdown that
 * never completes), and only SIGKILL ends them sooner.
 */
function createFakeProcessGroup(
  clock: { now: () => number },
  pgid: number,
  descendantExitAfterSigtermMs: number,
): {
  sendSignal: ProcessSignalSender;
  sent: Array<[number, NodeJS.Signals | 0]>;
  isLeaderAlive: () => boolean;
  isGroupAlive: () => boolean;
} {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  let leaderAlive = true;
  let descendantsExitAt = Number.POSITIVE_INFINITY;
  const isGroupAlive = () => leaderAlive || clock.now() < descendantsExitAt;
  return {
    sendSignal: (pid, signal) => {
      sent.push([pid, signal]);
      const targetAlive = pid === pgid ? leaderAlive : pid === -pgid ? isGroupAlive() : false;
      if (!targetAlive) {
        throw errno("ESRCH");
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        leaderAlive = false;
      }
      if (pid === -pgid && signal === "SIGTERM") {
        descendantsExitAt = Math.min(descendantsExitAt, clock.now() + descendantExitAfterSigtermMs);
      }
      if (pid === -pgid && signal === "SIGKILL") {
        descendantsExitAt = clock.now();
      }
    },
    sent,
    isLeaderAlive: () => leaderAlive,
    isGroupAlive,
  };
}

describe("dev supervisor process-group stop", () => {
  it("treats a process group as alive while any member can still be signalled", () => {
    expect(isProcessGroupAlive(4242, () => {})).toBe(true);
    expect(
      isProcessGroupAlive(4242, () => {
        throw errno("ESRCH");
      }),
    ).toBe(false);
    // EPERM means the group exists but is not ours to signal; it is not proof that it exited.
    expect(
      isProcessGroupAlive(4242, () => {
        throw errno("EPERM");
      }),
    ).toBe(true);

    const probes: Array<[number, NodeJS.Signals | 0]> = [];
    isProcessGroupAlive(4242, (pid, signal) => {
      probes.push([pid, signal]);
    });
    expect(probes).toEqual([[-4242, 0]]);
  });

  it("SIGKILLs the group when the leader exits on SIGTERM but a descendant outlives the grace period", async () => {
    const clock = createVirtualClock();
    const group = createFakeProcessGroup(clock, 4242, Number.POSITIVE_INFINITY);
    const signalLeader = vi.fn();

    const outcome = await terminateProcessGroup({
      pgid: 4242,
      graceMs: 1200,
      pollMs: 50,
      signalLeader,
      sendSignal: group.sendSignal,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(group.sent[0]).toEqual([-4242, "SIGTERM"]);
    // The CI hang: only pnpm died, so a leader-liveness check saw nothing left to kill.
    expect(group.isLeaderAlive()).toBe(false);
    expect(outcome).toBe("killed");
    expect(group.sent.at(-1)).toEqual([-4242, "SIGKILL"]);
    expect(clock.now()).toBe(1200);
    expect(group.isGroupAlive()).toBe(false);
    expect(signalLeader).not.toHaveBeenCalled();
  });

  it("does not SIGKILL or wait once the whole group has exited", async () => {
    const clock = createVirtualClock();
    const group = createFakeProcessGroup(clock, 4242, 0);

    const outcome = await terminateProcessGroup({
      pgid: 4242,
      graceMs: 1200,
      pollMs: 50,
      signalLeader: vi.fn(),
      sendSignal: group.sendSignal,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(outcome).toBe("exited");
    expect(group.sent.map(([, signal]) => signal)).not.toContain("SIGKILL");
    expect(clock.sleeps).toEqual([]);
  });

  it("returns as soon as the group exits inside the grace period instead of sleeping it out", async () => {
    const clock = createVirtualClock();
    const group = createFakeProcessGroup(clock, 4242, 300);

    const outcome = await terminateProcessGroup({
      pgid: 4242,
      graceMs: 1200,
      pollMs: 50,
      signalLeader: vi.fn(),
      sendSignal: group.sendSignal,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(outcome).toBe("exited");
    expect(clock.now()).toBe(300);
    expect(clock.sleeps.every((ms) => ms <= 50)).toBe(true);
    expect(group.sent.map(([, signal]) => signal)).not.toContain("SIGKILL");
  });

  it("signals the leader directly when the group itself refuses the signal", async () => {
    const clock = createVirtualClock();
    const signalLeader = vi.fn();

    const outcome = await terminateProcessGroup({
      pgid: 4242,
      graceMs: 100,
      pollMs: 50,
      signalLeader,
      sendSignal: () => {
        throw errno("EPERM");
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(outcome).toBe("killed");
    expect(signalLeader.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
});

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
