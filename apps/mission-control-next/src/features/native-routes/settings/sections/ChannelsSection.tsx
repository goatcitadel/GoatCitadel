// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Play, Plus, RefreshCw, Save, ShieldCheck } from "lucide-react";
import {
  createChannelSetupDraft,
  discoverTelegramTargets,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  fetchIntegrationConnections,
  fetchSlackOAuthStatus,
  finalizeChannelSetupDraft,
  startSlackOAuth,
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
  SettingsCodeBlock,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import {
  collectDefinitionFieldHints,
  delay,
  formatDateTime,
  formatJson,
  parseJsonObject,
  preferredChannelDefinition,
  readConnectionConfigString,
  readDraftString,
} from "../../SettingsNativePage";

export function ChannelsSection(_props: SettingsSectionProps) {
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
  const [draftJson, setDraftJson] = useState("{}");
  const [validationResult, setValidationResult] = useState<{ kind: "validate" | "test"; items: string[] } | null>(null);
  const selectedDraft = data?.drafts?.find((item) => item.draftId === selectedDraftId) ?? data?.drafts?.[0] ?? null;
  const selectedDefinition =
    data?.definitions?.find((item) => item.catalog.catalogId === (selectedDraft?.catalogId || createCatalogId)) ?? null;

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
      setDraftJson("{}");
      return;
    }
    setDraftLabel(selectedDraft.label ?? "");
    setDraftEnabled(selectedDraft.enabled);
    setDraftJson(formatJson(selectedDraft.draft));
  }, [selectedDraft]);

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
      const draftObject = parseJsonObject(draftJson, selectedDraft.draft);
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
      setDraftJson(
        formatJson({
          ...draftObject,
          targets,
          defaultChatId: targets[0]?.chatId ?? readDraftString(draftObject, "defaultChatId"),
        }),
      );
      setNotice({
        tone: "success",
        message: `Detected ${targets.length} Telegram target${targets.length === 1 ? "" : "s"}.`,
      });
    } catch (discoverError) {
      setNotice({ tone: "error", message: getErrorMessage(discoverError) });
    }
  };

  const handleSave = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      await updateChannelSetupDraft(selectedDraft.draftId, {
        label: draftLabel.trim() || undefined,
        enabled: draftEnabled,
        draft: parseJsonObject(draftJson, selectedDraft.draft),
      });
      setNotice({ tone: "success", message: "Channel draft saved." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleValidate = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const result = await validateChannelSetupDraft(selectedDraft.draftId);
      setValidationResult({
        kind: "validate",
        items: result.issues.map((item) => `${item.level.toUpperCase()}: ${item.message}`),
      });
      setNotice({
        tone: result.status === "error" ? "error" : result.status === "warn" ? "warning" : "success",
        message: "Channel draft validated.",
      });
      await reload();
    } catch (validateError) {
      setNotice({ tone: "error", message: getErrorMessage(validateError) });
    }
  };

  const handleTest = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const result = await testChannelSetupDraft(selectedDraft.draftId);
      setValidationResult({
        kind: "test",
        items: result.issues.map((item) => `${item.level.toUpperCase()}: ${item.message}`),
      });
      setNotice({
        tone: result.status === "error" ? "error" : result.status === "warn" ? "warning" : "success",
        message: result.recommendedNextAction || "Channel draft tested.",
      });
      await reload();
    } catch (testError) {
      setNotice({ tone: "error", message: getErrorMessage(testError) });
    }
  };

  const handleFinalize = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const result = await finalizeChannelSetupDraft(selectedDraft.draftId);
      setNotice({ tone: "success", message: `Channel connection ${result.connection.label} finalized.` });
      await reload();
    } catch (finalizeError) {
      setNotice({ tone: "error", message: getErrorMessage(finalizeError) });
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
                    "Every listed channel starts as a setup draft. Slack uses OAuth, Telegram can discover targets, and all drafts must save, validate, test, and finalize before runtime use.",
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
                  Create setup draft
                </NativeButton>
              </SettingsButtonRow>
              <SettingsActionList
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
                  setSelectedDraftId(draftId);
                  setValidationResult(null);
                }}
                emptyLabel="No channel drafts yet."
              />
            </NativeCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedDraft?.label || selectedDefinition?.catalog?.label || "Channel draft"}
            subtitle="Edit the draft payload, then check readiness, send a trial message, and finalize it."
          >
            {selectedDraft ? (
              <>
                <SettingsFieldGrid>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={draftLabel}
                      onChange={(event) => setDraftLabel(event.target.value)}
                    />
                  </SettingsField>
                  <SettingsField label="Enabled" group>
                    <label className="mc-next-settings-toggle">
                      <input
                        type="checkbox"
                        checked={draftEnabled}
                        onChange={(event) => setDraftEnabled(event.target.checked)}
                      />
                      <span>Enable the connection after finalize</span>
                    </label>
                  </SettingsField>
                  <SettingsField label="Draft JSON" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={draftJson}
                      onChange={(event) => setDraftJson(event.target.value)}
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                {selectedDefinition ? (
                  <NativeMetricGrid
                    items={[
                      {
                        label: "Difficulty",
                        value: selectedDefinition.wizard.difficulty,
                        meta: selectedDefinition.catalog.key,
                      },
                      {
                        label: "Validation levels",
                        value: String(selectedDefinition.validation.levels.length),
                        meta: selectedDefinition.testing.levels.join(", "),
                      },
                    ]}
                  />
                ) : null}
                <SettingsButtonRow>
                  {selectedDraft.catalogId === "channel.slack" ? (
                    <NativeButton variant="default" onClick={() => void handleStartSlackOAuth()}>
                      <ExternalLink size={16} />
                      Connect Slack
                    </NativeButton>
                  ) : null}
                  {selectedDraft.catalogId === "channel.telegram" ? (
                    <NativeButton variant="secondary" onClick={() => void handleDiscoverTelegramTargets()}>
                      <RefreshCw size={16} />
                      Detect Telegram Chats
                    </NativeButton>
                  ) : null}
                  <NativeButton variant="default" onClick={() => void handleSave()}>
                    <Save size={16} />
                    Save draft
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void handleValidate()}>
                    <ShieldCheck size={16} />
                    Validate
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void handleTest()}>
                    <Play size={16} />
                    Test
                  </NativeButton>
                  <NativeButton variant="default" onClick={() => void handleFinalize()}>
                    <CheckCircle2 size={16} />
                    Finalize
                  </NativeButton>
                </SettingsButtonRow>
                {selectedDefinition ? (
                  <SettingsActionList
                    items={collectDefinitionFieldHints(selectedDefinition).map((item) => ({
                      label: item.label,
                      description: item.explanation,
                      meta: item.type,
                    }))}
                    emptyLabel="No wizard field hints available."
                  />
                ) : null}
                {validationResult ? (
                  <SettingsCodeBlock
                    label={validationResult.kind === "validate" ? "Validation results" : "Test results"}
                  >
                    {validationResult.items.join("\n") || "No issues returned."}
                  </SettingsCodeBlock>
                ) : null}
              </>
            ) : (
              <SettingsEmptyState label="Create or select a channel setup draft to continue." />
            )}
          </NativeCard>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}
