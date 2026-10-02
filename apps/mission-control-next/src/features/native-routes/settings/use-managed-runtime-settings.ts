import { useEffect, useRef, useState } from "react";
import {
  fetchSettings,
  patchSettings,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../library/session-drafts";
import { useSettingsChange } from "./use-settings-change";
import {
  MANAGED_RUNTIME_DRAFT_KEY,
  hasManagedRuntimeSettings,
  isManagedRuntimeRevisionConflict,
  managedRuntimeInputError,
  managedRuntimeValues,
  matchesManagedRuntimePlan,
  normalizeManagedRuntime,
  retainManagedRuntimeUncertainty,
  runtimeManagementMode,
  sameRuntimeValues,
  useManagedRuntimeUncertainty,
  type ManagedRuntimeValues,
} from "./managed-runtime-state";

interface RuntimeReview {
  revision: number;
  current: ManagedRuntimeValues;
  submitted: ManagedRuntimeValues;
}
const SUBMITTED_NOTICE = "Change submitted. Wait for the Gateway to confirm settlement before another save.";
export function useManagedRuntimeSettings(options: {
  settings: RuntimeSettingsResponse | undefined;
  available: boolean;
  active?: boolean;
  reload: () => Promise<unknown>;
}) {
  const { settings, available, reload } = options;
  const ready = available && hasManagedRuntimeSettings(settings);
  const managed = ready && runtimeManagementMode(settings) === "managed";
  const current = managedRuntimeValues(settings);
  const draft = useSessionDraft(MANAGED_RUNTIME_DRAFT_KEY, current, settings?.revision, {
    label: "Managed llama.cpp configuration",
    available: ready,
    active: options.active,
    onSave: () => requestReview(),
  });
  const change = useSettingsChange<ManagedRuntimeValues>({
    key: draft.key,
    operation: "llama_cpp_configuration",
    matchesPlan: matchesManagedRuntimePlan,
    matches: (saved, submitted) =>
      runtimeManagementMode(saved) === "managed" &&
      sameRuntimeValues(managedRuntimeValues(saved), normalizeManagedRuntime(submitted)),
    acceptSaved: (value, revision, submitted) => draft.acceptSaved(normalizeManagedRuntime(value), revision, submitted),
    reload,
  });
  const uncertain = useManagedRuntimeUncertainty();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<RuntimeReview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const inputError = managedRuntimeInputError(draft.value);
  const locked = busy || change.hasPending || Boolean(uncertain);
  const active = options.active !== false;
  const canReview = active && managed && !locked && draft.isDirty && !draft.hasRemoteChanges && !inputError;
  const latestEditor = useRef({ active, managed, value: draft.value, revision: draft.baseRevision });
  const editorEpoch = useRef(0);
  if (
    latestEditor.current.active !== active ||
    latestEditor.current.managed !== managed ||
    latestEditor.current.revision !== draft.baseRevision ||
    !sameRuntimeValues(latestEditor.current.value, draft.value)
  ) {
    editorEpoch.current += 1;
  }
  latestEditor.current = { active, managed, value: draft.value, revision: draft.baseRevision };
  const reviewCurrent = Boolean(
    review &&
    canReview &&
    review.revision === draft.baseRevision &&
    sameRuntimeValues(review.current, current) &&
    sameRuntimeValues(review.submitted, draft.value),
  );

  async function requestReview(): Promise<boolean> {
    if (!active || !managed || locked || draft.hasRemoteChanges || inputError) return false;
    if (!draft.isDirty) return true;
    if (!canReview) return false;
    setNotice(null);
    setReview({ revision: Number(draft.baseRevision), current, submitted: draft.value });
    return false;
  }
  async function confirm(): Promise<boolean> {
    if (!review || !reviewCurrent || !change.beginSave()) return false;
    const intent = review;
    const reviewedEpoch = editorEpoch.current;
    setBusy(true);
    setReview(null);
    setNotice(null);
    let attempted = false;
    let acknowledged = false;
    try {
      const latest = await fetchSettings();
      if (!mounted.current) return false;
      if (
        editorEpoch.current !== reviewedEpoch ||
        !latestEditor.current.active ||
        !latestEditor.current.managed ||
        latestEditor.current.revision !== intent.revision ||
        !sameRuntimeValues(latestEditor.current.value, intent.submitted)
      ) {
        setNotice("The reviewed runtime draft is no longer active. Review it again before saving.");
        return false;
      }
      if (
        !hasManagedRuntimeSettings(latest) ||
        runtimeManagementMode(latest) !== "managed" ||
        latest.revision !== intent.revision ||
        !sameRuntimeValues(managedRuntimeValues(latest), intent.current)
      ) {
        setNotice("Runtime settings changed. Your draft is preserved; refresh and review the current revision.");
        await reload();
        return false;
      }
      attempted = true;
      const result = await patchSettings({
        expectedRevision: intent.revision,
        llamaCpp: normalizeManagedRuntime(intent.submitted),
      });
      const saved = change.receive(result, intent.submitted, intent.revision);
      acknowledged = true;
      setNotice(
        saved
          ? "Runtime configuration saved and confirmed. Refresh runtime health to check the process."
          : SUBMITTED_NOTICE,
      );
      try {
        await reload();
      } catch {
        /* Preserve the acknowledged owner result across a failed follow-up read. */
      }
      return saved;
    } catch (error) {
      if (isManagedRuntimeRevisionConflict(error, intent.revision)) {
        setNotice("The Gateway rejected the stale runtime revision. Your draft is preserved for review.");
        try {
          await reload();
        } catch {
          /* Keep the fresh owner read unavailable instead of inventing a confirmed result. */
        }
      } else if (attempted && !acknowledged) {
        retainManagedRuntimeUncertainty(
          "Save outcome is uncertain. Further runtime saves are locked in this app session; inspect Settings activity before continuing.",
        );
      } else setNotice(`Could not confirm current runtime settings. ${describeApiError(error).summary}`);
      return false;
    } finally {
      change.endSave();
      if (mounted.current) setBusy(false);
    }
  }
  return {
    ready,
    managed,
    current,
    draft,
    change,
    uncertain,
    busy,
    review,
    reviewCurrent,
    notice: notice === SUBMITTED_NOTICE && change.change && !change.change.blocking ? null : notice,
    locked,
    canReview,
    inputError,
    requestReview,
    confirm,
    cancel: () => setReview(null),
  };
}
