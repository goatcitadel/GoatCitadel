import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildPromptLabExactCitationAppendix,
  buildPromptLabExactCitationAppendixForPaths,
  collectPromptLabConcreteReadCitations,
  collectPromptLabConcreteReadEvidence,
  collectPromptLabConcreteReadPaths,
  extractPromptLabCitationQuote,
  extractPromptLabEvidenceTextFromSerializedPayload,
  extractPromptLabExactBulletLabels,
  filterPromptLabConcreteReadCitationsForPrompt,
  filterPromptLabConcreteReadEvidenceForPrompt,
  filterPromptLabExactFilePathsForPrompt,
  formatPromptLabCitationForPath,
  formatPromptLabInlineCitation,
  looksLikePromptLabConcreteFileCandidate,
  normalizePromptLabEvidenceContent,
  normalizePromptLabFilePath,
  pickPromptLabConcreteReadEvidence,
  promptLabConcreteReadSetMatchesPath,
  readPromptLabEvidenceTextFromPayload,
  scorePromptLabConcreteReadCandidate,
  selectPromptLabConcreteReadPathsFromSearchResult,
} from "./chat-agent-prompt-lab-evidence.js";

describe("prompt-lab evidence helpers", () => {
  it("parses serialized read payloads, merges duplicate evidence, and anchors inline citations to the useful line", () => {
    const runs = [
      toolRun({
        toolName: "file.read_range",
        args: {
          path: "F:\\code\\personal-ai\\apps\\gateway\\src\\services\\prompt-pack-service.ts",
          startLine: 120,
          endLine: 180,
        },
        result: {
          content: JSON.stringify({
            content: ["import { z } from 'zod';", "export function parsePromptPackTests() {", "  return [];", "}"].join(
              "\\n",
            ),
          }),
        },
      }),
      toolRun({
        toolName: "fs.read",
        args: { path: "apps/gateway/src/services/prompt-pack-service.ts" },
        result: {
          bodySnippet: "{'content':'sourceLabel: input.sourceLabel\\nrefreshPromptPackExportFile();'}",
        },
      }),
      toolRun({
        toolName: "file.read_range",
        args: { path: "apps/gateway/src/services/prompt-pack-service.scoring.test.ts", startLine: 40, endLine: 80 },
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.scoring.test.ts",
          snippet: '{"content":"describe(\'judge defaults\', () => {\\n  resolvePromptPackJudgeTarget();\\n});"}',
        },
      }),
      toolRun({
        toolName: "browser.search",
        result: { content: "not a local read" },
      }),
    ];

    expect(collectPromptLabConcreteReadEvidence(runs)).toEqual([
      {
        path: "apps/gateway/src/services/prompt-pack-service.ts",
        content: [
          "import { z } from 'zod';",
          "export function parsePromptPackTests() {",
          "  return [];",
          "}",
          "sourceLabel: input.sourceLabel",
          "refreshPromptPackExportFile();",
        ].join("\n"),
      },
      {
        path: "apps/gateway/src/services/prompt-pack-service.scoring.test.ts",
        content: "describe('judge defaults', () => {\n  resolvePromptPackJudgeTarget();\n});",
      },
    ]);
    expect(collectPromptLabConcreteReadCitations(runs)).toEqual([
      {
        path: "apps/gateway/src/services/prompt-pack-service.ts",
        startLine: 120,
        endLine: 180,
      },
      {
        path: "apps/gateway/src/services/prompt-pack-service.scoring.test.ts",
        startLine: 40,
        endLine: 80,
      },
    ]);
    expect(formatPromptLabCitationForPath("apps/gateway/src/services/prompt-pack-service.ts", runs)).toBe(
      '`apps/gateway/src/services/prompt-pack-service.ts` line 124 ("sourceLabel: input.sourceLabel")',
    );
    expect(formatPromptLabInlineCitation({ path: "apps/gateway/src/services/prompt-pack-service.ts" }, runs)).toBe(
      '`apps/gateway/src/services/prompt-pack-service.ts` ("sourceLabel: input.sourceLabel")',
    );
    expect(extractPromptLabCitationQuote("apps/gateway/src/services/prompt-pack-service.scoring.test.ts", runs)).toBe(
      "resolvePromptPackJudgeTarget();",
    );
    expect(buildPromptLabExactCitationAppendix(runs)).toContain("Exact citations used:");
    expect(
      buildPromptLabExactCitationAppendixForPaths(runs, ["apps/gateway/src/services/prompt-pack-service.ts"]),
    ).not.toContain("prompt-pack-service.scoring.test.ts");
    expect(buildPromptLabExactCitationAppendixForPaths(runs, [])).toBeUndefined();
    expect(buildPromptLabExactCitationAppendixForPaths(runs, ["docs/missing.md"])).toBeUndefined();
  });

  it("normalizes loose evidence payloads and rejects unsupported payload shapes", () => {
    expect(normalizePromptLabEvidenceContent("{ content: 'not valid json' }")).toBe("{ content: 'not valid json' }");
    expect(normalizePromptLabEvidenceContent('{"content":"first\\r\\nsecond\\tline"}')).toBe("first\nsecond\tline");
    expect(extractPromptLabEvidenceTextFromSerializedPayload("{'content':'single quoted\\nbody'}")).toBe(
      "single quoted\nbody",
    );
    expect(extractPromptLabEvidenceTextFromSerializedPayload('{"bodySnippet":"snippet text"}')).toBe("snippet text");
    expect(extractPromptLabEvidenceTextFromSerializedPayload('{"content":"double \\"quoted\\""}')).toBe(
      'double "quoted"',
    );
    expect(extractPromptLabEvidenceTextFromSerializedPayload("plain text")).toBeUndefined();
    expect(readPromptLabEvidenceTextFromPayload(" raw text ")).toBe("raw text");
    expect(readPromptLabEvidenceTextFromPayload(["array"])).toBeUndefined();
    expect(readPromptLabEvidenceTextFromPayload({ content: "  " })).toBeUndefined();
    expect(readPromptLabEvidenceTextFromPayload({ message: "message text" })).toBe("message text");
  });

  it("filters template paths and preserves exact bullet label contracts", () => {
    const prompt = [
      "Return exactly three bullets labeled `Routing`, `Evidence`, and `Risk`.",
      "Do not cite template files or placeholder paths.",
    ].join("\n");
    const paths = [
      "apps/gateway/src/services/prompt-pack-service.ts",
      "apps/gateway/src/services/prompt-pack-service.ts",
      "templates/{{skill}}/README.md",
      "",
      "docs/runtime.md",
    ];

    expect(extractPromptLabExactBulletLabels(prompt)).toEqual(["Routing", "Evidence", "Risk"]);
    expect(filterPromptLabExactFilePathsForPrompt(paths, prompt)).toEqual([
      "apps/gateway/src/services/prompt-pack-service.ts",
      "docs/runtime.md",
    ]);
    expect(
      filterPromptLabConcreteReadEvidenceForPrompt(
        [
          { path: "templates/{{skill}}/README.md", content: "template" },
          { path: "apps/gateway/src/services/prompt-pack-service.ts", content: "real" },
        ],
        prompt,
      ),
    ).toEqual([{ path: "apps/gateway/src/services/prompt-pack-service.ts", content: "real" }]);
    expect(
      filterPromptLabConcreteReadCitationsForPrompt(
        [
          { path: "templates/{{skill}}/README.md", startLine: 1 },
          { path: "docs/runtime.md", startLine: 2 },
        ],
        prompt,
      ),
    ).toEqual([{ path: "docs/runtime.md", startLine: 2 }]);
    expect(filterPromptLabExactFilePathsForPrompt([""], "")).toEqual([]);
  });

  it("ranks concrete search hits and matches observed reads by suffix", () => {
    const selected = selectPromptLabConcreteReadPathsFromSearchResult({
      matches: [
        null,
        { path: "node_modules/pkg/index.ts", type: "file" },
        { path: "apps/gateway/src/services/prompt-pack-service.ts", type: "file" },
        { path: "docs/prompt-pack.md", type: "file" },
        { path: "artifacts/prompt-lab/latest.md", type: "file" },
        { path: "apps/gateway/src/services", type: "dir" },
        { path: "apps/gateway/src/services/prompt-pack-service.ts", type: "file" },
      ],
    });

    expect(selected).toEqual([
      "apps/gateway/src/services/prompt-pack-service.ts",
      "docs/prompt-pack.md",
      "artifacts/prompt-lab/latest.md",
    ]);
    expect(selectPromptLabConcreteReadPathsFromSearchResult({ matches: [{ path: "src/", type: "dir" }] })).toEqual([]);
    expect(selectPromptLabConcreteReadPathsFromSearchResult({})).toEqual([]);
    expect(looksLikePromptLabConcreteFileCandidate("README")).toBe(true);
    expect(looksLikePromptLabConcreteFileCandidate("apps/gateway/src/services/fixture.bin")).toBe(false);
    expect(looksLikePromptLabConcreteFileCandidate("apps/gateway/src/services/", "dir")).toBe(false);
    expect(scorePromptLabConcreteReadCandidate("apps/gateway/src/services/prompt-pack-service.ts")).toBeGreaterThan(
      scorePromptLabConcreteReadCandidate("artifacts/prompt-lab/latest.md"),
    );

    const observed = collectPromptLabConcreteReadPaths([
      toolRun({
        args: { path: "F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.ts" },
        result: {},
      }),
      toolRun({
        status: "blocked",
        args: { path: "docs/runtime.md" },
        result: { path: "docs/runtime.md" },
      }),
      toolRun({ result: {} }),
    ]);

    expect(observed).toEqual(new Set(["apps/gateway/src/services/prompt-pack-service.ts"]));
    expect(promptLabConcreteReadSetMatchesPath(observed, "services/prompt-pack-service.ts")).toBe(true);
    expect(promptLabConcreteReadSetMatchesPath(observed, "docs/runtime.md")).toBe(false);
    expect(normalizePromptLabFilePath("./apps/gateway/src/services/prompt-pack-service.ts")).toBe(
      "apps/gateway/src/services/prompt-pack-service.ts",
    );
    expect(
      pickPromptLabConcreteReadEvidence(
        [
          { path: "docs/runtime.md", content: "docs" },
          { path: "apps/gateway/src/services/prompt-pack-service.ts", content: "source" },
        ],
        (item) => item.path.endsWith("prompt-pack-service.ts"),
      ),
    ).toEqual({ path: "apps/gateway/src/services/prompt-pack-service.ts", content: "source" });
  });
});

let nextToolRunId = 0;

function toolRun(overrides: Partial<ChatToolRunRecord>): ChatToolRunRecord {
  return {
    toolRunId: `tool-${(nextToolRunId += 1)}`,
    turnId: "turn-1",
    sessionId: "session-1",
    toolName: "file.read_range",
    status: "executed",
    startedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}
