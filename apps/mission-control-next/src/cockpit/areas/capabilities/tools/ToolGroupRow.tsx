import type { CapabilityToolGroupItem, ToolGroupId } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../../ui/Button";
import { RiskBadge } from "../../../ui/RiskBadge";
import { LetterIcon } from "../LetterIcon";
import { GroupSwitchControl } from "./GroupSwitchControl";
import { presentGroupBlockLines } from "./tool-view";

export interface ToolGroupViewProps {
  /** The live row from the cached list. */
  group: CapabilityToolGroupItem;
  /** The calls line, already worded (`presentGroupCalls`). */
  calls: string;
  /** The Settings revision the list was read at. */
  settingsRevision: number;
  /** Opens the group's panel. */
  onOpen: (groupId: ToolGroupId) => void;
}

/**
 * One tool group as a row card: its letter icon, name and tool count, its risk and calls, what blocks it, and its
 * switch. The button opens the group's panel through `onOpen`; the row itself is not a click target, because the
 * switch sits inside it. Core has no switch, so its row says why in its own words.
 */
export function ToolGroupRow({ group, calls, settingsRevision, onOpen }: ToolGroupViewProps) {
  const lines = presentGroupBlockLines(group);
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-lg border border-line-subtle bg-raised p-3">
      <LetterIcon name={group.label} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 className="min-w-0 truncate text-base font-semibold text-fg">{group.label}</h3>
          <span className="shrink-0 text-xs text-fg-muted">{plural(group.tools.length, "tool")}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <RiskBadge risk={group.risk} />
          <span className="text-sm text-fg-secondary">{calls}</span>
        </div>
        {group.state === "always_on" ? <p className="mt-1.5 text-sm text-fg-secondary">{group.description}</p> : null}
        {lines.map((line) => (
          <p key={line} className="mt-1 text-sm text-fg-secondary">
            {line}
          </p>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <GroupSwitchControl group={group} settingsRevision={settingsRevision} switchLabel={group.label} />
        {/* The name comes last so the accessible name starts with the visible word. */}
        <Button size="sm" aria-label={`View ${group.label}`} onClick={() => onOpen(group.groupId)}>
          View
        </Button>
      </div>
    </li>
  );
}
