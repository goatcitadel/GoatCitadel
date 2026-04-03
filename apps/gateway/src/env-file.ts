import fs from "node:fs";
import path from "node:path";
import { repoHasConfigMarker } from "./config-files.js";

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

  let raw = "";
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
    const envPath = path.join(root, ".env");
    if (repoHasConfigMarker(root) && fs.existsSync(envPath)) {
      return envPath;
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
  const envPath = detectEnvFilePath(options);
  if (!envPath) {
    return { updated: false };
  }

  const validatedKey = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(validatedKey)) {
    throw new Error(`Invalid env var key: ${key}`);
  }

  const nextLine = `${validatedKey}=${serializeEnvValue(value)}`;
  let raw = "";
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
    const candidate = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
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
    : [...updatedLines.filter((line, index, array) => !(index === array.length - 1 && line === "")), nextLine, ""].join("\n");
  fs.writeFileSync(envPath, normalized, "utf8");
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

    const candidate = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;

    const splitIndex = candidate.indexOf("=");
    if (splitIndex <= 0) {
      continue;
    }

    const key = candidate.slice(0, splitIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    let value = candidate.slice(splitIndex + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
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
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
