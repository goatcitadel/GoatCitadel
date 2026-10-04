import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { chatTurnChecks } from "./chat-turns";

const mocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  preflightChatRoute: vi.fn(),
  streamAgentChatMessage: vi.fn(),
  cancelChatTurn: vi.fn(),
  answerChatUserInputPrompt: vi.fn(),
  fetchChatThread: vi.fn(),
  seedChatApprovalScenario: vi.fn(),
  seedChatUserInputScenario: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  createChatSession: mocks.createChatSession,
  preflightChatRoute: mocks.preflightChatRoute,
  streamAgentChatMessage: mocks.streamAgentChatMessage,
  cancelChatTurn: mocks.cancelChatTurn,
  answerChatUserInputPrompt: mocks.answerChatUserInputPrompt,
  fetchChatThread: mocks.fetchChatThread,
}));
vi.mock("./dev-verification", () => ({
  seedChatApprovalScenario: mocks.seedChatApprovalScenario,
  seedChatUserInputScenario: mocks.seedChatUserInputScenario,
}));

const DECISION = {
  effectiveProviderId: "verification-stub",
  effectiveModel: "verification-stub-chat",
  fingerprint: "f",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createChatSession.mockResolvedValue({ sessionId: "s-1", revision: 1, lifecycleStatus: "active" });
  mocks.preflightChatRoute.mockResolvedValue({ decision: DECISION });
});

function run(id: string) {
  return findCheck(chatTurnChecks, id).run(makeTestContext());
}

function streamChunks(chunks: readonly unknown[]): void {
  mocks.streamAgentChatMessage.mockImplementation(
    async (_sessionId: string, _input: unknown, onChunk: (chunk: unknown) => void) => {
      for (const chunk of chunks) {
        onChunk(chunk);
      }
    },
  );
}

describe("streamed reply", () => {
  it("sends with the preflight route decision and passes when the deltas match the final message", async () => {
    streamChunks([
      { type: "delta", delta: "Verification " },
      { type: "delta", delta: "stub reply." },
      { type: "message_done", content: "Verification stub reply." },
      { type: "done" },
    ]);
    await expect(run("chat.stream-reply")).resolves.toMatchObject({
      status: "pass",
      summary: "Streamed 24 characters matching the final message: “Verification stub reply.”.",
    });
    expect(mocks.streamAgentChatMessage.mock.calls[0]?.[1]).toMatchObject({
      routeDecision: DECISION,
      providerId: "verification-stub",
      model: "verification-stub-chat",
    });
  });

  it("fails when routing is blocked", async () => {
    mocks.preflightChatRoute.mockResolvedValueOnce({ decision: DECISION, blockedReason: "provider_unavailable" });
    await expect(run("chat.stream-reply")).rejects.toThrow("Routing is blocked: provider_unavailable.");
    expect(mocks.streamAgentChatMessage).not.toHaveBeenCalled();
  });

  it("fails when the stream never sends done", async () => {
    streamChunks([
      { type: "delta", delta: "partial" },
      { type: "message_done", content: "partial" },
    ]);
    await expect(run("chat.stream-reply")).rejects.toThrow("never sent its done event");
  });

  it("fails when the streamed deltas differ from the final message", async () => {
    streamChunks([
      { type: "delta", delta: "Verification " },
      { type: "message_done", content: "Verification stub reply." },
      { type: "done" },
    ]);
    const error = await run("chat.stream-reply").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message:
        'The stream delivered "Verification " but the final message is "Verification stub reply."; streamed text was lost.',
      evidence: { streamed: "Verification ", final: "Verification stub reply." },
    });
  });

  it("truncates long texts in the mismatch summary but keeps them whole as evidence", async () => {
    const streamed = "a".repeat(200);
    const final = "b".repeat(200);
    streamChunks([{ type: "delta", delta: streamed }, { type: "message_done", content: final }, { type: "done" }]);
    const error = await run("chat.stream-reply").catch((caught: unknown) => caught);
    expect((error as Error).message).toContain(`"${"a".repeat(80)}…"`);
    expect((error as Error).message).not.toContain("a".repeat(81));
    expect(error).toMatchObject({ evidence: { streamed, final } });
  });

  it("fails with the error chunk's message when the stream reports an error", async () => {
    streamChunks([
      { type: "delta", delta: "Hello" },
      { type: "error", error: "provider timed out" },
      { type: "message_done", content: "Hello" },
      { type: "done" },
    ]);
    await expect(run("chat.stream-reply")).rejects.toThrow("The stream reported an error: provider timed out");
  });

  it("fails when the stream never sends the final message", async () => {
    streamChunks([{ type: "delta", delta: "partial" }, { type: "done" }]);
    await expect(run("chat.stream-reply")).rejects.toThrow("never sent the final message");
  });

  it("fails when the stream carries no reply text", async () => {
    streamChunks([{ type: "message_done", content: "" }, { type: "done" }]);
    await expect(run("chat.stream-reply")).rejects.toThrow("carried no reply text");
  });
});

describe("cancel a waiting turn", () => {
  it("cancels the seeded turn", async () => {
    mocks.seedChatApprovalScenario.mockResolvedValueOnce({
      sessionId: "s-1",
      workspaceId: "ws-testbench",
      turnId: "t-1",
    });
    mocks.cancelChatTurn.mockResolvedValueOnce({ cancelled: true, trace: { status: "cancelled" } });
    await expect(run("chat.cancel-waiting-turn")).resolves.toMatchObject({ status: "pass" });
    expect(mocks.cancelChatTurn).toHaveBeenCalledWith("s-1", "t-1", "testbench");
  });

  it("fails when the trace does not end cancelled", async () => {
    mocks.seedChatApprovalScenario.mockResolvedValueOnce({
      sessionId: "s-1",
      workspaceId: "ws-testbench",
      turnId: "t-1",
    });
    mocks.cancelChatTurn.mockResolvedValueOnce({ cancelled: true, trace: { status: "waiting_for_approval" } });
    await expect(run("chat.cancel-waiting-turn")).rejects.toThrow("waiting_for_approval, not cancelled");
  });
});

describe("user input", () => {
  it("answers the seeded prompt and waits for it to clear", async () => {
    mocks.seedChatUserInputScenario.mockResolvedValueOnce({
      sessionId: "s-1",
      workspaceId: "ws-testbench",
      turnId: "t-2",
      promptId: "p-1",
    });
    mocks.answerChatUserInputPrompt.mockResolvedValueOnce({ ok: true, resumed: true });
    mocks.fetchChatThread.mockResolvedValueOnce({ turns: [{ turnId: "t-2", trace: {} }] });
    await expect(run("chat.user-input")).resolves.toMatchObject({
      status: "pass",
      summary: "Answered; the turn resumed: yes.",
    });
    expect(mocks.answerChatUserInputPrompt).toHaveBeenCalledWith("s-1", "t-2", "p-1", {
      response: { kind: "single_select", optionId: "option-a" },
    });
  });
});
