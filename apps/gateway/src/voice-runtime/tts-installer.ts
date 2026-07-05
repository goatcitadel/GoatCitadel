import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MANAGED_TTS_VOICE_ID,
  getManagedPiperRuntimeSource,
  getManagedTtsVoice,
  PIPER_RUNTIME_VERSION,
} from "./tts-catalog.js";
import { createTempDir, downloadFile, extractTarGz, extractZip } from "./download.js";
import { detectManagedVoicePlatform, resolveVoiceRuntimePaths } from "./paths.js";
import {
  type ManagedTtsManifest,
  type TtsRuntimeStatus,
  getManagedTtsRuntimeStatus,
  readManagedTtsManifest,
  resolveManagedTtsVoicePaths,
  writeManagedTtsManifest,
} from "./tts-status.js";

/**
 * Managed Piper TTS installer (Competitive-gap program phase B2b). Mirrors the
 * whisper lane's `installer.ts`: sha256-pinned downloads into the voice tools
 * dir, a manifest that records what is installed, and idempotent re-runs that
 * skip work when the recorded version/digest is already present on disk.
 */
export async function installManagedTtsRuntime(
  input: { voiceId?: string; activate?: boolean } = {},
): Promise<TtsRuntimeStatus> {
  const platform = detectManagedVoicePlatform();
  if (!platform) {
    throw new Error(
      `Managed Piper TTS install is not supported on ${process.platform}/${process.arch}. Use manual env overrides instead.`,
    );
  }

  const voiceId = input.voiceId?.trim() || DEFAULT_MANAGED_TTS_VOICE_ID;
  const voice = getManagedTtsVoice(voiceId);
  if (!voice) {
    throw new Error(`Unknown managed TTS voice: ${voiceId}`);
  }

  const paths = resolveVoiceRuntimePaths();
  await fs.mkdir(paths.voiceDir, { recursive: true });
  await fs.mkdir(paths.piperDir, { recursive: true });
  await fs.mkdir(paths.ttsVoicesDir, { recursive: true });

  const manifest =
    (await readManagedTtsManifest()) ??
    ({
      schemaVersion: 1,
      voices: [],
    } satisfies ManagedTtsManifest);

  try {
    const piper = await ensureManagedPiperRuntime(platform, manifest);
    const voiceRecord = await ensureManagedTtsVoice(voice.id, manifest);
    const selectedVoiceId = input.activate === false ? manifest.selectedVoiceId : voice.id;

    const next: ManagedTtsManifest = {
      ...manifest,
      lastError: undefined,
      lastSuccessfulInstallAt: new Date().toISOString(),
      selectedVoiceId,
      piper,
      voices: upsertVoice(manifest.voices, voiceRecord),
    };
    await writeManagedTtsManifest(next);
    return getManagedTtsRuntimeStatus();
  } catch (error) {
    const next: ManagedTtsManifest = {
      ...manifest,
      lastError: (error as Error).message,
      voices: manifest.voices ?? [],
      schemaVersion: 1,
    };
    await writeManagedTtsManifest(next);
    throw error;
  }
}

export async function selectManagedTtsVoice(voiceId: string): Promise<TtsRuntimeStatus> {
  const manifest = await readManagedTtsManifest();
  if (!manifest || !manifest.voices.some((item) => item.voiceId === voiceId)) {
    throw new Error(`TTS voice ${voiceId} is not installed yet.`);
  }
  await writeManagedTtsManifest({
    ...manifest,
    selectedVoiceId: voiceId,
  });
  return getManagedTtsRuntimeStatus();
}

async function ensureManagedPiperRuntime(
  platform: NonNullable<ReturnType<typeof detectManagedVoicePlatform>>,
  manifest: ManagedTtsManifest,
): Promise<NonNullable<ManagedTtsManifest["piper"]>> {
  if (manifest.piper?.version === PIPER_RUNTIME_VERSION) {
    try {
      await fs.access(manifest.piper.binaryPath);
      return manifest.piper;
    } catch {
      // Reinstall below.
    }
  }

  const source = getManagedPiperRuntimeSource(platform);
  const paths = resolveVoiceRuntimePaths();
  const installDir = path.join(paths.piperDir, PIPER_RUNTIME_VERSION, platform);
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.mkdir(installDir, { recursive: true });

  const tempDir = await createTempDir("goatcitadel-voice-piper-");
  const archivePath = path.join(tempDir, path.basename(new URL(source.url).pathname));

  try {
    await downloadFile(source.url, archivePath, source.sha256);
    if (source.archiveKind === "zip") {
      await extractZip(archivePath, installDir);
    } else {
      await extractTarGz(archivePath, installDir);
    }
    const binaryPath = path.join(installDir, source.binaryRelativePath);
    await fs.access(binaryPath);
    if (process.platform !== "win32") {
      await fs.chmod(binaryPath, 0o755);
    }
    return {
      version: source.version,
      platform,
      binaryPath,
      installedAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function ensureManagedTtsVoice(
  voiceId: string,
  manifest: ManagedTtsManifest,
): Promise<ManagedTtsManifest["voices"][number]> {
  const voice = getManagedTtsVoice(voiceId);
  if (!voice) {
    throw new Error(`Unknown managed TTS voice: ${voiceId}`);
  }
  const existing = manifest.voices.find((item) => item.voiceId === voiceId);
  const { modelPath, configPath } = resolveManagedTtsVoicePaths(voiceId);
  if (existing?.sha256 === voice.modelSha256) {
    try {
      await fs.access(existing.modelPath);
      await fs.access(existing.configPath);
      return existing;
    } catch {
      // Reinstall below.
    }
  }

  await downloadFile(voice.modelUrl, modelPath, voice.modelSha256);
  await downloadFile(voice.configUrl, configPath, voice.configSha256);
  return {
    voiceId,
    modelPath,
    configPath,
    sizeBytes: voice.sizeBytes,
    sha256: voice.modelSha256,
    installedAt: new Date().toISOString(),
  };
}

function upsertVoice(
  voices: ManagedTtsManifest["voices"],
  nextVoice: ManagedTtsManifest["voices"][number],
): ManagedTtsManifest["voices"] {
  const remaining = voices.filter((item) => item.voiceId !== nextVoice.voiceId);
  return [...remaining, nextVoice];
}
