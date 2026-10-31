import { useState } from "react";
import {
  keepCodeModeRun,
  promoteCapabilityCandidate,
  resolveApproval,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

const toolName = (goal: string): string => {
  const titled = goal.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  return titled.slice(0, 60).trim() || "Saved Code Mode tool";
};

/**
 * Stages the finished run as a tool, then promotes it in the same click: the button label is the consent, so a
 * lifecycle approval raised by the promotion is approved here. A Change Plan, or a promotion that is not available,
 * leaves the tool saved for review in Capabilities.
 */
export function ChatCodeModeKeepAsTool({
  runId,
  goal,
  workspaceId,
}: {
  runId: string;
  goal: string;
  workspaceId: string;
}) {
  const [state, setState] = useState<"idle" | "keeping" | "kept" | "failed">("idle");
  if (state === "kept") {
    return (
      <p className="text-fg-secondary">
        Saved as a tool for review{" "}
        <NativeOwnerLink href="/capabilities/skills" scope={workspaceId}>
          Open Capabilities
        </NativeOwnerLink>
      </p>
    );
  }
  const keep = async () => {
    setState("keeping");
    let staged: Awaited<ReturnType<typeof keepCodeModeRun>>;
    try {
      staged = await keepCodeModeRun(runId, { name: toolName(goal), summary: goal.slice(0, 200) });
    } catch {
      setState("failed");
      return;
    }
    try {
      const outcome = await promoteCapabilityCandidate(staged.candidateId, staged.revision, staged.versionId);
      if (outcome.pendingApproval) await resolveApproval(outcome.pendingApproval.approvalId, "approve");
    } catch {
      // The tool is staged; promotion stays available from Capabilities.
    }
    setState("kept");
  };
  return (
    <p className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="font-medium text-accent hover:underline disabled:opacity-60"
        disabled={state === "keeping"}
        onClick={() => void keep()}
      >
        Keep as a tool
      </button>
      {state === "failed" ? (
        <span role="status" className="text-fg-muted">
          Couldn&apos;t save it. Try again.
        </span>
      ) : null}
    </p>
  );
}
