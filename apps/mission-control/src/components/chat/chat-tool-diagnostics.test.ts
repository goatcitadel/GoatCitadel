import { describe, expect, it } from "vitest";

import { getChatToolRunDiagnostics, getTraceFallbackAttemptCount } from "./chat-tool-diagnostics";

describe("chat tool diagnostics", () => {
  it("extracts artifact, browser, HTTP, and fallback metadata from rich tool results", () => {
    const diagnostics = getChatToolRunDiagnostics({
      status: "completed",
      result: {
        url: " https://example.test/start ",
        finalUrl: "https://example.test/final",
        status: "200",
        engineTier: "browser",
        engineLabel: "Playwright",
        browserFailureClass: "",
        artifactSummary: " Saved screenshot ",
        storedAsArtifact: true,
        virtualized: true,
        artifactId: "artifact-1",
        artifactPath: "/tmp/artifact.png",
        originalByteLength: "512",
        fallbackChain: ["browser", "http", "cache"],
      },
    } as never);

    expect(diagnostics).toEqual({
      url: "https://example.test/start",
      finalUrl: "https://example.test/final",
      httpStatus: 200,
      engineTier: "browser",
      engineLabel: "Playwright",
      browserFailureClass: undefined,
      summary: "Saved screenshot",
      storedAsArtifact: true,
      outputVirtualized: true,
      artifactId: "artifact-1",
      artifactPath: "/tmp/artifact.png",
      artifactSummary: "Saved screenshot",
      originalByteLength: 512,
      fallbackAttemptCount: 2,
      hasFailureSignal: false,
    });
  });

  it("falls back through snippets, result counts, message fields, and failure signals", () => {
    expect(getChatToolRunDiagnostics({ status: "blocked", result: { snippet: "snippet" } } as never)).toMatchObject({
      finalUrl: undefined,
      summary: "snippet",
      fallbackAttemptCount: 0,
      hasFailureSignal: true,
    });
    expect(getChatToolRunDiagnostics({ status: "completed", result: { results: [] } } as never).summary).toBe(
      "No results returned.",
    );
    expect(getChatToolRunDiagnostics({ status: "completed", result: { results: [{}] } } as never).summary).toBe(
      "1 result returned.",
    );
    expect(getChatToolRunDiagnostics({ status: "completed", result: { results: [{}, {}] } } as never).summary).toBe(
      "2 results returned.",
    );
    expect(
      getChatToolRunDiagnostics({
        status: "failed",
        error: "tool failed",
        result: { httpStatus: 503, byteLength: 1024, message: "Gateway unavailable" },
      } as never),
    ).toMatchObject({
      httpStatus: 503,
      originalByteLength: 1024,
      summary: "Gateway unavailable",
      hasFailureSignal: true,
    });
    expect(getChatToolRunDiagnostics({ status: "completed", result: null } as never)).toMatchObject({
      storedAsArtifact: false,
      outputVirtualized: false,
      fallbackAttemptCount: 0,
      hasFailureSignal: false,
    });
  });

  it("sums fallback attempts across a trace", () => {
    expect(
      getTraceFallbackAttemptCount({
        toolRuns: [
          { status: "completed", result: { fallbackChain: ["a", "b"] } },
          { status: "completed", result: { fallbackChain: ["a", "b", "c"] } },
          { status: "completed", result: { fallbackChain: ["a"] } },
        ],
      } as never),
    ).toBe(3);
  });
});
