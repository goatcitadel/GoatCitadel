import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const execFileAsync = promisify(execFile);

describe("config indexed-array mutation surface", () => {
  it("has no runtime JSON-patch style API that can widen array-indexed config consent", async () => {
    const runtimeFiles = await collectRuntimeSourceFiles([
      path.join(repoRoot, "apps", "gateway", "src"),
      path.join(repoRoot, "packages", "contracts", "src"),
      path.join(repoRoot, "packages", "policy-engine", "src"),
    ]);
    const findings: string[] = [];
    const forbiddenPatterns = [
      { label: "replace-path list", pattern: /\breplace_?paths?\b/i },
      { label: "JSON Patch helper", pattern: /\bjson-?patch\b/i },
      { label: "config patch path helper", pattern: /\bpatchConfigPath\b/i },
      {
        label: "array-indexed runtime config path",
        pattern: /\/(?:providers|models|tools|channels|connectors|integrations)\/\d+(?:\/|$)/i,
      },
    ];

    for (const batch of chunk(runtimeFiles, 64)) {
      const sources = await Promise.all(batch.map(async (file) => ({ file, source: await fs.readFile(file, "utf8") })));
      for (const { file, source } of sources) {
        for (const { label, pattern } of forbiddenPatterns) {
          if (pattern.test(source)) {
            findings.push(`${toGitPath(path.relative(repoRoot, file))}: ${label}`);
          }
        }
      }
    }

    expect(findings).toEqual([]);
  });
});

async function collectRuntimeSourceFiles(roots: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...roots.map((root) => toGitPath(path.relative(repoRoot, root))),
    ],
    {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(isRuntimeSourceFile)
    .map((file) => path.join(repoRoot, file));
}

function isRuntimeSourceFile(file: string): boolean {
  return (
    (file.endsWith(".ts") || file.endsWith(".tsx")) &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".coverage.ts") &&
    !file.endsWith(".coverage.test.ts")
  );
}

function toGitPath(file: string): string {
  return file.split(path.sep).join("/");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
