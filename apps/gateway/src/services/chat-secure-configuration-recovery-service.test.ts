import { describe, expect, it, vi } from "vitest";
import type { InterruptedDurableChatSecureConfigurationCandidate } from "@goatcitadel/storage";
import { recoverInterruptedChatSecureConfigurations } from "./chat-secure-configuration-recovery-service.js";

const candidate: InterruptedDurableChatSecureConfigurationCandidate = {
  reservationId: "reservation-old",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  durableRunId: "run-1",
  promptId: "prompt-issued",
  targetId: "search.brave",
  scopeRef: "root-installation-1",
  expiresAt: "2026-08-08T00:05:00.000Z",
  responderActorId: "operator-1",
  responderAuthActorSource: "token",
  approvedAction: {
    approvalId: "approval-1",
    toolRunId: "tool-run-1",
    promptId: "prompt-issued",
  },
};

function recoveredOutcome() {
  return {
    disposition: "recovered" as const,
    previousPromptId: candidate.promptId,
    promptId: "prompt-recovered",
    expiresAt: "2026-08-08T00:15:00.000Z",
    run: { runId: candidate.durableRunId, status: "waiting" as const, version: 4 },
    reservation: {
      reservationId: candidate.reservationId,
      status: "expired_unreconciled",
    },
  };
}

function harness() {
  const findNext = vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(undefined);
  const recover = vi.fn().mockResolvedValue(recoveredOutcome());
  return {
    deps: {
      storage: {
        sessionMutationAdmissions: {
          findNextInterruptedDurableChatSecureConfiguration: findNext,
          recoverInterruptedDurableChatSecureConfiguration: recover,
        },
      } as any,
      validateAuthority: vi.fn(async () => undefined),
      publishRealtime: vi.fn(async () => undefined),
      recordDevDiagnostic: vi.fn(),
    },
    findNext,
    recover,
  };
}

describe("interrupted Chat secure configuration recovery", () => {
  it("revalidates approval authority before rotating the original durable prompt", async () => {
    const { deps, recover } = harness();

    const result = await recoverInterruptedChatSecureConfigurations(deps);

    expect(result).toEqual({
      scanned: 1,
      recoveredPromptIds: ["prompt-recovered"],
      quarantinedPromptIds: [],
      notificationFailures: 0,
      persistenceFailures: 0,
      limitReached: false,
    });
    expect(deps.validateAuthority).toHaveBeenCalledWith(candidate);
    expect(recover).toHaveBeenCalledWith({
      reservationId: candidate.reservationId,
      promptId: candidate.promptId,
      approvalAuthority: "preserve",
      approvedAction: candidate.approvedAction,
    });
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.objectContaining({
        type: "chat_thread_secure_configuration_recovered",
        turnId: candidate.turnId,
        previousPromptId: candidate.promptId,
        promptId: "prompt-recovered",
      }),
      expect.objectContaining({ links: expect.objectContaining({ runId: candidate.durableRunId }) }),
    );
    expect(
      JSON.stringify({ recoverCalls: recover.mock.calls, realtimeCalls: deps.publishRealtime.mock.calls }),
    ).not.toContain("replacement-secret-bytes");
  });

  it("quarantines a consumed approval without minting a successor prompt", async () => {
    const { deps, recover } = harness();
    deps.validateAuthority.mockRejectedValueOnce(new Error("settled approval"));
    recover.mockResolvedValueOnce({
      disposition: "quarantined",
      previousPromptId: candidate.promptId,
      run: { runId: candidate.durableRunId, status: "waiting", version: 3 },
      reservation: { reservationId: candidate.reservationId, status: "expired_unreconciled" },
    });

    const result = await recoverInterruptedChatSecureConfigurations(deps);

    expect(result.recoveredPromptIds).toEqual([]);
    expect(result.quarantinedPromptIds).toEqual([candidate.promptId]);
    expect(recover).toHaveBeenCalledWith({
      reservationId: candidate.reservationId,
      promptId: candidate.promptId,
      approvalAuthority: "reject",
    });
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.objectContaining({ type: "chat_thread_secure_configuration_quarantined" }),
      expect.any(Object),
    );
  });

  it("quarantines an unapproved prompt when current deny-wins policy rejects it", async () => {
    const { deps, findNext, recover } = harness();
    const unapprovedCandidate: InterruptedDurableChatSecureConfigurationCandidate = {
      reservationId: candidate.reservationId,
      workspaceId: candidate.workspaceId,
      sessionId: candidate.sessionId,
      turnId: candidate.turnId,
      durableRunId: candidate.durableRunId,
      promptId: candidate.promptId,
      targetId: candidate.targetId,
      scopeRef: candidate.scopeRef,
      responderActorId: candidate.responderActorId,
      responderAuthActorSource: candidate.responderAuthActorSource,
    };
    findNext.mockReset().mockResolvedValueOnce(unapprovedCandidate).mockResolvedValueOnce(undefined);
    deps.validateAuthority.mockRejectedValueOnce(new Error("current policy denied"));
    recover.mockResolvedValueOnce({
      disposition: "quarantined",
      previousPromptId: candidate.promptId,
      run: { runId: candidate.durableRunId, status: "waiting", version: 3 },
      reservation: { reservationId: candidate.reservationId, status: "expired_unreconciled" },
    });

    const result = await recoverInterruptedChatSecureConfigurations(deps);

    expect(deps.validateAuthority).toHaveBeenCalledWith(unapprovedCandidate);
    expect(result.quarantinedPromptIds).toEqual([candidate.promptId]);
    expect(recover).toHaveBeenCalledWith({
      reservationId: candidate.reservationId,
      promptId: candidate.promptId,
      approvalAuthority: "reject",
    });
  });

  it("keeps a durable recovery successful when realtime notification fails", async () => {
    const { deps } = harness();
    deps.publishRealtime.mockRejectedValueOnce(new Error("realtime offline"));

    const result = await recoverInterruptedChatSecureConfigurations(deps);

    expect(result.recoveredPromptIds).toEqual(["prompt-recovered"]);
    expect(result.notificationFailures).toBe(1);
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat.secure_configuration.recovery_notification_failed" }),
    );
  });

  it("does not block startup or expose failure details when durable recovery is unavailable", async () => {
    const { deps, findNext } = harness();
    findNext.mockReset().mockRejectedValueOnce(new Error("credential=should-not-escape"));

    const result = await recoverInterruptedChatSecureConfigurations(deps);

    expect(result.persistenceFailures).toBe(1);
    expect(result.recoveredPromptIds).toEqual([]);
    expect(JSON.stringify(deps.recordDevDiagnostic.mock.calls)).not.toContain("should-not-escape");
  });
});
