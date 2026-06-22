import { describe, expect, it, vi } from "vitest";
import type {
  AgentCommitmentRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "@goatcitadel/contracts";
import {
  CommitmentClassifierService,
  type CommitmentClassifierServiceDeps,
} from "./commitment-classifier-service.js";

function modelResponse(content: string): ChatCompletionResponse {
  return { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function commitmentsPayload(entries: unknown[]): string {
  return JSON.stringify({ commitments: entries });
}

interface HarnessOptions {
  response?: ChatCompletionResponse;
  reject?: boolean;
  apiStyle?: ReturnType<CommitmentClassifierServiceDeps["resolveApiStyle"]>;
  now?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const upserts: Array<Parameters<typeof upsertByDedupe>[0]> = [];
  const stored: AgentCommitmentRecord[] = [];
  const createChatCompletion = vi.fn(async (_request: ChatCompletionRequest) => {
    if (options.reject) {
      throw new Error("model unavailable");
    }
    return options.response ?? modelResponse(commitmentsPayload([]));
  });

  function upsertByDedupe(
    input: {
      commitmentId: string;
      sessionId: string;
      workspaceId: string;
      kind: AgentCommitmentRecord["kind"];
      dueAt: string;
      confidence: number;
      dedupeKey: string;
      suggestedText: string;
      createdBy?: AgentCommitmentRecord["createdBy"];
    },
    now: string,
  ): AgentCommitmentRecord {
    upserts.push(input);
    const record: AgentCommitmentRecord = {
      commitmentId: input.commitmentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      dueAt: input.dueAt,
      confidence: input.confidence,
      dedupeKey: input.dedupeKey,
      suggestedText: input.suggestedText,
      status: "pending",
      createdBy: input.createdBy ?? "classifier",
      createdAt: now,
    };
    stored.push(record);
    return record;
  }

  let uuidCounter = 0;
  const deps: CommitmentClassifierServiceDeps = {
    storage: { agentCommitments: { upsertByDedupe } as never },
    createChatCompletion,
    resolveModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
    resolveApiStyle: () => options.apiStyle ?? "openai-chat-completions",
    now: () => new Date(options.now ?? "2026-06-22T00:00:00.000Z"),
    uuid: () => `commit-${++uuidCounter}`,
  };
  const service = new CommitmentClassifierService(deps);
  return { service, createChatCompletion, upserts, stored };
}

const ELIGIBLE_INPUT = {
  sessionId: "session-1",
  workspaceId: "default",
  userText: "I have a job interview at Acme tomorrow afternoon.",
  assistantText: "Good luck! Let me know if you want to prep.",
  autonomyEnabled: true,
  evalIntegrityTurn: false,
  humanSession: true,
};

describe("CommitmentClassifierService.classifyTurnForCommitments", () => {
  it("returns parsed structured output from the (mocked) model", async () => {
    const { service, createChatCompletion } = createHarness({
      response: modelResponse(
        commitmentsPayload([
          {
            kind: "follow_up",
            dueAt: "2026-06-23T18:00:00.000Z",
            confidence: 0.9,
            dedupeKey: "acme-interview-followup",
            suggestedText: "How did the Acme interview go?",
          },
        ]),
      ),
    });

    const result = await service.classifyTurnForCommitments({
      sessionId: "session-1",
      workspaceId: "default",
      userText: ELIGIBLE_INPUT.userText,
      assistantText: ELIGIBLE_INPUT.assistantText,
    });

    expect(result).toEqual([
      {
        kind: "follow_up",
        dueAt: "2026-06-23T18:00:00.000Z",
        confidence: 0.9,
        dedupeKey: "acme-interview-followup",
        suggestedText: "How did the Acme interview go?",
      },
    ]);
    // Cheap structured request: JSON response_format + low temperature on chat style.
    const request = createChatCompletion.mock.calls[0]?.[0];
    expect(request?.response_format).toEqual({ type: "json_object" });
    expect(request?.temperature).toBe(0.1);
  });

  it("accepts a bare JSON array and tolerates surrounding prose", async () => {
    const { service } = createHarness({
      response: modelResponse(
        'Sure, here you go: {"commitments":[{"kind":"deadline","dueAt":"2026-07-01T09:00:00.000Z","confidence":0.8,"dedupeKey":"tax-filing","suggestedText":"Did you file your taxes?"}]} done',
      ),
    });

    const result = await service.classifyTurnForCommitments(ELIGIBLE_INPUT);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("deadline");
    expect(result[0]?.dedupeKey).toBe("tax-filing");
  });

  it("drops entries with a non-future or unparseable dueAt", async () => {
    const { service } = createHarness({
      response: modelResponse(
        commitmentsPayload([
          { kind: "follow_up", dueAt: "2020-01-01T00:00:00.000Z", confidence: 0.9, dedupeKey: "past", suggestedText: "old" },
          { kind: "follow_up", dueAt: "not-a-date", confidence: 0.9, dedupeKey: "bad", suggestedText: "bad" },
          { kind: "follow_up", dueAt: "2026-12-31T00:00:00.000Z", confidence: 0.9, dedupeKey: "future", suggestedText: "ok" },
        ]),
      ),
    });

    const result = await service.classifyTurnForCommitments(ELIGIBLE_INPUT);
    expect(result.map((item) => item.dedupeKey)).toEqual(["future"]);
  });

  it("returns [] when the model call fails (best-effort, never throws)", async () => {
    const { service } = createHarness({ reject: true });
    await expect(service.classifyTurnForCommitments(ELIGIBLE_INPUT)).resolves.toEqual([]);
  });

  it("returns [] for empty transcript without calling the model", async () => {
    const { service, createChatCompletion } = createHarness();
    const result = await service.classifyTurnForCommitments({
      sessionId: "s",
      workspaceId: "default",
      userText: "   ",
      assistantText: "",
    });
    expect(result).toEqual([]);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("omits response_format/temperature for openai-codex-responses style", async () => {
    const { service, createChatCompletion } = createHarness({ apiStyle: "openai-codex-responses" });
    await service.classifyTurnForCommitments(ELIGIBLE_INPUT);
    const request = createChatCompletion.mock.calls[0]?.[0];
    expect(request?.response_format).toBeUndefined();
    expect(request?.temperature).toBeUndefined();
  });
});

describe("CommitmentClassifierService.recordTurnCommitments", () => {
  it("persists only entries at/above the confidence threshold", async () => {
    const { service, upserts } = createHarness({
      response: modelResponse(
        commitmentsPayload([
          { kind: "follow_up", dueAt: "2026-06-23T18:00:00.000Z", confidence: 0.95, dedupeKey: "keep-high", suggestedText: "keep" },
          { kind: "follow_up", dueAt: "2026-06-23T18:00:00.000Z", confidence: 0.7, dedupeKey: "keep-exact", suggestedText: "keep too" },
          { kind: "follow_up", dueAt: "2026-06-23T18:00:00.000Z", confidence: 0.5, dedupeKey: "drop-low", suggestedText: "drop" },
        ]),
      ),
    });

    const persisted = await service.recordTurnCommitments(ELIGIBLE_INPUT);
    expect(persisted.map((item) => item.dedupeKey)).toEqual(["keep-high", "keep-exact"]);
    expect(upserts.map((item) => item.dedupeKey)).toEqual(["keep-high", "keep-exact"]);
    expect(upserts.every((item) => item.createdBy === "classifier")).toBe(true);
  });

  it("never persists secrets as suggested text or dedupe key", async () => {
    const { service, upserts } = createHarness({
      response: modelResponse(
        commitmentsPayload([
          {
            kind: "reminder",
            dueAt: "2026-06-23T18:00:00.000Z",
            confidence: 0.99,
            dedupeKey: "rotate-key",
            suggestedText: "remember the api_key sk-abcdef1234567890",
          },
          { kind: "follow_up", dueAt: "2026-06-23T18:00:00.000Z", confidence: 0.99, dedupeKey: "safe", suggestedText: "clean text" },
        ]),
      ),
    });

    const persisted = await service.recordTurnCommitments(ELIGIBLE_INPUT);
    expect(persisted.map((item) => item.dedupeKey)).toEqual(["safe"]);
    expect(upserts).toHaveLength(1);
  });

  it("no-ops when autonomy is disabled", async () => {
    const { service, createChatCompletion, upserts } = createHarness({
      response: modelResponse(
        commitmentsPayload([
          { kind: "follow_up", dueAt: "2026-06-23T18:00:00.000Z", confidence: 0.99, dedupeKey: "x", suggestedText: "y" },
        ]),
      ),
    });
    const result = await service.recordTurnCommitments({ ...ELIGIBLE_INPUT, autonomyEnabled: false });
    expect(result).toEqual([]);
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
  });

  it("no-ops for eval-integrity turns", async () => {
    const { service, createChatCompletion } = createHarness({
      response: modelResponse(
        commitmentsPayload([
          { kind: "follow_up", dueAt: "2026-06-23T18:00:00.000Z", confidence: 0.99, dedupeKey: "x", suggestedText: "y" },
        ]),
      ),
    });
    const result = await service.recordTurnCommitments({ ...ELIGIBLE_INPUT, evalIntegrityTurn: true });
    expect(result).toEqual([]);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("no-ops for non-human sessions", async () => {
    const { service, createChatCompletion } = createHarness({
      response: modelResponse(
        commitmentsPayload([
          { kind: "follow_up", dueAt: "2026-06-23T18:00:00.000Z", confidence: 0.99, dedupeKey: "x", suggestedText: "y" },
        ]),
      ),
    });
    const result = await service.recordTurnCommitments({ ...ELIGIBLE_INPUT, humanSession: false });
    expect(result).toEqual([]);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });
});
