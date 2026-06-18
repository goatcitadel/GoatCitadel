import type { TavernAudioCaptureDefaults } from "@goatcitadel/contracts";

export interface TavernAudioCaptureConstraintSet {
  audio: TavernAudioCaptureDefaults;
  video: false;
}

interface NavigatorWithAudioCapture {
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
}

const TAVERN_BROWSER_AUDIO_CAPTURE_DEFAULTS: TavernAudioCaptureDefaults = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export function buildTavernAudioCaptureConstraints(
  overrides: Partial<TavernAudioCaptureDefaults> = {},
): TavernAudioCaptureConstraintSet {
  return {
    audio: {
      ...TAVERN_BROWSER_AUDIO_CAPTURE_DEFAULTS,
      ...overrides,
    },
    video: false,
  };
}

export function isTavernAudioCaptureSupported(
  navigatorLike: NavigatorWithAudioCapture | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  return typeof navigatorLike?.mediaDevices?.getUserMedia === "function";
}
