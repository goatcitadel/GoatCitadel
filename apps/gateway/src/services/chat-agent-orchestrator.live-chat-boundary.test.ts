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
  it("passes model output through verbatim without forced repo prefetch on harness turns", async () => {
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
    const modelAnswer = [
      "## Observed",
      "- `apps/gateway/src/services/prompt-pack-service.ts`",
      "- `packages/storage/src/prompt-pack-repo.ts`",
      "",
      "## Unverified (inspection incomplete)",
      "- The actual auto-loading/import mechanism is not visible in the captured excerpts.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: modelAnswer,
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
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

    // Eval-integrity turn: the controller never executes repo inspection on the
    // model's behalf, and the model's own answer is persisted verbatim — no
    // injected fallback details the model never produced.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("GOATCITADEL_PROMPT_PACK_PATH");
    expect(result.assistantContent).not.toContain("/api/v1/prompt-packs/import");
  });

  it("passes explicit-tools harness output through verbatim without controller-initiated tool runs", async () => {
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
    const modelAnswer = [
      "## Exact files used",
      "- `F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`",
      "- `F:/code/personal-ai/artifacts/cost-reports/cost-report-2026-03-20-22.md`",
      "- `F:/code/personal-ai/artifacts/cost-reports/cost-report-2026-03-21-08.md`",
      "- `F:/code/personal-ai/apps/gateway/src/routes/prompt-packs.ts`",
      "- `F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.ts`",
      "",
      "## Patch points",
      "- Consumer/status candidate: `F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: modelAnswer,
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
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

    // Eval-integrity turn: even on an explicit-tools contract, tool runs are
    // model-initiated only — the controller does not search or read the repo on
    // the model's behalf, does not replace the answer with a compliance
    // fallback, and does not append operator-surface details the model never
    // produced.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
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

  it("still parks on approval for LIVE turns even when the user pastes a Prompt Lab run contract", async () => {
    // Eval-integrity semantics are keyed strictly on the server-set
    // normalizationProfile. A live user pasting contract text (e.g. to debug a
    // failing pack row) must keep normal approval parking — content sniffing
    // must never silently soft-fail their approval prompts.
    const pastedContract = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Why did this row pause? Read `apps/gateway/src/services/durable-run-service.ts` and tell me.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue(
      namedToolCallCompletion("file.read_range", {
        path: "apps/gateway/src/services/durable-run-service.ts",
        startLine: 1,
        endLine: 40,
      }),
    );
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "approval_required",
      policyReason: "file read requires operator approval",
      auditEventId: "audit-live-pasted-contract-approval",
      approvalId: "approval-live-pasted-contract",
      expiresAt: "2026-03-22T13:00:00.000Z",
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-live-pasted-contract-1",
      turnId: randomUUID(),
      userMessageId: "msg-live-pasted-contract-1",
      content: pastedContract,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      // No normalizationProfile: this is a live turn.
      historyMessages: [{ role: "user", content: pastedContract }],
    });

    expect(result.turnTrace.status).toBe("waiting_for_approval");
  });
});
