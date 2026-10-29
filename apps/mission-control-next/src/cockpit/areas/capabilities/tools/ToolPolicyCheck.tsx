import { useState } from "react";
import type { CapabilityToolGroupItem } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { CapabilityPolicyInspector } from "../../library/CapabilityPolicyInspector";

const FIELD = "mt-1 w-full rounded-md border border-line-control bg-raised px-2 py-2 text-base text-fg";

/**
 * Library's tool policy inspector, for one tool of the open group: a select of the group's tools (the first one until
 * another is chosen) and the inspector for the chosen tool in the active workspace. It lives in the group panel's
 * Technical details, where Library's inspectors moved with the tool records. A group with no tools offers nothing.
 */
export function ToolPolicyCheck({ group }: { group: CapabilityToolGroupItem }) {
  const { activeWorkspaceId } = useUiPreferences();
  const [chosen, setChosen] = useState<string>();
  const toolName = group.tools.find((tool) => tool.toolName === chosen)?.toolName ?? group.tools[0]?.toolName;
  if (!toolName) return null;
  return (
    <div className="mt-3 border-t border-line-subtle pt-3">
      <label className="block text-xs text-fg-muted">
        Check a tool&apos;s policy
        <select className={FIELD} value={toolName} onChange={(event) => setChosen(event.target.value)}>
          {group.tools.map((tool) => (
            <option key={tool.toolName} value={tool.toolName}>
              {tool.toolName}
            </option>
          ))}
        </select>
      </label>
      {/* A new workspace or tool starts a fresh check, never one carried over from the last. */}
      <CapabilityPolicyInspector
        key={JSON.stringify([activeWorkspaceId, toolName])}
        workspaceId={activeWorkspaceId}
        toolName={toolName}
      />
    </div>
  );
}
