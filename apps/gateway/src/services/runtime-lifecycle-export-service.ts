import type {
  RuntimeLifecycleResponse,
  RuntimeLifecycleExportBundle,
  RuntimeLifecycleExportQuery,
  RuntimeLifecycleQuery,
  RuntimeLifecycleTrustReport,
  SessionTimelineItem,
  TranscriptEvent,
} from "@goatcitadel/contracts";

export interface RuntimeLifecycleExportHost {
  getRuntimeLifecycle(input: RuntimeLifecycleQuery): Promise<RuntimeLifecycleResponse>;
  getTranscript(sessionId: string): Promise<TranscriptEvent[]>;
  listSessionTimeline(sessionId: string, limit: number): Promise<SessionTimelineItem[]>;
}

function toRuntimeLifecycleQuery(input: RuntimeLifecycleExportQuery): RuntimeLifecycleQuery {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId,
    approvalId: input.approvalId,
    taskId: input.taskId,
  };
}

export class RuntimeLifecycleExportService {
  public constructor(private readonly host: RuntimeLifecycleExportHost) {}

  public async exportBundle(input: RuntimeLifecycleExportQuery): Promise<RuntimeLifecycleExportBundle> {
    const includeTranscript = input.includeTranscript ?? false;
    const includeTimeline = input.includeTimeline ?? false;
    const timelineLimit = Math.max(1, Math.min(input.timelineLimit ?? 200, 1000));
    const format = input.format ?? "bundle";
    const lifecycle = await this.host.getRuntimeLifecycle(toRuntimeLifecycleQuery(input));
    const sessionId = lifecycle.canonical.sessionId ?? lifecycle.session?.sessionId;

    const [transcript, timeline] = await Promise.all([
      includeTranscript && sessionId ? this.host.getTranscript(sessionId) : undefined,
      includeTimeline && sessionId ? this.host.listSessionTimeline(sessionId, timelineLimit) : undefined,
    ]);

    const bundle: RuntimeLifecycleExportBundle = {
      ...lifecycle,
      export: {
        version: "runtime.lifecycle.export.v1",
        exportedAt: new Date().toISOString(),
        includeTranscript,
        includeTimeline,
        timelineLimit,
        format,
      },
      transcript,
      timeline,
      stats: {
        linkedSessionCount: lifecycle.linked.sessionIds.length,
        linkedTurnCount: lifecycle.linked.turnIds.length,
        linkedRunCount: lifecycle.linked.runIds.length,
        linkedApprovalCount: lifecycle.linked.approvalIds.length,
        linkedTaskCount: lifecycle.linked.taskIds.length,
        turnCount: lifecycle.turns.length,
        toolRunCount: lifecycle.toolRuns.length,
        executionPlanCount: lifecycle.executionPlans?.length ?? 0,
        delegationRunCount: lifecycle.delegationRuns?.length ?? 0,
        delegationStepCount: lifecycle.delegationSteps?.length ?? 0,
        proactiveRunCount: lifecycle.proactiveRuns?.length ?? 0,
        approvalEffectCount: lifecycle.approvalEffects?.length ?? 0,
        transcriptEventCount: transcript?.length ?? 0,
        timelineEventCount: timeline?.length ?? 0,
      },
    };

    if (format === "trust_report") {
      bundle.trustReport = buildTrustReport(bundle);
    }

    return bundle;
  }
}

function buildTrustReport(bundle: RuntimeLifecycleExportBundle): RuntimeLifecycleTrustReport {
  const failures = [
    ...bundle.turns.flatMap((turn) => (turn.failure?.message ? [`Turn ${turn.turnId}: ${turn.failure.message}`] : [])),
    ...(bundle.delegationSteps ?? []).flatMap((step) =>
      step.error ? [`Delegation ${step.stepId}: ${step.error}`] : [],
    ),
  ];
  const openRisks = [
    bundle.stats.transcriptEventCount === 0 ? "Transcript was not included in this export." : null,
    bundle.stats.timelineEventCount === 0 ? "Timeline was not included in this export." : null,
    bundle.approval && !isApprovalResolved(bundle.approval) ? "A linked approval still needs operator review." : null,
    failures.length > 0 ? "The run contains failures or partial execution evidence." : null,
  ].filter((item): item is string => Boolean(item));
  const evidence = [
    `${bundle.stats.turnCount} turn(s)`,
    `${bundle.stats.toolRunCount} tool run(s)`,
    `${bundle.stats.executionPlanCount} execution plan(s)`,
    `${bundle.stats.delegationRunCount} delegation run(s)`,
    `${bundle.stats.approvalEffectCount} approval effect(s)`,
  ];
  const latestRoutingTurn = [...bundle.turns].reverse().find((turn) => turn.routing);
  const effectiveRouting = latestRoutingTurn?.routing;

  const title =
    bundle.session?.displayName ??
    bundle.sessionSummary?.lastMessagePreview ??
    bundle.canonical.sessionId ??
    "Runtime run";
  const summary = `Trust report for ${title}: ${bundle.stats.turnCount} turn(s), ${bundle.stats.toolRunCount} tool run(s), ${bundle.stats.delegationStepCount} delegation step(s), and ${openRisks.length} open risk(s).`;

  return {
    version: "runtime.trust_report.v1",
    generatedAt: bundle.export.exportedAt,
    title,
    summary,
    source: bundle.canonical,
    modelProvider: {
      requestedProviderId: effectiveRouting?.primaryProviderId,
      requestedModel: effectiveRouting?.primaryModel ?? latestRoutingTurn?.model,
      effectiveProviderId: effectiveRouting?.effectiveProviderId,
      effectiveModel: effectiveRouting?.effectiveModel ?? latestRoutingTurn?.model,
      fallbackUsed: Boolean(effectiveRouting?.fallbackUsed),
      fallbackReason: effectiveRouting?.fallbackReason,
    },
    activity: {
      turnCount: bundle.stats.turnCount,
      toolRunCount: bundle.stats.toolRunCount,
      executionPlanCount: bundle.stats.executionPlanCount,
      delegationRunCount: bundle.stats.delegationRunCount,
      delegationStepCount: bundle.stats.delegationStepCount,
      approvalEffectCount: bundle.stats.approvalEffectCount,
    },
    tools: bundle.toolRuns.map((tool) => ({
      toolRunId: tool.toolRunId,
      toolName: tool.toolName,
      status: tool.status,
      approvalId: tool.approvalId,
      reused: tool.reused,
    })),
    approvals: bundle.approval
      ? [
          {
            approvalId: bundle.approval.approvalId,
            status: bundle.approval.status,
            kind: bundle.approval.kind,
            riskLevel: bundle.approval.riskLevel,
          },
        ]
      : [],
    evidence,
    failures,
    openRisks,
    shareableMarkdown: renderTrustReportMarkdown(title, summary, evidence, failures, openRisks),
  };
}

function isApprovalResolved(approval: { status?: string }): boolean {
  return approval.status === "approved" || approval.status === "rejected" || approval.status === "edited";
}

function renderTrustReportMarkdown(
  title: string,
  summary: string,
  evidence: string[],
  failures: string[],
  openRisks: string[],
): string {
  const lines = [`# ${title} Trust Report`, "", summary, "", "## Evidence"];
  lines.push(...evidence.map((item) => `- ${item}`));
  lines.push("", "## Failures");
  lines.push(...(failures.length ? failures : ["No failures were linked to this export."]).map((item) => `- ${item}`));
  lines.push("", "## Open Risks");
  lines.push(
    ...(openRisks.length ? openRisks : ["No open risks were detected in the linked runtime evidence."]).map(
      (item) => `- ${item}`,
    ),
  );
  return lines.join("\n");
}
