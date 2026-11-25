import { expect, it, vi } from "vitest";
import { collectChatContinuityLinks } from "./chat-continuity-links.js";

it("rechecks live receipt owners and never infers a completed effect from a tool result body", async () => {
  let completed = true;
  const effect = { owner: "external_side_effect", refId: "receipt-one" };
  const tools = [
    {
      toolRunId: "confirmed",
      sessionId: "s",
      turnId: "t",
      toolName: "channel.send",
      effectOutcomeKind: "concrete",
      effectEvidence: {
        version: "goatcitadel.tool-effect.v1",
        outcomeKind: "concrete",
        reason: "canonical_effect_receipt_linked",
        refs: [effect],
      },
    },
    {
      toolRunId: "claim",
      sessionId: "s",
      turnId: "t",
      toolName: "channel.send",
      result: { status: "sent", deliveryId: "invented" },
      effectOutcomeKind: "uncertain",
      effectEvidence: {
        version: "goatcitadel.tool-effect.v1",
        outcomeKind: "uncertain",
        reason: "completed_without_canonical_effect_receipt",
        refs: [],
      },
    },
  ];
  const storage = {
    chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "A", lifecycleStatus: "active" })) },
    chatTurnTraces: {
      getByTurnIds: vi.fn(async () => new Map([["t", { sessionId: "s", turnId: "t", durable: { runId: "run" } }]])),
    },
    chatToolRuns: { readCompleteByTurn: vi.fn(async () => tools) },
    chatGeneratedArtifacts: { listByTurn: vi.fn(async () => []) },
    externalSideEffectRuns: {
      get: vi.fn(async () => ({ status: completed ? "completed" : "unknown", workspaceId: "A" })),
    },
    approvalEffects: { get: vi.fn() },
  };
  const result = await collectChatContinuityLinks(storage as never, "s", ["t"]);
  expect(result.complete).toBe(true);
  expect(storage.chatToolRuns.readCompleteByTurn).toHaveBeenCalledExactlyOnceWith("t", 32);
  expect(result.links).toContainEqual(
    expect.objectContaining({ canonicalRef: "external_side_effect:receipt-one", completed: true }),
  );
  expect(result.links.some((link) => link.completed && link.canonicalRef.includes("invented"))).toBe(false);
  expect(result.links).toContainEqual(expect.objectContaining({ canonicalRef: "tool-run:claim", completed: false }));
  completed = false;
  expect((await collectChatContinuityLinks(storage as never, "s", ["t"])).links.some((link) => link.completed)).toBe(
    false,
  );
});

it("fails closed for foreign turns and incomplete tool history", async () => {
  const storage = {
    chatSessionMeta: { get: async () => ({ workspaceId: "A", lifecycleStatus: "active" }) },
    chatTurnTraces: { getByTurnIds: async () => new Map([["t", { sessionId: "foreign" }]]) },
    chatToolRuns: { readCompleteByTurn: vi.fn(async () => undefined) },
    chatGeneratedArtifacts: { listByTurn: vi.fn(async () => []) },
  };
  expect((await collectChatContinuityLinks(storage as never, "s", ["t"])).complete).toBe(false);
  expect(storage.chatToolRuns.readCompleteByTurn).not.toHaveBeenCalled();
  storage.chatTurnTraces.getByTurnIds = async () => new Map([["t", { sessionId: "s" }]]);
  expect((await collectChatContinuityLinks(storage as never, "s", ["t"])).complete).toBe(false);
});
