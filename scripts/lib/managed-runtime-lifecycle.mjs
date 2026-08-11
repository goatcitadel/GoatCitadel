import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 4096;
const DEFAULT_LOCK_TIMEOUT_MS = 190_000;
const DEFAULT_STALE_HEARTBEAT_MS = 5_000;
const LOCK_HEARTBEAT_MS = 1_000;
const LOCK_OWNER_READ_RETRIES = 4;
const LOCK_OWNER_READ_RETRY_DELAY_MS = 25;
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

let cachedCurrentProcessIdentity;
let cachedLinuxBootId;

export function readManagedStateFile(filePath, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  let fileHandle;
  try {
    fileHandle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      const stat = fs.fstatSync(fileHandle);
      return {
        exists: true,
        oversized: true,
        fingerprint: `oversized:${stat.size}:${Math.trunc(stat.mtimeMs)}`,
      };
    }
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      exists: true,
      oversized: false,
      raw,
      fingerprint: fingerprintText(raw),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, oversized: false, fingerprint: null };
    }
    return { exists: true, oversized: false, unreadable: true, fingerprint: "unreadable" };
  } finally {
    if (fileHandle !== undefined) {
      fs.closeSync(fileHandle);
    }
  }
}

export function atomicCompareAndPublishJson({ filePath, value, expectedFingerprint }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = readManagedStateFile(filePath);
  if (current.fingerprint !== expectedFingerprint) {
    return { published: false, reason: "compare_conflict", currentFingerprint: current.fingerprint };
  }

  const serialized = `${JSON.stringify(value)}\n`;
  const nextFingerprint = fingerprintText(serialized);
  const tempPath = `${filePath}.publish-${process.pid}-${randomUUID()}.tmp`;
  let tempHandle;
  try {
    tempHandle = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(tempHandle, serialized, "utf8");
    fs.fsyncSync(tempHandle);
    fs.closeSync(tempHandle);
    tempHandle = undefined;

    const beforeRename = readManagedStateFile(filePath);
    if (beforeRename.fingerprint !== expectedFingerprint) {
      return { published: false, reason: "compare_conflict", currentFingerprint: beforeRename.fingerprint };
    }
    fs.renameSync(tempPath, filePath);
    const published = readManagedStateFile(filePath);
    if (published.fingerprint !== nextFingerprint) {
      return { published: false, reason: "post_publish_conflict", currentFingerprint: published.fingerprint };
    }
    return { published: true, fingerprint: nextFingerprint };
  } finally {
    if (tempHandle !== undefined) {
      fs.closeSync(tempHandle);
    }
    fs.rmSync(tempPath, { force: true });
  }
}

export function atomicCompareAndRemove({ filePath, expectedFingerprint }) {
  const current = readManagedStateFile(filePath);
  if (!current.exists) {
    return {
      removed: expectedFingerprint === null,
      reason: expectedFingerprint === null ? "already_missing" : "missing",
    };
  }
  if (current.fingerprint !== expectedFingerprint) {
    return { removed: false, reason: "compare_conflict", currentFingerprint: current.fingerprint };
  }

  const tombstonePath = `${filePath}.remove-${process.pid}-${randomUUID()}.tmp`;
  fs.renameSync(filePath, tombstonePath);
  const moved = readManagedStateFile(tombstonePath);
  if (moved.fingerprint !== expectedFingerprint) {
    if (!fs.existsSync(filePath)) {
      fs.renameSync(tombstonePath, filePath);
    }
    return { removed: false, reason: "post_move_conflict", currentFingerprint: moved.fingerprint };
  }
  fs.rmSync(tombstonePath, { force: true });
  return { removed: true };
}

export async function withManagedLifecycleLock(
  {
    lockPath,
    service,
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleHeartbeatMs = DEFAULT_STALE_HEARTBEAT_MS,
  },
  operation,
) {
  if (typeof operation !== "function") {
    throw new Error("Managed lifecycle lock operation must be a function.");
  }
  const lock = await acquireManagedLifecycleLock({
    lockPath,
    service,
    timeoutMs,
    staleHeartbeatMs,
  });
  try {
    return await operation(lock);
  } finally {
    lock.release();
  }
}

export function queryProcessCreationIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "missing" };
  }
  if (pid === process.pid && cachedCurrentProcessIdentity) {
    return { status: "running", identity: cachedCurrentProcessIdentity };
  }
  const binding = inspectProcessBinding({ rootPid: pid, servingPid: pid });
  if (binding.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (binding.status !== "verified") {
    return { status: "missing" };
  }
  if (pid === process.pid) {
    cachedCurrentProcessIdentity = binding.rootIdentity;
  }
  return { status: "running", identity: binding.rootIdentity };
}

export function inspectProcessBinding({ rootPid, servingPid, maxDepth = 64 }) {
  if (![rootPid, servingPid].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return { status: "missing" };
  }
  const ancestry = readProcessAncestry(servingPid, maxDepth, rootPid);
  if (ancestry.status !== "ok") {
    return { status: ancestry.status === "unavailable" ? "unavailable" : "missing" };
  }
  const serving = ancestry.records[0];
  if (!serving || serving.pid !== servingPid) {
    return { status: "missing" };
  }
  const root = ancestry.records.find((record) => record.pid === rootPid);
  if (!root) {
    return {
      status: "not_in_tree",
      servingIdentity: serving.identity,
    };
  }
  return {
    status: "verified",
    rootIdentity: root.identity,
    servingIdentity: serving.identity,
    depth: ancestry.records.indexOf(root),
  };
}

export async function inspectProcessBindingWithRetry(options, { attempts = 2, delayMs = 250, probe = inspectProcessBinding } = {}) {
  let binding = probe(options);
  for (let attempt = 1; binding.status === "unavailable" && attempt < attempts; attempt += 1) {
    // One unavailable identity read under host load is contention evidence,
    // not an identity verdict; a bounded re-query answers before classifying.
    await delay(delayMs);
    binding = probe(options);
  }
  return binding;
}

async function acquireManagedLifecycleLock({ lockPath, service, timeoutMs, staleHeartbeatMs }) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const processIdentity = queryProcessCreationIdentity(process.pid);
  if (processIdentity.status !== "running") {
    throw new Error(`Unable to establish the launcher process creation identity for ${service}.`);
  }
  const owner = {
    lockId: randomUUID(),
    pid: process.pid,
    processIdentity: processIdentity.identity,
    service,
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      try {
        writeLockOwner(lockPath, owner);
      } catch (error) {
        reclaimLockDirectory(lockPath, owner.lockId);
        throw error;
      }
      const heartbeat = setInterval(() => {
        owner.heartbeatAt = new Date().toISOString();
        try {
          const current = readLockOwner(lockPath);
          if (current?.lockId === owner.lockId) {
            writeLockOwner(lockPath, owner);
          }
        } catch {
          // Release or stale recovery owns the next state transition.
        }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      let released = false;
      return {
        owner: { ...owner },
        release() {
          if (released) {
            return;
          }
          released = true;
          clearInterval(heartbeat);
          const current = readLockOwner(lockPath);
          if (current?.lockId === owner.lockId) {
            reclaimLockDirectory(lockPath, `release-${owner.lockId}`);
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      const lockOwner = readLockOwner(lockPath);
      const ownerLabel = lockOwner?.pid ? ` PID ${lockOwner.pid}` : " an unknown owner";
      throw new Error(`Timed out waiting for the ${service} lifecycle lock held by${ownerLabel}.`);
    }
    if (canRecoverLifecycleLock(lockPath, staleHeartbeatMs)) {
      reclaimLockDirectory(lockPath, `stale-${randomUUID()}`);
      continue;
    }
    await delay(Math.min(100, Math.max(20, deadline - Date.now())));
  }
}

function canRecoverLifecycleLock(lockPath, staleHeartbeatMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  const ownerState = readLockOwnerState(lockPath);
  if (ownerState.state === "unreadable") {
    // A transiently unreadable owner record is contention evidence, not death.
    return false;
  }
  if (!ownerState.owner) {
    return Date.now() - stat.mtimeMs >= staleHeartbeatMs;
  }
  const owner = ownerState.owner;
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  const heartbeatAge = Number.isFinite(heartbeatAt) ? Date.now() - heartbeatAt : Number.POSITIVE_INFINITY;
  if (heartbeatAge < staleHeartbeatMs) {
    return false;
  }
  // A starved heartbeat proves only a busy event loop: launch identity probes
  // block it for multi-second windows under load. Only an owner whose PID is
  // demonstrably gone, or demonstrably reused by another process, releases the
  // lock to a waiter.
  if (!isLockOwnerAlive(owner.pid)) {
    return true;
  }
  const current = queryProcessCreationIdentity(owner.pid);
  return current.status === "running" && current.identity !== owner.processIdentity;
}

export async function inspectLifecycleLockHolder({ lockPath, service }) {
  let ownerState = readLockOwnerState(lockPath);
  for (let attempt = 0; ownerState.state === "unreadable" && attempt < LOCK_OWNER_READ_RETRIES; attempt += 1) {
    await delay(LOCK_OWNER_READ_RETRY_DELAY_MS);
    ownerState = readLockOwnerState(lockPath);
  }
  if (!ownerState.owner) {
    return { held: false, reason: `owner_${ownerState.state}` };
  }
  const owner = ownerState.owner;
  if (owner.service !== service) {
    return { held: false, reason: "service_mismatch", pid: owner.pid };
  }
  if (owner.pid === process.pid) {
    // The caller's own lock is never launch-in-progress evidence: in-lock code
    // paths keep their strict collision refusal.
    return { held: false, reason: "self_owned", pid: owner.pid };
  }
  if (!isLockOwnerAlive(owner.pid)) {
    return { held: false, reason: "owner_exited", pid: owner.pid };
  }
  const current = queryProcessCreationIdentity(owner.pid);
  if (current.status === "missing") {
    return { held: false, reason: "owner_exited", pid: owner.pid };
  }
  if (current.status === "running" && current.identity !== owner.processIdentity) {
    return { held: false, reason: "owner_pid_reused", pid: owner.pid };
  }
  return {
    held: true,
    reason: current.status === "running" ? "owner_identity_verified" : "owner_alive_identity_unverified",
    pid: owner.pid,
  };
}

function readLockOwnerState(lockPath) {
  const record = readManagedStateFile(path.join(lockPath, "owner.json"));
  if (!record.exists) {
    return { state: "missing" };
  }
  if (record.unreadable) {
    return { state: "unreadable" };
  }
  if (record.oversized || typeof record.raw !== "string") {
    return { state: "malformed" };
  }
  try {
    const owner = JSON.parse(record.raw);
    if (
      !owner ||
      typeof owner !== "object" ||
      typeof owner.lockId !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.processIdentity !== "string" ||
      typeof owner.service !== "string" ||
      typeof owner.createdAt !== "string" ||
      typeof owner.heartbeatAt !== "string"
    ) {
      return { state: "malformed" };
    }
    return { state: "owned", owner };
  } catch {
    return { state: "malformed" };
  }
}

function readLockOwner(lockPath) {
  return readLockOwnerState(lockPath).owner;
}

function isLockOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function writeLockOwner(lockPath, owner) {
  const ownerPath = path.join(lockPath, "owner.json");
  const tempPath = path.join(lockPath, `.owner-${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(tempPath, ownerPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function reclaimLockDirectory(lockPath, suffix) {
  const quarantinePath = `${lockPath}.${suffix}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "EPERM") {
      return false;
    }
    throw error;
  }
  fs.rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function readProcessAncestry(servingPid, maxDepth, stopPid) {
  if (process.platform === "win32") {
    return readWindowsProcessAncestry(servingPid, maxDepth, stopPid);
  }
  if (process.platform === "linux") {
    return readLinuxProcessAncestry(servingPid, maxDepth, stopPid);
  }
  return readPosixProcessAncestry(servingPid, maxDepth, stopPid);
}

function readWindowsProcessAncestry(servingPid, maxDepth, stopPid) {
  if (!fs.existsSync(WINDOWS_POWERSHELL)) {
    return { status: "unavailable", records: [] };
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$current = [uint32]${servingPid}`,
    `for ($index = 0; $index -lt ${maxDepth}; $index += 1) {`,
    '  $item = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $current)',
    "  if ($null -eq $item) { break }",
    "  $created = $item.CreationDate.ToUniversalTime().ToFileTimeUtc()",
    '  [Console]::Out.WriteLine(($item.ProcessId.ToString() + "|" + $item.ParentProcessId.ToString() + "|" + $created.ToString()))',
    `  if ($item.ProcessId -eq ${stopPid}) { break }`,
    "  if ($item.ParentProcessId -eq 0 -or $item.ParentProcessId -eq $item.ProcessId) { break }",
    "  $current = [uint32]$item.ParentProcessId",
    "}",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    WINDOWS_POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    return { status: "unavailable", records: [] };
  }
  const records = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, parentPid, created] = line.split("|");
      return {
        pid: Number(pid),
        parentPid: Number(parentPid),
        identity: `windows:${created}`,
      };
    })
    .filter(
      (record) =>
        Number.isSafeInteger(record.pid) &&
        record.pid > 0 &&
        Number.isSafeInteger(record.parentPid) &&
        /^windows:\d+$/u.test(record.identity),
    );
  return { status: records.length > 0 ? "ok" : "missing", records };
}

function readLinuxProcessAncestry(servingPid, maxDepth, stopPid) {
  const records = [];
  const visited = new Set();
  let currentPid = servingPid;
  for (let depth = 0; depth < maxDepth && currentPid > 0 && !visited.has(currentPid); depth += 1) {
    visited.add(currentPid);
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${currentPid}/stat`, "utf8");
    } catch (error) {
      return { status: error?.code === "ENOENT" ? "missing" : "unavailable", records };
    }
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) {
      return { status: "unavailable", records };
    }
    const pid = Number(raw.slice(0, raw.indexOf(" ")));
    const fields = raw
      .slice(closeParen + 1)
      .trim()
      .split(/\s+/u);
    const parentPid = Number(fields[1]);
    const startTicks = fields[19];
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !/^\d+$/u.test(startTicks ?? "")) {
      return { status: "unavailable", records };
    }
    records.push({
      pid,
      parentPid,
      identity: `linux:${readLinuxBootId()}:${startTicks}`,
    });
    if (pid === stopPid) {
      break;
    }
    currentPid = parentPid;
  }
  return { status: records.length > 0 ? "ok" : "missing", records };
}

function readPosixProcessAncestry(servingPid, maxDepth, stopPid) {
  const records = [];
  const visited = new Set();
  let currentPid = servingPid;
  for (let depth = 0; depth < maxDepth && currentPid > 0 && !visited.has(currentPid); depth += 1) {
    visited.add(currentPid);
    const result = spawnSync("ps", ["-p", String(currentPid), "-o", "pid=", "-o", "ppid=", "-o", "lstart="], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 16 * 1024,
    });
    if (result.error || result.status !== 0) {
      return { status: result.error ? "unavailable" : "missing", records };
    }
    const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) {
      return { status: "unavailable", records };
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    records.push({ pid, parentPid, identity: `posix:${match[3].trim()}` });
    if (pid === stopPid) {
      break;
    }
    currentPid = parentPid;
  }
  return { status: records.length > 0 ? "ok" : "missing", records };
}

function readLinuxBootId() {
  if (cachedLinuxBootId) {
    return cachedLinuxBootId;
  }
  try {
    cachedLinuxBootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    cachedLinuxBootId = "unknown-boot";
  }
  return cachedLinuxBootId;
}

function fingerprintText(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
