import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpTestAllowance, McpTestAllowanceStatus } from "@goatcitadel/contracts";
import { fetchChatSessions } from "@goatcitadel/mission-control-shared/api/client";
import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { formatClockTime } from "@goatcitadel/mission-control-shared/content/format";

const path = "/api/v1/settings/mcp-test-allowance";
const queryKey = ["settings", "mcp-test-allowance"];
const field = "mt-1 block min-h-11 w-full rounded-md border border-line-control bg-canvas px-2 text-sm text-fg";

export function McpTestAllowanceSettings() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const [open, setOpen] = useState(false);
  return (
    <details className="border-t border-line-subtle pt-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-semibold text-fg">Temporary read-only MCP allowance</summary>
      {open ? <AllowanceEditor key={workspaceId} workspaceId={workspaceId} /> : null}
    </details>
  );
}

function AllowanceEditor({ workspaceId }: { workspaceId: string }) {
  const [serverId, setServerId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const client = useQueryClient();
  const state = useQuery({
    queryKey,
    queryFn: () => request<McpTestAllowanceStatus>(path),
    retry: false,
    refetchInterval: (query) => (query.state.data?.allowance ? 5_000 : false),
  });
  const sessions = useQuery({
    queryKey: ["settings", "mcp-test-allowance-chats", workspaceId],
    queryFn: ({ signal }) =>
      fetchChatSessions({ workspaceId, scope: "mission", view: "active", limit: 50 }, { signal }),
    enabled: state.data?.available === true,
  });
  const candidate = state.data?.candidates.find((item) => item.serverId === serverId);
  const session = sessions.data?.items.find((item) => item.sessionId === sessionId);
  const active = state.data?.allowance;
  const save = useMutation({
    mutationFn: async () => {
      if (active) {
        await request(path + "/revoke", { method: "POST", body: JSON.stringify({ allowanceId: active.allowanceId }) });
        return;
      }
      if (candidate && session) {
        const { label: _label, ...selection } = candidate;
        await request<McpTestAllowance>(path, {
          method: "POST",
          body: JSON.stringify({ ...selection, workspaceId, sessionId }),
        });
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  const error = save.error ?? state.error ?? sessions.error;

  return (
    <div className="mt-3 space-y-3 text-sm text-fg-secondary">
      <p>Allow one connected local fixture tool in one Chat for five minutes. Each call still requires Approve once.</p>
      <p role="status" className={error || active ? "" : "sr-only"}>
        {error
          ? describeApiError(error, "Could not update the temporary MCP allowance.").summary
          : active
            ? `Active for ${active.toolName} until ${formatClockTime(active.expiresAt)}.`
            : save.isSuccess
              ? "Allowance ended."
              : ""}
      </p>
      {state.isPending ? <p aria-busy="true">Loading MCP test tools…</p> : null}
      {state.data?.available === false ? (
        <p>Available with local Token sign-in, Loopback bypass off, and the global MCP deny in place.</p>
      ) : null}
      {active ? (
        <div className="space-y-2">
          <p>
            In the selected Chat, ask Terra to use the read-only tool with selector{" "}
            <code className="break-all">
              mcp.{active.serverId}.{active.toolName}
            </code>
            .
          </p>
          <a
            className="text-accent underline"
            href={`/chat?shell=cockpit&workspaceId=${encodeURIComponent(active.workspaceId)}&sessionId=${encodeURIComponent(active.sessionId)}`}
          >
            Open test Chat
          </a>
          <div>
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              End allowance
            </Button>
          </div>
        </div>
      ) : (
        state.data?.available &&
        (state.data.candidates.length === 0 ? (
          <p>Connect a local HTTP MCP fixture with exactly one read-only tool and first-use approval enabled.</p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (candidate && session && !save.isPending) save.mutate();
            }}
          >
            <Field label="Read-only MCP tool">
              {(fieldProps) => (
                <select
                  {...fieldProps}
                  className={field}
                  value={serverId}
                  onChange={(event) => setServerId(event.target.value)}
                >
                  <option value="">Choose a connected fixture</option>
                  {state.data?.candidates.map((item) => (
                    <option key={item.serverId} value={item.serverId}>
                      {item.label} · {item.toolName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Chat in this workspace">
              {(fieldProps) => (
                <select
                  {...fieldProps}
                  className={field}
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                >
                  <option value="">{sessions.isPending ? "Loading Chats…" : "Choose a Chat"}</option>
                  {sessions.data?.items.map((item) => (
                    <option key={item.sessionId} value={item.sessionId}>
                      {item.title || "Untitled Chat"}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Button type="submit" size="sm" disabled={!candidate || !session || save.isPending}>
              Allow for five minutes
            </Button>
          </form>
        ))
      )}
    </div>
  );
}
