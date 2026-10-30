import { useState } from "react";
import { describeRetiredChannel } from "@goatcitadel/contracts";
import { presentChannelStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import {
  createChannelPlanReviewHandoff,
  channelPlanReviewHref,
} from "@goatcitadel/mission-control-shared/api/channel-plan-handoff";
import { ChannelEntryControls } from "../../../features/native-routes/settings/channel-setup/ChannelEntryControls";
import { ChannelConnectionWebhook } from "../../../features/native-routes/settings/channel-setup/ChannelWebhookAddress";
import { useChannelReturnNavigation } from "../../../features/native-routes/settings/sections/use-channel-return-navigation";
import { useChannelSettings } from "../../../features/native-routes/settings/sections/use-channel-settings";
import { channelPickerHref } from "../../app/routes";
import { chatSetupHref, chatSetupHrefForDraft } from "../chat/channel-setup/channel-picker-model";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { ChannelOutcomeCheck } from "../../../features/native-routes/settings/sections/ChannelOutcomeCheck";
import { ChannelDraftEditor } from "./ChannelDraftEditor";
import { ChannelDraftLeave } from "./ChannelDraftLeave";
import { ChannelOperations } from "./ChannelOperations";
import { ChannelLifecycleControls } from "./ChannelLifecycleControls";
import { channelInputClass } from "./ChannelWizardFields";
import { useChannelPreselect } from "./use-channel-preselect";

export function ChannelsSettings({ workspaceId }: { workspaceId: string }) {
  const { navigate, search } = useCockpitRoute();
  const owner = useChannelSettings(workspaceId, (plan) =>
    navigate(channelPlanReviewHref(createChannelPlanReviewHandoff(plan))),
  );
  useChannelReturnNavigation(owner, search);
  useChannelPreselect(owner, search);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const { data, selectedDraft, selectedDefinition, channelDraft, selectedConnection } = owner;
  const disabled = owner.mutation.pending || Boolean(owner.mutation.uncertain) || owner.entryBusy;
  // A retired channel's connection can only be removed; nothing about it can be edited, checked or switched on.
  const selectedRetiredReason = selectedConnection ? describeRetiredChannel(selectedConnection.key) : undefined;
  const matches = (label: string) => label.toLowerCase().includes(query.trim().toLowerCase());
  // A channel with its own setup page in Chat is set up there, from the start or from where a new setup stopped.
  const createInChat = owner.createDefinition ? chatSetupHref(owner.createDefinition) : undefined;
  return (
    <section
      id="channels"
      aria-label="Channel setup"
      className="space-y-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <header className="space-y-1">
        <p className="text-sm text-fg-secondary">
          Some channels have a quicker setup page of their own.{" "}
          <NativeOwnerLink href={channelPickerHref()} scope={workspaceId}>
            Add a channel
          </NativeOwnerLink>
        </p>
        <p className="text-sm text-fg-secondary">
          Connections and setup drafts belong to this installation. This workspace is only the origin of a finalization
          plan.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button disabled={owner.loading} onClick={() => void owner.reload()}>
          Refresh channels
        </Button>
        <Button disabled={disabled} onClick={() => owner.leave.request(() => owner.setPanel("create"))}>
          Connect channel
        </Button>
        {owner.panel ? <Button onClick={owner.closePanel}>Back to channels</Button> : null}
      </div>
      {owner.loading && !data ? <p role="status">Loading channels…</p> : null}
      {owner.error ? (
        <p role="alert" className="text-status-failed">
          {owner.error}
        </p>
      ) : null}
      {owner.notice ? (
        <p role="status" className="text-sm">
          {owner.notice.message}
        </p>
      ) : null}
      {owner.mutation.uncertain ? (
        <p role="alert" className="text-sm text-status-waiting">
          {owner.mutation.uncertain}
        </p>
      ) : null}
      <ChannelOutcomeCheck reload={owner.reload} buttonComponent={Button} />
      {data?.issues.length ? (
        <div role="alert" className="text-sm text-status-waiting">
          {data.issues.map((issue) => (
            <p key={issue.label}>
              {issue.label}: {issue.message}
            </p>
          ))}
        </div>
      ) : null}
      {owner.panel === "create" ? (
        <section aria-label="New channel setup" className="space-y-3">
          <label className="block text-sm">
            Channel definition
            <select
              aria-label="Channel definition"
              className={channelInputClass}
              disabled={disabled || !data?.definitions.length}
              value={owner.createCatalogId}
              onChange={(e) => owner.setCreateCatalogId(e.target.value)}
            >
              <option value="" disabled>
                No definition selected
              </option>
              {data?.definitions.map((item) => (
                <option key={item.catalog.catalogId} value={item.catalog.catalogId}>
                  {item.catalog.label}
                </option>
              ))}
            </select>
          </label>
          {owner.createDefinition ? (
            <>
              <p className="text-sm text-fg-secondary">{owner.createDefinition.catalog.description}</p>
              <p className="text-xs text-fg-muted">
                {owner.createDefinition.wizard.difficulty} · about {owner.createDefinition.wizard.estimatedMinutes}{" "}
                minutes. A saved draft is not an active connection.
              </p>
            </>
          ) : null}
          {createInChat && owner.createDefinition ? (
            <NativeOwnerLink href={createInChat} scope={workspaceId}>
              Set up {owner.createDefinition.catalog.label} in Chat
            </NativeOwnerLink>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={disabled || !owner.createDefinition}
                onClick={() => void owner.handleCreate()}
              >
                Start guided setup
              </Button>
            </div>
          )}
        </section>
      ) : owner.panel === "editor" ? (
        <>
          {owner.needsConnectionReview ? (
            <section
              aria-label="Review changed channel connection"
              className="space-y-2 rounded-md border border-line p-3 text-sm"
            >
              <h3 className="font-semibold">Saved connection review required</h3>
              <p>
                Your setup fields remain. Reviewing refreshes inherited credentials; explicit replacements stay in the
                draft. A new live test is required.
              </p>
              {owner.draftConnection ? (
                <dl>
                  <dt>Connection</dt>
                  <dd>
                    {owner.draftConnection.label} · {owner.draftConnection.connectionId}
                  </dd>
                  <dt>Current version</dt>
                  <dd className="break-all">{owner.draftConnection.revision}</dd>
                </dl>
              ) : (
                <p>The saved connection is unavailable.</p>
              )}
              {owner.connectionReview.error ? <p role="alert">{owner.connectionReview.error}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={disabled || owner.connectionReview.loading}
                  onClick={() => void owner.connectionReview.refresh()}
                >
                  Refresh connection review
                </Button>
                <Button
                  disabled={
                    disabled ||
                    owner.connectionReview.loading ||
                    Boolean(owner.connectionReview.error) ||
                    !owner.draftConnection
                  }
                  onClick={() => void owner.handleAcceptConnectionReview()}
                >
                  Use latest connection version
                </Button>
              </div>
            </section>
          ) : null}
          {channelDraft.hasRemoteChanges ? (
            <section className="space-y-2 rounded-md border border-line p-3 text-sm">
              <h3 className="font-semibold">Channel draft changed</h3>
              <p>
                Your input is kept. It started from an older version; review saved version {selectedDraft?.revision}{" "}
                before retrying.
              </p>
              <details>
                <summary className="cursor-pointer">Current saved public fields</summary>
                <dl className="space-y-1">
                  {Object.entries(selectedDraft?.draft ?? {}).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd className="break-words">
                        {typeof value === "object"
                          ? "Structured value; open the advanced editor after discarding your input or applying it to the latest version"
                          : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <Button disabled={disabled} onClick={channelDraft.rebaseToCurrent}>
                Apply my input to latest version
              </Button>
            </section>
          ) : null}
          {selectedDraft && selectedDefinition ? (
            <ChannelDraftEditor
              scopeId={workspaceId}
              draft={selectedDraft}
              definition={selectedDefinition}
              values={owner.draftValues}
              label={owner.draftLabel}
              enabled={owner.draftEnabled}
              dirty={owner.draftDirty}
              advancedValue={channelDraft.value.advancedText}
              onAdvancedValueChange={(advancedText) =>
                channelDraft.setValue((current) => ({ ...current, advancedText }))
              }
              feedback={owner.validationRevision === selectedDraft.revision ? owner.validationResult : null}
              draftEvidence={owner.draftEvidence}
              draftEvidenceLoading={owner.draftEvidenceLoading}
              draftEvidenceError={owner.draftEvidenceError}
              busyAction={owner.mutation.pending ? owner.busyAction : null}
              mutationBlocked={disabled}
              reviewRequired={owner.needsConnectionReview || channelDraft.hasRemoteChanges}
              onValuesChange={(values) => {
                owner.setDraftValues(values);
                owner.setValidationResult(null);
              }}
              onLabelChange={(label) => {
                owner.setDraftLabel(label);
                owner.setValidationResult(null);
              }}
              onEnabledChange={(enabled) => {
                owner.setDraftEnabled(enabled);
                owner.setValidationResult(null);
              }}
              onDirty={() => owner.setValidationResult(null)}
              onSave={owner.handleSave}
              onValidate={owner.handleValidate}
              onTest={owner.handleTest}
              onFinalize={owner.handleFinalize}
              onAcknowledgeTest={owner.handleAcknowledgeTest}
              supplementaryActions={<ChannelEntryControls owner={owner} />}
            />
          ) : (
            <p>The selected draft or its setup definition is unavailable. Refresh the channel catalog.</p>
          )}
        </>
      ) : (
        <>
          <label className="block text-sm">
            Search channels
            <input
              type="search"
              aria-label="Search channels"
              className={channelInputClass}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(20);
              }}
            />
          </label>
          <section aria-label="Saved channel connections">
            <h3 className="font-semibold">Connections</h3>
            <ul className="mt-2 divide-y divide-line-subtle">
              {data?.connections
                .filter((item) => matches(`${item.label} ${item.key}`))
                .slice(0, limit)
                .map((item) => {
                  // A retired channel's saved state is left as it was; it is out of service whatever that state says.
                  const retired = describeRetiredChannel(item.key);
                  return (
                    <li key={item.connectionId} className="py-3">
                      <h4 className="font-medium">{item.label}</h4>
                      {retired ? (
                        <>
                          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
                            {item.key}
                            <StatusBadge status={presentChannelStatus("removed")} />
                          </p>
                          <p className="text-sm text-fg-secondary">{retired}</p>
                        </>
                      ) : (
                        <p className="text-sm text-fg-secondary">
                          {item.key} · {item.enabled ? "Enabled" : "Disabled"} · observed {item.status}
                        </p>
                      )}
                      <Button
                        onClick={() =>
                          owner.leave.request(() => {
                            owner.setSelectedConnectionId(item.connectionId);
                            owner.setPanel("connection");
                          })
                        }
                      >
                        Inspect {item.label}
                      </Button>
                    </li>
                  );
                })}
            </ul>
            {data && !data.connections.length && !data.issues.some((item) => item.label === "Channel connections") ? (
              <p className="text-sm text-fg-muted">No saved channel connections.</p>
            ) : null}
          </section>
          <section aria-label="Saved channel drafts">
            <h3 className="font-semibold">Drafts</h3>
            <ul className="mt-2 divide-y divide-line-subtle">
              {data?.drafts
                .filter((item) => matches(`${item.label ?? ""} ${item.catalogId}`))
                .slice(0, limit)
                .map((item) => {
                  const name = item.label || item.catalogId;
                  const continueInChat = chatSetupHrefForDraft(item, data.definitions);
                  return (
                    <li key={item.draftId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                      <span className="text-sm">
                        {name} · version {item.revision} · {item.lifecycleMode}
                      </span>
                      {continueInChat ? (
                        <NativeOwnerLink href={continueInChat} scope={workspaceId}>
                          Continue {name} in Chat
                        </NativeOwnerLink>
                      ) : (
                        <Button onClick={() => owner.draftSelectionGuard.requestTransition(item.draftId)}>
                          Edit {name}
                        </Button>
                      )}
                      <ChannelLifecycleControls
                        workspaceId={workspaceId}
                        selection={{ draft: item }}
                        reload={owner.reload}
                      />
                    </li>
                  );
                })}
            </ul>
          </section>
          {Math.max(data?.connections.length ?? 0, data?.drafts.length ?? 0) > limit ? (
            <Button onClick={() => setLimit((value) => value + 20)}>Show more channels</Button>
          ) : null}
          {owner.panel === "connection" && selectedConnection ? (
            <section aria-label="Selected channel connection" className="space-y-3 border-t border-line-subtle pt-4">
              <h3 className="font-semibold">{selectedConnection.label}</h3>
              {selectedRetiredReason ? (
                <p className="text-sm">{selectedRetiredReason}</p>
              ) : (
                <>
                  <p className="text-sm">
                    {selectedConnection.lastError ??
                      "No last error recorded. This does not prove current connectivity."}
                  </p>
                  <Button disabled={disabled} onClick={() => void owner.editConnection()}>
                    Edit channel setup
                  </Button>
                  <ChannelOperations
                    key={selectedConnection.connectionId}
                    connection={selectedConnection}
                    onUpdated={owner.reload}
                    connectorDiagnosticsEnabled={data?.connectorDiagnosticsEnabled}
                  />
                </>
              )}
              <ChannelLifecycleControls
                key={`lifecycle:${selectedConnection.connectionId}`}
                workspaceId={workspaceId}
                selection={{ connection: selectedConnection }}
                reload={owner.reload}
                removeOnly={Boolean(selectedRetiredReason)}
              />
              {selectedRetiredReason ? null : (
                <ChannelConnectionWebhook connection={selectedConnection} definitions={data?.definitions} />
              )}
              <details className="text-sm">
                <summary className="cursor-pointer">Connection identity</summary>
                <p className="break-all">
                  {selectedConnection.connectionId} · version {selectedConnection.revision}
                </p>
              </details>
            </section>
          ) : null}
        </>
      )}
      <ChannelDraftLeave {...owner.leave.dialogProps} />
    </section>
  );
}
