import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommitmentSweep, type ChatAutonomousTurnDeps } from "./chat-autonomous-turn-service.js";
import { normalizeAgentTurnCronActionConfig } from "./gateway/cron-agent-turn-support.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 11, 12, 0, 0));
  const row = {
    commitmentId: "commitment",
    revision: 3,
    sessionId: "session",
    workspaceId: "workspace",
    dueAt: "2026-10-01T00:00:00.000Z",
    suggestedText: "Check the project",
    status: "pending",
  };
  const repo = {
    reconcileScheduled: vi.fn(async () => 0),
    listDue: vi.fn(async () => [row]),
    claimScheduledOccurrence: vi.fn(async () => ({ runId: "canonical-occurrence" })),
    get: vi.fn(async () => ({ ...row, scheduledRunId: "canonical-occurrence" })),
    markDeliveryFailed: vi.fn(async () => true),
    markDeliveryPending: vi.fn(async () => true),
  };
  const process = vi.fn(async () => ({ status: "pending" }));
  const deps = {
    storage: { agentCommitments: repo, chatSessionBindings: { get: vi.fn(async () => undefined) } },
    cron: { processCommitmentOccurrence: process },
    isFeatureEnabled: vi.fn(async (flag: string) => flag !== "autonomyV1Disabled"),
    getSessionAutonomyPrefs: vi.fn(async () => ({ cooldownSeconds: 60 })),
    prepareAgentChatTurn: vi.fn(),
    createDurableRun: vi.fn(),
  } as unknown as ChatAutonomousTurnDeps;
  return { deps, repo, process };
}

describe("commitment scheduling through canonical cron", () => {
  it("claims immutable material before dispatch and leaves delivery to cron", async () => {
    const f = fixture();
    await runCommitmentSweep(f.deps);
    expect(f.repo.claimScheduledOccurrence).toHaveBeenCalledWith({
      commitmentId: "commitment",
      expectedRevision: 3,
      deliveryChannel: undefined,
    });
    expect(f.process).toHaveBeenCalledWith("canonical-occurrence");
    expect(f.repo.markDeliveryPending).not.toHaveBeenCalled();
    expect(f.deps.prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(f.deps.createDurableRun).not.toHaveBeenCalled();
  });
  it("preserves a committed occurrence for recovery after processing fails", async () => {
    const f = fixture();
    f.process.mockRejectedValueOnce(new Error("crash after claim"));
    await runCommitmentSweep(f.deps);
    expect(f.repo.markDeliveryFailed).not.toHaveBeenCalled();
    expect(f.repo.get).toHaveBeenCalledWith("commitment");
  });
  for (const disabled of ["commitmentScheduledTurnsV1Enabled", "durableKernelV1Enabled", "autonomyV1Disabled"])
    it(`does no work when ${disabled} disallows it`, async () => {
      const f = fixture();
      f.deps.isFeatureEnabled = async (flag) => (flag === "autonomyV1Disabled" ? disabled === flag : disabled !== flag);
      await runCommitmentSweep(f.deps);
      expect(f.repo.listDue).not.toHaveBeenCalled();
      expect(f.process).not.toHaveBeenCalled();
    });
  it("preserves only valid content-free commitment occurrence references", () => {
    const commitment = { commitmentId: "commitment", revision: 3, materialSha256: "a".repeat(64) };
    expect(
      normalizeAgentTurnCronActionConfig({ agentTurn: { prompt: "Test", commitment } })?.agentTurn?.commitment,
    ).toEqual(commitment);
    for (const bad of [
      { ...commitment, revision: 0 },
      { ...commitment, materialSha256: "wrong" },
      { ...commitment, actorId: "fake-creator" },
    ]) {
      expect(() => normalizeAgentTurnCronActionConfig({ agentTurn: { prompt: "Test", commitment: bad } })).toThrow();
    }
  });
});
