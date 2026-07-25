import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";
import { repoHasConfigMarker } from "./config-files.js";

const ENV_FILE_MODE = 0o600;

const envFileLog = logger.child("env-file");

/**
 * Atomic + owner-only write for credential files. Writes to a sibling temp file
 * with O_CREAT|O_EXCL|O_WRONLY at 0600, then renames over the target.
 * Restores 0600 on the renamed target on POSIX; no-op on win32 where chmod
 * does not map to ACLs.
 */
function writeCredentialFileAtomicSync(targetPath: string, contents: string): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tempPath = path.join(dir, `.${base}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, ENV_FILE_MODE);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, targetPath);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(targetPath, ENV_FILE_MODE);
      } catch {
        // best-effort: rename succeeded; some filesystems (e.g. exfat) ignore chmod
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error during cleanup
      }
    }
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup error
    }
    throw error;
  }
}

export interface EnvFileLoadResult {
  path?: string;
  applied: string[];
  skipped: string[];
}

export interface LocalEnvFileSnapshot {
  path?: string;
  existed: boolean;
  contents?: string;
}

export interface LocalEnvVarValue {
  path?: string;
  present: boolean;
  value?: string;
}

/**
 * Captures the complete local credential file so a multi-owner config
 * transaction can restore byte-for-byte state after a later owner fails.
 */
export function captureLocalEnvFileSnapshot(options?: { rootDir?: string }): LocalEnvFileSnapshot {
  const envPath = resolveWritableEnvFilePath(options);
  if (!envPath || !fs.existsSync(envPath)) {
    return { path: envPath, existed: false };
  }
  return {
    path: envPath,
    existed: true,
    contents: fs.readFileSync(envPath, "utf8"),
  };
}

/** Restores a snapshot captured above without projecting any credential bytes. */
export function restoreLocalEnvFileSnapshot(snapshot: LocalEnvFileSnapshot): void {
  if (!snapshot.path) {
    return;
  }
  if (!snapshot.existed) {
    try {
      fs.unlinkSync(snapshot.path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }
  writeCredentialFileAtomicSync(snapshot.path, snapshot.contents ?? "");
}

let loaded = false;

export function loadLocalEnvFile(options?: { forceReload?: boolean }): EnvFileLoadResult {
  if (loaded && !options?.forceReload) {
    return { applied: [], skipped: [] };
  }
  loaded = true;

  const envPath = detectEnvFilePath();
  if (!envPath) {
    return { applied: [], skipped: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return { applied: [], skipped: [] };
  }

  const parsed = parseEnv(raw);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }

  return { path: envPath, applied, skipped };
}

export function detectEnvFilePath(options?: { rootDir?: string }): string | undefined {
  const writablePath = resolveWritableEnvFilePath(options);
  if (!writablePath) {
    return undefined;
  }
  if (fs.existsSync(writablePath)) {
    return writablePath;
  }
  return undefined;
}

/** Reads one value from the durable local env file without applying process-env precedence. */
export function readLocalEnvVar(key: string, options?: { rootDir?: string }): LocalEnvVarValue {
  const validatedKey = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(validatedKey)) {
    throw new Error(`Invalid env var key: ${key}`);
  }
  const envPath = detectEnvFilePath(options);
  if (!envPath) {
    return { path: resolveWritableEnvFilePath(options), present: false };
  }
  const parsed = parseEnv(fs.readFileSync(envPath, "utf8"));
  if (!Object.prototype.hasOwnProperty.call(parsed, validatedKey)) {
    return { path: envPath, present: false };
  }
  return { path: envPath, present: true, value: parsed[validatedKey] };
}

/** Outcome of probing for a writable `.env`, including the roots that were tried. */
export interface EnvFileProbeResult {
  /** Absolute `.env` path, or undefined when no candidate root qualified. */
  path?: string;
  /** Roots probed, in priority order — the debuggable part of a failed probe. */
  probedRoots: string[];
}

/**
 * Locates the `.env` that credential writes should target, and reports which
 * roots were considered.
 *
 * An explicit `rootDir` is authoritative: it is the caller asserting where the
 * install lives, so resolution stops there. It deliberately does NOT fall back
 * to cwd-derived roots, because `.env` is a credential sink — falling through
 * would make the write target depend on the directory the process was started
 * from, and a gateway launched from `apps/gateway` could persist a secret into
 * the repo root's `.env` instead of the install the caller named.
 *
 * Without a `rootDir` this is discovery mode (startup, CLIs): GOATCITADEL_ROOT_DIR
 * first, then cwd, cwd/.., cwd/../.., preferring any root carrying the config
 * marker before falling back to a root that merely has a `.env` already.
 */
export function probeWritableEnvFilePath(options?: { rootDir?: string }): EnvFileProbeResult {
  const explicitRoot = options?.rootDir?.trim() ? path.resolve(options.rootDir) : undefined;
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  const cwd = process.cwd();

  const rootCandidates = explicitRoot
    ? [explicitRoot]
    : ([envRoot ? path.resolve(envRoot) : undefined, cwd, path.resolve(cwd, ".."), path.resolve(cwd, "../..")].filter(
        Boolean,
      ) as string[]);

  const probedRoots = Array.from(new Set(rootCandidates));
  for (const root of probedRoots) {
    if (repoHasConfigMarker(root)) {
      return { path: path.join(root, ".env"), probedRoots };
    }
  }

  for (const root of probedRoots) {
    const envPath = path.join(root, ".env");
    if (fs.existsSync(envPath)) {
      return { path: envPath, probedRoots };
    }
  }

  return { probedRoots };
}

export function resolveWritableEnvFilePath(options?: { rootDir?: string }): string | undefined {
  return probeWritableEnvFilePath(options).path;
}

/**
 * Result of a credential write. Modelled as a discriminated union so the
 * compiler — not a convention — forces callers to handle the failure: `path`
 * exists only on the success arm, so reading it without first narrowing on
 * `updated` is a type error.
 */
export type EnvFileWriteResult =
  | { updated: true; path: string }
  | { updated: false; reason: "no-writable-env-file"; probedRoots: string[] };

export function upsertLocalEnvVar(key: string, value: string, options?: { rootDir?: string }): EnvFileWriteResult {
  const validatedKey = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(validatedKey)) {
    throw new Error(`Invalid env var key: ${key}`);
  }

  const probe = probeWritableEnvFilePath(options);
  const envPath = probe.path;
  if (!envPath) {
    // Never fail silently: a dropped credential is invisible at the call site
    // unless the operator can see which roots were tried.
    envFileLog.warn("could not persist env var: no writable .env file found", {
      envVar: validatedKey,
      probedRoots: probe.probedRoots,
    });
    return { updated: false, reason: "no-writable-env-file", probedRoots: probe.probedRoots };
  }

  const nextLine = `${validatedKey}=${serializeEnvValue(value)}`;
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    raw = "";
  }

  const lines = raw.split(/\r?\n/u);
  let replaced = false;
  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }
    const candidate = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const splitIndex = candidate.indexOf("=");
    if (splitIndex <= 0) {
      return line;
    }
    const existingKey = candidate.slice(0, splitIndex).trim();
    if (existingKey !== validatedKey) {
      return line;
    }
    replaced = true;
    return nextLine;
  });

  const normalized = replaced
    ? updatedLines.join("\n")
    : [...updatedLines.filter((line, index, array) => !(index === array.length - 1 && line === "")), nextLine, ""].join(
        "\n",
      );
  writeCredentialFileAtomicSync(envPath, normalized);
  return { path: envPath, updated: true };
}

/**
 * Result of a credential removal. `key-absent` is a benign no-op (nothing to
 * remove); `no-writable-env-file` means the removal could not be attempted at
 * all and the secret may still be on disk.
 */
export type EnvFileDeleteResult =
  | { updated: true; path: string }
  | { updated: false; reason: "key-absent"; path: string }
  | { updated: false; reason: "no-writable-env-file"; probedRoots: string[] };

export function deleteLocalEnvVar(key: string, options?: { rootDir?: string }): EnvFileDeleteResult {
  const validatedKey = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(validatedKey)) {
    throw new Error(`Invalid env var key: ${key}`);
  }

  const probe = probeWritableEnvFilePath(options);
  const envPath = probe.path;
  if (!envPath) {
    envFileLog.warn("could not remove env var: no writable .env file found", {
      envVar: validatedKey,
      probedRoots: probe.probedRoots,
    });
    return { updated: false, reason: "no-writable-env-file", probedRoots: probe.probedRoots };
  }
  if (!fs.existsSync(envPath)) {
    return { path: envPath, updated: false, reason: "key-absent" };
  }

  const raw = fs.readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/u);
  let removed = false;
  const updatedLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return true;
    }
    const candidate = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const splitIndex = candidate.indexOf("=");
    if (splitIndex <= 0) {
      return true;
    }
    const existingKey = candidate.slice(0, splitIndex).trim();
    if (existingKey !== validatedKey) {
      return true;
    }
    removed = true;
    return false;
  });

  if (!removed) {
    return { path: envPath, updated: false, reason: "key-absent" };
  }

  const normalized = [
    ...updatedLines.filter((line, index, array) => !(index === array.length - 1 && line === "")),
    "",
  ].join("\n");
  writeCredentialFileAtomicSync(envPath, normalized);
  return { path: envPath, updated: true };
}

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const candidate = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;

    const splitIndex = candidate.indexOf("=");
    if (splitIndex <= 0) {
      continue;
    }

    const key = candidate.slice(0, splitIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    let value = candidate.slice(splitIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const inlineCommentIndex = value.indexOf(" #");
      if (inlineCommentIndex >= 0) {
        value = value.slice(0, inlineCommentIndex).trimEnd();
      }
    }

    out[key] = value;
  }

  return out;
}

function serializeEnvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
