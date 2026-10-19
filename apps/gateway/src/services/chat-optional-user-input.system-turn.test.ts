import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";

const payloadFor = vi.hoisted(() => ({ actorKind: "system" as string }));

vi.mock("./durable-execution-service.js", () => ({
  parseDurableChatTurnPayload: () => ({
    sessionId: "session-1",
    turnId: "turn-1",
    requestActor: { actorKind: payloadFor.actorKind, actorId: "actor-1" },
    admissionId: "admission-1",
    sessionIncarnationId: "incarnation-1",
    workspaceId: "default",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    admissionMaterialSha256: "a".repeat(64),
  }),
}));

const { readChatOptionalInput, registerChatOptionalInput } = await import("./chat-optional-user-input.js");

function fixture() {
  const projectDurableChatOptionalInput = vi.fn(async () => ({ prompts: [], replies: [] }));
  const registerDurableChatOptionalInput = vi.fn();
  const storage = {
    durableRuns: { getRun: vi.fn(async () => ({ runId: "run-1", version: 2 })) },
    sessionMutationAdmissions: {
      requireExactDurableTurnPayloadIdentity: vi.fn(async () => undefined),
      projectDurableChatOptionalInput,
      registerDurableChatOptionalInput,
    },
  } as unknown as AsyncStorage;
  const input = {
    mode: "chat",
    sessionId: "session-1",
    turnId: "turn-1",
    policyRunId: "run-1",
    canonicalWriteFence: async (work: () => unknown) => await work(),
  } as unknown as ChatTurnAgentRunnerInput;
  return { storage, input, projectDurableChatOptionalInput, registerDurableChatOptionalInput };
}

describe("optional Chat input on non-operator durable turns", () => {
  it.each(["system", "channel"])(
    "reads an empty mailbox for a %s turn instead of failing the turn",
    async (actorKind) => {
      payloadFor.actorKind = actorKind;
      const { storage, input, projectDurableChatOptionalInput } = fixture();

      await expect(readChatOptionalInput(storage, input)).resolves.toEqual({ prompts: [], replies: [] });
      expect(projectDurableChatOptionalInput).not.toHaveBeenCalled();
    },
  );

  it("reads an empty mailbox when the policy run is not a durable Chat run (orchestration phases)", async () => {
    payloadFor.actorKind = "operator";
    const { storage, input } = fixture();
    (storage.durableRuns.getRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new NotFoundError({ entity: "Durable run", id: "run-1" }),
    );

    await expect(readChatOptionalInput(storage, input)).resolves.toEqual({ prompts: [], replies: [] });
  });

  it("still fails issuance when the policy run is not a durable Chat run", async () => {
    payloadFor.actorKind = "operator";
    const { storage, input } = fixture();
    (storage.durableRuns.getRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new NotFoundError({ entity: "Durable run", id: "run-1" }),
    );

    await expect(registerChatOptionalInput(storage, input, {} as never)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("still refuses to issue an optional prompt on a non-operator turn", async () => {
    payloadFor.actorKind = "system";
    const { storage, input, registerDurableChatOptionalInput } = fixture();

    await expect(
      registerChatOptionalInput(storage, input, {
        promptId: "prompt-1",
        turnId: "turn-1",
        kind: "text",
        title: "Style",
        question: "Which style?",
        required: false,
        delivery: "background",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toThrow("no exact operator turn binding");
    expect(registerDurableChatOptionalInput).not.toHaveBeenCalled();
  });

  it("still fails closed when the durable payload belongs to another turn", async () => {
    payloadFor.actorKind = "system";
    const { storage, input } = fixture();

    await expect(readChatOptionalInput(storage, { ...input, turnId: "turn-other" })).rejects.toThrow("binding");
  });
});
