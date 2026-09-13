// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  createChannelSetupDraft,
  isApiRequestError,
  createChangePlan,
  discoverTelegramTargets,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  fetchIntegrationConnections,
  fetchSlackOAuthStatus,
  startSlackOAuth,
  submitChannelSetupDraftSecrets,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  validateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { ChannelSetupWizard, type ChannelSetupWizardFeedback } from "../channel-setup/ChannelSetupWizard";
import { DiscordConnectionOperationsPanel } from "../channel-setup/DiscordConnectionOperationsPanel";
import { ChannelJourneyPanel } from "../channel-setup/ChannelJourneyPanel";
import {
  delay,
  formatDateTime,
  formatJson,
  parseJsonObject,
  preferredChannelDefinition,
  readConnectionConfigString,
  readDraftString,
} from "../../SettingsNativePage";
import { hasSessionDraft, useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { DetailInspector } from "../../../../components/DetailInspector";

export function ChannelsSection({ activeWorkspaceId, navigate, route }: SettingsSectionProps) {
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
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [panel, setPanel] = useState<"create" | "editor" | "connection" | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [selectedConnectionId, setSelectedConnectionId] = useSessionViewState(
    "channels:" + activeWorkspaceId + ":connection",
    "",
  );
  const [selectedDraftId, setSelectedDraftId] = useSessionViewState("channels:" + activeWorkspaceId + ":draft", "");
  const selectionRef = useRef(selectedDraftId);
  selectionRef.current = selectedDraftId;
  const busyRef = useRef(false);
  const oauthGeneration = useRef(0);
  const oauthBusy = useRef(false);
  const leave = useDraftLeave();
  const [createCatalogId, setCreateCatalogId] = useState("");
  const [validationResult, setValidationResult] = useState<ChannelSetupWizardFeedback | null>(null);
  const [validationRevision, setValidationRevision] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "validate" | "test" | "finalize" | null>(null);
  const selectedDraft = data?.drafts?.find((item) => item.draftId === selectedDraftId) ?? null;
  const createDefinition = data?.definitions?.find((item) => item.catalog.catalogId === createCatalogId) ?? null;
  const selectedDefinition = selectedDraft
    ? (data?.definitions?.find((item) => item.catalog.catalogId === selectedDraft.catalogId) ?? null)
    : createDefinition;

  const selectedConnection = data?.connections?.find((item) => item.connectionId === selectedConnectionId) ?? null;
  const channelDraft = useSessionDraft(
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
      onSave: () => handleSave(),
    },
  );
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
    oauthGeneration.current += 1;
    oauthBusy.current = false;
    return () => {
      oauthGeneration.current += 1;
    };
  }, [activeWorkspaceId]);
  useEffect(() => {
    if (!data?.definitions?.length) {
      setCreateCatalogId("");
      return;
    }
    setCreateCatalogId((current) => {
      if (current && data.definitions.some((item) => item.catalog.catalogId === current)) {
        return current;
      }
      return preferredChannelDefinition(data.definitions)?.catalog?.catalogId || "";
    });
  }, [data?.definitions]);

  useEffect(() => {
    setValidationResult(null);
  }, [selectedDraft?.draftId]);

  const handleCreate = async () => {
    if (!createCatalogId) {
      setNotice({ tone: "warning", message: "Choose a channel definition first." });
      return;
    }
    try {
      const created = await createChannelSetupDraft({ catalogId: createCatalogId });
      setNotice({ tone: "success", message: "Channel setup draft created." });
      await reload();
      setSelectedDraftId(created.draftId);
      if (panelRef.current === "create") setPanel("editor");
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleStartSlackOAuth = async () => {
    if (oauthBusy.current) return;
    oauthBusy.current = true;
    const generation = ++oauthGeneration.current;
    try {
      const status = await fetchSlackOAuthStatus();
      if (!status.configured) {
        setNotice({
          tone: "warning",
          message: `Slack OAuth needs configuration first: ${status.missing.join(", ") || "missing OAuth settings"}.`,
        });
        return;
      }
      const previousConnections = new Map(
        status.connections.map((item) => [
          item.connection.connectionId,
          readConnectionConfigString(item.connection.config, "oauthConnectedAt") ?? "",
        ]),
      );
      const result = await startSlackOAuth();
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      setNotice({
        tone: "success",
        message: "Slack authorization opened. Approve the workspace, then target setup will open here.",
      });
      void waitForSlackOAuthInstall(previousConnections, generation);
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    } finally {
      oauthBusy.current = false;
    }
  };

  const waitForSlackOAuthInstall = async (previousConnections: Map<string, string>, generation: number) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(2000);
      if (generation !== oauthGeneration.current) return;
      try {
        const status = await fetchSlackOAuthStatus();
        if (generation !== oauthGeneration.current) return;
        const installed = status.connections.find((item) => {
          const previousConnectedAt = previousConnections.get(item.connection.connectionId);
          const nextConnectedAt = readConnectionConfigString(item.connection.config, "oauthConnectedAt") ?? "";
          return previousConnectedAt === undefined || previousConnectedAt !== nextConnectedAt;
        });
        if (!installed) {
          continue;
        }
        const created = await createChannelSetupDraft({
          catalogId: "channel.slack",
          connectionId: installed.connection.connectionId,
          lifecycleMode: "edit",
        });
        setCreateCatalogId("channel.slack");
        setNotice({
          tone: "success",
          message: "Slack workspace connected. Add channel targets, then validate and test.",
        });
        await reload();
        if (generation !== oauthGeneration.current) return;
        setSelectedDraftId(created.draftId);
        if (panelRef.current === "create") setPanel("editor");
        return;
      } catch {
        // Keep polling so callback timing or a short gateway blip does not interrupt setup.
      }
    }
    setNotice({
      tone: "warning",
      message: "Slack authorization may still be finishing. Refresh channel connections if the workspace was approved.",
    });
  };

  const handleDiscoverTelegramTargets = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const draftObject = draftValues;
      const result = await discoverTelegramTargets({
        botToken: readDraftString(draftObject, "botToken"),
        botTokenEnv: readDraftString(draftObject, "botTokenEnv") ?? readDraftString(draftObject, "tokenEnv"),
        setupCode: readDraftString(draftObject, "setupCode"),
      });
      if (selectedDraft.draftId !== selectionRef.current) return;
      if (result.items.length === 0) {
        setNotice({
          tone: "warning",
          message:
            "Telegram did not return recent chats yet. Send /start or the setup code in the target chat and try again.",
        });
        return;
      }
      const targets = result.items.map((item, index) => ({
        id: item.id,
        label: item.label,
        chatId: item.chatId,
        kind: item.kind,
        default: index === 0,
      }));
      setDraftValues({
        ...draftObject,
        targets,
        defaultChatId: targets[0]?.chatId ?? readDraftString(draftObject, "defaultChatId"),
      });
      setValidationResult(null);
      setNotice({
        tone: "success",
        message: `Detected ${targets.length} Telegram target${targets.length === 1 ? "" : "s"}.`,
      });
    } catch (discoverError) {
      setNotice({ tone: "error", message: getErrorMessage(discoverError) });
    }
  };

  const persistDraft = async (valuesOverride?: Record<string, unknown>): Promise<ChannelSetupDraft | undefined> => {
    if (!selectedDraft) {
      return undefined;
    }
    let nextValues: Record<string, unknown>;
    try {
      nextValues = valuesOverride ?? (advancedMode ? parseJsonObject(channelDraft.value.advancedText) : draftValues);
    } catch (cause) {
      setNotice({ tone: "error", message: getErrorMessage(cause) });
      return undefined;
    }
    if (channelDraft.hasRemoteChanges) {
      setNotice({
        tone: "warning",
        message: "This channel draft changed elsewhere. Review its current revision before applying your changes.",
      });
      return undefined;
    }
    const submitted = {
      label: draftLabel,
      enabled: draftEnabled,
      values: nextValues,
      advancedText: formatJson(nextValues),
    };
    if (!draftHasChanges(nextValues)) {
      return selectedDraft;
    }
    channelDraft.setValue(submitted);
    try {
      const secretFieldKeys = new Set(selectedDefinition?.adapter?.secretFieldKeys ?? []);
      const publicValues = Object.fromEntries(
        Object.entries(nextValues).filter(([fieldKey]) => !secretFieldKeys.has(fieldKey)),
      );
      const secureValues = Object.fromEntries(
        Object.entries(nextValues).flatMap(([fieldKey, value]) =>
          secretFieldKeys.has(fieldKey) &&
          typeof value === "string" &&
          value.trim().length > 0 &&
          value !== "[REDACTED]"
            ? [[fieldKey, value]]
            : [],
        ),
      );
      let savedDraft = await updateChannelSetupDraft(selectedDraft.draftId, {
        expectedRevision: channelDraft.baseRevision as number,
        label: draftLabel.trim() || undefined,
        enabled: draftEnabled,
        draft: publicValues,
      });
      if (Object.keys(secureValues).length > 0) {
        savedDraft = await submitChannelSetupDraftSecrets(savedDraft.draftId, {
          expectedRevision: savedDraft.revision,
          values: secureValues,
        });
      }
      const clean = channelDraft.acceptSaved(
        {
          label: savedDraft.label ?? draftLabel.trim(),
          enabled: savedDraft.enabled ?? draftEnabled,
          values: savedDraft.draft ?? nextValues,
          advancedText: formatJson(savedDraft.draft ?? nextValues),
        },
        savedDraft.revision,
        submitted,
      );
      if (!clean) {
        setNotice({
          tone: "warning",
          message: "The submitted channel draft was saved. Newer edits remain; save them before continuing.",
        });
        await reload();
        return undefined;
      }
      return savedDraft;
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) await reload();
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
      return undefined;
    }
  };

  const handleSave = async (valuesOverride?: Record<string, unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusyAction("save");
    try {
      const savedDraft = await persistDraft(valuesOverride);
      if (savedDraft) {
        setNotice({ tone: "success", message: "Channel draft saved." });
        await reload();
      }
      return Boolean(savedDraft);
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  };

  const handleValidate = async (valuesOverride?: Record<string, unknown>) => {
    if (!selectedDraft) {
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction("validate");
    try {
      const currentDraft = await persistDraft(valuesOverride);
      if (!currentDraft) {
        return;
      }
      const result = await validateChannelSetupDraft(currentDraft.draftId, currentDraft.revision);
      if (currentDraft.draftId !== selectionRef.current) return;
      setValidationRevision(result.draftRevision);
      setValidationResult({
        kind: "validate",
        status: result.status,
        issues: result.issues,
      });
      setNotice({
        tone: result.status === "error" ? "error" : result.status === "warn" ? "warning" : "success",
        message: "Channel draft validated.",
      });
      await reload();
    } catch (validateError) {
      setNotice({ tone: "error", message: getErrorMessage(validateError) });
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  };

  const handleTest = async (valuesOverride?: Record<string, unknown>) => {
    if (!selectedDraft) {
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction("test");
    try {
      const currentDraft = await persistDraft(valuesOverride);
      if (!currentDraft) {
        return;
      }
      const validation = await validateChannelSetupDraft(currentDraft.draftId, currentDraft.revision);
      if (currentDraft.draftId !== selectionRef.current) return;
      if (validation.status === "error") {
        setValidationRevision(validation.draftRevision);
        setValidationResult({
          kind: "validate",
          status: validation.status,
          issues: validation.issues,
        });
        setNotice({ tone: "error", message: "Resolve the validation errors before running a live test." });
        await reload();
        return;
      }
      const result = await testChannelSetupDraft(currentDraft.draftId, validation.draftRevision);
      if (currentDraft.draftId !== selectionRef.current) return;
      setValidationRevision(result.draftRevision);
      setValidationResult({
        kind: "test",
        status: result.status,
        issues: result.issues,
        recommendedNextAction: result.recommendedNextAction,
        probe: result.probe,
      });
      setNotice({
        tone: result.status === "error" ? "error" : result.status === "warn" ? "warning" : "success",
        message: result.recommendedNextAction || "Channel draft tested.",
      });
      await reload();
    } catch (testError) {
      setNotice({ tone: "error", message: getErrorMessage(testError) });
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  };

  const handleFinalize = async (valuesOverride?: Record<string, unknown>) => {
    if (!selectedDraft) {
      return;
    }
    if (draftHasChanges(valuesOverride)) {
      setNotice({ tone: "warning", message: "Save these changes and run the live test again before finalizing." });
      return;
    }
    if (
      validationResult?.kind !== "test" ||
      validationResult.status !== "ok" ||
      validationRevision !== selectedDraft.revision
    ) {
      setNotice({ tone: "warning", message: "A passing live test is required before finalizing this connection." });
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction("finalize");
    try {
      const plan = await createChangePlan({
        workspaceId: activeWorkspaceId,
        surface: "settings",
        request: {
          kind: "channel_connection",
          channelKind: selectedDraft.catalogId,
          draftId: selectedDraft.draftId,
        },
        idempotencyKey: `settings-channel-finalize:${selectedDraft.draftId}:${selectedDraft.revision}`,
      });
      setNotice({
        tone: "success",
        message: `Change Plan ${plan.planId} is ready for exact confirmation in Chat. The draft has not been finalized yet.`,
      });
      navigate({ area: "chat", theme: route.theme });
    } catch (finalizeError) {
      setNotice({ tone: "error", message: getErrorMessage(finalizeError) });
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  };

  const editConnection = async () => {
    if (!selectedConnection || busyRef.current) return;
    const existing = data?.drafts?.find((item) => item.connectionId === selectedConnection.connectionId);
    if (existing) {
      setSelectedDraftId(existing.draftId);
      setPanel("editor");
      return;
    }
    busyRef.current = true;
    try {
      const created = await createChannelSetupDraft({
        catalogId: selectedConnection.catalogId,
        connectionId: selectedConnection.connectionId,
        lifecycleMode: "edit",
      });
      await reload();
      if (panelRef.current === "connection") {
        setSelectedDraftId(created.draftId);
        setPanel("editor");
      }
    } catch (cause) {
      setNotice({ tone: "error", message: getErrorMessage(cause) });
    } finally {
      busyRef.current = false;
    }
  };

  return (
    // Block-render the loader only while there is nothing to show yet. Reloads
    // after save/validate/test keep `data` (useAsyncLoad retains it), and the
    // children must stay mounted through them or the wizard loses its in-flight
    // step state and resets the operator to step 1.
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {panel === "create" ? (
            <FocusedDetail title="Connect channel" onClose={closePanel}>
              <SettingsStack>
                <SettingsField label="Create draft from">
                  <select
                    className="mc-next-settings-input"
                    value={createCatalogId}
                    onChange={(event) => setCreateCatalogId(event.target.value)}
                    disabled={(data.definitions?.length ?? 0) === 0}
                  >
                    <option value="" disabled>
                      {(data.definitions?.length ?? 0) > 0
                        ? "Choose a channel definition"
                        : "No channel definitions available"}
                    </option>
                    {(data.definitions ?? []).map((item) => (
                      <option key={item.catalog.catalogId} value={item.catalog.catalogId}>
                        {item.catalog.label}
                      </option>
                    ))}
                  </select>
                </SettingsField>
                <SettingsNotice
                  notice={{
                    tone: "info",
                    message:
                      "Choose a channel, start its guided setup, then save, validate, test, and finalize before runtime use. Slack uses OAuth and Telegram can discover targets.",
                  }}
                />
                <SettingsButtonRow>
                  {createCatalogId === "channel.slack" ? (
                    <NativeButton variant="default" onClick={() => void handleStartSlackOAuth()}>
                      <ExternalLink size={16} />
                      Connect Slack
                    </NativeButton>
                  ) : null}
                  <NativeButton variant="default" disabled={!createCatalogId} onClick={() => void handleCreate()}>
                    <Plus size={16} />
                    {createDefinition ? `Start ${createDefinition.catalog.label} setup` : "Start guided setup"}
                  </NativeButton>
                </SettingsButtonRow>
                <SettingsActionList
                  ariaLabel="Channel setup definitions"
                  items={(data.definitions ?? []).map((item) => ({
                    label: item.catalog.label,
                    description: item.catalog.description,
                    meta: `${item.wizard.difficulty} · ${item.wizard.estimatedMinutes} min`,
                    onClick: () => setCreateCatalogId(item.catalog.catalogId),
                    actionLabel: createCatalogId === item.catalog.catalogId ? "Selected" : "Use",
                  }))}
                  emptyLabel="No channel setup definitions returned."
                  maxHeight="min(34vh, 18rem)"
                />
              </SettingsStack>
            </FocusedDetail>
          ) : panel === "editor" ? (
            <FocusedDetail
              title={selectedDraft?.label || selectedDefinition?.catalog?.label || "Channel setup"}
              onClose={closePanel}
            >
              <SettingsStack>
                {validationResult && validationRevision !== selectedDraft?.revision ? (
                  <p role="status">
                    The previous check belongs to a different draft revision. Run the live test again.
                  </p>
                ) : null}
                {channelDraft.hasRemoteChanges ? (
                  <NativeCard
                    title="Channel draft changed"
                    subtitle="Your input is retained. Review the saved revision before retrying."
                  >
                    <p>
                      {selectedDraft?.label} · revision {selectedDraft?.revision} ·{" "}
                      {formatDateTime(selectedDraft?.updatedAt)}
                    </p>
                    <NativeButton onClick={channelDraft.rebaseToCurrent}>Apply draft to current channel</NativeButton>
                  </NativeCard>
                ) : null}

                {selectedDraft && selectedDefinition ? (
                  <ChannelSetupWizard
                    scopeId={activeWorkspaceId}
                    advancedValue={channelDraft.value.advancedText}
                    onAdvancedValueChange={(advancedText) =>
                      channelDraft.setValue((current) => ({ ...current, advancedText }))
                    }
                    definition={selectedDefinition}
                    draft={selectedDraft}
                    values={draftValues}
                    label={draftLabel}
                    enabled={draftEnabled}
                    dirty={draftDirty}
                    feedback={validationRevision === selectedDraft.revision ? validationResult : null}
                    busyAction={busyAction}
                    onValuesChange={(next) => {
                      setDraftValues(next);
                      setValidationResult(null);
                    }}
                    onLabelChange={(next) => {
                      setDraftLabel(next);
                      setValidationResult(null);
                    }}
                    onEnabledChange={(next) => {
                      setDraftEnabled(next);
                      setValidationResult(null);
                    }}
                    onDirty={() => {
                      setValidationResult(null);
                    }}
                    onSave={handleSave}
                    onValidate={handleValidate}
                    onTest={handleTest}
                    onFinalize={handleFinalize}
                    supplementaryActions={
                      <>
                        {selectedDraft.catalogId === "channel.slack" ? (
                          <NativeButton variant="secondary" onClick={() => void handleStartSlackOAuth()}>
                            <ExternalLink size={16} />
                            Connect Slack
                          </NativeButton>
                        ) : null}
                        {selectedDraft.catalogId === "channel.telegram" ? (
                          <NativeButton variant="secondary" onClick={() => void handleDiscoverTelegramTargets()}>
                            <RefreshCw size={16} />
                            Detect Telegram chats
                          </NativeButton>
                        ) : null}
                      </>
                    }
                  />
                ) : selectedDraft ? (
                  <SettingsEmptyState label="The setup definition for this draft is unavailable. Refresh or repair the Gateway catalog." />
                ) : (
                  <SettingsEmptyState label="Create or select a channel setup draft to continue." />
                )}
              </SettingsStack>
            </FocusedDetail>
          ) : (
            <>
              <SettingsButtonRow>
                <NativeButton onClick={() => leave.request(() => setPanel("create"))}>
                  <Plus size={16} />
                  Connect channel
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void reload()}>
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
              <NativeCard title="Channel connections" subtitle="Saved connections and their observed status." stats={[{label:"Definitions",value:data.issues.some(issue=>issue.label === "Channel definitions") ? "Unavailable" : (Array.isArray(data.definitions) ? String(data.definitions.length) : "Unavailable")},{label:"Existing channels",value:data.issues.some(issue=>issue.label === "Channel connections") ? "Unavailable" : (Array.isArray(data.connections) ? String(data.connections.length) : "Unavailable")}]}>
                <NativeSelectableList
                  items={(data.connections ?? []).map((item) => ({
                    id: item.connectionId,
                    title: item.label,
                    meta: item.status,
                    body: item.key + " · " + (item.enabled ? "enabled" : "disabled"),
                  }))}
                  selectedId={panel === "connection" ? selectedConnectionId : undefined}
                  onSelect={(id) => {
                    setSelectedConnectionId(id);
                    setPanel("connection");
                  }}
                  emptyLabel="No connected channels yet."
                  maxHeight="min(45vh, 28rem)"
                />
              </NativeCard>
              <NativeCard title="Drafts" subtitle="Saved setup work, including retained edits.">
                <NativeSelectableList
                  items={(data.drafts ?? []).map((item) => ({
                    id: item.draftId,
                    title: item.label || item.catalogId,
                    meta:
                      item.lifecycleMode +
                      (hasSessionDraft("channel:" + activeWorkspaceId + ":" + item.draftId + ":setup") ||
                      hasSessionDraft("channel:" + activeWorkspaceId + ":" + item.draftId + ":advanced")
                        ? " · Unsaved"
                        : ""),
                    body: `${item.enabled ? "enabled" : "disabled"} · ${formatDateTime(item.updatedAt)}`,
                  }))}
                  selectedId={selectedDraftId}
                  onSelect={(draftId) => {
                    draftSelectionGuard.requestTransition(draftId);
                  }}
                  emptyLabel="No channel drafts yet."
                />
              </NativeCard>
            </>
          )}
          <DetailInspector
            open={panel === "connection"}
            title={selectedConnection?.label ?? "Channel unavailable"}
            onClose={closePanel}
          >
            {selectedConnection ? (
              <SettingsStack>
                <p>
                  {selectedConnection.key} · {selectedConnection.status} ·{" "}
                  {selectedConnection.enabled ? "Enabled" : "Disabled"}
                </p>
                <p>{selectedConnection.lastError}</p>
                <NativeButton onClick={() => void editConnection()}>Edit setup</NativeButton>
                <ChannelJourneyPanel connections={[selectedConnection]} />
                <NativeDisclosureCard id="channel-operations" title="Connection operations">
                  <DiscordConnectionOperationsPanel connections={[selectedConnection]} />
                  <dl>
                    <dt>Connection ID</dt>
                    <dd>{selectedConnection.connectionId}</dd>
                    <dt>Last sync</dt>
                    <dd>{formatDateTime(selectedConnection.lastSyncAt)}</dd>
                    <dt>Updated</dt>
                    <dd>{formatDateTime(selectedConnection.updatedAt)}</dd>
                  </dl>
                </NativeDisclosureCard>
              </SettingsStack>
            ) : (
              <SettingsEmptyState label="This connection is unavailable. Refresh or choose another channel." />
            )}
          </DetailInspector>
        </SettingsStack>
      ) : null}
      {leave.dialog}
    </SettingsSectionShell>
  );
}
