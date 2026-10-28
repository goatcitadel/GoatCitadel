import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * An own-delivery marker lets a call past a switched-off tool group, so only the two Gateway owners that know a call
 * is GoatCitadel's own may mint one: the comms service (for a send its server-side caller marked as own) and the
 * knowledge facade (which serves only the operator's Library and Chat attachments). Any other production file that
 * names `createOwnDeliveryMarker` could hand the AI's call a marker, so this guard fails on it. The policy engine's
 * re-mint for an approved own call goes through an own-delivery.ts helper, guarded below.
 */
const MINT_TOKEN = "createOwnDeliveryMarker";
const ALLOWED_FILES = new Set([
  // The definition, and the package index's explicit re-export.
  "packages/policy-engine/src/own-delivery.ts",
  "packages/policy-engine/src/index.ts",
  // The two callers.
  "apps/gateway/src/services/comms-service.ts",
  "apps/gateway/src/services/memory-facade-service.ts",
]);

/**
 * An own call that asks first stays own once the operator approves it (P2-R4a). The policy engine records that fact
 * on the approval's `pending_action_registered` event, only from a minted marker, and re-mints a marker from it when
 * the approval runs. The two helpers are module-internal (the package index doesn't re-export them), so only the
 * engine may name them.
 */
const APPROVAL_FACT_TOKENS = ["ownDeliveryRegistrationFact", "mintOwnDeliveryFromRegistration"];
const APPROVAL_FACT_FILES = new Set([
  "packages/policy-engine/src/own-delivery.ts",
  "packages/policy-engine/src/engine.ts",
]);
/**
 * Every production file that appends a `pending_action_registered` event. Only the engine's registration may carry
 * the own fact; the others register their own action types and must never mention it. A new writer is reviewed here.
 */
const REGISTRATION_EVENT_PATTERN = /eventType:\s*"pending_action_registered"/u;
const REGISTRATION_EVENT_WRITERS = new Set([
  "packages/policy-engine/src/engine.ts",
  "apps/gateway/src/services/capability-system-service.ts",
  "apps/gateway/src/services/code-mode-aider-promotion.ts",
  "apps/gateway/src/services/integration-dry-run-gate.ts",
  // Test support for the engine's outside-root write tests; never imported by production code.
  "packages/policy-engine/src/outside-root-write.test-support.ts",
]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "out", "artifacts"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

describe("own-delivery marker mint guard", () => {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const readInventory = () =>
    ["apps", "packages"].flatMap((top) =>
      listProductionSources(resolve(repoRoot, top)).map((filePath) => ({
        relativePath: relative(repoRoot, filePath).replaceAll("\\", "/"),
        content: readFileSync(filePath, "utf8"),
      })),
    );

  it("finds createOwnDeliveryMarker only in its definition, the comms service and the knowledge facade", () => {
    const inventory = readInventory();
    // The walk really reached the files it guards.
    expect(inventory.map((file) => file.relativePath)).toEqual(expect.arrayContaining([...ALLOWED_FILES]));
    expect(() => assertMarkerMintedOnlyByOwners(inventory)).not.toThrow();
  });

  it("lets only the policy engine write the own fact on an approval and mint from it", () => {
    const inventory = readInventory();
    const engine = inventory.find((file) => file.relativePath === "packages/policy-engine/src/engine.ts");
    const index = inventory.find((file) => file.relativePath === "packages/policy-engine/src/index.ts");
    // The engine really uses both helpers, and the package index keeps them off the public surface.
    for (const token of APPROVAL_FACT_TOKENS) {
      expect(engine?.content, token).toContain(token);
      expect(index?.content, token).not.toContain(token);
    }
    expect(() => assertApprovalFactOnlyInEngine(inventory)).not.toThrow();
  });

  it("names the offending file when anything else writes or reads the approval's own fact", () => {
    expect(() =>
      assertApprovalFactOnlyInEngine([
        { relativePath: "apps/gateway/src/services/approval-runtime-service.ts", content: APPROVAL_FACT_TOKENS[1]! },
      ]),
    ).toThrow(
      "The approval's own fact is used outside the policy engine: apps/gateway/src/services/approval-runtime-service.ts",
    );
    expect(() =>
      assertApprovalFactOnlyInEngine([
        {
          relativePath: "apps/gateway/src/services/integration-dry-run-gate.ts",
          content: 'eventType: "pending_action_registered", payload: { ownDelivery: "operator_action" }',
        },
        { relativePath: "apps/gateway/src/routes/approvals.ts", content: 'eventType: "pending_action_registered"' },
      ]),
    ).toThrow(
      "The approval's own fact is used outside the policy engine: apps/gateway/src/services/integration-dry-run-gate.ts, apps/gateway/src/routes/approvals.ts",
    );
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

/**
 * The approval's own fact stays the engine's: its helpers appear only in their definition and the engine, an
 * unreviewed file never appends a registration event, and no reviewed writer but the engine mentions own delivery.
 */
function assertApprovalFactOnlyInEngine(inventory: ReadonlyArray<{ relativePath: string; content: string }>): void {
  const offenders = inventory
    .filter((file) => {
      if (APPROVAL_FACT_TOKENS.some((token) => file.content.includes(token))) {
        return !APPROVAL_FACT_FILES.has(file.relativePath);
      }
      if (!REGISTRATION_EVENT_PATTERN.test(file.content)) {
        return false;
      }
      if (!REGISTRATION_EVENT_WRITERS.has(file.relativePath)) {
        return true;
      }
      return file.relativePath !== "packages/policy-engine/src/engine.ts" && /\bownDelivery\b/u.test(file.content);
    })
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`The approval's own fact is used outside the policy engine: ${offenders.join(", ")}`);
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
