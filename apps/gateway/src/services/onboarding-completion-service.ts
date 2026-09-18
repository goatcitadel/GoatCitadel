import { persistOnboardingMarker, type OnboardingMarkerHost } from "./onboarding-marker-helpers.js";

interface OnboardingCompletionHost extends OnboardingMarkerHost {
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** Setup completion is a retained operator marker, not proof of model inference. */
export async function recordOnboardingCompletion(runtime: OnboardingCompletionHost, completedBy: string) {
  runtime.onboardingMarker = {
    completedAt: runtime.onboardingMarker.completedAt ?? new Date().toISOString(),
    completedBy: runtime.onboardingMarker.completedBy ?? (completedBy.trim() || "operator"),
  };
  persistOnboardingMarker(runtime);
  await runtime.publishRealtime("system", "onboarding", {
    type: "onboarding_completed",
    completedAt: runtime.onboardingMarker.completedAt,
    completedBy: runtime.onboardingMarker.completedBy,
  });
}
