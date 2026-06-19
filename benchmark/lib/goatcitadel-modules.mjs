// Central import map for the SHIPPED GoatCitadel logic the in-process scenarios
// assert against. Importing built dist/ (rather than re-implementing the rules)
// is what makes the benchmark prove the product's real enforcement code.
//
// Keys are stable logical names; values are absolute paths to built dist modules.
// If dist is missing the import throws a clear, actionable error (the runner turns
// that into a SKIP via the target.distReady gate, so a missing build never reads
// as a competitive loss).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./targets.mjs";

const MODULE_MAP = Object.freeze({
  "contracts/citadel-wards": ["packages", "contracts", "dist", "citadel-wards.js"],
  "contracts/channel-access": ["packages", "contracts", "dist", "channel-access.js"],
  "gateway/dry-run-commit-service": ["apps", "gateway", "dist", "services", "dry-run-commit-service.js"],
  "gateway/durable-run-service": ["apps", "gateway", "dist", "services", "durable-run-service.js"],
  "gateway/process-tree-killer": ["apps", "gateway", "dist", "services", "process-tree-killer.js"],
});

/** Resolve a logical module name to its absolute built path. */
export function resolveGoatCitadelModule(name) {
  const segments = MODULE_MAP[name];
  if (!segments) {
    throw new Error(`Unknown GoatCitadel module '${name}'. Known: ${Object.keys(MODULE_MAP).join(", ")}`);
  }
  return path.join(repoRoot, ...segments);
}

/** Dynamically import a shipped GoatCitadel dist module by logical name. */
export async function importGoatCitadel(name) {
  const filePath = resolveGoatCitadelModule(name);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `GoatCitadel module '${name}' is not built (${filePath}). ` +
        "Run `pnpm --filter @goatcitadel/gateway... build` from the repo root.",
    );
  }
  return import(pathToFileURL(filePath).href);
}
