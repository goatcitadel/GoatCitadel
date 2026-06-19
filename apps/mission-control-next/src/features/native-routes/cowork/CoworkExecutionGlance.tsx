import { AlertTriangle, CheckCircle2, CircleDashed, Eye, PlayCircle, Workflow } from "lucide-react";
import type { TaskDeliverableRecord, TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { NativeCard } from "../NativeRoutePageLayout";
import { NativeButton } from "@next/features/native-routes/primitives";
import { formatDateTime, formatTaskStatus, type CoworkTaskContinuationSummary } from "../shared/native-helpers";
import { LibraryButtonRow } from "../shared/library-primitives";

type TaskCardRecord = TaskRecord;

type CoworkOperatorRecord = {
  operatorId: string;
  sessionCount: number;
  activeSessions: number;
  lastActivityAt?: string;
};

type CoworkExecutionPhaseId = "plan" | "execute" | "review" | "done";
type CoworkExecutionPhaseState = "idle" | "active" | "blocked" | "complete";

type CoworkExecutionPhaseSummary = {
  id: CoworkExecutionPhaseId;
  label: string;
  count: number;
  detail: string;
  state: CoworkExecutionPhaseState;
};

type CoworkExecutionSnapshot = {
  activePhaseLabel: string;
  activePhaseDetail: string;
  phases: CoworkExecutionPhaseSummary[];
  lastCheckpointLabel: string;
  lastCheckpointDetail: string;
  nextCheckpointLabel: string;
  nextCheckpointDetail: string;
  attentionLabel: string;
  attentionDetail: string;
  operatorLabel: string;
  operatorDetail: string;
  runtimeLabel: string;
  runtimeDetail: string;
  truthNote: string;
};

const COWORK_PHASE_DEFS: ReadonlyArray<{
  id: CoworkExecutionPhaseId;
  label: string;
  statuses: ReadonlyArray<TaskRecord["status"]>;
}> = [
  { id: "plan", label: "Plan", statuses: ["planning", "inbox", "assigned"] },
  { id: "execute", label: "Execute", statuses: ["in_progress", "testing"] },
  { id: "review", label: "Review", statuses: ["review", "blocked"] },
  { id: "done", label: "Done", statuses: ["done"] },
];

export function CoworkExecutionGlance({
  snapshot,
  continuation,
  onContinue,
  onOpenApprovals,
  onOpenBoard,
  onOpenBlocker,
}: {
  snapshot: CoworkExecutionSnapshot;
  continuation: CoworkTaskContinuationSummary;
  onContinue: () => void;
  onOpenApprovals: () => void;
  onOpenBoard: () => void;
  onOpenBlocker?: () => void;
}) {
  const hasOperatorAttention = snapshot.attentionLabel !== "Clear" || continuation.blockerCount > 0;

  return (
    <NativeCard
      title="Execution at a glance"
      subtitle="Plan, phase, checkpoint, and attention state derived from visible Cowork task evidence."
      density="compact"
      className="mc-next-cowork-execution-card"
      stats={[
        { label: "Active phase", value: snapshot.activePhaseLabel },
        { label: "Blockers", value: String(continuation.blockerCount) },
      ]}
    >
      {hasOperatorAttention ? (
        <section
          className="mc-next-cowork-attention-strip"
          data-tone={snapshot.attentionLabel === "Blocked" ? "blocked" : "attention"}
          aria-label="Cowork operator attention"
        >
          <div>
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <strong>{snapshot.attentionLabel}</strong>
          </div>
          <p>{snapshot.attentionDetail}</p>
          {onOpenBlocker ? (
            <NativeButton variant="secondary" onClick={onOpenBlocker}>
              <AlertTriangle className="h-4 w-4" />
              Open blocker
            </NativeButton>
          ) : null}
        </section>
      ) : null}
      <LibraryButtonRow>
        <NativeButton variant="default" onClick={onContinue}>
          <Workflow className="h-4 w-4" />
          Continue Cowork
        </NativeButton>
        <NativeButton variant="secondary" onClick={onOpenApprovals}>
          <CheckCircle2 className="h-4 w-4" />
          Review approvals
        </NativeButton>
        <NativeButton variant="secondary" onClick={onOpenBoard}>
          <Workflow className="h-4 w-4" />
          Agent board
        </NativeButton>
      </LibraryButtonRow>
      <section className="mc-next-cowork-execution-summary" aria-label="Cowork execution summary">
        <div>
          <p className="mc-next-cowork-execution-kicker">Phase timeline</p>
          <div className="mc-next-cowork-phase-rail" role="list">
            {snapshot.phases.map((phase, index) => (
              <article key={phase.id} className="mc-next-cowork-phase-step" data-state={phase.state} role="listitem">
                <span className="mc-next-cowork-phase-index">{index + 1}</span>
                <div>
                  <div className="mc-next-cowork-phase-title-row">
                    <strong>{phase.label}</strong>
                    <CoworkPhaseStateBadge phase={phase} />
                  </div>
                  <span>{phase.count} tasks</span>
                </div>
                <p>{phase.detail}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="mc-next-cowork-checkpoint-grid">
          <CoworkCheckpointCard
            label="Current phase"
            value={snapshot.activePhaseLabel}
            detail={snapshot.activePhaseDetail}
          />
          <CoworkCheckpointCard
            label="Last checkpoint"
            value={snapshot.lastCheckpointLabel}
            detail={snapshot.lastCheckpointDetail}
          />
          <CoworkCheckpointCard
            label="Next checkpoint"
            value={snapshot.nextCheckpointLabel}
            detail={snapshot.nextCheckpointDetail}
          />
          <CoworkCheckpointCard label="Attention" value={snapshot.attentionLabel} detail={snapshot.attentionDetail} />
          <CoworkCheckpointCard label="Operators" value={snapshot.operatorLabel} detail={snapshot.operatorDetail} />
          <CoworkCheckpointCard label="Runtime links" value={snapshot.runtimeLabel} detail={snapshot.runtimeDetail} />
        </div>

        <p className="mc-next-cowork-execution-truth">{snapshot.truthNote}</p>
      </section>
    </NativeCard>
  );
}

function CoworkPhaseStateBadge({ phase }: { phase: CoworkExecutionPhaseSummary }) {
  const status = describeCoworkPhaseStateBadge(phase);
  const Icon = status.icon;
  return (
    <span className="mc-next-cowork-phase-state" data-state={phase.state}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {status.label}
    </span>
  );
}

export function buildCoworkExecutionSnapshot(input: {
  tasks: TaskCardRecord[];
  deletedTasks: TaskCardRecord[];
  selectedTask: TaskCardRecord | null;
  deliverables: TaskDeliverableRecord[];
  deliverablesLoading: boolean;
  operators: CoworkOperatorRecord[];
  pendingApprovals: number;
  continuation: CoworkTaskContinuationSummary;
}): CoworkExecutionSnapshot {
  const activeTaskCount = input.tasks.filter((item) => item.status !== "done").length;
  const blockedTasks = input.tasks.filter((item) => item.status === "blocked");
  const reviewTasks = input.tasks.filter((item) => item.status === "review");
  const activeTasks = input.tasks.filter((item) => item.status === "in_progress" || item.status === "testing");
  const planningTasks = input.tasks.filter(
    (item) => item.status === "planning" || item.status === "inbox" || item.status === "assigned",
  );
  const approvalLinkedTasks = input.tasks.filter((item) => Boolean(item.proactiveContext?.approvalId));
  const durableRunIds = new Set(
    input.tasks
      .flatMap((item) => [item.proactiveContext?.durableRunId, item.agenticContext?.durableRunId])
      .filter((item): item is string => Boolean(item)),
  );
  const waitingWakeCount = input.tasks.filter((item) => Boolean(item.proactiveContext?.nextWakeAt)).length;
  const resumedCount = input.tasks.filter((item) => Boolean(item.proactiveContext?.stopReason)).length;
  const latestTask = pickLatestCoworkTask([...input.tasks, ...input.deletedTasks]);
  const latestDeliverable = pickLatestCoworkDeliverable(input.deliverables);
  const latestTaskTime = readCoworkRecordTime(latestTask);
  const latestDeliverableTime = latestDeliverable
    ? readDateTime(latestDeliverable.createdAt)
    : Number.NEGATIVE_INFINITY;
  const latestOperator = pickLatestCoworkOperator(input.operators);
  const activeOperators = input.operators.filter((item) => item.activeSessions > 0).length;
  const activePhase = deriveActiveCoworkPhase({
    blockedCount: blockedTasks.length,
    reviewCount: reviewTasks.length,
    activeCount: activeTasks.length,
    planningCount: planningTasks.length,
    doneCount: input.tasks.filter((item) => item.status === "done").length,
    activeTaskCount,
  });
  const phases = COWORK_PHASE_DEFS.map((phase) => {
    const count = input.tasks.filter((task) => phase.statuses.includes(task.status)).length;
    const state = deriveCoworkPhaseState({ phaseId: phase.id, activePhaseId: activePhase.id, count, blockedTasks });
    return {
      id: phase.id,
      label: phase.label,
      count,
      state,
      detail: describeCoworkPhase(phase.id, count, state),
    };
  });
  const latestIsDeliverable = Boolean(latestDeliverable && latestDeliverableTime >= latestTaskTime);
  const lastCheckpointLabel = latestIsDeliverable
    ? "Deliverable captured"
    : latestTask
      ? "Task updated"
      : "No checkpoint yet";
  const lastCheckpointDetail = latestIsDeliverable
    ? `${latestDeliverable?.title ?? "Deliverable"} · ${formatDateTime(latestDeliverable?.createdAt)}`
    : latestTask
      ? `${latestTask.title} -> ${formatTaskStatus(latestTask.status)} · ${formatDateTime(
          latestTask.updatedAt ?? latestTask.createdAt,
        )}`
      : "Create a task or resume Cowork to start the visible execution record.";
  const pendingApprovalTotal = Math.max(input.pendingApprovals, approvalLinkedTasks.length);
  const attentionLabel =
    blockedTasks.length > 0
      ? "Blocked"
      : pendingApprovalTotal > 0
        ? "Waiting approval"
        : waitingWakeCount > 0
          ? "Waiting"
          : "Clear";
  const attentionDetail =
    blockedTasks.length > 0
      ? `${blockedTasks.length} blocked task${blockedTasks.length === 1 ? "" : "s"} need operator review.`
      : pendingApprovalTotal > 0
        ? `${pendingApprovalTotal} approval signal${pendingApprovalTotal === 1 ? "" : "s"} visible.`
        : waitingWakeCount > 0
          ? `${waitingWakeCount} task${waitingWakeCount === 1 ? "" : "s"} have a scheduled wake checkpoint.`
          : "No blocker or approval queue pressure is visible in this route.";
  const runtimeLabel =
    durableRunIds.size > 0
      ? `${durableRunIds.size} durable run${durableRunIds.size === 1 ? "" : "s"}`
      : resumedCount > 0
        ? `${resumedCount} resumed`
        : "Task projection";
  const runtimeDetail =
    durableRunIds.size > 0
      ? "Tasks carry durable run references; inspect the threaded Cowork panel for run-log authority."
      : resumedCount > 0
        ? "Some tasks record stop or resume context; confirm the durable run before claiming completion."
        : "This route summarizes task-board evidence; it is not a replacement for durable run history.";

  return {
    activePhaseLabel: activePhase.label,
    activePhaseDetail: activePhase.detail,
    phases,
    lastCheckpointLabel,
    lastCheckpointDetail,
    nextCheckpointLabel: describeNextCoworkCheckpoint(input.continuation.nextActionLabel),
    nextCheckpointDetail: input.continuation.nextActionDetail,
    attentionLabel,
    attentionDetail,
    operatorLabel: input.operators.length > 0 ? `${activeOperators}/${input.operators.length} active` : "No operators",
    operatorDetail: latestOperator
      ? `${latestOperator.operatorId} last signaled ${formatDateTime(latestOperator.lastActivityAt)}.`
      : "No operator posture has been reported for this workspace yet.",
    runtimeLabel,
    runtimeDetail,
    truthNote:
      "This is a task-board projection for fast orientation. Durable execution, approvals, and audit logs remain the source of truth for resumable Cowork runs.",
  };
}

function CoworkCheckpointCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="mc-next-cowork-checkpoint-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function deriveActiveCoworkPhase(input: {
  blockedCount: number;
  reviewCount: number;
  activeCount: number;
  planningCount: number;
  doneCount: number;
  activeTaskCount: number;
}): { id: CoworkExecutionPhaseId; label: string; detail: string } {
  if (input.blockedCount > 0) {
    return { id: "review", label: "Review blocked", detail: "A blocker is the current execution gate." };
  }
  if (input.reviewCount > 0) {
    return { id: "review", label: "Review", detail: "Outputs are ready for operator review." };
  }
  if (input.activeCount > 0) {
    return { id: "execute", label: "Execute", detail: "Work is currently in motion." };
  }
  if (input.planningCount > 0) {
    return { id: "plan", label: "Plan", detail: "Planned work is waiting to start." };
  }
  if (input.doneCount > 0 && input.activeTaskCount === 0) {
    return { id: "done", label: "Done", detail: "Visible work is complete unless archived tasks need recovery." };
  }
  return { id: "plan", label: "Idle", detail: "Create or restore a task to start Cowork execution." };
}

function deriveCoworkPhaseState(input: {
  phaseId: CoworkExecutionPhaseId;
  activePhaseId: CoworkExecutionPhaseId;
  count: number;
  blockedTasks: TaskCardRecord[];
}): CoworkExecutionPhaseState {
  if (input.phaseId === "review" && input.blockedTasks.length > 0) {
    return "blocked";
  }
  if (input.phaseId === input.activePhaseId && input.count > 0) {
    return "active";
  }
  if (input.phaseId === "done" && input.count > 0) {
    return "complete";
  }
  return "idle";
}

function describeCoworkPhase(phaseId: CoworkExecutionPhaseId, count: number, state: CoworkExecutionPhaseState): string {
  if (state === "blocked") {
    return "Operator decision required before resume.";
  }
  if (count === 0) {
    return "No visible task evidence yet.";
  }
  if (phaseId === "plan") {
    return "Scope, inbox, or assigned work.";
  }
  if (phaseId === "execute") {
    return "Implementation or validation in motion.";
  }
  if (phaseId === "review") {
    return "Outputs waiting on review.";
  }
  return "Completed visible work.";
}

function describeCoworkPhaseStateBadge(phase: CoworkExecutionPhaseSummary): {
  label: string;
  icon: typeof AlertTriangle;
} {
  if (phase.state === "blocked") {
    return { label: "Blocked", icon: AlertTriangle };
  }
  if (phase.state === "active" && phase.id === "review") {
    return { label: "Review", icon: Eye };
  }
  if (phase.state === "active") {
    return { label: "Active", icon: PlayCircle };
  }
  if (phase.state === "complete") {
    return { label: "Complete", icon: CheckCircle2 };
  }
  return { label: "Idle", icon: CircleDashed };
}

function describeNextCoworkCheckpoint(nextActionLabel: string): string {
  if (nextActionLabel === "Clear blocker") {
    return "Operator decision";
  }
  if (nextActionLabel === "Review output") {
    return "Review gate";
  }
  if (nextActionLabel === "Continue active work") {
    return "Execution checkpoint";
  }
  if (nextActionLabel === "Start planned task") {
    return "Start checkpoint";
  }
  if (nextActionLabel === "Restore or create") {
    return "Recovery checkpoint";
  }
  return "Create checkpoint";
}

function pickLatestCoworkTask(tasks: TaskCardRecord[]): TaskCardRecord | null {
  return tasks.reduce<TaskCardRecord | null>((latest, task) => {
    if (!latest) {
      return task;
    }
    return readCoworkRecordTime(task) > readCoworkRecordTime(latest) ? task : latest;
  }, null);
}

function pickLatestCoworkDeliverable(deliverables: TaskDeliverableRecord[]): TaskDeliverableRecord | null {
  return deliverables.reduce<TaskDeliverableRecord | null>((latest, deliverable) => {
    if (!latest) {
      return deliverable;
    }
    return readDateTime(deliverable.createdAt) > readDateTime(latest.createdAt) ? deliverable : latest;
  }, null);
}

function pickLatestCoworkOperator(operators: CoworkOperatorRecord[]): CoworkOperatorRecord | null {
  return operators.reduce<CoworkOperatorRecord | null>((latest, operator) => {
    if (!latest) {
      return operator;
    }
    return readDateTime(operator.lastActivityAt) > readDateTime(latest.lastActivityAt) ? operator : latest;
  }, null);
}

function readCoworkRecordTime(task: TaskCardRecord | null): number {
  if (!task) {
    return Number.NEGATIVE_INFINITY;
  }
  return Math.max(readDateTime(task.updatedAt), readDateTime(task.createdAt), readDateTime(task.deletedAt));
}

function readDateTime(value?: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
