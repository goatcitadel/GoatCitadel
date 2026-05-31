import { describe, expect, it } from "vitest";
import type { MemoryCitation, TranscriptEvent } from "@goatcitadel/contracts";
import { buildCacheKey, buildQueryHash, buildSourcesHash, hashText } from "./cache.js";
import { collectMemoryCandidates } from "./candidate-collector.js";
import { rankMemoryCandidates } from "./candidate-ranker.js";
import { validateCitations } from "./citation-validator.js";
import { composeDistilledContext, composeFallbackContext } from "./context-composer.js";
import { buildDistillerPrompt, parseDistillerJson } from "./distiller.js";
import {
  clearRegisteredTokenEstimators,
  estimateTokens,
  estimateTokensFromText,
  registerTokenEstimator,
  truncateByTokenEstimate,
} from "./token-estimator.js";
import type { DistillationPayload, MemoryCandidate, RankedMemoryCandidate } from "./types.js";

function transcriptEvent(
  eventId: string,
  payload: Record<string, unknown>,
  timestamp = "2026-05-01T00:00:00.000Z",
): TranscriptEvent {
  return {
    eventId,
    actionId: `action-${eventId}`,
    idempotencyKey: `idem-${eventId}`,
    sessionId: "session-1",
    sessionKey: "session-key",
    timestamp,
    type: "message.user",
    actorType: "user",
    actorId: "user",
    payload,
  };
}

function candidate(
  candidateId: string,
  text: string,
  overrides?: Partial<RankedMemoryCandidate>,
): RankedMemoryCandidate {
  return {
    candidateId,
    sourceType: "file",
    sourceRef: "notes.md",
    text,
    rankScore: 0.5,
    rankSignals: {
      lexicalScore: 0.2,
      semanticHintScore: 0,
      recencyScore: 0.2,
      diversityScore: 0.1,
      totalScore: 0.5,
    },
    timestamp: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory candidate collection", () => {
  it("collects transcript payload variants and bounded file chunks", () => {
    const collected = collectMemoryCandidates(
      [
        {
          type: "transcript",
          events: [
            transcriptEvent("one", { message: "  direct message  " }),
            transcriptEvent("two", { content: "content field" }),
            transcriptEvent("three", {}),
            transcriptEvent("four", { nested: { value: 1 } }),
          ],
        },
        {
          type: "file",
          relativePath: "notes.md",
          content: "alpha beta gamma delta",
          modifiedAt: "2026-05-02T00:00:00.000Z",
        },
        {
          type: "file",
          relativePath: "ignored.md",
          content: "ignored",
          modifiedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      {
        maxTranscriptEvents: 4,
        maxFileCandidates: 2,
        maxCharsPerCandidate: 64,
      },
    );

    expect(collected.map((item) => `${item.candidateId}:${item.text}`)).toEqual([
      "t:one:direct message",
      "t:two:content field",
      't:four:{"nested":{"value":1}}',
      "f:notes.md#0:alpha beta gamma delta",
      "f:ignored.md#0:ignored",
    ]);
  });

  it("splits files into bounded chunks and respects the file candidate cap", () => {
    const collected = collectMemoryCandidates(
      [
        {
          type: "file",
          relativePath: "notes.md",
          content: "alpha beta gamma delta",
          modifiedAt: "2026-05-02T00:00:00.000Z",
        },
        {
          type: "file",
          relativePath: "ignored.md",
          content: "ignored",
          modifiedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      { maxTranscriptEvents: 0, maxFileCandidates: 2, maxCharsPerCandidate: 10 },
    );

    expect(collected.map((item) => `${item.candidateId}:${item.text}`)).toEqual([
      "f:notes.md#0:alpha beta",
      "f:notes.md#1:gamma del",
    ]);

    expect(
      collectMemoryCandidates(
        [{ type: "file", relativePath: "blank.md", content: "   ", modifiedAt: "2026-05-02T00:00:00.000Z" }],
        { maxTranscriptEvents: 0, maxFileCandidates: 1, maxCharsPerCandidate: 10 },
      ),
    ).toEqual([]);
  });

  it("honors zero candidate limits without leaking all transcript events", () => {
    expect(
      collectMemoryCandidates(
        [
          { type: "transcript", events: [transcriptEvent("one", { message: "should not appear" })] },
          { type: "file", relativePath: "notes.md", content: "abc", modifiedAt: "2026-05-01T00:00:00.000Z" },
          {
            type: "memory_item",
            itemId: "mem-1",
            namespace: "workspace/default",
            title: "Launch fact",
            content: "should not appear",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        { maxTranscriptEvents: 0, maxFileCandidates: 0, maxMemoryItems: 0, maxCharsPerCandidate: 0 },
      ),
    ).toEqual([]);
  });

  it("collects bounded semantic memory item candidates", () => {
    const collected = collectMemoryCandidates(
      [
        {
          type: "memory_item",
          itemId: "mem-1",
          namespace: "workspace/default",
          title: "Launch decision",
          content: "Use governed browser sessions for external research.",
          updatedAt: "2026-05-02T00:00:00.000Z",
          pinned: true,
          retrievalHints: ["browser automation", "external research"],
        },
        {
          type: "memory_item",
          itemId: "mem-2",
          namespace: "workspace/default",
          title: "Ignored",
          content: "Past the cap.",
          updatedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      { maxTranscriptEvents: 0, maxFileCandidates: 0, maxMemoryItems: 1, maxCharsPerCandidate: 120 },
    );

    expect(collected).toEqual([
      expect.objectContaining({
        candidateId: "m:mem-1",
        sourceType: "memory_item",
        sourceRef: "mem-1",
        text: expect.stringContaining("Launch decision (workspace/default)"),
        timestamp: "2026-05-02T00:00:00.000Z",
        retrievalHints: ["browser automation", "external research"],
      }),
    ]);
    expect(collected[0]?.text).toContain("Pinned memory");
  });

  it("truncates long transcript candidates with a marker", () => {
    const [item] = collectMemoryCandidates(
      [{ type: "transcript", events: [transcriptEvent("one", { message: "abcdefghijklmnopqrstuvwxyz" })] }],
      { maxTranscriptEvents: 1, maxFileCandidates: 0, maxCharsPerCandidate: 20 },
    );

    expect(item?.text).toBe("abcd\n...[truncated]");
  });
});

describe("memory ranking and citations", () => {
  it("scores lexical hits, recency bands, diversity, and deterministic sorting", () => {
    const ranked = rankMemoryCandidates(
      "alpha beta",
      [
        {
          candidateId: "f:old",
          sourceType: "file",
          sourceRef: "old.md",
          text: "alpha",
          timestamp: "2026-04-01T00:00:00.000Z",
        },
        {
          candidateId: "t:recent",
          sourceType: "transcript",
          sourceRef: "event-1",
          text: "alpha beta",
          timestamp: "2026-05-01T11:30:00.000Z",
        },
        {
          candidateId: "f:invalid",
          sourceType: "file",
          sourceRef: "invalid.md",
          text: "gamma",
          timestamp: "not-a-date",
        },
        {
          candidateId: "f:none",
          sourceType: "file",
          sourceRef: "none.md",
          text: "delta",
        },
      ],
      { maxCandidates: 10, nowIso: "2026-05-01T12:00:00.000Z" },
    );

    expect(ranked[0]?.candidateId).toBe("t:recent");
    expect(ranked[0]?.rankSignals).toMatchObject({
      lexicalScore: expect.any(Number),
      lexicalBm25Score: expect.any(Number),
      semanticHintScore: 0,
      recencyScore: 0.25,
      diversityScore: 0.1,
      totalScore: expect.any(Number),
    });
    expect(ranked.map((item) => item.candidateId)).toEqual(["t:recent", "f:old", "f:invalid", "f:none"]);
  });

  it("uses bounded semantic hints without overpowering lexical matches", () => {
    const ranked = rankMemoryCandidates(
      "browser research",
      [
        {
          candidateId: "m:hints",
          sourceType: "memory_item",
          sourceRef: "mem-1",
          text: "Operator preference.",
          retrievalHints: ["browser automation", "external research"],
          timestamp: "2026-05-01T11:30:00.000Z",
        },
        {
          candidateId: "f:lexical",
          sourceType: "file",
          sourceRef: "notes.md",
          text: "browser research",
          timestamp: "2026-05-01T11:30:00.000Z",
        },
      ],
      { maxCandidates: 10, nowIso: "2026-05-01T12:00:00.000Z" },
    );

    expect(ranked.map((item) => item.candidateId)).toEqual(["f:lexical", "m:hints"]);
    expect(ranked[1]?.rankSignals.semanticHintScore).toBe(0.2);
  });

  it("adds embedding scoring only when explicit vectors are present", () => {
    const ranked = rankMemoryCandidates(
      "external browsing supervision",
      [
        {
          candidateId: "m:browser",
          sourceType: "memory_item",
          sourceRef: "mem-browser",
          text: "Use governed browser sessions for external research.",
          embedding: [1, 0, 0],
          timestamp: "2026-05-01T00:00:00.000Z",
        },
        {
          candidateId: "f:same-text",
          sourceType: "file",
          sourceRef: "notes.md",
          text: "Use governed browser sessions for external research.",
          embedding: [1, 0, 0],
          timestamp: "2026-05-01T00:00:00.000Z",
        },
        {
          candidateId: "m:unrelated",
          sourceType: "memory_item",
          sourceRef: "mem-cake",
          text: "Cake recipe sugar butter flour.",
          embedding: [0, 1, 0],
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ],
      { maxCandidates: 10, nowIso: "2026-05-01T12:00:00.000Z", queryEmbedding: [1, 0, 0] },
    );

    expect(ranked[0]?.candidateId).toBe("m:browser");
    expect(ranked[0]?.rankSignals.semanticVectorScore).toBeGreaterThan(0);
    expect(ranked.find((item) => item.candidateId === "f:same-text")?.rankSignals.semanticVectorScore).toBeGreaterThan(
      0,
    );
    expect(ranked.find((item) => item.candidateId === "m:unrelated")?.rankSignals.semanticVectorScore).toBeUndefined();
  });

  it("uses at least one candidate limit and supports no lexical terms", () => {
    const ranked = rankMemoryCandidates(
      "a b",
      [
        { candidateId: "b", sourceType: "file", sourceRef: "b", text: "same" },
        { candidateId: "a", sourceType: "file", sourceRef: "a", text: "same" },
      ],
      { maxCandidates: 0, nowIso: "2026-05-01T00:00:00.000Z" },
    );

    expect(ranked.map((item) => item.candidateId)).toEqual(["a"]);
  });

  it("covers recency bands and exact candidate-id ties", () => {
    const ranked = rankMemoryCandidates(
      "alpha",
      [
        {
          candidateId: "same",
          sourceType: "file",
          sourceRef: "recent.md",
          text: "alpha",
          timestamp: "2026-05-01T10:00:00.000Z",
        },
        {
          candidateId: "same",
          sourceType: "file",
          sourceRef: "older.md",
          text: "alpha",
          timestamp: "2026-04-29T12:00:00.000Z",
        },
      ],
      { maxCandidates: 2, nowIso: "2026-05-01T12:00:00.000Z" },
    );

    expect(ranked.map((item) => item.sourceRef)).toEqual(["recent.md", "older.md"]);
    expect(ranked[0]?.rankScore).toBeGreaterThan(ranked[1]?.rankScore ?? 0);

    const exactTie = rankMemoryCandidates(
      "alpha",
      [
        {
          candidateId: "same",
          sourceType: "file",
          sourceRef: "one.md",
          text: "alpha",
          timestamp: "2026-05-01T12:00:00.000Z",
        },
        {
          candidateId: "same",
          sourceType: "file",
          sourceRef: "two.md",
          text: "alpha",
          timestamp: "2026-05-01T12:00:00.000Z",
        },
      ],
      { maxCandidates: 2, nowIso: "2026-05-01T12:00:00.000Z" },
    );
    expect(exactTie).toHaveLength(2);
  });

  it("validates citation ids against selected candidates", () => {
    const candidates: MemoryCandidate[] = [
      { candidateId: "one", sourceType: "file", sourceRef: "one.md", text: "one" },
    ];

    expect(
      validateCitations([{ candidateId: "one", sourceType: "file", sourceRef: "one.md", score: 1 }], candidates),
    ).toEqual({
      valid: true,
      invalidIds: [],
    });
    expect(
      validateCitations(
        [{ candidateId: "missing", sourceType: "file", sourceRef: "missing.md", score: 0 }],
        candidates,
      ),
    ).toEqual({
      valid: false,
      invalidIds: ["missing"],
    });
  });
});

describe("memory context composition and distillation", () => {
  it("builds distiller prompts and parses noisy JSON output", () => {
    const prompt = buildDistillerPrompt({
      prompt: "What matters?",
      candidates: [candidate("one", "Important evidence", { sourceType: "transcript", sourceRef: "event-1" })],
    });
    expect(prompt).toContain("ID=one");
    expect(prompt).toContain("User prompt:");

    const parsed = parseDistillerJson(`prefix {
      "summary": " Keep this ",
      "facts": [
        { "text": "Fact", "citationIds": ["one", 2, ""] },
        7,
        { "text": "", "citationIds": ["ignored"] }
      ],
      "risks": [" risk ", 7],
      "openQuestions": [" question? "],
      "saferNextSteps": [" next "],
      "citations": [
        { "candidateId": "one", "sourceType": "file", "sourceRef": "notes.md", "snippet": " text ", "score": 0.12345 },
        { "candidateId": "memory", "sourceType": "memory_item", "sourceRef": "mem-1", "score": 0.8 },
        { "candidateId": "two", "sourceType": "unknown", "sourceRef": "event-2", "score": "bad" },
        9,
        { "candidateId": "", "sourceRef": "ignored" }
      ]
    } suffix`);

    expect(parsed.payload).toEqual({
      summary: "Keep this",
      facts: [{ text: "Fact", citationIds: ["one"] }],
      risks: ["risk"],
      openQuestions: ["question?"],
      saferNextSteps: ["next"],
    });
    expect(parsed.citations).toEqual([
      { candidateId: "one", sourceType: "file", sourceRef: "notes.md", snippet: "text", score: 0.123 },
      { candidateId: "memory", sourceType: "memory_item", sourceRef: "mem-1", snippet: undefined, score: 0.8 },
      { candidateId: "two", sourceType: "transcript", sourceRef: "event-2", snippet: undefined, score: 0 },
    ]);
  });

  it("rejects missing JSON objects and empty payloads", () => {
    expect(() => parseDistillerJson("no object here")).toThrow("distiller output did not contain a JSON object");
    expect(() => parseDistillerJson('{"summary":"","facts":[]}')).toThrow("distillation payload is empty");
    expect(parseDistillerJson('{"summary":"ok","facts":null,"citations":null}').payload.summary).toBe("ok");
    expect(parseDistillerJson('[] {"summary":"ok"}').payload.summary).toBe("ok");
  });

  it("composes distilled and fallback contexts with citations and truncation", () => {
    const payload: DistillationPayload = {
      summary: "Summary text",
      facts: [{ text: "Fact text", citationIds: ["one"] }],
      risks: ["Risk text"],
      openQuestions: ["Question text"],
      saferNextSteps: ["Next step"],
    };
    const citations: MemoryCitation[] = [
      { candidateId: "one", sourceType: "file", sourceRef: "notes.md", snippet: "Fact", score: 0.9 },
    ];

    const composed = composeDistilledContext({ payload, citations, maxContextTokens: 200 });
    expect(composed.contextText).toContain("Summary:");
    expect(composed.contextText).toContain("Citations:");
    expect(composed.distilledTokenEstimate).toBeGreaterThan(0);

    const empty = composeDistilledContext({
      payload: { summary: " ", facts: [], risks: [], openQuestions: [], saferNextSteps: [] },
      citations: [],
      maxContextTokens: 20,
    });
    expect(empty.contextText).toBe("");
    expect(empty.distilledTokenEstimate).toBe(0);

    const fallback = composeFallbackContext(
      Array.from({ length: 7 }, (_, index) =>
        candidate(`candidate-${index}`, `candidate ${index} `.repeat(40), { rankScore: index / 10 }),
      ),
      80,
    );
    expect(fallback.contextText).toContain("Fallback Context:");
    expect(fallback.citations).toHaveLength(6);
    expect(fallback.citations[0]?.score).toBe(0);
  });
});

describe("memory cache keys and token estimator edge cases", () => {
  it("hashes query and source inputs deterministically", () => {
    const candidates = [candidate("one", "text", { timestamp: undefined, rankScore: 0.123456 })];
    expect(hashText("same")).toBe(hashText("same"));
    expect(buildQueryHash("  Mixed CASE  ")).toBe(buildQueryHash("mixed case"));
    expect(buildQueryHash("prompt", [1, 0])).toBe(buildQueryHash("prompt", [1, 0]));
    expect(buildQueryHash("prompt", [1, 0])).not.toBe(buildQueryHash("prompt", [0, 1]));
    expect(buildSourcesHash(candidates)).toBe(buildSourcesHash(candidates));
    const baseKey = buildCacheKey({
      scope: "chat",
      prompt: "Prompt",
      maxContextTokens: 100,
      relationScope: "self",
      candidates,
    });
    const embeddingKey = buildCacheKey({
      scope: "chat",
      prompt: "Prompt",
      maxContextTokens: 100,
      relationScope: "self",
      candidates,
      queryEmbedding: [1, 0],
    });
    const scopedKey = buildCacheKey({
      scope: "chat",
      prompt: "Prompt",
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-1",
      phaseId: "phase-1",
      maxContextTokens: 100,
      candidates,
    });
    expect(baseKey).toBeTypeOf("string");
    expect(scopedKey).toBeTypeOf("string");
    expect(scopedKey).not.toBe(baseKey);
    expect(embeddingKey).not.toBe(baseKey);
    expect(buildSourcesHash(candidates)).not.toBe(
      buildSourcesHash([candidate("one", "text", { timestamp: undefined, rankScore: 0.123451 })]),
    );
  });

  it("handles estimator registration replacement, invalid plugins, and truncation edge cases", () => {
    clearRegisteredTokenEstimators();
    registerTokenEstimator({ name: "exact", estimate: () => 1.2 });
    registerTokenEstimator({ name: "invalid", estimate: () => -1 });
    registerTokenEstimator({
      name: "unstable",
      estimate: () => {
        throw new Error("boom");
      },
    });
    registerTokenEstimator({ name: "exact", estimate: () => 2.2 });

    expect(estimateTokens("abc")).toEqual({ count: 3, mode: "exact", estimator: "exact" });
    clearRegisteredTokenEstimators();
    expect(estimateTokens("")).toEqual({ count: 0, mode: "heuristic", estimator: "empty" });
    expect(estimateTokensFromText("漢字かな mixedIdentifier path/to/file.ts www.example.com")).toBeGreaterThan(5);
    expect(truncateByTokenEstimate("alpha beta", 0)).toBe("");
    expect(truncateByTokenEstimate("", 10)).toBe("");
    expect(truncateByTokenEstimate("alpha beta", 100)).toBe("alpha beta");

    registerTokenEstimator({ name: "huge", estimate: () => 999 });
    expect(truncateByTokenEstimate("x", 1)).toBe("...[truncated]");
    clearRegisteredTokenEstimators();
  });
});
