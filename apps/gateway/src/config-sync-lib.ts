import fs from "node:fs/promises";
import path from "node:path";
import { materializeConfigFilesFromExamples, SPLIT_CONFIG_FILENAMES } from "./config-files.js";
import { isVerboseLoggingEnabled } from "./runtime-ux.js";

const UNIFIED_FILENAME = "goatcitadel.json";

interface SectionTarget {
  aliases: string[];
  filename: string;
}

const SECTION_TARGETS: SectionTarget[] = [
  { aliases: ["assistant"], filename: "assistant.config.json" },
  { aliases: ["toolPolicy", "tool-policy"], filename: "tool-policy.json" },
  { aliases: ["budgets"], filename: "budgets.json" },
  { aliases: ["llm", "llmProviders", "llm-providers"], filename: "llm-providers.json" },
  { aliases: ["cronJobs", "cron", "cron-jobs"], filename: "cron-jobs.json" },
];
const UNSAFE_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface UnifiedConfigSyncResult {
  unifiedPath: string;
  createdUnified: boolean;
  materializedExamples: string[];
  syncedSections: string[];
}

export interface UnifiedConfigSyncOptions {
  createUnifiedIfMissing?: boolean;
}

export function buildUnifiedConfigPayload(
  assistant: unknown,
  toolPolicy: unknown,
  budgets: unknown,
  llm: unknown,
  cronJobs: unknown,
): Record<string, unknown> {
  return {
    version: 1,
    assistant,
    toolPolicy,
    budgets,
    llm,
    cronJobs,
  };
}

export async function syncUnifiedConfig(
  rootDir: string,
  options: UnifiedConfigSyncOptions = {},
): Promise<UnifiedConfigSyncResult> {
  const configDir = path.join(rootDir, "config");
  const unifiedPath = path.join(configDir, UNIFIED_FILENAME);
  const createUnifiedIfMissing = options.createUnifiedIfMissing ?? false;
  const materializedExamples = await materializeConfigFilesFromExamples(configDir, SPLIT_CONFIG_FILENAMES);
  let createdUnified = false;
  let unifiedRaw: string;
  let unifiedMtimeMs: number;

  try {
    unifiedRaw = await fs.readFile(unifiedPath, "utf8");
    unifiedMtimeMs = (await fs.stat(unifiedPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    if (!createUnifiedIfMissing) {
      return {
        unifiedPath,
        createdUnified: false,
        materializedExamples,
        syncedSections: [],
      };
    }

    const initialUnified = await buildUnifiedFromSplitFiles(configDir);
    await writeJsonIfChanged(unifiedPath, initialUnified);
    createdUnified = true;
    unifiedRaw = JSON.stringify(initialUnified);
    unifiedMtimeMs = (await fs.stat(unifiedPath)).mtimeMs;
  }

  const parsed = parseJson(unifiedRaw, unifiedPath);
  if (!isRecord(parsed)) {
    throw new Error(`Unified config must be a JSON object: ${unifiedPath}`);
  }

  const syncedSections: string[] = [];
  for (const target of SECTION_TARGETS) {
    const sectionValue = readSection(parsed, target.aliases);
    if (sectionValue === undefined) {
      continue;
    }

    const normalized = normalizeSection(sectionValue, target.filename);
    const outPath = path.join(configDir, target.filename);
    await warnIfSplitIsNewer(outPath, unifiedPath, unifiedMtimeMs, serializeJson(normalized));
    const changed = await writeJsonIfChanged(outPath, normalized);
    if (changed) {
      syncedSections.push(target.filename);
    }
  }

  return {
    unifiedPath,
    createdUnified,
    materializedExamples,
    syncedSections,
  };
}

async function buildUnifiedFromSplitFiles(configDir: string): Promise<Record<string, unknown>> {
  const assistant = await readJson(path.join(configDir, "assistant.config.json"));
  const toolPolicy = await readJson(path.join(configDir, "tool-policy.json"));
  const budgets = await readJson(path.join(configDir, "budgets.json"));
  const llm = await readJson(path.join(configDir, "llm-providers.json"));
  const cronJobs = await readJson(path.join(configDir, "cron-jobs.json"));

  return buildUnifiedConfigPayload(assistant, toolPolicy, budgets, llm, cronJobs);
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseJson(raw, filePath);
}

function parseJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = (error as Error).message;
    throw new Error(`Invalid JSON in ${filePath}: ${reason}`, { cause: error });
  }
}

function normalizeSection(value: unknown, filename: string): unknown {
  if (filename === "cron-jobs.json") {
    if (Array.isArray(value)) {
      return { jobs: sanitizeConfigSectionValue(value, filename) };
    }
    if (!isRecord(value)) {
      throw new Error(`Invalid section for ${filename} in config/goatcitadel.json (expected object or array)`);
    }
    return sanitizeConfigSectionValue(value, filename);
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid section for ${filename} in config/goatcitadel.json (expected object)`);
  }
  return sanitizeConfigSectionValue(value, filename);
}

function readSection(payload: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(payload, alias)) {
      return payload[alias];
    }
  }
  return undefined;
}

function sanitizeConfigSectionValue(value: unknown, pathLabel: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeConfigSectionValue(item, `${pathLabel}[${index}]`));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_CONFIG_KEYS.has(key)) {
      throw new Error(`Unsafe config key in config/goatcitadel.json: ${pathLabel}.${key}`);
    }
    out[key] = sanitizeConfigSectionValue(value[key], `${pathLabel}.${key}`);
  }
  return out;
}

async function writeJsonIfChanged(filePath: string, data: unknown): Promise<boolean> {
  const serialized = serializeJson(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let current = "";
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (normalizeComparableContent(current) === normalizeComparableContent(serialized)) {
    return false;
  }

  const next = applyPreferredLineEndings(serialized, detectLineEnding(current));

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(tempPath, next, "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // ignore temp cleanup failures
    }
  }
  return true;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeComparableContent(value: string): string {
  return normalizeLineEndings(value).trimEnd();
}

function detectLineEnding(value: string): "\r\n" | "\n" {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

function applyPreferredLineEndings(value: string, lineEnding: "\r\n" | "\n"): string {
  if (lineEnding === "\n") {
    return normalizeLineEndings(value);
  }
  return normalizeLineEndings(value).replace(/\n/g, "\r\n");
}

function serializeJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function warnIfSplitIsNewer(
  splitPath: string,
  unifiedPath: string,
  unifiedMtimeMs: number,
  nextContent: string,
): Promise<void> {
  let splitStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  try {
    splitStat = await fs.stat(splitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (!splitStat || splitStat.mtimeMs <= unifiedMtimeMs) {
    return;
  }

  try {
    const current = await fs.readFile(splitPath, "utf8");
    if (normalizeComparableContent(current) === normalizeComparableContent(nextContent)) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const detail = `${path.basename(splitPath)} is newer than ${path.basename(unifiedPath)}; unified config values are being applied`;
  // Config drift is intentionally terminal-visible during bootstrap and sync.
  // eslint-disable-next-line no-console
  console.warn(
    isVerboseLoggingEnabled() ? `[goatcitadel:config] warning: ${detail}` : `[goatcitadel] config override: ${detail}`,
  );
}
