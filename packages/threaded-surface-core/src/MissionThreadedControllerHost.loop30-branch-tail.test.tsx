import { describe, expect, it } from "vitest";
import type { ChatAttachmentRecord, ChatSessionPrefsRecord, RoutingPreflightResult } from "@goatcitadel/contracts";
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
    requestedModel: "gpt-5",
    effectiveProviderId: "openai",
    effectiveModel: "gpt-5",
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
    attachmentId: "a",
    fileName: "file.txt",
    mimeType: "text/plain",
    mediaType: "text",
    sizeBytes: 1,
    createdAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  } as ChatAttachmentRecord;
}

const prefs = (overrides: Partial<ChatSessionPrefsRecord> = {}) =>
  ({
    sessionId: "session-1",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    toolAutonomy: "safe_auto",
    planningMode: "off",
    ...overrides,
  }) as ChatSessionPrefsRecord;

describe("MissionThreadedControllerHost loop 30 branch matrix", () => {
  it("formats routing, fallback, runtime, and boundary summaries", () => {
    const labels = new Map([["openai", "OpenAI"]]);
    expect(formatRoutingTargetSummary(labels, "openai", "gpt-5")).toBe("OpenAI / gpt-5");
    expect(formatRoutingTargetSummary(labels, "custom", undefined)).toBe("custom");
    expect(formatRoutingTargetSummary(labels, undefined, "model-only")).toBe("model-only");

    expect(formatFallbackSummary(null)).toEqual({ summary: "Fallback off", tone: "muted" });
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

    expect(formatRuntimeSummary(preflight({ runtimeReachability: "reachable", runtimeClass: "local" }))).toEqual({
      summary: "Runtime reachable",
      tone: "success",
    });
    expect(formatRuntimeSummary(preflight({ runtimeReachability: "unreachable", runtimeClass: "cloud" }))).toEqual({
      summary: "Provider unreachable",
      tone: "critical",
    });
    expect(
      formatRuntimeSummary(preflight({ runtimeReachability: "models_unavailable", runtimeClass: "local" })),
    ).toEqual({ summary: "Models unavailable", tone: "warning" });
    expect(requiresBoundaryAcknowledgment(preflight({ fallbackResult: "local_to_cloud" }))).toBe(true);
    expect(requiresBoundaryAcknowledgment(preflight({ fallbackResult: "none" }))).toBe(false);
  });

  it("reconciles attachment document modes and execution prefs without mutating empty selections", () => {
    expect(
      reconcilePendingAttachmentModes(
        { ready: "full_text", pending: "full_text", pdf: "retrieval", stale: "retrieval" },
        [
          attachment({ attachmentId: "image", mediaType: "image", mimeType: "image/png" }),
          attachment({ attachmentId: "ready", extractStatus: "ready" }),
          attachment({ attachmentId: "pending", extractStatus: "pending", extractPreview: "" }),
          attachment({ attachmentId: "pdf", mimeType: "application/pdf" }),
          attachment({
            attachmentId: "ocr",
            mediaType: "binary",
            mimeType: "application/octet-stream",
            ocrText: "Text",
          }),
        ],
      ),
    ).toEqual({ ready: "full_text", pending: "message", pdf: "retrieval", ocr: "message" });

    expect(resolveExecutionRoutePrefs(null, "code")).toBeNull();
    expect(resolveExecutionRoutePrefs(prefs(), "cowork", "openai", "gpt-5")).toMatchObject({
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5",
    });
    expect(
      resolveExecutionRoutePrefs(prefs({ providerId: "anthropic", model: "claude" }), "code", "openai", "gpt-5"),
    ).toMatchObject({ providerId: "anthropic", model: "claude", mode: "code" });

    expect(runWithSelectedSessionId(null, () => "ran")).toBeUndefined();
    expect(runWithSelectedSessionId("session-1", (sessionId) => sessionId)).toBe("session-1");
    expect(runWithSelectedSession(undefined, () => "ran")).toBeUndefined();
    expect(runWithSelectedSession({ sessionId: "session-1", title: "T" } as any, (session) => session.title)).toBe("T");
  });
});
