import type { RuntimeDecisionTraceAppendInput, RuntimeDecisionTraceRecord } from "@goatcitadel/contracts";

export interface RuntimeDecisionRecorderHost {
  readonly runtimeDecisionTraces: {
    append(input: RuntimeDecisionTraceAppendInput): RuntimeDecisionTraceRecord;
  };
  recordDevDiagnostic?(input: {
    level: "warn";
    category: "runtime_decision_trace";
    event: "runtime.decision_trace.append_failed";
    message: string;
    context?: Record<string, unknown>;
  }): void;
}

export class RuntimeDecisionRecorder {
  public constructor(private readonly host: RuntimeDecisionRecorderHost) {}

  public record(input: RuntimeDecisionTraceAppendInput): RuntimeDecisionTraceRecord | undefined {
    try {
      return this.host.runtimeDecisionTraces.append(input);
    } catch (error) {
      const scope = input.scope ?? {};
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
      return undefined;
    }
  }
}
