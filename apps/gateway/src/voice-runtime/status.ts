import fs from "node:fs/promises";
import path from "node:path";
import type { SystemSettingsRepository } from "@goatcitadel/storage";
import type { InstalledVoiceModelRecord, VoiceRuntimeStatus } from "@goatcitadel/contracts";
import {
  DEFAULT_MANAGED_VOICE_MODEL_ID,
  formatVoiceReadiness,
  getManagedVoiceModel,
  listManagedVoiceModels,
} from "./catalog.js";
import { resolveVoiceRuntimePaths } from "./paths.js";

export const VOICE_RUNTIME_CONFIG_KEY = "voice_runtime_config_v1";

export interface VoiceRuntimeConfigRecord {
  selectedModelId?: string;
  mode?: "managed" | "env_override";
}

export interface ManagedVoiceManifest {
  schemaVersion: 1;
  lastSuccessfulInstallAt?: string;
  lastError?: string;
  selectedModelId?: string;
  whisper?: {
    version: string;
    platform: string;
    binaryPath: string;
    installedAt: string;
    source: "download-binary" | "build-from-source";
  };
  ffmpeg?: {
    version: string;
    binaryPath: string;
    installedAt: string;
    source: "package-managed" | "download-binary";
  };
  models: Array<{
    modelId: string;
    filePath: string;
    sizeBytes: number;
    sha256: string;
    installedAt: string;
  }>;
}

export async function readManagedVoiceManifest(): Promise<ManagedVoiceManifest | null> {
  const { manifestPath } = resolveVoiceRuntimePaths();
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as ManagedVoiceManifest;
  } catch {
    return null;
  }
}

export async function writeManagedVoiceManifest(manifest: ManagedVoiceManifest): Promise<void> {
  const { manifestPath, voiceDir } = resolveVoiceRuntimePaths();
  await fs.mkdir(voiceDir, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function getVoiceRuntimeConfig(systemSettings: Pick<SystemSettingsRepository, "get">): VoiceRuntimeConfigRecord {
  return systemSettings.get<VoiceRuntimeConfigRecord>(VOICE_RUNTIME_CONFIG_KEY)?.value ?? {};
}

export function setVoiceRuntimeConfig(
  systemSettings: Pick<SystemSettingsRepository, "set">,
  next: VoiceRuntimeConfigRecord,
): void {
  systemSettings.set(VOICE_RUNTIME_CONFIG_KEY, next);
}

export async function getManagedVoiceRuntimeStatus(
  systemSettings?: Pick<SystemSettingsRepository, "get">,
): Promise<VoiceRuntimeStatus> {
  const manifest = await readManagedVoiceManifest();
  const config = systemSettings ? getVoiceRuntimeConfig(systemSettings) : {};
  const catalog = listManagedVoiceModels();
  const envBinaryPath = process.env.GOATCITADEL_WHISPER_CPP_BIN?.trim();
  const envModelPath = process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH?.trim();
  const envFfmpegPath = process.env.GOATCITADEL_FFMPEG_BIN?.trim();
  const selectedModelId =
    config.selectedModelId ??
    manifest?.selectedModelId ??
    manifest?.models.find((item) => item.modelId === DEFAULT_MANAGED_VOICE_MODEL_ID)?.modelId ??
    manifest?.models[0]?.modelId;

  const installedModels: InstalledVoiceModelRecord[] = [];
  for (const entry of manifest?.models ?? []) {
    try {
      const stat = await fs.stat(entry.filePath);
      installedModels.push({
        modelId: entry.modelId,
        filePath: entry.filePath,
        sizeBytes: stat.size,
        installedAt: entry.installedAt,
        active: entry.modelId === selectedModelId,
      });
    } catch {
      // Skip missing model files; readiness will reflect it.
    }
  }

  const selectedModel = selectedModelId ? installedModels.find((item) => item.modelId === selectedModelId) : undefined;
  const managedBinaryPath = manifest?.whisper?.binaryPath;
  const managedFfmpegPath = manifest?.ffmpeg?.binaryPath;
  const binaryPath = envBinaryPath || managedBinaryPath;
  const ffmpegPath = envFfmpegPath || managedFfmpegPath;
  const selectedModelPath = envModelPath || selectedModel?.filePath;
  const isEnvOverride = Boolean(envBinaryPath || envModelPath || envFfmpegPath);
  const binaryReady = await pathExists(binaryPath);
  const ffmpegReady = await pathExists(ffmpegPath);
  const modelReady = await pathExists(selectedModelPath);
  const source = isEnvOverride ? "env_override" : binaryReady || installedModels.length > 0 ? "managed" : "manual";
  const derivedSelectedModelId = envModelPath ? (selectedModelId ?? path.basename(envModelPath)) : selectedModelId;

  return {
    provider: "whisper.cpp",
    source,
    readiness: isEnvOverride ? (binaryReady ? "ready" : "missing") : formatVoiceReadiness(binaryReady, modelReady),
    binaryReady,
    binaryPath,
    binaryVersion: manifest?.whisper?.version,
    ffmpegReady,
    ffmpegPath,
    manifestPath: resolveVoiceRuntimePaths().manifestPath,
    selectedModelId: derivedSelectedModelId,
    selectedModelPath,
    installedModels,
    catalog,
    lastError: manifest?.lastError,
  };
}

export function resolveManagedModel(modelId: string): string {
  const model = getManagedVoiceModel(modelId);
  if (!model) {
    throw new Error(`Unknown managed voice model: ${modelId}`);
  }
  return path.join(resolveVoiceRuntimePaths().modelsDir, model.fileName);
}

async function pathExists(targetPath?: string): Promise<boolean> {
  if (!targetPath) {
    return false;
  }
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
