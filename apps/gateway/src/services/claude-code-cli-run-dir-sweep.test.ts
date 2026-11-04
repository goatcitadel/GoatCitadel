import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CLI_OWNER_FILE,
  CLAUDE_CLI_STALE_RUN_DIR_AGE_MS,
  CLAUDE_CLI_STALE_RUN_DIR_PARK_MARGIN,
  hostClaudeCliRunDirSweepFs,
  registerClaudeCliRunDirOwner,
  sweepStaleClaudeCliRunDirs,
} from "./claude-code-cli-run-dir-sweep.js";

const HOUR_MS = 60 * 60 * 1000;

describe("sweepStaleClaudeCliRunDirs", () => {
  let base: string;
  let scratchRoot: string;
  let removed: string[];

  const removeDir = async (runDir: string) => {
    removed.push(path.basename(runDir));
    await rm(runDir, { recursive: true, force: true });
  };

  const makeRunDir = (name: string, ageMs: number) => {
    const dir = path.join(scratchRoot, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "system-prompt.txt"), "prompt");
    backdate(dir, ageMs);
    return dir;
  };

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "gc-claude-cli-sweep-test-"));
    scratchRoot = path.join(base, "scratch");
    mkdirSync(scratchRoot);
    removed = [];
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("keeps a two-hour age well above the warm park deadline", () => {
    expect(CLAUDE_CLI_STALE_RUN_DIR_AGE_MS).toBe(2 * HOUR_MS);
    expect(CLAUDE_CLI_STALE_RUN_DIR_PARK_MARGIN).toBeGreaterThanOrEqual(4);
  });

  it("removes stale run dirs and keeps fresh ones", async () => {
    const stale = makeRunDir("run-stale", 3 * HOUR_MS);
    await registerClaudeCliRunDirOwner(stale);
    backdate(stale, 3 * HOUR_MS);
    makeRunDir("run-fresh", 5 * 60 * 1000);

    const result = await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, probeOwner: () => "dead" });

    expect(result).toEqual({ removed: 1, kept: 1 });
    expect(removed).toEqual(["run-stale"]);
    expect(existsSync(path.join(scratchRoot, "run-stale"))).toBe(false);
    expect(existsSync(path.join(scratchRoot, "run-fresh"))).toBe(true);
  });

  it("keeps an old run dir whose results folder saw a recent warm resume", async () => {
    const dir = makeRunDir("run-resumed", 3 * HOUR_MS);
    const results = path.join(dir, "results");
    mkdirSync(results);
    writeFileSync(path.join(results, "toolu_1.json"), "{}");
    backdate(dir, 3 * HOUR_MS); // Creating results/ touched the run dir; only results/ stays recent.

    const result = await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir });

    expect(result).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(dir)).toBe(true);
  });

  it("keeps an active child run when its directory age exceeds the stale threshold", async () => {
    const dir = makeRunDir("run-active-child", 0);
    const prompt = path.join(dir, "system-prompt.txt");
    // Finite, task-owned and hidden. Advancing the sweep's clock represents an
    // active long-timeout step (or a wall-clock jump), without waiting two hours.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {
      cwd: dir,
      windowsHide: true,
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await once(child, "spawn");
      expect(child.exitCode).toBeNull();
      await registerClaudeCliRunDirOwner(dir, child.pid);
      const attempted: string[] = [];
      await sweepStaleClaudeCliRunDirs({
        scratchRoot,
        now: () => Date.now() + 3 * HOUR_MS,
        removeDir: async (target) => {
          attempted.push(target);
          // Match the provider's non-throwing cleanup. Windows may refuse the
          // final directory removal after deleting its contents; that is not
          // proof the active run's prompt/bridge files were protected.
          await rm(target, { recursive: true, force: true }).catch(() => undefined);
        },
      });
      expect(child.exitCode).toBeNull();
      expect(attempted).toEqual([]);
      expect(existsSync(prompt)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });

  it("keeps legacy unowned directories even when stale", async () => {
    makeRunDir("run-legacy", 3 * HOUR_MS);
    const probeOwner = vi.fn(() => "dead" as const);
    expect(await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, probeOwner })).toEqual({ removed: 0, kept: 1 });
    expect(removed).toEqual([]);
    expect(probeOwner).not.toHaveBeenCalled();
  });

  it.each(["alive", "unknown"] as const)("keeps an old declared owner that is %s (including PID reuse)", async (status) => {
    const dir = makeRunDir("run-owned", 3 * HOUR_MS);
    await registerClaudeCliRunDirOwner(dir);
    backdate(dir, 3 * HOUR_MS);
    const probeOwner = vi.fn(() => status);
    expect(await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, probeOwner })).toEqual({ removed: 0, kept: 1 });
    expect(removed).toEqual([]);
    expect(probeOwner).toHaveBeenCalledWith(process.pid);
  });

  it.each([0, -1, 1.5, 2 ** 32, "123", null])("never probes invalid owner pid %s", async (pid) => {
    const dir = makeRunDir("run-invalid-owner", 3 * HOUR_MS);
    writeFileSync(path.join(dir, CLAUDE_CLI_OWNER_FILE), JSON.stringify({ version: 1, pid }));
    backdate(dir, 3 * HOUR_MS);
    const probeOwner = vi.fn(() => "dead" as const);
    expect(await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, probeOwner })).toEqual({ removed: 0, kept: 1 });
    expect(probeOwner).not.toHaveBeenCalled();
  });

  it.each(["not JSON", JSON.stringify({ version: 2, pid: 123 }), " ".repeat(513)])("keeps malformed or oversized ownership", async (contents) => {
    const dir = makeRunDir("run-bad-owner", 3 * HOUR_MS);
    writeFileSync(path.join(dir, CLAUDE_CLI_OWNER_FILE), contents);
    backdate(dir, 3 * HOUR_MS);
    expect(await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, probeOwner: () => "dead" })).toEqual({ removed: 0, kept: 1 });
  });

  it("keeps unreadable ownership and a failed liveness probe", async () => {
    const dir = makeRunDir("run-unreadable-owner", 3 * HOUR_MS);
    await registerClaudeCliRunDirOwner(dir);
    backdate(dir, 3 * HOUR_MS);
    const unreadable = { ...hostClaudeCliRunDirSweepFs, readOwnerPid: async () => { throw new Error("denied"); } };
    expect(await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, fs: unreadable })).toEqual({ removed: 0, kept: 1 });
    expect(await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, probeOwner: () => { throw new Error("denied"); } })).toEqual({ removed: 0, kept: 1 });
    expect(removed).toEqual([]);
  });

  it("registers once with the current Gateway pid and refuses to replace ownership", async () => {
    const dir = makeRunDir("run-registration", 0);
    await registerClaudeCliRunDirOwner(dir);
    expect(await hostClaudeCliRunDirSweepFs.readOwnerPid(dir)).toBe(process.pid);
    await expect(registerClaudeCliRunDirOwner(dir)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("leaves entries that are not run-* dirs alone, however old", async () => {
    makeRunDir("notes", 3 * HOUR_MS);
    makeRunDir("run-", 3 * HOUR_MS);
    writeFileSync(path.join(scratchRoot, "run-file.txt"), "not a dir");

    const result = await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, now: () => Date.now() + 24 * HOUR_MS });

    expect(result).toEqual({ removed: 0, kept: 0 });
    expect(removed).toEqual([]);
    expect(existsSync(path.join(scratchRoot, "notes"))).toBe(true);
    expect(existsSync(path.join(scratchRoot, "run-"))).toBe(true);
    expect(existsSync(path.join(scratchRoot, "run-file.txt"))).toBe(true);
  });

  it("never follows a symlinked or junctioned run-* entry out of the scratch root", async () => {
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "operator data");
    backdate(outside, 3 * HOUR_MS);
    symlinkSync(outside, path.join(scratchRoot, "run-linked"), process.platform === "win32" ? "junction" : "dir");

    const result = await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir, now: () => Date.now() + 24 * HOUR_MS });

    expect(result).toEqual({ removed: 0, kept: 0 });
    expect(removed).toEqual([]);
    expect(existsSync(path.join(scratchRoot, "run-linked"))).toBe(true);
    expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });

  it("is a no-op when the scratch root does not exist", async () => {
    const result = await sweepStaleClaudeCliRunDirs({ scratchRoot: path.join(base, "missing"), removeDir });

    expect(result).toEqual({ removed: 0, kept: 0 });
    expect(removed).toEqual([]);
  });

  it("does not throw when the scratch root cannot be listed", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const result = await sweepStaleClaudeCliRunDirs({
      scratchRoot,
      removeDir,
      fs: {
        listEntries: async () => {
          throw denied;
        },
        statNoFollow: async () => undefined,
        readOwnerPid: async () => undefined,
      },
    });

    expect(result).toEqual({ removed: 0, kept: 0 });
  });

  it("keeps an entry whose stat fails or that is no longer a real dir", async () => {
    const now = 10 * HOUR_MS;
    const result = await sweepStaleClaudeCliRunDirs({
      scratchRoot,
      removeDir,
      now: () => now,
      fs: {
        listEntries: async () => [
          { name: "run-unreadable", isDirectory: true },
          { name: "run-swapped", isDirectory: true },
          { name: "run-gone", isDirectory: true },
        ],
        statNoFollow: async (target) => {
          const name = path.basename(target);
          if (name === "run-unreadable") throw Object.assign(new Error("busy"), { code: "EPERM" });
          if (name === "run-swapped") return { isDirectory: false, mtimeMs: 0 };
          return undefined;
        },
        readOwnerPid: async () => undefined,
      },
    });

    expect(result).toEqual({ removed: 0, kept: 3 });
    expect(removed).toEqual([]);
  });
});

function backdate(target: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(target, when, when);
}
