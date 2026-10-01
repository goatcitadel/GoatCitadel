import { useCallback, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpServer } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useMcpEditor } from "../../../features/native-routes/settings/use-mcp-editor";
import { isRuntimeInvokableMcpServer } from "../../../features/native-routes/settings/helpers/mcp-helpers";
import { hasMcpServerBinding } from "../../../features/native-routes/settings/mcp-server-mutation";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { McpDraftLeave } from "./McpDraftLeave";
import { McpPolicyFields, McpPolicySummary } from "../../../features/native-routes/settings/McpPolicyFields";

const fieldClass =
  "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-fg disabled:opacity-60";
const categories: McpServerRecord["category"][] = [
  "development",
  "browser",
  "automation",
  "research",
  "data",
  "creative",
  "orchestration",
  "other",
];

/** Saved configuration only. Connecting, credentials and tool execution remain separate owner actions. */
export function McpServerEditor({
  workspaceId,
  serverId,
  onClose,
}: {
  workspaceId: string;
  serverId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const key = ["settings", "mcp-server-editor", serverId];
  const query = useQuery({ queryKey: key, queryFn: () => fetchMcpServer(serverId), retry: false });
  const server = query.data?.serverId === serverId && hasMcpServerBinding(query.data) ? query.data : null;
  const available = Boolean(server && !query.isError && !query.isFetching);
  const applyServer = useCallback(
    (id: string, current: McpServerRecord | null) => {
      client.setQueryData(["settings", "mcp-server-editor", id], current);
      client.setQueryData<{ items: McpServerRecord[] }>(["settings", "mcp-servers"], (previous) =>
        !previous
          ? previous
          : {
              items: current
                ? previous.items.map((item) => (item.serverId === id ? current : item))
                : previous.items.filter((item) => item.serverId !== id),
            },
      );
    },
    [client],
  );
  const control = useMcpEditor({
    workspaceId,
    serverId,
    server,
    active: true,
    available,
    runtimeReady: Boolean(server && isRuntimeInvokableMcpServer(server)),
    applyServer,
    onSaveRequest: null,
  });
  const leave = useDraftLeave();
  const close = () => leave.request(onClose, [control.draft.key]);
  const draft = control.draft.value;
  const [reviewed, setReviewed] = useState<string | null>(null);
  const reviewIdentity = canonicalJsonString([server?.revision ?? null, control.draft.baseRevision ?? null, draft]);
  const canSave = control.canSave && control.draft.isDirty;
  const fieldDisabled = !available || control.gatewayOwned || control.mutation.locked || Boolean(reviewed);
  const labelId = useId();
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Edit saved MCP server"
        description="Changes apply to the whole Gateway installation and close this server's current connections. Saving does not connect the server or grant tool permission."
      >
        <div className="space-y-3 text-sm text-fg-secondary">
          {query.isFetching ? <p role="status">Reading current server configuration…</p> : null}
          {query.isError ? (
            <p role="alert" className="text-status-failed">
              {describeApiError(query.error).summary}
            </p>
          ) : null}
          {!query.isFetching && !server ? (
            <p role="alert">
              Current editable server evidence is unavailable. Your retained draft has not been discarded.
            </p>
          ) : null}
          {control.notice ? (
            <p role={control.notice.tone === "error" ? "alert" : "status"}>{control.notice.message}</p>
          ) : null}
          {control.mutation.locked ? (
            <p role="status">{control.mutation.message ?? "Waiting for the Gateway server owner…"}</p>
          ) : null}
          {control.draft.isDirty ? (
            <p role="status" className="text-status-waiting">
              Unsaved MCP server draft
            </p>
          ) : null}
          {control.gatewayOwned ? (
            <p>This server is managed by the Gateway. Configuration editing is unavailable.</p>
          ) : null}
          {control.requiresReview ? (
            <section
              aria-label="Current MCP server review"
              className="space-y-2 rounded-md border border-line bg-raised p-3"
            >
              <p>Saved configuration changed. Inspect it before applying your retained draft.</p>
              {control.review.loading ? <p role="status">Reading current server…</p> : null}
              {control.review.error ? <p role="alert">{control.review.error}</p> : null}
              {server && !control.review.loading && !control.review.error ? (
                <>
                  <dl className="space-y-1">
                    <dt>Current label</dt>
                    <dd>{server.label}</dd>
                    <dt>Current command or URL</dt>
                    <dd>
                      <code className="break-all font-mono">{server.command || server.url || "None"}</code>
                    </dd>
                    <dt>Current saved state</dt>
                    <dd>
                      {server.enabled ? "Enabled" : "Disabled"} · {server.category}
                    </dd>
                    <dt>Trust and authentication</dt>
                    <dd>
                      {server.trustTier} · {server.authType}
                    </dd>
                  </dl>
                  <McpPolicySummary args={server.args ?? []} policy={server.policy} />
                  <Button size="sm" onClick={control.acceptReview}>
                    Use current server review
                  </Button>
                </>
              ) : (
                <Button size="sm" disabled={control.review.loading} onClick={() => void control.review.refresh()}>
                  Reload server review
                </Button>
              )}
            </section>
          ) : null}
          <fieldset disabled={fieldDisabled} className="min-w-0 space-y-3">
            <legend className="sr-only">Saved server fields</legend>
            <label className="block" htmlFor={`${labelId}-label`}>
              Label
            </label>
            <input
              id={`${labelId}-label`}
              className={fieldClass}
              value={draft.label}
              onChange={(event) => control.draft.setValue((value) => ({ ...value, label: event.target.value }))}
            />
            <label className="block" htmlFor={`${labelId}-category`}>
              Category
            </label>
            <select
              id={`${labelId}-category`}
              className={fieldClass}
              value={draft.category}
              onChange={(event) =>
                control.draft.setValue((value) => ({
                  ...value,
                  category: event.target.value as McpServerRecord["category"],
                }))
              }
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category.charAt(0).toUpperCase() + category.slice(1)}
                </option>
              ))}
            </select>
            <label className="block" htmlFor={`${labelId}-endpoint`}>
              {server?.transport === "stdio" ? "Command" : "Server URL"}
            </label>
            <input
              id={`${labelId}-endpoint`}
              className={`${fieldClass} font-mono`}
              value={server?.transport === "stdio" ? draft.command : draft.url}
              onChange={(event) =>
                control.draft.setValue((value) => ({
                  ...value,
                  [server?.transport === "stdio" ? "command" : "url"]: event.target.value,
                }))
              }
            />
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={!server || !isRuntimeInvokableMcpServer(server)}
                onChange={(event) => control.draft.setValue((value) => ({ ...value, enabled: event.target.checked }))}
              />
              Enabled
            </label>
            <McpPolicyFields
              value={draft}
              onChange={control.draft.setValue}
              stdio={server?.transport === "stdio"}
              fieldClass={`${fieldClass} py-2`}
              className="space-y-3"
            />
          </fieldset>
          {server && !isRuntimeInvokableMcpServer(server) ? (
            <p>
              Configured for visibility only until transport, address, auth and trust are runtime-supported. This save
              keeps it disabled.
            </p>
          ) : null}
          {server?.packChange ? <p>Saving clears this server's existing pack ownership marker.</p> : null}
          <p>Credentials and trust remain with their existing owners. This form does not edit them.</p>
          <details>
            <summary>Reviewed server identity</summary>
            <code className="block break-all font-mono">
              {serverId} · {server?.revision || "Revision unavailable"}
            </code>
          </details>
          {reviewed ? (
            <section
              aria-label="Review MCP server changes"
              className="space-y-2 rounded-md border border-line bg-raised p-3"
            >
              <p>
                Save these fields for <strong className="text-fg">{server?.label}</strong> and close its current
                connections?
              </p>
              <dl>
                <dt>New label</dt>
                <dd>{draft.label || server?.label}</dd>
                <dt>New command or URL</dt>
                <dd>
                  <code className="break-all font-mono">
                    {server?.transport === "stdio" ? draft.command : draft.url}
                  </code>
                </dd>
                <dt>Saved state</dt>
                <dd>
                  {server && isRuntimeInvokableMcpServer(server) && draft.enabled ? "Enabled" : "Disabled"} ·{" "}
                  {draft.category}
                </dd>
              </dl>
              <McpPolicySummary args={draft.args} policy={draft.policy} />
              {reviewed !== reviewIdentity ? (
                <p role="alert">The review changed. Cancel and review the current fields.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!canSave || reviewed !== reviewIdentity}
                  onClick={() => {
                    setReviewed(null);
                    void control.save();
                  }}
                >
                  Save reviewed MCP configuration
                </Button>
                <Button onClick={() => setReviewed(null)}>Cancel review</Button>
              </div>
            </section>
          ) : (
            <Button variant="primary" disabled={!canSave} onClick={() => setReviewed(reviewIdentity)}>
              Review MCP changes
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={query.isFetching || control.mutation.pending}
              onClick={() => {
                setReviewed(null);
                void control.review.refresh();
              }}
            >
              Refresh saved server
            </Button>
            <Button onClick={close}>Close editor</Button>
          </div>
        </div>
      </Dialog>
      <McpDraftLeave {...leave.dialogProps} />
    </>
  );
}
