import type { TavernMediaQualityPreset, TavernMediaQualityPresetId } from "@goatcitadel/contracts";
import type { TavernMediaConnectionProfile } from "./media-playback-quality";

const TAVERN_MEDIA_SESSION_QUALITY_PRESETS: TavernMediaQualityPreset[] = [
  {
    presetId: "high",
    connectionQuality: "high",
    label: "High",
    maxVideo: { width: 1920, height: 1080, frameRate: 30 },
    audioFirst: false,
    intendedUse: "Strong connection with enough headroom for 1080p live video.",
  },
  {
    presetId: "balanced",
    connectionQuality: "balanced",
    label: "Balanced",
    maxVideo: { width: 1280, height: 720, frameRate: 30 },
    audioFirst: false,
    intendedUse: "Default live room target for ordinary broadband connections.",
  },
  {
    presetId: "constrained",
    connectionQuality: "constrained",
    label: "Constrained",
    maxVideo: { width: 854, height: 480, frameRate: 24 },
    audioFirst: false,
    intendedUse: "Lower bandwidth or higher latency links that still allow video.",
  },
  {
    presetId: "poor",
    connectionQuality: "poor",
    label: "Poor",
    maxVideo: { width: 640, height: 360, frameRate: 15 },
    audioFirst: true,
    intendedUse: "Poor live room conditions where voice continuity should win over video fidelity.",
  },
  {
    presetId: "data_saver",
    connectionQuality: "data_saver",
    label: "Data saver",
    maxVideo: { width: 640, height: 360, frameRate: 15 },
    audioFirst: true,
    intendedUse: "Operator-selected data saver mode; video should be optional and conservative.",
  },
];

const PROFILE_TO_PRESET: Record<TavernMediaConnectionProfile, TavernMediaQualityPresetId> = {
  high: "high",
  balanced: "balanced",
  constrained: "constrained",
  data_saver: "data_saver",
  unknown: "balanced",
};

export function resolveTavernMediaQualityPreset(input: {
  profile: TavernMediaConnectionProfile;
  requestedPresetId?: TavernMediaQualityPresetId;
}): TavernMediaQualityPreset {
  const resolved =
    findTavernMediaQualityPreset(input.requestedPresetId) ??
    findTavernMediaQualityPreset(PROFILE_TO_PRESET[input.profile]);
  if (resolved) {
    return resolved;
  }
  throw new Error(`Missing Tavern media quality preset for profile: ${input.profile}`);
}

export function describeTavernMediaPreset(presetId: TavernMediaQualityPresetId): string {
  const preset = findTavernMediaQualityPreset(presetId);
  if (!preset) {
    return "Unknown live media quality preset.";
  }
  const video = `${preset.maxVideo.height}p/${preset.maxVideo.frameRate}fps`;
  return preset.audioFirst ? `${preset.label}: ${video}, audio-first.` : `${preset.label}: ${video}.`;
}

export function listTavernMediaQualityPresets(): TavernMediaQualityPreset[] {
  return TAVERN_MEDIA_SESSION_QUALITY_PRESETS.map((preset) => ({
    ...preset,
    maxVideo: { ...preset.maxVideo },
  }));
}

function findTavernMediaQualityPreset(
  presetId: TavernMediaQualityPresetId | undefined,
): TavernMediaQualityPreset | null {
  if (!presetId) {
    return null;
  }
  return TAVERN_MEDIA_SESSION_QUALITY_PRESETS.find((preset) => preset.presetId === presetId) ?? null;
}
