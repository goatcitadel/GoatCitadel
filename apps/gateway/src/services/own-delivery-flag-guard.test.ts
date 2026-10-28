import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The marker mint is guarded by own-delivery-mint-guard.test.ts, but the trust boundary sits one step earlier: the
 * comms service mints for any caller that passes the server-only own-delivery option, the channel queue honors a
 * top-level `ownDelivery: true` on its payload, and connector deliveries trust the `ownDelivery` fact the Gateway
 * stamps when it enqueues an autonomous reply. This guard pins the files allowed to produce or read those facts, so a
 * new caller (say, one passing a request body or tool args as the option) has to be reviewed and added here.
 */
const GUARDED_REFERENCES: ReadonlyArray<{ name: string; pattern: RegExp; allowed: ReadonlySet<string> }> = [
  {
    name: "OWN_DELIVERY",
    pattern: /\bOWN_DELIVERY\b/u,
    allowed: new Set([
      // The definition.
      "apps/gateway/src/services/comms-service.ts",
      // Operator routes (P2-R6, P2-R18).
      "apps/gateway/src/routes/comms.ts",
      "apps/gateway/src/routes/communications.ts",
      // The compose path, the operator's approved Communications sends, connector deliveries, inbound replies and
      // the watchdog notice (P2-R3, P2-R4).
      "apps/gateway/src/services/chat-turn-dispatch-service.ts",
      "apps/gateway/src/services/communications-approval-effect-service.ts",
      "apps/gateway/src/services/durable-execution-service.ts",
      "apps/gateway/src/services/gateway-service.ts",
    ]),
  },
  {
    name: "ownDelivery: true",
    pattern: /\bownDelivery:\s*true\b/u,
    allowed: new Set([
      // OWN_DELIVERY itself.
      "apps/gateway/src/services/comms-service.ts",
      // The queued payload's internal flag and its read-back.
      "apps/gateway/src/services/gateway/channel-delivery-helpers.ts",
      // The autonomous reply's connector delivery metadata, stamped at enqueue time (P2-R19).
      "apps/gateway/src/services/gateway-service.ts",
    ]),
  },
  {
    name: "readChannelDeliveryOwnDelivery",
    pattern: /\breadChannelDeliveryOwnDelivery\b/u,
    allowed: new Set([
      "apps/gateway/src/services/gateway/channel-delivery-helpers.ts",
      "apps/gateway/src/services/channel-delivery-part-service.ts",
    ]),
  },
  {
    name: "readConnectorDeliveryOwnership",
    pattern: /\breadConnectorDeliveryOwnership\b/u,
    allowed: new Set(["apps/gateway/src/services/durable-execution-service.ts"]),
  },
  {
    name: "isOwnAutonomousDelivery",
    pattern: /\bisOwnAutonomousDelivery\b/u,
    allowed: new Set([
      "apps/gateway/src/services/autonomous-delivery-ownership.ts",
      "apps/gateway/src/services/gateway-service.ts",
    ]),
  },
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "out", "artifacts"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

describe("own-delivery option and flag guard", () => {
  it("finds the own-delivery option, flag and readers only in their reviewed files", () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const inventory = ["apps", "packages"].flatMap((top) =>
      listProductionSources(resolve(repoRoot, top)).map((filePath) => ({
        relativePath: relative(repoRoot, filePath).replaceAll("\\", "/"),
        content: readFileSync(filePath, "utf8"),
      })),
    );
    // The walk really reached every file it guards, and each still uses its reference.
    for (const reference of GUARDED_REFERENCES) {
      for (const allowed of reference.allowed) {
        const file = inventory.find((candidate) => candidate.relativePath === allowed);
        expect(file?.content, `${reference.name} in ${allowed}`).toMatch(reference.pattern);
      }
    }
    expect(() => assertOwnDeliveryReferencesReviewed(inventory)).not.toThrow();
  });

  it("names the offending file when anything else produces or reads the fact", () => {
    const leaked = [
      { relativePath: "apps/gateway/src/services/comms-service.ts", content: "OWN_DELIVERY" },
      { relativePath: "apps/gateway/src/routes/tools-invoke.ts", content: "commsSend(input, { ownDelivery: true })" },
    ];
    expect(() => assertOwnDeliveryReferencesReviewed(leaked)).toThrow(
      "ownDelivery: true is used outside its reviewed files: apps/gateway/src/routes/tools-invoke.ts",
    );
  });
});

function assertOwnDeliveryReferencesReviewed(
  inventory: ReadonlyArray<{ relativePath: string; content: string }>,
): void {
  for (const reference of GUARDED_REFERENCES) {
    const offenders = inventory
      .filter((file) => reference.pattern.test(file.content) && !reference.allowed.has(file.relativePath))
      .map((file) => file.relativePath);
    if (offenders.length > 0) {
      throw new Error(`${reference.name} is used outside its reviewed files: ${offenders.join(", ")}`);
    }
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
