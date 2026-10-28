import type { CapabilityToolGroupItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Section } from "../../../ui/Section";
import { LetterIcon } from "../LetterIcon";
import { GroupSwitchControl } from "./GroupSwitchControl";
import type { ToolGroupViewProps } from "./ToolGroupRow";

function MostUsedCard({ group, calls, settingsRevision, onOpen }: ToolGroupViewProps) {
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-line-subtle bg-raised p-3">
      <div className="flex min-w-0 items-center gap-2">
        <LetterIcon name={group.label} className="size-8 text-base" />
        <h3 className="min-w-0 truncate text-base font-semibold text-fg">{group.label}</h3>
      </div>
      <p className="text-sm text-fg-secondary">{calls}</p>
      {/* The group's row in the list names its switch by the label alone; this one adds where it sits. */}
      <GroupSwitchControl
        group={group}
        settingsRevision={settingsRevision}
        switchLabel={`${group.label}, most used`}
        announce={false}
      />
      <Button size="sm" aria-label={`View ${group.label}, most used`} onClick={() => onOpen(group.groupId)}>
        View
      </Button>
    </li>
  );
}

/**
 * The row of up to four cards above the list: the groups the AI called most, or the starter set ("Essentials")
 * before four have been called. The Gateway picks them; this row only shows them. A card's button opens the group's
 * panel, as the row's does.
 */
export function MostUsedRow({
  heading,
  groups,
  callsFor,
  settingsRevision,
  onOpen,
}: {
  heading: "Most used" | "Essentials";
  groups: readonly CapabilityToolGroupItem[];
  callsFor: (group: CapabilityToolGroupItem) => string;
  settingsRevision: number;
  onOpen: ToolGroupViewProps["onOpen"];
}) {
  return (
    <Section title={heading}>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {groups.map((group) => (
          <MostUsedCard
            key={group.groupId}
            group={group}
            calls={callsFor(group)}
            settingsRevision={settingsRevision}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </Section>
  );
}
