import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMonacoAssetPath } from "./monaco-assets.js";

describe("resolveMonacoAssetPath", () => {
  const sourceDir = path.resolve("/repo/node_modules/monaco-editor/min/vs");

  it("resolves normal relative Monaco asset paths inside the source directory", () => {
    expect(resolveMonacoAssetPath(sourceDir, "/loader.js")).toBe(path.join(sourceDir, "loader.js"));
    expect(resolveMonacoAssetPath(sourceDir, "/base/browser/ui/codicons/codicon.ttf")).toBe(
      path.join(sourceDir, "base", "browser", "ui", "codicons", "codicon.ttf"),
    );
  });

  it("rejects traversal and sibling-prefix escapes", () => {
    expect(resolveMonacoAssetPath(sourceDir, "/../vs-attack/secret.txt")).toBeUndefined();
    expect(resolveMonacoAssetPath(sourceDir, "/%2e%2e/vs-attack/secret.txt")).toBeUndefined();
    expect(resolveMonacoAssetPath(sourceDir, "/%252e%252e/vs-attack/secret.txt")).toBeUndefined();
  });

  it("rejects absolute, slash-in-segment, backslash, and null-byte payloads", () => {
    expect(resolveMonacoAssetPath(sourceDir, "/C:%5CWindows%5Cwin.ini")).toBeUndefined();
    expect(resolveMonacoAssetPath(sourceDir, "/%2Fetc%2Fpasswd")).toBeUndefined();
    expect(resolveMonacoAssetPath(sourceDir, "/base%5Cworker.js")).toBeUndefined();
    expect(resolveMonacoAssetPath(sourceDir, "/loader.js%00.txt")).toBeUndefined();
  });

  it("rejects malformed encodings and empty requests", () => {
    expect(resolveMonacoAssetPath(sourceDir, "/%")).toBeUndefined();
    expect(resolveMonacoAssetPath(sourceDir, "/")).toBeUndefined();
  });
});
