import { useSyncExternalStore } from "react";
import type { PersonalityCatalogResponse, PersonalityPreset } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import type { PersonalityEditorDraft } from "./helpers/personality-helpers";
import { hasPersonalityCatalog } from "./use-personality-default";

type Attempt = { pending: boolean; uncertain?: string };
const IDLE: Attempt = { pending: false };
let attempt = IDLE;
const listeners = new Set<() => void>();
function publish(next: Attempt) {
  attempt = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function usePersonalityEditorMutation() {
  return useSyncExternalStore(
    subscribe,
    () => attempt,
    () => IDLE,
  );
}
export function beginPersonalityEdit() {
  if (attempt.pending || attempt.uncertain) return false;
  publish({ pending: true });
  return true;
}
export function finishPersonalityEdit() {
  publish({ ...attempt, pending: false });
}
export function retainPersonalityEditUncertainty(message: string) {
  publish({
    pending: false,
    uncertain: `Outcome uncertain: ${message} Further personality edits are locked in this app session. Refresh the catalog to inspect saved state; your draft is retained.`,
  });
}
export function isPersonalityPrecommitConflict(error: unknown) {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>,
    details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "WRITE_CONFLICT" &&
    details?.reason === "PERSONALITY_CATALOG_REVISION_CONFLICT" &&
    body.committed !== true &&
    body.mutationCommitted !== true &&
    details.committed !== true &&
    details.mutationCommitted !== true
  );
}
export function confirmedPersonalityEdit(
  saved: PersonalityCatalogResponse,
  id: string,
  revision: string,
): PersonalityPreset {
  if (!hasPersonalityCatalog(saved) || saved.revision === revision)
    throw new Error("The Gateway did not confirm a newer personality catalog.");
  const item = saved.items.find((preset) => preset.id === id);
  if (!item) throw new Error("The saved catalog does not contain the submitted personality identity.");
  return item;
}
export function personalityDraftMatches(item: PersonalityPreset, draft: PersonalityEditorDraft) {
  const notes = draft.safetyNotes
    .split(/\r?\n/u)
    .map((note) => note.trim())
    .filter(Boolean);
  return (
    (["label", "description", "tone", "style", "systemOverlay"] as const).every((key) => {
      const value = draft[key].trim();
      return (item.builtin && !value) || item[key] === value;
    }) &&
    item.category === draft.category &&
    (!notes.length || JSON.stringify(item.safetyNotes) === JSON.stringify(notes))
  );
}
export function __resetPersonalityEditorMutationForTests() {
  publish(IDLE);
}
