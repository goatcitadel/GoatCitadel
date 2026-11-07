import { lazy } from "react";
import { Button } from "../../ui/Button";
import { DeferredChatLeaf } from "./DeferredChatLeaves";
import type { RunVariablesPanel } from "./ChatRunVariableFields";

const Fields = lazy(async () => ({ default: (await import("./ChatRunVariableFields")).ChatRunVariableFields }));

export function ChatRunVariables({ panel }: { panel: RunVariablesPanel | undefined }) {
  if (!panel?.open) return null;
  return (
    <section
      aria-label="Run variables"
      className="mb-2 max-h-64 overflow-y-auto rounded-md border border-line bg-sunken p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">{panel.title}</h2>
        <Button size="sm" onClick={panel.onClose}>
          Close
        </Button>
      </div>
      <DeferredChatLeaf label="Run variables" identity={panel.title}>
        <Fields panel={panel} />
      </DeferredChatLeaf>
    </section>
  );
}
