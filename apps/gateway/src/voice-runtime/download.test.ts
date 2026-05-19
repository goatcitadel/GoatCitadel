import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTempDir,
  downloadFile,
  extractGzip,
  extractTarGz,
  extractZip,
  findFileRecursive,
  runCommand,
} from "./download.js";

const tempDirs: string[] = [];

describe("voice runtime download helpers", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function makeTempDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-voice-download-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("downloads files with the expected user agent and checksum", async () => {
    const root = await makeTempDir();
    const body = Buffer.from("voice model bytes");
    const expectedSha256 = createHash("sha256").update(body).digest("hex");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const destinationPath = path.join(root, "models", "model.bin");
    await downloadFile("https://example.test/model.bin", destinationPath, expectedSha256);

    expect(await fs.readFile(destinationPath, "utf8")).toBe("voice model bytes");
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/model.bin", {
      headers: { "User-Agent": "GoatCitadel/1.0.0" },
    });
  });

  it("rejects failed downloads and checksum mismatches", async () => {
    const root = await makeTempDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Busy",
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    await expect(
      downloadFile("https://example.test/missing.bin", path.join(root, "missing.bin"), "sha"),
    ).rejects.toThrow("Download failed (503 Busy)");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => Buffer.from("wrong").buffer,
      })),
    );
    await expect(
      downloadFile("https://example.test/wrong.bin", path.join(root, "wrong.bin"), "expected"),
    ).rejects.toThrow("Checksum mismatch for wrong.bin");
  });

  it("extracts zip and gzip archives and finds nested files recursively", async () => {
    const root = await makeTempDir();
    const zipPath = path.join(root, "archive.zip");
    const zipDest = path.join(root, "zip-out");
    const gzipPath = path.join(root, "model.bin.gz");
    const gzipDest = path.join(root, "gzip-out", "model.bin");

    const zip = new AdmZip();
    zip.addFile("nested/model.txt", Buffer.from("zip model"));
    zip.writeZip(zipPath);
    await fs.writeFile(gzipPath, gzipSync(Buffer.from("gzip model")));

    await extractZip(zipPath, zipDest);
    await extractGzip(gzipPath, gzipDest);

    expect(await fs.readFile(path.join(zipDest, "nested", "model.txt"), "utf8")).toBe("zip model");
    expect(await fs.readFile(gzipDest, "utf8")).toBe("gzip model");
    expect(await findFileRecursive(zipDest, "model.txt")).toBe(path.join(zipDest, "nested", "model.txt"));
    expect(await findFileRecursive(zipDest, "missing.txt")).toBeNull();
  });

  it("runs commands, surfaces stderr failures, creates temp dirs, and invokes tar extraction", async () => {
    const root = await makeTempDir();

    expect(() => runCommand(process.execPath, ["-e", "process.exit(0)"], "node failed")).not.toThrow();
    expect(() =>
      runCommand(process.execPath, ["-e", "process.stderr.write('bad archive'); process.exit(2)"], "extract failed"),
    ).toThrow("extract failed bad archive");
    expect(() => runCommand("goatcitadel-command-that-does-not-exist", [], "missing")).toThrow();

    const created = await createTempDir("goat-voice-helper-");
    tempDirs.push(created);
    expect(path.basename(created)).toMatch(/^goat-voice-helper-/);

    await expect(extractTarGz(path.join(root, "missing.tar.gz"), path.join(root, "tar-out"))).rejects.toThrow();
  });
});
