import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import {
  BackgroundReviewService,
  buildBackgroundReviewMemoryEvidenceFingerprints,
  buildBackgroundReviewSkillEvidenceFingerprint,
  type BackgroundReviewServiceDeps,
  type BackgroundReviewTurnInput,
} from "./background-review-service.js";

function modelResponse(content: string): ChatCompletionResponse {
  return { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function factsPayload(entries: unknown[]): string {
  return JSON.stringify({ facts: entries });
}

const ELIGIBLE: BackgroundReviewTurnInput = {
  sessionId: "session-1",
  sourceTurnId: "turn-current",
  workspaceId: "default",
  userText: "I always want concise answers and I use a repeatable CSV review checklist.",
  assistantText: "Understood.",
  autonomyEnabled: true,
  evalIntegrityTurn: false,
  humanSession: true,
  turnSucceeded: true,
  effectExecutionId: "postcommit-child-1",
};

function createHarness(responses: ChatCompletionResponse[] = []) {
  let callIndex = 0;
  const createChatCompletion = vi.fn(async (_request: ChatCompletionRequest) => {
    const response = responses[callIndex] ?? modelResponse(factsPayload([]));
    callIndex += 1;
    return response;
  });
  const forbiddenMutations = {
    recordOperatorProfileFacts: vi.fn(),
    draftSkillMutation: vi.fn(),
    prepareDurableSkillMutation: vi.fn(),
    applyPreparedSkillMutationFilesSync: vi.fn(),
    commitPreparedSkillMutation: vi.fn(),
  };
  const deps = {
    createChatCompletion,
    resolveModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
    resolveApiStyle: () => "openai-chat-completions" as const,
    ...forbiddenMutations,
  } satisfies BackgroundReviewServiceDeps & typeof forbiddenMutations;
  return {
    service: new BackgroundReviewService(deps),
    createChatCompletion,
    forbiddenMutations,
  };
}

describe("BackgroundReviewService evidence-only contract", () => {
  it.each([
    ["autonomy disabled", { autonomyEnabled: false }],
    ["eval integrity", { evalIntegrityTurn: true }],
    ["non-human", { humanSession: false }],
    ["failed turn", { turnSucceeded: false }],
  ])("skips %s without a model or mutation call", async (_label, patch) => {
    const harness = createHarness();

    await expect(harness.service.runBackgroundReview({ ...ELIGIBLE, ...patch })).resolves.toEqual({
      ran: false,
      memoryFacts: [],
      memoryEvidenceFingerprints: [],
      skillProposed: false,
    });
    expect(harness.createChatCompletion).not.toHaveBeenCalled();
    for (const mutation of Object.values(harness.forbiddenMutations)) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("extracts filtered memory and skill evidence without any direct promotion", async () => {
    const harness = createHarness([
      modelResponse(
        factsPayload([
          { kind: "preference", content: "Prefers concise answers", confidence: 0.9 },
          { kind: "fact", content: "The API failed during this session", confidence: 0.99 },
          { kind: "constraint", content: "API token sk-example-secret-12345", confidence: 0.99 },
          { kind: "goal", content: "Low confidence noise", confidence: 0.2 },
        ]),
      ),
      modelResponse(JSON.stringify({ shouldAuthor: true, summary: "Review CSV exports with a stable checklist" })),
    ]);

    const result = await harness.service.runBackgroundReview(ELIGIBLE);

    expect(result).toMatchObject({
      ran: true,
      memoryFacts: [{ kind: "preference", content: "Prefers concise answers", confidence: 0.9 }],
      skillProposed: true,
    });
    expect(result.memoryEvidenceFingerprints).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(result.skillEvidenceFingerprint).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(result.summaryMarker).toBeUndefined();
    expect(result.skillMutation).toBeUndefined();
    for (const mutation of Object.values(harness.forbiddenMutations)) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("asks only for response-local skill evidence, never SKILL.md or activation content", async () => {
    const harness = createHarness([
      modelResponse(JSON.stringify({ shouldAuthor: true, summary: "A reusable review flow" })),
    ]);

    await harness.service.suggestSkill("User: demonstrate a reusable review flow");

    const request = harness.createChatCompletion.mock.calls[0]?.[0];
    const prompt = request?.messages.map((message) => message.content).join("\n") ?? "";
    expect(prompt).not.toContain("skillMarkdown");
    expect(prompt).not.toContain("SKILL.md");
    expect(prompt).toContain("never author a skill");
    expect(prompt).toContain("no Markdown or commands");
  });

  it("rejects markdown, commands, and secret-bearing skill evidence", async () => {
    const unsafeSummaries = [
      "```bash\nrm -rf /\n```",
      "Use token sk-example-secret-12345 in the workflow",
      "powershell Remove-Item -Recurse C:\\data",
    ];
    for (const summary of unsafeSummaries) {
      const harness = createHarness([modelResponse(JSON.stringify({ shouldAuthor: true, summary }))]);
      await expect(harness.service.suggestSkill("User: unsafe suggestion")).resolves.toEqual({ shouldAuthor: false });
    }
  });

  it("never accepts a legacy raw skillMarkdown payload as durable evidence", async () => {
    const harness = createHarness([
      modelResponse(
        JSON.stringify({
          shouldAuthor: true,
          skillMarkdown: "---\nname: raw\n---\n# Must never persist",
        }),
      ),
    ]);

    await expect(harness.service.suggestSkill("User: legacy response")).resolves.toEqual({ shouldAuthor: false });
  });

  it("produces stable content fingerprints and no raw content in the fingerprints", () => {
    const facts = [{ kind: "preference" as const, content: "Prefers concise answers", confidence: 0.9 }];
    const first = buildBackgroundReviewMemoryEvidenceFingerprints(facts);
    const second = buildBackgroundReviewMemoryEvidenceFingerprints(facts);
    const skillFirst = buildBackgroundReviewSkillEvidenceFingerprint({
      shouldAuthor: true,
      summary: "Review CSV exports with a stable checklist",
    });
    const skillSecond = buildBackgroundReviewSkillEvidenceFingerprint({
      shouldAuthor: true,
      summary: "Review CSV exports with a stable checklist",
    });

    expect(first).toEqual(second);
    expect(skillFirst).toBe(skillSecond);
    expect(first[0]).not.toContain("concise");
    expect(skillFirst).not.toContain("CSV");
    expect(
      buildBackgroundReviewMemoryEvidenceFingerprints([
        ...facts,
        { kind: "constraint", content: "API token sk-example-secret-12345", confidence: 0.99 },
        { kind: "fact", content: "The API failed during this session", confidence: 0.99 },
      ]),
    ).toEqual(first);
    expect(
      buildBackgroundReviewSkillEvidenceFingerprint({
        shouldAuthor: true,
        summary: "Use token sk-example-secret-12345 in the workflow",
      }),
    ).toBeUndefined();
  });

  it("remains best-effort when a provider read fails", async () => {
    const createChatCompletion = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const service = new BackgroundReviewService({
      createChatCompletion,
      resolveModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      resolveApiStyle: () => "openai-chat-completions",
    });

    await expect(service.runBackgroundReview(ELIGIBLE)).resolves.toEqual({
      ran: true,
      memoryFacts: [],
      memoryEvidenceFingerprints: [],
      skillProposed: false,
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
});
