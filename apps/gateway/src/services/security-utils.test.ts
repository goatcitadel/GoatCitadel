import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeMemoryForgetCriteria, serializePathWithinRoot } from "./security-utils.js";

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
    expect(onOutsideRootPathWarning).toHaveBeenCalledWith(expect.objectContaining({
      baseName: "token.txt",
      normalizedPath: outsideRoot,
    }));
  });
});
