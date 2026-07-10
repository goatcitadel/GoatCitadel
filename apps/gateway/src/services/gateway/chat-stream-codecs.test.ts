import { describe, expect, it } from "vitest";
import { toChatStreamChunk } from "./chat-stream-codecs.js";

describe("chat stream codecs", () => {
  it("decodes persisted thinking deltas", () => {
    expect(
      toChatStreamChunk({
        type: "thinking_delta",
        sessionId: "session-1",
        turnId: "turn-1",
        eventId: "event-1",
        sequence: 3,
        runId: "run-1",
        delta: "considering the evidence",
      }),
    ).toEqual({
      type: "thinking_delta",
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "event-1",
      sequence: 3,
      runId: "run-1",
      delta: "considering the evidence",
    });
  });

  it("decodes persisted user-input prompts without weakening their record shape", () => {
    const prompt = {
      promptId: "prompt-1",
      turnId: "turn-1",
      kind: "single_select",
      title: "Choose a target",
      question: "Where should this run?",
      required: true,
      dismissible: false,
      expiresAt: "2026-07-10T00:00:00.000Z",
      options: [
        {
          optionId: "staging",
          label: "Staging",
          description: "Use the non-production environment.",
          helpText: "Recommended for validation.",
        },
      ],
      submitLabel: "Continue",
    };

    expect(
      toChatStreamChunk({
        type: "user_input_required",
        sessionId: "session-1",
        turnId: "turn-1",
        eventId: "event-2",
        sequence: 4,
        prompt,
      }),
    ).toEqual({
      type: "user_input_required",
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "event-2",
      sequence: 4,
      prompt,
    });

    expect(
      toChatStreamChunk({
        type: "user_input_required",
        sessionId: "session-1",
        turnId: "turn-1",
        prompt: { ...prompt, required: "yes" },
      }),
    ).toBeUndefined();
  });

  it("round-trips the complete validated approval governance record", () => {
    const approval = {
      approvalId: "approval-1",
      kind: "code_mode",
      toolName: "code.execute",
      description: "Execute the reviewed immutable artifact.",
      reason: "Operator approval is required.",
      riskLevel: "danger",
      affectedResources: ["workspace:alpha", "artifact:sha256:abc"],
      taskId: "task-1",
      codeModeRunId: "code-run-1",
      codeHash: "sha256:code",
      wrapperManifestHash: "sha256:wrapper",
      capabilitySnapshotId: "snapshot-1",
      inspectPath: "C:/workspace/review.json",
      requestedOutputIntent: "apply_patch",
      saveCandidateOnSuccess: true,
      remainingCount: 2,
      expiresAt: "2026-07-10T08:00:00.000Z",
    } as const;

    expect(
      toChatStreamChunk({
        type: "approval_required",
        sessionId: "session-1",
        turnId: "turn-1",
        eventId: "event-3",
        sequence: 5,
        runId: "run-1",
        approval,
      }),
    ).toEqual({
      type: "approval_required",
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "event-3",
      sequence: 5,
      runId: "run-1",
      approval,
    });
  });

  it("rejects invalid optional approval governance fields instead of silently dropping them", () => {
    const base = {
      type: "approval_required",
      sessionId: "session-1",
      turnId: "turn-1",
      approval: { approvalId: "approval-1" },
    };
    const invalidFields: Array<[string, unknown]> = [
      ["kind", 1],
      ["riskLevel", "critical"],
      ["affectedResources", ["workspace:alpha", 7]],
      ["saveCandidateOnSuccess", "yes"],
      ["remainingCount", Number.NaN],
      ["expiresAt", false],
    ];

    for (const [field, value] of invalidFields) {
      expect(
        toChatStreamChunk({
          ...base,
          approval: { ...base.approval, [field]: value },
        }),
        field,
      ).toBeUndefined();
    }
  });
});
