import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { recordOnboardingCompletion } from "./onboarding-completion-service.js";

it("persists the first setup marker before publishing and preserves it on repeat", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "goat-onboarding-completion-"));
  try {
    const runtime = {
      onboardingMarkerPath: path.join(root, "onboarding.json"),
      onboardingMarker: {} as { completedAt?: string; completedBy?: string },
      publishRealtime: vi.fn(async (_type: string, _source: string, payload: Record<string, unknown>) => {
        expect(JSON.parse(await readFile(runtime.onboardingMarkerPath, "utf8"))).toEqual(runtime.onboardingMarker);
        expect(payload).toEqual({ type: "onboarding_completed", ...runtime.onboardingMarker });
      }),
    };
    await recordOnboardingCompletion(runtime, "  operator-a  ");
    const first = { ...runtime.onboardingMarker };
    expect(first.completedBy).toBe("operator-a");
    expect(Number.isFinite(Date.parse(first.completedAt!))).toBe(true);
    await recordOnboardingCompletion(runtime, "operator-b");
    expect(runtime.onboardingMarker).toEqual(first);
    expect(runtime.publishRealtime).toHaveBeenCalledTimes(2);
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^goat-onboarding-completion-/u);
    await rm(root, { recursive: true, force: true });
  }
});
