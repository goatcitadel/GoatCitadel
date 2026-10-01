import { useSyncExternalStore } from "react";
import { canonicalJsonString, type VoiceRuntimeStatus } from "@goatcitadel/contracts";

export type VoiceRuntimeAction = { kind: "install" | "select"; modelId: string };
export interface VoiceRuntimeReviewValue extends VoiceRuntimeAction {
  current: VoiceRuntimeStatus;
}
export const voiceSnapshot = (value: unknown) => canonicalJsonString(value);
export function voiceReady(status?: VoiceRuntimeStatus | null): status is VoiceRuntimeStatus {
  return Boolean(
    status &&
    status.provider === "whisper.cpp" &&
    ["managed", "manual", "env_override"].includes(status.source) &&
    ["ready", "missing", "broken"].includes(status.readiness) &&
    typeof status.binaryReady === "boolean" &&
    typeof status.ffmpegReady === "boolean" &&
    Array.isArray(status.catalog) &&
    Array.isArray(status.installedModels),
  );
}
export function voiceActionAvailable(status: VoiceRuntimeStatus, action: VoiceRuntimeAction) {
  if (!voiceReady(status) || status.source === "env_override" || !action.modelId.trim()) return false;
  return action.kind === "install"
    ? status.catalog.some((model) => model.id === action.modelId && model.sizeBytes > 0)
    : status.selectedModelId !== action.modelId &&
        status.installedModels.some(
          (model) => model.modelId === action.modelId && model.filePath && model.sizeBytes > 0,
        );
}
export function requireVoiceReceipt(review: VoiceRuntimeReviewValue, status: VoiceRuntimeStatus) {
  const selected = status?.installedModels?.find((model) => model.modelId === review.modelId);
  if (
    !voiceReady(status) ||
    status.source !== "managed" ||
    status.selectedModelId !== review.modelId ||
    !selected?.filePath ||
    !(selected.sizeBytes > 0)
  ) {
    throw new Error("The voice runtime did not confirm the reviewed model.");
  }
  if (review.kind === "select") {
    const before = review.current.installedModels.find((model) => model.modelId === review.modelId);
    if (
      !before ||
      before.filePath !== selected.filePath ||
      before.sizeBytes !== selected.sizeBytes ||
      before.installedAt !== selected.installedAt
    ) {
      throw new Error("The selected voice model changed during the request.");
    }
  }
}
type Attempt = { state: "pending" | "uncertain"; message: string };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
export function beginVoiceAttempt(key: string) {
  if (attempts.has(key)) return false;
  attempts.set(key, { state: "pending", message: "Waiting for the voice runtime owner." });
  publish();
  return true;
}
export function finishVoiceAttempt(key: string, uncertain: boolean) {
  if (uncertain)
    attempts.set(key, {
      state: "uncertain",
      message:
        "The voice runtime outcome is uncertain. Further voice installation and selection requests are locked in this app session. Inspect the runtime before continuing.",
    });
  else attempts.delete(key);
  publish();
}
export function useVoiceAttempt(key: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => attempts.get(key),
    () => undefined,
  );
}
export function __resetVoiceAttemptsForTests() {
  attempts.clear();
  publish();
}
