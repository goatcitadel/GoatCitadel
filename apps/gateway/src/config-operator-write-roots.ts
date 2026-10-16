import path from "node:path";
import type { OperatorWriteRoot, RuntimeWriteProtection } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { canonicalizeOperatorWriteRoot, resolveWriteRootPreset } from "@goatcitadel/policy-engine";

const configLog = logger.child("config");

/**
 * Runtime paths that model-driven tools may never write or delete, even inside
 * an allowed root: the config directory plus the secrets, bundled Postgres, and
 * audit trees. Derived at every load and never persisted.
 */
export function buildRuntimeWriteProtection(
  rootDir: string,
  assistant: { dataDir: string; auditDir: string },
): RuntimeWriteProtection {
  const resolvedRoot = path.resolve(rootDir);
  const dataDir = path.resolve(resolvedRoot, assistant.dataDir);
  return {
    rootDir: resolvedRoot,
    protectedPaths: [
      path.join(resolvedRoot, "config"),
      path.join(dataDir, "secrets"),
      path.join(dataDir, "postgres"),
      path.resolve(resolvedRoot, assistant.auditDir),
    ],
  };
}

/**
 * Resolve and validate operator write roots. Presets are re-resolved on the
 * server, relative paths resolve against the runtime root, and entries that
 * fail the write-root safety rules (or repeat an earlier folder) are dropped
 * with a warning instead of failing startup.
 */
export function resolveOperatorWriteRoots(
  entries: readonly OperatorWriteRoot[],
  protection: RuntimeWriteProtection,
): OperatorWriteRoot[] {
  const ctx = { rootDir: protection.rootDir, protectedRuntimePaths: protection.protectedPaths };
  const seen = new Set<string>();
  const resolved: OperatorWriteRoot[] = [];
  for (const entry of entries) {
    const requestedPath = entry.preset
      ? resolveWriteRootPreset(entry.preset, ctx)
      : path.resolve(protection.rootDir, entry.path);
    const result = canonicalizeOperatorWriteRoot(requestedPath, ctx);
    if (!result.ok) {
      configLog.warn("tool-policy sandbox.operatorWriteRoots entry ignored", {
        rejection: result.rejection,
        detail: result.detail,
      });
      continue;
    }
    const key = process.platform === "win32" ? result.canonicalPath.toLowerCase() : result.canonicalPath;
    if (seen.has(key)) {
      configLog.warn("tool-policy sandbox.operatorWriteRoots duplicate entry ignored", { path: result.canonicalPath });
      continue;
    }
    seen.add(key);
    resolved.push({ ...entry, path: result.canonicalPath });
  }
  return resolved;
}
