import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildFetchedContentBudgetFallback,
  buildRecoveredEvidenceAnswer,
  buildSearchResultBudgetFallback,
  collectObservedToolEvidencePaths,
  formatRecoveredSearchLead,
  inferBlockedSourceFailure,
  readBlockedSourceHost,
  recoverTitleUrlItems,
  summarizeToolRunForSynthesis,
  truncatePlainText,
} from "./chat-agent-recovered-answer.js";

describe("chat agent recovered answer helpers", () => {
  it("recovers search leads from nested results and explains blocked-source fallbacks", () => {
    const runs = [
      toolRun({
        toolName: "browser.search",
        result: {
          fallbackChain: [
            null,
            { browserFailureClass: "ignored", url: "not a url" },
            {
              browserFailureClass: "remote_blocked",
              finalUrl: "https://Blocked.Example/research",
            },
          ],
          results: [
            { title: "First lead", url: "https://example.com/first" },
            { name: "Second lead", href: "https://example.com/second" },
            { title: "Duplicate", url: "https://example.com/first" },
          ],
        },
      }),
    ];

    expect(inferBlockedSourceFailure(runs)).toEqual({
      host: "blocked.example",
      failureClass: "remote_blocked",
    });
    expect(recoverTitleUrlItems(runs, 5)).toEqual([
      { title: "First lead", url: "https://example.com/first" },
      { title: "Second lead", url: "https://example.com/second" },
    ]);
    expect(buildSearchResultBudgetFallback("quick", runs)).toContain(
      "A source blocked automated browsing on blocked.example",
    );
    expect(readBlockedSourceHost({ url: "not a url" })).toBeUndefined();
  });

  it("uses deep-search wording when budget recovery only has search leads", () => {
    const fallback = buildSearchResultBudgetFallback("deep", [
      toolRun({
        toolName: "browser.search",
        result: {
          results: [{ url: "https://example.com/deep-result" }],
        },
      }),
    ]);

    expect(fallback).toContain("full deep-research pass");
    expect(fallback).toContain("example.com");
  });

  it("summarizes fetched content while skipping blocked, short, and error responses", () => {
    const usefulText = [
      "Skip to content. Search support login. This website uses cookies.",
      "REST APIs are commonly used for mobile and web integrations across distributed environments and public API workflows.",
      "For example, teams use REST APIs to automate partner-facing services and connect cloud services reliably.",
    ].join(" ");
    const fallback = buildFetchedContentBudgetFallback(
      "deep",
      [
        toolRun({
          toolName: "browser.navigate",
          result: {
            status: 500,
            text: "This server error content should be skipped even though it is long enough to parse.",
          },
        }),
        toolRun({
          toolName: "browser.extract",
          result: {
            browserFailureClass: "remote_blocked",
            text: "Blocked content should be skipped even when it contains many words and enough characters.",
          },
        }),
        toolRun({
          toolName: "http.get",
          result: {
            title: "REST API use cases",
            url: "https://docs.example.com/rest",
            status: 200,
            bodySnippet: usefulText,
          },
        }),
      ],
      "What are the top 2 REST API use cases?",
    );

    expect(fallback).toContain("strongest relevant use cases");
    expect(fallback).toContain("mobile and web integrations");
    expect(fallback).toContain("Primary source: REST API use cases - https://docs.example.com/rest");
    expect(fallback).toContain("deep pass finished");
  });

  it("summarizes tool runs for synthesis across file, browser, and generic results", () => {
    expect(
      summarizeToolRunForSynthesis(
        toolRun({
          toolName: "file.read_range",
          result: { path: "src/a.ts", content: "export const value = 1;" },
        }),
      ),
    ).toContain("file: src/a.ts");
    expect(
      summarizeToolRunForSynthesis(
        toolRun({
          toolName: "file.read_range",
          result: { path: "src/empty.ts", content: "" },
        }),
      ),
    ).toBe('- file.read_range [executed] result: {"path":"src/empty.ts","content":""}');
    expect(
      summarizeToolRunForSynthesis(
        toolRun({
          toolName: "browser.search",
          result: {
            results: [
              {
                title: "Runtime trace",
                snippet:
                  "Runtime trace summaries include persisted evidence, provider status, and operator-visible diagnostics.",
              },
            ],
          },
        }),
      ),
    ).toContain("results: Runtime trace");
    expect(
      summarizeToolRunForSynthesis(
        toolRun({
          toolName: "browser.navigate",
          result: {
            finalUrl: "https://example.com/runtime",
            text: "Runtime APIs are used for workflow automation, partner-facing services, and mobile integrations in distributed environments.",
          },
        }),
        "workflow automation use cases",
      ),
    ).toContain("source: https://example.com/runtime");
    expect(
      summarizeToolRunForSynthesis(toolRun({ toolName: "custom.tool", result: { value: "x".repeat(400) } })),
    ).toContain("...");
    expect(collectObservedToolEvidencePaths([toolRun({ toolName: "code.search", result: { matches: [] } })])).toEqual(
      [],
    );
  });

  it("handles empty recovery inputs and plain text formatting boundaries", () => {
    expect(buildRecoveredEvidenceAnswer("Compare these systems", [], { note: "No evidence." })).toBeUndefined();
    expect(formatRecoveredSearchLead({ title: "  Named source  ", url: "https://example.com" })).toBe("Named source");
    expect(formatRecoveredSearchLead({ title: null, url: "not a url" })).toBe("not a url");
    expect(truncatePlainText("short", 10)).toBe("short");
    expect(truncatePlainText("x".repeat(80), 50)).toBe(`${"x".repeat(50)}...`);
  });

  it("handles top-level source blocks, comparison snippets, and word-boundary truncation", () => {
    expect(
      inferBlockedSourceFailure([
        toolRun({
          toolName: "browser.extract",
          args: { url: "https://Docs.Example/blocked" },
          result: { browserFailureClass: "http_error" },
        }),
      ]),
    ).toEqual({
      host: "docs.example",
      failureClass: "http_error",
    });

    expect(
      recoverTitleUrlItems(
        [
          toolRun({
            result: {
              nested: {
                entries: [
                  "ignore me",
                  { href: "https://example.com/nested", name: "Nested lead" },
                  { href: "ftp://example.com/ignored", name: "Wrong protocol" },
                ],
              },
            },
          }),
        ],
        1,
      ),
    ).toEqual([{ title: "Nested lead", url: "https://example.com/nested" }]);

    const comparison = buildRecoveredEvidenceAnswer(
      "Compare runtime orchestration approaches",
      [
        toolRun({
          result: {
            results: [
              {
                url: "https://example.com/runtime",
                snippet:
                  "Runtime orchestration differs from simple request handling because it persists progress, compares fallback paths, and exposes recovery status to operators.",
              },
            ],
          },
        }),
      ],
      { note: "Recovered from snippets." },
    );

    expect(comparison).toContain("strongest comparison points");
    expect(comparison).toContain("Primary source: example.com - https://example.com/runtime");
    expect(truncatePlainText("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda", 45)).toBe(
      "alpha beta gamma delta epsilon zeta eta theta...",
    );
  });

  it("handles malformed blocked-source records and low-signal fetched evidence", () => {
    expect(
      inferBlockedSourceFailure([
        toolRun({ result: "not an object" as never }),
        toolRun({
          result: {
            fallbackChain: ["bad entry", { browserFailureClass: "ignored", url: "https://example.com/ignored" }],
          },
        }),
      ]),
    ).toBeUndefined();
    expect(readBlockedSourceHost({})).toBeUndefined();

    const weakFetchedAnswer = buildFetchedContentBudgetFallback(
      "quick",
      [
        toolRun({
          toolName: "http.get",
          result: {
            status: 200,
            title: "Low signal REST page",
            url: "https://example.com/rest-low-signal",
            text: "Published: senior technology editor. What is a REST API and how do clients, servers, resources, endpoints, headers, body, URI, URL, requests, responses, HTTP methods, JSON, XML, multipart payloads, CRUD operations, and stateless constraints fit together for programming languages?",
          },
        }),
      ],
      "Explain REST",
    );

    expect(weakFetchedAnswer).toContain("What is a REST API");
    expect(weakFetchedAnswer).toContain("Primary source: Low signal REST page - https://example.com/rest-low-signal");

    expect(
      summarizeToolRunForSynthesis(
        toolRun({
          toolName: "browser.extract",
          result: {
            title: "Workflow page",
            text: "Cloud services use workflow automation and partner-facing integrations across distributed environments so operators can connect mobile and web services reliably.",
          },
        }),
      ),
    ).toContain("Workflow page");
    expect(
      summarizeToolRunForSynthesis(
        toolRun({
          toolName: "browser.search",
          result: { results: "not an array" },
        }),
      ),
    ).toBe('- browser.search [executed] result: {"results":"not an array"}');
  });

  it("covers recovery fallbacks for empty, blocked, duplicate, and source-title edge cases", () => {
    expect(
      inferBlockedSourceFailure([
        toolRun({
          result: {
            fallbackChain: [
              undefined,
              { browserFailureClass: "ignored", finalUrl: "https://example.com/ignored" },
              { browserFailureClass: "remote_blocked" },
            ],
          },
        }),
      ]),
    ).toEqual({ host: undefined, failureClass: "remote_blocked" });

    expect(buildSearchResultBudgetFallback("quick", [toolRun({ result: { results: [] } })])).toBeUndefined();
    expect(
      buildSearchResultBudgetFallback("quick", [
        toolRun({
          result: {
            results: [{ url: "https://example.com/lead" }],
          },
        }),
      ]),
    ).toContain("finish a full pass");

    const answer = buildRecoveredEvidenceAnswer(
      "Summarize the retrieved page",
      [
        toolRun({
          toolName: "browser.navigate",
          result: {
            finalUrl: "https://example.com/recovered",
            text: "Runtime recovery keeps operator-visible diagnostics available. Runtime recovery keeps operator-visible diagnostics available. It preserves source evidence when provider synthesis fails after useful tool output is already captured.",
          },
        }),
        toolRun({
          toolName: "browser.extract",
          result: {
            browserFailureClass: "remote_blocked",
            text: "This blocked page should be ignored even though it contains enough words to look substantial.",
          },
        }),
        toolRun({
          toolName: "http.get",
          result: {
            status: 503,
            bodySnippet: "This failed HTTP response should be ignored even though it has lots of words.",
          },
        }),
      ],
      { note: "Recovered from fetched content." },
    );

    expect(answer).toContain("Primary source: example.com - https://example.com/recovered");
    expect(answer).toContain("Runtime recovery keeps operator-visible diagnostics available.");

    expect(
      buildRecoveredEvidenceAnswer(
        "Compare unrelated options",
        [
          toolRun({
            toolName: "browser.search",
            result: {
              results: [],
            },
          }),
          toolRun({
            toolName: "file.read_range",
            result: {
              path: "apps/gateway/src/services/example.ts",
              content: "   ",
            },
          }),
          toolRun({
            toolName: "fs.read",
            result: {
              path: "apps/gateway/src/services/example.ts",
              content:
                "Pricing login support demo trial. Pricing login support demo trial. Pricing login support demo trial.",
            },
          }),
        ],
        { note: "Recovered from weak content." },
      ),
    ).toContain("Pricing login support demo trial");

  });
});

let toolRunCounter = 0;

function toolRun(overrides: Partial<ChatToolRunRecord>): ChatToolRunRecord {
  toolRunCounter += 1;
  return {
    toolRunId: `tool-${toolRunCounter}`,
    sessionId: "session-1",
    turnId: "turn-1",
    toolName: "browser.search",
    status: "executed",
    args: {},
    startedAt: "2026-05-14T00:00:00.000Z",
    completedAt: "2026-05-14T00:00:01.000Z",
    ...overrides,
  } as ChatToolRunRecord;
}
