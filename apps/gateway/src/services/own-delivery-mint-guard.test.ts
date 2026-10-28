import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * An own-delivery marker lets a call past a switched-off tool group, so only the two Gateway owners that know a call
 * is GoatCitadel's own may mint one: the comms service (for a send its server-side caller marked as own) and the
 * knowledge facade (which serves only the operator's Library and Chat attachments). Any other production file that
 * names `createOwnDeliveryMarker` could hand the AI's call a marker, so this guard fails on it.
 */
const MINT_TOKEN = "createOwnDeliveryMarker";
const ALLOWED_FILES = new Set([
  // The definition. The package index re-exports it with `export *`, so it never names the symbol.
  "packages/policy-engine/src/own-delivery.ts",
  // The two callers.
  "apps/gateway/src/services/comms-service.ts",
  "apps/gateway/src/services/memory-facade-service.ts",
]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "out", "artifacts"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

describe("own-delivery marker mint guard", () => {
  it("finds createOwnDeliveryMarker only in its definition, the comms service and the knowledge facade", () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const inventory = ["apps", "packages"].flatMap((top) =>
      listProductionSources(resolve(repoRoot, top)).map((filePath) => ({
        relativePath: relative(repoRoot, filePath).replaceAll("\\", "/"),
        content: readFileSync(filePath, "utf8"),
      })),
    );
    // The walk really reached the files it guards.
    expect(inventory.map((file) => file.relativePath)).toEqual(expect.arrayContaining([...ALLOWED_FILES]));
    expect(() => assertMarkerMintedOnlyByOwners(inventory)).not.toThrow();
  });

  it("names the offending file when anything else mints a marker", () => {
    const leaked = [
      { relativePath: "apps/gateway/src/services/comms-service.ts", content: `${MINT_TOKEN}("channel_reply")` },
      { relativePath: "apps/gateway/src/routes/tools-invoke.ts", content: `import { ${MINT_TOKEN} } from "x";` },
    ];
    expect(() => assertMarkerMintedOnlyByOwners(leaked)).toThrow(
      "createOwnDeliveryMarker is used outside its owners: apps/gateway/src/routes/tools-invoke.ts",
    );
  });
});

function assertMarkerMintedOnlyByOwners(inventory: ReadonlyArray<{ relativePath: string; content: string }>): void {
  const offenders = inventory
    .filter((file) => file.content.includes(MINT_TOKEN) && !ALLOWED_FILES.has(file.relativePath))
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`${MINT_TOKEN} is used outside its owners: ${offenders.join(", ")}`);
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
