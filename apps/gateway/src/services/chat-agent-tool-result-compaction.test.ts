import { describe, expect, it } from "vitest";
import {
  buildCompactToolResultMetadata,
  compactToolResultForExecutionProfile,
  compactToolResultForTurn,
  extractPersistableToolArtifactContent,
  safeSerializeToolResult,
  shouldPersistToolArtifactForAggregateBudget,
  summarizeVirtualizedToolResult,
  type PersistedToolArtifactSummary,
} from "./chat-agent-tool-result-compaction.js";

describe("chat-agent-tool-result-compaction", () => {
  it("keeps small textual results inline", () => {
    expect(extractPersistableToolArtifactContent("browser.fetch", { body: "short" })).toBeUndefined();
    expect(extractPersistableToolArtifactContent("browser.search", { text: "short" })).toBeUndefined();
  });

  it("virtualizes large body output with content type, snippet, and summary evidence", () => {
    const content = "x".repeat(12_001);

    const artifact = extractPersistableToolArtifactContent("browser.fetch", {
      body: content,
      bodySnippet: "preview",
      contentType: "text/html",
      status: 200,
    });

    expect(artifact).toMatchObject({
      content,
      contentType: "text/html",
      snippet: "preview",
      summary: "preview HTTP 200",
      virtualized: true,
      compactMode: "textual",
    });
  });

  it("uses the body prefix when no body snippet is supplied", () => {
    const content = "abcdef".repeat(3000);

    expect(extractPersistableToolArtifactContent("browser.fetch", { body: content })).toMatchObject({
      snippet: content.slice(0, 4000),
      contentType: undefined,
    });
  });

  it("virtualizes large text output as plain text", () => {
    const content = "result\n".repeat(3000);

    const artifact = extractPersistableToolArtifactContent("shell.exec", {
      text: content,
      textSnippet: "stdout preview",
    });

    expect(artifact).toMatchObject({
      content,
      contentType: "text/plain; charset=utf-8",
      snippet: content.slice(0, 4000),
      summary: "stdout preview",
      compactMode: "textual",
    });
  });

  it("virtualizes large structured output and ignores circular records", () => {
    const large = { results: Array.from({ length: 700 }, (_, index) => ({ index, value: "x".repeat(20) })) };
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(safeSerializeToolResult(circular)).toBeUndefined();
    expect(extractPersistableToolArtifactContent("browser.search", circular)).toBeUndefined();
    expect(extractPersistableToolArtifactContent("browser.search", large)).toMatchObject({
      contentType: "application/json; charset=utf-8",
      summary: "700 results returned.",
      compactMode: "structured",
    });
  });

  it("summarizes preferred diagnostics before falling back to generic artifact wording", () => {
    expect(summarizeVirtualizedToolResult("browser.fetch", { message: "failed", status: 503 })).toBe("failed HTTP 503");
    expect(summarizeVirtualizedToolResult("tool.large", {})).toBe(
      "Stored tool.large output as an artifact to keep live context compact.",
    );
  });

  it("keeps scalar metadata and result counts for structured compaction", () => {
    expect(
      buildCompactToolResultMetadata({
        url: "https://example.test",
        finalUrl: "https://example.test/final",
        status: 200,
        browserFailureClass: "none",
        path: "C:/workspace/goatcitadel_out/report.docx",
        bytesWritten: 4096,
        format: "docx",
        ignored: { nested: true },
        results: [{ title: "one" }],
        fallbackChain: ["primary", "fallback"],
      }),
    ).toEqual({
      url: "https://example.test",
      finalUrl: "https://example.test/final",
      status: 200,
      browserFailureClass: "none",
      path: "C:/workspace/goatcitadel_out/report.docx",
      bytesWritten: 4096,
      format: "docx",
      resultCount: 1,
      fallbackChain: ["primary", "fallback"],
    });
  });

  it("virtualizes a shell result whose serialized output exceeds the threshold", () => {
    const shellResult = {
      command: "pnpm test",
      cwd: "C:/workspace",
      executable: "pnpm",
      exitCode: 1,
      stdout: "test output line\n".repeat(1200),
      stderr: "",
      stdoutTruncated: true,
      envScrubbed: true,
    };

    expect(extractPersistableToolArtifactContent("shell.exec", shellResult)).toMatchObject({
      contentType: "application/json; charset=utf-8",
      virtualized: true,
      compactMode: "structured",
    });
  });

  it("preserves shell identity scalars and truncation flags in structured compaction", () => {
    expect(
      buildCompactToolResultMetadata({
        command: "pnpm test",
        cwd: "C:/workspace",
        executable: "pnpm",
        manager: "pnpm",
        kind: "test",
        exitCode: 1,
        pid: 4242,
        detached: false,
        stdoutTruncated: true,
        stderrTruncated: true,
        stdout: "not-a-scalar-key-so-dropped".repeat(10),
      }),
    ).toEqual({
      command: "pnpm test",
      cwd: "C:/workspace",
      executable: "pnpm",
      manager: "pnpm",
      kind: "test",
      exitCode: 1,
      pid: 4242,
      detached: false,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  });

  it("compacts textual artifacts without carrying the original body", () => {
    const compacted = compactToolResultForTurn(
      {
        body: "x".repeat(5000),
        text: "y".repeat(5001),
        bodySnippet: "body preview",
        contentType: "text/html",
      },
      artifact({ compactMode: "textual", snippet: undefined, contentType: undefined }),
    );

    expect(compacted.body).toBeUndefined();
    expect(compacted.text).toBe("y".repeat(4000));
    expect(compacted.snippet).toBe("body preview");
    expect(compacted.bodySnippet).toBe("body preview");
    expect(compacted).toMatchObject({
      artifactId: "artifact-1",
      artifactPath: "artifacts/tool-output.json",
      byteLength: 12001,
      originalByteLength: 12001,
      contentType: "text/html",
      virtualized: true,
      storedAsArtifact: true,
    });
  });

  it("compacts structured artifacts down to metadata and removes text payloads", () => {
    const compacted = compactToolResultForTurn(
      {
        text: "large text",
        url: "https://example.test",
        results: [{ title: "one" }, { title: "two" }],
      },
      artifact({ compactMode: "structured", snippet: "artifact preview", contentType: "application/json" }),
    );

    expect(compacted).toEqual({
      url: "https://example.test",
      resultCount: 2,
      artifactId: "artifact-1",
      artifactPath: "artifacts/tool-output.json",
      byteLength: 12001,
      originalByteLength: 12001,
      contentType: "application/json",
      snippet: "artifact preview",
      artifactSummary: "stored summary",
      virtualized: true,
      storedAsArtifact: true,
      bodySnippet: "artifact preview",
    });
  });

  it("preserves the bounded presentation manifest and package-audit receipt", () => {
    const compacted = compactToolResultForTurn(
      {
        path: "C:/workspace/goatcitadel_out/research.pptx",
        slideCount: 18,
        renderManifest: {
          slideCount: 18,
          contentSlideCount: 14,
          layoutCounts: { hero: 1, table: 6, sources: 4 },
          minimumFontSize: 10,
          minimumBodyFontSize: 16,
          hyperlinkCount: 42,
          sourceCount: 15,
          tableCount: 6,
          chartCount: 1,
          continuationCount: 4,
          visualCount: 8,
          authoredNoteCount: 0,
        },
        packageAudit: {
          passed: true,
          findings: [],
          observed: {
            slideCount: 18,
            hyperlinkCount: 42,
            uniqueHyperlinkTargetCount: 15,
            tableCount: 6,
            chartCount: 1,
            pictureCount: 1,
            authoredNoteCount: 0,
            layoutCounts: { hero: 1, table: 6, sources: 4 },
          },
        },
        designReport: { internal: "x".repeat(20_000) },
      },
      artifact({ compactMode: "structured", snippet: "artifact preview", contentType: "application/json" }),
    );

    expect(compacted).toMatchObject({
      renderManifest: {
        slideCount: 18,
        contentSlideCount: 14,
        layoutCounts: { hero: 1, table: 6, sources: 4 },
        minimumBodyFontSize: 16,
        hyperlinkCount: 42,
        sourceCount: 15,
        tableCount: 6,
        chartCount: 1,
      },
      packageAudit: {
        passed: true,
        findingCount: 0,
        observed: {
          slideCount: 18,
          hyperlinkCount: 42,
          uniqueHyperlinkTargetCount: 15,
        },
      },
    });
    expect(compacted.designReport).toBeUndefined();
  });

  it("preserves compact local-business research evidence during structured compaction", () => {
    const compacted = compactToolResultForTurn(
      {
        results: Array.from({ length: 700 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.test/${index}`,
        })),
        localBusinessResearch: {
          kind: "local_business_contact_research",
          workflow: "local_business.research",
          plan: {
            location: "91303",
            radiusMiles: 10,
            categories: ["board game and tabletop game store"],
            requireEmail: true,
            requireContactName: true,
          },
          stages: [
            {
              name: "candidate_discovery",
              status: "complete",
              summary: "Read search results.",
              resultCount: 700,
              sourceUrls: ["https://bgetabletop.com/"],
            },
          ],
          candidates: [
            {
              storeName: "BGE's Tabletop",
              website: "https://bgetabletop.com/",
              email: "games@boardgamingwitheducation.com",
              sourceUrls: ["https://bgetabletop.com/"],
              verificationStatus: "partial",
              evidence: [
                {
                  url: "https://bgetabletop.com/",
                  evidenceKind: "email",
                  confidence: "high",
                },
              ],
            },
          ],
          excluded: [{ reason: "blocked_or_secondary_listing_source", sourceUrl: "https://www.yelp.com/search" }],
          blockers: ["contact_name_not_verified_from_search_result"],
          verificationNote: "Source-backed public contact evidence only.",
        },
      },
      artifact({ compactMode: "structured", snippet: "artifact preview", contentType: "application/json" }),
    );

    expect(compacted.localBusinessResearch).toMatchObject({
      kind: "local_business_contact_research",
      workflow: "local_business.research",
      plan: {
        location: "91303",
        radiusMiles: 10,
        requireEmail: true,
        requireContactName: true,
      },
      stages: [
        expect.objectContaining({
          name: "candidate_discovery",
          resultCount: 700,
          sourceUrls: ["https://bgetabletop.com/"],
        }),
      ],
      candidates: [
        expect.objectContaining({
          storeName: "BGE's Tabletop",
          email: "games@boardgamingwitheducation.com",
          sourceUrls: ["https://bgetabletop.com/"],
          evidence: [expect.objectContaining({ evidenceKind: "email" })],
        }),
      ],
      excluded: [
        {
          reason: "blocked_or_secondary_listing_source",
          sourceUrl: "https://www.yelp.com/search",
        },
      ],
      blockers: ["contact_name_not_verified_from_search_result"],
    });
    expect(compacted.resultCount).toBe(700);
    expect(compacted.results).toBeUndefined();
  });

  it("removes text from structured compaction when artifact snippets fall back to result text", () => {
    const compacted = compactToolResultForTurn(
      {
        text: "structured text",
        title: "Result",
      },
      artifact({ compactMode: "structured", snippet: undefined }),
    );

    expect(compacted.text).toBeUndefined();
    expect(compacted.snippet).toBe("structured text");
    expect(compacted.bodySnippet).toBe("structured text");
  });

  it("keeps short text on textual compaction when no truncation is needed", () => {
    const compacted = compactToolResultForTurn(
      {
        text: "short text",
      },
      artifact({ compactMode: "textual", snippet: undefined }),
    );

    expect(compacted.text).toBe("short text");
    expect(compacted.snippet).toBe("short text");
  });

  it("trims quick-web browser search results to compact evidence", () => {
    const compacted = compactToolResultForExecutionProfile(
      "browser.search",
      {
        results: [
          { title: "One", url: "https://one.test", snippet: "x".repeat(700), extra: "ignored" },
          { title: "Two", url: "https://two.test", snippet: "two" },
          { title: "Three", url: "https://three.test", snippet: "three" },
          { title: "Four", url: "https://four.test", snippet: "four" },
        ],
      },
      "quick_web",
    );

    expect(compacted).toMatchObject({
      resultCount: 4,
      compactedForProfile: "quick_web",
    });
    expect(compacted.results).toHaveLength(3);
    expect((compacted.results as Array<Record<string, unknown>>)[0]).toEqual({
      title: "One",
      url: "https://one.test",
      snippet: "x".repeat(520),
    });
  });

  it("forces artifact persistence when the aggregate tool-result context budget would be exceeded", () => {
    const priorToolRuns = [
      {
        toolRunId: "run-1",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "browser.search",
        status: "executed",
        args: {},
        result: { text: "a".repeat(79_000) },
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as const;

    expect(
      shouldPersistToolArtifactForAggregateBudget({
        priorToolRuns,
        result: { text: "b".repeat(2_500) },
      }),
    ).toBe(true);
    expect(
      shouldPersistToolArtifactForAggregateBudget({
        priorToolRuns: [],
        result: { text: "small" },
      }),
    ).toBe(false);
  });
});

function artifact(overrides: Partial<PersistedToolArtifactSummary>): PersistedToolArtifactSummary {
  return {
    artifactId: "artifact-1",
    storageRelPath: "artifacts/tool-output.json",
    byteLength: 12001,
    summary: "stored summary",
    virtualized: true,
    compactMode: "textual",
    ...overrides,
  };
}
