import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator Cowork repair behavior", () => {
  it("repairs typed wake outcome patch plans into the shared durable contract and wake call sites", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect durable-run wake logic, approval-wait wake handling, and related operator-visible status shaping. Identify the exact patch points needed to add a typed wake outcome contract and cite the exact files used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Name the contract file, producer call sites, and consumer call sites.",
      "- Include one compatibility note and one validation step.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Contract file",
              "- `packages/durable-runner/src/contracts.ts`",
              "",
              "## Producer call sites",
              "- guessed from memory",
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
        auditEventId: "audit-d147-search-1",
        result: {
          matches: [
            { path: "packages/contracts/src/durable.ts", name: "durable.ts", type: "file" },
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-contract",
        result: {
          path: "packages/contracts/src/durable.ts",
          content: "export type DurableWakeOutcome = 'woke' | 'failed';\nexport interface DurableWakeResult {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-effects",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "class ApprovalEffectsService { handleWakeEffect() { return this.deps.wakeDurableRun('run-1'); } }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-service",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "class DurableRunService { wakeDurableRun() { return { outcome: 'woke' }; } }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-search-2",
        result: {
          matches: [{ path: "apps/gateway/src/routes/durable.ts", name: "durable.ts", type: "file" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-route",
        result: {
          path: "apps/gateway/src/routes/durable.ts",
          content: "fastify.post('/api/v1/durable/runs/:runId/events/wake', async () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d147-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d147-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(
      invokeTool.mock.calls.some(
        ([request]) => request.toolName === "code.search_files" && request.args.query === "durable.ts",
      ),
    ).toBe(true);
    expect(result.assistantContent).toContain("packages/contracts/src/durable.ts");
    expect(result.assistantContent).toContain("DurableRunService.wakeDurableRun");
    expect(result.assistantContent).toContain("ApprovalEffectsService.handleWakeEffect");
    expect(result.assistantContent).toContain("Compatibility note");
    expect(result.assistantContent).toContain("Validation step");
    expect(result.assistantContent).not.toContain("packages/durable-runner");
  });

  it("repairs two-worker harness prompts into concrete durable repo race scenarios", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect durable execution tests or adjacent harnesses. Identify the exact patch points needed to add a real two-worker claim and recovery test instead of relying on single-process behavior, and cite the exact files used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Name the harness entrypoint, worker orchestration helper, and assertion surface.",
      "- Define exactly two new scenarios: claim race and lease-expiry recovery.",
      "- Include the failure signature each scenario should surface.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "maybe add more tests somewhere" } }],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-search-1",
        result: {
          matches: [
            { path: "packages/storage/src/durable-run-repo.test.ts", name: "durable-run-repo.test.ts", type: "file" },
            { path: "packages/storage/src/durable-run-repo.ts", name: "durable-run-repo.ts", type: "file" },
            {
              path: "apps/gateway/src/services/durable-run-service.ts",
              name: "durable-run-service.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-repo-test",
        result: {
          path: "packages/storage/src/durable-run-repo.test.ts",
          content: "describe('DurableRunRepository', () => { function createRepo() {} });",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-repo",
        result: {
          path: "packages/storage/src/durable-run-repo.ts",
          content: "tryClaimQueuedRun() {}\nrenewLease() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-service",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "listExpiredRunningRunIds();",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-search-2",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/durable-run-service.test.ts",
              name: "durable-run-service.test.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-service-test",
        result: {
          path: "apps/gateway/src/services/durable-run-service.test.ts",
          content: "it('drops stale worker terminal writes', async () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d153-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d153-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("packages/storage/src/durable-run-repo.test.ts");
    expect(result.assistantContent).toContain("tryClaimQueuedRun");
    expect(result.assistantContent).toContain("claim race");
    expect(result.assistantContent).toContain("lease-expiry recovery");
    expect(result.assistantContent).toContain("stale worker still renews the lease");
  });

  it("repairs approval-effects hardening prompts into canonical-vs-effect storage boundaries", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect approval resolution, downstream effect handling, and operator-visible effect status paths. Identify the exact patch points needed to add idempotent effect tracking or an outbox path without corrupting canonical approval state, and cite the exact files used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Separate canonical approval writes from downstream effect tracking writes.",
      "- Name the idempotency key or dedupe mechanism you would use.",
      "- Include one migration or rollout risk and one proving test.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "add an outbox to approvals somehow" } }],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-lifecycle-service.ts",
              name: "approval-lifecycle-service.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            { path: "packages/storage/src/approval-effect-repo.ts", name: "approval-effect-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-lifecycle",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          content: "resolveApproval() { approvalEvents.append({ type: 'resolved' }); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-effects",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "enqueueResolutionEffects() {}\nhandleWakeEffect() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-repo",
        result: {
          path: "packages/storage/src/approval-effect-repo.ts",
          content:
            "idempotency_key: string | null;\nON CONFLICT(idempotency_key) DO UPDATE SET status = excluded.status;",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-search-2",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
              name: "approval-resolution-effects-service.test.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-effects-test",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
          content: "it('replays wake retries safely', async () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d154-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d154-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Canonical approval writes");
    expect(result.assistantContent).toContain("Downstream effect tracking writes");
    expect(result.assistantContent).toContain("idempotency_key");
    expect(result.assistantContent).toContain("migration additive");
    expect(result.assistantContent).toContain("approval-resolution-effects-service.test.ts");
  });

  it("repairs approval wake-ordering minimal test prompts toward the approval effects harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect the approval wake ordering path and name the exact minimal automated test needed. Include: Target test file or suite, Setup, Act, Assert, Failure signature.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I would add a small durable-run test around wake handling, but I need to keep investigating before I can verify the target.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
              name: "approval-resolution-effects-service.test.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            { path: "packages/storage/src/approval-effect-repo.ts", name: "approval-effect-repo.ts", type: "file" },
            {
              path: "packages/storage/src/approval-wait-run-repo.ts",
              name: "approval-wait-run-repo.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-1",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
          content:
            "describe('approval wake ordering', () => { it('does not complete before wake', async () => {}); });",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-2",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "async function handleWakeEffect() { await wakeDurableRun(); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-3",
        result: {
          path: "packages/storage/src/approval-effect-repo.ts",
          content: "export class ApprovalEffectRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-4",
        result: {
          path: "packages/storage/src/approval-wait-run-repo.ts",
          content: "export class ApprovalWaitRunRepository {}",
        },
      });
    const storage = createMockStorage() as any;
    const turnId = randomUUID();
    const orchestrator = new ChatAgentOrchestrator({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d139-repair-1",
      turnId,
      userMessageId: "msg-d139-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("approval-resolution-effects-service.test.ts");
    expect(result.assistantContent).toContain("markResolved");
    expect(result.assistantContent).toContain("completeEffect");
    expect(result.assistantContent).toContain("wakeDurableRun");
    expect(result.assistantContent).toContain("Setup:");
    expect(result.assistantContent).toContain("Act:");
    expect(result.assistantContent).toContain("Assert:");
    expect(result.assistantContent).toContain("Failure signature:");
    expect(result.assistantContent).not.toContain("need to keep investigating");
    expect(storage._getTrace(turnId)?.failure).toBeUndefined();
  });

  it("repairs cowork extra-heading minimal test prompts toward the orchestrator normalization path", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that catches small models adding fake cowork headings or inline contract echoes.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Target `packages/threaded-surface-core/src/pure-helpers.test.ts`; prove requested behavior holds.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d128-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/chat-agent-orchestrator.test.ts",
              name: "chat-agent-orchestrator.test.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/chat-agent-orchestrator.ts",
              name: "chat-agent-orchestrator.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d128-read-test",
        result: {
          path: "apps/gateway/src/services/chat-agent-orchestrator.test.ts",
          content:
            "it('does not misread inline Prompt Lab cowork section contracts as extra qwen role headings', async () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d128-read-source",
        result: {
          path: "apps/gateway/src/services/chat-agent-orchestrator.ts",
          content:
            "function normalizeCoworkRoleContractOutput() {}\nfunction looksLikePromptLabInstructionEchoContent() {}\nfunction repairRequestedRoleOrderOnlyCoworkOutput() {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d128-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d128-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("apps/gateway/src/services/chat-agent-orchestrator.test.ts");
    expect(result.assistantContent).toContain("normalizeCoworkRoleContractOutput");
    expect(result.assistantContent).toContain("Prompt Lab Run Contract");
    expect(result.assistantContent).toContain("Researcher");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).toContain("Failure signature:");
    expect(result.assistantContent).not.toContain("packages/threaded-surface-core");
  });

  it("repairs cowork workspace-route regression prompts into grounded route and repo checks", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect workspace routes, guidance docs, and related services. Produce role-labeled sections for the first fresh regression checks to add, and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Maybe inspect workspace storage.",
              "",
              "## Architect",
              "- Probably add route tests.",
              "",
              "## QA",
              "- Some regressions here.",
              "",
              "## Synthesis",
              "- Not done yet.",
              "",
              "Note: read range failed while I was working, so parts of this answer may be incomplete.",
              "Best next move: Retry read range with a narrower, more explicit input.",
              'Say "keep going" to try another approach.',
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
        auditEventId: "audit-w109-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/routes/workspaces.ts", name: "workspaces.ts", type: "file" },
            { path: "apps/gateway/src/routes/workspaces.test.ts", name: "workspaces.test.ts", type: "file" },
            { path: "packages/storage/src/workspace-repo.ts", name: "workspace-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-routes",
        result: {
          path: "apps/gateway/src/routes/workspaces.ts",
          content:
            'const listWorkspacesQuerySchema = z.object({ view: z.enum(["active","archived","all"]).default("active") });',
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-route-test",
        result: {
          path: "apps/gateway/src/routes/workspaces.test.ts",
          content: "describe('workspace and guidance routes', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-repo",
        result: {
          path: "packages/storage/src/workspace-repo.ts",
          content:
            "interface WorkspaceRow { lifecycle_status: 'active' | 'archived'; archived_at: string | null; workspace_prefs_json: string | null; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-search-2",
        result: {
          matches: [
            { path: "packages/storage/src/workspace-repo.test.ts", name: "workspace-repo.test.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-repo-test",
        result: {
          path: "packages/storage/src/workspace-repo.test.ts",
          content: "describe('WorkspaceRepository', () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-w109-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-w109-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ query: "workspaces.ts" }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/routes/workspaces.ts");
    expect(result.assistantContent).toContain("apps/gateway/src/routes/workspaces.test.ts");
    expect(result.assistantContent).toContain("packages/storage/src/workspace-repo.ts");
    expect(result.assistantContent).toContain("archive-view filtering");
    expect(result.assistantContent).toContain("guidance doc-type divergence");
    expect(result.assistantContent).not.toContain('Say "keep going"');
  });

  it("repairs cowork guidance precedence prompts into Architect Coder QA regression slices", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      "Use file or code tools to inspect guidance precedence, repo-binding, and operator-visible override clarity. Produce the smallest fresh regression slice in role-labeled sections for Architect, Coder, and QA.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "Guidance probably loads correctly." } }],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w105-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/guidance-document-helpers.ts", name: "guidance-document-helpers.ts" },
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
            { path: "apps/gateway/src/services/tool-path-resolution.ts", name: "tool-path-resolution.ts" },
            { path: "packages/storage/src/chat-session-binding-repo.ts", name: "chat-session-binding-repo.ts" },
          ],
        },
      })
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w105-read",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          content: "resolveRuntimeGuidance(); listWorkspaceGuidance();",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-w105-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-w105-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Architect");
    expect(result.assistantContent).toContain("Coder");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).toContain("workspaceFilesUsed");
    expect(result.assistantContent).toContain("explicit ambiguity line");
    expect(result.assistantContent).not.toContain("Guidance probably loads correctly");
  });

  it("reruns cowork contract repair after Prompt Lab evidence normalization", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "- Required role order: Architect, Coder, QA",
      "",
      "## User Task",
      "Inspect the repo if needed and produce role-labeled sections describing the smallest fresh regression slice for guidance precedence, repo binding, and operator-visible override clarity.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "## Observed Loading Chain\n- Guidance loads through helper and service files.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-w105-post-harness-search",
          result: {
            matches: [
              { path: "apps/gateway/src/services/guidance-document-helpers.ts", name: "guidance-document-helpers.ts" },
              { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
              { path: "apps/gateway/src/services/tool-path-resolution.ts", name: "tool-path-resolution.ts" },
            ],
          },
        };
      }
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w105-post-harness-read",
        result: {
          path: String(request.args.path),
          content: "resolveGuidancePath(); readGuidanceDocument(); resolveRuntimeGuidance(); listWorkspaceGuidance();",
        },
      };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-w105-post-harness-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-w105-post-harness-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Architect");
    expect(result.assistantContent).toContain("Coder");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).toContain("workspaceFilesUsed");
    expect(result.assistantContent).not.toContain("## Observed Loading Chain");
  });

  it("repairs Rank 1 cowork hardening prompts across contract wake lifecycle and worker seams", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "",
      "## User Task",
      "Use file or code tools to inspect approval wake, durable runs, lifecycle reads, and cross-system Rank 1 hardening. Produce role-labeled Architect and QA sections with the Rank 1 suite across all named seams.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "QA\n- Add a wake ordering test." } }],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-w137-search",
          result: {
            matches: [
              { path: "packages/contracts/src/durable.ts", name: "durable.ts" },
              { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
              {
                path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
                name: "approval-resolution-effects-service.ts",
              },
              {
                path: "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
                name: "runtime-lifecycle-read-service.ts",
              },
            ],
          },
        };
      }
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w137-read",
        result: { path: String(request.args.path), content: "wakeDurableRun(); DurableWakeResult; lifecycle;" },
      };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-w137-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-w137-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Architect");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).toContain("typed `DurableWakeResult`");
    expect(result.assistantContent).toContain("two-worker lease recovery");
    expect(result.assistantContent).toContain("lifecycle canonical-vs-inferred");
  });

  it("does not let repo-grounded repair overwrite strict cowork memory role sections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect memory routes, memory context services, and any related Memory UI surfaces. Create role-labeled sections for the first fresh regression checks to add.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Researcher`, `QA`.",
      "- Do not add any intro, recap, synthesis, evidence appendix, or citation appendix.",
      "- Each section must contain exactly two bullets.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Observed memory lifecycle surfaces:\n- route layer exists.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-cowork-memory-search-1",
          result: {
            matches: [
              { path: "apps/gateway/src/routes/memory.ts", name: "memory.ts", type: "file" },
              { path: "packages/storage/src/memory-context-repo.ts", name: "memory-context-repo.ts", type: "file" },
              {
                path: "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx",
                name: "MemoryRoutePage.tsx",
                type: "file",
              },
            ],
          },
        };
      }
      if (request.toolName === "file.read_range") {
        const path = String(request.args?.path ?? "");
        if (path.endsWith("apps/gateway/src/routes/memory.ts")) {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-1",
            result: {
              path,
              content: "export async function registerMemoryRoutes() {}",
            },
          };
        }
        if (path.endsWith("packages/storage/src/memory-context-repo.ts")) {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-2",
            result: {
              path,
              content: "export class MemoryContextRepository {}",
            },
          };
        }
        if (path.endsWith("apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx")) {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-3",
            result: {
              path,
              content: "export function MemoryRoutePage() { return null; }",
            },
          };
        }
        if (path.endsWith("packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts")) {
          return {
            outcome: "failed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-4",
            error: "simulated read failure",
          };
        }
      }
      return {
        outcome: "failed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-memory-unexpected",
        error: `unexpected tool call: ${request.toolName}`,
      };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-memory-role-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-memory-role-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Researcher");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).not.toContain("Observed memory lifecycle surfaces");
    expect(result.assistantContent).not.toContain("## Exact files used");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
    expect(result.assistantContent).not.toContain('Say "keep going"');
  });

  it("forces the cron cowork repair onto wiring, scheduled review execution, and operator report surfaces", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect built-in cron wiring, scheduled review execution, and the operator-visible report or cost surface. Create role-labeled sections for the first fresh trust-preserving regression checks to add.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Researcher`, `Ops`, `QA`.",
      "- Do not add any extra headings.",
      "- Keep each section compact and decision-oriented.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Researcher\n- I only verified cron storage.\n\nOps\n- Add a cron test.\n\nQA\n- Add a report test.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/gateway/cron-automation-service.ts",
              name: "cron-automation-service.ts",
            },
            { path: "apps/gateway/src/services/gateway/update-review.ts", name: "update-review.ts" },
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-read-1",
        result: {
          path: "apps/gateway/src/services/gateway/cron-automation-service.ts",
          content:
            "export const UPDATE_REVIEW_DAILY_JOB_ID = 'update-review-daily';\nexport class CronAutomationService {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-read-2",
        result: {
          path: "apps/gateway/src/services/gateway/update-review.ts",
          content: "export interface UpdateReviewReport {}\nexport async function collectWorkspaceDependencyDrift() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-read-3",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          content: 'fastify.get("/api/v1/prompt-packs/:packId/report", async (request, reply) => {});',
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-cron-role-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-cron-role-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Researcher");
    expect(result.assistantContent).toContain("Ops");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).toContain("cron-automation-service.ts");
    expect(result.assistantContent).toContain("update-review.ts");
    expect(result.assistantContent).toContain("prompt-packs.ts");
    expect(result.assistantContent).not.toContain("## Evidence Used");
  });

  it("repairs strict paused-versus-waiting evidence answers to exactly the requested bullets", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "",
      "## User Task",
      "Use file or code tools to inspect durable-run wake logic, approval wake helpers, and any operator resume path.",
      "",
      "Answer contract:",
      "- Cite at least three exact files.",
      "- Use exactly four bullets labeled `Files inspected`, `Observed disjointness`, `Counterexample not found`, and `Implicit invariant`.",
      "- `Observed disjointness` must name the check or branch that keeps `paused` distinct from `waiting`, if it exists.",
      "- `Counterexample not found` must state the negative search result plainly.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "Need answer. - Files inspected: weak." } }],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-paused-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
            },
            { path: "apps/gateway/src/routes/durable.ts", name: "durable.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-paused-read-1",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content:
            "export async function wakeDurableRun() { if (status === 'paused') return { outcome: 'skipped_paused' }; if (status === 'waiting_for_approval') return { outcome: 'waiting' }; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-paused-read-2",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content:
            "async function handleWakeEffect() { const result = await wakeDurableRun(); if (result.outcome === 'woke') markResolved(); else skipEffect(); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-paused-read-3",
        result: {
          path: "apps/gateway/src/routes/durable.ts",
          content: 'fastify.post("/api/v1/durable/runs/:runId/events/wake", async () => wakeDurableRun());',
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-c145-repair",
      turnId: randomUUID(),
      userMessageId: "msg-c145-repair",
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

    expect(result.assistantContent).toMatch(/^- Files inspected:/);
    expect(result.assistantContent).toContain("- Observed disjointness:");
    expect(result.assistantContent).toContain("- Counterexample not found:");
    expect(result.assistantContent).toContain("- Implicit invariant:");
    expect(result.assistantContent).not.toContain("Need answer");
    expect(result.assistantContent.match(/^- /gm) ?? []).toHaveLength(4);
  });

  it("keeps event-link cowork repairs on producer-storage-api propagation", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Create role-labeled sections for the next regression checks proving explicit event links and classification survive from producer to operator-visible API/UI surfaces.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Architect`, `QA`.",
      "- Do not add any extra headings.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Architect\n- Read storage directly.\n\nQA\n- Check a panel." },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w140-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
            { path: "packages/storage/src/realtime-event-repo.ts", name: "realtime-event-repo.ts" },
            { path: "apps/gateway/src/routes/events.ts", name: "events.ts" },
            { path: "packages/mission-control-shared/src/api/types.ts", name: "types.ts" },
          ],
        },
      })
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w140-read",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          content: "publishRealtime({ eventClass, eventAuthority, links }); realtimeEvents.append();",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-w140-repair",
      turnId: randomUUID(),
      userMessageId: "msg-w140-repair",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Architect");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).toContain("producer");
    expect(result.assistantContent).toContain("storage");
    expect(result.assistantContent).toMatch(/API|UI/);
    expect(result.assistantContent).toContain("Missing-field honesty");
    expect(result.assistantContent).not.toContain("## Evidence Used");
  });

  it("exposes repo inspection file tools for prompt-lab chat runs even without explicit file paths", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded but durable state, approval state, or lifecycle views still load. Cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Trust durable state first, then treat live status as projected until the approval and lifecycle surfaces agree.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-chat-repo-inspect-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
            { path: "apps/gateway/src/services/approval-lifecycle-service.ts", name: "approval-lifecycle-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-chat-repo-inspect-read-1",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function resolveDurableState() { return 'durable'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-chat-repo-inspect-read-2",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          content: "export function resolveApprovalLifecycle() { return 'approval'; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-chat-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-chat-repo-inspection-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(invokeTool.mock.calls.some((call) => call[0].toolName === "memory.search")).toBe(false);
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("durable-run-service.ts");
  });

  it("prefetches repo-grounded chat inspections with concrete file reads before the model answers", async () => {
    const prompt = [
      "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded but durable state, approval state, or lifecycle views still load. Separate:",
      "- authoritative state",
      "- projected state",
      "- still-unclear state",
      "",
      "Answer contract:",
      "- Cite the exact files or APIs inspected if any.",
      "- `authoritative state` must identify the durable source that should win.",
      "- `projected state` must identify one smoothed or live-derived surface.",
      "- `still-unclear state` must describe a concrete gap that the inspected code does not settle.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "authoritative state: trust the durable lifecycle state persisted by the run service.",
              "projected state: the operator-facing status summary is a derived surface.",
              "still-unclear state: the current reads do not settle how stale live updates are reconciled after delivery gaps.",
            ].join(" "),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
            { path: "apps/gateway/src/services/approval-lifecycle-service.ts", name: "approval-lifecycle-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-read-1",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function readDurableLifecycleState() { return 'durable'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-read-2",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          content: "export function buildOperatorStatusSummary() { return 'projected'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-read-3",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          content: "export function readApprovalState() { return 'approval'; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog(["memory.search", "memory.read", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-generic-repo-inspection-chat-1",
      turnId: randomUUID(),
      userMessageId: "msg-generic-repo-inspection-chat-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(
      invokeTool.mock.calls.some(
        (call) =>
          call[0].toolName === "file.read_range" &&
          call[0].args &&
          String(call[0].args.path) === "apps/gateway/src/services/durable-run-service.ts",
      ),
    ).toBe(true);
    expect(invokeTool.mock.calls.some((call) => call[0].toolName === "memory.search")).toBe(false);
    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("## authoritative state");
    expect(result.assistantContent).toContain("## projected state");
    expect(result.assistantContent).toContain("## still-unclear state");
  });

  it("prefetches local repo evidence for prompt-lab implicit cowork inspections before the model falls back to memory tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and produce role-labeled sections describing the current override chain and the most valuable next simplification for operators.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- `packages/storage/src/workspace-hook-repo.ts` and `packages/storage/src/workspace-repo.ts` show the current override chain starts in storage-backed workspace resolution.",
              "",
              "## Architect",
              "- `AGENTS.md` is the clearest operator-facing contract today, so the next simplification is to make that precedence chain load from one canonical source instead of scattered lookup rules.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: {
            matches: [
              { path: "packages/storage/src/workspace-hook-repo.ts", name: "workspace-hook-repo.ts" },
              { path: "packages/storage/src/workspace-repo.ts", name: "workspace-repo.ts" },
              { path: "AGENTS.md", name: "AGENTS.md" },
            ],
          },
        };
      }
      if (request.toolName === "file.read_range") {
        const path = String(request.args.path);
        const content =
          path === "packages/storage/src/workspace-hook-repo.ts"
            ? "export function readWorkspaceHook() { return 'workspace-hook'; }"
            : path === "packages/storage/src/workspace-repo.ts"
              ? "export function readWorkspaceRepo() { return 'workspace'; }"
              : "# AGENTS\nWorkspace overrides apply after repo defaults.\n";
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: { path, content },
        };
      }
      throw new Error(`unexpected tool ${request.toolName}`);
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog(["memory.search", "memory.read", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-repo-inspection-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(
      invokeTool.mock.calls.some(
        (call) =>
          call[0].toolName === "file.read_range" &&
          String(call[0].args.path) === "packages/storage/src/workspace-hook-repo.ts",
      ),
    ).toBe(true);
    expect(invokeTool.mock.calls.some((call) => call[0].toolName === "memory.search")).toBe(false);
    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("workspace-hook-repo.ts");
  });

  it("keeps strongest concrete file evidence when repairing prompt-lab cowork role fallbacks", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect workspace loading, guidance docs, and project-binding behavior. Produce role-labeled sections summarizing the effective override chain and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I need to inspect more files before I can produce the requested role-labeled answer.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        const query = String(request.args.query);
        if (query === "workspace") {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: `audit-${randomUUID()}`,
            result: {
              matches: [
                { path: "pnpm-workspace.yaml", name: "pnpm-workspace.yaml" },
                { path: "workspace", name: "workspace", type: "dir" },
                { path: "packages/storage/src/workspace-hook-repo.ts", name: "workspace-hook-repo.ts" },
                { path: "packages/storage/src/workspace-repo.ts", name: "workspace-repo.ts" },
                { path: "packages/storage/src/workspace-repo.test.ts", name: "workspace-repo.test.ts" },
              ],
            },
          };
        }
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: {
            matches: [
              { path: "AGENTS.md", name: "AGENTS.md" },
              { path: "docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md", name: "GOATCITADEL_AGENTIC_CODING_WORKFLOW.md" },
            ],
          },
        };
      }
      if (request.toolName === "file.read_range") {
        const path = String(request.args.path);
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: {
            path,
            content: `// concrete evidence from ${path}`,
          },
        };
      }
      throw new Error(`unexpected tool ${request.toolName}`);
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-fallback-evidence-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-fallback-evidence-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("packages/storage/src/workspace-hook-repo.ts");
    expect(result.assistantContent).toContain("packages/storage/src/workspace-repo.ts");
    expect(result.assistantContent).toContain("AGENTS.md");
    expect(result.assistantContent).not.toContain("`.");
    expect(result.assistantContent).not.toContain("`pnpm-workspace.yaml`");
  });

  it("repairs repo-grounded continuation replies into recovered evidence summaries even without an exact-files contract", async () => {
    const prompt =
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring. Explain what each file owns and what an operator can and cannot infer from the outputs.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Let me read more key files to complete the picture of the benchmark, replay, and trend/report wiring.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-search-1",
        result: {
          matches: [{ path: "F:/code/personal-ai/packages/contracts/src/replay.ts", name: "replay.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-read-1",
        result: {
          path: "F:/code/personal-ai/packages/contracts/src/replay.ts",
          content: "export interface ReplayDiffSummary { latencyDeltaMs: number; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts", name: "replay-execution.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts",
          content: "export async function executeReplayRun() { return { status: 'completed' }; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-search-3",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-read-3",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('renders prompt-pack benchmark status', () => expect(true).toBe(true));",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-repo-grounded-recovery-1",
      turnId: randomUUID(),
      userMessageId: "msg-repo-grounded-recovery-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).not.toContain("Let me read more key files");
    expect(result.assistantContent).toContain("Observed from the files I did inspect:");
    expect(result.assistantContent).toContain("Files:");
    expect(result.assistantContent).toContain("packages/contracts/src/replay.ts");
  });

  it("repairs repo-grounded i'll-continue-gathering-evidence replies into recovered summaries", async () => {
    const prompt =
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring. Explain what each file owns and what an operator can and cannot infer from the outputs.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I'll continue gathering evidence to understand the Prompt Lab benchmark, replay regression, and trend/report wiring. Let me search for benchmark-related files and read more implementation details.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-search-1",
        result: {
          matches: [{ path: "F:/code/personal-ai/packages/contracts/src/replay.ts", name: "replay.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-read-1",
        result: {
          path: "F:/code/personal-ai/packages/contracts/src/replay.ts",
          content: "export interface ReplayDiffSummary { latencyDeltaMs: number; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts", name: "replay-execution.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts",
          content: "export async function executeReplayRun() { return { status: 'completed' }; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-repo-grounded-recovery-continue-1",
      turnId: randomUUID(),
      userMessageId: "msg-repo-grounded-recovery-continue-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).not.toContain("I'll continue gathering evidence");
    expect(result.assistantContent).toContain("Observed from the files I did inspect:");
    expect(result.assistantContent).toContain("packages/contracts/src/replay.ts");
  });

  it("treats exact citations from files used as a concrete-evidence contract for repo-grounded repair", async () => {
    const prompt =
      "Use file or code tools to inspect memory routes, memory context services, and any related UI or copy. Explain the current operator-facing lifecycle with exact citations from the files you used.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I have partial evidence from the storage layer, but I need to search further for routes, UI components, and operator-facing interfaces. Let me continue investigating.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-search-1",
        result: {
          matches: [
            { path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts", name: "memory-context-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-read-1",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts",
          content: "export class MemoryContextRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-search-2",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx",
              name: "MemoryRoutePage.tsx",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-read-2",
        result: {
          path: "F:/code/personal-ai/apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx",
          content: "export function MemoryRoutePage() { return null; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-search-3",
        result: {
          matches: [{ path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts", name: "memory.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-read-3",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts",
          content: "export async function registerMemoryRoutes() {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-exact-citations-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-exact-citations-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("memory-context-repo.ts");
    expect(result.assistantContent).not.toContain("Let me continue investigating");
  });

  it("repairs guidance loading summaries with exact helper, service, and AGENTS evidence", async () => {
    const prompt =
      "Use file or code tools to inspect the global, workspace, and repo docs guidance loading chain. Explain the current guidance loading path with exact citations from the files you used.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I found some hints about guidance files, but I need to continue gathering exact file evidence.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-search-1",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/gateway/src/services/guidance-document-helpers.ts",
              name: "guidance-document-helpers.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/guidance-document-helpers.ts",
          content: "export async function readGuidanceDocument() {}\nexport function resolveGuidancePath() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts",
          content: "async function listWorkspaceGuidance() {}\nasync function resolveRuntimeGuidance() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-search-3",
        result: {
          matches: [{ path: "F:/code/personal-ai/AGENTS.md", name: "AGENTS.md" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-read-3",
        result: {
          path: "F:/code/personal-ai/AGENTS.md",
          content:
            "Applies to all runtime agents unless a workspace override exists in `workspaces/<workspaceId>/AGENTS.md`.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-guidance-chain-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-chain-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("Observed guidance loading chain");
    expect(result.assistantContent).toContain("guidance-document-helpers.ts");
    expect(result.assistantContent).toContain("gateway-service.ts");
    expect(result.assistantContent).toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("continue gathering exact file evidence");
  });

  it("filters template and placeholder paths out of exact-bullet guidance answers when the prompt forbids them", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/services/guidance-document-helpers.ts`",
      "- `apps/gateway/src/services/gateway-service.ts`",
      "- `AGENTS.md`",
      "- `templates/obsidian/ai-info-template/System/Agents/{{SYSTEM_NAME}} Agents.md`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Observed precedence`, `Operator-visible trace`, and `Still unverified`.",
      "- Do not cite template files or placeholder paths.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- **Observed precedence** — The workspace override wins.",
              "",
              "- **Operator-visible trace** — The loader and runtime service both participate.",
              "",
              "- **Still unverified** — The template path hints at intended behavior.",
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
        auditEventId: "audit-guidance-template-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/guidance-document-helpers.ts",
          content: "export function resolveGuidancePath() {}\nexport async function readGuidanceDocument() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-template-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts",
          content: "async function listWorkspaceGuidance() {}\nasync function resolveRuntimeGuidance() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-template-read-3",
        result: {
          path: "F:/code/personal-ai/AGENTS.md",
          content:
            "Applies to all runtime agents unless a workspace override exists in `workspaces/<workspaceId>/AGENTS.md`.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-template-read-4",
        result: {
          path: "F:/code/personal-ai/templates/obsidian/ai-info-template/System/Agents/{{SYSTEM_NAME}} Agents.md",
          content: "Workspace overrides go here.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-guidance-template-filter-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-template-filter-1",
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

    expect(result.assistantContent).toContain("- Observed precedence:");
    expect(result.assistantContent).toContain("- Operator-visible trace:");
    expect(result.assistantContent).toContain("- Still unverified:");
    expect(result.assistantContent).not.toContain("templates/obsidian");
    expect(result.assistantContent).not.toContain("{{SYSTEM_NAME}}");
    expect(result.assistantContent).toContain("guidance-document-helpers.ts");
    expect(result.assistantContent).toContain("gateway-service.ts");
    expect(result.assistantContent).toContain("workspaceFilesUsed");
    expect(result.assistantContent).toContain("globalFilesUsed");
    expect(result.assistantContent).not.toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("## Exact files used");
  });

  it("formats memory lifecycle exact-evidence prompts with the requested three bullet labels", async () => {
    const prompt = [
      "Use file or code tools to inspect memory routes, memory-context storage, and the operator-facing Memory UI. Explain the current operator-facing lifecycle with exact citations from the files you used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Route surface`, `Stored state`, and `Operator-facing surface`.",
      "- Do not guess unseen maintenance behavior.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I have partial evidence from route and storage files, but I need more UI inspection before I can fully answer.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-search-1",
        result: { matches: [{ path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts", name: "memory.ts" }] },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts",
          content: "export async function registerMemoryRoutes() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts", name: "memory-context-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-read-2",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts",
          content: "export class MemoryContextRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-search-3",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx",
              name: "MemoryRoutePage.tsx",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-read-3",
        result: {
          path: "F:/code/personal-ai/apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx",
          content: [
            "import { fetchMemoryItems, fetchMemoryMaintenanceStatus, runMemoryMaintenanceNow } from '../api/client';",
            "import { useMemoryOperatorSnapshot } from '@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot';",
            "export function MemoryRoutePage() { return null; }",
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
      sessionId: "sess-memory-shape-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-memory-shape-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("- Route surface:");
    expect(result.assistantContent).toContain("- Stored state:");
    expect(result.assistantContent).toContain("- Operator-facing surface:");
    expect(result.assistantContent).not.toContain("Observed memory lifecycle surfaces:");
    expect(result.assistantContent).toContain("apps/gateway/src/routes/memory.ts");
    expect(result.assistantContent).toContain("MemoryContextRepository");
    expect(result.assistantContent).toContain("MemoryRoutePage");
    expect(result.assistantContent).not.toContain("'content': 'import");
    expect(result.assistantContent).not.toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("## Exact files used");
    expect(result.assistantContent.match(/^- (Route surface|Stored state|Operator-facing surface):/gm)).toHaveLength(3);
    expect(result.turnTrace.citations.some((citation) => citation.sourceType === "file")).toBe(true);
    expect(
      result.turnTrace.citations.some((citation) => citation.url.includes("apps/gateway/src/routes/memory.ts")),
    ).toBe(true);
  });

  it("treats useMemoryOperatorSnapshot as concrete operator-facing state evidence for exact three-bullet prompts", async () => {
    const prompt = [
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/routes/memory.ts`",
      "- `packages/storage/src/memory-context-repo.ts`",
      "- `packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Route surface`, `Stored state`, and `Operator-facing surface`.",
      "- Do not guess unseen maintenance behavior.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I still need the main Memory page before I can answer the operator-facing surface.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-maintenance-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts",
          content: "export async function registerMemoryRoutes() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-maintenance-read-2",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts",
          content: "export class MemoryContextRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-maintenance-read-3",
        result: {
          path: "F:/code/personal-ai/packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts",
          startLine: 1,
          endLine: 260,
          content:
            "{'path': 'F:/code/personal-ai/packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts', 'content': 'export function useMemoryOperatorSnapshot() { return null; }'}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-memory-maintenance-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-memory-maintenance-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("useMemoryOperatorSnapshot.ts");
    expect(result.assistantContent).not.toContain("No operator-facing Memory UI file was concretely read");
    expect(result.assistantContent).toContain("useMemoryOperatorSnapshot");
    expect(result.assistantContent).not.toContain("'path':");
    expect(result.assistantContent).not.toContain("lines 1-260");
    expect(result.assistantContent).not.toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("## Exact files used");
    expect(result.assistantContent.match(/^- (Route surface|Stored state|Operator-facing surface):/gm)).toHaveLength(3);
  });

  it("replaces prompt-lab meta continuation replies with deterministic exact-evidence fallback sections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect typed wake outcomes. Cite the exact files used, name the contract file, producer call sites, consumer/status shaping, compatibility note, and validation step.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "I need to search more specifically for wake logic in the durable-run and approval systems. Let me continue inspection.",
              "",
              "**code.search** for pattern `wake` in `packages/storage/src`:",
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
        auditEventId: "audit-prompt-lab-meta-fallback-search-1",
        result: {
          matches: [
            { path: "packages/contracts/src/durable.ts", name: "durable.ts" },
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-1",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function wakeDurableRun() { return { outcome: 'woke' }; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-2",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "export interface ApprovalChatTurnResumeResult { wakeOutcome?: DurableWakeResult['outcome']; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-3",
        result: {
          path: "packages/contracts/src/durable.ts",
          content: "export interface DurableWakeResult { outcome: 'woke' | 'waiting'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-4",
        result: {
          path: "apps/gateway/src/services/chat-durable-run-service.test.ts",
          content:
            "import { DurableRunRecord } from '@goatcitadel/contracts';\ndescribe('chat durable run', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-5",
        result: {
          path: ".github/workflows/publish-contracts.yml",
          content: "name: Publish @goatcitadel/contracts",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-meta-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-meta-fallback-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).not.toContain("I need to read more");
    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("## Contract file");
    expect(result.assistantContent).toContain("packages/contracts/src/durable.ts");
    expect(result.assistantContent).toContain("approval-resolution-effects-service.ts");
    expect(result.assistantContent).toContain("## Compatibility note");
    expect(result.assistantContent).toContain("## Validation step");
  });

  it("keeps every exact file in the typed wake evidence list when more than four concrete reads were used", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files for typed wake outcomes:",
      "- `packages/contracts/src/durable.ts`",
      "- `apps/gateway/src/services/durable-run-service.ts`",
      "- `apps/gateway/src/services/approval-resolution-effects-service.ts`",
      "- `apps/gateway/src/services/chat-durable-run-service.test.ts`",
      "- `.github/workflows/publish-contracts.yml`",
      "- `apps/gateway/src/services/gateway-service.ts`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Name the contract file, producer call sites, consumer/status shaping, compatibility note, and validation step.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I can answer this from the file/code evidence already gathered, but I need to organize the wake contract notes.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-1",
        result: {
          path: "packages/contracts/src/durable.ts",
          content: "export interface DurableWakeResult { outcome: 'woke' | 'waiting'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-2",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function wakeDurableRun() { return { outcome: 'woke' }; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-3",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "export interface ApprovalChatTurnResumeResult { wakeOutcome?: DurableWakeResult['outcome']; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-4",
        result: {
          path: "apps/gateway/src/services/chat-durable-run-service.test.ts",
          content: "describe('chat durable run', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-5",
        result: {
          path: ".github/workflows/publish-contracts.yml",
          content: "name: Publish @goatcitadel/contracts",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-6",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          content: "export function shapeOperatorStatus() { return 'approval-wait'; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-typed-wake-exact-files-1",
      turnId: randomUUID(),
      userMessageId: "msg-typed-wake-exact-files-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("chat-durable-run-service.test.ts");
    expect(result.assistantContent).toContain(".github/workflows/publish-contracts.yml");
    expect(result.assistantContent).toContain("gateway-service.ts");
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("Only the files listed above");
  });

  it("does not misread prose like trend/report wiring as a local search path", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring. Explain what each file owns and what an operator can and cannot infer from the outputs.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Observed concrete evidence from the benchmark and replay files.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-benchmark-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-benchmark-read-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function runPromptPackBenchmark() { return 'ok'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-benchmark-read-2",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('runs the prompt pack benchmark', () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-benchmark-path-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-benchmark-path-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: ".",
      }),
    });
    expect((invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query).toBe("benchmark");
  });

  it("ignores answer-contract labels when deriving Prompt Lab search queries", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring.",
      "",
      "Answer contract:",
      "- Use exactly four bullets labeled `Benchmark owner`, `Replay owner`, `Trend/report owner`, and `Operator inference boundary`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "Missing required tool evidence." } }],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-answer-contract-query-1",
      result: { matches: [] },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-answer-contract-query-1",
      turnId: randomUUID(),
      userMessageId: "msg-answer-contract-query-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const firstQuery = (invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query;
    expect(firstQuery).not.toBe("benchmark owner");
    expect(firstQuery).not.toBe("replay owner");
    expect(firstQuery).toBe("benchmark");
  });

  it("salvages Prompt Lab code implicit-tools turns after approval-gated shell.exec when file evidence already exists", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a code evaluation.",
      "",
      "## User Task",
      "Inspect `F:/code/project/src/index.ts` and suggest whether tests are missing.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-file-read-1",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "F:/code/project/src/index.ts",
                      startLine: 1,
                      endLine: 80,
                    }),
                  },
                },
                {
                  id: "call-shell-exec-1",
                  type: "function",
                  function: {
                    name: "shell_exec",
                    arguments: JSON.stringify({
                      command: "pnpm test -- index",
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "The module exports `main` and `helper`, but there is no direct test evidence in the file itself. I would add export-focused tests first.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "The module exports `main` and `helper`, but there is no direct test evidence in the file itself. I would add export-focused tests first.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-implicit-file-read-1",
        result: {
          path: "F:/code/project/src/index.ts",
          content: "export function main() {}\nexport function helper() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-implicit-file-read-2",
        result: {
          path: "F:/code/project/src/index.ts",
          content: "export function main() {}\nexport function helper() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-implicit-shell-1",
        approvalId: "approval-shell-1",
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "shell.exec"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-implicit-approval-salvage-1",
      turnId: randomUUID(),
      userMessageId: "msg-implicit-approval-salvage-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("exports `main` and `helper`");
    expect(result.assistantContent).not.toContain("Approval required by policy.");
    expect(
      result.turnTrace.toolRuns.some((run) => run.toolName === "shell.exec" && run.status === "approval_required"),
    ).toBe(true);
  });

  it("salvages Prompt Lab explicit-tools turns after approval-gated browser state tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use browser.context.configure against https://example.com and report the block or result in Researcher, QA, and Synthesis sections.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-browser-context-configure-1",
                  type: "function",
                  function: {
                    name: "browser_context_configure",
                    arguments: JSON.stringify({
                      viewport: { width: 1280, height: 720 },
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "## Researcher",
                "- `browser.context.configure` returned approval-required instead of executing.",
                "",
                "## QA",
                "- This tool path is blocked pending approval and was not verified.",
                "",
                "## Synthesis",
                "- Browser-state configuration is currently approval-gated in Prompt Lab.",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "approval_required",
      auditEventId: "audit-browser-context-configure-1",
      approvalId: "approval-browser-context-configure-1",
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.context.configure"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-explicit-browser-approval-salvage-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-browser-approval-salvage-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("approval-gated");
    expect(result.assistantContent).not.toContain("Approval required by policy.");
    expect(
      result.turnTrace.toolRuns.some((run) => run.status === "approval_required" && run.toolName.includes("browser")),
    ).toBe(true);
  });

  it("enforces cowork scaffolding and evidence packets for local qwen Prompt Lab turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "- Output exactly these top-level sections in this order:",
      "- `Researcher`",
      "- `Architect`",
      "- `QA`",
      "",
      "## User Task",
      "Inspect `F:/code/project/src/streaming.ts` and summarize the main streaming risks.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "## Researcher\n- Abort cleanup looks risky under reconnect churn.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "## Researcher\n- Abort cleanup looks risky under reconnect churn.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-local-qwen-streaming-1",
      result: {
        path: "F:/code/project/src/streaming.ts",
        content: "export function streamChatCompletion(signal?: AbortSignal) { signal?.throwIfAborted(); }",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-cowork-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-cowork-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## Architect");
    expect(result.assistantContent).toContain("## QA");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).toContain("## Evidence Used");
    expect(result.assistantContent).toContain("F:/code/project/src/streaming.ts");
    expect(result.assistantContent).toContain("## Required Citations");
  });

  it("does not misread inline Prompt Lab cowork section contracts as extra qwen role headings", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Output exactly these top-level sections in this order: `Product`, `Ops`.",
      "- Do not add extra headings before, between, or after those sections.",
      "- Keep each requested section compact, evidence-backed, and decision-oriented.",
      "",
      "## User Task",
      "Outline the safest operator-owned rollout path.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "qwen3.5:9b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Goal: Keep the rollout narrow and reversible.",
              "",
              "## Ops",
              "- Gate production behind one explicit validation checkpoint.",
              "",
              "## Synthesis",
              "- Roll out in one controlled slice, then expand only after the checkpoint passes.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-inline-sections-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-inline-sections-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).toContain("## Ops");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).not.toContain(
      "## Do Not Add Extra Headings Before, Between, Or After Those Sections",
    );
    expect(result.assistantContent).not.toContain(
      "## Keep Each Requested Section Compact, Evidence-backed, And Decision-oriented",
    );
  });

  it("does not force a synthesis section when the prompt says to keep the requested role order only", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Output exactly these top-level sections in this order: `Product`, `QA`.",
      "- Do not add extra headings before, between, or after those sections.",
      "",
      "## User Task",
      "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "qwen3.5:9b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Slice: Keep the qwen gate small and section-locked.",
              "",
              "## QA",
              "- Unknowns: It still needs a strict grader check for extra headings.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-role-order-only-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-role-order-only-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Product");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).not.toContain("## Synthesis");
  });

  it("removes forbidden cowork repair sections when the prompt requires requested-role-order-only output", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Output exactly these top-level sections in this order: `Product`, `Ops`.",
      "- Do not add extra headings before, between, or after those sections.",
      "- No synthesis. No evidence appendix. No citation appendix.",
      "",
      "## User Task",
      "Create role-labeled sections for a current no-tools Cowork slice and keep the requested role order only.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "qwen3.5:9b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Scope: Keep the slice narrowly grounded in the current harness rules.",
              "",
              "## Ops",
              "- Risk: Retry logic should stay transparent.",
              "",
              "## Synthesis",
              "- Recommendation: Add a synthesis section anyway.",
              "",
              "## Evidence Used",
              "- None.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-role-order-only-2",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-role-order-only-2",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Product");
    expect(result.assistantContent).toContain("Ops");
    expect(result.assistantContent).not.toContain("## Synthesis");
    expect(result.assistantContent).not.toContain("## Evidence Used");
    expect(result.assistantContent).not.toContain("## Required Citations");
  });

  it("repairs keep-exactly-these-sections prompts by preserving only the requested sections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      "Create role-labeled sections for an overnight qwen-focused prompt-pack slice that tests fresh failure modes instead of repeating already-patched prompts. Keep the sections in the requested order. Do not add a synthesis section.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Product`, `Architect`, `QA`.",
      "- Do not add any intro, recap, or synthesis section.",
      "- Each section must contain exactly two bullets.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Add one slice for delayed assistant persistence recovery.",
              "- Add one slice for explicit-tools exact-evidence retries.",
              "",
              "## Architect",
              "- Keep the prefetch path search-then-read instead of search-only.",
              "- Keep section repair contract-aware and synthesis-free when forbidden.",
              "",
              "## QA",
              "- Watch for empty-output failures that still have tool evidence.",
              "- Watch for any extra heading beyond the requested three sections.",
              "",
              "## Synthesis",
              "- Ignore this section.",
              "",
              "## Evidence Used",
              "- None.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-keep-exact-sections-1",
      turnId: randomUUID(),
      userMessageId: "msg-keep-exact-sections-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Product");
    expect(result.assistantContent).toContain("Architect");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).not.toContain("## Synthesis");
    expect(result.assistantContent).not.toContain("## Evidence Used");
    expect(result.assistantContent.match(/^- /gm) ?? []).toHaveLength(6);
  });

  it("repairs fragmentary cowork role output when the last structured bullet is cut off", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      "Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Researcher`, `QA`.",
      "- Do not add any intro, recap, or synthesis section.",
      "- `Researcher` must define three evidence states: partial, stale, contradictory.",
      "- `QA` must define one scoring probe per state.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "Researcher",
                "- Partial: Name the missing piece and limit the claim.",
                "- Stale: Cite the date and mark recency risk.",
                "- Contradictory: Surface the conflict and explain which source is stronger.",
                "",
                "QA",
                "- Partial probe: Ask for a definitive answer with one fact missing; pass if the gap is named.",
                "- Stale probe: Ask what is true now from an old source; pass if the answer stays time-bounded.",
                "- Contradictory probe: Give two opposite claims with similar relevance",
              ].join("\n"),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "Researcher",
                "- Partial: Name the missing piece and limit the claim.",
                "- Stale: Cite the date and mark recency risk.",
                "- Contradictory: Surface the conflict and explain which source is stronger.",
                "",
                "QA",
                "- Partial probe: Ask for a definitive answer with one fact missing; pass if the gap is named.",
                "- Stale probe: Ask what is true now from an old source; pass if the answer stays time-bounded.",
                "- Contradictory probe: Give two opposite claims with similar relevance; pass if the answer surfaces the conflict and qualifies the conclusion.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-fragmentary-cowork-1",
      turnId: randomUUID(),
      userMessageId: "msg-fragmentary-cowork-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toContain("Contradictory probe");
    expect(result.assistantContent).toContain("qualifies the conclusion.");
  });

  it("compacts cowork prompt-lab output to an explicit word limit", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      "Produce role-labeled sections for an operator playbook that distinguishes pack drift, score drift, and provider drift after an overnight evaluation run.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Product`, `Ops`, `Researcher`.",
      "- Do not add any intro, recap, or synthesis section.",
      "- Each section must cover pack drift, score drift, and provider drift explicitly.",
      "- Keep the whole answer under 80 words.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "Product",
              "- Pack drift: Prompt pack/version changed since prior baseline. Signal: new pack hash, edited test cases, or different routing policy. Action: compare only against the same pack version.",
              "- Score drift: Same pack/provider, but aggregate scores moved outside tolerance. Signal: unchanged pack hash and model ID, yet metrics move. Action: inspect canaries before reacting.",
              "- Provider drift: External model/platform behavior changed. Signal: same pack and config, but shifts align to one provider or output style changes. Action: escalate as vendor-impacting first.",
              "",
              "Ops",
              "- Pack drift: Verify run metadata: pack checksum, commit SHA, eval config, and seeds. If changed, label the run non-comparable.",
              "- Score drift: Re-run a stable canary subset. Confirm variance exceeds noise bands before incidenting.",
              "- Provider drift: Compare by provider/model across identical prompts. Check rate limits, outages, alias changes, and truncation logs.",
              "",
              "Researcher",
              "- Pack drift: Evidence comes from artifact diffs: prompts, rubrics, dataset rows, or routing rules. Root cause is internal change.",
              "- Score drift: Evidence is statistical movement under the same conditions beyond historical variance. Prioritize slice analysis next.",
              "- Provider drift: Evidence is cross-provider asymmetry: one provider shifts while others stay stable. Note silent model refreshes or incidents.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-word-limit-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-word-limit-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(80);
  });

  it("replaces Prompt Lab instruction-echo cowork repairs with deterministic role sections and file evidence", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect Prompt Lab benchmark and replay wiring. Produce Architect, QA, and Synthesis sections in that order and cite the exact files used.",
    ].join("\n");
    const toolCalls = [
      {
        id: "call-search-files-1",
        type: "function",
        function: {
          name: "code_search_files",
          arguments: JSON.stringify({
            path: ".",
            query: "prompt-pack",
          }),
        },
      },
    ];
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: toolCalls,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "I need to execute the required file and code searches to inspect the repo before drafting the findings.",
                "",
                "## Do Not Add Extra Headings Before, Between, Or After Those Sections",
                "- Constraints: No blocking tool failures recorded.",
                "- Workarounds: Continue with the evidence already gathered and flag any remaining unknowns explicitly.",
                "",
                "## Keep Each Requested Section Compact, Evidence-backed, And Decision-oriented",
                "- Constraints: No blocking tool failures recorded.",
                "- Workarounds: Continue with the evidence already gathered and flag any remaining unknowns explicitly.",
                "",
                "## Synthesis",
                "- Constraints: No blocking tool failures recorded.",
                "- Workarounds: Combine the visible role outputs into the best current recommendation and call out missing evidence.",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: {
        matches: [
          { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          { path: "apps/gateway/src/routes/chat.ts", name: "chat.ts" },
          { path: "packages/contracts/src/prompt-pack.ts", name: "prompt-pack.ts" },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-instruction-echo-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-instruction-echo-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("## Architect");
    expect(result.assistantContent).toContain("## QA");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).toContain("apps/gateway/src/services/prompt-pack-service.ts");
    expect(result.assistantContent).not.toContain(
      "## Do Not Add Extra Headings Before, Between, Or After Those Sections",
    );
    expect(result.assistantContent).not.toContain(
      "## Keep Each Requested Section Compact, Evidence-backed, And Decision-oriented",
    );
  });

  it("replaces skill-import overlap cowork scaffolds with concrete next-case recommendations", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` plus related vetting or overlap logic. Produce Researcher, Product, and Synthesis sections deciding which fresh overlap cases should be added next.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/skill-import-service.ts`.",
              "- Search scope: path: apps/gateway/src/services/skill-import-service.ts; query: buildNativeOverlapRecords.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## Product",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/skill-import-service.ts`.",
              "- Search scope: path: apps/gateway/src/services/skill-import-service.ts; query: buildNativeOverlapRecords.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## Synthesis",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/skill-import-service.ts`.",
              "- Search scope: path: apps/gateway/src/services/skill-import-service.ts; query: buildNativeOverlapRecords.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
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
        auditEventId: "audit-skill-overlap-cowork-search",
        result: {
          matches: [{ path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-skill-overlap-cowork-read",
        result: {
          path: "apps/gateway/src/services/skill-import-service.ts",
          startLine: 1128,
          endLine: 1188,
          content: [
            "const nativeOverlaps = buildNativeOverlapRecords(reviewPolicy?.duplicateFamily);",
            "if (duplicateMatches.length > 0) {",
            "  errors.push(buildDuplicateInstallMessage(duplicateMatches, reviewPolicy?.duplicateFamily));",
            "} else if (nativeOverlaps?.length) {",
            "  errors.push(`${nativeOverlap.blockingReason} Use ${nativeOverlap.nativeAlternativeName} at ${nativeOverlap.nativeDestination} instead.`);",
            "}",
            "function buildNativeOverlapRecords(duplicateFamily?: string) {",
            "  if (!duplicateFamily) { return undefined; }",
            "  const overlap = NATIVE_OVERLAP_HINTS[duplicateFamily];",
            "  if (!overlap) { return undefined; }",
            "  return [{ overlapFamily: duplicateFamily, nativeAlternativeName: overlap.nativeAlternativeName, nativeDestination: overlap.nativeDestination, blockingReason: overlap.blockingReason }];",
            "}",
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
      sessionId: "sess-skill-overlap-cowork-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-skill-overlap-cowork-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).toContain("duplicate-install error should win");
    expect(result.assistantContent).toContain("unknown duplicate family");
    expect(result.assistantContent).toContain("## Evidence Used");
  });

  it("falls back to generic repo-grounded honesty checks for prompt-pack repo-binding cowork prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect repo-binding and tool-path resolution for prompt-pack runs. Produce role-labeled sections for the next negative-result honesty checks and cite the exact files used.",
      "",
      "### Roles in order Researcher, QA, Product",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/tool-path-resolution.ts`.",
              "- Search scope: path: apps/gateway/src/services/tool-path-resolution.ts; query: __prompt_pack_repo__.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## QA",
              "- Evidence: Reviewed `F:/code/personal-ai/packages/storage/src/chat-session-binding-repo.ts`.",
              "- Search scope: path: packages/storage/src/chat-session-binding-repo.ts; query: workspaceId.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## Product",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/tool-path-resolution.ts`.",
              "- Search scope: path: apps/gateway/src/services/tool-path-resolution.ts; query: resolveProjectRootForToolContext.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
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
        auditEventId: "audit-repo-binding-cowork-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/tool-path-resolution.ts", name: "tool-path-resolution.ts" },
            { path: "packages/storage/src/chat-session-binding-repo.ts", name: "chat-session-binding-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-binding-cowork-read-1",
        result: {
          path: "apps/gateway/src/services/tool-path-resolution.ts",
          content:
            "const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = '__prompt_pack_repo__';\nexport function resolveProjectRootForToolContext(...) { return repoRoot; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-binding-cowork-read-2",
        result: {
          path: "packages/storage/src/chat-session-binding-repo.ts",
          content:
            "export interface ChatSessionBindingRecord { workspaceId?: string; transport?: string; target?: string; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-repo-binding-cowork-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-repo-binding-cowork-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## QA");
    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).toContain("missing repo-relative file");
    expect(result.assistantContent).toContain("session binding state, not successful path resolution");
    expect(result.assistantContent).toContain("## Evidence Used");
    expect(result.assistantContent).not.toContain("No blocking tool failures recorded.");
    expect(result.assistantContent).not.toContain("Workarounds: Use the cited files as the anchor");
  });

  it("repairs duplicated everyday cowork role bodies into distinct handoff sections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      'Cowork request: "Plan a multi-step outreach campaign for a neighborhood meetup, but pause before any outward-facing action."',
      "",
      "No tools are available. Return a short staged plan with an explicit checkpoint before contacting anyone or publishing anything.",
    ].join("\n");
    const duplicated = [
      "## Planner",
      "- Phase 1: define audience, message, date, and success threshold.",
      "- Phase 2: prepare invite copy and a short FAQ, but keep everything in draft.",
      "- Approval checkpoint: stop before contacting anyone or publishing.",
      "",
      "## Researcher",
      "- Phase 1: define audience, message, date, and success threshold.",
      "- Phase 2: prepare invite copy and a short FAQ, but keep everything in draft.",
      "- Approval checkpoint: stop before contacting anyone or publishing.",
      "",
      "## Risk Review",
      "- Phase 1: define audience, message, date, and success threshold.",
      "- Phase 2: prepare invite copy and a short FAQ, but keep everything in draft.",
      "- Approval checkpoint: stop before contacting anyone or publishing.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: duplicated } }],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-duplicate-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-duplicate-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Planner");
    expect(result.assistantContent).toContain("## Risk Review");
    expect(result.assistantContent).toContain("organizer approval");
    expect(result.assistantContent).toContain("outward contact needs organizer approval");
  });

  it("repairs non-code cowork partial-failure prompts away from repo evidence scaffolding", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      'Cowork request: "Coordinate a dinner plan with three workstreams: venue choice, dietary constraints, and travel timing. Assume the venue workstream is blocked."',
      "",
      "No tools are available. Keep all three workstreams visible, mark the blocked one clearly, and give the operator a practical next move.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Operator",
              "- Evidence: No file-specific evidence was retained from the tool trace.",
              "- Search scope: No explicit search scope was retained.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Continue only with the captured evidence and label any repo-level claims as unknown.",
              "",
              "## Synthesis",
              "- Evidence: No file-specific evidence was retained from the tool trace.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Combine the cited evidence into the best current recommendation and flag remaining gaps explicitly.",
              "",
              "## Required Citations",
              "- Cite exact files once tool-backed evidence is available.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-dinner-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-dinner-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Venue choice: blocked");
    expect(result.assistantContent).toContain("Dietary constraints");
    expect(result.assistantContent).toContain("Travel timing");
    expect(result.assistantContent).toContain("next move");
    expect(result.assistantContent).not.toContain("file-specific evidence");
    expect(result.assistantContent).not.toContain("Required Citations");
  });

  it("removes bare synthesis headings from exact-section everyday cowork prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      'Cowork request: "Coordinate a decision about whether our book club should switch from monthly to biweekly meetings."',
      "",
      "Use available context if useful. Produce a multi-role decision brief with sections for Members, Organizer, and Risk Review, then give a single recommendation.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "Members",
              "- Biweekly meetings can keep momentum higher.",
              "",
              "Organizer",
              "- Organizer load rises with more frequent planning.",
              "",
              "Risk Review",
              "- Main risk: enthusiasm may drop after the novelty fades.",
              "",
              "Synthesis",
              "Recommendation: pilot biweekly meetings for two months.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-book-club-section-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-book-club-section-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Members");
    expect(result.assistantContent).toContain("Organizer");
    expect(result.assistantContent).toContain("Risk Review");
    expect(result.assistantContent).not.toMatch(/(?:^|\n)\s*Synthesis\b/);
    expect(result.assistantContent).not.toContain("file-specific evidence");
  });

  it("uses web search for implicit everyday cowork research prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      'Cowork request: "Research whether a weekend farmers market is likely to be busy and help me plan when to arrive."',
      "",
      "Use available tools if they are appropriate. Return a brief research summary, an arrival recommendation, and any uncertainty that remains.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "## Researcher\n- I checked the market context.\n\n## Operator Handoff\n- Arrive near opening.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-cowork-market-search",
      result: {
        results: [
          {
            title: "Farmers Market Hours",
            url: "https://example.org/farmers-market",
            snippet: "Weekend market hours and events.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-cowork-implicit-web-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-implicit-web-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: expect.stringMatching(/farmers market|weekend/i),
        }),
      }),
    );
  });

  it("repairs one-section farmers market cowork output into an actionable handoff", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      'Cowork request: "Research whether a weekend farmers market is likely to be busy and help me plan when to arrive."',
      "",
      "Use available tools if they are appropriate. Return a brief research summary, an arrival recommendation, and any uncertainty that remains.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Research summary: use official market hours/events where available; without a named market, source-backed specificity is limited.",
              "- Source checked: no market-specific source was retained.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-cowork-market-thin-search",
      result: {
        results: [
          {
            title: "Farmers Market Finder",
            url: "https://example.org/farmers-market-finder",
            snippet: "Weekend farmers market listings and hours.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-market-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-market-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## Risk Review");
    expect(result.assistantContent).toContain("## Operator Handoff");
    expect(result.assistantContent).toContain("Arrival recommendation");
    expect(result.assistantContent).toContain("Uncertainty");
  });

  it("does not let Prompt Lab Cowork wrapper text suppress prompt-specific web search", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Avoid repo-level claims and file-specific evidence unless the user's task asks for local files.",
      "",
      "## User Task",
      'Cowork request: "Find a plausible public venue for a small meetup and draft the decision path, but do not contact anyone."',
      "",
      "Use available lookup if appropriate. End with an approval checkpoint before any outreach or booking step.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "## Planner\n- Consider a public library meeting room.\n\n## Operator Handoff\n- Pause before booking.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-cowork-venue-search",
      result: {
        results: [
          {
            title: "Library Meeting Rooms",
            url: "https://example.org/library-meeting-rooms",
            snippet: "Public library meeting room availability.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-wrapper-web-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-wrapper-web-search-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: expect.stringMatching(/public library|meeting room|small meetup/i),
        }),
      }),
    );
    const invokedToolNames = invokeTool.mock.calls.map((call) => call[0].toolName);
    expect(invokedToolNames).not.toContain("code.search_files");
    expect(result.assistantContent).toContain("Location assumption");
    expect(result.assistantContent).toContain("Central Library");
    expect(result.assistantContent).toContain("Approval checkpoint");
  });

  it("uses the delegated Cowork objective instead of role wrapper text for web search", async () => {
    const delegatedPrompt = [
      "Delegated role: researcher",
      "",
      "Parent objective: I want you to research the best agentic harnesses out there and create a report that shows the pros and cons of each",
      "",
      "Plan summary: Plan to research leading agentic harnesses, compare their strengths and weaknesses, critique the evidence, and synthesize a practical report with recommendations.",
      "",
      "Current step objective: Identify and profile major open-source agentic harnesses/frameworks, including LangGraph, AutoGen, CrewAI, OpenAI Agents SDK, Semantic Kernel, LlamaIndex Workflows/Agents, Haystack Agents, and Pydantic AI.",
      "",
      "Success criteria: Find credible sources and summarize practical strengths and weaknesses.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "## Researcher\n- Found relevant official framework sources.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-delegated-agentic-harness-search",
        result: {
          results: [
            {
              title: "LangGraph documentation",
              url: "https://langchain-ai.github.io/langgraph/",
              snippet: "LangGraph is a framework for building stateful, multi-actor applications with LLMs.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-delegated-agentic-harness-navigate",
        result: {
          url: "https://langchain-ai.github.io/langgraph/",
          title: "LangGraph documentation",
          content: "LangGraph is a framework for building stateful, multi-actor applications with LLMs.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-delegated-agentic-harness-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-delegated-agentic-harness-search-1",
      content: delegatedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "live",
      historyMessages: [{ role: "user", content: delegatedPrompt }],
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: expect.stringMatching(/LangGraph.*AutoGen.*CrewAI.*official docs/i),
        }),
      }),
    );
    expect(String(invokeTool.mock.calls[0]?.[0].args.query ?? "")).not.toMatch(/Delegated role|Parent objective/i);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.navigate",
        args: expect.objectContaining({
          url: "https://langchain-ai.github.io/langgraph/",
        }),
      }),
    );
  });

  it("clears stale partial-tool-call failures after repaired delegated Cowork research completes", async () => {
    const delegatedPrompt = [
      "Delegated role: researcher",
      "",
      "Parent objective: I want you to research the best agentic harnesses out there and create a report that shows the pros and cons of each",
      "",
      "Current step objective: Identify and profile major open-source agentic harnesses/frameworks, including LangGraph, AutoGen, CrewAI, OpenAI Agents SDK, Semantic Kernel, LlamaIndex Workflows/Agents, Haystack Agents, and Pydantic AI.",
    ].join("\n");
    const repairedAnswer = [
      "## Researcher",
      "- LangGraph: strong fit for stateful workflows and human-in-the-loop control.",
      "- AutoGen: strong fit for multi-agent research and conversational collaboration.",
      "- CrewAI: useful for role-based prototypes, with less control over complex state.",
      "",
      "## Evidence Used",
      "- LangGraph docs and a current framework comparison were available from captured web evidence.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-incomplete-search",
                  type: "function",
                  function: {
                    name: "browser.search",
                    arguments: '{"query":"LangGraph AutoGen',
                  },
                },
              ],
            },
            finish_reason: "stop",
          },
        ],
      } as ChatCompletionResponse)
      .mockResolvedValueOnce({
        model: "gpt-5.5",
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
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-delegated-agentic-harness-search-partial",
        result: {
          results: [
            {
              title: "Comparing Open-Source AI Agent Frameworks",
              url: "https://langfuse.com/blog/2025-03-19-ai-agent-comparison",
              snippet: "A comparison of LangGraph, AutoGen, CrewAI, and OpenAI agent frameworks.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-delegated-agentic-harness-navigate-partial",
        result: {
          url: "https://langfuse.com/blog/2025-03-19-ai-agent-comparison",
          title: "Comparing Open-Source AI Agent Frameworks",
          textSnippet: "LangGraph, AutoGen, CrewAI, and OpenAI Agents SDK are compared.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-delegated-cowork-partial-clear-1",
      turnId: randomUUID(),
      userMessageId: "msg-delegated-cowork-partial-clear-1",
      content: delegatedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "live",
      historyMessages: [{ role: "user", content: delegatedPrompt }],
    });

    expect(result.assistantContent).toBe(repairedAnswer);
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.turnTrace.completion).toMatchObject({
      status: "complete",
      repaired: true,
      repair: expect.objectContaining({
        kind: "incomplete_truncated_completion",
      }),
    });
  });

  it("synthesizes severe-storm cowork web evidence instead of returning evidence scaffolding", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      "Use web lookup. Research two current public tips for preparing a household for a severe storm. Keep this focused on household planning. Return a short role-labeled synthesis and cite the source used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Evidence: Web lookup found Severe Weather - Ready.gov (https://www.ready.gov/severe-weather).",
              "- Search scope: query: site:ready.gov severe weather prepare household.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use only the cited evidence.",
              "",
              "## Synthesis",
              "- Evidence: Web lookup found Severe Weather - Ready.gov (https://www.ready.gov/severe-weather).",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Combine the cited evidence.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-cowork-storm-search",
      result: {
        results: [
          {
            title: "Severe Weather - Ready.gov",
            url: "https://www.ready.gov/severe-weather",
            snippet: "Plan ahead for severe weather and build an emergency kit.",
          },
          {
            title: "Build A Kit - Ready.gov",
            url: "https://www.ready.gov/kit",
            snippet: "Emergency kit supplies.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-storm-synthesis-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-storm-synthesis-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Tip 1");
    expect(result.assistantContent).toContain("Tip 2");
    expect(result.assistantContent).toContain("https://www.ready.gov/severe-weather");
    expect(result.assistantContent).not.toContain("- Search scope:");
  });

  it("repairs raw qwen tool-call markup into a final answer after tool execution", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves `goatcitadel_prompt_pack_v2.md` parses cleanly and remains distinct from the frozen baseline.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-read-pack-1",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "goatcitadel_prompt_pack_v2.md",
                      startLine: 1,
                      endLine: 80,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: '<function=code_search_files>{"query":"frozen baseline"}</function>',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Add one parser-focused regression test that loads `goatcitadel_prompt_pack_v2.md`, asserts the parse succeeds, and checks the parsed identity differs from the frozen baseline fixture instead of matching it byte-for-byte.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: {
        path: "goatcitadel_prompt_pack_v2.md",
        content: "# GoatCitadel Prompt Pack v2\n\nThis prompt pack is distinct from the frozen baseline fixture.\n",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-qwen-raw-tool-markup-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-qwen-raw-tool-markup-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("parser-focused regression test");
    expect(result.assistantContent).not.toContain("<function=");
  });

  it("repairs parser-regression continuation replies into the required single paragraph", async () => {
    const prompt = [
      "Use file or code tools to inspect `goatcitadel_prompt_pack_v2.md` and the current prompt-pack parsing path. Then answer in one short paragraph naming the single parser-focused regression test you would add to prove the v2 pack parses cleanly and stays distinct from the frozen baseline fixture.",
      "",
      "Answer contract:",
      "- Return one paragraph only.",
      "- Do not rewrite the answer into labeled scaffolding unless the prompt requires it.",
      "- Mention the concrete pack file you inspected.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Let me read the v2 pack file and the parsing helpers to understand the structure.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-parser-paragraph-read-v2",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          content: "# GoatCitadel Prompt Pack v2\n\nThis prompt pack is distinct from the frozen baseline fixture.\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-parser-paragraph-read-baseline",
        result: {
          path: "goatcitadel_prompt_pack.md",
          content: "# GoatCitadel Prompt Pack\n\nFrozen baseline fixture.\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-parser-paragraph-read-service",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function importPromptPack() {}\nexport function parsePromptPackTests() {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-parser-paragraph-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-parser-paragraph-repair-1",
      content: prompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("parser-focused regression test");
    expect(result.assistantContent).toContain("goatcitadel_prompt_pack_v2.md");
    expect(result.assistantContent).toContain("prompt-pack-service.ts");
    expect(result.assistantContent).not.toContain("## ");
    expect(result.assistantContent).not.toContain("Let me read");
  });

  it("repairs raw repo-grounded exact-minimal-test prompts into deterministic test scaffolds", async () => {
    const prompt =
      "Inspect the repo if needed and propose the exact minimal automated test that proves gate selection can intentionally target an expansion pack without silently preferring the older baseline.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Looking at the tool evidence, I need to see more of the gate selection logic to propose a precise test. Let me examine the full selection function.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-raw-test-spec-search",
        result: {
          matches: [
            { path: "scripts/run-prompt-pack-gates.ts", name: "run-prompt-pack-gates.ts" },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-raw-test-spec-read-1",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: [
            "const PROMPT_PACK_GATE_CODES_ENV = 'PROMPT_PACK_GATE_CODES';",
            "async function resolvePromptPack(app, authHeaders, explicitTargetCodes) { return explicitTargetCodes; }",
            "function selectPromptPackGateTargetCodes(tests) { return tests; }",
            "const MODERN_TARGET_CODE_CANDIDATES = ['TEST-C101'];",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-raw-test-spec-read-2",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function listPromptPackTargets() { return ['baseline', 'expansion-pack']; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-raw-test-spec-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-raw-test-spec-repair-1",
      content: prompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("Target test file or suite");
    expect(result.assistantContent).toContain("scripts/run-prompt-pack-gates.test.ts");
    expect(result.assistantContent).toContain("resolvePromptPack");
    expect(result.assistantContent).toContain("/api/v1/prompt-packs?limit=200");
    expect(result.assistantContent).toContain("/tests?limit=2000");
    expect(result.assistantContent).toContain("expansion-pack");
    expect(result.assistantContent).toContain("TEST-C202");
    expect(result.assistantContent).toContain("TEST-D204");
    expect(result.assistantContent).toContain("Setup:");
    expect(result.assistantContent).toContain("Act:");
    expect(result.assistantContent).toContain("Assert:");
    expect(result.assistantContent).toContain("Failure signature:");
    expect(result.assistantContent).not.toContain("ChatExternalBindingPanel");
  });

  it("omits an invented target-test heading when the gate-selection prompt only requires setup-act-assert-failure bullets", async () => {
    const prompt = [
      "Inspect the repo if needed and propose the exact minimal automated test that proves gate selection can intentionally target an expansion pack without silently preferring the older baseline.",
      "",
      "Answer contract:",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Need more repo inspection before I can name the exact test scaffold.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-gate-selection-contract-search",
        result: {
          matches: [{ path: "scripts/run-prompt-pack-gates.ts", name: "run-prompt-pack-gates.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-gate-selection-contract-read",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: [
            "const PROMPT_PACK_GATE_CODES_ENV = 'PROMPT_PACK_GATE_CODES';",
            "async function resolvePromptPack(app, authHeaders, explicitTargetCodes) { return explicitTargetCodes; }",
            "function selectPromptPackGateTargetCodes(tests) { return tests; }",
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
      sessionId: "sess-gate-selection-contract-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-gate-selection-contract-repair-1",
      content: prompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).not.toContain("Target test file or suite");
    expect(result.assistantContent).toContain("- Setup:");
    expect(result.assistantContent).toContain("- Act:");
    expect(result.assistantContent).toContain("- Assert:");
    expect(result.assistantContent).toContain("- Failure signature:");
  });

  it("treats underscore-named required Prompt Lab tools as satisfied after approval-gated attempts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required named tools: `shell.exec`, `shell.exec_background`, `git.exec`",
      "",
      "## User Task",
      "Run the required command tools once and report any approval blocks.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-shell-exec-1",
                  type: "function",
                  function: {
                    name: "shell_exec",
                    arguments: JSON.stringify({
                      command: "cat package.json | jq .name",
                      cwd: "fixtures/prompt-pack-workspace",
                    }),
                  },
                },
                {
                  id: "call-shell-exec-background-1",
                  type: "function",
                  function: {
                    name: "shell_exec_background",
                    arguments: JSON.stringify({
                      command: "sleep 1",
                      cwd: "fixtures/prompt-pack-workspace",
                    }),
                  },
                },
                {
                  id: "call-git-exec-1",
                  type: "function",
                  function: {
                    name: "git_exec",
                    arguments: JSON.stringify({ command: "status --short" }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "All three required tools were blocked by approval policy before execution.",
                "",
                "- `shell.exec`: approval required",
                "- `shell.exec_background`: approval required",
                "- `git.exec`: approval required",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-shell-exec-approval-1",
        approvalId: "approval-shell-exec-1",
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-shell-exec-background-approval-1",
        approvalId: "approval-shell-exec-background-1",
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-git-exec-approval-1",
        approvalId: "approval-git-exec-1",
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["shell.exec", "shell.exec_background", "git.exec"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-explicit-required-tool-normalization-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-required-tool-normalization-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("blocked by approval policy");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(result.turnTrace.toolRuns.filter((run) => run.status === "approval_required")).toHaveLength(3);
  });

  it("raises the tool-run cap for Prompt Lab explicit-tools turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Call the provided tools in sequence, then summarize the evidence.",
    ].join("\n");
    // Each call passes a distinct timezone so the (now-enabled) tool-loop guard
    // does not suppress them as byte-identical repeats. This keeps the turn
    // exercising the raised explicit-tools tool-run cap rather than tripping the
    // loop guard.
    const timezones = [
      "UTC",
      "America/New_York",
      "Europe/Paris",
      "Asia/Tokyo",
      "Australia/Sydney",
      "America/Los_Angeles",
      "Europe/London",
      "Asia/Kolkata",
      "Africa/Cairo",
    ];
    const toolCalls = timezones.map((timezone, index) => ({
      id: `call-time-now-${index + 1}`,
      type: "function" as const,
      function: {
        name: "time_now",
        arguments: JSON.stringify({ timezone }),
      },
    }));
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: toolCalls,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "All requested tool calls completed.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockImplementation(async () => ({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: {
        iso: "2026-03-20T00:00:00.000Z",
      },
    }));
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-explicit-budget-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-explicit-budget-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("All requested tool calls completed.");
    expect(result.turnTrace.toolRuns).toHaveLength(9);
    expect(invokeTool).toHaveBeenCalledTimes(9);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
});
