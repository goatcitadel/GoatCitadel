import { useQueryClient } from "@tanstack/react-query";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { useMcpDeletion } from "../../../features/native-routes/settings/use-mcp-deletion";
import { hasMcpServerBinding, isGatewayMcpServer } from "../../../features/native-routes/settings/mcp-server-mutation";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

export function McpDeleteControl({
  workspaceId,
  server,
  available,
}: {
  workspaceId: string;
  server: McpServerRecord;
  available: boolean;
}) {
  const client = useQueryClient();
  const control = useMcpDeletion({
    workspaceId,
    server,
    available,
    onConflict: () => client.invalidateQueries({ queryKey: ["settings", "mcp-servers"] }),
    onDeleted: (id) => {
      client.setQueryData<{ items: McpServerRecord[] }>(["settings", "mcp-servers"], (previous) =>
        previous ? { items: previous.items.filter((item) => item.serverId !== id) } : previous,
      );
      client.removeQueries({ queryKey: ["settings", "mcp-server-editor", id] });
    },
  });
  return (
    <>
      <Button
        size="sm"
        variant="danger"
        aria-label={`Review delete ${server.label}`}
        disabled={!available || !hasMcpServerBinding(server) || isGatewayMcpServer(server) || control.mutation.locked}
        onClick={control.requestReview}
      >
        Review delete
      </Button>
      {control.notice ? (
        <p role={control.notice.tone === "error" ? "alert" : "status"} className="w-full text-xs text-fg-secondary">
          {control.notice.message}
        </p>
      ) : null}
      <Dialog
        open={Boolean(control.review)}
        onOpenChange={(open) => {
          if (!open) control.cancel();
        }}
        title="Delete saved MCP server"
        description="This removes the server configuration for the whole Gateway installation."
      >
        {control.review ? (
          <div className="space-y-3 text-sm text-fg-secondary">
            <p className="font-semibold text-fg">{control.review.label}</p>
            <p>
              Saved configuration, credentials, cached tools and this workspace’s retained edit draft will be removed.
              Current connections close. This cannot be undone here.
            </p>
            <dl>
              <dt>Server ID</dt>
              <dd>
                <code className="break-all font-mono">{control.review.serverId}</code>
              </dd>
              <dt>Reviewed revision</dt>
              <dd>
                <code className="break-all font-mono">{control.review.revision}</code>
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" disabled={control.mutation.pending} onClick={() => void control.confirm()}>
                Delete reviewed MCP server
              </Button>
              <Button disabled={control.mutation.phase === "saving"} onClick={control.cancel}>
                Keep MCP server
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
