import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { WorkspaceRecord } from "@goatcitadel/contracts";
import {
  createWorkspace,
  fetchWorkspaces,
  listCitadels,
  updateWorkspace,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../library/session-drafts";
import {
  hasWorkspaceBinding,
  isWorkspaceRevisionConflict,
  setWorkspaceAttempt,
  subscribeWorkspaceAttempts,
  workspaceAttempt,
  workspaceAttemptLocked,
  workspaceDraft,
  workspaceReceiptMatches,
} from "./workspace-editor-state";
import { DIRECTORY_CHANGED_WHILE_CHECKING } from "./use-directory-lifecycle";

interface WorkspaceEditorOptions {
  citadelId?: string;
  citadelName?: string;
  selected: WorkspaceRecord | null;
  selectedId: string;
  mode: "create" | "edit" | null;
  /** The workspace records are loaded and valid and the Citadel is active. A refresh alone does not clear it. */
  available: boolean;
  /** The directory is refreshing: a new save waits, but a save already checking goes on. */
  checking?: boolean;
  metadataOnly?: boolean;
  reload: () => Promise<unknown>;
  onCreated?: (workspace: WorkspaceRecord) => void;
}

/** Shared by classic and cockpit. Retained input and uncertainty survive navigation in this app session. */
export function useWorkspaceEditor(options: WorkspaceEditorOptions) {
  const { citadelId, citadelName, selected, selectedId, mode, available, reload, onCreated, metadataOnly } = options;
  const checking = options.checking ?? false;
  const scope = citadelId ?? "legacy";
  const prefix = metadataOnly ? "workspace-metadata" : "workspace";
  const createKey = `${prefix}:${scope}:new`;
  const editKey = `${prefix}:${scope}:${selectedId}:edit`;
  // Draft schemas differ; both shells share the same canonical operation lock.
  const createAttemptKey = `workspace:${scope}:new`;
  const editAttemptKey = `workspace:${scope}:${selectedId}:edit`;
  const createDraft = useSessionDraft(createKey, workspaceDraft(), undefined, {
    label: `New workspace in ${citadelName ?? scope}`,
    active: mode === "create",
    onSave: () => create(),
  });
  const editDraft = useSessionDraft(editKey, workspaceDraft(selected), selected?.revision, {
    label: selected?.name ?? "Workspace",
    active: mode === "edit",
    available: Boolean(selected),
    onSave: () => save(),
  });
  const key = mode === "create" ? createAttemptKey : editAttemptKey;
  const attempt = useSyncExternalStore(
    subscribeWorkspaceAttempts,
    () => workspaceAttempt(key),
    () => workspaceAttempt(key),
  );
  const identity = JSON.stringify({ citadelId, selectedId: mode === "edit" ? selectedId : null, mode });
  const live = useRef({ available, identity, generation: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation += 1;
  }
  live.current.available = available;
  useLayoutEffect(() => {
    const lifecycle = live.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
    };
  }, []);
  const pending = attempt.phase === "checking" || attempt.phase === "saving";
  const locked = pending || attempt.phase === "uncertain";

  async function submit(kind: "create" | "edit"): Promise<boolean> {
    const targetKey = kind === "create" ? createAttemptKey : editAttemptKey;
    const draft = kind === "create" ? createDraft : editDraft;
    if (workspaceAttemptLocked(targetKey)) return false;
    const inform = (message: string) => setWorkspaceAttempt(targetKey, { phase: "idle", message });
    if (!citadelId || !available || mode !== kind) {
      inform("Choose an available Citadel before saving workspace metadata.");
      return false;
    }
    if (checking) {
      inform("This list is still refreshing. Try again in a moment.");
      return false;
    }
    if (!draft.value.name.trim()) {
      inform("Workspace name is required.");
      return false;
    }
    const expectedRevision = editDraft.baseRevision;
    if (
      kind === "edit" &&
      (!hasWorkspaceBinding(selected, citadelId) ||
        editDraft.hasRemoteChanges ||
        expectedRevision !== selected.revision)
    ) {
      inform("Review the current workspace before applying this draft.");
      return false;
    }
    const submittedDraft = { ...draft.value };
    const submitted = { ...submittedDraft, ...(metadataOnly && kind === "edit" ? { slug: selected!.slug } : {}) };
    const reviewed = selected ? structuredClone(selected) : undefined;
    const generation = live.current.generation;
    const isSameSelection = () => live.current.mounted && live.current.generation === generation;
    // A background refresh never stops a confirmed save; the fresh read and revision-pinned write guard staleness.
    const isCurrent = () => isSameSelection() && live.current.available;
    const cancelled = () =>
      inform(
        isSameSelection()
          ? DIRECTORY_CHANGED_WHILE_CHECKING
          : "Workspace save cancelled because the selection changed.",
      );
    setWorkspaceAttempt(targetKey, { phase: "checking" });
    let dispatched = false;
    let savedClean: boolean;
    let acknowledged: WorkspaceRecord | undefined;
    try {
      const citadels = await listCitadels("all", 500);
      if (!isCurrent()) {
        cancelled();
        return false;
      }
      if (!citadels.items.some((item) => item.citadelId === citadelId && item.lifecycleStatus === "active")) {
        inform("This Citadel is unavailable or archived. Refresh before saving a workspace.");
        return false;
      }
      if (kind === "edit") {
        const current = await fetchWorkspaces("all", 500, citadelId);
        if (!isCurrent()) {
          cancelled();
          return false;
        }
        const matches = current.items.filter((item) => item.workspaceId === selectedId);
        if (
          (current.citadelId && current.citadelId !== citadelId) ||
          matches.length !== 1 ||
          !hasWorkspaceBinding(matches[0], citadelId) ||
          JSON.stringify(matches[0]) !== JSON.stringify(reviewed)
        ) {
          inform(
            "This workspace changed elsewhere. Your draft is preserved. Review the current revision before applying it.",
          );
          await reload();
          return false;
        }
      }
      if (!isCurrent()) {
        cancelled();
        return false;
      }
      setWorkspaceAttempt(targetKey, { phase: "saving" });
      dispatched = true;
      acknowledged =
        kind === "create"
          ? await createWorkspace({
              citadelId,
              name: submitted.name.trim(),
              description: submitted.description.trim() || undefined,
              slug: submitted.slug.trim() || undefined,
            })
          : await updateWorkspace(selectedId, {
              expectedRevision: expectedRevision as number,
              name: submitted.name.trim(),
              description: submitted.description.trim(),
              slug: submitted.slug.trim() || undefined,
            });
      if (!workspaceReceiptMatches(acknowledged, citadelId, submitted, kind === "edit" ? reviewed : undefined)) {
        throw new Error("The Gateway returned a workspace receipt that does not match this request.");
      }
      savedClean = draft.acceptSaved(
        kind === "create" ? workspaceDraft() : workspaceDraft(acknowledged),
        kind === "create" ? undefined : acknowledged.revision,
        submittedDraft,
      );
      setWorkspaceAttempt(targetKey, {
        phase: "saved",
        message:
          kind === "create"
            ? `Workspace ${acknowledged.name} created.`
            : `Workspace ${acknowledged.name} updated.${submitted.description.trim() ? "" : " Description cleared."}`,
      });
    } catch (error) {
      if (kind === "edit" && dispatched && isWorkspaceRevisionConflict(error, selectedId, expectedRevision as number)) {
        inform(
          "This workspace changed elsewhere. Your draft is preserved. Review the current revision before applying it.",
        );
        if (isCurrent()) await reload();
      } else if (dispatched) {
        setWorkspaceAttempt(targetKey, {
          phase: "uncertain",
          message:
            "The workspace save outcome is unconfirmed. Refresh the directory and inspect the saved record before taking further action. Repeating this request is locked for this app session.",
        });
      } else inform(`Workspace review unavailable: ${describeApiError(error).summary}`);
      return false;
    }
    // Canonical acknowledgement is retained even after navigation; UI refresh failures cannot undo it.
    if (isCurrent()) {
      try {
        await reload();
      } catch {
        /* The directory already owns its read error. */
      }
      if (isSameSelection() && kind === "create" && savedClean && acknowledged) onCreated?.(acknowledged);
    }
    return savedClean;
  }
  function create() {
    return submit("create");
  }
  function save() {
    return submit("edit");
  }
  return {
    createDraft,
    editDraft,
    create,
    save,
    pending,
    locked,
    notice: attempt.message,
    uncertain: attempt.phase === "uncertain",
  };
}
