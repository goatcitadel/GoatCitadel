import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Relief is minted only by the Gateway's relief helper, from server-owned state. Any other production file that names
 * `createMcpApprovalRelief` could hand the policy engine a relief nobody checked, so this guard fails on it.
 */
const MINT_TOKEN = "createMcpApprovalRelief";
const ALLOWED_FILES = new Set([
  // The definition and the policy-engine package's own re-export.
  "packages/policy-engine/src/mcp-approval-relief.ts",
  "packages/policy-engine/src/index.ts",
  // The one caller: it reads the saved setting, the stored labels and the install's profile first.
  "apps/gateway/src/services/mcp-approval-relief.ts",
]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "out", "artifacts"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

describe("MCP approval relief mint guard", () => {
  it("finds createMcpApprovalRelief only in its definition, its re-export and the Gateway relief helper", () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const inventory = ["apps", "packages"].flatMap((top) =>
      listProductionSources(resolve(repoRoot, top)).map((filePath) => ({
        relativePath: relative(repoRoot, filePath).replaceAll("\\", "/"),
        content: readFileSync(filePath, "utf8"),
      })),
    );
    // The walk really reached the files it guards.
    expect(inventory.map((file) => file.relativePath)).toEqual(expect.arrayContaining([...ALLOWED_FILES]));
    expect(() => assertReliefMintedOnlyByGateway(inventory)).not.toThrow();
  });

  it("names the offending file when anything else mints a relief", () => {
    const leaked = [
      { relativePath: "apps/gateway/src/services/mcp-approval-relief.ts", content: `${MINT_TOKEN}({})` },
      { relativePath: "apps/gateway/src/routes/mcp.ts", content: `import { ${MINT_TOKEN} } from "x";` },
    ];
    expect(() => assertReliefMintedOnlyByGateway(leaked)).toThrow(
      "createMcpApprovalRelief is used outside the Gateway relief helper: apps/gateway/src/routes/mcp.ts",
    );
  });
});

function assertReliefMintedOnlyByGateway(inventory: ReadonlyArray<{ relativePath: string; content: string }>): void {
  const offenders = inventory
    .filter((file) => file.content.includes(MINT_TOKEN) && !ALLOWED_FILES.has(file.relativePath))
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`${MINT_TOKEN} is used outside the Gateway relief helper: ${offenders.join(", ")}`);
  }
}

/** Production TypeScript under a directory: no tests, declarations, builds or installed packages. */
function listProductionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".") ? [] : listProductionSources(fullPath);
    }
    if (
      !entry.isFile() ||
      !SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ||
      /\.(test|spec|vitest)\.[cm]?tsx?$/u.test(entry.name) ||
      entry.name.endsWith(".d.ts")
    ) {
      return [];
    }
    return [fullPath];
  });
}
