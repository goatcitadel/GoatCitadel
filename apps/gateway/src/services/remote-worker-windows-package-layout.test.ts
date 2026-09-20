import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWindowsPackageLayout } from "./remote-worker-windows-package-layout.js";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifest = () => ({
  schemaVersion: "goatcitadel.remote-worker-windows-package.v3",
  target: "windows-x64",
  entrypoint: "app/worker/dist/main.js",
  nodeExecutable: "app/runtime/node.exe",
  hostExecutable: "bin/GoatCitadelRemoteWorkerHost.exe",
  files: [
    "app/worker/dist/main.js",
    "app/pnpm-lock.yaml",
    "app/runtime/node.exe",
    "bin/GoatCitadelRemoteWorkerHost.exe",
    "app/worker/node_modules/pkg/index.js",
  ].map((path) => ({ path, sha256: "a".repeat(64), sizeBytes: 4 })),
});
const parse = (value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return parseWindowsPackageLayout(bytes, digest(bytes));
};
describe("pinned Windows package layout", () => {
  it("covers every file including the inventory and assigns exact singleton roles", () => {
    const layout = parse(manifest());
    expect(layout.files.size).toBe(6);
    expect(layout.files.get("app/worker/dist/main.js")?.role).toBe("bundle");
    expect(layout.files.get("app/pnpm-lock.yaml")?.role).toBe("dependency_lock");
    expect(layout.files.get("bin/GoatCitadelRemoteWorkerHost.exe")?.role).toBe("launcher");
    expect(layout.files.get("app/worker/node_modules/pkg/index.js")?.role).toBe("vendor");
    expect(layout.files.get("worker-package.json")?.role).toBe("runtime");
  });
  it("rejects changed manifest bytes", () => {
    const bytes = Buffer.from(JSON.stringify(manifest()));
    expect(() => parseWindowsPackageLayout(bytes, "b".repeat(64))).toThrow();
  });
  it.each([
    "app/../escape",
    "app/file:stream",
    "app/CON.txt",
    "app/space ",
    "app/dir\\file",
    "app//file",
    "elsewhere/file",
  ])("rejects unsafe path %s", (path) => {
    const m = manifest();
    m.files.push({ path, sha256: "a".repeat(64), sizeBytes: 1 });
    expect(() => parse(m)).toThrow();
  });
  it.each([
    "app/worker/dist/main.js",
    "app/pnpm-lock.yaml",
    "app/runtime/node.exe",
    "bin/GoatCitadelRemoteWorkerHost.exe",
    "app/worker/node_modules/pkg/index.js",
  ])("requires %s", (path) => {
    const m = manifest();
    m.files = m.files.filter((f) => f.path !== path);
    expect(() => parse(m)).toThrow();
  });
  it("rejects case aliases and directory/file collisions", () => {
    for (const path of ["app/Worker/extra.js", "app/worker", "app/worker/dist/main.js"]) {
      const m = manifest();
      m.files.push({ path, sha256: "a".repeat(64), sizeBytes: 1 });
      expect(() => parse(m)).toThrow();
    }
  });
  it("rejects invalid hashes and sizes", () => {
    for (const change of [{ sha256: "bad" }, { sizeBytes: -1 }, { sizeBytes: 0.5 }, { sizeBytes: 536870913 }]) {
      const m = manifest();
      Object.assign(m.files[0]!, change);
      expect(() => parse(m)).toThrow();
    }
  });
});
