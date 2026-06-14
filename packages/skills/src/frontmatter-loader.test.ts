import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSkillMarkdown, SkillFrontmatterSchema } from "./frontmatter.js";
import { SkillsService, type SkillsLogger } from "./loader.js";

function makeLoggerSpy(): SkillsLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skills-"));
  tempRoots.push(dir);
  return dir;
}

async function writeSkill(dir: string, body: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("parseSkillMarkdown edge cases", () => {
  it("rejects missing or unterminated frontmatter", () => {
    expect(() => parseSkillMarkdown("name: Missing Fence")).toThrow(
      "SKILL.md must start with YAML frontmatter delimiter ---",
    );

    expect(() =>
      parseSkillMarkdown(`---
name: Missing Close
description: Still invalid`),
    ).toThrow("SKILL.md frontmatter closing delimiter --- not found");
  });

  it("rejects non-object frontmatter and missing required fields", () => {
    expect(() =>
      parseSkillMarkdown(`---
plain scalar
---
body`),
    ).toThrow("Invalid SKILL.md frontmatter");

    expect(() =>
      parseSkillMarkdown(`---
name: ""
description: ""
---
body`),
    ).toThrow("SKILL.md frontmatter requires name and description");
  });

  it("normalizes optional metadata forms", () => {
    const noMetadata = parseSkillMarkdown(`---
name: No Metadata
description: Has no metadata
---
body`);
    expect(noMetadata.frontmatter.metadata).toBeUndefined();

    const jsonMetadata = parseSkillMarkdown(`---
name: JSON Metadata
description: Has JSON metadata
metadata: '{"tags":["a"],"tools":["read"]}'
---
body`);
    expect(jsonMetadata.frontmatter.metadata).toEqual({ tags: ["a"], tools: ["read"] });

    const invalidJsonMetadata = parseSkillMarkdown(`---
name: Bad JSON Metadata
description: Has invalid JSON metadata
metadata: "{not json"
---
body`);
    expect(invalidJsonMetadata.frontmatter.metadata).toBeUndefined();
  });

  it("tolerates BOM-prefixed SKILL.md frontmatter", () => {
    const parsed = parseSkillMarkdown(`\uFEFF---
name: BOM Skill
description: Has a byte-order mark before the first fence
---
body`);

    expect(parsed.frontmatter.name).toBe("BOM Skill");
    expect(parsed.body).toBe("body");
  });

  it("rejects a non-array tools metadata value through the Zod schema", () => {
    expect(() =>
      parseSkillMarkdown(`---
name: Bad Tools
description: tools must be a list
metadata:
  tools: read
---
body`),
    ).toThrow(/Invalid SKILL.md frontmatter.*tools/s);
  });

  it("accepts well-formed metadata list shapes", () => {
    const parsed = parseSkillMarkdown(`---
name: Good Lists
description: All metadata lists are arrays of strings
metadata:
  tags: [a, b]
  tools: [fs.read]
  requires: [Other]
  keywords: [alpha]
---
body`);

    expect(parsed.frontmatter.metadata).toEqual({
      tags: ["a", "b"],
      tools: ["fs.read"],
      requires: ["Other"],
      keywords: ["alpha"],
    });
  });

  it("exposes a reusable SkillFrontmatterSchema that validates list shapes", () => {
    expect(
      SkillFrontmatterSchema.safeParse({
        name: "X",
        description: "Y",
        metadata: { tools: ["read"] },
      }).success,
    ).toBe(true);

    const rejected = SkillFrontmatterSchema.safeParse({
      name: "X",
      description: "Y",
      metadata: { tools: "read" },
    });
    expect(rejected.success).toBe(false);
  });
});

describe("SkillsService loader edge cases", () => {
  it("loads direct-source and child skills while ignoring invalid entries", async () => {
    const root = await makeTempDir();
    await writeSkill(
      root,
      `---
name: Direct
description: Direct source skill
metadata:
  tags: [direct]
  tools: [fs.read]
  requires: [Child]
  keywords: [direct keyword]
---
Direct body`,
    );
    await writeSkill(
      path.join(root, "child"),
      `---
name: Child
description: Child source skill
---
Child body`,
    );
    await writeSkill(
      path.join(root, "broken"),
      `---
name: Broken
---
Broken body`,
    );
    await fs.writeFile(path.join(root, "README.md"), "not a skill directory", "utf8");

    const logger = makeLoggerSpy();
    const service = new SkillsService([{ source: "workspace", dir: root }], logger);
    const loaded = await service.reload();

    expect(loaded.map((skill) => skill.name)).toEqual(["Child", "Direct"]);
    expect(service.list()).toBe(loaded);
    expect(loaded.find((skill) => skill.name === "Direct")).toMatchObject({
      skillId: "workspace:Direct",
      tags: ["direct"],
      declaredTools: ["fs.read"],
      requires: ["Child"],
      keywords: ["direct keyword"],
      instructionBody: "Direct body",
    });
  });

  it("reports a malformed SKILL.md instead of silently dropping it", async () => {
    const root = await makeTempDir();
    await writeSkill(
      path.join(root, "ok"),
      `---
name: Healthy
description: A valid skill
---
Body`,
    );
    await writeSkill(
      path.join(root, "broken"),
      `---
name: Broken
description: Missing closing fence and bad yaml
tools: [unterminated
`,
    );

    const logger = makeLoggerSpy();
    const service = new SkillsService([{ source: "managed", dir: root }], logger);
    const loaded = await service.reload();

    // The malformed skill is excluded from the catalog but surfaced via the logger.
    expect(loaded.map((skill) => skill.name)).toEqual(["Healthy"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("broken"),
      expect.objectContaining({ source: "managed" }),
    );
  });

  it("reports a non-array tools metadata shape", async () => {
    const root = await makeTempDir();
    await writeSkill(
      root,
      `---
name: BadTools
description: tools is a string, not a list
metadata:
  tools: read
---
Body`,
    );

    const logger = makeLoggerSpy();
    const service = new SkillsService([{ source: "extra", dir: root }], logger);
    const loaded = await service.reload();

    expect(loaded).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse SKILL.md"),
      expect.objectContaining({ source: "extra" }),
    );
  });

  it("returns an empty set for unreadable or missing source directories", async () => {
    const root = await makeTempDir();
    const missing = path.join(root, "missing");
    const service = new SkillsService([{ source: "managed", dir: missing }]);

    await expect(service.reload()).resolves.toEqual([]);
    expect(service.resolveActivation({ text: "@skill anything" }).selected).toEqual([]);
  });
});
