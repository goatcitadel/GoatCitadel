import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import { NextCodeWorkbenchPanel } from "../../../features/threaded-surface/workflow/CodeWorkbenchPanel";

export function ChatBuildEditor({ panel }: { panel: Extract<MissionThreadedWorkflowPanel, { kind: "code" }> }) {
  return <div className="cockpit-build-editor mc-next-threaded-side-panel code">
    <NextCodeWorkbenchPanel panel={panel} />
  </div>;
}
