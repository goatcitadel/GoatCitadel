import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const WORKTREE_OUTPUT_LOCK_LEASE_ENV = "GOATCITADEL_WORKTREE_OUTPUT_LOCK_LEASE_ID";
export const WORKTREE_OUTPUT_LOCK_PATH_ENV = "GOATCITADEL_WORKTREE_OUTPUT_LOCK_PATH";
export const WORKTREE_OUTPUT_LOCK_ROOT_ENV = "GOATCITADEL_WORKTREE_OUTPUT_LOCK_ROOT";

const LOCK_RELATIVE_PATH = path.join(".tmp", "verification-build-output.lock");
const INCOMPLETE_LOCK_READ_RETRIES = 4;
const INCOMPLETE_LOCK_READ_DELAY_MS = 25;
const MALFORMED_LOCK_RECLAIM_AGE_MS = 30_000;
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;
const DEAD_OWNER_RECLAIM_AGE_MS = 15_000;

/**
 * Acquires the worktree-wide exclusion boundary shared by verification and
 * output-emitting build/typecheck commands. The lease is deliberately
 * re-entrant through environment inheritance: a verification process owns one
 * lease for its full lifecycle while every pnpm/node child validates and then
 * reuses that same lease instead of deadlocking against its parent.
 */
export async function acquireWorktreeOutputLock(options = {}) {
  const environment = options.environment ?? process.env;
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const lockPath = path.join(repoRoot, LOCK_RELATIVE_PATH);
  const inheritedToken = normalizeText(environment[WORKTREE_OUTPUT_LOCK_LEASE_ENV]);

  if (inheritedToken) {
    return await inheritWorktreeOutputLock({ environment, inheritedToken, lockPath, repoRoot });
  }

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const metadata = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    owner: normalizeText(options.owner) ?? "verification-or-build",
    startedAt: new Date().toISOString(),
    repoRoot,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      installLeaseEnvironment(environment, metadata, lockPath);
      return createOwnedLease({ environment, lockPath, metadata });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readLockMetadata(lockPath);
      if (attempt === 0 && (await canReclaimLock(existing, lockPath))) {
        const reclaimed = existing?.token
          ? await removeLockWhenTokenMatches(lockPath, existing.token)
          : await removeMalformedLock(lockPath);
        if (reclaimed) continue;
      }
      throw buildContentionError(lockPath, existing);
    }
  }

  throw new Error(`Unable to acquire the worktree verification/build-output lock at ${lockPath}.`);
}

export function worktreeOutputLockPath(repoRoot) {
  return path.join(path.resolve(repoRoot), LOCK_RELATIVE_PATH);
}

async function inheritWorktreeOutputLock({ environment, inheritedToken, lockPath, repoRoot }) {
  const inheritedPath = normalizeText(environment[WORKTREE_OUTPUT_LOCK_PATH_ENV]);
  const inheritedRoot = normalizeText(environment[WORKTREE_OUTPUT_LOCK_ROOT_ENV]);
  if (!inheritedPath || !samePath(inheritedPath, lockPath) || !inheritedRoot || !samePath(inheritedRoot, repoRoot)) {
    throw new Error(
      "Inherited worktree output-lock metadata belongs to a different worktree. " +
        "Start the command without GOATCITADEL_WORKTREE_OUTPUT_LOCK_* overrides.",
    );
  }
  const metadata = await readLockMetadata(lockPath);
  if (!metadata || metadata.token !== inheritedToken) {
    throw new Error(
      `Inherited worktree output lock is no longer valid at ${lockPath}. ` +
        "The owning verification/build process may have exited; retry the top-level command.",
    );
  }
  return {
    inherited: true,
    lockPath,
    metadata,
    async release() {},
  };
}

function createOwnedLease({ environment, lockPath, metadata }) {
  let released = false;
  const heartbeat = setInterval(() => {
    refreshLockHeartbeat(lockPath, metadata.token).catch(() => undefined);
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  return {
    inherited: false,
    lockPath,
    metadata,
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        await removeLockWhenTokenMatches(lockPath, metadata.token);
      } finally {
        clearLeaseEnvironment(environment, metadata, lockPath);
      }
    },
  };
}

async function readLockMetadata(lockPath) {
  for (let attempt = 0; attempt < INCOMPLETE_LOCK_READ_RETRIES; attempt += 1) {
    try {
      const raw = await fs.readFile(lockPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (!(error instanceof SyntaxError)) throw error;
    }
    await delay(INCOMPLETE_LOCK_READ_DELAY_MS);
  }
  return undefined;
}

async function canReclaimLock(metadata, lockPath) {
  if (!metadata) {
    const stats = await fs.stat(lockPath).catch(() => undefined);
    return Boolean(stats && Date.now() - stats.mtimeMs >= MALFORMED_LOCK_RECLAIM_AGE_MS);
  }
  if (!Number.isSafeInteger(metadata.pid) || metadata.pid <= 0) return false;
  if (normalizeText(metadata.hostname) !== os.hostname()) return false;
  if (await isProcessAlive(metadata.pid)) return false;
  const stats = await fs.stat(lockPath).catch(() => undefined);
  return Boolean(stats && Date.now() - stats.mtimeMs >= DEAD_OWNER_RECLAIM_AGE_MS);
}

async function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function removeLockWhenTokenMatches(lockPath, expectedToken) {
  if (!expectedToken) return false;
  const current = await readLockMetadata(lockPath);
  if (!current || current.token !== expectedToken) return false;
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removeMalformedLock(lockPath) {
  if (await readLockMetadata(lockPath)) return false;
  const stats = await fs.stat(lockPath).catch(() => undefined);
  if (!stats || Date.now() - stats.mtimeMs < MALFORMED_LOCK_RECLAIM_AGE_MS) return false;
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function refreshLockHeartbeat(lockPath, expectedToken) {
  const current = await readLockMetadata(lockPath);
  if (!current || current.token !== expectedToken) return;
  const now = new Date();
  await fs.utimes(lockPath, now, now);
}

function buildContentionError(lockPath, metadata) {
  const owner = normalizeText(metadata?.owner) ?? "an unknown command";
  const pid = Number.isSafeInteger(metadata?.pid) ? metadata.pid : "unknown";
  const startedAt = normalizeText(metadata?.startedAt) ?? "unknown time";
  return new Error(
    `Worktree verification/build outputs are locked by ${owner} (pid ${pid}, started ${startedAt}). ` +
      `Wait for that command to finish before retrying. Lock: ${lockPath}`,
  );
}

function installLeaseEnvironment(environment, metadata, lockPath) {
  environment[WORKTREE_OUTPUT_LOCK_LEASE_ENV] = metadata.token;
  environment[WORKTREE_OUTPUT_LOCK_PATH_ENV] = lockPath;
  environment[WORKTREE_OUTPUT_LOCK_ROOT_ENV] = metadata.repoRoot;
}

function clearLeaseEnvironment(environment, metadata, lockPath) {
  if (environment[WORKTREE_OUTPUT_LOCK_LEASE_ENV] === metadata.token) {
    delete environment[WORKTREE_OUTPUT_LOCK_LEASE_ENV];
  }
  if (samePath(environment[WORKTREE_OUTPUT_LOCK_PATH_ENV], lockPath)) {
    delete environment[WORKTREE_OUTPUT_LOCK_PATH_ENV];
  }
  if (samePath(environment[WORKTREE_OUTPUT_LOCK_ROOT_ENV], metadata.repoRoot)) {
    delete environment[WORKTREE_OUTPUT_LOCK_ROOT_ENV];
  }
}

function samePath(left, right) {
  const leftText = normalizeText(left);
  const rightText = normalizeText(right);
  if (!leftText || !rightText) return false;
  const leftPath = path.resolve(leftText);
  const rightPath = path.resolve(rightText);
  return process.platform === "win32" ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

function normalizeText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
