import { useEffect, useRef, useState } from "react";
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
/**
 * Where a kept tool ended up: promoted, staged for review in Capabilities, staged after its promotion failed, or
 * approved with its promotion still being applied.
 */
type Kept = "saved" | "review" | "unfinished" | "applying";

const KEPT: Record<Kept, string> = {
  saved: "Saved as a tool",
  review: "Saved as a tool for review",
  unfinished: "Saved as a tool for review. It couldn't be turned on here.",
  applying: "Saved as a tool. It's still being turned on.",
};

/** An approved lifecycle approval promotes the tool through its effects, so it is saved once none is left over. */
function appliedOutcome(effects: ReadonlyArray<{ status: string }>): Kept {
  if (effects.some((effect) => effect.status === "failed")) return "unfinished";
  if (effects.some((effect) => effect.status === "pending" || effect.status === "running")) return "applying";
  return "saved";
}

/**
 * Promotes a staged tool in this click. A lifecycle approval it raises is approved here, so an approved one whose
 * effects all finished leaves the tool promoted; a Change Plan leaves it for review.
 */
async function promote(staged: Staged): Promise<Kept> {
  const outcome = await promoteCapabilityCandidate(staged.candidateId, staged.revision, staged.versionId);
  if (outcome.pendingApproval) {
    const resolved = await resolveApproval(outcome.pendingApproval.approvalId, "approve");
    return resolved.approval.status === "approved" ? appliedOutcome(resolved.effects) : "review";
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
  // The click replaces its button with the outcome line; focus that fell to <body> moves to the line, once.
  const refocus = useRef(false);
  const keptRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!refocus.current || state === "idle" || state === "keeping") return;
    refocus.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    keptRef.current?.focus({ preventScroll: true });
  }, [state]);
  if (state !== "idle" && state !== "keeping" && state !== "failed") {
    return (
      <p ref={keptRef} tabIndex={-1} className="text-fg-secondary outline-none">
        {KEPT[state]}{" "}
        <NativeOwnerLink href="/capabilities/skills" scope={workspaceId}>
          Open Capabilities
        </NativeOwnerLink>
      </p>
    );
  }
  const keep = async () => {
    refocus.current = true;
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
