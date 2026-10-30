import { useId, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CapabilityToolGroupItem, CapabilityToolUsageResponse, ToolGroupId } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { toolListQuery, toolUsageQuery } from "../../../data/capability-tools-query";
import { recordView } from "../../../data/record-view";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { RiskBadge } from "../../../ui/RiskBadge";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { GroupSwitch, GroupSwitchNotes, GroupSwitchState } from "./GroupSwitchParts";
import { ToolGroupToolList } from "./ToolGroupToolList";
import { ToolPolicyCheck } from "./ToolPolicyCheck";
import { TOOL_GROUP_NOTES } from "./tool-group-notes";
import { SAFETY_RULES_HREF } from "./tool-links";
import { presentGroupBlockLines, presentToolGroupState } from "./tool-view";

const NOT_LISTED = <p className="text-sm text-fg-muted">This tool group isn't in the list anymore.</p>;

/**
 * The switch with the sentences that explain it. The group's panel names it "Turn it on or off: Files", like a
 * connector's, so it never shares an accessible name with the group's row or its Most used card.
 */
function SwitchBlock({
  group,
  settingsRevision,
  announce,
}: {
  group: CapabilityToolGroupItem;
  settingsRevision: number;
  announce: boolean;
}) {
  const noteId = useId();
  const extraId = useId();
  const extra = TOOL_GROUP_NOTES[group.groupId];
  return (
    // One switch hook for this placement (the row and the card each have their own), all reading one shared state.
    <GroupSwitchState group={group} settingsRevision={settingsRevision}>
      {(control) =>
        control ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium text-fg">Turn it on or off</span>
              <GroupSwitch
                control={control}
                label={`Turn it on or off: ${group.label}`}
                describedBy={extra ? `${noteId} ${extraId}` : noteId}
              />
            </div>
            <GroupSwitchNotes group={group} control={control} id={noteId} announce={announce} />
            {extra ? (
              <p id={extraId} className="text-xs text-fg-secondary">
                {extra}
              </p>
            ) : null}
          </div>
        ) : null
      }
    </GroupSwitchState>
  );
}

function GroupDetails({
  group,
  settingsRevision,
  usage,
  announce,
}: {
  group: CapabilityToolGroupItem;
  settingsRevision: number;
  usage: CapabilityToolUsageResponse | undefined;
  announce: boolean;
}) {
  const lines = presentGroupBlockLines(group);
  return (
    <div className="space-y-4">
      {/* The inspector's title names the group, so the panel starts with its risk and state (P2-R44). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RiskBadge risk={group.risk} />
        <StatusBadge status={presentToolGroupState(group.state)} />
        {lines.map((line) => (
          <span key={line} className="text-sm text-fg-secondary">
            {line}
          </span>
        ))}
      </div>
      <p className="text-sm text-fg-secondary">{group.description}</p>
      <SwitchBlock group={group} settingsRevision={settingsRevision} announce={announce} />

      <Section title="Tools in this group" headingLevel={3}>
        <ToolGroupToolList group={group} usage={usage} />
      </Section>

      <NativeOwnerLink scope={group.groupId} href={SAFETY_RULES_HREF} className="text-sm">
        Detailed rules are in Settings › Safety
      </NativeOwnerLink>

      {/* The registry's description of each tool is written for the model, so it stays here with the tool's name. */}
      <TechnicalDetails>
        <dl className="space-y-2">
          <div>
            <dt className="text-xs text-fg-muted">Group</dt>
            <dd className="break-all font-mono text-xs text-fg-secondary">{group.groupId}</dd>
          </div>
          {group.tools.map((tool) => (
            <div key={tool.toolName}>
              <dt className="break-all font-mono text-xs text-fg-secondary">{tool.toolName}</dt>
              <dd className="text-xs text-fg-muted">{tool.description}</dd>
            </div>
          ))}
        </dl>
        <ToolPolicyCheck group={group} />
      </TechnicalDetails>
    </div>
  );
}

function ToolGroupPanelBody({ groupId, announce }: { groupId: ToolGroupId; announce: boolean }) {
  const { activeWorkspaceId } = useUiPreferences();
  // The panel never reads either list itself (`enabled: false`): the Tools tab keeps them, and the panel follows the
  // cache entries, so its switch and its tools move with every change to the list. It carries the same options as the
  // tab, because observers write their options onto the one shared query.
  const list = useQuery({ ...toolListQuery(activeWorkspaceId), enabled: false });
  const counts = recordView(useQuery({ ...toolUsageQuery(), enabled: false }));
  const group = list.data?.groups.find((entry) => entry.groupId === groupId);
  if (!list.data || !group) return NOT_LISTED;
  return (
    <GroupDetails
      group={group}
      settingsRevision={list.data.settingsRevision}
      usage={counts.record}
      announce={announce}
    />
  );
}

/**
 * The details panel of one tool group, shown in the inspector: its state and switch, each tool with its risk, whether
 * it asks first (or which rule blocks it) and its last use, and the way to the detailed rules in Settings. It reads the
 * group from the list the Tools tab keeps, so everything follows that list.
 *
 * A group shown in two places announces its switch notes in one place. Beside the page that is the group's row, so the
 * docked panel stays quiet; but a modal inspector (the phone sheet, the expanded panel) hides the page from screen
 * readers, so there the panel announces them itself.
 */
export function ToolGroupPanel({ groupId }: { groupId: ToolGroupId }) {
  const root = useRef<HTMLDivElement>(null);
  const [modal, setModal] = useState(false);
  useLayoutEffect(() => setModal(Boolean(root.current?.closest('[role="dialog"]'))), []);
  return (
    <div ref={root}>
      <ToolGroupPanelBody groupId={groupId} announce={modal} />
    </div>
  );
}
