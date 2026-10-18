import path from "node:path";
import type { OperatorWriteRoot, RuntimeWriteProtection } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import {
  canonicalizeOperatorWriteRoot,
  resolveReadPathAccess,
  resolveWriteRootPreset,
} from "@goatcitadel/policy-engine";

const configLog = logger.child("config");

interface RuntimeWriteProtectionInput {
  dataDir: string;
  auditDir: string;
  database?: { bundledPostgres?: { dataDir?: string } };
}

/**
 * SQLite files beside the database: the runtime opens it in WAL mode (`-wal`,
 * `-shm`), and a rollback journal (`-journal`) appears whenever WAL is off.
 */
const SQLITE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * Runtime paths that model-driven tools may never write or delete, even inside
 * an allowed root: the config directory, the secrets, Postgres (default and
 * configured bundled data dir), and audit trees, plus the SQLite database file
 * and its sidecars, which sit directly in the data dir (often a jail root).
 * Every path is resolved through its closest existing ancestor so it matches
 * the canonical targets the write jail produces when a root or data dir sits
 * behind a symlink or junction. Derived at every load and never persisted.
 */
export function buildRuntimeWriteProtection(
  rootDir: string,
  assistant: RuntimeWriteProtectionInput,
  dbPath: string,
): RuntimeWriteProtection {
  const resolvedRoot = canonicalThroughExistingAncestor(path.resolve(rootDir));
  const dataDir = path.resolve(resolvedRoot, assistant.dataDir);
  const candidates = [
    path.join(resolvedRoot, "config"),
    path.join(dataDir, "secrets"),
    path.join(dataDir, "postgres"),
    path.resolve(resolvedRoot, assistant.auditDir),
    ...(assistant.database?.bundledPostgres?.dataDir
      ? [path.resolve(resolvedRoot, assistant.database.bundledPostgres.dataDir)]
      : []),
    ...SQLITE_FILE_SUFFIXES.map((suffix) => `${path.resolve(resolvedRoot, dbPath)}${suffix}`),
  ];
  const seen = new Set<string>();
  const protectedPaths: string[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalThroughExistingAncestor(candidate);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!seen.has(key)) {
      seen.add(key);
      protectedPaths.push(canonical);
    }
  }
  return { rootDir: resolvedRoot, protectedPaths };
}

function canonicalThroughExistingAncestor(target: string): string {
  return resolveReadPathAccess(target, [], []).resolvedPath;
}

/**
 * Resolve and validate operator write roots. Presets are re-resolved on the
 * server, relative paths resolve against the runtime root, and entries that
 * fail the write-root safety rules (or repeat an earlier folder) are dropped
 * with a warning instead of failing startup.
 */
export function resolveOperatorWriteRoots(
  entries: ReadonlyArray<Omit<OperatorWriteRoot, "path"> & { path?: string }>,
  protection: RuntimeWriteProtection,
): OperatorWriteRoot[] {
  const ctx = { rootDir: protection.rootDir, protectedRuntimePaths: protection.protectedPaths };
  const seen = new Set<string>();
  const resolved: OperatorWriteRoot[] = [];
  for (const entry of entries) {
    const configuredPath = entry.path?.trim();
    if (!entry.preset && !configuredPath) {
      configLog.warn("tool-policy sandbox.operatorWriteRoots entry ignored", { rejection: "missing_path" });
      continue;
    }
    const requestedPath = entry.preset
      ? resolveWriteRootPreset(entry.preset, ctx)
      : path.resolve(protection.rootDir, configuredPath as string);
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
