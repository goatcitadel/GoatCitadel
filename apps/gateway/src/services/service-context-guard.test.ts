import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SERVICES_DIR = new URL(".", import.meta.url);
const SERVICE_CONTEXT_GUARD_EXCLUDED_PATHS = new Set([
  "gateway-service.ts",
  "service-context.ts",
  "gateway/build-service-context.ts",
]);

const DIRECT_SERVICE_CONTEXT_PATTERN = /\bprivate\s+readonly\s+\w+\s*:\s*ServiceContext\b/m;

async function collectServiceFiles(dir: URL, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectServiceFiles(new URL(`${entry.name}/`, dir), relativePath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    files.push(relativePath);
  }

  return files;
}

describe("service context guard", () => {
  it("does not allow bare ServiceContext service fields outside transitional infrastructure", async () => {
    const files = await collectServiceFiles(SERVICES_DIR);
    const offenders: string[] = [];

    for (const relativePath of files) {
      if (SERVICE_CONTEXT_GUARD_EXCLUDED_PATHS.has(relativePath)) {
        continue;
      }
      const source = await fs.readFile(new URL(relativePath, SERVICES_DIR), "utf8");
      if (DIRECT_SERVICE_CONTEXT_PATTERN.test(source)) {
        offenders.push(relativePath);
      }
    }
    offenders.sort();
    expect(offenders).toEqual([]);
  });
});
