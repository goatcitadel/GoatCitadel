import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CitadelRecord, WorkspaceRecord } from "@goatcitadel/contracts";
import {
  archiveCitadel,
  archiveWorkspace,
  fetchWorkspaces,
  listCitadels,
  restoreCitadel,
  restoreWorkspace,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { discardSessionDraft } from "../library/session-drafts";
import {
  directoryAttemptKey,
  directoryLifecycleConflict,
  directoryLifecycleReceiptMatches,
  directoryRecordId,
  hasCitadelRecord,
  sameDirectoryRecord,
  type DirectoryLifecycleReview,
} from "./directory-lifecycle-binding";
import {
  hasWorkspaceBinding,
  setWorkspaceAttempt,
  subscribeWorkspaceAttempts,
  workspaceAttempt,
  workspaceAttemptLocked,
  workspaceAttemptsVersion,
} from "./workspace-editor-state";

/** Shown beside an action that waits while its directory refreshes (its hook would ignore a click). */
export const CHECKING_FOR_CHANGES = "Checking for changes…";
/** Shown when a confirmed action stops before sending because its list was no longer ready. */
export const DIRECTORY_CHANGED_WHILE_CHECKING = "This list changed while checking. Review it again.";

interface DirectoryLifecycleOptions {
  ownerKey: string;
  /** The records are loaded and valid (and any parent is active). A refresh alone does not clear it. */
  available: boolean;
  /** The directory is refreshing: new reviews and confirm clicks wait, but a confirm already checking goes on. */
  checking?: boolean;
  reload: (kind: "workspace" | "citadel") => Promise<unknown>;
  onConfirmed?: (review: DirectoryLifecycleReview) => void;
}
/** Revision-bound lifecycle requests, shared across shells and workspace editors. */
export function useDirectoryLifecycle({
  ownerKey,
  available,
  checking = false,
  reload,
  onConfirmed,
}: DirectoryLifecycleOptions) {
  useSyncExternalStore(subscribeWorkspaceAttempts, workspaceAttemptsVersion, workspaceAttemptsVersion);
  const [review, setReview] = useState<DirectoryLifecycleReview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = useRef<DirectoryLifecycleReview | null>(null);
  const live = useRef({ ownerKey, available, checking, mounted: true, generation: 0 });
  live.current.available = available;
  live.current.checking = checking;
  const canStart = () => live.current.available && !live.current.checking;
  if (live.current.ownerKey !== ownerKey) {
    live.current.ownerKey = ownerKey;
    live.current.generation += 1;
  }
  useLayoutEffect(() => {
    const lifecycle = live.current;
    lifecycle.mounted = true;
    selected.current = null;
    setReview(null);
    setNotice(null);
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation += 1;
    };
  }, [ownerKey]);
  const key = review ? directoryAttemptKey(review) : "";
  const pending = Boolean(key && ["checking", "saving"].includes(workspaceAttempt(key).phase));
  function request(next: DirectoryLifecycleReview) {
    if (!canStart() || selected.current || workspaceAttemptLocked(directoryAttemptKey(next))) return;
    const valid =
      next.kind === "workspace" ? hasWorkspaceBinding(next.record, next.scope) : hasCitadelRecord(next.record);
    if (
      !valid ||
      next.record.lifecycleStatus !== (next.action === "archive" ? "active" : "archived") ||
      (next.kind === "workspace" && next.action === "archive" && next.record.workspaceId === "default")
    ) {
      setNotice("This record is not eligible for the requested lifecycle change.");
      return;
    }
    const captured = structuredClone(next);
    selected.current = captured;
    setReview(captured);
    setNotice(null);
    live.current.generation += 1;
  }
  function cancel() {
    if (selected.current && workspaceAttempt(directoryAttemptKey(selected.current)).phase === "saving") return;
    live.current.generation += 1;
    selected.current = null;
    setReview(null);
  }
  async function readRecord(target: DirectoryLifecycleReview): Promise<WorkspaceRecord | CitadelRecord> {
    const response =
      target.kind === "workspace" ? await fetchWorkspaces("all", 500, target.scope) : await listCitadels("all", 500);
    const rows = response.items as (WorkspaceRecord | CitadelRecord)[];
    if (
      !Array.isArray(rows) ||
      (target.kind === "workspace" &&
        "citadelId" in response &&
        response.citadelId &&
        response.citadelId !== target.scope)
    )
      throw new Error("The directory owner did not confirm the reviewed scope.");
    const matches = rows.filter(
      (item) =>
        (target.kind === "workspace" ? (item as WorkspaceRecord).workspaceId : (item as CitadelRecord).citadelId) ===
        directoryRecordId(target),
    );
    if (matches.length !== 1) throw new Error("The reviewed record is missing or duplicated in its directory owner.");
    return matches[0]!;
  }
  async function confirm(): Promise<boolean> {
    const target = selected.current;
    if (!target || !canStart() || workspaceAttemptLocked(directoryAttemptKey(target))) return false;
    const attemptKey = directoryAttemptKey(target),
      generation = live.current.generation;
    const current = () =>
      live.current.mounted &&
      live.current.ownerKey === ownerKey &&
      live.current.generation === generation &&
      selected.current === target;
    const inform = (message: string) => setWorkspaceAttempt(attemptKey, { phase: "idle", message });
    // A background refresh never stops a confirmed request; only a changed owner or a list that is no longer ready.
    const stillReviewing = () => current() && live.current.available;
    const stop = () => {
      inform(DIRECTORY_CHANGED_WHILE_CHECKING);
      if (current()) {
        setNotice(DIRECTORY_CHANGED_WHILE_CHECKING);
        selected.current = null;
        setReview(null);
      }
      return false;
    };
    setWorkspaceAttempt(attemptKey, { phase: "checking", message: "Reviewing current lifecycle state…" });
    let dispatched = false,
      confirmed = false;
    try {
      const before = await readRecord(target);
      if (!stillReviewing()) return stop();
      if (!sameDirectoryRecord(target, before))
        throw new Error("The reviewed record changed. Refresh and review its current revision before trying again.");
      if (target.kind === "workspace") {
        const parents = (await listCitadels("all", 500)).items.filter((item) => item.citadelId === target.scope);
        if (parents.length !== 1 || parents[0]?.lifecycleStatus !== "active")
          throw new Error("This Citadel is unavailable or archived. Refresh before changing its workspace lifecycle.");
      }
      if (!stillReviewing()) return stop();
      setWorkspaceAttempt(attemptKey, { phase: "saving", message: "Waiting for the Gateway lifecycle owner…" });
      dispatched = true;
      const receipt =
        target.kind === "workspace"
          ? await (target.action === "archive" ? archiveWorkspace : restoreWorkspace)(
              target.record.workspaceId,
              target.record.revision,
            )
          : await (target.action === "archive" ? archiveCitadel : restoreCitadel)(
              target.record.citadelId,
              target.record.revision,
            );
      if (!directoryLifecycleReceiptMatches(target, receipt))
        throw new Error("The Gateway did not confirm the exact reviewed lifecycle change.");
      const recorded = await readRecord(target);
      const acknowledged =
        target.kind === "workspace"
          ? { ...target, record: receipt as WorkspaceRecord }
          : { ...target, record: receipt as CitadelRecord };
      if (!sameDirectoryRecord(acknowledged, recorded))
        throw new Error("The saved lifecycle receipt does not match its current owner.");
      confirmed = true;
      const message = `${target.record.name} ${target.action === "archive" ? "archived" : "restored"}.`;
      setWorkspaceAttempt(attemptKey, { phase: "saved", message });
      if (target.action === "archive") {
        if (target.kind === "citadel") discardSessionDraft(`citadel:${target.record.citadelId}:edit`);
        else {
          discardSessionDraft(`workspace:${target.scope}:${target.record.workspaceId}:edit`);
          discardSessionDraft(`workspace-metadata:${target.scope}:${target.record.workspaceId}:edit`);
        }
      }
      if (current()) {
        setNotice(message);
        selected.current = null;
        setReview(null);
        onConfirmed?.(target);
        try {
          await reload(target.kind);
        } catch {
          if (live.current.mounted && live.current.generation === generation)
            setNotice(`${message} The displayed directory could not refresh. Refresh to inspect its current state.`);
        }
      }
      return true;
    } catch (error) {
      if (!dispatched || directoryLifecycleConflict(error, target)) {
        inform(
          dispatched
            ? "The record changed elsewhere. Refresh and review its current revision."
            : describeApiError(error).summary,
        );
      } else {
        setWorkspaceAttempt(attemptKey, {
          phase: "uncertain",
          message:
            "The lifecycle write outcome is unconfirmed. Further changes to this record are locked for this app session. Refresh and inspect its current owner before taking another action.",
        });
      }
      if (current()) {
        setNotice(workspaceAttempt(attemptKey).message ?? null);
        selected.current = null;
        setReview(null);
        if (dispatched && directoryLifecycleConflict(error, target)) {
          try {
            await reload(target.kind);
          } catch {
            /* Read owner already exposes its failure. */
          }
        }
      }
      return false;
    } finally {
      if (!dispatched && workspaceAttempt(attemptKey).phase === "checking") inform(DIRECTORY_CHANGED_WHILE_CHECKING);
      // Confirmed writes stay recorded even if their displaying editor was closed.
      if (confirmed && current()) setReview(null);
    }
  }
  return {
    review,
    pending,
    /** Whether `confirm` would act now; a confirm control must be disabled otherwise. */
    available: available && !checking,
    /** Only a refresh is holding confirm back; show {@link CHECKING_FOR_CHANGES}. */
    checking: available && checking,
    notice,
    request,
    cancel,
    confirm,
    locked: (target: DirectoryLifecycleReview) => workspaceAttemptLocked(directoryAttemptKey(target)),
    attempt: (target: DirectoryLifecycleReview) => workspaceAttempt(directoryAttemptKey(target)),
  };
}
