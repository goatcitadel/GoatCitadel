import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import {
  fetchCapabilitySkillRemoval,
  requestCapabilitySkillRemoval,
} from "@goatcitadel/mission-control-shared/api/capability-skills";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { skillListQuery } from "../../../data/capability-skills-query";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import { removalLeftoversKey, removalLeftoversNote, removalOutcomeNote } from "./skill-removal-outcome";

/** How often the removal is read again while an approved one is applied, and how many reads before it gives up. */
const REMOVING_READ_MS = 3_000;
const REMOVING_READS = 20;

const DECLINED = "Not removed. The request was declined.";
const UNFINISHED = "Removing didn't finish. The skill is still here, so you can try again.";

type Phase =
  | { kind: "idle"; note?: string; failed?: boolean }
  | { kind: "asking" }
  | { kind: "waiting"; approvalId: string; workspaceId: string }
  | { kind: "removing"; approvalId: string }
  | { kind: "removed" };

/** How the reads ended: applied, settled without removing (its plain line), or no settlement in time. */
type ReadsEnd = { applied: true } | { applied: false; note?: string };

/**
 * Reads the removal by the approval it tracks while an approved removal is applied. Once it settled the reads stop and
 * the skill list is read again: an applied removal's skill leaves it, and any temporary folders it left are kept where
 * the panel finds them once this part is gone; a removal that settled without removing the skill ends with the
 * settlement's plain line. A failed read also reads the list again. With no settlement in time, it ends with nothing.
 */
function useRemovalReads(
  removal: { approvalId: string } | undefined,
  target: { workspaceId: string; skillId: string },
  onEnd: (end: ReadsEnd) => void,
) {
  const queryClient = useQueryClient();
  const ended = useRef(onEnd);
  ended.current = onEnd;
  const approvalId = removal?.approvalId;
  const { workspaceId, skillId } = target;
  useEffect(() => {
    if (!approvalId) return undefined;
    const key = skillListQuery(workspaceId).queryKey;
    let reads = 0;
    let stopped = false;
    const stop = (end: ReadsEnd) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      ended.current(end);
    };
    const read = async () => {
      let settlement: Awaited<ReturnType<typeof fetchCapabilitySkillRemoval>>["settlement"];
      try {
        ({ settlement } = await fetchCapabilitySkillRemoval({ workspaceId, approvalId }));
      } catch {
        // A failed read tells nothing about the removal: the list is read again, so a removal that went through still
        // shows, and the next read tries again.
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      if (!settlement || stopped) return;
      const leftovers = removalLeftoversNote(settlement);
      // Written before the list is read again, so the line is there when the skill leaves the list.
      if (leftovers) queryClient.setQueryData(removalLeftoversKey(workspaceId, skillId), leftovers);
      const note = removalOutcomeNote(settlement);
      stop(note ? { applied: false, note } : { applied: true });
      void queryClient.invalidateQueries({ queryKey: key });
    };
    const timer = setInterval(() => {
      reads += 1;
      if (reads >= REMOVING_READS) {
        stop({ applied: false });
        return;
      }
      void read();
    }, REMOVING_READ_MS);
    void read();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [approvalId, queryClient, skillId, workspaceId]);
}

/** The dialog's words: what the removal deletes, which is no folder for a skill that was never switched on. */
function removalDescription(name: string, neverOn: boolean): string {
  return neverOn
    ? `Removes ${name}, which an earlier install of this plugin left behind and never switched on. It has no folder in GoatCitadel's skills folder, so nothing is deleted: GoatCitadel marks it removed, so this plugin can be installed again. GoatCitadel keeps its check and its records. This can't be undone here.`
    : `Removes ${name} from this install and deletes its folder from GoatCitadel's skills folder. Its plugin was uninstalled, so the AI can't use it. GoatCitadel keeps its check and its records, so you can install it again later. This can't be undone here.`;
}

export interface SkillRemovalProps {
  skillId: string;
  name: string;
  workspaceId: string;
  /** A left-over an earlier install never switched on: it has no folder and no row in Skills. */
  neverOn?: boolean;
  /** Called once the removal applied, so the place it was asked from can read itself again. */
  onRemoved?: () => void;
}

/**
 * Removing a skill a plugin left behind: from its Skills panel, or, for one never switched on, from a new check of
 * that plugin. It asks the Gateway for the removal, which makes the usual approval, never skipped; the approval is
 * decided here, in place, with the danger review kept. Only that approval's effect removes anything, and GoatCitadel
 * keeps the skill's check and its records.
 */
export function SkillRemoval({ skillId, name, workspaceId, neverOn = false, onRemoved }: SkillRemovalProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  const removedHook = useRef(onRemoved);
  removedHook.current = onRemoved;
  const removing = phase.kind === "removing";
  useRemovalReads(phase.kind === "removing" ? phase : undefined, { workspaceId, skillId }, (end) => {
    if (end.applied) {
      setPhase({ kind: "removed" });
      removedHook.current?.();
      return;
    }
    setPhase({ kind: "idle", note: end.note ?? UNFINISHED, failed: true });
  });
  const queryClient = useQueryClient();

  const ask = async () => {
    setConfirming(false);
    setPhase({ kind: "asking" });
    // A line an earlier removal of this skill left must never read as this one's.
    queryClient.removeQueries({ queryKey: removalLeftoversKey(workspaceId, skillId), exact: true });
    try {
      const outcome = await requestCapabilitySkillRemoval({ workspaceId, skillId });
      setPhase(
        outcome.status === "approved"
          ? { kind: "removing", approvalId: outcome.approvalId }
          : { kind: "waiting", approvalId: outcome.approvalId, workspaceId: outcome.workspaceId },
      );
    } catch (error) {
      setPhase({ kind: "idle", note: describeApiError(error).summary, failed: true });
    }
  };
  const resolved = (approvalId: string, status: ApprovalRequest["status"] | undefined) => {
    setPhase(status === "approved" ? { kind: "removing", approvalId } : { kind: "idle", note: DECLINED });
  };

  if (phase.kind === "removed") return <p className="text-sm text-fg-secondary">{`Removed ${name}.`}</p>;
  return (
    <div className="space-y-2">
      {phase.kind === "waiting" ? (
        <>
          <p className="text-sm text-fg-secondary">The removal applies once you approve it.</p>
          <SettingsApprovalDialog
            key={phase.approvalId}
            approvalId={phase.approvalId}
            workspaceId={phase.workspaceId}
            title="Approve removing this skill?"
            reviewLabel="Review the removal"
            loadFailureHint="Reload to try again."
            dangerReview
            onResolved={(status) => resolved(phase.approvalId, status)}
          />
        </>
      ) : removing ? (
        <p className="text-sm text-fg-secondary">{`Removing ${name}…`}</p>
      ) : (
        <Button
          type="button"
          variant="danger"
          loading={phase.kind === "asking"}
          loadingLabel="Asking…"
          onClick={() => setConfirming(true)}
        >
          Remove skill
        </Button>
      )}
      {phase.kind === "idle" && phase.note ? (
        <p className={phase.failed ? "text-sm text-status-failed" : "text-sm text-fg-secondary"}>{phase.note}</p>
      ) : null}
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove this skill?"
        description={removalDescription(name, neverOn)}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button type="button" variant="danger" onClick={() => void ask()}>
            Remove skill
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
