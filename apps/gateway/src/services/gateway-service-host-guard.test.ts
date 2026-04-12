import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SERVICES_DIR = new URL(".", import.meta.url);
const HOST_GUARD_EXCLUDED_PATHS = new Set([
  "gateway-service.ts",
  "service-context.ts",
  "gateway/build-service-context.ts",
]);

const HOST_COUPLING_PATTERNS = [
  /import\s+type\s+\{\s*GatewayService\s*\}\s+from\s+"\.\/gateway-service\.js";/m,
  /type\s+\w+Host\s*=\s*GatewayService\b/m,
  /GatewayService\["[^"]+"\]/m,
];

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

describe("gateway service host guard", () => {
  it("does not allow GatewayService host coupling outside gateway-service.ts", async () => {
    const files = await collectServiceFiles(SERVICES_DIR);
    const offenders: string[] = [];

    for (const relativePath of files) {
      if (HOST_GUARD_EXCLUDED_PATHS.has(relativePath)) {
        continue;
      }
      const source = await fs.readFile(new URL(relativePath, SERVICES_DIR), "utf8");
      if (HOST_COUPLING_PATTERNS.some((pattern) => pattern.test(source))) {
        offenders.push(relativePath);
      }
    }

    offenders.sort();
    expect(offenders).toEqual([]);
  });
});
