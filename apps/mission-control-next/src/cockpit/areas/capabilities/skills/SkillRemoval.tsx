import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest, CapabilitySkillItem } from "@goatcitadel/contracts";
import { requestCapabilitySkillRemoval } from "@goatcitadel/mission-control-shared/api/capability-skills";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { skillListQuery } from "../../../data/capability-skills-query";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";

/** How often the list is read again while an approved removal is applied, and how many reads before it gives up. */
const REMOVING_READ_MS = 3_000;
const REMOVING_READS = 20;

const DECLINED = "Not removed. The request was declined.";
const UNFINISHED = "Removing didn't finish. The skill is still here, so you can try again.";

type Phase =
  | { kind: "idle"; note?: string; failed?: boolean }
  | { kind: "asking" }
  | { kind: "waiting"; approvalId: string; workspaceId: string }
  | { kind: "removing" };

/**
 * Reads the skill list again while an approved removal is applied, so the panel follows the list: once the skill is
 * gone the panel says so, and if it never goes the removal is offered again with a plain line.
 */
function useRemovalReads(active: boolean, workspaceId: string, onGaveUp: () => void) {
  const queryClient = useQueryClient();
  const gaveUp = useRef(onGaveUp);
  gaveUp.current = onGaveUp;
  useEffect(() => {
    if (!active) return undefined;
    const key = skillListQuery(workspaceId).queryKey;
    let reads = 0;
    void queryClient.invalidateQueries({ queryKey: key });
    const timer = setInterval(() => {
      reads += 1;
      if (reads >= REMOVING_READS) {
        clearInterval(timer);
        gaveUp.current();
        return;
      }
      void queryClient.invalidateQueries({ queryKey: key });
    }, REMOVING_READ_MS);
    return () => clearInterval(timer);
  }, [active, queryClient, workspaceId]);
}

/**
 * Removing a skill a plugin left behind, from its panel. It asks the Gateway for the removal, which makes the usual
 * approval; the approval is decided here, in place, with the danger review kept. Only that approval's effect removes
 * anything, and GoatCitadel keeps the skill's check and its records.
 */
export function SkillRemoval({ item, workspaceId }: { item: CapabilitySkillItem; workspaceId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  const removing = phase.kind === "removing";
  useRemovalReads(removing, workspaceId, () => setPhase({ kind: "idle", note: UNFINISHED, failed: true }));
  const queryClient = useQueryClient();
  if (!item.removable) return null;

  const ask = async () => {
    setConfirming(false);
    setPhase({ kind: "asking" });
    try {
      const outcome = await requestCapabilitySkillRemoval({ workspaceId, skillId: item.skillId });
      setPhase(
        outcome.status === "approved"
          ? { kind: "removing" }
          : { kind: "waiting", approvalId: outcome.approvalId, workspaceId: outcome.workspaceId },
      );
    } catch (error) {
      setPhase({ kind: "idle", note: describeApiError(error).summary, failed: true });
    }
  };
  const resolved = (status: ApprovalRequest["status"] | undefined) => {
    void queryClient.invalidateQueries({ queryKey: skillListQuery(workspaceId).queryKey });
    setPhase(status === "approved" ? { kind: "removing" } : { kind: "idle", note: DECLINED });
  };

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
            onResolved={resolved}
          />
        </>
      ) : removing ? (
        <p className="text-sm text-fg-secondary">{`Removing ${item.name}…`}</p>
      ) : (
        <Button
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
        description={`Removes ${item.name} from this install. Its plugin was uninstalled, so the AI can't use it. GoatCitadel keeps its check and its records, so you can install it again later. This can't be undone here.`}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => setConfirming(false)}>Keep it</Button>
          <Button variant="danger" onClick={() => void ask()}>
            Remove skill
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
