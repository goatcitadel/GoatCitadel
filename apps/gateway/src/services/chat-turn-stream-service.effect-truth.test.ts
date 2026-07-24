import { describe, expect, it, vi } from "vitest";
import {
  TOOL_EFFECT_CLASSIFICATION_VERSION,
  type ChatToolRunRecord,
  type RuntimeDecisionTraceAppendInput,
} from "@goatcitadel/contracts";
import { recordStepRuntimeDecisions } from "./chat-turn-stream-service.js";

describe("orchestration tool-effect decision traces", () => {
  it("records planning potential, recovery disposition, operator outcome, and bounded receipt refs", () => {
    const recordRuntimeDecision = vi.fn<(input: RuntimeDecisionTraceAppendInput) => void>();
    const toolRun: ChatToolRunRecord = {
      toolRunId: "tool-effect-trace",
      turnId: "child-turn",
      sessionId: "child-session",
      toolName: "plugin:mutate",
      status: "executed",
      effectPotential: "unknown",
      effectDisposition: undefined,
      effectOutcomeKind: "concrete",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "concrete",
        reason: "canonical_effect_receipt_linked",
        refs: [{ owner: "external_side_effect", refId: "effect-receipt-1" }],
      },
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    };

    recordStepRuntimeDecisions(
      { recordRuntimeDecision } as never,
      { workspaceId: "workspace-1", session: { sessionId: "session-1" }, turnId: "turn-1" } as never,
      {
        runId: "run-1",
        planId: "plan-1",
        step: { stepId: "step-1" } as never,
        childToolRuns: [toolRun],
      },
    );

    expect(recordRuntimeDecision).toHaveBeenCalledTimes(1);
    const decision = recordRuntimeDecision.mock.calls[0]![0];
    expect(decision.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "effect_potential", value: "unknown" }),
        expect.objectContaining({ key: "effect_disposition", value: null }),
        expect.objectContaining({ key: "effect_outcome_kind", value: "concrete" }),
        expect.objectContaining({ key: "effect_evidence_reason", value: "canonical_effect_receipt_linked" }),
      ]),
    );
    expect(decision.evidenceRefs).toEqual(
      expect.arrayContaining([
        { refType: "tool_run", refId: "tool-effect-trace" },
        {
          refType: "event",
          refId: "effect-receipt-1",
          label: "tool_effect:external_side_effect",
        },
      ]),
    );
  });

  it("marks an unknown recovery disposition as a blocking decision signal", () => {
    const recordRuntimeDecision = vi.fn<(input: RuntimeDecisionTraceAppendInput) => void>();
    recordStepRuntimeDecisions(
      { recordRuntimeDecision } as never,
      { workspaceId: "workspace-1", session: { sessionId: "session-1" }, turnId: "turn-1" } as never,
      {
        runId: "run-1",
        planId: "plan-1",
        step: { stepId: "step-1" } as never,
        childToolRuns: [
          {
            toolRunId: "tool-uncertain",
            turnId: "child-turn",
            sessionId: "child-session",
            toolName: "shell.exec",
            status: "failed",
            effectPotential: "unknown",
            effectDisposition: "unknown",
            effectOutcomeKind: "uncertain",
            effectEvidence: {
              version: TOOL_EFFECT_CLASSIFICATION_VERSION,
              outcomeKind: "uncertain",
              reason: "interrupted_after_possible_dispatch",
              refs: [],
            },
            startedAt: "2026-07-13T00:00:00.000Z",
            finishedAt: "2026-07-13T00:00:01.000Z",
          },
        ],
      },
    );

    expect(recordRuntimeDecision.mock.calls[0]![0].signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "effect_disposition", value: "unknown", weight: "blocking" }),
        expect.objectContaining({ key: "effect_outcome_kind", value: "uncertain", weight: "blocking" }),
      ]),
    );
  });
});
