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

type Staged = Awaited<ReturnType<typeof keepCodeModeRun>>;
/** Where a kept tool ended up: promoted, staged for review in Capabilities, or staged after its promotion failed. */
type Kept = "saved" | "review" | "unfinished";

const KEPT: Record<Kept, string> = {
  saved: "Saved as a tool",
  review: "Saved as a tool for review",
  unfinished: "Saved as a tool for review. It couldn't be turned on here.",
};

/**
 * Promotes a staged tool in this click. A lifecycle approval it raises is approved here, so an approved one leaves the
 * tool promoted; a Change Plan leaves it for review.
 */
async function promote(staged: Staged): Promise<Kept> {
  const outcome = await promoteCapabilityCandidate(staged.candidateId, staged.revision, staged.versionId);
  if (outcome.pendingApproval) {
    const resolved = await resolveApproval(outcome.pendingApproval.approvalId, "approve");
    return resolved.approval.status === "approved" ? "saved" : "review";
  }
  return outcome.noMutationRequired ? "saved" : "review";
}

/**
 * Stages the finished run as a tool, then promotes it in the same click: the button label is the consent. The line
 * after says where the tool ended up, and links to Capabilities.
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
  const [state, setState] = useState<"idle" | "keeping" | "failed" | Kept>("idle");
  if (state === "saved" || state === "review" || state === "unfinished") {
    return (
      <p className="text-fg-secondary">
        {KEPT[state]}{" "}
        <NativeOwnerLink href="/capabilities/skills" scope={workspaceId}>
          Open Capabilities
        </NativeOwnerLink>
      </p>
    );
  }
  const keep = async () => {
    setState("keeping");
    let staged: Staged;
    try {
      staged = await keepCodeModeRun(runId, { name: toolName(goal), summary: goal.slice(0, 200) });
    } catch {
      setState("failed");
      return;
    }
    try {
      setState(await promote(staged));
    } catch {
      // Staged but not promoted: it waits for review in Capabilities, and the line says so.
      setState("unfinished");
    }
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
