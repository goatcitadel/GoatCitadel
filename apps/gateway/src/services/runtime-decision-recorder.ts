import type { RuntimeDecisionTraceAppendInput, RuntimeDecisionTraceRecord } from "@goatcitadel/contracts";

const MAX_PENDING_ADVISORY_DECISIONS = 256;

export interface RuntimeDecisionRecorderHost {
  readonly runtimeDecisionTraces: {
    append(input: RuntimeDecisionTraceAppendInput): Promise<RuntimeDecisionTraceRecord>;
  };
  recordDevDiagnostic?(input: {
    level: "warn";
    category: "runtime_decision_trace";
    event: "runtime.decision_trace.append_failed" | "runtime.decision_trace.queue_overflow";
    message: string;
    context?: Record<string, unknown>;
  }): void;
  /** Owns queued advisory writes so Gateway shutdown can drain them. */
  registerBackgroundTask?(task: Promise<void>): void;
}

export class RuntimeDecisionRecorder {
  private advisoryTail: Promise<void> = Promise.resolve();
  private pendingAdvisoryDecisions = 0;

  public constructor(private readonly host: RuntimeDecisionRecorderHost) {}

  public async record(input: RuntimeDecisionTraceAppendInput): Promise<RuntimeDecisionTraceRecord | undefined> {
    try {
      return await this.host.runtimeDecisionTraces.append(input);
    } catch (error) {
      const scope = input.scope ?? {};
      try {
        this.host.recordDevDiagnostic?.({
          level: "warn",
          category: "runtime_decision_trace",
          event: "runtime.decision_trace.append_failed",
          message: "Failed to append runtime decision trace record",
          context: {
            kind: input.kind,
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            runId: scope.runId,
            planId: scope.planId,
            approvalId: scope.approvalId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } catch (diagnosticError) {
        void diagnosticError;
        // Decision traces are advisory projections. When both stores are down,
        // preserve the caller's already-committed canonical mutation.
      }
      return undefined;
    }
  }

  /**
   * Queues an operator-facing projection after its caller has passed the
   * canonical write fence. The projection stays ordered and shutdown-owned,
   * but storage latency is kept off the already-settled Chat tool path.
   *
   * This queue is intentionally bounded. Dropping the newest advisory trace
   * under sustained pressure is safer than allowing an observability backlog
   * to consume unbounded memory; canonical tool/effect rows remain untouched.
   */
  public enqueueAdvisory(input: RuntimeDecisionTraceAppendInput): boolean {
    if (this.pendingAdvisoryDecisions >= MAX_PENDING_ADVISORY_DECISIONS) {
      this.reportQueueOverflow(input);
      return false;
    }

    const captured = snapshotAppendInput(input);
    this.pendingAdvisoryDecisions += 1;
    const task = this.advisoryTail
      .then(async () => {
        await this.record(captured);
      })
      .catch((error: unknown) => {
        // `record` is already failure-isolated. Keep the queue live if a future
        // implementation unexpectedly rejects outside that boundary.
        this.reportAppendFailure(captured, error);
      })
      .then(() => {
        this.pendingAdvisoryDecisions -= 1;
      });
    this.advisoryTail = task;

    try {
      this.host.registerBackgroundTask?.(task);
    } catch (error) {
      // Registration is lifecycle plumbing, not canonical tool truth. The
      // queue still observes and executes the task in-process.
      this.reportAppendFailure(captured, error);
    }
    void task.catch(() => undefined);
    return true;
  }

  private reportQueueOverflow(input: RuntimeDecisionTraceAppendInput): void {
    const scope = input.scope ?? {};
    try {
      this.host.recordDevDiagnostic?.({
        level: "warn",
        category: "runtime_decision_trace",
        event: "runtime.decision_trace.queue_overflow",
        message: "Dropped advisory runtime decision trace because the bounded queue is full",
        context: {
          kind: input.kind,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          runId: scope.runId,
          toolRunId: scope.toolRunId,
          pendingCount: this.pendingAdvisoryDecisions,
          maxPendingCount: MAX_PENDING_ADVISORY_DECISIONS,
        },
      });
    } catch (diagnosticError) {
      void diagnosticError;
    }
  }

  private reportAppendFailure(input: RuntimeDecisionTraceAppendInput, error: unknown): void {
    const scope = input.scope ?? {};
    try {
      this.host.recordDevDiagnostic?.({
        level: "warn",
        category: "runtime_decision_trace",
        event: "runtime.decision_trace.append_failed",
        message: "Failed to process queued runtime decision trace record",
        context: {
          kind: input.kind,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          runId: scope.runId,
          toolRunId: scope.toolRunId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (diagnosticError) {
      void diagnosticError;
    }
  }
}

function snapshotAppendInput(input: RuntimeDecisionTraceAppendInput): RuntimeDecisionTraceAppendInput {
  return {
    ...input,
    scope: { ...(input.scope ?? {}) },
    alternatives: input.alternatives?.map((alternative) => ({ ...alternative })),
    signals: input.signals?.map((signal) => ({
      ...signal,
      evidence: signal.evidence ? { ...signal.evidence } : undefined,
    })),
    evidenceRefs: input.evidenceRefs?.map((evidence) => ({ ...evidence })),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
