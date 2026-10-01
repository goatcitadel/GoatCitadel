import type {
  ChangePlanStatus,
  OperatorInboxGroup,
  OperatorInboxItem,
  OperatorInboxResponse,
  OperatorInboxSourceCoverage,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { BackupRetentionService } from "./backup-retention-service.js";
import type { DaemonRouteService } from "./daemon-route-service.js";
import type { DatabaseCutoverService } from "./database-cutover-service.js";
import type { DurableOperatorService } from "./durable-operator-service.js";
import type { ImprovementService } from "./improvement-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { bounded, buildInboxProjection, label, projectInboxBackupTrust, projectInboxRuntimeHealth, runString, runWorkspaceId, watcherString } from "./inbox-projection-model.js";

const SOURCE_LIMIT = 200;
const RECENT_UPDATE_DAYS = 14;
const RECENT_UPDATE_LIMIT = 50;
const BACKUP_TRUST_CACHE_MS = 5 * 60 * 1000;

export interface InboxProjectionDependencies {
  storage: {
    approvals: Pick<AsyncStorage["approvals"], "listPage">;
    changePlans: Pick<AsyncStorage["changePlans"], "list">;
    documentPatchProposals: Pick<AsyncStorage["documentPatchProposals"], "list">;
    capabilityProposals: Pick<AsyncStorage["capabilityProposals"], "list">;
    chatTurnTraces: Pick<AsyncStorage["chatTurnTraces"], "listActive">;
    chatSessionMeta: Pick<AsyncStorage["chatSessionMeta"], "get" | "listBySessionIds">;
    taskDeliverables: Pick<AsyncStorage["taskDeliverables"], "listRecentByWorkspace">;
    durableChildWatchers: Pick<AsyncStorage["durableChildWatchers"], "listRecentCompletedDelegations">;
    durableRuns: Pick<AsyncStorage["durableRuns"], "getRunsByIds">;
    chatDelegationRuns: Pick<AsyncStorage["chatDelegationRuns"], "get">;
    chatDelegationSteps: Pick<AsyncStorage["chatDelegationSteps"], "get">;
  };
  memory: Pick<MemoryLifecycleService, "listTraceMemoryCandidates">;
  improvement: Pick<ImprovementService, "listCuratorReviewItems">;
  durable: Pick<DurableOperatorService, "listRunHistory" | "listDeadLetters" | "getRun">;
  runtimeHealth: {
    getDatabaseHealthSnapshot: DatabaseCutoverService["getHealthSnapshot"];
    getDaemonStatus: DaemonRouteService["getDaemonStatus"];
    inspectLatestBackupTrust: BackupRetentionService["inspectLatestBackupTrust"];
    costUsageAvailability: AsyncStorage["costLedger"]["usageAvailability"];
  };
}

async function readOptionalOwner<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); }
  catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

export class InboxProjectionService {
  private backupTrustCache?: {
    at: number;
    read: ReturnType<BackupRetentionService["inspectLatestBackupTrust"]>;
  };

  public constructor(private readonly deps: InboxProjectionDependencies) {}

  private async readBackupTrust() {
    const now = Date.now();
    const cached = Boolean(this.backupTrustCache && now - this.backupTrustCache.at < BACKUP_TRUST_CACHE_MS);
    if (!cached) {
      this.backupTrustCache = { at: now, read: this.deps.runtimeHealth.inspectLatestBackupTrust() };
    }
    const read = this.backupTrustCache!.read;
    try { return { inspection: await read, cached }; }
    catch (error) {
      if (this.backupTrustCache?.read === read) this.backupTrustCache = undefined;
      throw error;
    }
  }

  public async getProjection(
    workspaceId: string,
    onSourceError?: (source: string, error: unknown) => void,
  ): Promise<OperatorInboxResponse> {
    const items: OperatorInboxItem[] = [];
    const coverage: OperatorInboxSourceCoverage[] = [];
    const collect = async (
      source: string,
      groups: readonly OperatorInboxGroup[],
      read: () => Promise<{ items: OperatorInboxItem[]; partial?: boolean; detail?: string }>,
    ) => {
      try {
        const result = await read();
        items.push(...result.items);
        coverage.push({ source, state: result.partial ? "partial" : "current", ...(result.detail ? { detail: result.detail } : {}) });
      } catch (error) {
        onSourceError?.(source, error);
        coverage.push({ source, state: "unavailable", detail: `${groups.map(label).join(" and ")} could not be read from this owner.` });
      }
    };

    await collect("approvals", ["needs_decision"], async () => {
      const page = await this.deps.storage.approvals.listPage({ status: "pending", limit: SOURCE_LIMIT, workspaceId });
      return {
        partial: Boolean(page.nextCursor),
        items: page.items.map((approval): OperatorInboxItem => ({
          id: `approval:${approval.approvalId}`,
          kind: "approval",
          group: "needs_decision",
          title: `Review ${label(approval.linkage?.toolName ?? approval.kind)}`,
          summary: "An operator decision is required. Open the approval to inspect the exact action and its policy reason.",
          createdAt: approval.createdAt,
          expiresAt: approval.expiresAt,
          riskLevel: approval.riskLevel,
          source: {
            workspaceId,
            approvalId: approval.approvalId,
            ...(approval.linkage?.sessionId ? { sessionId: approval.linkage.sessionId } : {}),
            ...(approval.linkage?.turnId ? { turnId: approval.linkage.turnId } : {}),
            ...(approval.linkage?.durableRunId ? { runId: approval.linkage.durableRunId } : {}),
          },
          href: `/ops/approvals?approvalId=${encodeURIComponent(approval.approvalId)}&shell=classic`,
        })),
      };
    });

    await collect("change_plans", ["needs_decision", "needs_attention"], async () => {
      const states: readonly ChangePlanStatus[] = ["awaiting_input", "awaiting_confirmation", "awaiting_approval", "manual_required", "failed", "rollback_failed"];
      const batches = await Promise.all(states.map((status) => this.deps.storage.changePlans.list({ workspaceId, status, limit: SOURCE_LIMIT })));
      const records = batches.flat();
      const visible = records.filter((plan) => plan.origin.workspaceId === workspaceId && states.includes(plan.status));
      return {
        partial: batches.some((batch) => batch.length === SOURCE_LIMIT) || visible.length !== records.length,
        detail: visible.length !== records.length ? "Change plans without matching workspace and waiting status were omitted." : undefined,
        items: visible.map((plan): OperatorInboxItem => ({
          id: `change_plan:${plan.planId}`,
          kind: "change_plan",
          group: ["manual_required", "failed", "rollback_failed"].includes(plan.status) ? "needs_attention" : "needs_decision",
          title: bounded(plan.title || "Review change plan"),
          summary: bounded(plan.summary || `Change plan ${label(plan.status)}.`),
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          expiresAt: plan.expiresAt,
          riskLevel: plan.risk,
          source: { workspaceId, planId: plan.planId, planRevision: plan.revision, planStatus: plan.status,
            ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}),
            ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}) },
          href: plan.origin.sessionId ? `/chat?sessionId=${encodeURIComponent(plan.origin.sessionId)}&shell=classic` : "/ops/runtime?shell=classic",
        })),
      };
    });

    await collect("memory_proposals", ["proposals"], async () => {
      const records = await this.deps.memory.listTraceMemoryCandidates({ workspaceId, status: "proposed", limit: SOURCE_LIMIT });
      const visible = records.filter((candidate) => candidate.workspaceId === workspaceId && candidate.status === "proposed");
      return {
        partial: records.length === SOURCE_LIMIT || visible.length !== records.length,
        detail: visible.length !== records.length ? "Memory proposals without matching workspace and status were omitted." : undefined,
        items: visible.map((candidate): OperatorInboxItem => ({
          id: `memory_proposal:${candidate.candidateId}`,
          kind: "memory_proposal",
          group: "proposals",
          title: "Review memory proposal",
          summary: bounded(candidate.proposedInsight),
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
          source: { workspaceId, proposalId: candidate.candidateId },
          href: "/library/memory?shell=classic",
        })),
      };
    });

    await collect("document_proposals", ["proposals"], async () => {
      const records = await this.deps.storage.documentPatchProposals.list({ workspaceId, state: "pending", limit: SOURCE_LIMIT });
      const visible = records.filter((proposal) => proposal.workspaceId === workspaceId && proposal.state === "pending");
      return {
        partial: records.length === SOURCE_LIMIT || visible.length !== records.length,
        detail: visible.length !== records.length ? "Document proposals without matching workspace and pending state were omitted." : undefined,
        items: visible.map((proposal): OperatorInboxItem => ({
          id: `document_proposal:${proposal.proposalId}`,
          kind: "document_proposal",
          group: "proposals",
          title: `Review ${proposal.targetKind === "personal_note" ? "note" : "artifact"} edit`,
          summary: "A proposed document patch is waiting for review. Open its diff before applying it.",
          createdAt: proposal.createdAt,
          updatedAt: proposal.updatedAt,
          source: { workspaceId, proposalId: proposal.proposalId, ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}), ...(proposal.turnId ? { turnId: proposal.turnId } : {}) },
          href: proposal.sessionId ? `/chat?sessionId=${encodeURIComponent(proposal.sessionId)}&shell=classic`
            : proposal.targetKind === "personal_note" ? "/library/notes?shell=classic" : "/library/artifacts?shell=classic",
        })),
      };
    });

    await collect("capability_proposals", ["proposals"], async () => {
      const records = await this.deps.storage.capabilityProposals.list(SOURCE_LIMIT);
      let unscoped = false;
      const visible = records.filter((proposal) => {
        const scope = proposal.payload.workspaceId;
        if (typeof scope !== "string" || !scope.trim()) { unscoped = true; return false; }
        return scope.trim() === workspaceId;
      }).filter((proposal) => ["proposed", "validating", "pending_approval"].includes(proposal.status));
      return {
        partial: records.length === SOURCE_LIMIT || unscoped,
        detail: unscoped ? "Some proposals have no workspace binding and were omitted." : undefined,
        items: visible.map((proposal): OperatorInboxItem => ({
          id: `capability_proposal:${proposal.proposalId}`,
          kind: "capability_proposal",
          group: "proposals",
          title: bounded(proposal.title || "Review capability proposal"),
          summary: bounded(proposal.summary),
          createdAt: proposal.createdAt,
          updatedAt: proposal.updatedAt,
          source: { workspaceId, proposalId: proposal.proposalId },
          href: "/library/capabilities?shell=classic",
        })),
      };
    });

    await collect("improvement_proposals", ["proposals"], async () => {
      const response = await this.deps.improvement.listCuratorReviewItems({ workspaceId, limit: SOURCE_LIMIT });
      const active = response.items.filter((item) => ["proposed", "evaluating", "ready_for_approval", "approval_pending"].includes(item.candidate.status));
      return {
        partial: response.items.length === SOURCE_LIMIT,
        items: active.map((item): OperatorInboxItem => ({
          id: `improvement_proposal:${item.candidate.candidateId}`,
          kind: "improvement_proposal",
          group: "proposals",
          title: "Review improvement proposal",
          summary: bounded(item.candidate.summary),
          createdAt: item.candidate.createdAt,
          updatedAt: item.candidate.updatedAt,
          source: { workspaceId, proposalId: item.candidate.candidateId },
          href: "/library/curator?shell=classic",
        })),
      };
    });

    await collect("durable_runs", ["needs_attention"], async () => {
      const page = await this.deps.durable.listRunHistory({ workspaceId, limit: SOURCE_LIMIT });
      let omittedScope = false;
      const visible = page.items.filter((run) => {
        const scope = runWorkspaceId(run);
        if (scope !== workspaceId) { omittedScope = true; return false; }
        return run.status === "failed";
      });
      const detail = [
        page.nextCursor ? "Only the most recent workspace runs were checked. Older failures may be omitted." : undefined,
        omittedScope ? "Runs without matching workspace scope were omitted." : undefined,
      ].filter(Boolean).join(" ");
      return {
        partial: Boolean(page.nextCursor) || omittedScope,
        detail: detail || undefined,
        items: visible.map((run): OperatorInboxItem => ({
          id: `failed_run:${run.runId}`,
          kind: "failed_run",
          group: "needs_attention",
          title: "Recover failed run",
          summary: bounded(run.recoverySummary || run.lastError || "The run failed. Review the run before retrying."),
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          source: { workspaceId, runId: run.runId },
          href: `/ops/runtime?runId=${encodeURIComponent(run.runId)}&shell=classic`,
        })),
      };
    });

    await collect("dead_letters", ["needs_attention"], async () => {
      const records = await this.deps.durable.listDeadLetters(SOURCE_LIMIT);
      let unscoped = false;
      const visible: OperatorInboxItem[] = [];
      for (const letter of records) {
        if (letter.resolvedAt) continue;
        const run = await this.deps.durable.getRun(letter.runId).catch(() => null);
        if (!run || !runWorkspaceId(run)) { unscoped = true; continue; }
        if (runWorkspaceId(run) !== workspaceId) continue;
        visible.push({
          id: `dead_letter:${letter.deadLetterId}`,
          kind: "dead_letter",
          group: "needs_attention",
          title: "Recover stopped run",
          summary: bounded(letter.reason),
          createdAt: letter.createdAt,
          source: { workspaceId, runId: letter.runId, deadLetterId: letter.deadLetterId },
          href: `/ops/runtime?runId=${encodeURIComponent(letter.runId)}&shell=classic`,
        });
      }
      return { items: visible, partial: records.length === SOURCE_LIMIT || unscoped, detail: unscoped ? "Dead letters without a readable scoped run were omitted." : undefined };
    });

    await collect("user_input", ["needs_decision"], async () => {
      const traces = await this.deps.storage.chatTurnTraces.listActive(SOURCE_LIMIT);
      let unscoped = false;
      const visible: OperatorInboxItem[] = [];
      for (const trace of traces) {
        if (!trace.pendingUserInput) continue;
        const session = await this.deps.storage.chatSessionMeta.get(trace.sessionId);
        if (!session) { unscoped = true; continue; }
        if (session.workspaceId !== workspaceId) continue;
        const prompt = trace.pendingUserInput;
        visible.push({
          id: `user_input:${prompt.promptId}`,
          kind: "user_input",
          group: "needs_decision",
          title: bounded(prompt.title || "Answer a question"),
          summary: bounded(prompt.question),
          createdAt: trace.startedAt,
          expiresAt: prompt.expiresAt,
          source: { workspaceId, sessionId: trace.sessionId, turnId: trace.turnId, promptId: prompt.promptId },
          href: `/chat?sessionId=${encodeURIComponent(trace.sessionId)}&shell=classic`,
        });
      }
      return { items: visible, partial: traces.length === SOURCE_LIMIT || unscoped, detail: unscoped ? "Questions without a readable session scope were omitted." : undefined };
    });

    await collect("background_updates", ["updates"], async () => {
      const cutoff = new Date(Date.now() - RECENT_UPDATE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const records = await this.deps.storage.taskDeliverables.listRecentByWorkspace(workspaceId, cutoff, RECENT_UPDATE_LIMIT + 1);
      const visible = records.filter((record) => record.workspaceId === workspaceId && record.createdAt >= cutoff);
      const incomplete = records.length > RECENT_UPDATE_LIMIT || visible.length !== records.length;
      return {
        items: visible.slice(0, RECENT_UPDATE_LIMIT).map((deliverable): OperatorInboxItem => ({
          id: `task_deliverable:${deliverable.deliverableId}`,
          kind: "task_deliverable",
          group: "updates",
          title: bounded(deliverable.title || "Task deliverable"),
          summary: `A ${deliverable.deliverableType} deliverable was recorded for ${bounded(deliverable.taskTitle || "a task")}. Open Kanban to inspect its current record.`,
          createdAt: deliverable.createdAt,
          source: { workspaceId, taskId: deliverable.taskId, deliverableId: deliverable.deliverableId },
          href: `/ops/kanban?shell=classic&taskId=${encodeURIComponent(deliverable.taskId)}`,
        })),
        partial: true,
        detail: incomplete
          ? "Recent task deliverables are bounded or some records lacked matching scope."
          : "Only recent task deliverables are shown.",
      };
    });

    await collect("completed_background_runs", ["updates"], async () => {
      const cutoff = new Date(Date.now() - RECENT_UPDATE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const candidates = await this.deps.storage.durableChildWatchers.listRecentCompletedDelegations(workspaceId, cutoff, RECENT_UPDATE_LIMIT + 1);
      const runs = await this.deps.storage.durableRuns.getRunsByIds(candidates.flatMap(({ watcher }) => [watcher.parentRunId, watcher.childRunId]));
      const sessionIds = [...new Set(candidates.flatMap(({ watcher }) => [
        runs.get(watcher.parentRunId), runs.get(watcher.childRunId),
      ]).flatMap((run) => run ? [runString(run, "sessionId")].filter((id): id is string => Boolean(id)) : []))];
      const sessions = await this.deps.storage.chatSessionMeta.listBySessionIds(sessionIds, workspaceId);
      const visible: OperatorInboxItem[] = [];
      let unverified = false;
      for (const { watcher, finishedAt } of candidates) {
        const parent = runs.get(watcher.parentRunId);
        const child = runs.get(watcher.childRunId);
        if (!parent || !child) { unverified = true; continue; }
        const parentSessionId = runString(parent, "sessionId");
        const childSessionId = runString(child, "sessionId");
        const childTurnId = runString(child, "turnId");
        const delegationRunId = watcherString(watcher.metadata, "delegationRunId");
        const stepId = watcherString(watcher.metadata, "stepId");
        if (watcher.source !== "chat_delegation" || parent.workflowKey !== "chat.turn.execute"
          || child.workflowKey !== "chat.turn.execute" || child.status !== "completed"
          || child.finishedAt !== finishedAt || finishedAt < cutoff
          || !parentSessionId || !childSessionId || !childTurnId
          || !delegationRunId || !stepId
          || watcherString(watcher.metadata, "childSessionId") !== childSessionId
          || watcherString(watcher.metadata, "childTurnId") !== childTurnId
          || !runWorkspaceId(parent) || !runWorkspaceId(child)) {
          unverified = true;
          continue;
        }
        if (runWorkspaceId(parent) !== workspaceId || runWorkspaceId(child) !== workspaceId) continue;
        const parentSession = sessions.get(parentSessionId);
        const childSession = sessions.get(childSessionId);
        if (!parentSession || !childSession) { unverified = true; continue; }
        if (parentSession.workspaceId !== workspaceId || childSession.workspaceId !== workspaceId) continue;
        const [delegationRun, step] = await Promise.all([
          readOptionalOwner(() => this.deps.storage.chatDelegationRuns.get(delegationRunId)),
          readOptionalOwner(() => this.deps.storage.chatDelegationSteps.get(stepId)),
        ]);
        if (!delegationRun || !step || delegationRun.sessionId !== parentSessionId
          || delegationRun.parentRunId !== parent.runId || step.runId !== delegationRunId
          || step.durableRunId !== child.runId || step.childSessionId !== childSessionId
          || step.childTurnId !== childTurnId) {
          unverified = true;
          continue;
        }
        visible.push({
          id: `completed_background_run:${watcher.watcherId}`,
          kind: "completed_background_run",
          group: "updates",
          title: "Background run completed",
          summary: "A watched Chat child run reached completed status. Open the run to inspect its output and delegation outcome.",
          createdAt: finishedAt,
          source: { workspaceId, runId: child.runId },
          href: `/ops/runtime?runId=${encodeURIComponent(child.runId)}&shell=classic`,
        });
      }
      return {
        items: visible.slice(0, RECENT_UPDATE_LIMIT),
        partial: true,
        detail: candidates.length > RECENT_UPDATE_LIMIT || unverified
          ? "Recent completed Chat delegations are bounded or some records could not be scoped. Other background sources are not projected."
          : "Only recent completed Chat delegations are shown; other background sources are not projected.",
      };
    });

    await collect("runtime_health", ["needs_attention"], async () => {
      const [database, daemon] = await Promise.all([
        this.deps.runtimeHealth.getDatabaseHealthSnapshot(),
        this.deps.runtimeHealth.getDaemonStatus(),
      ]);
      return projectInboxRuntimeHealth(workspaceId, database, daemon, new Date().toISOString());
    });

    await collect("backup_trust", ["needs_attention"], async () => {
      const { inspection, cached } = await this.readBackupTrust();
      return projectInboxBackupTrust(workspaceId, inspection, cached, Date.now());
    });

    await collect("spend_coverage", ["needs_attention"], async () => {
      const now = new Date();
      const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const availability = await this.deps.runtimeHealth.costUsageAvailability(from, now.toISOString());
      const missingCost = availability.metricAvailability.costUsd.unknownAttemptCount;
      const missingUsage = availability.unknownEvents;
      return { items: missingCost || missingUsage ? [{
        id: "spend_coverage:seven_days", kind: "spend_coverage", group: "needs_attention",
        title: "Spend coverage gap",
        summary: `${missingCost} installation-wide attempts lack trustworthy cost and ${missingUsage} lack usage metadata over the last seven days. Displayed spend may be a lower bound.`,
        createdAt: now.toISOString(), source: { workspaceId }, href: "/system/spend",
      } satisfies OperatorInboxItem] : [] };
    });

    return buildInboxProjection(workspaceId, items, coverage, new Date().toISOString());
  }
}
