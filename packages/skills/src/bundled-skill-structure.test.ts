import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "./frontmatter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, "../../../skills/bundled");

// The bundled skills adapted from public skill repos share one skeleton (see the native skill imports plan).
const ADAPTED_SKILLS = [
  "debugging",
  "tdd",
  "grilling",
  "codebase-design",
  "receiving-code-review",
  "secure-coding",
  "source-driven-development",
  "ponytail",
  "spec-driven-development",
];
const REQUIRED_SECTIONS = [
  "## When to use",
  "## When not to use",
  "## What the operator decides",
  "## Output",
  "## Boundaries",
];
const SHELL_POLICY_LINE = "Commands run through `shell.exec` under the operator's shell policy and approvals.";

function read(name: string): string {
  return fs.readFileSync(path.join(bundledDir, name, "SKILL.md"), "utf8");
}

describe("adapted bundled skill structure", () => {
  it.each(ADAPTED_SKILLS)("%s has every skeleton section", (name) => {
    const raw = read(name);
    for (const section of REQUIRED_SECTIONS) {
      expect(raw, `${name} is missing ${section}`).toMatch(new RegExp(`^${section}$`, "mu"));
    }
  });

  it.each(ADAPTED_SKILLS)("%s states the shell policy when it declares shell.exec", (name) => {
    const raw = read(name);
    if (parseSkillMarkdown(raw).frontmatter.metadata?.tools?.includes("shell.exec")) {
      expect(raw).toContain(SHELL_POLICY_LINE);
    }
  });
});
