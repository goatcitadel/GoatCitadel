import { useState } from "react";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { FirstRunDefaults } from "./FirstRunDefaults";
import { FirstRunDemo } from "./FirstRunDemo";
import { McpDraftLeave } from "./McpDraftLeave";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

export function FirstRunAdvanced({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false),
    leave = useDraftLeave();
  const [demoOpen, setDemoOpen] = useState(false);
  return (
    <section aria-label="Optional setup" className="grid gap-4 border-t border-line-subtle pt-4">
      <div>
        <Button aria-expanded={demoOpen} aria-controls="first-run-sample"
          onClick={() => leave.request(() => setDemoOpen(!demoOpen))}>Explore sample records</Button>
        <p className="mt-2 text-xs text-fg-muted">Review the local demo before preparing records. Opening these controls changes no data.</p>
      </div>
      {demoOpen ? <div id="first-run-sample"><FirstRunDemo workspaceId={workspaceId} /></div> : null}
      <div>
        <Button
          aria-expanded={open}
          aria-controls="first-run-advanced-panels"
          onClick={() => leave.request(() => setOpen(!open))}
        >
          Optional bootstrap defaults
        </Button>
        <p className="mt-2 text-xs text-fg-muted">
          Review optional defaults only if you want to change your installation settings.
        </p>
      </div>
      {open ? (
        <div id="first-run-advanced-panels" className="grid gap-4">
          <FirstRunDefaults workspaceId={workspaceId} />
        </div>
      ) : null}
      <NativeOwnerLink href="/system/diagnostics" scope={workspaceId} className="text-sm font-medium text-accent hover:underline">
        Inspect setup and release verification in System diagnostics
      </NativeOwnerLink>
      <McpDraftLeave {...leave.dialogProps} />
    </section>
  );
}
