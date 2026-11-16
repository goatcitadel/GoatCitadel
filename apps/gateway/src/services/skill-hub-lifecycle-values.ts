import { createHash } from "node:crypto";
import path from "node:path";
import { ConflictError } from "@goatcitadel/contracts";
import type { SkillHubSnapshotRecord } from "@goatcitadel/storage";
import {
  PROMPTWARE_SCANNER_ID,
  PROMPTWARE_SCANNER_REVISION,
  PROMPTWARE_SCANNER_VERSION,
} from "./assembled-prompt-injection-guard.js";

// Small pure helpers of the Skill Hub lifecycle service: paths inside its managed roots, hashes, settlement result
// values and the check's promptware audit. Nothing here reads or writes state.

export function resolveManagedRoot(rootDir: string, configured: string, label: string): string {
  const resolved = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(rootDir, configured);
  const relative = path.relative(rootDir, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`Skill Hub ${label} must stay inside the Gateway root.`);
  }
  return resolved;
}

export function toRootRelative(rootDir: string, target: string): string {
  return path.relative(rootDir, target).split(path.sep).join("/");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasCurrentPromptwareAudit(snapshot: SkillHubSnapshotRecord): boolean {
  const scanners = snapshot.audit.scanners;
  if (!Array.isArray(scanners)) return false;
  return scanners.some((scanner) => {
    if (!isRecord(scanner) || !Array.isArray(scanner.coverageIds)) return false;
    const coverageIds = scanner.coverageIds;
    return (
      scanner.scannerId === PROMPTWARE_SCANNER_ID &&
      scanner.scannerVersion === PROMPTWARE_SCANNER_VERSION &&
      typeof scanner.revision === "number" &&
      scanner.revision >= PROMPTWARE_SCANNER_REVISION &&
      ["exact_bytes", "model_facing_md_txt", "multiline", "protective_negation"].every((coverageId) =>
        coverageIds.includes(coverageId),
      )
    );
  });
}

/** The check's SKILL.md name must make exactly the approved skill id. */
export function assertSkillIdentity(skillId: string, name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(name) || skillId !== `extra:${name}`) {
    throw new ConflictError({ message: "Skill Hub SKILL.md identity does not match the approved runtime skill ID." });
  }
}

export function assertRevisionExpectation(
  label: string,
  actual: number | undefined,
  expected: number | undefined,
  expectedAbsent: boolean,
): void {
  if ((expectedAbsent && actual !== undefined) || (!expectedAbsent && actual !== expected)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Skill Hub ${label} revision is stale.`,
      details: { expectedState: expectedAbsent ? "absent" : expected, currentRevision: actual },
    });
  }
}
