import { describe, expect, it } from "vitest";
import type {
  ChatAttachmentRecord,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import {
  formatFallbackSummary,
  formatRoutingTargetSummary,
  formatRuntimeSummary,
  reconcilePendingAttachmentModes,
  requiresBoundaryAcknowledgment,
  resolveExecutionRoutePrefs,
  runWithSelectedSession,
  runWithSelectedSessionId,
} from "./MissionThreadedControllerHost";

function preflight(overrides: Partial<RoutingPreflightResult>): RoutingPreflightResult {
  return {
    requestedProviderId: "openai",
    requestedModel: "gpt-5.5",
    effectiveProviderId: "openai",
    effectiveModel: "gpt-5.5",
    runtimeClass: "cloud",
    runtimeReachability: "not_checked",
    fallbackPolicy: "off",
    fallbackResult: "none",
    selectionSource: "manual",
    warnings: [],
    ...overrides,
  } as RoutingPreflightResult;
}

function attachment(overrides: Partial<ChatAttachmentRecord>): ChatAttachmentRecord {
  return {
    attachmentId: "attachment-1",
    fileName: "file.txt",
    mimeType: "text/plain",
    mediaType: "text",
    sizeBytes: 1,
    createdAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  } as ChatAttachmentRecord;
}

function prefs(overrides: Partial<ChatSessionPrefsRecord> = {}): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    providerId: undefined,
    model: undefined,
    toolAutonomy: "safe_auto",
    planningMode: "off",
    ...overrides,
  } as ChatSessionPrefsRecord;
}

describe("MissionThreadedControllerHost loop 23 branch tails", () => {
  it("formats routing, fallback, runtime, and boundary summaries across default and explicit states", () => {
    const labels = new Map([["openai", "OpenAI"]]);
    expect(formatRoutingTargetSummary(labels, "openai", "gpt-5.5")).toBe("OpenAI / gpt-5.5");
    expect(formatRoutingTargetSummary(labels, "custom-provider", undefined)).toBe("custom-provider");
    expect(formatRoutingTargetSummary(labels, undefined, "model-only")).toBe("model-only");

    expect(formatFallbackSummary(null)).toEqual({ summary: "Fallback off", tone: "muted" });
    expect(formatFallbackSummary(preflight({ fallbackPolicy: "off" }))).toEqual({
      summary: "Fallback off",
      tone: "muted",
    });
    expect(formatFallbackSummary(preflight({ fallbackPolicy: "auto", fallbackResult: "local_to_cloud" }))).toEqual({
      summary: "Fallback armed · local to cloud",
      tone: "warning",
    });
    expect(formatFallbackSummary(preflight({ fallbackPolicy: "auto", fallbackResult: "cloud_to_local" }))).toEqual({
      summary: "Fallback armed · cloud to local",
      tone: "warning",
    });
    expect(formatFallbackSummary(preflight({ fallbackPolicy: "auto", fallbackResult: "none" }))).toEqual({
      summary: "Fallback armed",
      tone: "warning",
    });

    expect(formatRuntimeSummary(null)).toEqual({ summary: "Runtime not checked", tone: "muted" });
    expect(formatRuntimeSummary(preflight({ runtimeReachability: "reachable", runtimeClass: "local" }))).toEqual({
      summary: "Runtime reachable",
      tone: "success",
    });
    expect(formatRuntimeSummary(preflight({ runtimeReachability: "reachable", runtimeClass: "cloud" }))).toEqual({
      summary: "Provider reachable",
      tone: "success",
    });
    expect(formatRuntimeSummary(preflight({ runtimeReachability: "unreachable", runtimeClass: "local" }))).toEqual({
      summary: "Runtime unreachable",
      tone: "critical",
    });
    expect(
      formatRuntimeSummary(preflight({ runtimeReachability: "models_unavailable", runtimeClass: "cloud" })),
    ).toEqual({
      summary: "Provider degraded",
      tone: "warning",
    });

    expect(requiresBoundaryAcknowledgment(null)).toBe(false);
    expect(requiresBoundaryAcknowledgment(preflight({ fallbackResult: "local_to_cloud" }))).toBe(true);
    expect(requiresBoundaryAcknowledgment(preflight({ fallbackResult: "cloud_to_local" }))).toBe(true);
    expect(requiresBoundaryAcknowledgment(preflight({ fallbackResult: "none" }))).toBe(false);
  });

  it("reconciles pending attachment modes for image, full text, retrieval, and stale state tails", () => {
    const reconciled = reconcilePendingAttachmentModes(
      {
        docReady: "full_text",
        docPending: "full_text",
        docRetrieval: "retrieval",
        stale: "retrieval",
      },
      [
        attachment({ attachmentId: "image", mediaType: "image", mimeType: "image/png" }),
        attachment({ attachmentId: "docReady", extractStatus: "ready" }),
        attachment({ attachmentId: "docPending", extractStatus: "pending", extractPreview: "   " }),
        attachment({ attachmentId: "docRetrieval", mimeType: "application/pdf" }),
        attachment({ attachmentId: "jsonDoc", mediaType: "binary", mimeType: "application/json" }),
        attachment({
          attachmentId: "ocrDoc",
          mediaType: "binary",
          mimeType: "application/octet-stream",
          ocrText: "Text",
        }),
      ],
    );

    expect(reconciled).toEqual({
      docReady: "full_text",
      docPending: "message",
      docRetrieval: "retrieval",
      jsonDoc: "message",
      ocrDoc: "message",
    });
  });

  it("resolves execution preferences and selected-session callbacks without mutating empty inputs", () => {
    expect(resolveExecutionRoutePrefs(null, "cowork", "openai", "gpt-5.5")).toBeNull();
    expect(resolveExecutionRoutePrefs(prefs({ providerId: "anthropic", model: "claude-4" }), "code")).toMatchObject({
      mode: "code",
      providerId: "anthropic",
      model: "claude-4",
    });
    expect(resolveExecutionRoutePrefs(prefs(), "cowork", "openai", "gpt-5.5")).toMatchObject({
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.5",
    });

    expect(runWithSelectedSessionId(null, () => "ran")).toBeUndefined();
    expect(runWithSelectedSessionId("", () => "ran")).toBeUndefined();
    expect(runWithSelectedSessionId("session-1", (sessionId) => `ran:${sessionId}`)).toBe("ran:session-1");

    const session = { sessionId: "session-1", title: "Mission" } as ChatSessionRecord;
    expect(runWithSelectedSession(undefined, () => "ran")).toBeUndefined();
    expect(runWithSelectedSession(session, (selected) => selected.title)).toBe("Mission");
  });
});
