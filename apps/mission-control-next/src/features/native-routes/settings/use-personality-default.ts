import { useState, useSyncExternalStore } from "react";
import type { PersonalityCatalogResponse, PersonalityPreset } from "@goatcitadel/contracts";
import {
  fetchPersonalities,
  isApiRequestError,
  setDefaultPersonality,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

export const PERSONALITY_DEFAULT_SCOPE =
  "Changes the default for future Work turns, including existing conversations. Policy stays unchanged.";

export interface DefaultReview {
  preset: PersonalityPreset;
  revision: string;
  previousDefaultId: string;
}
export interface DefaultAttempt {
  phase: "idle" | "checking" | "saving" | "saved" | "uncertain";
  message?: string;
}
const IDLE: DefaultAttempt = { phase: "idle" };
let attempt = IDLE;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function updateAttempt(next: DefaultAttempt) {
  attempt = next;
  for (const listener of listeners) listener();
}
const isLocked = () => ["checking", "saving", "uncertain"].includes(attempt.phase);

export function hasPersonalityCatalog(
  value: PersonalityCatalogResponse | undefined,
): value is PersonalityCatalogResponse {
  return Boolean(
    value &&
    /^[a-f0-9]{64}$/.test(value.revision) &&
    Array.isArray(value.items) &&
    value.items.some((item) => item.id === value.defaultPersonalityId),
  );
}
function isRevisionConflict(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "WRITE_CONFLICT" &&
    details?.reason === "PERSONALITY_CATALOG_REVISION_CONFLICT" &&
    body.committed !== true &&
    body.mutationCommitted !== true &&
    details.committed !== true &&
    details.mutationCommitted !== true
  );
}

/** Both shells share the owner action and its app-session uncertainty lock. */
export function usePersonalityDefault({
  catalog,
  available,
  reload,
}: {
  catalog: PersonalityCatalogResponse | undefined;
  available: boolean;
  reload: () => Promise<unknown>;
}) {
  const state = useSyncExternalStore(
    subscribe,
    () => attempt,
    () => IDLE,
  );
  const [review, setReview] = useState<DefaultReview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ready = available && hasPersonalityCatalog(catalog);
  const pending = state.phase === "checking" || state.phase === "saving";
  const locked = pending || state.phase === "uncertain";
  const reviewCurrent = Boolean(
    ready &&
    review &&
    catalog.revision === review.revision &&
    catalog.defaultPersonalityId === review.previousDefaultId &&
    catalog.items.some((item) => item.id === review.preset.id),
  );

  function requestReview(id: string) {
    if (!ready || isLocked()) return;
    const preset = catalog.items.find((item) => item.id === id);
    if (!preset) return;
    setNotice(null);
    updateAttempt(IDLE);
    setReview({
      preset: structuredClone(preset),
      revision: catalog.revision,
      previousDefaultId: catalog.defaultPersonalityId,
    });
  }
  function cancel() {
    if (!pending) setReview(null);
  }
  async function refreshOwner() {
    try {
      await reload();
    } catch {
      /* Preserve an acknowledged or uncertain mutation outcome across refresh failure. */
    }
  }
  async function confirm(): Promise<boolean> {
    if (!review || !reviewCurrent || isLocked()) return false;
    const intent = review;
    updateAttempt({ phase: "checking" });
    setNotice(null);
    let mutationAttempted = false;
    try {
      const latest = await fetchPersonalities();
      if (
        !hasPersonalityCatalog(latest) ||
        latest.revision !== intent.revision ||
        latest.defaultPersonalityId !== intent.previousDefaultId ||
        !latest.items.some((item) => item.id === intent.preset.id)
      ) {
        setNotice("The personality catalog changed. Review the current saved personality before applying it.");
        updateAttempt(IDLE);
        setReview(null);
        await refreshOwner();
        return false;
      }
      mutationAttempted = true;
      updateAttempt({ phase: "saving" });
      const saved = await setDefaultPersonality(intent.preset.id, intent.revision);
      if (
        !hasPersonalityCatalog(saved) ||
        saved.defaultPersonalityId !== intent.preset.id ||
        saved.revision === intent.revision
      )
        throw new Error("The Gateway did not return the expected committed catalog.");
      updateAttempt({
        phase: "saved",
        message:
          intent.preset.id === "default"
            ? "Global Work personality cleared and confirmed by the Gateway."
            : `${intent.preset.label} saved as the global Work default and confirmed by the Gateway.`,
      });
      setReview(null);
      await refreshOwner();
      return true;
    } catch (error) {
      setReview(null);
      if (mutationAttempted && !isRevisionConflict(error)) {
        updateAttempt({
          phase: "uncertain",
          message:
            "Default change outcome is uncertain. Further default changes are locked in this app session. Refresh the catalog to inspect current owner state before continuing.",
        });
      } else {
        updateAttempt(IDLE);
        setNotice(
          mutationAttempted
            ? "The Gateway rejected a stale catalog revision. Review the current saved personality before trying again."
            : `Could not confirm the current catalog. ${describeApiError(error).summary}`,
        );
      }
      await refreshOwner();
      return false;
    }
  }
  return {
    review,
    reviewCurrent,
    pending,
    locked,
    ready,
    requestReview,
    cancel,
    confirm,
    notice: state.message ?? notice,
    uncertain: state.phase === "uncertain",
  };
}

export function __resetPersonalityDefaultForTests() {
  updateAttempt(IDLE);
}
