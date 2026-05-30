import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeGitPositionalArg,
  normalizeMemoryForgetCriteria,
  serializePathWithinRoot,
} from "./security-utils.js";

describe("security utils", () => {
  it("normalizes forget criteria and enforces at least one filter", () => {
    const empty = normalizeMemoryForgetCriteria({});
    expect(empty.hasCriteria).toBe(false);
    expect(empty.itemIds).toEqual([]);

    const normalized = normalizeMemoryForgetCriteria({
      itemIds: [" mem_1 ", "mem_1", ""],
      namespace: "  project.alpha  ",
      query: "  context refresh  ",
    });
    expect(normalized.hasCriteria).toBe(true);
    expect(normalized.hasItemIds).toBe(true);
    expect(normalized.itemIds).toEqual(["mem_1"]);
    expect(normalized.namespace).toBe("project.alpha");
    expect(normalized.query).toBe("context refresh");
  });

  it("accepts ordinary git positional args and trims surrounding whitespace", () => {
    expect(assertSafeGitPositionalArg("https://github.com/owner/repo.git", "Git source ref")).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(assertSafeGitPositionalArg("  v1.2.3 ", "Git source ref")).toBe("v1.2.3");
    expect(assertSafeGitPositionalArg("release/2026-05", "Git source ref")).toBe("release/2026-05");
  });

  it("rejects empty and leading-dash git positional args", () => {
    expect(() => assertSafeGitPositionalArg("   ", "Git source ref")).toThrow("Git source ref must not be empty.");
    expect(() => assertSafeGitPositionalArg("--upload-pack=touch x", "Git source ref")).toThrow(
      "Git source ref must not begin with '-'",
    );
    expect(() => assertSafeGitPositionalArg("-oProxyCommand=x", "Tracked upstream URL")).toThrow(
      "Tracked upstream URL must not begin with '-'",
    );
  });

  it("serializes in-root paths and redacts out-of-root paths", () => {
    const rootDir = path.resolve(os.tmpdir(), `goatcitadel-security-utils-${Date.now()}`);
    const onOutsideRootPathWarning = vi.fn();
    const warned = new Set<string>();

    const inRoot = path.join(rootDir, "workspace", "notes", "test.md");
    const outsideRoot = path.resolve(rootDir, "..", "secrets", "token.txt");

    expect(serializePathWithinRoot(rootDir, inRoot, warned)).toBe("./workspace/notes/test.md");
    expect(serializePathWithinRoot(rootDir, outsideRoot, warned, onOutsideRootPathWarning)).toBe("[outside-root]");
    expect(serializePathWithinRoot(rootDir, outsideRoot, warned, onOutsideRootPathWarning)).toBe("[outside-root]");
    expect(onOutsideRootPathWarning).toHaveBeenCalledTimes(1);
    expect(onOutsideRootPathWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        baseName: "token.txt",
        normalizedPath: outsideRoot,
      }),
    );
  });
});
