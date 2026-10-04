import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { fetchIntegrationConnections } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import {
  canToggleIntegration,
  useIntegrationEnabled,
} from "../../../features/native-routes/settings/use-integration-enabled";
import { useIntegrationConnectionMutation } from "../../../features/native-routes/settings/integration-connection-mutation";
import { Button } from "../../ui/Button";
import { IntegrationManagementSettings } from "./IntegrationManagementSettings";

const PAGE_SIZE = 20;
export function IntegrationConnectionsSettings({ workspaceId }: { workspaceId: string }) {
  const connections = useQuery({
    queryKey: ["settings", "integration-connections"],
    queryFn: () => fetchIntegrationConnections(),
  });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [search, setSearch] = useState("");
  const [managementOpen, setManagementOpen] = useState(false);
  const ready = !connections.isError && Array.isArray(connections.data?.items);
  const control = useIntegrationEnabled({
    workspaceId,
    available: ready && !connections.isFetching,
    reload: () => connections.refetch(),
  });
  const items = ready
    ? connections.data!.items.filter((item) => item.kind !== "channel" && item.kind !== "external_connector")
    : [];
  const filtered = items.filter((item) => `${item.label} ${item.key}`.toLowerCase().includes(search.toLowerCase()));
  const reviewed = control.review;
  return (
    <section
      id="integration-connections"
      aria-label="Integration connections"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4"
    >
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Saved integrations</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Connections for this Gateway installation, across all workspaces. Review a saved connection before enabling or
          disabling it.
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          Enabled state controls runtime availability. Connection health, tool policy, approvals, and plugin
          availability still apply.
        </p>
      </header>
      <Button aria-expanded={managementOpen} onClick={() => setManagementOpen(value => !value)}>
        {managementOpen ? "Hide connection management" : "Add and manage integrations"}
      </Button>
      {managementOpen ? <IntegrationManagementSettings workspaceId={workspaceId} /> : null}
      <Button
        size="sm"
        disabled={connections.isFetching || control.checking || control.attempt.pending}
        onClick={() => void connections.refetch()}
      >
        Refresh integrations
      </Button>
      {connections.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading saved integrations…
        </p>
      ) : null}
      {connections.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Integration directory unavailable: {describeApiError(connections.error).summary}
        </p>
      ) : null}
      {!connections.isLoading && !connections.isError && !ready ? (
        <p role="alert" className="text-sm text-status-failed">
          Integration evidence is unavailable. Refresh before changing a connection.
        </p>
      ) : null}
      {control.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {control.notice}
        </p>
      ) : null}
      {control.checking ? (
        <p role="status" className="text-sm text-fg-muted">
          Reading current connection evidence…
        </p>
      ) : null}
      {ready ? (
        <>
          <label className="block text-sm text-fg-secondary">
            Search saved integrations
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(PAGE_SIZE);
              }}
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-sm text-fg"
            />
          </label>
          <p className="text-xs text-fg-muted">
            Showing {Math.min(limit, filtered.length)} of {filtered.length} loaded integrations
            {connections.data!.items.length === 300 ? " · Owner directory limited to 300 records" : ""}.
          </p>
          <ul className="space-y-2">
            {filtered.slice(0, limit).map((connection) => (
              <IntegrationRow
                key={connection.connectionId}
                connection={connection}
                disabled={connections.isFetching || control.checking || Boolean(reviewed)}
                onReview={() => void control.requestReview(connection)}
              />
            ))}
          </ul>
          {!filtered.length ? (
            <p className="text-sm text-fg-muted">
              No saved integrations match this view. Connection setup is available in the classic Settings view.
            </p>
          ) : null}
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Show more integrations
            </Button>
          ) : null}
        </>
      ) : null}
      <ConfirmModal
        className="min-w-0 grid-cols-1 break-words"
        open={reviewed !== null}
        title={reviewed?.enabled ? "Enable integration?" : "Disable integration?"}
        message={`${reviewed?.enabled ? "Enable" : "Disable"} ${reviewed?.connection.label ?? "this connection"} for this Gateway installation? ${reviewed?.connection.workspaceId ? "Its saved workspace binding remains unchanged." : "Unbound connection: Personal Citadel policy applies."} This changes the saved enabled state and requests runtime synchronization. It does not test connectivity or override policy and approvals.`}
        confirmLabel={reviewed?.enabled ? "Enable reviewed integration" : "Disable reviewed integration"}
        cancelLabel="Keep current state"
        pending={control.checking || control.attempt.pending}
        confirmDisabled={!ready || connections.isFetching || control.checking || control.attempt.locked}
        onCancel={control.cancel}
        onConfirm={() => void control.confirm()}
      />
    </section>
  );
}

function IntegrationRow({
  connection,
  disabled,
  onReview,
}: {
  connection: IntegrationConnection;
  disabled: boolean;
  onReview: () => void;
}) {
  const attempt = useIntegrationConnectionMutation(connection.connectionId);
  return (
    <li className="rounded-md border border-line-subtle bg-sunken p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-sm font-semibold text-fg">{connection.label}</h4>
          <p className="mt-1 text-sm text-fg-secondary">
            {connection.enabled ? "Enabled" : "Disabled"} · {humanizeToken(connection.status)}
          </p>
          <p className="mt-1 break-words text-xs text-fg-muted">
            {connection.workspaceId ? "Workspace-bound connection" : "Unbound · Personal Citadel policy"}
          </p>
        </div>
        <Button
          size="sm"
          disabled={disabled || attempt.locked || !canToggleIntegration(connection)}
          aria-label={`Review ${connection.enabled ? "disable" : "enable"} ${connection.label}`}
          onClick={onReview}
        >
          {connection.enabled ? "Review disable" : "Review enable"}
        </Button>
      </div>
      <details className="mt-2 text-xs text-fg-muted">
        <summary className="cursor-pointer">Connection details</summary>
        <dl className="mt-2 grid min-w-0 gap-1">
          <dt>Connection ID</dt>
          <dd className="break-all font-mono">{connection.connectionId}</dd>
          <dt>Revision</dt>
          <dd className="break-all font-mono">{connection.revision}</dd>
          {connection.workspaceId ? (
            <>
              <dt>Bound workspace</dt>
              <dd className="break-all font-mono">{connection.workspaceId}</dd>
            </>
          ) : null}
        </dl>
      </details>
      {attempt.pending ? (
        <p role="status" className="mt-2 text-sm text-fg-muted">
          Waiting for the Gateway connection owner…
        </p>
      ) : null}
      {attempt.phase === "uncertain" ? (
        <p role="alert" className="mt-2 text-sm text-status-waiting">
          {attempt.message}
        </p>
      ) : null}
    </li>
  );
}
