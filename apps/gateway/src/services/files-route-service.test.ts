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
  }, 30_000);

  it("rejects inline downloads before reading content over the route cap", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    await fs.writeFile(path.join(rootDir, "workspace", "large.txt"), "0123456789", "utf8");
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.downloadWorkspaceFile("large.txt", { maxBytes: 4 })).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      httpStatus: 413,
    });
  }, 30_000);

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
  }, 30_000);

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

  it("creates workspace files from templates and publishes the rendered upload event", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const publishRealtime = vi.fn();
    const port = createFilesRoutePort({
      rootDir,
      workspaceDir: "workspace",
      writeJailRoots: [path.join(rootDir, "workspace")],
      readOnlyRoots: [],
      serializeRootPath: (fullPath: string) => `<root>/${path.relative(rootDir, fullPath).replaceAll("\\", "/")}`,
      publishRealtime,
    });

    const templates = port.listFileTemplates();
    const releaseTemplate = templates.find((template) => template.templateId === "release-note");
    expect(releaseTemplate?.defaultPath).toMatch(/^docs\/release-notes-\d{4}-\d{2}-\d{2}\.md$/);

    const result = await port.createWorkspaceFileFromTemplate("release-note", "docs/release.md");

    expect(result).toMatchObject({
      relativePath: "docs/release.md",
      fullPath: "<root>/workspace/docs/release.md",
    });
    await expect(fs.readFile(path.join(rootDir, "workspace", "docs", "release.md"), "utf8")).resolves.toContain(
      "# Release Notes",
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "files",
      expect.objectContaining({
        type: "file_uploaded",
        relativePath: "docs/release.md",
      }),
    );
  });

  it("suggests common workspace roots plus discovered files and directories", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    await fs.mkdir(path.join(rootDir, "workspace", "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "workspace", "docs", "nested", "brief.md"), "brief", "utf8");
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.listWorkspacePathSuggestions(".", 20)).resolves.toEqual(
      expect.arrayContaining([
        "memory/",
        "notes/",
        "artifacts/",
        "docs/",
        "workspace/",
        "docs/nested/brief.md",
        "docs/nested/",
      ]),
    );
    await expect(port.listWorkspacePathSuggestions("docs", 10)).resolves.toEqual(
      expect.arrayContaining(["docs/", "nested/brief.md", "nested/"]),
    );
  });

  it("detects text and binary content decisions for inline downloads", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    await fs.writeFile(path.join(rootDir, "workspace", "config.json"), '{"ok":true}', "utf8");
    await fs.writeFile(path.join(rootDir, "workspace", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.downloadWorkspaceFile("config.json", { maxBytes: 100 })).resolves.toMatchObject({
      contentType: "application/json",
      isText: true,
      content: '{"ok":true}',
    });
    const image = await port.downloadWorkspaceFile("image.png", { maxBytes: 100 });
    expect(image).toMatchObject({
      contentType: "image/png",
      isText: false,
    });
    expect(Buffer.isBuffer(image.content)).toBe(true);
  });

  it("rejects invalid relative paths and directory downloads with explicit errors", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    await fs.mkdir(path.join(rootDir, "workspace", "docs"), { recursive: true });
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.uploadWorkspaceFile("../escape.txt", "bad")).rejects.toThrow("Invalid relative path");
    await expect(port.createWorkspaceFileFromTemplate("missing-template")).rejects.toThrow("Unknown file template");
    await expect(port.downloadWorkspaceFile("docs")).rejects.toMatchObject({
      code: "FIELD_INVALID",
    });
    await expect(port.downloadWorkspaceFile("missing.txt")).rejects.toMatchObject({
      code: "ENTITY_NOT_FOUND",
    });
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
