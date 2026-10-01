import { useState } from "react";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { FirstRunDefaults } from "./FirstRunDefaults";
import { FirstRunDemo } from "./FirstRunDemo";
import { FirstRunVerification } from "./FirstRunVerification";
import { McpDraftLeave } from "./McpDraftLeave";

export function FirstRunAdvanced({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false),
    leave = useDraftLeave();
  return (
    <section aria-label="Advanced setup" className="grid gap-4 border-t border-line-subtle pt-4">
      <div>
        <Button
          aria-expanded={open}
          aria-controls="first-run-advanced-panels"
          onClick={() => leave.request(() => setOpen(!open))}
        >
          Advanced setup and evidence
        </Button>
        <p className="mt-2 text-xs text-fg-muted">
          Optional bootstrap defaults, inspectable demo records, and detailed verification checks.
        </p>
      </div>
      {open ? (
        <div id="first-run-advanced-panels" className="grid gap-4">
          <FirstRunDefaults workspaceId={workspaceId} />
          <FirstRunDemo workspaceId={workspaceId} />
          <FirstRunVerification />
        </div>
      ) : null}
      <McpDraftLeave {...leave.dialogProps} />
    </section>
  );
}
