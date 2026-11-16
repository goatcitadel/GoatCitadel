import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Holds the next read of a chosen file after it read the disk, until released. */
const gate = vi.hoisted(() => ({
  file: undefined as string | undefined,
  release: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = (await original<{ default: typeof import("node:fs/promises") }>()).default;
  const readFile = (async (target: string, options: unknown) => {
    const result = await actual.readFile(target, options as never);
    if (gate.file && path.resolve(target) === path.resolve(gate.file)) {
      gate.file = undefined;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    }
    return result;
  }) as typeof actual.readFile;
  const patched = { ...actual, readFile };
  return { ...patched, default: patched };
});

const { SkillsService } = await import("./loader.js");

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SkillsService reloads that finish out of order", () => {
  it("keeps the list of the reload that started last", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skills-order-"));
    tempRoots.push(root);
    await fs.mkdir(path.join(root, "demo"));
    await fs.writeFile(path.join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nBody\n", "utf8");
    const service = new SkillsService([{ source: "extra", dir: root }], { warn: vi.fn(), error: vi.fn() });

    // Reload A reads the skill while it is still there, and is held before it finishes.
    gate.file = path.join(root, "demo", "SKILL.md");
    const stale = service.reload();
    await vi.waitFor(() => expect(gate.release).toBeDefined());
    // The skill's folder goes; reload B starts after that and finishes first.
    await fs.rm(path.join(root, "demo"), { recursive: true, force: true });
    const fresh = await service.reload();
    expect(fresh.map((skill) => skill.skillId)).toEqual([]);

    gate.release!();
    const staleResult = await stale;

    // A started before B, so its older read never replaces B's.
    expect(service.list().map((skill) => skill.skillId)).toEqual([]);
    expect(staleResult.map((skill) => skill.skillId)).toEqual([]);
  });
});
