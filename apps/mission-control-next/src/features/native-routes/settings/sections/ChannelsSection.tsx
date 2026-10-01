import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { ChannelSetupWizard } from "../channel-setup/ChannelSetupWizard";
import { DiscordConnectionOperationsPanel } from "../channel-setup/DiscordConnectionOperationsPanel";
import { ChannelJourneyPanel } from "../channel-setup/ChannelJourneyPanel";
import { formatDateTime } from "../helpers/input-format";
import { hasSessionDraft } from "../../library/session-drafts";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { DetailInspector } from "../../../../components/DetailInspector";
import { IntegrationConnectionReview } from "./IntegrationConnectionReview";
import { useChannelSettings } from "./use-channel-settings";

export function ChannelsSection({ activeWorkspaceId, navigate, route }: SettingsSectionProps) {
  const owner = useChannelSettings(activeWorkspaceId, () => navigate({ area: "chat", theme: route.theme }));
  const {
    loading,
    error,
    data,
    reload,
    notice,
    panel,
    setPanel,
    createCatalogId,
    setCreateCatalogId,
    createDefinition,
    selectedDraft,
    selectedDefinition,
    closePanel,
    needsConnectionReview,
    draftConnection,
    connectionReview,
    busyAction,
    handleAcceptConnectionReview,
    validationResult,
    validationRevision,
    channelDraft,
    draftValues,
    draftLabel,
    draftEnabled,
    draftDirty,
    setDraftValues,
    setDraftLabel,
    setDraftEnabled,
    setValidationResult,
    handleSave,
    handleValidate,
    handleTest,
    handleFinalize,
    handleStartSlackOAuth,
    handleDiscoverTelegramTargets,
    handleCreate,
    leave,
    selectedConnectionId,
    setSelectedConnectionId,
    selectedDraftId,
    draftSelectionGuard,
    selectedConnection,
    editConnection,
  } = owner;
  return (
    // Block-render the loader only while there is nothing to show yet. Reloads
    // after save/validate/test keep `data` (useAsyncLoad retains it), and the
    // children must stay mounted through them or the wizard loses its in-flight
    // step state and resets the operator to step 1.
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {owner.mutation.uncertain ? <p role="alert">{owner.mutation.uncertain}</p> : null}
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
                  <NativeButton
                    variant="default"
                    disabled={!createCatalogId || owner.mutation.pending || Boolean(owner.mutation.uncertain)}
                    onClick={() => void handleCreate()}
                  >
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
                {needsConnectionReview ? (
                  <>
                    <IntegrationConnectionReview
                      connection={draftConnection}
                      loading={connectionReview.loading || busyAction !== null}
                      error={connectionReview.error}
                      missing={connectionReview.missing}
                      onAccept={() => void handleAcceptConnectionReview()}
                      onReload={() => void connectionReview.refresh()}
                    />
                    <p>
                      Reviewing keeps your setup fields and refreshes inherited credentials. Credentials you explicitly
                      replaced stay in the draft. A new live test is required.
                    </p>
                  </>
                ) : null}
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
                    busyAction={owner.mutation.pending || owner.mutation.uncertain ? (busyAction ?? "save") : null}
                    reviewRequired={needsConnectionReview}
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
              <NativeCard
                title="Channel connections"
                subtitle="Saved connections and their observed status."
                stats={[
                  {
                    label: "Definitions",
                    value: data.issues.some((issue) => issue.label === "Channel definitions")
                      ? "Unavailable"
                      : Array.isArray(data.definitions)
                        ? String(data.definitions.length)
                        : "Unavailable",
                  },
                  {
                    label: "Existing channels",
                    value: data.issues.some((issue) => issue.label === "Channel connections")
                      ? "Unavailable"
                      : Array.isArray(data.connections)
                        ? String(data.connections.length)
                        : "Unavailable",
                  },
                ]}
              >
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
