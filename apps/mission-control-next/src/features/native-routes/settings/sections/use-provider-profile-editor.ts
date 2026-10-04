import { useMemo, useRef, useState, type SetStateAction } from "react";
import type { LlmProviderConfig } from "@goatcitadel/contracts";
import {
  fetchLlmConfig,
  createChangePlan,
  patchSettings,
  updateProviderTransport,
  type LlmRuntimeConfigResponse,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
  requestConfigFromDraft,
  type LlmTransportDraft,
} from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import {
  buildProviderEditorDraft,
  createEmptyProviderEditorDraft,
  type ProviderEditorDraft,
} from "../helpers/provider-drafts";
import { useSessionDraft } from "../../library/session-drafts";
import { useSettingsChange } from "../use-settings-change";
import { getErrorMessage } from "../SettingsShared";
import {
  matchesProviderSave,
  matchesProviderSavePlan,
  matchesProviderTargetRevision,
  providerProfilePlanRequest,
  type ProviderSaveDraft,
} from "./provider-save-contract";
import { prepareProviderSave, sendsProviderChanges } from "./provider-save-operation";
import { matchesProviderTransportReceipt } from "./provider-transport-receipt";
import type { ProviderCatalog, ProviderNoticeSetter } from "./provider-section-types";
import {
  beginProviderMutation,
  finishProviderMutation,
  isProviderPrecommitConflict,
  retainProviderMutationUncertainty,
  useProviderEditorEpoch,
  useProviderMutationState,
} from "./provider-mutation-state";

export function useProviderProfileEditor({
  config,
  reload,
  loadModelsForProvider,
  selectedProviderId,
  selectedProvider,
  selectedProviderConfig,
  editorMode,
  detailView,
  setNotice,
  onSaved,
  onSubmitted,
  governedCreation = false,
}: Pick<ProviderCatalog, "config" | "reload" | "loadModelsForProvider"> & {
  selectedProviderId: string;
  selectedProvider: ProviderCatalog["providers"][number] | null;
  selectedProviderConfig?: LlmProviderConfig;
  editorMode: "selected" | "new";
  detailView: string | null;
  setNotice: ProviderNoticeSetter;
  onSaved: (providerId: string) => void;
  onSubmitted?: () => void;
  governedCreation?: boolean;
}) {
  const [providerSaveBusy, setProviderSaveBusy] = useState(false);
  const savesInFlight = useRef(new Set<string>());
  const providerCanonical: ProviderSaveDraft = {
    ...(governedCreation && editorMode === "new"
      ? { governedCreation: true, credentialStorage: "keychain" as const }
      : {}),
    provider:
      editorMode === "new"
        ? createEmptyProviderEditorDraft()
        : buildProviderEditorDraft(selectedProviderConfig ?? selectedProvider),
    transport:
      editorMode === "new" ? createEmptyLlmTransportDraft() : draftFromRequestConfig(selectedProviderConfig?.request),
  };
  const providerEditor = useSessionDraft(
    `provider:system:${editorMode === "new" ? "new" : selectedProviderId}`,
    providerCanonical,
    config?.revision,
    {
      label: editorMode === "new" ? "New provider" : (selectedProvider?.label ?? "Provider"),
      active: detailView === "editor",
      available: Boolean(config),
      onSave: (): Promise<boolean> => handleSaveProvider(),
    },
  );
  const providerDraft = providerEditor.value.provider;
  const mutation = useProviderMutationState();
  const captureEditor = useProviderEditorEpoch({
    key: providerEditor.key,
    selectedProviderId,
    detailView,
    value: providerEditor.value,
    revision: providerEditor.baseRevision,
  });
  const captureView = useProviderEditorEpoch({ key: providerEditor.key, selectedProviderId, detailView });
  const providerTransportDraft = providerEditor.value.transport;
  const setProviderDraft = (update: SetStateAction<ProviderEditorDraft>) =>
    providerEditor.setValue((value) => ({
      ...value,
      provider: typeof update === "function" ? update(value.provider) : update,
    }));
  const setProviderTransportDraft = (update: SetStateAction<LlmTransportDraft>) =>
    providerEditor.setValue((value) => ({
      ...value,
      transport: typeof update === "function" ? update(value.transport) : update,
    }));
  const currentEditor = useRef({ key: providerEditor.key, providerId: selectedProviderId, view: detailView });
  if (
    currentEditor.current.key !== providerEditor.key ||
    currentEditor.current.providerId !== selectedProviderId ||
    currentEditor.current.view !== detailView
  )
    currentEditor.current = { key: providerEditor.key, providerId: selectedProviderId, view: detailView };
  const providerChange = useSettingsChange({
    key: providerEditor.key,
    read: fetchLlmConfig,
    matchesPlan: matchesProviderSavePlan,
    matchesTargetRevision: matchesProviderTargetRevision,
    matches: matchesProviderSave,
    acceptSaved: providerEditor.acceptSaved,
    reload,
  });
  const providerRequestValidation = useMemo(() => {
    try {
      return {
        request: requestConfigFromDraft(providerTransportDraft),
        error: null,
      };
    } catch (draftError) {
      return {
        request: undefined,
        error: getErrorMessage(draftError),
      };
    }
  }, [providerTransportDraft]);
  let saveOperation: ReturnType<typeof prepareProviderSave> | undefined;
  let creationRequest: ReturnType<typeof providerProfilePlanRequest> | undefined;
  let saveOperationError: string | undefined;
  let sendsChanges = false;
  try {
    const prepared = prepareProviderSave(
      providerEditor.value,
      providerCanonical,
      editorMode === "selected" && Boolean(selectedProviderConfig),
    );
    if (providerEditor.value.governedCreation && prepared.kind === "profile")
      creationRequest = providerProfilePlanRequest(providerEditor.value);
    sendsChanges = sendsProviderChanges(providerEditor.value, providerCanonical);
    saveOperation = prepared;
  } catch (error) {
    saveOperationError = getErrorMessage(error);
  }
  const handleSaveProvider = async (): Promise<boolean> => {
    if (mutation.pending || mutation.uncertain || providerEditor.hasRemoteChanges) return false;
    if (providerChange.isPending()) {
      await providerChange.refresh();
      return false;
    }
    if (savesInFlight.current.has(providerEditor.key)) return false;
    if (!providerDraft.providerId.trim() || !providerDraft.baseUrl.trim()) {
      setNotice({ tone: "warning", message: "Provide both a provider id and base URL before saving." });
      return false;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before saving this provider." });
      return false;
    }
    if (providerRequestValidation.error) {
      setNotice({ tone: "error", message: providerRequestValidation.error });
      return false;
    }
    if (!saveOperation) {
      setNotice({ tone: "warning", message: saveOperationError ?? "Review this provider edit before saving." });
      return false;
    }
    const submitted = providerEditor.value;
    const editorIdentity = currentEditor.current;
    const isCurrent = captureEditor();
    const viewCurrent = captureView();
    const revision = Number(providerEditor.baseRevision ?? config.revision);
    if (!providerChange.beginSave()) return false;
    if (!beginProviderMutation()) {
      providerChange.endSave();
      return false;
    }
    savesInFlight.current.add(providerEditor.key);
    setProviderSaveBusy(true);
    let attempted = false;
    let acknowledged = false;
    try {
      const latest = await fetchLlmConfig();
      if (!isCurrent()) return false;
      if (latest.revision !== revision) {
        setNotice({
          tone: "warning",
          message: "Provider settings changed. Your draft is preserved; refresh and review the current revision.",
        });
        await reload();
        return false;
      }
      attempted = true;
      let transportConfirmed = false;
      let next: LlmRuntimeConfigResponse & { changePlanReceipt?: RuntimeSettingsResponse["changePlanReceipt"] };
      if (saveOperation.kind === "transport") {
        const updated = await updateProviderTransport({
          expectedRevision: revision,
          providerId: saveOperation.providerId,
          request: saveOperation.request,
        });
        next = await fetchLlmConfig();
        if ("changePlanReceipt" in updated || !matchesProviderTransportReceipt(updated, next, submitted, revision)) {
          throw new Error(
            "The transport response did not confirm the reviewed values. Refresh owner evidence before another action.",
          );
        }
        transportConfirmed = true;
      } else {
        if (submitted.governedCreation && creationRequest) {
          const plan = await createChangePlan({
            workspaceId: "default",
            surface: "settings",
            request: creationRequest,
          });
          if (
            plan.origin.workspaceId !== "default" ||
            plan.origin.surface !== "settings" ||
            !matchesProviderTargetRevision(plan, submitted, revision) ||
            plan.status !== "awaiting_confirmation" ||
            plan.requiredAction?.kind !== "confirmation"
          )
            throw new Error(
              "The prepared provider plan does not match this reviewed profile and revision. Inspect the Gateway plan before another action.",
            );
          next = { ...latest, changePlanReceipt: plan };
        } else {
          const updated = await patchSettings({
            expectedRevision: revision,
            llm: { upsertProvider: saveOperation.profile },
          });
          next =
            updated.changePlanReceipt && !["completed", "applied"].includes(updated.changePlanReceipt.status)
              ? { ...updated.llm, revision: updated.revision, changePlanReceipt: updated.changePlanReceipt }
              : { ...(await fetchLlmConfig()), changePlanReceipt: updated.changePlanReceipt };
        }
      }
      const clean = transportConfirmed
        ? providerEditor.acceptSaved(
            {
              ...submitted,
              transport: draftFromRequestConfig(
                next.providerConfigs?.find((item) => item.providerId === submitted.provider.providerId.trim())?.request,
              ),
            },
            next.revision,
            submitted,
          )
        : providerChange.receive(next, submitted, revision);
      acknowledged = true;
      if (!clean && next.changePlanReceipt && viewCurrent() && currentEditor.current === editorIdentity)
        onSubmitted?.();
      await reload();
      if (viewCurrent() && currentEditor.current === editorIdentity) {
        if (clean) {
          onSaved(submitted.provider.providerId.trim());
          setNotice({
            tone: "success",
            message: transportConfirmed
              ? "Transport accepted by the Gateway. The saved revision and public fields were confirmed; header values remain hidden."
              : "Provider saved and confirmed.",
          });
        }
      }
      if (clean) void loadModelsForProvider(submitted.provider.providerId.trim(), { force: true });
      return clean;
    } catch (saveError) {
      if (attempted && !acknowledged && isProviderPrecommitConflict(saveError, revision)) {
        await reload();
        if (viewCurrent())
          setNotice({
            tone: "warning",
            message:
              "Provider settings changed elsewhere. Your provider draft is preserved; review the current settings, then save again to retry.",
          });
        return false;
      }
      if (attempted && !acknowledged) retainProviderMutationUncertainty();
      if (isCurrent())
        setNotice({
          tone: "error",
          message: acknowledged
            ? "The Gateway acknowledged the change, but refreshing provider evidence failed. Refresh its status."
            : getErrorMessage(saveError),
        });
      return false;
    } finally {
      savesInFlight.current.delete(providerEditor.key);
      providerChange.endSave();
      finishProviderMutation();
      setProviderSaveBusy(false);
    }
  };

  return {
    providerEditor,
    mutation,
    providerDraft,
    providerTransportDraft,
    setProviderDraft,
    setProviderTransportDraft,
    setCredentialStorage: (credentialStorage: "keychain" | "env") =>
      providerEditor.setValue((value) => ({ ...value, credentialStorage })),
    providerChange,
    providerRequestValidation,
    saveOperationKind: saveOperation?.kind,
    saveOperationError,
    /** Whether a save sends anything the saved profile doesn't hold; whitespace-only edits send nothing new. */
    sendsChanges,
    providerSaveBusy,
    setProviderSaveBusy,
    currentEditor,
    handleSaveProvider,
  };
}
