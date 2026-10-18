import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSettings, isApiRequestError, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useSettingsChange } from "../../../features/native-routes/settings/use-settings-change";
import {
  EMPTY_ADD_ROOT_DRAFT,
  isWriteAccessProjection,
  matchesWriteAccessPlan,
  toolAccessDraft,
  writeAccessSaved,
  type WriteAccessSubmission,
} from "./filesystem-write-access";

export const WRITE_ACCESS_CHANGE_KEY = "tools:system:filesystem-write-access";

export type WriteAccessNotice = { tone: "done" | "waiting" | "failed"; message: string };

/** How one governed save ended. `rejected` means the Gateway refused it, so nothing changed. */
export type WriteAccessOutcome =
  | { kind: "saved"; revision: number; settings: RuntimeSettingsResponse }
  | { kind: "pending" }
  | { kind: "rejected"; message: string }
  | { kind: "stale" }
  | { kind: "blocked" }
  | { kind: "failed" };

/**
 * Settings custody for operator write roots and curated filesystem tool access:
 * one change at a time, each against the version the operator saw, with the
 * same plan, conflict and uncertain-outcome handling as the other Settings saves.
 */
export function useFilesystemWriteAccess() {
  const settings = useQuery({
    queryKey: ["system", "settings-filesystem-write-access"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const ready = Boolean(settings.data && !settings.isError && isWriteAccessProjection(settings.data));
  const access = settings.data?.globalToolAccess;
  const currentTools = useMemo(() => toolAccessDraft(access), [access]);
  const addDraft = useSessionDraft("tools:system:write-roots:add", EMPTY_ADD_ROOT_DRAFT, settings.data?.revision, {
    label: "New operator write root",
    available: ready,
  });
  const toolDraft = useSessionDraft("tools:system:fs-tool-access", currentTools, settings.data?.revision, {
    label: "Global filesystem tool access",
    available: ready,
  });
  const change = useSettingsChange<WriteAccessSubmission>({
    key: WRITE_ACCESS_CHANGE_KEY,
    matchesPlan: matchesWriteAccessPlan,
    matches: writeAccessSaved,
    acceptSaved: (_value, revision, submitted) => {
      if (submitted.kind === "tool") return toolDraft.acceptSaved(submitted.saved, revision, submitted.draft);
      if (submitted.draft) return addDraft.acceptSaved(EMPTY_ADD_ROOT_DRAFT, revision, submitted.draft);
      return true;
    },
    reload: () => settings.refetch(),
  });
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState<WriteAccessNotice | null>(null);
  const locked = busy || change.hasPending || uncertain || !ready;

  async function submit(submission: WriteAccessSubmission, baseRevision: number): Promise<WriteAccessOutcome> {
    if (!ready || uncertain || !Number.isSafeInteger(baseRevision) || !change.beginSave()) return { kind: "blocked" };
    setBusy(true);
    setNotice(null);
    let mutationAttempted = false;
    try {
      const latest = await fetchSettings();
      if (latest.revision !== baseRevision) {
        await settings.refetch();
        setNotice({
          tone: "waiting",
          message:
            "Filesystem access changed after this page loaded. Nothing was saved. Review the current folders and tool access, then try again.",
        });
        return { kind: "stale" };
      }
      mutationAttempted = true;
      const response = await patchSettings({
        expectedRevision: baseRevision,
        ...(submission.kind === "tool"
          ? { globalToolAccessChange: submission.change }
          : { operatorWriteRootChange: submission.change }),
      });
      const saved = change.receive(response, submission, baseRevision);
      await settings.refetch();
      return saved ? { kind: "saved", revision: response.revision, settings: response } : { kind: "pending" };
    } catch (error) {
      if (isApiRequestError(error) && error.status === 409) {
        await settings.refetch();
        setNotice({
          tone: "waiting",
          message: "Filesystem access changed elsewhere. Nothing was saved; your input is kept for review.",
        });
        return { kind: "stale" };
      }
      if (isApiRequestError(error) && (error.status === 400 || error.status === 422)) {
        // The Gateway refused the change before applying it, so the outcome is known.
        return { kind: "rejected", message: describeApiError(error).summary };
      }
      if (mutationAttempted) setUncertain(true);
      setNotice({
        tone: "failed",
        message: mutationAttempted
          ? `Save outcome is uncertain. Inspect Settings activity before another request. ${describeApiError(error).summary}`
          : `Could not confirm current settings. ${describeApiError(error).summary}`,
      });
      return { kind: "failed" };
    } finally {
      change.endSave();
      setBusy(false);
    }
  }

  return {
    settings,
    ready,
    currentTools,
    addDraft,
    toolDraft,
    change,
    busy,
    uncertain,
    notice,
    setNotice,
    locked,
    submit,
  };
}

export type FilesystemWriteAccess = ReturnType<typeof useFilesystemWriteAccess>;
