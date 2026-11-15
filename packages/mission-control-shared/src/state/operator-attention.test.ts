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
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it("closes the fallback context when resuming audio rejects", async () => {
    const close = vi.fn(async () => undefined);
    class RejectedAudioContext {
      readonly state = "suspended";
      readonly resume = vi.fn().mockRejectedValue(new Error("resume denied"));
      readonly close = close;
    }
    vi.stubGlobal("window", { AudioContext: RejectedAudioContext, setTimeout, clearTimeout });
    await expect(playOperatorAttentionSound("done", "normal")).resolves.toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds a pending resume and ignores a late resume after cleanup", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const createOscillator = vi.fn();
    let resolveResume!: () => void;
    class SuspendedAudioContext {
      readonly state = "suspended";
      readonly resume = () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve;
        });
      readonly close = close;
      readonly createOscillator = createOscillator;
    }
    vi.stubGlobal("window", { AudioContext: SuspendedAudioContext, setTimeout, clearTimeout });
    const playback = playOperatorAttentionSound("done", "normal");
    const settled = vi.fn();
    void playback.then(settled);
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toHaveBeenCalledWith(false);
    expect(close).toHaveBeenCalledTimes(1);
    resolveResume();
    await playback;
    expect(createOscillator).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the context when note setup throws and tolerates a rejected close", async () => {
    const close = vi.fn().mockRejectedValue(new Error("already closed"));
    class BrokenAudioContext extends FakeAudioContext {
      override readonly close = close;
      override createOscillator(): never {
        throw new Error("oscillator unavailable");
      }
    }
    vi.stubGlobal("window", { AudioContext: BrokenAudioContext, setTimeout, clearTimeout });
    await expect(playOperatorAttentionSound("done", "normal")).resolves.toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
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
