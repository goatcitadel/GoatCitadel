import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MANAGED_TTS_VOICE_ID, getManagedTtsVoice } from "./tts-catalog.js";
import { resolveVoiceRuntimePaths } from "./paths.js";

/**
 * Managed Piper TTS status (Competitive-gap program phase B2b). Mirrors the
 * whisper lane's `status.ts`: a JSON manifest under the voice tools dir plus
 * env overrides (`GOATCITADEL_PIPER_BIN` / `GOATCITADEL_PIPER_VOICE_PATH`)
 * for operators who bring their own piper install.
 */

export type TtsRuntimeReadiness = "ready" | "broken" | "missing";

export interface ManagedTtsManifest {
  schemaVersion: 1;
  lastSuccessfulInstallAt?: string;
  lastError?: string;
  selectedVoiceId?: string;
  piper?: {
    version: string;
    platform: string;
    binaryPath: string;
    installedAt: string;
  };
  voices: Array<{
    voiceId: string;
    modelPath: string;
    configPath: string;
    sizeBytes: number;
    sha256: string;
    installedAt: string;
  }>;
}

export interface TtsRuntimeStatus {
  provider: "piper";
  source: "managed" | "env_override" | "manual";
  readiness: TtsRuntimeReadiness;
  binaryReady: boolean;
  binaryPath?: string;
  binaryVersion?: string;
  selectedVoiceId?: string;
  selectedVoiceModelPath?: string;
  selectedVoiceConfigPath?: string;
  manifestPath: string;
  lastError?: string;
}

export async function readManagedTtsManifest(): Promise<ManagedTtsManifest | null> {
  const { ttsManifestPath } = resolveVoiceRuntimePaths();
  try {
    const raw = await fs.readFile(ttsManifestPath, "utf8");
    return JSON.parse(raw) as ManagedTtsManifest;
  } catch {
    return null;
  }
}

export async function writeManagedTtsManifest(manifest: ManagedTtsManifest): Promise<void> {
  const { ttsManifestPath, voiceDir } = resolveVoiceRuntimePaths();
  await fs.mkdir(voiceDir, { recursive: true });
  await fs.writeFile(ttsManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function getManagedTtsRuntimeStatus(): Promise<TtsRuntimeStatus> {
  const manifest = await readManagedTtsManifest();
  const envBinaryPath = process.env.GOATCITADEL_PIPER_BIN?.trim();
  const envVoicePath = process.env.GOATCITADEL_PIPER_VOICE_PATH?.trim();
  const selectedVoiceId =
    manifest?.selectedVoiceId ??
    manifest?.voices.find((item) => item.voiceId === DEFAULT_MANAGED_TTS_VOICE_ID)?.voiceId ??
    manifest?.voices[0]?.voiceId;
  const selectedVoice = selectedVoiceId ? manifest?.voices.find((item) => item.voiceId === selectedVoiceId) : undefined;

  const binaryPath = envBinaryPath || manifest?.piper?.binaryPath;
  const voiceModelPath = envVoicePath || selectedVoice?.modelPath;
  const voiceConfigPath = envVoicePath ? `${envVoicePath}.json` : selectedVoice?.configPath;
  const isEnvOverride = Boolean(envBinaryPath || envVoicePath);
  const binaryReady = await pathExists(binaryPath);
  const voiceReady = (await pathExists(voiceModelPath)) && (await pathExists(voiceConfigPath));
  const source = isEnvOverride
    ? "env_override"
    : binaryReady || (manifest?.voices.length ?? 0) > 0
      ? "managed"
      : "manual";
  const readiness: TtsRuntimeReadiness = binaryReady && voiceReady ? "ready" : binaryReady ? "broken" : "missing";
  const derivedSelectedVoiceId = envVoicePath
    ? (selectedVoiceId ?? path.basename(envVoicePath, ".onnx"))
    : selectedVoiceId;

  return {
    provider: "piper",
    source,
    readiness,
    binaryReady,
    binaryPath,
    binaryVersion: manifest?.piper?.version,
    selectedVoiceId: derivedSelectedVoiceId,
    selectedVoiceModelPath: voiceModelPath,
    selectedVoiceConfigPath: voiceConfigPath,
    manifestPath: resolveVoiceRuntimePaths().ttsManifestPath,
    lastError: manifest?.lastError,
  };
}

export function resolveManagedTtsVoicePaths(voiceId: string): { modelPath: string; configPath: string } {
  const voice = getManagedTtsVoice(voiceId);
  if (!voice) {
    throw new Error(`Unknown managed TTS voice: ${voiceId}`);
  }
  const { ttsVoicesDir } = resolveVoiceRuntimePaths();
  return {
    modelPath: path.join(ttsVoicesDir, voice.modelFileName),
    configPath: path.join(ttsVoicesDir, voice.configFileName),
  };
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
