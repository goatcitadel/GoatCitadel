import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AddonLaunchContract, AddonLaunchDataFile, AddonLaunchHealthProbe } from "@goatcitadel/contracts";
import { readBoundedResponseJson } from "./bounded-response-reader.js";

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const DATA_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMPANION_SUFFIX = /^[A-Za-z0-9._-]{0,32}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const AddonLaunchContractSchema = z
  .object({
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(1024)).max(64),
    env: z.record(z.string().regex(ENV_NAME), z.string().max(4096)).optional(),
    dataFiles: z
      .array(
        z
          .object({
            envVar: z.string().regex(ENV_NAME),
            fileName: z.string().regex(DATA_FILE_NAME),
            companionSuffixes: z.array(z.string().regex(COMPANION_SUFFIX)).max(8).optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    health: z
      .object({
        url: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
          }, "Add-on health probes must target a loopback http URL."),
        readyWhen: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .refine((value) => Object.keys(value).length > 0, "readyWhen needs at least one field."),
        readyTimeoutMs: z.number().int().min(1_000).max(120_000),
      })
      .strict(),
  })
  .strict();

/** Validates a manifest-declared launch contract; fails closed on anything outside the data-only shape. */
export function parseAddonLaunchContract(addonId: string, value: unknown): AddonLaunchContract {
  const parsed = AddonLaunchContractSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Add-on ${addonId} declares an invalid launch contract.`, { cause: parsed.error });
  }
  const envNames = [...Object.keys(parsed.data.env ?? {}), ...(parsed.data.dataFiles ?? []).map((file) => file.envVar)];
  if (new Set(envNames).size !== envNames.length) {
    throw new Error(`Add-on ${addonId} declares a launch environment variable more than once.`);
  }
  return parsed.data;
}

/**
 * Moves any legacy data files out of the install directory into
 * `<add-ons root>/data/<addonId>/` and returns the env vars that point at them.
 */
export async function prepareAddonDataFiles(input: {
  addonId: string;
  installedPath: string;
  addonsRootDir: string;
  dataFiles: readonly AddonLaunchDataFile[];
  assertWithinRoot: (targetPath: string, addonsRootDir: string) => string;
}): Promise<Record<string, string>> {
  if (input.dataFiles.length === 0) {
    return {};
  }
  const safeInstalledPath = input.assertWithinRoot(input.installedPath, input.addonsRootDir);
  const dataDirectory = path.join(input.addonsRootDir, "data", input.addonId);
  await ensureAddonDirectoryWithoutLinks(dataDirectory, input.addonsRootDir);
  const env: Record<string, string> = {};
  for (const dataFile of input.dataFiles) {
    for (const suffix of ["", ...(dataFile.companionSuffixes ?? [])]) {
      const fileName = `${dataFile.fileName}${suffix}`;
      const legacyPath = path.join(safeInstalledPath, fileName);
      const durablePath = path.join(dataDirectory, fileName);
      const legacyStats = await lstatIfPresent(legacyPath);
      const durableStats = await lstatIfPresent(durablePath);
      assertRegularAddonDataFile(legacyPath, legacyStats);
      assertRegularAddonDataFile(durablePath, durableStats);
      if (legacyStats && durableStats) {
        throw new Error(
          `Add-on ${input.addonId} data migration is ambiguous because both ${legacyPath} and ${durablePath} exist.`,
        );
      }
      if (legacyStats) {
        await fs.rename(legacyPath, durablePath);
      }
    }
    env[dataFile.envVar] = path.join(dataDirectory, dataFile.fileName);
  }
  return env;
}

/** One bounded health read; `null` when unreachable or not a JSON object. */
export async function readAddonHealth(
  probe: AddonLaunchHealthProbe,
  timeoutMs: number,
): Promise<{ ready: boolean } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(probe.url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await readBoundedResponseJson(response, {
      maxBytes: 32 * 1024,
      timeoutMs,
      label: "Add-on health",
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    return {
      ready: Object.entries(probe.readyWhen).every(([key, expected]) => record[key] === expected),
    };
  } catch {
    return null;
  }
}

export async function waitForAddonReady(probe: AddonLaunchHealthProbe): Promise<{ ready: boolean } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < probe.readyTimeoutMs) {
    const result = await readAddonHealth(probe, 1_000);
    if (result?.ready) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/** Human-readable `field=value` list for health messages. */
export function describeReadyWhen(probe: AddonLaunchHealthProbe): string {
  return Object.entries(probe.readyWhen)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

export async function ensureAddonDirectoryWithoutLinks(directory: string, addonsRootDir: string): Promise<void> {
  const root = path.resolve(addonsRootDir);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Add-on data path escapes add-ons root: ${directory}`);
  }
  await fs.mkdir(root, { recursive: true });
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = await lstatIfPresent(current);
    if (!existing) {
      await fs.mkdir(current);
    }
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Refusing to use a linked or non-directory add-on data path: ${current}`);
    }
  }
}

export async function lstatIfPresent(targetPath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertRegularAddonDataFile(targetPath: string, stats: Stats | undefined): void {
  if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
    throw new Error(`Refusing to use a linked or non-file add-on data path: ${targetPath}`);
  }
}
