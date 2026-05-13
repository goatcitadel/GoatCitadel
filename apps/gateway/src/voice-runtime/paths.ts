import os from "node:os";
import path from "node:path";
import type { ManagedVoicePlatform } from "./catalog.js";

const PREFERRED_HOME_NAME = ".GoatCitadel";

export interface VoiceRuntimePaths {
  goatHome: string;
  toolsDir: string;
  voiceDir: string;
  whisperDir: string;
  modelsDir: string;
  ffmpegDir: string;
  manifestPath: string;
}

export function resolveGoatCitadelHome(): string {
  const envHome = process.env.GOATCITADEL_HOME?.trim();
  if (envHome) {
    return path.resolve(envHome);
  }
  const preferred = path.join(os.homedir(), PREFERRED_HOME_NAME);
  return preferred;
}

export function resolveVoiceRuntimePaths(): VoiceRuntimePaths {
  const goatHome = resolveGoatCitadelHome();
  const toolsDir = path.join(goatHome, "tools");
  const voiceDir = path.join(toolsDir, "voice");
  return {
    goatHome,
    toolsDir,
    voiceDir,
    whisperDir: path.join(voiceDir, "whispercpp"),
    modelsDir: path.join(voiceDir, "models"),
    ffmpegDir: path.join(voiceDir, "ffmpeg"),
    manifestPath: path.join(voiceDir, "manifest.json"),
  };
}

export function detectManagedVoicePlatform(
  platform = process.platform,
  arch = process.arch,
): ManagedVoicePlatform | null {
  if (platform === "win32" && arch === "x64") {
    return "windows-x64";
  }
  if (platform === "win32" && arch === "arm64") {
    return "windows-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "darwin-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
  }
  return null;
}
