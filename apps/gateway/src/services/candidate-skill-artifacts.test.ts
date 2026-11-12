import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeImmutableBundle } from "./candidate-skill-artifacts.js";

const roots: string[] = [];

async function makeBundle() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "goat-candidate-artifacts-"));
  roots.push(root);
  return { root, bundle: path.join(root, "candidate", "version") };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("writeImmutableBundle", () => {
  it("leaves the final artifact absent if its first write is interrupted and accepts an identical retry", async () => {
    const { root, bundle } = await makeBundle();
    const instructions = "# Sample skill\n\nKeep a daily checklist.\n";
    const target = path.join(bundle, "SKILL.md");
    const interrupted = new Error("Synthetic interruption during artifact write");
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
        await file.writeFile("# Sample", "utf8");
        throw interrupted;
      });
      return file;
    });

    await expect(writeImmutableBundle(root, bundle, { "SKILL.md": instructions })).rejects.toBe(interrupted);
    openSpy.mockRestore();
    await expect(fs.readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writeImmutableBundle(root, bundle, { "SKILL.md": instructions })).resolves.toBeUndefined();
    await expect(fs.readFile(target, "utf8")).resolves.toBe(instructions);
  });

  it("preserves complete conflicting artifacts", async () => {
    const { root, bundle } = await makeBundle();
    await writeImmutableBundle(root, bundle, { "SKILL.md": "# Existing draft\n" });

    await expect(writeImmutableBundle(root, bundle, { "SKILL.md": "# Conflicting draft\n" })).rejects.toThrow(
      "does not match the reviewed immutable bytes",
    );
    await expect(fs.readFile(path.join(bundle, "SKILL.md"), "utf8")).resolves.toBe("# Existing draft\n");
  });

  it("reports an incomplete legacy bundle without changing its existing bytes", async () => {
    const { root, bundle } = await makeBundle();
    const manifest = '{"name":"sample"}';
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, "manifest.json"), manifest);

    await expect(
      writeImmutableBundle(root, bundle, { "manifest.json": manifest, "SKILL.md": "# Sample draft\n" }),
    ).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("incomplete") });
    await expect(fs.readFile(path.join(bundle, "manifest.json"), "utf8")).resolves.toBe(manifest);
    await expect(fs.readdir(bundle)).resolves.toEqual(["manifest.json"]);
  });

  it("keeps the winning complete bundle when two writers publish concurrently", async () => {
    const { root, bundle } = await makeBundle();
    const rename = fs.rename.bind(fs);
    const ready = Promise.withResolvers<void>();
    let readyWriters = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (++readyWriters === 2) ready.resolve();
      await ready.promise;
      return rename(...args);
    });
    const drafts = ["# First draft\n", "# Other draft\n"];

    const outcomes = await Promise.allSettled(
      drafts.map((draft) => writeImmutableBundle(root, bundle, { "SKILL.md": draft })),
    );

    const winner = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(outcomes[1 - winner]).toMatchObject({ status: "rejected", reason: { httpStatus: 409 } });
    await expect(fs.readFile(path.join(bundle, "SKILL.md"), "utf8")).resolves.toBe(drafts[winner]);
    await expect(fs.readdir(path.dirname(bundle))).resolves.toEqual([path.basename(bundle)]);
  });
});
