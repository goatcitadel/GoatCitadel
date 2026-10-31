import { useEffect, useRef } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useIntegrationSettings } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { UnsavedChangesDialog } from "../../ui/UnsavedChangesDialog";
import { IntegrationConnectionEditor } from "./IntegrationConnectionEditor";
import { IntegrationConnectionDetails } from "./IntegrationConnectionDetails";
import { IntegrationCatalogEvidence } from "./IntegrationCatalogEvidence";
import { IntegrationMeetSettings } from "./IntegrationMeetSettings";

/** A request from the single saved-integrations list to open one connection here; `nonce` re-opens the same one. */
export interface IntegrationManagementSelection {
  connectionId: string;
  nonce: number;
}

/** ST-21: the management views, shown as one segmented control whose pressed state names the open view. */
const MANAGEMENT_VIEWS = [
  { panel: "connectors", label: "Imported connectors" },
  { panel: "history", label: "Delivery records" },
  { panel: "meet", label: "Google Meet preparation" },
] as const;

export function IntegrationManagementSettings({
  workspaceId,
  selection = null,
}: {
  workspaceId: string;
  /** Set by the saved-integrations list; this owner keeps no second list or search box of its own. */
  selection?: IntegrationManagementSelection | null;
}) {
  const s = useIntegrationSettings(workspaceId);
  const available = Boolean(
    s.data && !s.data.issues.some((issue) => ["Integration catalog", "Integration connections"].includes(issue.label)),
  );
  const handledSelection = useRef<number | null>(null);
  const selectionGuard = s.connectionSelectionGuard;
  useEffect(() => {
    if (!selection || !available || handledSelection.current === selection.nonce) return;
    handledSelection.current = selection.nonce;
    selectionGuard.requestTransition(selection.connectionId);
  }, [available, selection, selectionGuard]);
  return (
    <section aria-label="Integration management" className="space-y-4 border-t border-line-subtle pt-4">
      <header>
        <h3 className="text-md font-semibold">Connection management</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Create and edit installation-wide connections. Unsaved drafts are kept, and saving stops if a connection
          changed since you opened it.
        </p>
      </header>
      {s.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading integrations…
        </p>
      ) : null}
      {s.error ? (
        <p role="alert" className="text-sm text-status-failed">
          Connection management unavailable: {describeApiError(s.error).summary}
        </p>
      ) : null}
      {s.data?.issues.map((issue) => (
        <p role="alert" key={issue.label} className="text-sm text-status-waiting">
          {issue.label}: {issue.message}
        </p>
      ))}
      {s.notice ? (
        <p role="status" className="break-words text-sm text-fg-secondary">
          {s.notice.message}
        </p>
      ) : null}
      {[s.connectionMutation, s.createMutation]
        .filter((attempt) => attempt.phase === "uncertain")
        .map((attempt, index) => (
          <p role="alert" key={index} className="text-sm text-status-waiting">
            {attempt.message}
          </p>
        ))}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!available || s.loading} onClick={() => s.openPanel("create")}>
          Add integration connection
        </Button>
        <Button disabled={s.loading || s.saving} onClick={() => void s.reload()}>
          Refresh connection management
        </Button>
      </div>
      <div role="group" aria-label="Management views" className="flex flex-wrap gap-2">
        {MANAGEMENT_VIEWS.map((view) => (
          <Button
            key={view.panel}
            size="sm"
            aria-pressed={s.panel === view.panel}
            disabled={s.loading}
            onClick={() => s.openPanel(s.panel === view.panel ? null : view.panel)}
          >
            {view.label}
          </Button>
        ))}
      </div>
      {available ? (
        <>
          {s.panel === "meet" ? <IntegrationMeetSettings owner={s} /> : null}
          {s.panel === "create" || s.panel === "edit" ? (
            <IntegrationConnectionEditor key={`${s.panel}:${s.selectedConnectionId}`} owner={s} />
          ) : s.panel === "details" ? (
            <IntegrationConnectionDetails owner={s} />
          ) : ["connectors", "history"].includes(s.panel ?? "") ? (
            <IntegrationCatalogEvidence owner={s} />
          ) : null}
        </>
      ) : null}
      <Dialog
        open={Boolean(s.pendingDeleteConnection)}
        title="Delete integration connection?"
        description={`Delete ${s.pendingDeleteConnection?.label ?? "this connection"}? GoatCitadel removes its saved configuration and requests runtime synchronization.`}
        onOpenChange={(open) => {
          if (!open && !s.deletePending) s.setPendingDeleteConnection(null);
        }}
      >
        <p className="break-all text-xs text-fg-muted">Reviewed version: {s.pendingDeleteConnection?.revision}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={s.deletePending || s.connectionMutation.locked || s.review.required}
            onClick={() => void s.handleDelete()}
          >
            Delete reviewed integration
          </Button>
          <Button disabled={s.deletePending} onClick={() => s.setPendingDeleteConnection(null)}>
            Keep integration
          </Button>
        </div>
      </Dialog>
      <UnsavedChangesDialog {...s.leave.dialogProps} />
    </section>
  );
}
