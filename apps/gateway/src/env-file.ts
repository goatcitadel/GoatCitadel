import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { repoHasConfigMarker } from "./config-files.js";

const ENV_FILE_MODE = 0o600;

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

export function resolveWritableEnvFilePath(options?: { rootDir?: string }): string | undefined {
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  const cwd = process.cwd();

  const rootCandidates = [
    options?.rootDir ? path.resolve(options.rootDir) : undefined,
    envRoot ? path.resolve(envRoot) : undefined,
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "../.."),
  ].filter(Boolean) as string[];

  const deduped = Array.from(new Set(rootCandidates));
  for (const root of deduped) {
    if (repoHasConfigMarker(root)) {
      return path.join(root, ".env");
    }
  }

  for (const root of deduped) {
    const envPath = path.join(root, ".env");
    if (fs.existsSync(envPath)) {
      return envPath;
    }
  }

  return undefined;
}

export function upsertLocalEnvVar(
  key: string,
  value: string,
  options?: { rootDir?: string },
): { path?: string; updated: boolean } {
  const envPath = resolveWritableEnvFilePath(options);
  if (!envPath) {
    return { updated: false };
  }

  const validatedKey = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(validatedKey)) {
    throw new Error(`Invalid env var key: ${key}`);
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

export function deleteLocalEnvVar(key: string, options?: { rootDir?: string }): { path?: string; updated: boolean } {
  const envPath = resolveWritableEnvFilePath(options);
  if (!envPath || !fs.existsSync(envPath)) {
    return { path: envPath, updated: false };
  }

  const validatedKey = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(validatedKey)) {
    throw new Error(`Invalid env var key: ${key}`);
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
    return { path: envPath, updated: false };
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
