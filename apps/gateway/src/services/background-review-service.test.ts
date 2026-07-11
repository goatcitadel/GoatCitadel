import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  OperatorProfileFact,
  OperatorProfileRecord,
} from "@goatcitadel/contracts";
import {
  BackgroundReviewService,
  type BackgroundReviewServiceDeps,
  type BackgroundReviewTurnInput,
} from "./background-review-service.js";
import type { RecordOperatorProfileFactsResult } from "./operator-profile-service.js";
import type { SkillMutationResult } from "./skill-mutation-service.js";

function modelResponse(content: string): ChatCompletionResponse {
  return { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function factsPayload(entries: unknown[]): string {
  return JSON.stringify({ facts: entries });
}

function profileRecord(facts: OperatorProfileFact[] = []): OperatorProfileRecord {
  return {
    operatorProfileId: "op_1",
    workspaceId: "default",
    summary: "",
    facts,
    revision: facts.length > 0 ? 2 : 1,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

function skillMutationResult(skillId: string): SkillMutationResult {
  return {
    skillId,
    skillDir: `/root/skills/self/${skillId}`,
    skillFilePath: `/root/skills/self/${skillId}/SKILL.md`,
    lifecycle: {
      skillId,
      category: "self_generated",
      lifecycleState: "candidate",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    },
    snapshot: {
      skillId,
      skillFilePath: `/root/skills/self/${skillId}/SKILL.md`,
      existed: false,
      capturedAt: "2026-06-22T00:00:00.000Z",
    },
    validation: { valid: true, errors: [], inferredSkillId: skillId },
    changeHash: "deadbeef",
  };
}

interface HarnessOptions {
  /** Sequential responses; one per model call in order (memory, then skill). */
  responses?: ChatCompletionResponse[];
  reject?: boolean;
  apiStyle?: ReturnType<BackgroundReviewServiceDeps["resolveApiStyle"]>;
  /** Outcome of the operator-profile write. */
  recordOutcome?: RecordOperatorProfileFactsResult["outcome"];
  recordThrows?: boolean;
  draftThrows?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const recordedFacts: OperatorProfileFact[][] = [];
  const draftedSkills: Array<Parameters<BackgroundReviewServiceDeps["draftSkillMutation"]>[0]> = [];
  let callIndex = 0;

  const createChatCompletion = vi.fn(async (_request: ChatCompletionRequest) => {
    if (options.reject) {
      throw new Error("model unavailable");
    }
    const response = options.responses?.[callIndex] ?? modelResponse(factsPayload([]));
    callIndex += 1;
    return response;
  });

  const recordOperatorProfileFacts = vi.fn(
    (_workspaceId: string, facts: OperatorProfileFact[]): RecordOperatorProfileFactsResult => {
      if (options.recordThrows) {
        throw new Error("write failed");
      }
      recordedFacts.push(facts);
      const outcome = options.recordOutcome ?? "applied";
      return {
        record: profileRecord(outcome === "applied" ? facts : []),
        outcome,
        blockedFacts: [],
        ...(outcome === "proposed" ? { proposedFacts: facts } : {}),
      };
    },
  );

  const draftSkillMutation = vi.fn(
    async (input: Parameters<BackgroundReviewServiceDeps["draftSkillMutation"]>[0]): Promise<SkillMutationResult> => {
      if (options.draftThrows) {
        throw new Error("skill rejected");
      }
      draftedSkills.push(input);
      return skillMutationResult(input.skillId ?? "authored-skill");
    },
  );

  const deps: BackgroundReviewServiceDeps = {
    createChatCompletion,
    resolveModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
    resolveApiStyle: () => options.apiStyle ?? "openai-chat-completions",
    recordOperatorProfileFacts,
    draftSkillMutation,
    now: () => new Date("2026-06-22T00:00:00.000Z"),
  };
  const service = new BackgroundReviewService(deps);
  return {
    service,
    createChatCompletion,
    recordOperatorProfileFacts,
    draftSkillMutation,
    recordedFacts,
    draftedSkills,
  };
}

const ELIGIBLE: BackgroundReviewTurnInput = {
  sessionId: "session-1",
  sourceTurnId: "turn-current",
  workspaceId: "default",
  userText: "I always want concise answers and I'm building a SaaS for dentists.",
  assistantText: "Got it — I'll keep it concise.",
  autonomyEnabled: true,
  evalIntegrityTurn: false,
  humanSession: true,
  turnSucceeded: true,
};

const DURABLE_FACT = {
  kind: "preference",
  content: "Prefers concise answers",
  confidence: 0.9,
};

describe("BackgroundReviewService — guards (safety invariants)", () => {
  it("does not run on autonomy-disabled turns (no model call, no writes)", async () => {
    const { service, createChatCompletion, recordOperatorProfileFacts, draftSkillMutation } = createHarness();
    const result = await service.runBackgroundReview({ ...ELIGIBLE, autonomyEnabled: false });
    expect(result.ran).toBe(false);
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(recordOperatorProfileFacts).not.toHaveBeenCalled();
    expect(draftSkillMutation).not.toHaveBeenCalled();
  });

  it("does not run on eval-integrity turns", async () => {
    const { service, createChatCompletion } = createHarness();
    const result = await service.runBackgroundReview({ ...ELIGIBLE, evalIntegrityTurn: true });
    expect(result.ran).toBe(false);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("does not run on non-human sessions", async () => {
    const { service, createChatCompletion } = createHarness();
    const result = await service.runBackgroundReview({ ...ELIGIBLE, humanSession: false });
    expect(result.ran).toBe(false);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("does not run on failed turns", async () => {
    const { service, createChatCompletion } = createHarness();
    const result = await service.runBackgroundReview({ ...ELIGIBLE, turnSucceeded: false });
    expect(result.ran).toBe(false);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("does not run on an empty transcript (no model call)", async () => {
    const { service, createChatCompletion } = createHarness();
    const result = await service.runBackgroundReview({ ...ELIGIBLE, userText: "   ", assistantText: "" });
    expect(result.ran).toBe(false);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });
});

describe("BackgroundReviewService — memory extraction", () => {
  it("persists durable, high-confidence facts via the governed profile service", async () => {
    const { service, recordedFacts, recordOperatorProfileFacts } = createHarness({
      responses: [modelResponse(factsPayload([DURABLE_FACT]))],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(result.ran).toBe(true);
    expect(recordOperatorProfileFacts).toHaveBeenCalledTimes(1);
    expect(recordedFacts[0]).toEqual([{ kind: "preference", content: "Prefers concise answers", confidence: 0.9 }]);
    expect(result.summaryMarker).toContain("updated durable memory");
  });

  it("uses a cheap structured request (json_object + low temperature on chat style)", async () => {
    const { service, createChatCompletion } = createHarness({
      responses: [modelResponse(factsPayload([DURABLE_FACT]))],
    });
    await service.runBackgroundReview(ELIGIBLE);
    const request = createChatCompletion.mock.calls[0]?.[0];
    expect(request?.response_format).toEqual({ type: "json_object" });
    expect(request?.temperature).toBe(0.1);
  });

  it("omits response_format/temperature for openai-codex-responses style", async () => {
    const { service, createChatCompletion } = createHarness({
      apiStyle: "openai-codex-responses",
      responses: [modelResponse(factsPayload([DURABLE_FACT]))],
    });
    await service.runBackgroundReview(ELIGIBLE);
    const request = createChatCompletion.mock.calls[0]?.[0];
    expect(request?.response_format).toBeUndefined();
    expect(request?.temperature).toBeUndefined();
  });

  it("drops low-confidence facts below the durability gate", async () => {
    const { service, recordOperatorProfileFacts } = createHarness({
      responses: [
        modelResponse(
          factsPayload([
            { kind: "fact", content: "Uses Postgres", confidence: 0.3 },
            { kind: "preference", content: "Prefers concise answers", confidence: 0.95 },
          ]),
        ),
      ],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(result.memoryFacts.map((fact) => fact.content)).toEqual(["Prefers concise answers"]);
    expect(recordOperatorProfileFacts).toHaveBeenCalledTimes(1);
  });

  it("does not write memory when nothing durable survives (no profile call)", async () => {
    const { service, recordOperatorProfileFacts } = createHarness({
      responses: [modelResponse(factsPayload([{ kind: "fact", content: "Uses Postgres", confidence: 0.2 }]))],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(result.ran).toBe(true);
    expect(result.memoryFacts).toEqual([]);
    expect(recordOperatorProfileFacts).not.toHaveBeenCalled();
    expect(result.summaryMarker).toBeUndefined();
  });
});

describe("BackgroundReviewService — anti-self-poisoning filter", () => {
  it("drops transient / environment-failure 'facts' so they never harden into rules", async () => {
    const { service, recordOperatorProfileFacts } = createHarness({
      responses: [
        modelResponse(
          factsPayload([
            { kind: "fact", content: "The web search tool failed with a 503 this session", confidence: 0.99 },
            { kind: "constraint", content: "Cannot use the browser tool", confidence: 0.99 },
            { kind: "fact", content: "The deploy API is currently unavailable", confidence: 0.99 },
            { kind: "fact", content: "Rate limit 429 hit, must retry", confidence: 0.99 },
            { kind: "preference", content: "Prefers TypeScript over JavaScript", confidence: 0.9 },
          ]),
        ),
      ],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    // Only the durable, non-poisoning fact survives.
    expect(result.memoryFacts.map((fact) => fact.content)).toEqual(["Prefers TypeScript over JavaScript"]);
    expect(recordOperatorProfileFacts).toHaveBeenCalledTimes(1);
  });

  it("drops negative tool/capability claims (would harden into refusals)", async () => {
    const { service, recordOperatorProfileFacts } = createHarness({
      responses: [
        modelResponse(
          factsPayload([
            { kind: "fact", content: "I can't send emails", confidence: 0.95 },
            { kind: "fact", content: "The shell command always fails", confidence: 0.95 },
          ]),
        ),
      ],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(result.memoryFacts).toEqual([]);
    expect(recordOperatorProfileFacts).not.toHaveBeenCalled();
  });
});

describe("BackgroundReviewService — skill authoring", () => {
  const SKILL_MD =
    "---\nname: summarize-csv-exports\ndescription: Summarize CSV exports into a brief.\n---\n\n# Summarize CSV exports\n\n1. Read the CSV.\n2. Produce a brief.\n";

  it("drafts exactly one candidate skill when a reusable procedure emerged", async () => {
    const { service, draftSkillMutation, draftedSkills } = createHarness({
      responses: [
        modelResponse(factsPayload([])),
        modelResponse(
          JSON.stringify({
            shouldAuthor: true,
            skillId: "summarize-csv-exports",
            skillMarkdown: SKILL_MD,
            summary: "How to summarize CSV exports",
          }),
        ),
      ],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(draftSkillMutation).toHaveBeenCalledTimes(1);
    expect(draftedSkills[0]?.skillId).toBe("summarize-csv-exports");
    expect(draftedSkills[0]?.sourceTurnId).toBe("turn-current");
    expect(result.skillProposed).toBe(true);
    expect(result.skillMutation?.skillId).toBe("summarize-csv-exports");
    expect(result.summaryMarker).toContain('drafted skill "summarize-csv-exports"');
  });

  it("authors nothing when the model declines (shouldAuthor=false)", async () => {
    const { service, draftSkillMutation } = createHarness({
      responses: [modelResponse(factsPayload([])), modelResponse(JSON.stringify({ shouldAuthor: false }))],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(draftSkillMutation).not.toHaveBeenCalled();
    expect(result.skillProposed).toBe(false);
    expect(result.skillMutation).toBeUndefined();
  });

  it("authors nothing when shouldAuthor=true but no markdown is provided", async () => {
    const { service, draftSkillMutation } = createHarness({
      responses: [
        modelResponse(factsPayload([])),
        modelResponse(JSON.stringify({ shouldAuthor: true, summary: "missing body" })),
      ],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(draftSkillMutation).not.toHaveBeenCalled();
    expect(result.skillProposed).toBe(false);
  });
});

describe("BackgroundReviewService — autonomy-off propose-only + best-effort safety", () => {
  it("surfaces a 'proposed' marker when the governed write holds facts for review", async () => {
    const { service } = createHarness({
      recordOutcome: "proposed",
      responses: [modelResponse(factsPayload([DURABLE_FACT]))],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    // The service still hands facts to the governed gate; the gate decides apply
    // vs propose. Under propose-only the marker reflects that nothing auto-applied.
    expect(result.summaryMarker).toContain("proposed durable memory");
    expect(result.summaryMarker).not.toContain("updated durable memory");
  });

  it("never throws when the model call fails (returns ran:true, nothing written)", async () => {
    const { service, recordOperatorProfileFacts, draftSkillMutation } = createHarness({ reject: true });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(result.ran).toBe(true);
    expect(result.memoryFacts).toEqual([]);
    expect(recordOperatorProfileFacts).not.toHaveBeenCalled();
    expect(draftSkillMutation).not.toHaveBeenCalled();
    expect(result.summaryMarker).toBeUndefined();
  });

  it("never throws when the profile write throws (swallowed, no marker)", async () => {
    const { service } = createHarness({
      recordThrows: true,
      responses: [modelResponse(factsPayload([DURABLE_FACT]))],
    });
    await expect(service.runBackgroundReview(ELIGIBLE)).resolves.toMatchObject({ ran: true });
  });

  it("never throws when the skill draft is rejected (swallowed, no skill in result)", async () => {
    const { service } = createHarness({
      draftThrows: true,
      responses: [
        modelResponse(factsPayload([])),
        modelResponse(
          JSON.stringify({ shouldAuthor: true, skillMarkdown: "---\nname: x\ndescription: y\n---\n# x\n" }),
        ),
      ],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(result.ran).toBe(true);
    expect(result.skillMutation).toBeUndefined();
  });

  it("tolerates prose around the JSON object", async () => {
    const { service, recordedFacts } = createHarness({
      responses: [
        modelResponse('Sure: {"facts":[{"kind":"goal","content":"Launch the dentist SaaS","confidence":0.85}]} done'),
      ],
    });
    const result = await service.runBackgroundReview(ELIGIBLE);
    expect(result.memoryFacts).toEqual([{ kind: "goal", content: "Launch the dentist SaaS", confidence: 0.85 }]);
    expect(recordedFacts[0]).toHaveLength(1);
  });
});
