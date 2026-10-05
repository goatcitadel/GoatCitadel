import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchMcpElicitations } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { McpElicitationResponseForm } from "../../../features/native-routes/settings/McpElicitationResponseForm";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../data/record-view";
import { Button } from "../../ui/Button";

export function McpElicitationRequests({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["settings", "mcp-requests", workspaceId],
    queryFn: () => fetchMcpElicitations({}),
    enabled: open,
    retry: false,
  });
  // The loaded list (and an open request) stays while it is read again.
  const view = recordView(query, (data) => (Array.isArray(data.items) ? data.items : undefined));
  const rows = view.record ?? [];
  const lastVersion = lastVersionNote(view);
  const scoped = rows.filter((item) => !item.owner.workspaceId || item.owner.workspaceId === workspaceId);
  const request = scoped.find((item) => item.elicitationId === selected);
  return (
    <section
      aria-label="MCP operator requests"
      className="space-y-3 border-t border-line pt-3 text-sm text-fg-secondary"
    >
      <h4 className="font-semibold text-fg">Operator requests</h4>
      <p>
        Inspect the Gateway's bounded elicitation list. Requests without a workspace are identified separately. This is
        not the approval inbox.
      </p>
      <Button
        onClick={() => {
          setOpen(true);
          if (open) void query.refetch();
        }}
        disabled={query.isFetching}
      >
        Inspect MCP requests
      </Button>
      {view.phase === "loading" ? (
        <p role="status">Reading MCP requests…</p>
      ) : view.phase === "checking" ? (
        <p role="status">{CHECKING_FOR_CHANGES}</p>
      ) : null}
      {query.isError ? (
        <p role="alert">
          {describeApiError(query.error).summary}
          {lastVersion ? ` ${lastVersion}` : ""}
        </p>
      ) : null}
      {open && view.record ? (
        <>
          <p>
            Showing up to 20 of {scoped.length} matching records in the loaded list. The Gateway returns at most 200
            records; this is not a complete history.
          </p>
          <ul className="space-y-2">
            {scoped.slice(0, 20).map((item) => (
              <li key={item.elicitationId} className="rounded-md border border-line p-3">
                <p>{item.prompt.text.slice(0, 180)}</p>
                <p>
                  {item.status} · {item.owner.workspaceId ? "Selected workspace" : "No workspace attached"}
                </p>
                <Button
                  size="sm"
                  aria-label={`Inspect MCP request ${item.elicitationId}`}
                  onClick={() => setSelected(item.elicitationId)}
                >
                  Inspect request
                </Button>
              </li>
            ))}
          </ul>
          {!scoped.length ? <p>No matching MCP requests are in the loaded list.</p> : null}
        </>
      ) : null}
      {request ? (
        <McpElicitationResponseForm
          key={request.elicitationId}
          request={request}
          workspaceId={workspaceId}
          onRecorded={() => {
            void query.refetch();
          }}
          className="space-y-3 rounded-md border border-line bg-sunken p-3"
          fieldClass="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 py-2 text-fg"
          button={(label, click, disabled) => (
            <Button size="sm" onClick={click} disabled={disabled}>
              {label}
            </Button>
          )}
        />
      ) : null}
    </section>
  );
}
