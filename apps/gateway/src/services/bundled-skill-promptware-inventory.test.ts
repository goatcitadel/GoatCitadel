import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanPromptwareContent } from "./assembled-prompt-injection-guard.js";

const BUNDLED_SKILLS_ROOT = path.resolve(import.meta.dirname, "../../../../skills/bundled");

describe("bundled runtime skill promptware inventory", () => {
  it("keeps every bundled model-facing Markdown and text source clean", () => {
    const findings = listModelFacingFiles(BUNDLED_SKILLS_ROOT).flatMap((fullPath) => {
      const sourcePath = path.relative(BUNDLED_SKILLS_ROOT, fullPath).replaceAll("\\", "/");
      return scanPromptwareContent({
        source: "imported_skill",
        sourcePath,
        content: fs.readFileSync(fullPath, "utf8"),
      }).map((finding) => ({ sourcePath, ruleId: finding.ruleId, line: finding.startLine }));
    });

    expect(findings).toEqual([]);
  });
});

function listModelFacingFiles(root: string): string[] {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile() && /\.(?:md|txt)$/iu.test(entry.name)) files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}
