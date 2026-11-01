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

/** Drop fenced code blocks (``` or ~~~, closed by the same character at least as long), so examples cannot satisfy a check. */
function withoutFencedCode(markdown: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence === undefined) {
      if (marker) fence = marker;
      else kept.push(line);
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = undefined;
    }
  }
  return kept.join("\n");
}

describe("adapted bundled skill structure", () => {
  it("does not count headings or the shell policy line inside fenced code", () => {
    const fenced = ["```", "## Output", SHELL_POLICY_LINE, "```", "~~~~md", "## Boundaries", "~~~~"].join("\n");
    const prose = withoutFencedCode(`${fenced}\n## Output\n`);
    expect(prose).not.toContain("## Boundaries");
    expect(prose).not.toContain(SHELL_POLICY_LINE);
    expect(prose).toMatch(/^## Output$/mu);
  });

  it.each(ADAPTED_SKILLS)("%s has every skeleton section", (name) => {
    const prose = withoutFencedCode(read(name));
    for (const section of REQUIRED_SECTIONS) {
      expect(prose, `${name} is missing ${section}`).toMatch(new RegExp(`^${section}$`, "mu"));
    }
  });

  it.each(ADAPTED_SKILLS)("%s states the shell policy when it declares shell.exec", (name) => {
    const raw = read(name);
    if (parseSkillMarkdown(raw).frontmatter.metadata?.tools?.includes("shell.exec")) {
      expect(withoutFencedCode(raw)).toContain(SHELL_POLICY_LINE);
    }
  });
});
