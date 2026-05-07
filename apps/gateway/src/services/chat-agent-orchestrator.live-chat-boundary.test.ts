import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator live-chat and harness boundary behavior", () => {
  it("does not inject prompt-pack markdown import fallback content on live chat turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain how prompt-pack markdown is auto-loaded or imported today, including any source-label or source-of-truth ambiguity that remains.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Observed",
              "- `apps/gateway/src/services/prompt-pack-service.ts`",
              "- `packages/storage/src/prompt-pack-repo.ts`",
              "",
              "## Unverified (inspection incomplete)",
              "- The actual auto-loading/import mechanism is not visible in the captured excerpts.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts", type: "file" },
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts", type: "file" },
            { path: "packages/storage/src/prompt-pack-repo.ts", name: "prompt-pack-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-service-read",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          startLine: 1400,
          endLine: 1450,
          content: [
            "async ensurePromptPackLoaded(): Promise<PromptPackRecord | undefined> {",
            "  const sourcePath = process.env.GOATCITADEL_PROMPT_PACK_PATH?.trim();",
            "  const markdown = await fs.readFile(sourcePath, 'utf8');",
            "  const imported = this.importPromptPack({",
            "    content: markdown,",
            "    sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE,",
            "  });",
            "}",
            "importPromptPack(input: { content: string; name?: string; sourceLabel?: string; packId?: string }) {",
            "  const tests = parsePromptPackTests(input.content);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-route-read",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          startLine: 100,
          endLine: 125,
          content: [
            "fastify.post('/api/v1/prompt-packs/import', async (request, reply) => {",
            "  return reply.send(fastify.gateway.importPromptPack(body.data));",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-repo-read",
        result: {
          path: "packages/storage/src/prompt-pack-repo.ts",
          startLine: 1,
          endLine: 220,
          content: [
            "interface PromptPackRow {",
            "  source_label: string | null;",
            "  policy_v2_source: string | null;",
            "}",
            "const resolvedSource = input.policySource ?? existingSource ?? 'inherited_default';",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-pack-import-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-pack-import-repair-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(
      invokeTool.mock.calls.some(
        (call) =>
          call[0].toolName === "file.read_range" &&
          String(call[0].args.path) === "apps/gateway/src/services/prompt-pack-service.ts",
      ),
    ).toBe(true);
    expect(result.assistantContent).toContain("## Observed");
    expect(result.assistantContent).toContain("inspection incomplete");
    expect(result.assistantContent).not.toContain("GOATCITADEL_PROMPT_PACK_PATH");
    expect(result.assistantContent).not.toContain("/api/v1/prompt-packs/import");
  });

  it("does not inject prompt-pack operator-surface fallback content on live chat turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect report rendering, trend rendering, and benchmark status/report APIs. Explain what evidence each surface exposes to an operator and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Exact files used",
              "- `F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`",
              "- `F:/code/personal-ai/artifacts/cost-reports/cost-report-2026-03-20-22.md`",
              "- `F:/code/personal-ai/artifacts/cost-reports/cost-report-2026-03-21-08.md`",
              "- `F:/code/personal-ai/apps/gateway/src/routes/prompt-packs.ts`",
              "- `F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.ts`",
              "",
              "## Patch points",
              "- Consumer/status candidate: `F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts", type: "file" },
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts", type: "file" },
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
              type: "file",
            },
            {
              path: "artifacts/cost-reports/cost-report-2026-03-20-22.md",
              name: "cost-report-2026-03-20-22.md",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-service-read",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          startLine: 847,
          endLine: 1000,
          content: [
            "getPromptPackReport(packId: string): PromptPackReportRecord {",
            "  return { pack, tests, runs, scores, autoScoresV2, humanReviewsV2, latestAssessments, summary };",
            "}",
            "getPromptPackBenchmarkStatus(benchmarkRunId: string): PromptPackBenchmarkStatusRecord {",
            "  return { run, progress: { totalItems: runRow.total_items, completedItems: Math.max(runRow.completed_items, items.length) }, modelSummaries };",
            "}",
            "getPromptPackCapabilityTrends(packId: string): { items: CapabilityTrendSeries[] } {",
            "  return { items: capabilities.map((entry) => ({ capability: entry.key, points, threshold: entry.threshold, breached })) };",
            "}",
            "function renderPromptPackMarkdownReport(report: PromptPackReportRecord): string {",
            "  lines.push('## Snapshot');",
            "  lines.push('### Latest Run');",
            "  lines.push('### Auto Score (V2)');",
            "  lines.push('### Integrity');",
            "  lines.push('### Trace Summary');",
            "  lines.push('### Citations');",
            "  lines.push('## Outstanding');",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-route-read",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          startLine: 303,
          endLine: 405,
          content: [
            "fastify.get('/api/v1/prompt-packs/:packId/report', async (request, reply) => {",
            "  return reply.send(fastify.gateway.getPromptPackReport(params.data.packId));",
            "});",
            "fastify.post('/api/v1/prompt-packs/:packId/benchmark/run', async (request, reply) => {",
            "  return reply.send(fastify.gateway.runPromptPackBenchmark(params.data.packId, { testCodes: body.data.testCodes, providers: body.data.providers }));",
            "});",
            "fastify.get('/api/v1/prompt-packs/benchmark/:benchmarkRunId', async (request, reply) => {",
            "  return reply.send(fastify.gateway.getPromptPackBenchmarkStatus(params.data.benchmarkRunId));",
            "});",
            "fastify.post('/api/v1/prompt-packs/benchmark/:benchmarkRunId/cancel', async (request, reply) => {",
            "  return reply.send(fastify.gateway.cancelPromptPackBenchmark(params.data.benchmarkRunId));",
            "});",
            "fastify.get('/api/v1/prompt-packs/:packId/trends', async (request, reply) => {",
            "  return reply.send(fastify.gateway.getPromptPackCapabilityTrends(params.data.packId));",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-benchmark-test-read",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          startLine: 1,
          endLine: 124,
          content: [
            "it('returns benchmark status for a benchmark run id', async () => {",
            "  expect(response.json()).toMatchObject({",
            "    progress: { totalItems: 10, completedItems: 4 },",
            "  });",
            "});",
            "it('cancels a benchmark run by id', async () => {",
            "  expect(response.json()).toMatchObject({",
            "    run: { status: 'cancelled' },",
            "  });",
            "});",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-pack-operator-surface-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-pack-operator-surface-repair-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "prompt-pack-service.ts",
      }),
    });
    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts");
    expect(result.assistantContent).toContain("artifacts/cost-reports/cost-report-2026-03-20-22.md");
    expect(result.assistantContent).not.toContain("GET /api/v1/prompt-packs/:packId/report");
    expect(result.assistantContent).not.toContain("top failure signals");
  });

  it("does not apply repo-grounded harness repair logic to ordinary live prompts", async () => {
    const prompt =
      "Inspect the repo and explain the current implementation for approval wake handling. Show the exact files used.";
    const repairedAnswer = [
      "The current implementation keeps approval wake handling in the approval effects service and cross-checks the wake result before deciding whether to skip, fail, or complete the effect.",
      "",
      "I would verify `apps/gateway/src/services/approval-resolution-effects-service.ts` first, then trace the durable wake call sites from there.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("file.read_range", {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          startLine: 1,
          endLine: 160,
        }),
      )
      .mockResolvedValueOnce({
        model: "gemma-3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Observed from the files I did inspect:",
            },
            finish_reason: "length",
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "gemma-3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: repairedAnswer,
            },
            finish_reason: "stop",
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-live-repo-inspection-read-1",
      result: {
        path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
        startLine: 1,
        endLine: 160,
        content: [
          "export class ApprovalEffectsService {",
          "  public enqueueResolutionEffects() {}",
          "  private async handleApprovalWaitWake() {}",
          "}",
        ].join("\n"),
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-live-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-live-repo-inspection-1",
      content: prompt,
      mode: "chat",
      providerId: "llamacpp",
      model: "gemma-3",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toBe(repairedAnswer);
    expect(result.assistantContent).not.toContain("Files:");
    expect(result.assistantContent).not.toContain("Anything beyond those files is unverified");
    expect(result.turnTrace.completion).toMatchObject({
      repaired: true,
      repair: expect.objectContaining({
        applied: true,
        kind: "incomplete_truncated_completion",
        source: "orchestrator",
      }),
    });
    expect(result.turnTrace.completion?.repair?.kind).not.toBe("prompt_pack_harness_normalization");
  });

  it("passes non-Prompt-Lab prompts through without explicit-tools enforcement", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is a plain answer without any tools.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-non-prompt-lab-1",
      turnId: randomUUID(),
      userMessageId: "msg-non-prompt-lab-1",
      content: "Explain how tree-shaking works in webpack.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Explain how tree-shaking works in webpack.",
        },
      ],
    });

    // No Prompt Lab contract → no enforcement, prose answer accepted as-is
    expect(result.assistantContent).toBe("Here is a plain answer without any tools.");
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
  });
});
