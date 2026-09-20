import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  enumerateRemoteWorkerWindowsDirectory: vi.fn(),
  hashRemoteWorkerWindowsFile: vi.fn(),
  readRemoteWorkerWindowsFile: vi.fn(),
  enumerateRemoteWorkerWindowsDirectories: vi.fn(),
  hashRemoteWorkerWindowsFiles: vi.fn(),
}));
vi.mock("./remote-worker-windows-no-follow.js", () => api);
import { RemoteWorkerInstalledTreeScanner } from "./remote-worker-installed-tree-scanner.js";
const sha = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const names = [
  "app/worker/dist/main.js",
  "app/pnpm-lock.yaml",
  "app/runtime/node.exe",
  "bin/GoatCitadelRemoteWorkerHost.exe",
  "app/worker/node_modules/pkg/index.js",
];
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: "goatcitadel.remote-worker-windows-package.v3",
    target: "windows-x64",
    entrypoint: names[0],
    nodeExecutable: names[2],
    hostExecutable: names[3],
    files: names.map((path) => ({ path, sha256: sha(path), sizeBytes: Buffer.byteLength(path) })),
  }),
);
const content = new Map([
  ...names.map((path) => [path, Buffer.from(path)] as const),
  ["worker-package.json", manifest] as const,
]);
const directories = new Set([""]);
for (const name of content.keys()) {
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
}
const observation = (path: string) => ({
  volumeSerial: "0000000000000001",
  fileId: sha(path || "root").slice(0, 32),
  sizeBytes: content.get(path)?.length ?? 0,
  linkCount: 1,
  attributes: directories.has(path) ? 16 : 32,
  reparseTag: 0,
  creationTime: "1",
  lastWriteTime: "2",
  changeTime: "3",
  ownerSid: "S-1-5-18",
  sddl: "O:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;S-1-5-80-123)",
  streams: directories.has(path) ? [] : ["::$DATA"],
});
beforeEach(() => {
  api.enumerateRemoteWorkerWindowsDirectories.mockImplementation(async (root: string, paths: string[]) =>
    Promise.all(paths.map((path) => api.enumerateRemoteWorkerWindowsDirectory(root, path))),
  );
  api.hashRemoteWorkerWindowsFiles.mockImplementation(async (root: string, paths: string[]) =>
    Promise.all(paths.map((path) => api.hashRemoteWorkerWindowsFile(root, path))),
  );
  api.readRemoteWorkerWindowsFile.mockReset().mockImplementation(async () => ({ content: Buffer.from(manifest) }));
  api.enumerateRemoteWorkerWindowsDirectory.mockReset().mockImplementation(async (root: string, path: string) => {
    const children = [...directories, ...content.keys()]
      .filter((p) => p !== "" && (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === path)
      .sort();
    return {
      operatorSid: "S-1-5-21-1001",
      rootPath: root,
      relativePath: path,
      rootObservation: observation(""),
      directoryObservation: observation(path),
      secondNames: children.map((p) => p.split("/").at(-1)),
      entries: children.map((p) => ({
        name: p.split("/").at(-1),
        kind: directories.has(p) ? "directory" : "regular_file",
        observation: observation(p),
      })),
    };
  });
  api.hashRemoteWorkerWindowsFile.mockReset().mockImplementation(async (_root: string, path: string) => {
    const parts = path.split("/");
    const ancestors = [observation("")];
    for (let i = 1; i < parts.length; i++) ancestors.push(observation(parts.slice(0, i).join("/")));
    return {
      operatorSid: "S-1-5-21-1001",
      before: observation(path),
      after: observation(path),
      ancestorsBefore: ancestors,
      ancestorsAfter: ancestors,
      sizeBytes: content.get(path)!.length,
      sha256: sha(content.get(path)!),
    };
  });
});
const scan = () =>
  new RemoteWorkerInstalledTreeScanner("a".repeat(64), () => new Date("2026-09-18T00:00:00Z"), {
    windowsPackageManifestSha256: sha(manifest),
  }).scan({
    root: "C:\\ProgramData\\GoatCitadel\\RemoteWorker\\payload",
    maxFileCount: 100,
    maxFileBytes: 1048576,
    maxTotalBytes: 10485760,
  });
it.skipIf(process.platform !== "win32")(
  "scans all SYSTEM-owned installed package files with an operator distinct from SYSTEM",
  async () => {
    const result = await scan();
    expect(result.files).toHaveLength(6);
    expect(result.files.find((f) => f.path === names[0])?.role).toBe("bundle");
  },
);
it.skipIf(process.platform !== "win32")("rejects changed bytes even when native metadata is stable", async () => {
  const original = api.hashRemoteWorkerWindowsFile.getMockImplementation()!;
  api.hashRemoteWorkerWindowsFile.mockImplementation(async (...args) => ({
    ...(await original(...args)),
    sha256: "b".repeat(64),
  }));
  await expect(scan()).rejects.toThrow("pinned inventory");
});
it.skipIf(process.platform !== "win32")("rejects operator-owned substitution for a SYSTEM-owned package", async () => {
  const original = api.enumerateRemoteWorkerWindowsDirectory.getMockImplementation()!;
  api.enumerateRemoteWorkerWindowsDirectory.mockImplementation(async (...args) => {
    const r = await original(...args);
    return { ...r, rootObservation: { ...r.rootObservation, ownerSid: "S-1-5-21-1001" } };
  });
  await expect(scan()).rejects.toThrow();
});
