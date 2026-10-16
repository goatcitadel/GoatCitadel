import { useState } from "react";
import { useIntegrationSettings } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { UnsavedChangesDialog } from "../../ui/UnsavedChangesDialog";
import { IntegrationConnectionEditor } from "./IntegrationConnectionEditor";
import { IntegrationConnectionDetails } from "./IntegrationConnectionDetails";
import { IntegrationCatalogEvidence } from "./IntegrationCatalogEvidence";
import { NotificationRoutingSettings } from "./NotificationRoutingSettings";
import { IntegrationMeetSettings } from "./IntegrationMeetSettings";
import { integrationInputClass } from "./IntegrationFormFields";

export function IntegrationManagementSettings({ workspaceId }: { workspaceId: string }) {
  const s = useIntegrationSettings(workspaceId);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(20);
  const available = Boolean(
    s.data && !s.data.issues.some((issue) => ["Integration catalog", "Integration connections"].includes(issue.label)),
  );
  const connections =
    s.data?.connections.filter(
      (item) =>
        item.kind !== "external_connector" && `${item.label} ${item.key}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <section aria-label="Integration management" className="space-y-4 rounded-md border border-line-subtle p-3">
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
          {String(s.error)}
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
        <Button disabled={s.loading} onClick={() => s.openPanel("connectors")}>
          Imported connectors
        </Button>
        <Button disabled={s.loading} onClick={() => s.openPanel("plugins")}>
          Plugin trust
        </Button>
        <Button disabled={s.loading} onClick={() => s.openPanel("history")}>
          Delivery records
        </Button>
        <Button disabled={s.loading} onClick={() => s.openPanel("routing")}>
          Notification routing
        </Button>
        <Button disabled={s.loading} onClick={() => s.openPanel("meet")}>
          Google Meet preparation
        </Button>
      </div>
      {available ? (
        <>
          <label className="block text-sm">
            Find managed integration
            <input
              aria-label="Find managed integration"
              type="search"
              className={integrationInputClass}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(20);
              }}
            />
          </label>
          <ul className="space-y-2">
            {connections.slice(0, limit).map((connection) => (
              <li key={connection.connectionId}>
                <Button
                  className="h-auto w-full justify-start whitespace-normal break-words text-left"
                  onClick={() => s.connectionSelectionGuard.requestTransition(connection.connectionId)}
                >
                  {connection.label} · {connection.enabled ? "Enabled" : "Disabled"}
                </Button>
              </li>
            ))}
          </ul>
          {!connections.length ? <p className="text-sm text-fg-muted">No saved integrations match this view.</p> : null}
          {connections.length > limit ? (
            <Button onClick={() => setLimit((value) => value + 20)}>Show more managed integrations</Button>
          ) : null}
          {s.panel === "meet" ? <IntegrationMeetSettings owner={s} /> : null}
          {s.panel === "create" || s.panel === "edit" ? (
            <IntegrationConnectionEditor key={`${s.panel}:${s.selectedConnectionId}`} owner={s} />
          ) : s.panel === "details" ? (
            <IntegrationConnectionDetails owner={s} />
          ) : ["connectors", "plugins", "history"].includes(s.panel ?? "") ? (
            <IntegrationCatalogEvidence owner={s} />
          ) : s.panel === "routing" ? (
            <NotificationRoutingSettings
              key={workspaceId}
              workspaceId={workspaceId}
              channels={s.data?.channelConnections ?? []}
            />
          ) : null}
        </>
      ) : null}
      <Dialog
        open={Boolean(s.pendingDeleteConnection)}
        title="Delete integration connection?"
        description={`Delete ${s.pendingDeleteConnection?.label ?? "this connection"}? The Gateway removes its saved configuration and requests runtime synchronization.`}
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
