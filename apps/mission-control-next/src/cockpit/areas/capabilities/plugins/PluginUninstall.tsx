import { useState } from "react";
import type { CapabilityPluginDetail } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import { uninstallConfirmLines } from "./plugin-uninstall-view";
import { usePluginUninstall } from "./use-plugin-uninstall";

/**
 * A plugin's Uninstall: the danger button, the confirmation that says what goes and what stays, the approvals it waits
 * on in place, GoatCitadel's own summary of each request, and "Finish uninstalling" while the plugin still reads as
 * uninstalling. It follows the plugin's detail until the plugin is gone; then the panel closes and focus goes back to
 * the plugins list.
 */
export function PluginUninstall({ detail }: { detail: CapabilityPluginDetail }) {
  const flow = usePluginUninstall(detail, detail.pluginId);
  const [confirming, setConfirming] = useState(false);
  const current = flow.detail ?? detail;
  const { entry, approval } = flow;
  const asking = entry?.phase === "asking";
  const uninstalling = current.state === "uninstalling";
  const confirm = () => {
    setConfirming(false);
    flow.start();
  };
  return (
    <div className="space-y-3">
      {approval ? (
        <SettingsApprovalDialog
          key={approval.approvalId}
          approvalId={approval.approvalId}
          workspaceId={current.workspaceId}
          title={approval.title}
          reviewLabel="Review the change"
          loadFailureHint="Reload to try again."
          onResolved={() => flow.resolved(approval.approvalId)}
        />
      ) : null}
      {entry?.summary && entry.phase !== "asking" ? <p className="text-fg">{entry.summary}</p> : null}
      {entry?.phase === "stopped" && entry.message && entry.message !== entry.summary ? (
        <p role="alert" className="text-status-failed">
          {entry.message}
        </p>
      ) : null}
      {uninstalling ? (
        // It goes on removing what the first pass left, so it is red like Uninstall; it asks no confirmation again.
        <Button variant="danger" loading={asking} loadingLabel="Asking…" onClick={flow.start}>
          Finish uninstalling
        </Button>
      ) : (
        <Button variant="danger" loading={asking} loadingLabel="Asking…" onClick={() => setConfirming(true)}>
          Uninstall
        </Button>
      )}
      <p role="status" className="text-fg">
        {flow.progress}
      </p>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Uninstall ${current.name}?`}
        description="This can't be undone here. Installing it again adds its pieces back."
      >
        <div className="space-y-3 text-sm text-fg-secondary">
          <ul className="space-y-1">
            {uninstallConfirmLines(current.pieces).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>Keep it</Button>
            <Button variant="danger" onClick={confirm}>{`Uninstall ${current.name}`}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
