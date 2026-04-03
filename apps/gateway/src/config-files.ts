import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export const SPLIT_CONFIG_FILENAMES = [
  "assistant.config.json",
  "tool-policy.json",
  "budgets.json",
  "llm-providers.json",
  "cron-jobs.json",
] as const;

export const MANAGED_CONFIG_FILENAMES = [
  ...SPLIT_CONFIG_FILENAMES,
  "goatcitadel.json",
  "private-beta.profile.json",
] as const;

export function toExampleConfigFilename(filename: string): string {
  return filename.replace(/\.json$/u, ".example.json");
}

export function resolveConfigPath(configDir: string, filename: string): string {
  return path.join(configDir, filename);
}

export function resolveExampleConfigPath(configDir: string, filename: string): string {
  return path.join(configDir, toExampleConfigFilename(filename));
}

export function configFileExists(configDir: string, filename: string): boolean {
  return fs.existsSync(resolveConfigPath(configDir, filename))
    || fs.existsSync(resolveExampleConfigPath(configDir, filename));
}

export function repoHasConfigMarker(rootDir: string): boolean {
  return configFileExists(path.join(rootDir, "config"), "assistant.config.json");
}

export async function materializeConfigFilesFromExamples(
  configDir: string,
  filenames: readonly string[],
): Promise<string[]> {
  const materialized: string[] = [];
  await fsPromises.mkdir(configDir, { recursive: true });

  for (const filename of filenames) {
    const actualPath = resolveConfigPath(configDir, filename);
    if (fs.existsSync(actualPath)) {
      continue;
    }

    const examplePath = resolveExampleConfigPath(configDir, filename);
    try {
      await fsPromises.copyFile(examplePath, actualPath);
      materialized.push(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return materialized;
}
