import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  fetchIntegrationConnections,
} from "@goatcitadel/mission-control-shared/api/client";
import { nativeLoad, nativeLoadIssues, useAsyncLoad, type Notice } from "../SettingsShared";
import type { ChannelSetupWizardFeedback } from "../channel-setup/ChannelSetupWizard";
import { formatJson } from "../helpers/input-format";
import { preferredChannelDefinition } from "../helpers/channel-helpers";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { useIntegrationConnectionReview } from "./useIntegrationConnectionReview";
import { useChannelMutationState } from "./channel-setup-state";

/** Installation-owned channel records; workspace scopes only the editor and plan origin. */
export function useChannelSetupState(activeWorkspaceId: string) {
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const mutation = useChannelMutationState();
  const load = useCallback(async () => {
    const [definitions, drafts, connections] = await Promise.all([
      nativeLoad("Channel definitions", fetchChannelSetupDefinitions(), { items: [] }),
      nativeLoad("Channel drafts", fetchChannelSetupDrafts({ limit: 100 }), { items: [] }),
      nativeLoad("Channel connections", fetchIntegrationConnections("channel"), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([definitions, drafts, connections]),
      definitions: definitions.data.items,
      drafts: drafts.data.items,
      connections: connections.data.items,
    };
  }, []);
  const { loading, error, data, reload, updateData } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [panel, setPanel] = useState<"create" | "editor" | "connection" | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useSessionViewState(
    "channels:" + activeWorkspaceId + ":connection",
    "",
  );
  const [selectedDraftId, setSelectedDraftId] = useSessionViewState("channels:" + activeWorkspaceId + ":draft", "");

  const leave = useDraftLeave();
  const [createCatalogId, setCreateCatalogId] = useState("");
  const [validationResult, setValidationResult] = useState<ChannelSetupWizardFeedback | null>(null);
  const [validationRevision, setValidationRevision] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "validate" | "test" | "finalize" | null>(null);
  const selectedDraft = data?.drafts?.find((item) => item.draftId === selectedDraftId) ?? null;
  const draftScope = useRef({ activeWorkspaceId, selectedDraftId, panel, selectedConnectionId, createCatalogId });
  if (
    draftScope.current.activeWorkspaceId !== activeWorkspaceId ||
    draftScope.current.selectedDraftId !== selectedDraftId ||
    draftScope.current.panel !== panel ||
    draftScope.current.selectedConnectionId !== selectedConnectionId ||
    draftScope.current.createCatalogId !== createCatalogId
  ) {
    draftScope.current = { activeWorkspaceId, selectedDraftId, panel, selectedConnectionId, createCatalogId };
  }
  const currentScope = draftScope.current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrentDraft = () => mounted.current && draftScope.current === currentScope;
  const applyConnection = useCallback(
    (connectionId: string, connection: NonNullable<typeof data>["connections"][number] | null) => {
      updateData((current) => ({
        ...current,
        connections: connection
          ? [...current.connections.filter((item) => item.connectionId !== connectionId), connection]
          : current.connections.filter((item) => item.connectionId !== connectionId),
      }));
    },
    [updateData],
  );
  const connectionReview = useIntegrationConnectionReview(
    JSON.stringify([activeWorkspaceId, selectedDraftId]),
    selectedDraft?.connectionId ?? "",
    applyConnection,
  );
  const draftConnection = data?.connections.find((item) => item.connectionId === selectedDraft?.connectionId) ?? null;
  const needsConnectionReview = Boolean(
    selectedDraft?.connectionId &&
    (connectionReview.required || selectedDraft.connectionRevision !== draftConnection?.revision),
  );
  const attemptedReview = useRef<{ scope: typeof currentScope; key: string } | null>(null);
  const { required: connectionReviewRequired, refresh: refreshConnectionReview } = connectionReview;
  useEffect(() => {
    if (panel !== "editor" || !needsConnectionReview || connectionReviewRequired) return;
    const key = JSON.stringify([
      activeWorkspaceId,
      selectedDraftId,
      selectedDraft?.connectionRevision,
      draftConnection?.revision,
    ]);
    if (attemptedReview.current?.scope === currentScope && attemptedReview.current.key === key) return;
    attemptedReview.current = { scope: currentScope, key };
    void refreshConnectionReview();
  }, [
    panel,
    needsConnectionReview,
    connectionReviewRequired,
    refreshConnectionReview,
    currentScope,
    activeWorkspaceId,
    selectedDraftId,
    selectedDraft?.connectionRevision,
    draftConnection?.revision,
  ]);
  const mergeDraft = (draft: ChannelSetupDraft) =>
    updateData((current) => ({
      ...current,
      drafts: [...current.drafts.filter((item) => item.draftId !== draft.draftId), draft],
    }));
  const createDefinition = data?.definitions?.find((item) => item.catalog.catalogId === createCatalogId) ?? null;
  const selectedDefinition = selectedDraft
    ? (data?.definitions?.find((item) => item.catalog.catalogId === selectedDraft.catalogId) ?? null)
    : createDefinition;

  const selectedConnection = data?.connections?.find((item) => item.connectionId === selectedConnectionId) ?? null;
  const inputEpoch = useRef(0);
  const sessionDraft = useSessionDraft(
    "channel:" + activeWorkspaceId + ":" + selectedDraftId + ":setup",
    {
      label: selectedDraft?.label ?? "",
      enabled: selectedDraft?.enabled ?? true,
      values: selectedDraft?.draft ?? ({} as Record<string, unknown>),
      advancedText: formatJson(selectedDraft?.draft ?? {}),
    },
    selectedDraft?.revision,
    {
      label: selectedDraft?.label ?? "Channel setup",
      active: panel === "editor",
      available: Boolean(selectedDraft),
      onSave: () => saveRef.current(),
    },
  );
  const channelDraft = {
    ...sessionDraft,
    setValue: (update: Parameters<typeof sessionDraft.setValue>[0]) => {
      inputEpoch.current += 1;
      sessionDraft.setValue(update);
    },
  };
  const { label: draftLabel, enabled: draftEnabled, values: draftValues } = channelDraft.value;
  const draftDirty = channelDraft.isDirty;
  const [advancedMode] = useSessionViewState(
    "channel:" + activeWorkspaceId + ":" + selectedDraftId + ":advanced-mode",
    false,
  );
  const setDraftLabel = (label: string) => channelDraft.setValue((current) => ({ ...current, label }));
  const setDraftEnabled = (enabled: boolean) => channelDraft.setValue((current) => ({ ...current, enabled }));
  const setDraftValues = (values: Record<string, unknown>) =>
    channelDraft.setValue((current) => ({ ...current, values, advancedText: formatJson(values) }));
  const draftHasChanges = (valuesOverride?: Record<string, unknown>): boolean =>
    Boolean(
      selectedDraft &&
      (channelDraft.isDirty || JSON.stringify(valuesOverride ?? draftValues) !== JSON.stringify(selectedDraft.draft)),
    );
  const draftSelectionGuard = {
    requestTransition: (id: string) =>
      leave.request(() => {
        setSelectedDraftId(id);
        setPanel("editor");
        setValidationResult(null);
      }),
  };
  const closePanel = () => leave.request(() => setPanel(null));
  useEffect(() => {
    setPanel(null);
    setValidationResult(null);
  }, [activeWorkspaceId]);
  useEffect(() => {
    setCreateCatalogId((current) =>
      data?.definitions.some((item) => item.catalog.catalogId === current)
        ? current
        : (preferredChannelDefinition(data?.definitions ?? [])?.catalog.catalogId ?? ""),
    );
  }, [data?.definitions]);
  useEffect(() => {
    setValidationResult(null);
  }, [selectedDraft?.draftId]);
  return {
    activeWorkspaceId,
    loading,
    error,
    data,
    reload,
    updateData,
    notice,
    setNotice,
    panel,
    setPanel,
    selectedConnectionId,
    setSelectedConnectionId,
    selectedDraftId,
    setSelectedDraftId,
    leave,
    createCatalogId,
    setCreateCatalogId,
    validationResult,
    setValidationResult,
    validationRevision,
    setValidationRevision,
    busyAction,
    setBusyAction,
    selectedDraft,
    isCurrentDraft,
    connectionReview,
    draftConnection,
    needsConnectionReview,
    mergeDraft,
    createDefinition,
    selectedDefinition,
    selectedConnection,
    channelDraft,
    draftLabel,
    draftEnabled,
    draftValues,
    draftDirty,
    advancedMode,
    setDraftLabel,
    setDraftEnabled,
    setDraftValues,
    draftHasChanges,
    draftSelectionGuard,
    closePanel,
    saveRef,
    mutation,
    inputEpoch,
  };
}
export type ChannelSetupState = ReturnType<typeof useChannelSetupState>;
