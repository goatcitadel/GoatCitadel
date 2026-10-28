import { useId } from "react";
import type { CapabilityToolGroupItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Section } from "../../../ui/Section";
import { LetterIcon } from "../LetterIcon";
import { GroupSwitch, GroupSwitchNotes, GroupSwitchState } from "./GroupSwitchParts";
import type { ToolGroupViewProps } from "./ToolGroupRow";

type MostUsedHeading = "Most used" | "Essentials";

function MostUsedCard({
  group,
  calls,
  settingsRevision,
  onOpen,
  heading,
}: ToolGroupViewProps & { heading: MostUsedHeading }) {
  const noteId = useId();
  // Named for the heading the card sits under, so "most used" is never said of a group that is only a starter pick.
  const where = `${group.label}, ${heading.toLowerCase()}`;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-line-subtle bg-raised p-3">
      <GroupSwitchState group={group} settingsRevision={settingsRevision}>
        {(control) => (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <LetterIcon name={group.label} className="size-8 text-base" />
              <h3 className="min-w-0 truncate text-base font-semibold text-fg">{group.label}</h3>
            </div>
            <p className="text-sm text-fg-secondary">{calls}</p>
            {/* The group's row in the list names its switch by the label alone; this one adds where it sits. */}
            <div>
              <GroupSwitch control={control} label={where} describedBy={noteId} />
            </div>
            {/* The card is narrow, so the lines wrap inside it. The row below announces them; the card only shows them. */}
            <GroupSwitchNotes group={group} control={control} id={noteId} announce={false} />
            <Button size="sm" aria-label={`View ${where}`} onClick={() => onOpen(group.groupId)}>
              View
            </Button>
          </>
        )}
      </GroupSwitchState>
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
  heading: MostUsedHeading;
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
            heading={heading}
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
