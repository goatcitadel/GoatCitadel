import { afterEach, describe, expect, it, vi } from "vitest";
import { playOperatorAttentionSound } from "./operator-attention";

class FakeAudioParam {
  readonly setValueAtTime = vi.fn();
  readonly exponentialRampToValueAtTime = vi.fn();
}

class FakeAudioContext {
  static created = 0;

  readonly currentTime = 1;
  readonly destination = {};
  readonly state = "running";
  readonly close = vi.fn();
  readonly resume = vi.fn();

  constructor() {
    FakeAudioContext.created += 1;
  }

  createOscillator() {
    return {
      type: "sine",
      frequency: new FakeAudioParam(),
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }

  createGain() {
    return {
      gain: new FakeAudioParam(),
      connect: vi.fn(),
    };
  }
}

describe("operator attention", () => {
  afterEach(() => {
    FakeAudioContext.created = 0;
    Reflect.deleteProperty(globalThis, "window");
  });

  it("stays silent when disabled or unavailable", async () => {
    expect(await playOperatorAttentionSound("done", "off")).toBe(false);
    expect(await playOperatorAttentionSound(undefined, "normal")).toBe(false);
    expect(await playOperatorAttentionSound("done", "normal")).toBe(false);
  });

  it("plays synthesized cues when Web Audio is available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: vi.fn((callback: () => void) => {
          callback();
          return 1;
        }),
      },
    });

    await expect(playOperatorAttentionSound("waiting", "subtle")).resolves.toBe(true);
    expect(FakeAudioContext.created).toBe(1);
  });

  it("prefers real sound assets when audio playback is available", async () => {
    const play = vi.fn(async () => undefined);
    const audioInstances: Array<{ preload: string; src: string; volume: number }> = [];

    class FakeAudio {
      preload = "";
      volume = 1;
      readonly src: string;

      constructor(src: string) {
        this.src = src;
        audioInstances.push(this);
      }

      play = play;
    }

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        Audio: FakeAudio,
      },
    });

    await expect(playOperatorAttentionSound("handoff_ready", "normal")).resolves.toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(audioInstances[0]).toMatchObject({
      preload: "auto",
      src: "/assets/sounds/handoff_ready.wav",
      volume: 0.85,
    });
  });
});
