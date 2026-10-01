import type { CapabilityCatalogEntry, SkillRuntimeState } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { presentCapabilityTitle } from "@goatcitadel/mission-control-shared/content/capability-rows";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import type { CapabilityCatalogView } from "./capability-catalog";
import { useCapabilitySkillState } from "./use-capability-skill-state";

type CatalogSkill = CapabilityCatalogView["skillsById"][string];

const SKILL_STATES: readonly { state: SkillRuntimeState; label: string }[] = [
  { state: "enabled", label: "Enable" },
  { state: "sleep", label: "Pause" },
  { state: "disabled", label: "Disable" },
];

function CapabilityOwnerLink({ item }: { item: CapabilityCatalogEntry }) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const { navigate } = useCockpitRoute();
  if (item.kind === "tool") {
    const href = "/settings/safety?shell=cockpit#approval-mode";
    return (
      <a
        href={href}
        className="text-sm text-accent hover:underline"
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          navigate(href);
        }}
      >
        Open current tool controls
      </a>
    );
  }
  const path =
    item.kind === "skill"
      ? "/library/skills"
      : item.kind === "proposal" || item.kind === "candidate_skill"
        ? "/library/curator"
        : "/library/capabilities";
  return (
    <ClassicOwnerLink
      href={`${path}?shell=classic`}
      scope={JSON.stringify([activeCitadelId, activeWorkspaceId, item.capabilityId])}
      label={item.kind === "skill" ? "Open current skills view" : "Open current capability view"}
    />
  );
}

export function CapabilitySettings({
  item,
  skillsKnown,
  skill,
  onRefresh,
}: {
  item: CapabilityCatalogEntry;
  skillsKnown: boolean;
  skill?: CatalogSkill;
  onRefresh: () => void;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  const control = useCapabilitySkillState({ item, skill, skillsKnown, workspaceId: activeWorkspaceId, onRefresh });
  const { target, pending, locked, notice, error } = control;
  const title = presentCapabilityTitle(item);

  if (item.kind !== "skill" || !item.skillId)
    return (
      <>
        <p>No native state control is available for this capability type.</p>
        <CapabilityOwnerLink item={item} />
      </>
    );
  if (!control.ready || !skill)
    return (
      <div className="space-y-2">
        <p role="status">The current skill state is unavailable. Refresh Library before making a change.</p>
        <CapabilityOwnerLink item={item} />
      </div>
    );

  return (
    <div className="space-y-3">
      <p>
        Current skill state: <strong className="text-fg">{humanizeToken(skill.state)}</strong>. Changes are
        approval-first; a request does not change this state.
      </p>
      <div className="flex flex-wrap gap-2">
        {SKILL_STATES.filter((option) => option.state !== skill.state).map((option) => (
          <Button
            key={option.state}
            size="sm"
            variant={option.state === "disabled" ? "danger" : "secondary"}
            disabled={locked}
            onClick={() => control.requestReview(option.state)}
          >
            Request {option.label.toLowerCase()}
          </Button>
        ))}
      </div>
      {target ? (
        <div
          role="group"
          aria-label="Confirm skill state request"
          className="space-y-2 rounded-md border border-line bg-sunken p-3"
        >
          <p>
            Request a change to {humanizeToken(target.state)} for {title}? Gateway will create an approval. This
            installation-wide skill state changes only after that approval and its effect complete.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={target.state === "disabled" ? "danger" : "primary"}
              disabled={locked}
              onClick={() => void control.confirm()}
            >
              Confirm request
            </Button>
            <Button size="sm" disabled={pending} onClick={control.cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {pending ? <p role="status">Checking the current skill and requesting approval…</p> : null}
      {notice ? (
        <p role="status" className="text-status-done">
          {notice}
        </p>
      ) : null}
      {control.approvalId ? (
        <details className="text-xs text-fg-muted">
          <summary>Approval details</summary>
          <p className="mt-1 break-all font-mono">{control.approvalId}</p>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
    </div>
  );
}
