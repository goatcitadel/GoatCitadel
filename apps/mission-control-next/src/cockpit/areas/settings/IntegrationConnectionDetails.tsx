import type { IntegrationSettingsOwner } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { IntegrationFormFields, integrationInputClass } from "./IntegrationFormFields";

export function IntegrationConnectionDetails({ owner: s }: { owner: IntegrationSettingsOwner }) {
  const connection = s.selectedConnection;
  if (!connection) return <p role="status">Choose a saved connection.</p>;
  const blocked = s.connectionMutation.locked || s.review.required;
  return (
    <section aria-label="Integration connection details" className="space-y-4 rounded-md border border-line p-4">
      <h3 className="break-words font-semibold">{connection.label}</h3>
      <p className="text-sm text-fg-secondary">
        {connection.enabled ? "Enabled" : "Disabled"} · Configured status: {connection.status}
      </p>
      <p className="text-sm text-fg-secondary">{s.diagnostics?.connectorId === connection.connectionId
        ? `Latest diagnostics: ${s.diagnostics.status}, observed ${s.diagnostics.checkedAt}. This result does not establish ongoing connectivity.`
        : "Connectivity unverified. Saved configuration does not prove a working connection."}</p>
      <p className="text-xs text-fg-muted">
        {connection.workspaceId
          ? `Bound workspace: ${connection.workspaceId}`
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
          <h4 className="font-semibold">Diagnostics: {s.diagnostics.status}</h4>
          <p className="text-xs text-fg-muted">Observed {s.diagnostics.checkedAt}</p>
          <ul className="space-y-1">
            {s.diagnostics.checks.map((check, index) => (
              <li key={`${check.key}:${index}`} className="break-words">
                {check.status} · {check.message}
              </li>
            ))}
          </ul>
          {s.diagnostics.recommendedNextAction ? <p>{s.diagnostics.recommendedNextAction}</p> : null}
        </section>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Advertised operator actions</summary>
        <p className="mt-2 text-xs text-fg-muted">
          Review each action before dispatch. External writes may be irreversible. Saved connection state is rechecked;
          this action API has no atomic revision precondition.
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
            {s.lastOperatorActionResult.actionLabel}: {s.lastOperatorActionResult.status}
          </h4>
          <p className="break-words">{s.lastOperatorActionResult.message}</p>
          <p className="text-xs text-fg-muted">Observed {s.lastOperatorActionResult.checkedAt}</p>
          <p>
            Undo:{" "}
            {s.lastOperatorActionResult.reversibility?.label ??
              s.lastOperatorActionResult.durableWriteback?.reversibility?.label ??
              "No inverse operation advertised"}
          </p>
          {s.lastOperatorActionResult.durableWriteback ? (
            <p className="break-words">
              Writeback: {s.lastOperatorActionResult.durableWriteback.status} · Replay:{" "}
              {s.lastOperatorActionResult.durableWriteback.replayOutcome ?? "Not reported"}
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer">Owner evidence</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(s.lastOperatorActionResult, null, 2)}
            </pre>
          </details>
        </section>
      ) : null}
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer">Connection identity and revision</summary>
        <dl className="mt-2 space-y-1">
          <dt>Connection</dt>
          <dd className="break-all">{connection.connectionId}</dd>
          <dt>Catalog</dt>
          <dd>{connection.catalogId}</dd>
          <dt>Revision</dt>
          <dd className="break-all">{connection.revision}</dd>
          <dt>Updated</dt>
          <dd>{connection.updatedAt}</dd>
        </dl>
      </details>
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
          The exact saved connection and catalog action are read again before dispatch. The action API has no atomic
          revision precondition.
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
