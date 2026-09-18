import { describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@goatcitadel/contracts";
import { readOnboardingFirstTaskEvidence } from "./onboarding-first-task-service.js";

const state = { completed: true, completedAt: "2026-09-08T00:00:00.000Z" } as OnboardingState;
function fixture(overrides: Record<string, unknown> = {}) {
  const trace = {
    status: "completed",
    turnId: "turn-1",
    sessionId: "session-1",
    assistantMessageId: "message-1",
    completion: { status: "complete", providerCallCount: 1 },
    routing: { effectiveProviderId: "local", effectiveModel: "model-1" },
    finishedAt: "2026-09-08T00:01:00.000Z",
    ...overrides,
  };
  return {
    chatTurnTraces: { listCompletedSince: vi.fn().mockResolvedValue([trace]) },
    chatMessages: {
      get: vi.fn().mockResolvedValue({ role: "assistant", sessionId: "session-1", content: "A useful response." }),
    },
  };
}
describe("first-task evidence", () => {
  it("finds the first valid response beyond a full page of non-provider completions", async () => {
    const storage = fixture();
    const skipped = Array.from({ length: 1000 }, (_, i) => ({
      turnId: `demo-${String(i).padStart(4, "0")}`, startedAt: "2026-09-08T00:00:30.000Z",
      status: "completed", completion: { status: "complete", providerCallCount: 0 }, routing: {},
    }));
    const valid = (await storage.chatTurnTraces.listCompletedSince())[0];
    storage.chatTurnTraces.listCompletedSince.mockReset().mockResolvedValueOnce(skipped).mockResolvedValueOnce([valid]);
    expect(await readOnboardingFirstTaskEvidence(storage as never, state)).toMatchObject({ status: "verified", turnId: "turn-1" });
    expect(storage.chatTurnTraces.listCompletedSince).toHaveBeenLastCalledWith(state.completedAt, 1000,
      { startedAt: "2026-09-08T00:00:30.000Z", turnId: "demo-0999" });
  });

  it("requires actual provider execution and a canonical nonempty assistant message", async () => {
    const storage = fixture();
    const result = await readOnboardingFirstTaskEvidence(storage as never, state);
    expect(result).toMatchObject({ status: "verified", turnId: "turn-1", providerId: "local" });
    expect(storage.chatTurnTraces.listCompletedSince).toHaveBeenCalledWith(state.completedAt, 1000);
  });
  it.each([
    { completion: { status: "complete", providerCallCount: 0 } },
    { completion: { status: "truncated", providerCallCount: 1 } },
    { status: "failed" },
    { failure: { message: "failed" } },
    { assistantMessageId: undefined },
    { completion: { status: "complete", providerCallCount: 1, failedFileMutations: [{}] } },
  ])("does not promote partial, demo or failed outcomes: %j", async (overrides) => {
    expect(await readOnboardingFirstTaskEvidence(fixture(overrides) as never, state)).toMatchObject({
      status: "not_observed",
    });
  });
  it("rejects a message belonging to another session", async () => {
    const storage = fixture();
    storage.chatMessages.get.mockResolvedValue({ role: "assistant", sessionId: "foreign", content: "response" });
    expect(await readOnboardingFirstTaskEvidence(storage as never, state)).toMatchObject({ status: "not_observed" });
  });
  it("does not scan before setup or suppress storage errors", async () => {
    const storage = fixture();
    await readOnboardingFirstTaskEvidence(storage as never, { completed: false } as OnboardingState);
    expect(storage.chatTurnTraces.listCompletedSince).not.toHaveBeenCalled();
    storage.chatTurnTraces.listCompletedSince.mockRejectedValue(new Error("storage unavailable"));
    await expect(readOnboardingFirstTaskEvidence(storage as never, state)).rejects.toThrow("storage unavailable");
  });
});
