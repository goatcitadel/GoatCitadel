import { describe, expect, it, vi } from "vitest";
import { createGalleryWaveRunner, type GalleryWave } from "./gallery-wave";

const target = {} as HTMLElement;
const source = {} as HTMLElement;

function deferredWave() {
  let update: (() => void) | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const skip = vi.fn(finish);
  const wave: GalleryWave = (_target, callback) => {
    update = callback;
    return { finished, skip };
  };
  return { wave, skip, finish, update: () => update?.() };
}

describe("gallery wave", () => {
  it("applies an unavailable or throwing effect's update exactly once", () => {
    const runner = createGalleryWaveRunner();
    const update = vi.fn();
    runner.run(undefined, target, source, update);
    runner.run(
      (_target, callback) => {
        callback();
        throw new Error("capture");
      },
      target,
      source,
      update,
    );
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("applies rapid activations in order and ignores a late callback", () => {
    const runner = createGalleryWaveRunner();
    const wave = deferredWave();
    const changes: number[] = [];
    runner.run(wave.wave, target, source, () => changes.push(1));
    runner.run(wave.wave, target, source, () => changes.push(2));
    wave.update();
    expect(changes).toEqual([1, 2]);
    expect(wave.skip).toHaveBeenCalledOnce();
  });

  it("cleans up on leave and ignores updates after disposal", () => {
    const runner = createGalleryWaveRunner();
    const wave = deferredWave();
    const update = vi.fn();
    runner.run(wave.wave, target, source, update);
    runner.dispose();
    wave.update();
    expect(wave.skip).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("applies the update if the effect rejects before calling it", async () => {
    const runner = createGalleryWaveRunner();
    const update = vi.fn();
    runner.run(() => ({ finished: Promise.reject(new Error("WebGL")), skip: () => {} }), target, source, update);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  });
});
