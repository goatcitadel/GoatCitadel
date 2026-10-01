import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { CitadelRecord } from "@goatcitadel/contracts";
import { createCitadel, listCitadels, updateCitadel } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../library/session-drafts";
import { citadelDraft, citadelEditorReceiptMatches, citadelEditorRejectedBeforeCommit, citadelRequestedSlug, CITADEL_KINDS } from "./citadel-editor-binding";
import { directoryLifecycleConflict, hasCitadelRecord, sameDirectoryRecord } from "./directory-lifecycle-binding";
import { setWorkspaceAttempt, subscribeWorkspaceAttempts, workspaceAttempt, workspaceAttemptLocked } from "./workspace-editor-state";

interface CitadelEditorOptions { ownerKey: string; selected: CitadelRecord | null; selectedId: string; mode: "create" | "edit" | null;
  available: boolean; reload: () => Promise<unknown>; onCreated?: (record: CitadelRecord) => void }
/** Retained metadata input and the same record lock used by archive/restore. */
export function useCitadelEditor({ ownerKey, selected, selectedId, mode, available, reload, onCreated }: CitadelEditorOptions) {
  const createKey = "citadel:global:new", editKey = `citadel:${selectedId}:edit`, key = mode === "create" ? createKey : editKey;
  const createDraft = useSessionDraft(createKey, citadelDraft(), undefined, { label: "New Citadel", active: mode === "create", onSave: () => submit("create") });
  const editDraft = useSessionDraft(editKey, citadelDraft(selected), selected?.revision, { label: selected?.name ?? "Citadel", active: mode === "edit",
    available: Boolean(selected), onSave: () => submit("edit") });
  const attempt = useSyncExternalStore(subscribeWorkspaceAttempts, () => workspaceAttempt(key), () => workspaceAttempt(key));
  const identity = JSON.stringify([ownerKey, selectedId, mode]);
  const live = useRef({ identity, available, mounted: true, generation: 0 });
  if (live.current.identity !== identity) { live.current.identity = identity; live.current.generation += 1; }
  live.current.available = available;
  useLayoutEffect(() => { const lifecycle = live.current; lifecycle.mounted = true;
    return () => { lifecycle.mounted = false; lifecycle.generation += 1; }; }, []);
  const locked = workspaceAttemptLocked(key), hasConflict = Boolean(attempt.rejectedRevision);
  const canRebase = !locked && Boolean(selected?.revision && selected.revision !== attempt.rejectedRevision);
  async function submit(kind: "create" | "edit"): Promise<boolean> {
    const targetKey = kind === "create" ? createKey : editKey, draft = kind === "create" ? createDraft : editDraft;
    if (workspaceAttemptLocked(targetKey) || mode !== kind || !available) return false;
    const inform = (message: string, rejectedRevision?: string) => setWorkspaceAttempt(targetKey, { phase: "idle", message, rejectedRevision });
    if (!draft.value.name.trim() || !citadelRequestedSlug(draft.value) || !CITADEL_KINDS.includes(draft.value.kind)) {
      inform("Citadel name, a valid slug, and kind are required."); return false;
    }
    if (kind === "edit" && (!hasCitadelRecord(selected) || editDraft.hasRemoteChanges || editDraft.baseRevision !== selected.revision || hasConflict)) {
      inform("Review the current Citadel before applying this draft.", attempt.rejectedRevision); return false;
    }
    const submitted = { ...draft.value }, before = selected ? structuredClone(selected) : undefined;
    const generation = live.current.generation;
    const current = () => live.current.mounted && live.current.identity === identity && live.current.generation === generation;
    let dispatched = false, acknowledged: CitadelRecord | undefined, saved: boolean;
    setWorkspaceAttempt(targetKey, { phase: "checking", message: "Checking the current Citadel directory…" });
    try {
      const directory = await listCitadels("all", 500);
      if (!current() || !live.current.available) { inform("Citadel save cancelled before dispatch."); return false; }
      if (!Array.isArray(directory.items)) throw new Error("Citadel directory is unavailable.");
      if (kind === "edit") {
        const matches = directory.items.filter((item) => item.citadelId === selectedId);
        if (matches.length !== 1 || !sameDirectoryRecord({ kind: "citadel", record: before!, action: "archive" }, matches[0]!)) {
          inform("The Citadel changed. Your draft is preserved; reload and review its current profile.", before?.revision);
          try { await reload(); } catch { /* Read owner exposes failures. */ } return false;
        }
      } else if (directory.items.some((item) => item.slug === citadelRequestedSlug(submitted) || item.citadelId === citadelRequestedSlug(submitted))) {
        inform("That Citadel slug is already in use. Choose a different slug."); return false;
      }
      if (!current() || !live.current.available) { inform("Citadel save cancelled before dispatch."); return false; }
      setWorkspaceAttempt(targetKey, { phase: "saving", message: "Waiting for the Gateway Citadel owner…" }); dispatched = true;
      acknowledged = kind === "create" ? await createCitadel({ name: submitted.name.trim(), description: submitted.description.trim() || undefined,
        slug: submitted.slug.trim() || undefined, kind: submitted.kind })
        : await updateCitadel(selectedId, { expectedRevision: before!.revision, name: submitted.name.trim(), description: submitted.description.trim(),
          slug: submitted.slug.trim() || undefined, kind: submitted.kind });
      if (!citadelEditorReceiptMatches(acknowledged, submitted, kind === "edit" ? before : undefined)) throw new Error("The Citadel receipt does not match the submitted profile.");
      const recorded = (await listCitadels("all", 500)).items.filter((item) => item.citadelId === acknowledged!.citadelId);
      if (recorded.length !== 1 || !sameDirectoryRecord({ kind: "citadel", record: acknowledged, action: "archive" }, recorded[0]!))
        throw new Error("The Citadel receipt could not be confirmed in its current owner.");
      // Draft acknowledgement persists independently of the displaying component and preserves newer typing.
      saved = draft.acceptSaved(kind === "create" ? citadelDraft() : citadelDraft(acknowledged), kind === "create" ? undefined : acknowledged.revision, submitted);
      setWorkspaceAttempt(targetKey, { phase: "saved", message: `Citadel ${acknowledged.name} ${kind === "create" ? "created" : "updated"}.` });
    } catch (error) {
      const conflict = kind === "edit" && before && directoryLifecycleConflict(error, { kind: "citadel", record: before, action: "archive" });
      if (!dispatched || conflict || citadelEditorRejectedBeforeCommit(error)) inform(describeApiError(error).summary, conflict ? before?.revision : undefined);
      else setWorkspaceAttempt(targetKey, { phase: "uncertain", message: "Citadel save outcome is unconfirmed. Further writes to this record are locked for this app session. Refresh and inspect its current owner before taking another action." });
      if (current() && conflict) { try { await reload(); } catch { /* Read owner exposes failures. */ } }
      return false;
    }
    if (current()) {
      try { await reload(); } catch { /* A confirmed write remains recorded; the read owner exposes failures. */ }
      if (current() && kind === "create" && saved && acknowledged) onCreated?.(acknowledged);
    }
    return saved;
  }
  function rebase() { if (!canRebase) return; editDraft.rebaseToCurrent(); setWorkspaceAttempt(editKey, { phase: "idle" }); }
  return { createDraft, editDraft, create: () => submit("create"), save: () => submit("edit"), rebase, hasConflict, canRebase,
    rejectedRevision: attempt.rejectedRevision, locked, pending: ["checking", "saving"].includes(attempt.phase),
    uncertain: attempt.phase === "uncertain", notice: attempt.message };
}
