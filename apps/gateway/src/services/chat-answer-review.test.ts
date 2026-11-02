import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse } from "@goatcitadel/contracts";
import {
  buildStrictReviewNote,
  classifyReviewFailure,
  parseReviewVerdict,
  type ChatAnswerReviewDeps,
  reviewPreparedTurnAnswer,
  runChatAnswerReview,
  shouldReviewChatAnswer,
} from "./chat-answer-review.js";

const NOW = () => new Date("2026-11-01T00:00:00.000Z");

function completion(content: string): ChatCompletionResponse {
  return { choices: [{ index: 0, message: { content }, finish_reason: "stop" }] };
}

function reviewInput(depth: "standard" | "strict" = "standard") {
  return {
    depth,
    workspaceId: "default",
    sessionId: "session-1",
    turnId: "turn-1",
    providerId: "openai",
    model: "gpt-5.4",
    userRequest: "What is the capital of France?",
    answer: "Paris.",
    toolRuns: [],
    citations: [{ citationId: "c1", url: "https://example.test/france", title: "France" }],
    now: NOW,
  };
}

describe("shouldReviewChatAnswer", () => {
  const base = { depth: "standard" as const, answer: "Paris.", status: "completed" };

  it("reviews a completed answer when review depth is standard or strict", () => {
    expect(shouldReviewChatAnswer(base)).toBe(true);
    expect(shouldReviewChatAnswer({ ...base, depth: "strict" })).toBe(true);
  });

  it("does not review when review depth is off or unset", () => {
    expect(shouldReviewChatAnswer({ ...base, depth: "off" })).toBe(false);
    expect(shouldReviewChatAnswer({ ...base, depth: undefined })).toBe(false);
  });

  it("skips failed, empty, repaired, delegated-child, server-only, worker and aborted answers", () => {
    expect(shouldReviewChatAnswer({ ...base, status: "failed" })).toBe(false);
    expect(shouldReviewChatAnswer({ ...base, answer: "  " })).toBe(false);
    expect(shouldReviewChatAnswer({ ...base, repaired: true })).toBe(false);
    expect(shouldReviewChatAnswer({ ...base, parentDelegationStepId: "step-1" })).toBe(false);
    expect(shouldReviewChatAnswer({ ...base, serverOnly: true })).toBe(false);
    expect(shouldReviewChatAnswer({ ...base, remoteWorker: true })).toBe(false);
    expect(shouldReviewChatAnswer({ ...base, aborted: true })).toBe(false);
  });
});

describe("runChatAnswerReview", () => {
  it("makes one no-tools call on the turn's route with utility cost attribution and records a pass", async () => {
    const createChatCompletion = vi.fn(async () => completion('{"verdict":"pass","issues":[]}'));
    const review = await runChatAnswerReview({ createChatCompletion }, reviewInput());

    expect(review).toEqual({
      depth: "standard",
      outcome: "passed",
      issues: [],
      action: "recorded",
      providerId: "openai",
      model: "gpt-5.4",
      reviewedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(createChatCompletion).toHaveBeenCalledOnce();
    const [request, attribution] = createChatCompletion.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(request).toMatchObject({ providerId: "openai", model: "gpt-5.4", stream: false });
    expect(request.tools).toBeUndefined();
    expect(request.memory).toEqual({ enabled: false, mode: "off", sessionId: "session-1", workspace: "default" });
    const userPayload = JSON.parse((request.messages as Array<{ content: string }>)[1]!.content);
    expect(userPayload).toMatchObject({
      request: "What is the capital of France?",
      answer: "Paris.",
      evidence: { sources: [{ url: "https://example.test/france", title: "France" }] },
    });
    expect(attribution).toMatchObject({
      callKind: "utility",
      utilityKind: "chat_answer_review",
      operationId: "chat-turn:turn-1:answer-review",
      turnId: "turn-1",
      sessionId: "session-1",
    });
  });

  it("records standard issues without asking to change the answer", async () => {
    const review = await runChatAnswerReview(
      { createChatCompletion: async () => completion('{"verdict":"issues","issues":["The source says Lyon."]}') },
      reviewInput("standard"),
    );
    expect(review).toMatchObject({ outcome: "issues_found", issues: ["The source says Lyon."], action: "recorded" });
    expect(buildStrictReviewNote(review)).toBeUndefined();
  });

  it("notes strict issues in the answer", async () => {
    const review = await runChatAnswerReview(
      {
        createChatCompletion: async () =>
          completion('{"verdict":"issues","issues":["Unsupported claim A.","Missed part B."]}'),
      },
      reviewInput("strict"),
    );
    expect(review).toMatchObject({ depth: "strict", outcome: "issues_found", action: "noted_in_answer" });
    const note = buildStrictReviewNote(review);
    expect(note).toContain("strict review of this answer found 2 possible issues");
    expect(note).toContain("- Unsupported claim A.");
    expect(note).toContain("- Missed part B.");
  });

  it("records a provider failure as unavailable instead of throwing", async () => {
    const review = await runChatAnswerReview(
      {
        createChatCompletion: async () => {
          throw new Error("provider returned 503");
        },
      },
      reviewInput("strict"),
    );
    expect(review).toMatchObject({
      outcome: "unavailable",
      reason: "The model provider returned an error (HTTP 503).",
      issues: [],
      action: "recorded",
    });
    expect(buildStrictReviewNote(review)).toBeUndefined();
  });

  it("never records the raw provider error, which can echo credentials or request content", async () => {
    const leaky = 'HTTP 401: invalid key sk-live-abcdef0123456789 for request {"messages":["secret prompt"]}';
    const review = await runChatAnswerReview(
      {
        createChatCompletion: async () => {
          throw new Error(leaky);
        },
      },
      reviewInput(),
    );
    expect(review.reason).toBe("The model provider returned an error (HTTP 401).");
    expect(JSON.stringify(review)).not.toContain("sk-live");
    expect(JSON.stringify(review)).not.toContain("secret prompt");
    expect(classifyReviewFailure(new Error("answer review timed out"))).toBe("The reviewer call timed out.");
    expect(classifyReviewFailure(new Error("socket hang up"))).toBe("The reviewer call failed.");
  });

  it("binds the reviewer call to the conversation's workspace and session with memory off", async () => {
    let request: Parameters<ChatAnswerReviewDeps["createChatCompletion"]>[0] | undefined;
    await runChatAnswerReview(
      {
        createChatCompletion: async (sent) => {
          request = sent;
          return completion('{"verdict":"pass","issues":[]}');
        },
      },
      { ...reviewInput(), workspaceId: "ws-other", sessionId: "session-9" },
    );
    expect(request?.memory).toMatchObject({ enabled: false, workspace: "ws-other", sessionId: "session-9" });
  });

  it("records an unreadable verdict as unavailable", async () => {
    const review = await runChatAnswerReview(
      { createChatCompletion: async () => completion("Looks fine to me!") },
      reviewInput(),
    );
    expect(review).toMatchObject({ outcome: "unavailable", reason: "The reviewer's verdict could not be read." });
  });

  it("still propagates authoritative model-usage accounting errors", async () => {
    const accountingError = Object.assign(new Error("usage ledger write failed"), {
      name: "ModelUsageSettlementError",
    });
    await expect(
      runChatAnswerReview(
        {
          createChatCompletion: async () => {
            throw accountingError;
          },
        },
        reviewInput(),
      ),
    ).rejects.toBe(accountingError);
  });
});

describe("parseReviewVerdict", () => {
  it("bounds the issue list and drops blanks", () => {
    const issues = Array.from({ length: 8 }, (_, index) => `Issue ${index}`);
    expect(parseReviewVerdict(JSON.stringify({ verdict: "issues", issues: ["", ...issues] }))?.issues).toHaveLength(5);
  });

  it("treats an issues verdict with no issues as unreadable", () => {
    expect(parseReviewVerdict('{"verdict":"issues","issues":[]}')).toBeUndefined();
  });
});

describe("reviewPreparedTurnAnswer", () => {
  const trace = { sessionId: "session-1", routing: { effectiveProviderId: "anthropic", effectiveModel: "claude" } };

  function host(response: ChatCompletionResponse) {
    return {
      createChatCompletion: vi.fn(async () => response),
      storage: { chatToolRuns: { listByTurn: vi.fn(async () => []) } },
    };
  }

  function prepared(depth: "off" | "standard" | "strict") {
    return {
      turnId: "turn-1",
      workspaceId: "default",
      content: "hello",
      session: { sessionId: "session-1" },
      prefs: { orchestrationReviewDepth: depth, providerId: "openai", model: "gpt-5.4" },
    };
  }

  it("does not call the reviewer when review is off", async () => {
    const reviewHost = host(completion('{"verdict":"pass"}'));
    const result = await reviewPreparedTurnAnswer(reviewHost, prepared("off"), {
      answer: "hi",
      status: "completed",
      trace,
      citations: [],
    });
    expect(result).toBeUndefined();
    expect(reviewHost.createChatCompletion).not.toHaveBeenCalled();
  });

  it("reviews on the turn's effective route when on", async () => {
    const reviewHost = host(completion('{"verdict":"pass","issues":[]}'));
    const result = await reviewPreparedTurnAnswer(reviewHost, prepared("standard"), {
      answer: "hi",
      status: "completed",
      trace,
      citations: [],
    });
    expect(result?.record).toMatchObject({ outcome: "passed", providerId: "anthropic", model: "claude" });
    expect(result?.note).toBeUndefined();
    expect(reviewHost.createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "anthropic", model: "claude" }),
      expect.anything(),
    );
  });
});
