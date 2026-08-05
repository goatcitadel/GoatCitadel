import fs from "node:fs/promises";
import path from "node:path";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { VoiceRuntimeInstallRequest, VoiceRuntimeStatus } from "@goatcitadel/contracts";
import {
  DEFAULT_MANAGED_VOICE_MODEL_ID,
  FFMPEG_HELPER_VERSION,
  getManagedFfmpegSource,
  getManagedVoiceModel,
  getManagedVoiceRuntimeSource,
  WHISPER_RUNTIME_VERSION,
} from "./catalog.js";
import {
  createTempDir,
  downloadFile,
  extractGzip,
  extractTarGz,
  extractZip,
  findFileRecursive,
  runCommand,
} from "./download.js";
import { detectManagedVoicePlatform, resolveVoiceRuntimePaths } from "./paths.js";
import {
  type ManagedVoiceManifest,
  getManagedVoiceRuntimeStatus,
  readManagedVoiceManifest,
  resolveManagedModel,
  VOICE_RUNTIME_CONFIG_KEY,
  setVoiceRuntimeConfig,
  writeManagedVoiceManifest,
} from "./status.js";

export async function installManagedVoiceRuntime(
  systemSettings?: Pick<AsyncStorage["systemSettings"], "get" | "set">,
  input: VoiceRuntimeInstallRequest = {},
): Promise<VoiceRuntimeStatus> {
  const platform = detectManagedVoicePlatform();
  if (!platform) {
    throw new Error(
      `Managed whisper.cpp install is not supported on ${process.platform}/${process.arch}. Use manual env overrides instead.`,
    );
  }

  const modelId = input.modelId?.trim() || DEFAULT_MANAGED_VOICE_MODEL_ID;
  const voiceModel = getManagedVoiceModel(modelId);
  if (!voiceModel) {
    throw new Error(`Unknown managed voice model: ${modelId}`);
  }

  const paths = resolveVoiceRuntimePaths();
  await fs.mkdir(paths.voiceDir, { recursive: true });
  await fs.mkdir(paths.modelsDir, { recursive: true });
  await fs.mkdir(paths.whisperDir, { recursive: true });
  await fs.mkdir(paths.ffmpegDir, { recursive: true });

  const manifest =
    (await readManagedVoiceManifest()) ??
    ({
      schemaVersion: 1,
      models: [],
    } satisfies ManagedVoiceManifest);

  try {
    const whisper = await ensureManagedWhisperRuntime(platform, manifest);
    const ffmpeg = await ensureManagedFfmpeg(platform, manifest);
    const modelRecord = await ensureManagedModel(voiceModel.id, manifest);
    const selectedModelId = input.activate === false ? manifest.selectedModelId : voiceModel.id;

    const next: ManagedVoiceManifest = {
      ...manifest,
      lastError: undefined,
      lastSuccessfulInstallAt: new Date().toISOString(),
      selectedModelId,
      whisper,
      ffmpeg,
      models: upsertModel(manifest.models, modelRecord),
    };
    await writeManagedVoiceManifest(next);
    if (selectedModelId && systemSettings) {
      await setVoiceRuntimeConfig(systemSettings, {
        selectedModelId,
        mode: "managed",
      });
    }
    return getManagedVoiceRuntimeStatus(systemSettings);
  } catch (error) {
    const next: ManagedVoiceManifest = {
      ...manifest,
      lastError: (error as Error).message,
      models: manifest.models ?? [],
      schemaVersion: 1,
    };
    await writeManagedVoiceManifest(next);
    throw error;
  }
}

export async function selectManagedVoiceModel(
  systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "set"> | undefined,
  modelId: string,
): Promise<VoiceRuntimeStatus> {
  const manifest = await readManagedVoiceManifest();
  if (!manifest || !manifest.models.some((item) => item.modelId === modelId)) {
    throw new Error(`Model ${modelId} is not installed yet.`);
  }
  await writeManagedVoiceManifest({
    ...manifest,
    selectedModelId: modelId,
  });
  if (systemSettings) {
    await setVoiceRuntimeConfig(systemSettings, {
      selectedModelId: modelId,
      mode: "managed",
    });
  }
  return getManagedVoiceRuntimeStatus(systemSettings);
}

export async function removeManagedVoiceModel(
  systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "set"> | undefined,
  modelId: string,
): Promise<VoiceRuntimeStatus> {
  const manifest = await readManagedVoiceManifest();
  if (!manifest) {
    throw new Error("Managed voice runtime is not installed.");
  }
  const selectedModelId =
    (await systemSettings?.get<{ selectedModelId?: string }>(VOICE_RUNTIME_CONFIG_KEY))?.value?.selectedModelId ??
    manifest.selectedModelId ??
    manifest.models.find((item) => item.modelId === DEFAULT_MANAGED_VOICE_MODEL_ID)?.modelId ??
    manifest.models[0]?.modelId;
  if (selectedModelId === modelId) {
    throw new Error(`Model ${modelId} is currently active. Select another model before removing it.`);
  }
  const existing = manifest.models.find((item) => item.modelId === modelId);
  if (!existing) {
    throw new Error(`Model ${modelId} is not installed.`);
  }
  await fs.rm(existing.filePath, { force: true });
  const next: ManagedVoiceManifest = {
    ...manifest,
    models: manifest.models.filter((item) => item.modelId !== modelId),
  };
  await writeManagedVoiceManifest(next);
  return getManagedVoiceRuntimeStatus(systemSettings);
}

async function ensureManagedWhisperRuntime(
  platform: ReturnType<typeof detectManagedVoicePlatform> extends infer T ? Exclude<T, null> : never,
  manifest: ManagedVoiceManifest,
): Promise<NonNullable<ManagedVoiceManifest["whisper"]>> {
  if (manifest.whisper?.version === WHISPER_RUNTIME_VERSION) {
    try {
      await fs.access(manifest.whisper.binaryPath);
      return manifest.whisper;
    } catch {
      // Reinstall below.
    }
  }

  const source = getManagedVoiceRuntimeSource(platform);
  const paths = resolveVoiceRuntimePaths();
  const installDir = path.join(paths.whisperDir, WHISPER_RUNTIME_VERSION, platform);
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.mkdir(installDir, { recursive: true });

  const tempDir = await createTempDir("goatcitadel-voice-whisper-");
  const archivePath = path.join(tempDir, path.basename(new URL(source.url).pathname));

  try {
    await downloadFile(source.url, archivePath, source.sha256);
    if (source.installMethod === "download-binary") {
      await extractZip(archivePath, installDir);
      const binaryPath = source.binaryRelativePath
        ? path.join(installDir, source.binaryRelativePath)
        : await findExpectedBinary(installDir, "whisper-cli.exe");
      return {
        version: source.version,
        platform,
        binaryPath,
        installedAt: new Date().toISOString(),
        source: source.installMethod,
      };
    }

    const sourceRoot = path.join(tempDir, "src");
    await extractTarGz(archivePath, sourceRoot);
    const [extractedDirName] = await fs.readdir(sourceRoot);
    if (!extractedDirName) {
      throw new Error("whisper.cpp source archive did not extract as expected.");
    }
    const extractedDir = path.join(sourceRoot, extractedDirName);
    runCommand(
      "cmake",
      ["-B", "build", "-S", ".", "-DWHISPER_FFMPEG=OFF"],
      "Failed to configure whisper.cpp build.",
      extractedDir,
    );
    runCommand("cmake", ["--build", "build", "--config", "Release"], "Failed to build whisper.cpp.", extractedDir);
    const binaryName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    const builtBinary = await findExpectedBinary(extractedDir, binaryName);
    const targetBinDir = path.join(installDir, "bin");
    await fs.mkdir(targetBinDir, { recursive: true });
    const targetPath = path.join(targetBinDir, binaryName);
    await fs.copyFile(builtBinary, targetPath);
    if (process.platform !== "win32") {
      await fs.chmod(targetPath, 0o755);
    }
    return {
      version: source.version,
      platform,
      binaryPath: targetPath,
      installedAt: new Date().toISOString(),
      source: source.installMethod,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function ensureManagedFfmpeg(
  platform: ReturnType<typeof detectManagedVoicePlatform> extends infer T ? Exclude<T, null> : never,
  manifest: ManagedVoiceManifest,
): Promise<NonNullable<ManagedVoiceManifest["ffmpeg"]>> {
  if (manifest.ffmpeg?.version === FFMPEG_HELPER_VERSION) {
    try {
      await fs.access(manifest.ffmpeg.binaryPath);
      return manifest.ffmpeg;
    } catch {
      // Reinstall below.
    }
  }

  const source = getManagedFfmpegSource(platform);
  const paths = resolveVoiceRuntimePaths();
  const installDir = path.join(paths.ffmpegDir, FFMPEG_HELPER_VERSION.replace(/[^a-z0-9._-]+/gi, "_"), platform);
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.mkdir(installDir, { recursive: true });
  const tempDir = await createTempDir("goatcitadel-voice-ffmpeg-");
  const archivePath = path.join(tempDir, path.basename(new URL(source.url).pathname));
  const targetPath = path.join(installDir, source.binaryFileName);
  try {
    await downloadFile(source.url, archivePath, source.sha256);
    await extractGzip(archivePath, targetPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  if (process.platform !== "win32") {
    await fs.chmod(targetPath, 0o755);
  }
  return {
    version: FFMPEG_HELPER_VERSION,
    binaryPath: targetPath,
    installedAt: new Date().toISOString(),
    source: "download-binary",
  };
}

async function ensureManagedModel(
  modelId: string,
  manifest: ManagedVoiceManifest,
): Promise<ManagedVoiceManifest["models"][number]> {
  const model = getManagedVoiceModel(modelId);
  if (!model) {
    throw new Error(`Unknown managed voice model: ${modelId}`);
  }
  const existing = manifest.models.find((item) => item.modelId === modelId);
  const targetPath = resolveManagedModel(modelId);
  if (existing?.sha256 === model.sha256) {
    try {
      await fs.access(existing.filePath);
      return existing;
    } catch {
      // Reinstall below.
    }
  }

  await downloadFile(model.url, targetPath, model.sha256);
  return {
    modelId,
    filePath: targetPath,
    sizeBytes: model.sizeBytes,
    sha256: model.sha256,
    installedAt: new Date().toISOString(),
  };
}

function upsertModel(
  models: ManagedVoiceManifest["models"],
  nextModel: ManagedVoiceManifest["models"][number],
): ManagedVoiceManifest["models"] {
  const remaining = models.filter((item) => item.modelId !== nextModel.modelId);
  return [...remaining, nextModel];
}

async function findExpectedBinary(rootDir: string, fileName: string): Promise<string> {
  const located = await findFileRecursive(rootDir, fileName);
  if (!located) {
    throw new Error(`Unable to locate ${fileName} after whisper.cpp install.`);
  }
  return located;
}
