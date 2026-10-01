import { useMcpModeEvidence } from "../../../features/native-routes/settings/use-mcp-mode-evidence";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { McpModePanels } from "./McpModePanels";

export function McpModeInspection({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const evidence = useMcpModeEvidence(workspaceId, true);
  return (
    <Sheet
      open
      sideOnDesktop
      title="MCP installation previews"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="space-y-4 text-sm text-fg-secondary">
        <p>
          Installation-wide Gateway projections, not filtered to the selected workspace. Opening or refreshing this view
          only reads evidence; it does not launch, connect, authorize or call a tool.
        </p>
        <p className="text-xs text-fg-muted">
          The two owners generate independent snapshots. Refresh to reread their current evidence.
        </p>
        <Button disabled={evidence.loading} onClick={() => void evidence.refresh()}>
          Refresh MCP previews
        </Button>
        {evidence.loading ? <p role="status">Reading MCP installation previews…</p> : null}
        {evidence.data ? <McpModePanels evidence={evidence.data} /> : null}
      </div>
    </Sheet>
  );
}
