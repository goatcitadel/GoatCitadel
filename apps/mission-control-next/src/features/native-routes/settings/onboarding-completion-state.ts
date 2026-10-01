import { useSyncExternalStore } from "react";
import { canonicalJsonString, type OnboardingState } from "@goatcitadel/contracts";

type Attempt = { phase: "pending" | "unknown"; message: string };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useOnboardingAttempt(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => attempts.get(key),
    () => undefined,
  );
}
export function getOnboardingAttempt(key: string) {
  return attempts.get(key);
}
export function setOnboardingAttempt(key: string, attempt?: Attempt) {
  if (attempt) attempts.set(key, attempt);
  else attempts.delete(key);
  for (const listener of listeners) listener();
}
export function onboardingCompletionBinding(state: OnboardingState | undefined): string | null {
  if (
    !state ||
    typeof state.completed !== "boolean" ||
    !Number.isSafeInteger(state.settings?.revision) ||
    state.settings.revision < 1 ||
    !["approve_all", "approve_risky", "bypass"].includes(state.settings.toolApprovalMode) ||
    !state.settings.llm ||
    !Array.isArray(state.settings.llm.providers)
  )
    return null;
  return canonicalJsonString({
    settings: state.settings,
    provider: state.setupReadiness?.items.find((item) => item.id === "provider") ?? null,
  });
}
export function onboardingModelReady(state: OnboardingState) {
  return Boolean(
    state.settings.llm.activeProviderId &&
    state.settings.llm.activeModel &&
    state.setupReadiness?.items.find((item) => item.id === "provider")?.status === "ready",
  );
}
export function onboardingSafeMode(state: OnboardingState) {
  return state.settings.toolApprovalMode === "approve_all" || state.settings.toolApprovalMode === "approve_risky";
}
export function hasOnboardingMarker(state: OnboardingState): boolean {
  return (
    state.completed === true &&
    typeof state.completedAt === "string" &&
    Number.isFinite(Date.parse(state.completedAt)) &&
    typeof state.completedBy === "string" &&
    Boolean(state.completedBy.trim())
  );
}
export function __resetOnboardingAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
