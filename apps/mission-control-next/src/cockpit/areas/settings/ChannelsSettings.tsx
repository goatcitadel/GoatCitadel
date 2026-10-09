import { useState } from "react";
import { createChannelPlanReviewHandoff, channelPlanReviewHref } from "@goatcitadel/mission-control-shared/api/channel-plan-handoff";
import { ChannelEntryControls } from "../../../features/native-routes/settings/channel-setup/ChannelEntryControls";
import { useChannelReturnNavigation } from "../../../features/native-routes/settings/sections/use-channel-return-navigation";
import { useChannelSettings } from "../../../features/native-routes/settings/sections/use-channel-settings";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { ChannelOutcomeCheck } from "../../../features/native-routes/settings/sections/ChannelOutcomeCheck";
import { ChannelDraftEditor } from "./ChannelDraftEditor";
import { ChannelDraftLeave } from "./ChannelDraftLeave";
import { ChannelOperations } from "./ChannelOperations";
import { ChannelLifecycleControls } from "./ChannelLifecycleControls";
import { channelInputClass } from "./ChannelWizardFields";

export function ChannelsSettings({ workspaceId }: { workspaceId: string }) {
  const { navigate, search } = useCockpitRoute();
  const owner = useChannelSettings(workspaceId, (plan) => navigate(channelPlanReviewHref(createChannelPlanReviewHandoff(plan))));
  useChannelReturnNavigation(owner, search);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const { data, selectedDraft, selectedDefinition, channelDraft, selectedConnection } = owner;
  const disabled = owner.mutation.pending || Boolean(owner.mutation.uncertain) || owner.entryBusy;
  const matches = (label: string) => label.toLowerCase().includes(query.trim().toLowerCase());
  return (
    <section id="channels" aria-label="Channel setup" className="space-y-4 rounded-lg border border-line bg-panel p-4">
      <header>
        <h2 className="font-display text-lg font-semibold">Channels</h2>
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
      {owner.loading && !data ? <p role="status">Loading channel owners…</p> : null}
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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={disabled || !owner.createDefinition}
              onClick={() => void owner.handleCreate()}
            >
              Start guided setup
            </Button>

          </div>
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
                  <dt>Current revision</dt>
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
                  Use current connection revision
                </Button>
              </div>
            </section>
          ) : null}
          {channelDraft.hasRemoteChanges ? (
            <section className="space-y-2 rounded-md border border-line p-3 text-sm">
              <h3 className="font-semibold">Channel draft changed</h3>
              <p>Your input is retained. Saved revision {selectedDraft?.revision} must be reviewed before retrying.</p>
              <details>
                <summary className="cursor-pointer">Current saved public fields</summary>
                <dl className="space-y-1">
                  {Object.entries(selectedDraft?.draft ?? {}).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd className="break-words">
                        {typeof value === "object"
                          ? "Structured value; inspect in advanced editor after discarding or rebasing"
                          : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <Button disabled={disabled} onClick={channelDraft.rebaseToCurrent}>
                Apply retained input to current revision
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
            <p>The selected draft or its setup definition is unavailable. Refresh the Gateway catalog.</p>
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
            <ul className="mt-2 space-y-2">
              {data?.connections
                .filter((item) => matches(`${item.label} ${item.key}`))
                .slice(0, limit)
                .map((item) => (
                  <li key={item.connectionId} className="rounded-md border border-line p-3">
                    <h4 className="font-medium">{item.label}</h4>
                    <p className="text-sm text-fg-secondary">
                      {item.key} · {item.enabled ? "Enabled" : "Disabled"} · observed {item.status}
                    </p>
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
                ))}
            </ul>
            {data && !data.connections.length && !data.issues.some((item) => item.label === "Channel connections") ? (
              <p className="text-sm text-fg-muted">No saved channel connections.</p>
            ) : null}
          </section>
          <section aria-label="Saved channel drafts">
            <h3 className="font-semibold">Drafts</h3>
            <ul className="mt-2 space-y-2">
              {data?.drafts
                .filter((item) => matches(`${item.label ?? ""} ${item.catalogId}`))
                .slice(0, limit)
                .map((item) => (
                  <li
                    key={item.draftId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3"
                  >
                    <span className="text-sm">
                      {item.label || item.catalogId} · revision {item.revision} · {item.lifecycleMode}
                    </span>
                    <Button onClick={() => owner.draftSelectionGuard.requestTransition(item.draftId)}>
                      Edit {item.label || item.catalogId}
                    </Button>
                    <ChannelLifecycleControls workspaceId={workspaceId} selection={{ draft: item }} reload={owner.reload} />
                  </li>
                ))}
            </ul>
          </section>
          {Math.max(data?.connections.length ?? 0, data?.drafts.length ?? 0) > limit ? (
            <Button onClick={() => setLimit((value) => value + 20)}>Show more channels</Button>
          ) : null}
          {owner.panel === "connection" && selectedConnection ? (
            <section aria-label="Selected channel connection" className="space-y-3 rounded-md border border-line p-3">
              <h3 className="font-semibold">{selectedConnection.label}</h3>
              <p className="text-sm">
                {selectedConnection.lastError ?? "No last error recorded. This does not prove current connectivity."}
              </p>
              <Button disabled={disabled} onClick={() => void owner.editConnection()}>
                Edit channel setup
              </Button>
              <ChannelOperations key={selectedConnection.connectionId} connection={selectedConnection} onUpdated={owner.reload} connectorDiagnosticsEnabled={data?.connectorDiagnosticsEnabled} />
              <ChannelLifecycleControls key={`lifecycle:${selectedConnection.connectionId}`} workspaceId={workspaceId} selection={{ connection: selectedConnection }} reload={owner.reload} />
              <details className="text-sm">
                <summary className="cursor-pointer">Connection identity</summary>
                <p className="break-all">
                  {selectedConnection.connectionId} · revision {selectedConnection.revision}
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
