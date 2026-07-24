import { describe, expect, it } from "vitest";
import type { ChatCitationRecord } from "@goatcitadel/contracts";
import {
  buildDelegationFailureGuidance,
  buildEmptyAssistantTurnFallbackText,
  ChatTurnCancelledError,
  dedupeChatCitations,
  detectDelegationRoles,
  inferDegradedAssistantTurnFailure,
  isChatTurnCancelledError,
  isImageMimeType,
  mergeExecutionPlanStepStatuses,
  readDurableCancellation,
  renderExecutionPlanAsMarkdown,
  splitIntoChunks,
  toTitleCase,
  truncateSummaryLine,
} from "./chat-turn-helpers.js";

describe("chat-turn-helpers", () => {
  it("detects cancellation errors without treating ordinary errors as cancelled turns", () => {
    expect(isChatTurnCancelledError(new ChatTurnCancelledError("turn-1"))).toBe(true);
    expect(isChatTurnCancelledError(new Error("chat turn cancelled by caller"))).toBe(true);
    expect(isChatTurnCancelledError(new Error("provider failed"))).toBe(false);
    expect(isChatTurnCancelledError("cancelled")).toBe(false);
  });

  it("accepts durable cancellation only from an actually aborted signal", () => {
    const cancellation = Object.assign(new Error("operator cancelled durable run"), {
      name: "DurableRunCancelledError",
    });
    expect(readDurableCancellation(undefined, cancellation)).toBeUndefined();
    expect(readDurableCancellation(new AbortController().signal, cancellation)).toBeUndefined();

    const controller = new AbortController();
    controller.abort(cancellation);
    expect(readDurableCancellation(controller.signal, cancellation)).toBe(cancellation);
  });

  it("chunks text with a defensive minimum chunk size", () => {
    expect(splitIntoChunks("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(splitIntoChunks("abc", 0)).toEqual(["a", "b", "c"]);
    expect(splitIntoChunks("", 4)).toEqual([]);
  });

  it("classifies degraded fallback-style assistant output", () => {
    expect(inferDegradedAssistantTurnFailure("I ran out of time before I could finish the research.")).toEqual(
      expect.objectContaining({
        failureClass: "unknown",
        retryable: true,
        recommendedAction: "retry_narrower",
      }),
    );
    expect(inferDegradedAssistantTurnFailure("Here is the finished answer.")).toBeUndefined();
  });

  it("detects roles and renders advisory execution plans with step metadata", () => {
    expect(detectDelegationRoles("Product, architect, coder, QA, and ops should review deployment.")).toEqual([
      "product",
      "architect",
      "coder",
      "qa",
      "ops",
    ]);
    expect(detectDelegationRoles("Route this through a multi-agent handoff.")).toEqual([
      "product",
      "architect",
      "coder",
    ]);

    const markdown = renderExecutionPlanAsMarkdown({
      mode: "cowork",
      objective: "Ship the release",
      summary: "Coordinate the release safely.",
      steps: [
        {
          stepId: "step-1",
          index: 0,
          objective: "Review rollout risk",
          successCriteria: "Known blockers listed",
          expectedOutput: "Risk memo",
          suggestedTools: ["browser.search"],
          dependsOnStepIds: ["planning"],
          delegatedRole: "ops",
        },
      ],
    });

    expect(markdown).toContain("## Cowork plan");
    expect(markdown).toContain("Success: Known blockers listed");
    expect(markdown).toContain("Suggested tools: browser.search");
    expect(markdown).toContain("Delegated role: ops");
  });

  it("merges execution plan status fields from step results", () => {
    const merged = mergeExecutionPlanStepStatuses(
      [
        { stepId: "planner", index: 0, objective: "Plan" },
        { stepId: "coder", index: 1, objective: "Build" },
      ],
      [
        {
          stepId: "result-missing-id",
          role: "coder",
          index: 1,
          status: "skipped",
          summary: "Skipped by policy",
          error: "approval required",
          startedAt: "2026-05-14T20:00:00.000Z",
          finishedAt: "2026-05-14T20:01:00.000Z",
          childSessionId: "child-session",
          childTurnId: "child-turn",
        },
      ],
    );

    expect(merged[0]).toEqual(expect.objectContaining({ stepId: "planner", objective: "Plan" }));
    expect(merged[1]).toEqual(
      expect.objectContaining({
        stepId: "coder",
        status: "cancelled",
        summary: "Skipped by policy",
        error: "approval required",
        childSessionId: "child-session",
        childTurnId: "child-turn",
      }),
    );
  });

  it("maps delegation failures to operator guidance", () => {
    expect(buildDelegationFailureGuidance("token expired", "researcher")).toContain("auth or permission barrier");
    expect(buildDelegationFailureGuidance("deadline exceeded", "qa-validator")).toContain("ran out of time");
    expect(buildDelegationFailureGuidance("policy denied", "coder")).toContain("restricted action");
    expect(buildDelegationFailureGuidance("input not found", "ops")).toContain("could not find");
    expect(buildDelegationFailureGuidance("provider crashed", "reviewer")).toContain("Retry the reviewer delegate");
  });

  it("deduplicates citations while preserving original identity and filling metadata gaps", () => {
    const citations: ChatCitationRecord[] = [
      {
        citationId: "citation-1",
        url: "https://example.com/Doc",
        sourceType: "web",
      },
      {
        citationId: "citation-2",
        url: "https://example.com/doc",
        title: "Example doc",
        snippet: "Useful excerpt",
      },
      {
        citationId: "citation-3",
        url: "memory://chunk-1",
        knowledge: {
          attachmentId: "attachment-1",
          chunkId: "chunk-1",
          retrievalMode: "layered",
        },
      },
      {
        citationId: "citation-4",
        url: "memory://chunk-1-copy",
        title: "Knowledge copy",
        provenance: {
          relationScope: "self",
          freshness: "recent",
          selectionReason: "selected by semantic-hint retrieval score 0.956",
          retrievalStrategy: "semantic_hints",
          matchSignals: {
            lexicalScore: 0.4,
            semanticHintScore: 0.2,
            recencyScore: 0.3,
            diversityScore: 0.056,
            totalScore: 0.956,
          },
        },
        knowledge: {
          attachmentId: "attachment-1",
          chunkId: "chunk-1",
          retrievalMode: "layered",
        },
      },
    ];

    expect(dedupeChatCitations(citations)).toEqual([
      {
        citationId: "citation-1",
        url: "https://example.com/Doc",
        title: "Example doc",
        snippet: "Useful excerpt",
        sourceType: "web",
      },
      {
        citationId: "citation-3",
        url: "memory://chunk-1",
        title: "Knowledge copy",
        provenance: {
          relationScope: "self",
          freshness: "recent",
          selectionReason: "selected by semantic-hint retrieval score 0.956",
          retrievalStrategy: "semantic_hints",
          matchSignals: {
            lexicalScore: 0.4,
            semanticHintScore: 0.2,
            recencyScore: 0.3,
            diversityScore: 0.056,
            totalScore: 0.956,
          },
        },
        knowledge: {
          attachmentId: "attachment-1",
          chunkId: "chunk-1",
          retrievalMode: "layered",
        },
      },
    ]);
  });

  it("formats small UI strings without touching non-image attachments", () => {
    expect(isImageMimeType("IMAGE/PNG")).toBe(true);
    expect(isImageMimeType("application/pdf")).toBe(false);
    expect(toTitleCase("qa-validator_role")).toBe("Qa Validator Role");
    expect(truncateSummaryLine("one\n  two\tthree", 20)).toBe("one two three");
    expect(truncateSummaryLine("0123456789", 6)).toBe("01234\u2026");
    expect(buildEmptyAssistantTurnFallbackText()).toContain("Preserved trace/tool evidence");
  });
});
