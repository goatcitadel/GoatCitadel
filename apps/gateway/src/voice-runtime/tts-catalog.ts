import type { ManagedVoiceArchiveKind, ManagedVoicePlatform } from "./catalog.js";

/**
 * Managed Piper TTS lane (Competitive-gap program phase B2b).
 *
 * Mirrors the whisper.cpp lane in `catalog.ts`: every artifact is pinned by
 * URL + sha256. All digests below were computed from the actual downloaded
 * release bytes (rhasspy/piper 2023.11.14-2 GitHub release assets and the
 * rhasspy/piper-voices v1.0.0 Hugging Face artifacts); the voice model digest
 * also matches the Hugging Face LFS oid for the file.
 */

export interface ManagedPiperRuntimeSource {
  platform: ManagedVoicePlatform;
  archiveKind: Extract<ManagedVoiceArchiveKind, "zip" | "tar.gz">;
  version: string;
  url: string;
  sha256: string;
  /** Path of the piper executable inside the extracted archive. */
  binaryRelativePath: string;
}

export interface ManagedTtsVoiceSource {
  id: string;
  label: string;
  language: string;
  approxSizeLabel: string;
  sizeBytes: number;
  defaultInstall: boolean;
  /** Piper voices ship as an .onnx model plus a sibling .onnx.json config. */
  modelUrl: string;
  modelSha256: string;
  modelFileName: string;
  configUrl: string;
  configSha256: string;
  configFileName: string;
}

export const PIPER_RUNTIME_VERSION = "2023.11.14-2";

const PIPER_RELEASE_BASE_URL = `https://github.com/rhasspy/piper/releases/download/${PIPER_RUNTIME_VERSION}`;

const WINDOWS_PIPER_RUNTIME_SOURCE = {
  archiveKind: "zip",
  version: PIPER_RUNTIME_VERSION,
  url: `${PIPER_RELEASE_BASE_URL}/piper_windows_amd64.zip`,
  sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
  binaryRelativePath: "piper/piper.exe",
} as const satisfies Omit<ManagedPiperRuntimeSource, "platform">;

export const MANAGED_PIPER_RUNTIME_SOURCES: Record<ManagedVoicePlatform, ManagedPiperRuntimeSource> = {
  "windows-x64": {
    platform: "windows-x64",
    ...WINDOWS_PIPER_RUNTIME_SOURCE,
  },
  // Piper does not publish a windows-arm64 build; the x64 binary runs through
  // Windows emulation, mirroring the whisper lane's windows-arm64 posture.
  "windows-arm64": {
    platform: "windows-arm64",
    ...WINDOWS_PIPER_RUNTIME_SOURCE,
  },
  "darwin-x64": {
    platform: "darwin-x64",
    archiveKind: "tar.gz",
    version: PIPER_RUNTIME_VERSION,
    url: `${PIPER_RELEASE_BASE_URL}/piper_macos_x64.tar.gz`,
    sha256: "ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b",
    binaryRelativePath: "piper/piper",
  },
  "darwin-arm64": {
    platform: "darwin-arm64",
    archiveKind: "tar.gz",
    version: PIPER_RUNTIME_VERSION,
    url: `${PIPER_RELEASE_BASE_URL}/piper_macos_aarch64.tar.gz`,
    sha256: "6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc",
    binaryRelativePath: "piper/piper",
  },
  "linux-x64": {
    platform: "linux-x64",
    archiveKind: "tar.gz",
    version: PIPER_RUNTIME_VERSION,
    url: `${PIPER_RELEASE_BASE_URL}/piper_linux_x86_64.tar.gz`,
    sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
    binaryRelativePath: "piper/piper",
  },
};

const PIPER_VOICES_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";

export const MANAGED_TTS_VOICES: ManagedTtsVoiceSource[] = [
  {
    id: "en_US-lessac-medium",
    label: "English (US) — Lessac, medium",
    language: "en_US",
    approxSizeLabel: "60 MB",
    sizeBytes: 63201294,
    defaultInstall: true,
    modelUrl: `${PIPER_VOICES_BASE_URL}/en/en_US/lessac/medium/en_US-lessac-medium.onnx`,
    modelSha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
    modelFileName: "en_US-lessac-medium.onnx",
    configUrl: `${PIPER_VOICES_BASE_URL}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json`,
    configSha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
    configFileName: "en_US-lessac-medium.onnx.json",
  },
];

export const DEFAULT_MANAGED_TTS_VOICE_ID = "en_US-lessac-medium";

export function getManagedTtsVoice(voiceId: string): ManagedTtsVoiceSource | undefined {
  return MANAGED_TTS_VOICES.find((item) => item.id === voiceId);
}

export function getManagedPiperRuntimeSource(platform: ManagedVoicePlatform): ManagedPiperRuntimeSource {
  return MANAGED_PIPER_RUNTIME_SOURCES[platform];
}
