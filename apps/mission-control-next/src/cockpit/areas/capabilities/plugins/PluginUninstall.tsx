import { useState } from "react";
import type { CapabilityPluginDetail } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import type { PluginUninstallEntry } from "./plugin-uninstall-store";
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
      <UninstallOutcome entry={entry} />
      {current.state === "uninstalling" ? (
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
      <UninstallConfirmation
        detail={current}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => {
          setConfirming(false);
          flow.start();
        }}
      />
    </div>
  );
}

/**
 * What the last request came to: a stop is read out as one alert, in GoatCitadel's words; while the uninstall goes on,
 * its summary stands as a quiet line.
 */
function UninstallOutcome({ entry }: { entry: PluginUninstallEntry | undefined }) {
  if (!entry || entry.phase === "asking") return null;
  if (entry.phase === "stopped") {
    return (
      <p role="alert" className="text-status-failed">
        {entry.message ?? entry.summary}
      </p>
    );
  }
  return entry.summary ? <p className="text-fg">{entry.summary}</p> : null;
}

/** The confirmation: what goes, what stays, and that it can't be undone here. */
function UninstallConfirmation({
  detail,
  open,
  onOpenChange,
  onConfirm,
}: {
  detail: CapabilityPluginDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Uninstall ${detail.name}?`}
      description="This can't be undone here. Installing it again adds its pieces back."
    >
      <div className="space-y-3 text-sm text-fg-secondary">
        <ul className="space-y-1">
          {uninstallConfirmLines(detail.pieces).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Keep it</Button>
          <Button variant="danger" onClick={onConfirm}>{`Uninstall ${detail.name}`}</Button>
        </div>
      </div>
    </Dialog>
  );
}
