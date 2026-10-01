import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpServers } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  hasMcpServerBinding,
  isGatewayMcpServer,
  useMcpServerMutation,
} from "../../../features/native-routes/settings/mcp-server-mutation";
import { mcpToggleUnavailableReason, useMcpEnabled } from "../../../features/native-routes/settings/use-mcp-enabled";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { McpServerEditor } from "./McpServerEditor";
import { McpServerCreate } from "./McpServerCreate";
import { McpDeleteControl } from "./McpDeleteControl";
import { McpServerInspection } from "./McpServerInspection";
import { McpElicitationRequests } from "./McpElicitationRequests";
import { McpModeInspection } from "./McpModeInspection";

const PAGE_SIZE = 20;
const connectionLabel: Record<McpServerRecord["status"], string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  error: "Connection error",
};
export function McpServersSettings({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({ queryKey: ["settings", "mcp-servers"], queryFn: fetchMcpServers });
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false),
    [inspecting, setInspecting] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const items = query.data?.items;
  const ready =
    !query.isError &&
    Array.isArray(items) &&
    items.every(
      (item) =>
        item &&
        typeof item.serverId === "string" &&
        item.serverId &&
        typeof item.label === "string" &&
        typeof item.enabled === "boolean" &&
        ["stdio", "http", "sse"].includes(item.transport),
    ) &&
    new Set(items.map((item) => item.serverId)).size === items.length;
  const action = useMcpEnabled({ workspaceId, available: ready && !query.isFetching, reload: () => query.refetch() });
  const filtered = ready
    ? items.filter((item) => `${item.label} ${item.transport}`.toLowerCase().includes(search.toLowerCase()))
    : [];
  const review = action.review;
  return (
    <section
      id="mcp-servers"
      aria-label="MCP server configuration"
      className="mt-4 space-y-4 border-t border-line-subtle pt-4"
    >
      <header>
        <h3 className="font-display text-md font-semibold text-fg">MCP servers</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Review installation-wide saved server configuration. Enabling a server does not connect it or grant permission
          to call its tools.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={query.isFetching || action.checking} onClick={() => void query.refetch()}>
          Refresh MCP servers
        </Button>
        <Button
          size="sm"
          disabled={!ready || query.isFetching || action.checking}
          onClick={() => {
            action.cancel();
            setCreating(true);
          }}
        >
          Register MCP server
        </Button>
        <ClassicOwnerLink href="/settings/mcp?shell=classic" scope={workspaceId} label="Server setup and diagnostics" />
        <Button size="sm" onClick={() => setPreviewing(true)}>Inspect MCP installation previews</Button>
      </div>
      {query.isPending ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading MCP servers…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          MCP servers unavailable: {describeApiError(query.error).summary}
        </p>
      ) : null}
      {!query.isPending && !query.isError && !ready ? (
        <p role="alert" className="text-sm text-status-failed">
          MCP server directory evidence is incomplete. Refresh before editing.
        </p>
      ) : null}
      {action.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {action.notice}
        </p>
      ) : null}
      {ready ? (
        <>
          <label className="block text-sm text-fg-secondary">
            Search MCP servers
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
            Showing {Math.min(limit, filtered.length)} of {filtered.length} loaded servers.
          </p>
          <ul className="space-y-2">
            {filtered.slice(0, limit).map((server) => (
              <McpServerRow
                key={server.serverId}
                server={server}
                workspaceId={workspaceId}
                disabled={query.isFetching || action.checking}
                onInspect={() => setInspecting(server.serverId)}
                onReview={() => void action.requestReview(server)}
                onEdit={() => {
                  action.cancel();
                  setEditing(server.serverId);
                }}
              />
            ))}
          </ul>
          {!filtered.length ? <p className="text-sm text-fg-muted">No MCP servers match this view.</p> : null}
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Show more servers
            </Button>
          ) : null}
        </>
      ) : null}
      <ConfirmModal
        open={Boolean(review)}
        title="Change saved MCP server state?"
        confirmLabel="Apply reviewed MCP state"
        cancelLabel="Keep current MCP state"
        danger
        confirmDisabled={!ready || query.isFetching || action.attempt.locked || action.checking}
        onConfirm={() => void action.confirm()}
        onCancel={action.cancel}
        message={
          review
            ? `${review.server.label}: ${review.server.enabled ? "Enabled" : "Disabled"} → ${review.enabled ? "Enabled" : "Disabled"}. This changes the saved configuration for the whole installation and closes current connections owned by this server. Future use remains subject to Gateway policy, approvals, authentication, and transport checks. ${review.server.packChange ? "Saving also clears this server's existing pack ownership marker. " : ""}Connectivity and tool-call permission are not established by this change.`
            : ""
        }
      />
      {editing ? (
        <McpServerEditor
          key={`edit:${workspaceId}:${editing}`}
          workspaceId={workspaceId}
          serverId={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {creating ? (
        <McpServerCreate key={`create:${workspaceId}`} workspaceId={workspaceId} onClose={() => setCreating(false)} />
      ) : null}
      {inspecting ? (
        <McpServerInspection
          key={`inspection:${workspaceId}:${inspecting}`}
          serverId={inspecting}
          workspaceId={workspaceId}
          onClose={() => setInspecting(null)}
        />
      ) : null}
      <McpElicitationRequests key={`elicitation:${workspaceId}`} workspaceId={workspaceId} />
      {previewing ? <McpModeInspection key={`mode:${workspaceId}`} workspaceId={workspaceId} onClose={() => setPreviewing(false)} /> : null}
    </section>
  );
}
function McpServerRow({
  workspaceId,
  server,
  disabled,
  onReview,
  onEdit,
  onInspect,
}: {
  workspaceId: string;
  server: McpServerRecord;
  disabled: boolean;
  onReview: () => void;
  onEdit: () => void;
  onInspect: () => void;
}) {
  const attempt = useMcpServerMutation(server.serverId);
  const blocked = mcpToggleUnavailableReason(server);
  return (
    <li className="rounded-md border border-line bg-sunken p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-sm font-semibold text-fg">{server.label}</h4>
          <p className="mt-1 text-sm text-fg-secondary">Saved state: {server.enabled ? "Enabled" : "Disabled"}</p>
          <p className="mt-1 text-xs text-fg-muted">
            {server.transport === "stdio" ? "Local process transport" : "Remote transport"} · Last connection state:{" "}
            {connectionLabel[server.status] ?? "Unavailable"}
          </p>
        </div>
        <Button
          size="sm"
          disabled={disabled || attempt.locked || Boolean(blocked)}
          aria-label={`Review ${server.enabled ? "disable" : "enable"} ${server.label}`}
          onClick={onReview}
        >
          {server.enabled ? "Review disable" : "Review enable"}
        </Button>
        <Button size="sm" disabled={disabled} aria-label={`Inspect ${server.label}`} onClick={onInspect}>
          Inspect tools and transport
        </Button>
        <McpDeleteControl workspaceId={workspaceId} server={server} available={!disabled} />
        <Button
          size="sm"
          disabled={disabled || attempt.locked || !hasMcpServerBinding(server) || isGatewayMcpServer(server)}
          aria-label={`Edit ${server.label}`}
          onClick={onEdit}
        >
          Edit configuration
        </Button>
      </div>
      {blocked ? <p className="mt-2 text-xs text-fg-muted">{blocked}</p> : null}
      {attempt.locked ? (
        <p role="status" className="mt-2 text-sm text-status-waiting">
          {attempt.message ?? "Waiting for the Gateway server owner…"}
        </p>
      ) : null}
      <details className="mt-2 text-xs text-fg-muted">
        <summary className="cursor-pointer">Saved server details</summary>
        <dl className="mt-2 space-y-1">
          <dt>Server ID</dt>
          <dd className="break-all font-mono">{server.serverId}</dd>
          <dt>Configuration revision</dt>
          <dd className="break-all font-mono">
            {server.revision || "Not provided; configuration editing is unavailable"}
          </dd>
          <dt>Authentication</dt>
          <dd>
            {server.authType === "none"
              ? "No credentials configured"
              : server.authType === "oauth2"
                ? "OAuth"
                : "Token"}
          </dd>
        </dl>
      </details>
    </li>
  );
}
