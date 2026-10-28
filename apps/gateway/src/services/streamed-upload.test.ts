import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { commitStagedUpload, receiveUpload } from "./streamed-upload.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-streamed-upload-"));
  tempRoots.push(dir);
  return dir;
}

function chunked(...parts: string[]): Readable {
  return Readable.from(parts.map((part) => Buffer.from(part)));
}

describe("receiveUpload", () => {
  it("streams the body into a staging file and reports its size, hash and head", async () => {
    const root = await tempDir();
    const stagingDir = path.join(root, "staging");
    const staged = await receiveUpload(chunked("hello ", "world"), { stagingDir, maxBytes: 100, declaredBytes: 11 });

    expect(staged.bytes).toBe(11);
    expect(staged.sha256).toBe(createHash("sha256").update("hello world").digest("hex"));
    expect(staged.head.toString()).toBe("hello world");
    await expect(fs.readFile(staged.stagingPath, "utf8")).resolves.toBe("hello world");
  });

  it("refuses a declared length over the limit before reading or staging anything", async () => {
    const root = await tempDir();
    const stagingDir = path.join(root, "staging");
    const body = chunked("x".repeat(20));

    await expect(receiveUpload(body, { stagingDir, maxBytes: 10, declaredBytes: 20 })).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(body.readableEnded).toBe(false);
    await expect(fs.readdir(stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a body shorter or longer than its declared length and removes the staging file", async () => {
    const root = await tempDir();
    const stagingDir = path.join(root, "staging");

    await expect(
      receiveUpload(chunked("short"), { stagingDir, maxBytes: 100, declaredBytes: 10 }),
    ).rejects.toMatchObject({
      code: "FIELD_INVALID",
    });
    await expect(
      receiveUpload(chunked("too long"), { stagingDir, maxBytes: 100, declaredBytes: 3 }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    await expect(fs.readdir(stagingDir)).resolves.toEqual([]);
  });

  it("drains the rest of the body after a rejected chunk, then rejects and cleans up", async () => {
    const root = await tempDir();
    const stagingDir = path.join(root, "staging");
    const body = chunked("good", "bad!", "more");
    const seen: string[] = [];
    const rejection = new Error("bad chunk");

    await expect(
      receiveUpload(body, {
        stagingDir,
        maxBytes: 100,
        declaredBytes: 12,
        inspect: (chunk) => {
          seen.push(chunk.toString());
          if (chunk.toString() === "bad!") throw rejection;
        },
      }),
    ).rejects.toBe(rejection);
    expect(seen).toEqual(["good", "bad!"]);
    expect(body.readableEnded).toBe(true);
    await expect(fs.readdir(stagingDir)).resolves.toEqual([]);
  });

  it("rejects a body whose hash differs from the declared SHA-256", async () => {
    const root = await tempDir();
    const stagingDir = path.join(root, "staging");

    await expect(
      receiveUpload(chunked("hello"), { stagingDir, maxBytes: 100, declaredBytes: 5, expectedSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "FIELD_INVALID", message: expect.stringMatching(/SHA-256/u) });
    await expect(fs.readdir(stagingDir)).resolves.toEqual([]);
  });

  it("sweeps staging files older than an hour", async () => {
    const root = await tempDir();
    const stagingDir = path.join(root, "staging");
    await fs.mkdir(stagingDir);
    const stale = path.join(stagingDir, "left-behind.upload");
    const recent = path.join(stagingDir, "in-flight.upload");
    await fs.writeFile(stale, "old");
    await fs.writeFile(recent, "new");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

    const staged = await receiveUpload(chunked("x"), { stagingDir, maxBytes: 10, declaredBytes: 1 });

    expect((await fs.readdir(stagingDir)).sort()).toEqual(
      [path.basename(staged.stagingPath), "in-flight.upload"].sort(),
    );
  });
});

describe("commitStagedUpload", () => {
  it("moves the staged file into place, replacing an existing file", async () => {
    const root = await tempDir();
    const staged = await receiveUpload(chunked("new"), {
      stagingDir: path.join(root, "s"),
      maxBytes: 10,
      declaredBytes: 3,
    });
    const target = path.join(root, "docs", "note.md");
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, "old");

    await expect(commitStagedUpload(staged.stagingPath, target)).resolves.toBe("written");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("new");
    await expect(fs.stat(staged.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rewrites an existing file in place, keeping its hard links and permission bits", async () => {
    const root = await tempDir();
    const target = path.join(root, "script.sh");
    const alias = path.join(root, "alias.sh");
    await fs.writeFile(target, "old");
    await fs.chmod(target, 0o700);
    await fs.link(target, alias);
    const modeBefore = (await fs.stat(target)).mode & 0o777;
    const staged = await receiveUpload(chunked("new"), {
      stagingDir: path.join(root, "s"),
      maxBytes: 10,
      declaredBytes: 3,
    });

    await expect(commitStagedUpload(staged.stagingPath, target)).resolves.toBe("written");
    await expect(fs.readFile(alias, "utf8")).resolves.toBe("new");
    expect((await fs.stat(target)).mode & 0o777).toBe(modeBefore);
    await expect(fs.readdir(path.join(root, "s"))).resolves.toEqual([]);
  });

  it("refuses the move when the target check fails at commit time, and removes the staged file", async () => {
    const root = await tempDir();
    const staged = await receiveUpload(chunked("x"), {
      stagingDir: path.join(root, "s"),
      maxBytes: 10,
      declaredBytes: 1,
    });
    const refusal = new Error("outside the write jail");

    await expect(
      commitStagedUpload(staged.stagingPath, path.join(root, "out", "x.md"), {
        assertTarget: () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    await expect(fs.stat(path.join(root, "out", "x.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(path.join(root, "s"))).resolves.toEqual([]);
  });

  it("never replaces a file that exists when the upload expects none", async () => {
    const root = await tempDir();
    const target = path.join(root, "note.md");
    const fresh = await receiveUpload(chunked("first"), {
      stagingDir: path.join(root, "s"),
      maxBytes: 10,
      declaredBytes: 5,
    });
    await expect(commitStagedUpload(fresh.stagingPath, target, { expectAbsent: true })).resolves.toBe("written");

    const late = await receiveUpload(chunked("second"), {
      stagingDir: path.join(root, "s"),
      maxBytes: 10,
      declaredBytes: 6,
    });
    await expect(commitStagedUpload(late.stagingPath, target, { expectAbsent: true })).resolves.toBe("exists");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("first");
    await expect(fs.readdir(path.join(root, "s"))).resolves.toEqual([]);
  });
});
