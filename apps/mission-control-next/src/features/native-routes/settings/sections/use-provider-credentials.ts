import { useEffect, useRef, useState, type RefObject } from "react";
import {
  fetchProviderSecretStatus,
  fetchSettings,
  saveProviderSecret,
  deleteProviderSecret,
} from "@goatcitadel/mission-control-shared/api/client";
import { useCredentialInput, retainCredentialSubmission, settleCredentialSubmission } from "../credential-input-owner";
import { useSettingsChange } from "../use-settings-change";
import { getErrorMessage, type LoadState } from "../SettingsShared";
import type { ProviderCatalog, ProviderNoticeSetter, ProviderEditorIdentity } from "./provider-section-types";
import {
  beginProviderMutation,
  dispatchProviderMutation,
  finishProviderMutation,
  isProviderPrecommitConflict,
  retainProviderMutationUncertainty,
  useProviderEditorEpoch,
  useProviderMutationState,
} from "./provider-mutation-state";

export function useProviderCredentials({
  config,
  reload,
  selectedProviderId,
  detailView,
  credentialEditorOpen,
  currentEditor,
  setNotice,
}: Pick<ProviderCatalog, "config" | "reload"> & {
  selectedProviderId: string;
  detailView: string | null;
  credentialEditorOpen: boolean;
  currentEditor: RefObject<ProviderEditorIdentity>;
  setNotice: ProviderNoticeSetter;
}) {
  const [pendingDeleteSecret, setDeleteReview] = useState<{
    providerId: string;
    label: string;
    revision: number;
  } | null>(null);
  const mutation = useProviderMutationState();
  const setPendingDeleteSecret = (review: { providerId: string; label: string } | null) => {
    if (!review) {
      setDeleteReview(null);
      return;
    }
    if (config && !mutation.pending && !mutation.uncertain) setDeleteReview({ ...review, revision: config.revision });
  };
  const captureView = useProviderEditorEpoch({ selectedProviderId, detailView, credentialEditorOpen });
  const [deleteSecretBusy, setDeleteSecretBusy] = useState(false);
  const savesInFlight = useRef(new Set<string>());
  const [secretState, setSecretState] = useState<LoadState<Awaited<ReturnType<typeof fetchProviderSecretStatus>>>>({
    loading: false,
    error: null,
    data: null,
  });
  const secretEditor = useCredentialInput(`provider-secret:system:${selectedProviderId}`, "", config?.revision, {
    label: "Provider credential",
    active: detailView === "trust" && credentialEditorOpen,
    available: Boolean(config),
    onSave: (): Promise<boolean> => handleSaveSecret(),
  });
  const secretValue = secretEditor.value;
  const captureEditor = useProviderEditorEpoch({
    selectedProviderId,
    detailView,
    credentialEditorOpen,
    credentialVersion: secretEditor.inputVersion,
    revision: secretEditor.baseRevision,
    pendingDeleteSecret,
  });
  const setSecretValue = secretEditor.setValue;
  const secretChange = useSettingsChange<string, Awaited<ReturnType<typeof saveProviderSecret>>>({
    key: secretEditor.key,
    matchesPlan: (plan) =>
      plan.request.kind === "provider_connection" &&
      plan.request.providerId === selectedProviderId &&
      plan.request.credentialAction === "replace_api_key" &&
      plan.target.ownerId === "provider_connection" &&
      plan.target.resourceId === selectedProviderId,
    read: async () => {
      const [status, settings] = await Promise.all([fetchProviderSecretStatus(selectedProviderId), fetchSettings()]);
      return { ...status, revision: settings.revision };
    },
    matches: (status) => status.providerId === selectedProviderId && status.hasSecret === true,
    savedValue: () => "",
    acceptSaved: (_value, revision, receipt) => settleCredentialSubmission(secretEditor.key, receipt, (submitted) => secretEditor.acceptSaved("", revision, submitted)),
    reload,
  });
  const secretRemoval = useSettingsChange<{ providerId: string }, Awaited<ReturnType<typeof deleteProviderSecret>>>({
    key: "provider-secret-removal:system:" + selectedProviderId,
    matchesPlan: (plan, submitted) =>
      plan.request.kind === "provider_connection" &&
      plan.request.providerId === submitted.providerId &&
      plan.request.credentialAction === "remove_api_key" &&
      plan.target.ownerId === "provider_connection" &&
      plan.target.resourceId === submitted.providerId,
    read: async (submitted) => {
      const [status, settings] = await Promise.all([fetchProviderSecretStatus(submitted.providerId), fetchSettings()]);
      return { ...status, revision: settings.revision };
    },
    matches: (status, submitted) => status.providerId === submitted.providerId && status.hasSecret === false,
    acceptSaved: () => true,
    reload,
  });
  useEffect(() => {
    if (detailView !== "trust" || !selectedProviderId) {
      setSecretState({ loading: false, error: null, data: null });
      return;
    }
    if (selectedProviderId === "openai-codex") {
      setSecretState({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setSecretState({ loading: true, error: null, data: null });
    void fetchProviderSecretStatus(selectedProviderId)
      .then((data) => {
        if (data.providerId !== selectedProviderId)
          throw new Error("Credential status did not identify the selected provider.");
        if (!cancelled) {
          setSecretState({ loading: false, error: null, data });
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setSecretState({ loading: false, error: loadError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProviderId, detailView, config?.revision]);

  const handleSaveSecret = async (): Promise<boolean> => {
    if (mutation.pending || mutation.uncertain || secretEditor.hasRemoteChanges) return false;
    if (secretRemoval.isPending()) {
      await secretRemoval.refresh();
      return false;
    }
    if (secretChange.isPending()) {
      await secretChange.refresh();
      return false;
    }
    if (savesInFlight.current.has(secretEditor.key)) return false;
    if (!selectedProviderId.trim() || !secretValue.trim()) {
      setNotice({ tone: "warning", message: "Enter a provider secret before saving." });
      return false;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before saving a secret." });
      return false;
    }
    const editorIdentity = currentEditor.current;
    const isCurrent = captureEditor();
    const viewCurrent = captureView();
    const revision = Number(secretEditor.baseRevision ?? config.revision);
    if (!secretChange.beginSave()) return false;
    if (!beginProviderMutation()) {
      secretChange.endSave();
      return false;
    }
    savesInFlight.current.add(secretEditor.key);
    let attempted = false;
    let acknowledged = false;
    try {
      const latest = await fetchSettings();
      if (!isCurrent()) return false;
      if (latest.revision !== revision) {
        setNotice({
          tone: "warning",
          message: "Provider settings changed. Refresh and review this credential before saving.",
        });
        await reload();
        return false;
      }
      attempted = true;
      const next = await dispatchProviderMutation(() => saveProviderSecret(selectedProviderId, secretValue.trim(), revision));
      const settled = secretChange.receive(next, retainCredentialSubmission(secretEditor.key, secretValue), revision);
      acknowledged = true;
      if (viewCurrent() && currentEditor.current === editorIdentity) {
        setSecretState({ loading: false, error: null, data: next });
        if (settled)
          setNotice({
            tone: "success",
            message: "Provider secret saved. " + formatSecretStorageNotice(next.source, next.hasSecret),
          });
      }
      await reload();
      return settled;
    } catch (saveError) {
      if (attempted && !acknowledged && isProviderPrecommitConflict(saveError, revision)) {
        await reload();
        if (viewCurrent())
          setNotice({
            tone: "warning",
            message: "Provider settings changed elsewhere. Your secret was not changed; review and save again.",
          });
        return false;
      }
      if (attempted && !acknowledged) retainProviderMutationUncertainty();
      if (viewCurrent())
        setNotice({
          tone: "error",
          message: acknowledged
            ? "The Gateway acknowledged the credential action, but refreshing evidence failed."
            : getErrorMessage(saveError),
        });
      return false;
    } finally {
      savesInFlight.current.delete(secretEditor.key);
      secretChange.endSave();
      finishProviderMutation();
    }
  };

  const handleDeleteSecret = async () => {
    if (mutation.pending || mutation.uncertain) return;
    if (secretChange.isPending()) {
      await secretChange.refresh();
      return;
    }
    if (secretRemoval.isPending()) {
      await secretRemoval.refresh();
      return;
    }
    if (!pendingDeleteSecret) {
      return;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before removing a secret." });
      return;
    }
    if (
      pendingDeleteSecret.providerId !== selectedProviderId ||
      pendingDeleteSecret.revision !== config.revision ||
      !secretRemoval.beginSave()
    )
      return;
    if (!beginProviderMutation()) {
      secretRemoval.endSave();
      return;
    }
    const revision = pendingDeleteSecret.revision;
    const isCurrent = captureEditor();
    const viewCurrent = captureView();
    const editorIdentity = currentEditor.current;
    setDeleteSecretBusy(true);
    let attempted = false;
    let acknowledged = false;
    try {
      const latest = await fetchSettings();
      if (!isCurrent()) return;
      if (latest.revision !== revision) {
        setNotice({
          tone: "warning",
          message: "Provider settings changed. Refresh and review credential removal again.",
        });
        await reload();
        return;
      }
      attempted = true;
      const next = await dispatchProviderMutation(() => deleteProviderSecret(pendingDeleteSecret.providerId, revision));
      const settled = secretRemoval.receive(next, { providerId: pendingDeleteSecret.providerId }, revision);
      acknowledged = true;
      if (viewCurrent() && currentEditor.current === editorIdentity) {
        setSecretState({ loading: false, error: null, data: next });
        if (settled)
          setNotice({
            tone: "success",
            message: "Provider secret removed. " + formatSecretStorageNotice(next.source, next.hasSecret),
          });
        setPendingDeleteSecret(null);
      }
      await reload();
    } catch (deleteError) {
      if (attempted && !acknowledged && isProviderPrecommitConflict(deleteError, revision)) {
        await reload();
        if (viewCurrent())
          setNotice({
            tone: "warning",
            message: "Provider settings changed elsewhere. No secret was removed; review and try again.",
          });
        return;
      }
      if (attempted && !acknowledged) retainProviderMutationUncertainty();
      if (viewCurrent())
        setNotice({
          tone: "error",
          message: acknowledged
            ? "The Gateway acknowledged the removal action, but refreshing evidence failed."
            : getErrorMessage(deleteError),
        });
    } finally {
      secretRemoval.endSave();
      finishProviderMutation();
      setDeleteSecretBusy(false);
    }
  };

  return {
    secretEditor,
    mutation,
    secretValue,
    setSecretValue,
    secretState,
    secretChange,
    secretRemoval,
    pendingDeleteSecret,
    setPendingDeleteSecret,
    deleteSecretBusy,
    handleSaveSecret,
    handleDeleteSecret,
  };
}

function formatSecretStorageNotice(source: string | undefined, hasSecret: boolean): string {
  if (!hasSecret) {
    return "No key remains on file.";
  }
  if (source === "keychain") {
    return "Stored in OS keychain.";
  }
  if (source === "env") {
    return "Stored in local .env fallback.";
  }
  if (source === "inline") {
    return "Stored in inline config.";
  }
  return "Stored by gateway secret backend.";
}
