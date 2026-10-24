import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_STALE_RUN_DIR_AGE_MS,
  CLAUDE_CLI_STALE_RUN_DIR_PARK_MARGIN,
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
    makeRunDir("run-stale", 3 * HOUR_MS);
    makeRunDir("run-fresh", 5 * 60 * 1000);

    const result = await sweepStaleClaudeCliRunDirs({ scratchRoot, removeDir });

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
