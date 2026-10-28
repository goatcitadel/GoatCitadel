import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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

  it("refuses an expected-absent upload when the file already exists and leaves it unchanged", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const existing = path.join(rootDir, "workspace", "notes", "proof.txt");
    await fs.mkdir(path.dirname(existing), { recursive: true });
    await fs.writeFile(existing, "original", "utf8");
    const port = createPort(createFilesRoutePort, rootDir);

    await expect(port.uploadWorkspaceFile("notes/proof.txt", "new", { expectAbsent: true })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
      httpStatus: 409,
    });
    await expect(fs.readFile(existing, "utf8")).resolves.toBe("original");
    await expect(port.uploadWorkspaceFile("notes/fresh.txt", "new", { expectAbsent: true })).resolves.toMatchObject({
      relativePath: "notes/fresh.txt",
      bytes: 3,
    });
    await port.uploadWorkspaceFile("notes/proof.txt", "replaced");
    await expect(fs.readFile(existing, "utf8")).resolves.toBe("replaced");
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

describe("paged workspace file listing (LB-08)", () => {
  const tempRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("searches the whole scanned folder, pages newest first with a cursor, and names direct subfolders", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const workspace = path.join(rootDir, "workspace");
    await fs.mkdir(path.join(workspace, "docs", "deep"), { recursive: true });
    await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
    const files = ["docs/readme-1.md", "docs/deep/readme-2.md", "docs/other.md", "readme-3.md"];
    for (const [index, file] of files.entries()) {
      const full = path.join(workspace, file);
      await fs.writeFile(full, file, "utf8");
      const time = new Date(Date.UTC(2026, 0, 1 + index));
      await fs.utimes(full, time, time);
    }
    const port = createPort(createFilesRoutePort, rootDir);

    const first = await port.pageWorkspaceFiles(".", 2, { query: "README" });
    expect(first.items.map((item: { relativePath: string }) => item.relativePath)).toEqual([
      "readme-3.md",
      "docs/deep/readme-2.md",
    ]);
    expect(first).toMatchObject({ folders: ["docs"], nextCursor: expect.any(String), complete: true });
    // A file written between pages sorts ahead of the cursor; it must not shift later pages.
    const newer = path.join(workspace, "readme-new.md");
    await fs.writeFile(newer, "new", "utf8");
    const newerTime = new Date(Date.UTC(2026, 0, 10));
    await fs.utimes(newer, newerTime, newerTime);
    const second = await port.pageWorkspaceFiles(".", 2, { query: "readme", cursor: first.nextCursor });
    expect(second.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(["docs/readme-1.md"]);
    expect(second.nextCursor).toBeUndefined();

    const folder = await port.pageWorkspaceFiles("docs", 10);
    expect(folder.items.map((item: { relativePath: string }) => item.relativePath)).toEqual([
      "other.md",
      "deep/readme-2.md",
      "readme-1.md",
    ]);
    expect(folder.folders).toEqual(["deep"]);
    for (const cursor of ["-1", "2", "not base64!", Buffer.from('{"m":"x","p":""}').toString("base64url")]) {
      await expect(port.pageWorkspaceFiles(".", 2, { cursor })).rejects.toMatchObject({ code: "FIELD_INVALID" });
    }
    await expect(port.pageWorkspaceFiles("../outside", 2)).rejects.toThrow();

    // Paths that compare equal under locale collation still page one at a time without loss.
    await fs.mkdir(path.join(workspace, "accents"));
    const accentNames = [`${String.fromCodePoint(0xe9)}.txt`, `e${String.fromCodePoint(0x301)}.txt`]; // composed vs decomposed e-acute
    const tieTime = new Date(Date.UTC(2026, 1, 1));
    for (const name of accentNames) {
      const full = path.join(workspace, "accents", name);
      await fs.writeFile(full, name, "utf8");
      await fs.utimes(full, tieTime, tieTime);
    }
    const accentSeen: string[] = [];
    let accentCursor: string | undefined;
    do {
      const page = await port.pageWorkspaceFiles("accents", 1, { cursor: accentCursor });
      accentSeen.push(...page.items.map((item: { relativePath: string }) => item.relativePath));
      accentCursor = page.nextCursor;
    } while (accentCursor && accentSeen.length < 5);
    expect(new Set(accentSeen)).toEqual(new Set(await fs.readdir(path.join(workspace, "accents"))));
    expect(accentSeen).toHaveLength(new Set(accentSeen).size);
  }, 30_000);
});

describe("streamed workspace file upload", () => {
  const tempRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const body = (...chunks: Buffer[]) => Readable.from(chunks);
  const length = (...chunks: Buffer[]) => chunks.reduce((total, chunk) => total + chunk.length, 0);

  it("writes UTF-8 text split mid-character across chunks, publishes the receipt and leaves no staging file", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const workspace = path.join(rootDir, "workspace");
    const port = createPort(createFilesRoutePort, rootDir);
    const text = Buffer.from(`caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x2603)} notes`, "utf8");
    const chunks = [text.subarray(0, 4), text.subarray(4, 7), text.subarray(7)];

    const uploaded = await port.uploadWorkspaceFileStream("notes/today.md", body(...chunks), {
      declaredBytes: length(...chunks),
    });

    expect(uploaded).toMatchObject({ relativePath: "notes/today.md", bytes: text.length });
    await expect(fs.readFile(path.join(workspace, "notes", "today.md"))).resolves.toEqual(text);
    await expect(fs.readdir(path.join(workspace, ".goatcitadel-uploads"))).resolves.toEqual([]);
    const listed = await port.pageWorkspaceFiles(".", 10);
    expect(listed.folders).toEqual(["notes"]);
  });

  it("refuses invalid UTF-8 and a file that appeared since the review, writing nothing", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const workspace = path.join(rootDir, "workspace");
    const port = createPort(createFilesRoutePort, rootDir);
    const binary = Buffer.from([0x68, 0x69, 0xff, 0xfe]);
    const truncated = Buffer.from(`caf${String.fromCodePoint(0xe9)}`, "utf8").subarray(0, 4);

    await expect(
      port.uploadWorkspaceFileStream("bin.dat", body(binary), { declaredBytes: binary.length }),
    ).rejects.toMatchObject({ code: "FIELD_INVALID", message: "File upload must be UTF-8 text." });
    await expect(
      port.uploadWorkspaceFileStream("cut.md", body(truncated), { declaredBytes: truncated.length }),
    ).rejects.toMatchObject({ code: "FIELD_INVALID" });
    await fs.writeFile(path.join(workspace, "taken.md"), "kept", "utf8");
    await expect(
      port.uploadWorkspaceFileStream("taken.md", body(Buffer.from("new")), { declaredBytes: 3, expectAbsent: true }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

    await expect(fs.readFile(path.join(workspace, "taken.md"), "utf8")).resolves.toBe("kept");
    await expect(fs.readdir(workspace)).resolves.toEqual(expect.not.arrayContaining(["bin.dat", "cut.md"]));
    await expect(fs.readdir(path.join(workspace, ".goatcitadel-uploads"))).resolves.toEqual([]);
  });

  it("re-checks the write jail at the move, so a folder swapped for a link mid-upload cannot redirect the file", async () => {
    const { createFilesRoutePort } = await import("./files-route-service.js");
    const rootDir = await createTempWorkspace(tempRoots);
    const workspace = path.join(rootDir, "workspace");
    const outside = path.join(rootDir, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(path.join(workspace, "docs"));
    const port = createPort(createFilesRoutePort, rootDir);
    async function* swappingBody() {
      yield Buffer.from("first ");
      await fs.rm(path.join(workspace, "docs"), { recursive: true });
      await fs.symlink(outside, path.join(workspace, "docs"), "junction");
      yield Buffer.from("second");
    }

    await expect(
      port.uploadWorkspaceFileStream("docs/escape.md", Readable.from(swappingBody()), { declaredBytes: 12 }),
    ).rejects.toThrow(/write jail/u);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    await expect(fs.readdir(path.join(workspace, ".goatcitadel-uploads"))).resolves.toEqual([]);
  });

  it("refuses an upload over the size limit by its declared length, and any target inside the staging folder", async () => {
    process.env.GOATCITADEL_MAX_FILE_UPLOAD_BYTES = "8";
    vi.resetModules();
    try {
      const { createFilesRoutePort } = await import("./files-route-service.js");
      const rootDir = await createTempWorkspace(tempRoots);
      const port = createPort(createFilesRoutePort, rootDir);

      await expect(
        port.uploadWorkspaceFileStream("big.md", body(Buffer.from("123456789")), { declaredBytes: 9 }),
      ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", details: { limitBytes: 8, relativePath: "big.md" } });
      await expect(
        port.uploadWorkspaceFileStream(".GoatCitadel-Uploads/x.md", body(Buffer.from("x")), { declaredBytes: 1 }),
      ).rejects.toMatchObject({ code: "FIELD_INVALID" });
      await expect(port.uploadWorkspaceFile(".goatcitadel-uploads/x.md", "x")).rejects.toMatchObject({
        code: "FIELD_INVALID",
      });
    } finally {
      delete process.env.GOATCITADEL_MAX_FILE_UPLOAD_BYTES;
      vi.resetModules();
    }
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
