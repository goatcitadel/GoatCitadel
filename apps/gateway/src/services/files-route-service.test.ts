import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type CreateFilesRoutePort = typeof import("./files-route-service.js").createFilesRoutePort;
type FilesRoutePort = ReturnType<CreateFilesRoutePort>;

const originalEnv = {
  GOATCITADEL_MAX_FILE_UPLOAD_BYTES: process.env.GOATCITADEL_MAX_FILE_UPLOAD_BYTES,
  GOATCITADEL_MAX_FILE_LIST_DEPTH: process.env.GOATCITADEL_MAX_FILE_LIST_DEPTH,
  GOATCITADEL_MAX_FILE_LIST_STAT_CALLS: process.env.GOATCITADEL_MAX_FILE_LIST_STAT_CALLS,
};

describe("files route service limits", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
    await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("rejects uploads before writing content over the configured byte cap", async () => {
    process.env.GOATCITADEL_MAX_FILE_UPLOAD_BYTES = "8";
    vi.resetModules();
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.uploadWorkspaceFile("notes/large.txt", "123456789")).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      httpStatus: 413,
    });
    await expect(fs.access(path.join(rootDir, "workspace", "notes", "large.txt"))).rejects.toBeInstanceOf(Error);
  });

  it("rejects inline downloads before reading content over the route cap", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    await fs.writeFile(path.join(rootDir, "workspace", "large.txt"), "0123456789", "utf8");
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.downloadWorkspaceFile("large.txt", { maxBytes: 4 })).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      httpStatus: 413,
    });
  });

  it("skips ignored heavy directories and stops at the configured depth while listing", async () => {
    process.env.GOATCITADEL_MAX_FILE_LIST_DEPTH = "1";
    vi.resetModules();
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    await fs.mkdir(path.join(rootDir, "workspace", "level-one", "level-two"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "workspace", "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "workspace", "root.md"), "root", "utf8");
    await fs.writeFile(path.join(rootDir, "workspace", "level-one", "child.md"), "child", "utf8");
    await fs.writeFile(path.join(rootDir, "workspace", "level-one", "level-two", "deep.md"), "deep", "utf8");
    await fs.writeFile(path.join(rootDir, "workspace", "node_modules", "pkg", "skip.js"), "skip", "utf8");
    const port = createPort(createFilesRoutePort, rootDir);

    const items = await port.listWorkspaceFiles(".", 100);
    const paths = items.map((item) => item.relativePath).sort();

    expect(paths).toContain("root.md");
    expect(paths).toContain("level-one/child.md");
    expect(paths).not.toContain("level-one/level-two/deep.md");
    expect(paths.some((item) => item.startsWith("node_modules/"))).toBe(false);
  });

  it("keeps symlink escape checks on downloads", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
    try {
      await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(rootDir, "workspace", "link.txt"), "file");
    } catch {
      return;
    }
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.downloadWorkspaceFile("link.txt", { maxBytes: 100 })).rejects.toThrow();
  });
});

async function createTempWorkspace(tempRoots: string[]): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-files-route-"));
  tempRoots.push(rootDir);
  await fs.mkdir(path.join(rootDir, "workspace"), { recursive: true });
  return rootDir;
}

function createPort(createFilesRoutePort: CreateFilesRoutePort, rootDir: string): FilesRoutePort {
  return createFilesRoutePort({
    rootDir,
    workspaceDir: "workspace",
    writeJailRoots: [path.join(rootDir, "workspace")],
    readOnlyRoots: [],
    serializeRootPath: (fullPath: string) => fullPath,
    publishRealtime: vi.fn(),
  });
}
