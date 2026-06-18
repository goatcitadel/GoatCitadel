import { describe, expect, it, vi } from "vitest";
import { buildTavernAudioCaptureConstraints, isTavernAudioCaptureSupported } from "./tavern-audio-capture";

describe("tavern audio capture helpers", () => {
  it("builds conservative browser audio capture constraints", () => {
    expect(buildTavernAudioCaptureConstraints()).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    expect(buildTavernAudioCaptureConstraints({ autoGainControl: false })).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
  });

  it("detects whether browser audio capture is available", () => {
    expect(isTavernAudioCaptureSupported(undefined)).toBe(false);
    expect(isTavernAudioCaptureSupported({})).toBe(false);
    expect(
      isTavernAudioCaptureSupported({
        mediaDevices: {
          getUserMedia: vi.fn(),
        },
      }),
    ).toBe(true);
  });
});
