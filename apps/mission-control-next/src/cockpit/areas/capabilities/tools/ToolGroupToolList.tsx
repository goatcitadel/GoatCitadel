import type { CapabilityToolGroupItem, CapabilityToolItem, CapabilityToolUsageResponse } from "@goatcitadel/contracts";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { RiskBadge } from "../../../ui/RiskBadge";
import { toolLabel } from "./tool-labels";
import { toolBlockHref } from "./tool-links";
import { presentToolAsks, presentToolLastUse } from "./tool-view";

/**
 * One tool of the open group: its plain label, its risk, whether the AI asks first (or which rule blocks it, with the
 * way to that rule), and when it was last used. The label comes from the cockpit's own map, because the registry's
 * description is written for the model; that text is in the group's Technical details. The tool's name stands last in
 * the monospace slot the inspector keeps for IDs, so it never reads as part of the sentences.
 */
function ToolEntry({
  group,
  tool,
  usage,
}: {
  group: CapabilityToolGroupItem;
  tool: CapabilityToolItem;
  usage: CapabilityToolUsageResponse | undefined;
}) {
  const asks = presentToolAsks(group, tool);
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-sm text-fg">{toolLabel(tool.toolName)}</p>
        <RiskBadge risk={tool.risk} />
      </div>
      <p className="text-sm text-fg-secondary">
        {asks.text}
        {asks.block ? (
          <>
            {" "}
            <NativeOwnerLink
              scope={`${group.groupId}:${tool.toolName}`}
              href={toolBlockHref(asks.block, group.groupId)}
            >
              See the rule
            </NativeOwnerLink>
          </>
        ) : null}
      </p>
      <p className="text-xs text-fg-muted">{presentToolLastUse(usage, tool.toolName)}</p>
      <code className="block break-all font-mono text-xs text-fg-secondary">{tool.toolName}</code>
    </li>
  );
}

/**
 * "Tools in this group": the tools this install offers, in the order the Gateway listed them. `usage` is the last call
 * counts read; without them every tool's last use reads "Last use unknown" rather than "Not used yet".
 */
export function ToolGroupToolList({
  group,
  usage,
}: {
  group: CapabilityToolGroupItem;
  usage: CapabilityToolUsageResponse | undefined;
}) {
  if (group.tools.length === 0)
    return <p className="text-sm text-fg-muted">This install offers no tools in this group.</p>;
  return (
    <ul className="divide-y divide-line-subtle">
      {group.tools.map((tool) => (
        <ToolEntry key={tool.toolName} group={group} tool={tool} usage={usage} />
      ))}
    </ul>
  );
}
