import type { IntegrationSettingsOwner } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { IntegrationFormFields, integrationInputClass } from "./IntegrationFormFields";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import {
  CONNECTOR_CHECK_STATUS_LABELS,
  CONNECTOR_DIAGNOSTIC_STATUS_LABELS,
  INTEGRATION_ACTION_STATUS_LABELS,
  INTEGRATION_CONNECTION_STATUS_LABELS,
  WRITEBACK_REPLAY_OUTCOME_LABELS,
  WRITEBACK_STATUS_LABELS,
} from "./settings-vocabulary";

export function IntegrationConnectionDetails({ owner: s }: { owner: IntegrationSettingsOwner }) {
  const connection = s.selectedConnection;
  const { activeCitadelId } = useUiPreferences();
  const workspaceName = useWorkspaceNameLookup(activeCitadelId, Boolean(connection?.workspaceId));
  if (!connection) return <p role="status">Choose a saved connection.</p>;
  const blocked = s.connectionMutation.locked || s.review.required;
  return (
    <section aria-label="Integration connection details" className="space-y-4 rounded-md border border-line p-4">
      <h3 className="break-words font-semibold">{connection.label}</h3>
      <p className="text-sm text-fg-secondary">
        {connection.enabled ? "Enabled" : "Disabled"} · Configured status:{" "}
        {INTEGRATION_CONNECTION_STATUS_LABELS[connection.status] ?? "Unknown"}
      </p>
      <p className="text-sm text-fg-secondary">
        {s.diagnostics?.connectorId === connection.connectionId ? (
          <>
            Latest diagnostics: {CONNECTOR_DIAGNOSTIC_STATUS_LABELS[s.diagnostics.status] ?? "Unknown"},{" "}
            <TimeText prefix="observed" value={s.diagnostics.checkedAt} />. This result does not establish ongoing
            connectivity.
          </>
        ) : (
          "Connectivity unverified. Saved configuration does not prove a working connection."
        )}
      </p>
      <p className="text-xs text-fg-muted">
        {connection.workspaceId
          ? `Bound workspace: ${workspaceName(connection.workspaceId) ?? "Another workspace"}.`
          : "Unbound connection · Personal Citadel policy applies."}{" "}
        Runtime health and policy still govern use.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={s.connectionMutation.pending} onClick={() => s.openPanel("edit")}>
          Edit integration connection
        </Button>
        <Button
          disabled={!s.data?.connectorDiagnosticsEnabled || s.diagnosticsPending}
          onClick={() => void s.handleDiagnostics()}
        >
          Run integration diagnostics
        </Button>
        <Button
          variant="danger"
          disabled={blocked || !connection.revision}
          onClick={() =>
            s.setPendingDeleteConnection({
              connectionId: connection.connectionId,
              label: connection.label,
              revision: connection.revision,
            })
          }
        >
          Delete integration connection
        </Button>
      </div>
      {!s.data?.connectorDiagnosticsEnabled ? (
        <p className="text-sm text-fg-muted">Connector diagnostics are not enabled in Runtime settings.</p>
      ) : (
        <p className="text-xs text-fg-muted">
          Diagnostics may contact this connection's service. They do not send a sandbox message.
        </p>
      )}
      {s.diagnostics ? (
        <section aria-label="Integration diagnostic result" className="space-y-2 text-sm">
          <h4 className="font-semibold">
            Diagnostics: {CONNECTOR_DIAGNOSTIC_STATUS_LABELS[s.diagnostics.status] ?? "Unknown"}
          </h4>
          <p className="text-xs text-fg-muted">
            <TimeText prefix="Observed" value={s.diagnostics.checkedAt} />
          </p>
          <ul className="space-y-1">
            {s.diagnostics.checks.map((check, index) => (
              <li key={`${check.key}:${index}`} className="break-words">
                {CONNECTOR_CHECK_STATUS_LABELS[check.status] ?? "Unknown"} · {check.message}
              </li>
            ))}
          </ul>
          {s.diagnostics.recommendedNextAction ? <p>{s.diagnostics.recommendedNextAction}</p> : null}
        </section>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Advertised operator actions</summary>
        <p className="mt-2 text-xs text-fg-muted">
          Review each action before dispatch. External writes may be irreversible. The saved connection is read again
          first, but changes made in the meantime are not blocked.
        </p>
        {s.selectedCatalog?.operatorActions?.length ? (
          <div className="mt-3 space-y-4">
            {s.selectedCatalog.operatorActions.map((action) => (
              <section key={action.actionId} className="space-y-2 border-t border-line-subtle pt-3">
                <h4 className="font-semibold">{action.label}</h4>
                <p>{action.description}</p>
                <p className="text-xs text-fg-muted">Capability: {action.capability}</p>
                {action.formSchema ? (
                  <IntegrationFormFields
                    schema={action.formSchema}
                    value={s.operatorActionInputs[action.actionId] ?? {}}
                    disabled={blocked}
                    onChange={(value) =>
                      s.setOperatorActionInputs((current) => ({ ...current, [action.actionId]: value }))
                    }
                  />
                ) : null}
                {action.capability === "write" ? (
                  <label className="block">
                    Idempotency key
                    <input
                      aria-label={`Idempotency key for ${action.label}`}
                      className={integrationInputClass}
                      value={s.operatorActionIdempotencyKeys[action.actionId] ?? ""}
                      disabled={blocked}
                      onChange={(event) =>
                        s.setOperatorActionIdempotencyKeys((current) => ({
                          ...current,
                          [action.actionId]: event.target.value,
                        }))
                      }
                    />
                    <span className="text-xs text-fg-muted">
                      Optional explicit key. The Gateway's action-specific replay policy remains authoritative.
                    </span>
                  </label>
                ) : null}
                <Button disabled={blocked} onClick={() => s.handleOperatorAction(action)}>
                  Review {action.label}
                </Button>
              </section>
            ))}
          </div>
        ) : (
          <p className="mt-2">
            This catalog entry advertises no operator action. Configuration alone does not make a capability callable.
          </p>
        )}
      </details>
      {s.lastOperatorActionResult ? (
        <section aria-label="Integration action result" className="space-y-2 text-sm">
          <h4 className="font-semibold">
            {s.lastOperatorActionResult.actionLabel}:{" "}
            {INTEGRATION_ACTION_STATUS_LABELS[s.lastOperatorActionResult.status] ?? "Unknown"}
          </h4>
          <p className="break-words">{s.lastOperatorActionResult.message}</p>
          <p className="text-xs text-fg-muted">
            <TimeText prefix="Observed" value={s.lastOperatorActionResult.checkedAt} />
          </p>
          <p>
            Undo:{" "}
            {s.lastOperatorActionResult.reversibility?.label ??
              s.lastOperatorActionResult.durableWriteback?.reversibility?.label ??
              "No inverse operation advertised"}
          </p>
          {s.lastOperatorActionResult.durableWriteback ? (
            <p className="break-words">
              Writeback: {WRITEBACK_STATUS_LABELS[s.lastOperatorActionResult.durableWriteback.status] ?? "Unknown"} ·
              Replay:{" "}
              {s.lastOperatorActionResult.durableWriteback.replayOutcome
                ? (WRITEBACK_REPLAY_OUTCOME_LABELS[s.lastOperatorActionResult.durableWriteback.replayOutcome] ??
                  "Unknown")
                : "Not reported"}
            </p>
          ) : null}
          <TechnicalDetails label="Action result">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
              {JSON.stringify(s.lastOperatorActionResult, null, 2)}
            </pre>
          </TechnicalDetails>
        </section>
      ) : null}
      <TechnicalDetails label="Connection identity and version">
        <dl className="space-y-1 font-mono text-xs">
          <dt>Connection</dt>
          <dd className="break-all">{connection.connectionId}</dd>
          <dt>Catalog</dt>
          <dd>{connection.catalogId}</dd>
          <dt>Version</dt>
          <dd className="break-all">{connection.revision}</dd>
          <dt>Updated</dt>
          <dd>
            <TimeText absolute value={connection.updatedAt} />
          </dd>
          <dt>Bound workspace</dt>
          <dd className="break-all">{connection.workspaceId ?? "None"}</dd>
        </dl>
      </TechnicalDetails>
      <Dialog
        open={s.operatorReview !== null}
        title="Run reviewed integration action?"
        description="This may contact the external service. The Gateway's policy and approvals remain authoritative."
        onOpenChange={(open) => {
          if (!open && !s.operatorBusyId) s.cancelOperatorAction();
        }}
      >
        <p className="break-words text-sm">
          {s.operatorReview?.action.label} on {s.operatorReview?.connection.label}
        </p>
        <p className="mt-2 text-xs text-fg-muted">
          The saved connection and catalog action are read again before running, but changes made in the meantime are
          not blocked.
        </p>
        {!s.operatorReviewCurrent ? (
          <p role="alert">The reviewed input or view changed. Close and review again.</p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!s.operatorReviewCurrent || blocked}
            onClick={() => void s.confirmOperatorAction()}
          >
            Run reviewed action
          </Button>
          <Button disabled={Boolean(s.operatorBusyId)} onClick={s.cancelOperatorAction}>
            Cancel action
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
