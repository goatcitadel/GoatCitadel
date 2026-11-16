import type { DurableRunRecord, DurableRunStatus } from "@goatcitadel/contracts";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";

export type WorkBoardGroup = "running" | "waiting" | "failed" | "done";

const INTERACTIVE_WORKFLOWS = new Set(["chat.turn.execute", "orchestration.plan.execute"]);

export function groupRunStatus(status: DurableRunStatus): WorkBoardGroup {
  if (status === "queued" || status === "running") return "running";
  if (status === "waiting" || status === "paused") return "waiting";
  if (status === "failed" || status === "dead_lettered") return "failed";
  return "done";
}

export function projectWorkBoard(
  runs: DurableRunRecord[],
  workspaceId: string,
): Record<WorkBoardGroup, DurableRunRecord[]> {
  const result: Record<WorkBoardGroup, DurableRunRecord[]> = { running: [], waiting: [], failed: [], done: [] };
  for (const run of runs) {
    if (
      !INTERACTIVE_WORKFLOWS.has(run.workflowKey) ||
      typeof run.payload.heartbeatOccurrenceId === "string" ||
      durableRunWorkspaceId(run) !== workspaceId
    )
      continue;
    result[groupRunStatus(run.status)].push(run);
  }
  for (const group of Object.values(result)) group.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}

export function workRunTitle(run: DurableRunRecord): string {
  const objective = run.metadata?.objective;
  if (typeof objective === "string" && objective.trim()) {
    const compact = objective.replace(/\s+/g, " ").trim();
    return compact.length > 140 ? `${compact.slice(0, 139).trimEnd()}…` : compact;
  }
  if (run.workflowKey === "chat.turn.execute") return "Chat turn";
  if (run.workflowKey === "orchestration.plan.execute") return "Supervised plan";
  if (run.workflowKey === "proactive.tick") return "Background work";
  if (run.workflowKey === "chat.post_commit.effect") return postCommitTitle(run.metadata?.effect);
  if (run.workflowKey === "approval.wait") return "Waiting for an approval";
  if (run.workflowKey === "connector.delivery") return "Connector delivery";
  if (run.workflowKey === "hook.delivery") return "Hook delivery";
  return "Workflow run";
}

const POST_COMMIT_TITLES: Readonly<Record<string, string>> = {
  commitments: "Follow-up commitments after a Chat reply",
  background_review: "Background review after a Chat reply",
  memory_maintenance: "Memory upkeep after a Chat reply",
};

function postCommitTitle(effect: unknown): string {
  const known = typeof effect === "string" && Object.hasOwn(POST_COMMIT_TITLES, effect);
  return known ? POST_COMMIT_TITLES[effect]! : "Background work after a Chat reply";
}
