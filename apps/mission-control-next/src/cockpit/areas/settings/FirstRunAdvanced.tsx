import { useState } from "react";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { FirstRunDefaults } from "./FirstRunDefaults";
import { McpDraftLeave } from "./McpDraftLeave";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

/** Optional installation defaults and the diagnostics link, below the setup steps. The demo is a step 1 choice. */
export function FirstRunAdvanced({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false),
    leave = useDraftLeave();
  return (
    <section aria-label="Optional setup" className="grid gap-4 border-t border-line-subtle pt-4">
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
      <NativeOwnerLink
        href="/system/diagnostics"
        scope={workspaceId}
        className="text-sm font-medium text-accent hover:underline"
      >
        Open setup and release checks in System diagnostics
      </NativeOwnerLink>
      <McpDraftLeave {...leave.dialogProps} />
    </section>
  );
}
