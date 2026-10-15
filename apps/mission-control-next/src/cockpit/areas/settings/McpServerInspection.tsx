import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchSettings, fetchMcpServerTestEvidence } from "@goatcitadel/mission-control-shared/api/client";
import { inspectMcpServer } from "../../../features/native-routes/settings/mcp-server-inspection";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../data/record-view";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { McpConfigurationReport } from "../../../features/native-routes/settings/McpConfigurationReport";
import { McpConnectionControls } from "../../../features/native-routes/settings/McpConnectionControls";
import { McpOAuthControls } from "../../../features/native-routes/settings/McpOAuthControls";
import { McpSetupProgress } from "./McpSetupProgress";

const readable = (value: string | undefined) => value?.replaceAll("_", " ") ?? "Unavailable";
export function McpServerInspection({
  serverId,
  workspaceId,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(30);
  const query = useQuery({
    queryKey: ["settings", "mcp-inspection", serverId],
    queryFn: () => inspectMcpServer(serverId),
    retry: false,
  });
  const settings = useQuery({
    queryKey: ["system", "managed-runtime-settings"],
    queryFn: fetchSettings,
    retry: false,
  });
  const testEvidence = useQuery({
    queryKey: [
      "settings",
      "mcp-test-evidence",
      workspaceId,
      serverId,
      query.data?.server.revision,
      query.data?.server.connectionRevision,
    ],
    queryFn: () => fetchMcpServerTestEvidence(serverId, workspaceId),
    enabled: Boolean(query.data),
    retry: false,
  });
  const refreshConnectionEvidence = () =>
    Promise.all([
      query.refetch(),
      testEvidence.refetch(),
      queryClient.invalidateQueries({ queryKey: ["settings", "mcp-servers"] }),
    ]);
  // The last inspection (and any open review in its controls) stays while it is read again.
  const view = recordView(query);
  const evidenceView = recordView(testEvidence);
  const availabilityView = recordView(settings, (value) => value.chatFeatureAvailability?.staticMcp);
  const data = view.record;
  const checking = view.phase === "checking";
  const lastVersion = lastVersionNote(view);
  const inspectionStale = view.stale || query.isError;
  const setupStale =
    inspectionStale || evidenceView.stale || availabilityView.stale || testEvidence.isError || settings.isError;
  return (
    <Sheet
      open
      sideOnDesktop
      title="MCP server inspection"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="space-y-4 text-sm text-fg-secondary">
        <p>
          Installation-wide saved metadata and cached tools. Opening this inspection does not connect a server, test its
          transport or invoke a tool. Actions below require an explicit review.
        </p>
        <Button disabled={query.isFetching} onClick={() => void refreshConnectionEvidence()}>
          Refresh MCP inspection
        </Button>
        {view.phase === "loading" ? (
          <p role="status">Reading current server and cached inventory…</p>
        ) : checking ? (
          <p role="status">{CHECKING_FOR_CHANGES}</p>
        ) : null}
        {query.isError ? (
          <p role="alert" className="text-status-failed">
            {describeApiError(query.error).summary}
            {lastVersion ? ` ${lastVersion}` : ""}
          </p>
        ) : null}
        {evidenceView.phase === "checking" || availabilityView.phase === "checking" ? (
          <p role="status">Checking test evidence and Chat availability for changes…</p>
        ) : null}
        {testEvidence.isError ? (
          <p role="alert" className="text-status-failed">
            Could not refresh retained test evidence. Refresh before relying on the last recorded result.
          </p>
        ) : null}
        {settings.isError ? (
          <p role="alert" className="text-status-failed">
            Could not refresh Chat availability. Refresh before relying on the last recorded status.
          </p>
        ) : null}
        {data ? (
          <>
            <h4 className="text-base font-semibold text-fg">{data.server.label}</h4>
            <McpSetupProgress
              key={`${workspaceId}:${data.server.serverId}:${data.server.revision}`}
              server={data.server}
              tools={data.tools}
              stale={setupStale}
              testEvidence={evidenceView.record}
              staticMcpAvailable={availabilityView.record}
              availabilityChecking={settings.isFetching}
              refreshAvailability={() => void settings.refetch()}
            />
            <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
              <dt>Server ID</dt>
              <dd>
                <code className="break-all font-mono">{data.server.serverId}</code>
              </dd>
              <dt>Saved revision</dt>
              <dd>
                <code className="break-all font-mono">{data.server.revision}</code>
              </dd>
              <dt>Saved state</dt>
              <dd>{data.server.enabled ? "Enabled" : "Disabled"}</dd>
              <dt>Last connection state</dt>
              <dd>{readable(data.server.status)}</dd>
              <dt>Transport</dt>
              <dd>{data.server.transport}</dd>
              <dt>Trust</dt>
              <dd>{readable(data.server.trustTier)}</dd>
              <dt>Authentication</dt>
              <dd>{readable(data.server.authState?.readiness ?? data.server.authType)}</dd>
            </dl>
            {data.issues.map((issue) => (
              <p key={issue} role="status" className="text-status-waiting">
                {issue}
              </p>
            ))}
            {data.remote ? (
              <section className="space-y-2" aria-label="Saved remote transport evidence">
                <h5 className="font-semibold text-fg">Remote transport evidence</h5>
                <p>
                  {readable(data.remote.posture)} · {readable(data.remote.invocationState)}
                </p>
                <p>{data.remote.operatorNextAction.slice(0, 2000)}</p>
                <ul className="list-inside list-disc">
                  {[...data.remote.blockers, ...data.remote.governance].slice(0, 30).map((note, index) => (
                    <li key={index}>{note.slice(0, 2000)}</li>
                  ))}
                </ul>
                <p className="text-xs text-fg-muted">
                  Showing up to 30 recorded transport notes. Tool permission is evaluated by the Gateway for each actual
                  request.
                </p>
              </section>
            ) : null}
            <section className="space-y-2" aria-label="Cached MCP tools">
              <h5 className="font-semibold text-fg">Cached tool inventory</h5>
              <p>Descriptors reflect the retained inventory, not a live connectivity check or permission to invoke.</p>
              {data.tools ? (
                <>
                  <p className="text-xs text-fg-muted">
                    Showing {Math.min(limit, data.tools.length)} of {data.tools.length} cached descriptors.
                  </p>
                  {!data.tools.length ? <p>No cached tools are recorded for this server.</p> : null}
                  <ul className="space-y-2">
                    {data.tools.slice(0, limit).map((tool) => (
                      <li key={tool.toolName} className="rounded-md border border-line p-3">
                        <code className="break-all font-mono text-fg">{tool.toolName}</code>
                        <p>{tool.enabled ? "Descriptor enabled" : "Descriptor disabled"}</p>
                        <p className="break-words">{tool.description?.slice(0, 2000) || "Description not recorded."}</p>
                        <p className="text-xs text-fg-muted">Recorded update: {tool.updatedAt || "Unavailable"}</p>
                      </li>
                    ))}
                  </ul>
                  {data.tools.length > limit ? (
                    <Button onClick={() => setLimit((value) => value + 30)}>Show more cached tools</Button>
                  ) : null}
                </>
              ) : (
                <p>Cached tools could not be verified.</p>
              )}
            </section>
            <McpConfigurationReport
              server={data.server}
              scope={workspaceId}
              button={(label, click, disabled) => (
                <Button size="sm" onClick={click} disabled={disabled || inspectionStale}>
                  {label}
                </Button>
              )}
            />
            <McpConnectionControls
              server={data.server}
              scope={workspaceId}
              onSettled={refreshConnectionEvidence}
              button={(label, click, disabled) => (
                <Button size="sm" onClick={click} disabled={disabled || inspectionStale}>
                  {label}
                </Button>
              )}
            />
            <McpOAuthControls
              server={data.server}
              scope={workspaceId}
              onSettled={refreshConnectionEvidence}
              button={(label, click, disabled) => (
                <Button size="sm" onClick={click} disabled={disabled || inspectionStale}>
                  {label}
                </Button>
              )}
            />
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
