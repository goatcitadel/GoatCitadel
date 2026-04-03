import path from "node:path";
import { repoHasConfigMarker } from "./config-files.js";
import { syncUnifiedConfig } from "./config-sync-lib.js";

async function main() {
  const rootDir = detectRootDir();
  const result = await syncUnifiedConfig(rootDir, { createUnifiedIfMissing: true });

  const lines: string[] = [];
  lines.push(`root: ${rootDir}`);
  lines.push(`unified: ${result.unifiedPath}`);
  lines.push(`created unified: ${result.createdUnified ? "yes" : "no"}`);
  lines.push(
    `materialized examples: ${result.materializedExamples.length > 0 ? result.materializedExamples.join(", ") : "none"}`,
  );
  lines.push(
    `synced sections: ${result.syncedSections.length > 0 ? result.syncedSections.join(", ") : "none"}`,
  );

  console.log(lines.join("\n"));
}

function detectRootDir(): string {
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }

  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
  ];

  for (const candidate of candidates) {
    if (repoHasConfigMarker(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), "../..");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
