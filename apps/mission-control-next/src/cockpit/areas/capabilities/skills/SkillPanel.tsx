import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SKILL_ORIGIN_LABELS, type CapabilitySkillItem } from "@goatcitadel/contracts";
import { formatRelativeTime } from "@goatcitadel/mission-control-shared/content/format";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { skillDetailQuery, skillListQuery, skillUsageQuery } from "../../../data/capability-skills-query";
import { recordView } from "../../../data/record-view";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { SkillPanelDetail } from "./SkillPanelDetail";
import { SkillPanelSwitch } from "./SkillPanelSwitch";
import { presentSkillState, presentSkillUses, skillCategoryLabel, SKILL_TONE_TEXT } from "./skill-view";
import { useSkillSwitch } from "./use-skill-switch";

const NOT_LISTED = <p className="text-sm text-fg-muted">This skill isn&apos;t in the list anymore.</p>;

/** The uses line, and when the skill was last used once the counts say so. */
function UsesLine({ skillId }: { skillId: string }) {
  // The Skills tab keeps the counts; the panel follows the cache entry (`enabled: false`), as the Tools panel does.
  const counts = recordView(useQuery({ ...skillUsageQuery(), enabled: false })).record;
  const entry = counts?.skills.find((candidate) => candidate.skillId === skillId);
  const uses = presentSkillUses(entry, counts ? "ready" : "unknown");
  return (
    <p className="text-sm text-fg-secondary">
      {entry && entry.uses > 0 ? `${uses}, last used ${formatRelativeTime(entry.lastUsedAt)}` : uses}
    </p>
  );
}

function SkillDetails({
  item,
  announce,
  onTag,
}: {
  item: CapabilitySkillItem;
  announce: boolean;
  onTag: (tag: string) => void;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  const sw = useSkillSwitch(item);
  // The uses line has its own section here, so an On skill's reason is left empty.
  const state = presentSkillState(item, sw);
  const detail = useQuery(skillDetailQuery(activeWorkspaceId, item.skillId));
  return (
    <div className="space-y-4">
      {/* The inspector's title names the skill, so the panel starts with its state, origin and category. */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge status={state} />
          <span className="text-sm text-fg-secondary">{SKILL_ORIGIN_LABELS[item.origin]}</span>
          <span className="text-sm text-fg-secondary">{skillCategoryLabel(item.category)}</span>
        </div>
        {/* A wait's reason stands under the switch, beside its Inbox link. */}
        {!sw.waiting && (state.reason || state.link) ? (
          <p className={cn("text-sm", SKILL_TONE_TEXT[state.tone])}>
            {state.reason}
            {state.link ? (
              <>
                {state.reason ? " " : null}
                <NativeOwnerLink scope={item.skillId} href={state.link.href}>
                  {state.link.label}
                </NativeOwnerLink>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      <p className="text-sm text-fg-secondary">{item.description}</p>
      <SkillPanelSwitch item={item} sw={sw} state={state} announce={announce} />
      <Section title="Uses" headingLevel={3}>
        <UsesLine skillId={item.skillId} />
      </Section>
      {item.tags.length > 0 ? (
        <Section title="Tags" headingLevel={3} description="Press a tag to find the skills that have it.">
          <ul className="flex flex-wrap gap-2">
            {item.tags.map((tag) => (
              <li key={tag}>
                <Button size="sm" variant="ghost" onClick={() => onTag(tag)}>
                  {tag}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <SkillPanelDetail item={item} query={detail} />
    </div>
  );
}

function SkillPanelBody({
  skillId,
  announce,
  onTag,
}: {
  skillId: string;
  announce: boolean;
  onTag: (tag: string) => void;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  // The panel never reads the list itself (`enabled: false`): the Skills tab keeps it, and the panel follows the cache
  // entry, so its switch moves with every change to the list. It carries the same options as the tab, because
  // observers write their options onto the one shared query.
  const list = useQuery({ ...skillListQuery(activeWorkspaceId), enabled: false });
  const item = list.data?.items.find((entry) => entry.skillId === skillId);
  if (!item) return NOT_LISTED;
  return <SkillDetails item={item} announce={announce} onTag={onTag} />;
}

/**
 * The details panel of one installed skill, shown in the inspector: its state, origin and category, its description,
 * its switch with Pause or Resume and the approval in place, how often it was used, its tags (each one searches the
 * tab), its instructions, where it came from, and the collapsed Technical details. It reads the skill from the list the
 * Skills tab keeps, so the switch and the state follow that list; only the instructions and the technical details are
 * read for the panel.
 *
 * Beside the page the skill's row announces its switch, so the docked panel stays quiet; a modal inspector (the phone
 * sheet, the expanded panel) hides the page from screen readers, so there the panel announces itself.
 */
export function SkillPanel({ skillId, onTag }: { skillId: string; onTag: (tag: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [modal, setModal] = useState(false);
  useLayoutEffect(() => setModal(Boolean(root.current?.closest('[role="dialog"]'))), []);
  return (
    <div ref={root}>
      <SkillPanelBody skillId={skillId} announce={modal} onTag={onTag} />
    </div>
  );
}
