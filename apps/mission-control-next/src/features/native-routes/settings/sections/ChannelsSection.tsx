// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  createChannelSetupDraft,
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
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { ChannelSetupWizard, type ChannelSetupWizardFeedback } from "../channel-setup/ChannelSetupWizard";
import { DiscordConnectionOperationsPanel } from "../channel-setup/DiscordConnectionOperationsPanel";
import {
  delay,
  formatDateTime,
  preferredChannelDefinition,
  readConnectionConfigString,
  readDraftString,
} from "../../SettingsNativePage";
import { useDraftTransitionGuard, useFormDirty } from "../../library/use-form-dirty";

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
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [createCatalogId, setCreateCatalogId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftOwnerId, setDraftOwnerId] = useState("");
  const [validationResult, setValidationResult] = useState<ChannelSetupWizardFeedback | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "validate" | "test" | "finalize" | null>(null);
  const selectedDraft = data?.drafts?.find((item) => item.draftId === selectedDraftId) ?? data?.drafts?.[0] ?? null;
  const createDefinition = data?.definitions?.find((item) => item.catalog.catalogId === createCatalogId) ?? null;
  const selectedDefinition = selectedDraft
    ? (data?.definitions?.find((item) => item.catalog.catalogId === selectedDraft.catalogId) ?? null)
    : createDefinition;

  const hasDraftChanges = Boolean(selectedDraft && draftOwnerId === selectedDraft.draftId && draftDirty);
  const draftHasChanges = useCallback(
    (valuesOverride?: Record<string, unknown>): boolean => {
      if (!selectedDraft || draftOwnerId !== selectedDraft.draftId) {
        return false;
      }
      const nextValues = valuesOverride ?? draftValues;
      return (
        draftDirty ||
        draftLabel.trim() !== (selectedDraft.label ?? "").trim() ||
        draftEnabled !== selectedDraft.enabled ||
        JSON.stringify(nextValues) !== JSON.stringify(selectedDraft.draft)
      );
    },
    [draftDirty, draftEnabled, draftLabel, draftOwnerId, draftValues, selectedDraft],
  );
  useFormDirty("settings:channels", hasDraftChanges, { label: "Channels" });

  const resetSelectedDraft = useCallback(() => {
    if (!selectedDraft) {
      return;
    }
    setDraftLabel(selectedDraft.label ?? "");
    setDraftEnabled(selectedDraft.enabled);
    setDraftValues(selectedDraft.draft);
    setDraftDirty(false);
    setValidationResult(null);
  }, [selectedDraft]);
  const applyDraftSelection = useCallback((draftId: string) => {
    setSelectedDraftId(draftId);
    setValidationResult(null);
  }, []);
  const draftSelectionGuard = useDraftTransitionGuard(hasDraftChanges, applyDraftSelection, resetSelectedDraft);

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
    if (!data?.drafts?.length) {
      setSelectedDraftId("");
      return;
    }
    setSelectedDraftId((current) =>
      current && data.drafts.some((item) => item.draftId === current) ? current : data.drafts[0]?.draftId || "",
    );
  }, [data?.drafts]);

  useEffect(() => {
    if (!selectedDraft) {
      setDraftLabel("");
      setDraftEnabled(true);
      setDraftValues({});
      setDraftDirty(false);
      setDraftOwnerId("");
      return;
    }
    if (draftOwnerId === selectedDraft.draftId && hasDraftChanges) {
      return;
    }
    setDraftLabel(selectedDraft.label ?? "");
    setDraftEnabled(selectedDraft.enabled);
    setDraftValues(selectedDraft.draft);
    setDraftDirty(false);
    setDraftOwnerId(selectedDraft.draftId);
  }, [draftOwnerId, hasDraftChanges, selectedDraft]);

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
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleStartSlackOAuth = async () => {
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
      void waitForSlackOAuthInstall(previousConnections);
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    }
  };

  const waitForSlackOAuthInstall = async (previousConnections: Map<string, string>) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(2000);
      try {
        const status = await fetchSlackOAuthStatus();
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
        setSelectedDraftId(created.draftId);
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
      setDraftDirty(true);
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
    const nextValues = valuesOverride ?? draftValues;
    if (!draftHasChanges(nextValues)) {
      return selectedDraft;
    }
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
        expectedRevision: selectedDraft.revision,
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
      setDraftLabel(savedDraft.label ?? draftLabel.trim());
      setDraftEnabled(savedDraft.enabled ?? draftEnabled);
      setDraftValues(savedDraft.draft ?? nextValues);
      setDraftDirty(false);
      return savedDraft;
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
      return undefined;
    }
  };

  const handleSave = async (valuesOverride?: Record<string, unknown>): Promise<boolean> => {
    setBusyAction("save");
    try {
      const savedDraft = await persistDraft(valuesOverride);
      if (savedDraft) {
        setNotice({ tone: "success", message: "Channel draft saved." });
        await reload();
      }
      return Boolean(savedDraft);
    } finally {
      setBusyAction(null);
    }
  };

  const handleValidate = async (valuesOverride?: Record<string, unknown>) => {
    if (!selectedDraft) {
      return;
    }
    setBusyAction("validate");
    try {
      const currentDraft = await persistDraft(valuesOverride);
      if (!currentDraft) {
        return;
      }
      const result = await validateChannelSetupDraft(currentDraft.draftId, currentDraft.revision);
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
      setBusyAction(null);
    }
  };

  const handleTest = async (valuesOverride?: Record<string, unknown>) => {
    if (!selectedDraft) {
      return;
    }
    setBusyAction("test");
    try {
      const currentDraft = await persistDraft(valuesOverride);
      if (!currentDraft) {
        return;
      }
      const validation = await validateChannelSetupDraft(currentDraft.draftId, currentDraft.revision);
      if (validation.status === "error") {
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
    if (validationResult?.kind !== "test" || validationResult.status !== "ok") {
      setNotice({ tone: "warning", message: "A passing live test is required before finalizing this connection." });
      return;
    }
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
      setBusyAction(null);
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="detail-wide">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Channel definitions"
              subtitle="Available guided setup definitions for supported channel integrations."
              stats={[
                { label: "Definitions", value: String(data.definitions?.length ?? 0) },
                { label: "Existing channels", value: String(data.connections?.length ?? 0) },
              ]}
            >
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
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Drafts"
              subtitle="Saved setup drafts, readiness checks, trial sends, and finalization."
            >
              <NativeSelectableList
                items={(data.drafts ?? []).map((item) => ({
                  id: item.draftId,
                  title: item.label || item.catalogId,
                  meta: item.lifecycleMode,
                  body: `${item.enabled ? "enabled" : "disabled"} · ${formatDateTime(item.updatedAt)}`,
                }))}
                selectedId={selectedDraftId}
                onSelect={(draftId) => {
                  if (draftId !== selectedDraftId) {
                    draftSelectionGuard.requestTransition(draftId);
                  }
                }}
                emptyLabel="No channel drafts yet."
              />
            </NativeCard>
            <DiscordConnectionOperationsPanel connections={data.connections ?? []} />
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedDraft?.label || selectedDefinition?.catalog?.label || "Channel draft"}
            subtitle="Follow the guided setup, prove the connection, then finalize it into the live runtime."
          >
            {selectedDraft && selectedDefinition ? (
              <ChannelSetupWizard
                definition={selectedDefinition}
                draft={selectedDraft}
                values={draftValues}
                label={draftLabel}
                enabled={draftEnabled}
                dirty={draftDirty}
                feedback={validationResult}
                busyAction={busyAction}
                onValuesChange={(next) => {
                  setDraftValues(next);
                  setDraftDirty(true);
                  setValidationResult(null);
                }}
                onLabelChange={(next) => {
                  setDraftLabel(next);
                  setDraftDirty(true);
                  setValidationResult(null);
                }}
                onEnabledChange={(next) => {
                  setDraftEnabled(next);
                  setDraftDirty(true);
                  setValidationResult(null);
                }}
                onDirty={() => {
                  setDraftDirty(true);
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
          </NativeCard>
        </SettingsGrid>
      ) : null}
      <ConfirmModal
        open={draftSelectionGuard.pendingTransition !== null}
        danger
        title="Discard channel draft changes?"
        message="The selected channel setup has unsaved edits. Discard them and open another draft?"
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onCancel={draftSelectionGuard.cancelDiscard}
        onConfirm={draftSelectionGuard.confirmDiscard}
      />
    </SettingsSectionShell>
  );
}
