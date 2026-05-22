import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import { NextCoworkPanel } from "./CoworkPanel";
import { NextCodeWorkbenchPanel } from "./CodeWorkbenchPanel";

export function ThreadedWorkflowPanel({ panel }: { panel: MissionThreadedWorkflowPanel }) {
  if (!panel) {
    return null;
  }
  return panel.kind === "cowork" ? <NextCoworkPanel panel={panel} /> : <NextCodeWorkbenchPanel panel={panel} />;
}

// Re-exports for consumers that imported helpers from the legacy single-file
// module. The shape mirrors what the original ThreadedWorkflowPanel.tsx
// exposed so test imports and the Context Drawer's shortId import continue to
// resolve without churn.
export {
  describeAgenticControlCopy,
  extractCodeBlocks,
  isPendingPatchBlock,
  shortId,
  validationStatusTone,
} from "./format";
