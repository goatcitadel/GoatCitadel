import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator Prompt Lab repo and evidence behavior", () => {
  it("does not use extraction fallback for file-analysis prompts that mention package.json", async () => {
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
                  id: "call-file-1",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "fixtures/prompt-pack-workspace/package.json",
                      startLine: 1,
                      endLine: 20,
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
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockRejectedValueOnce(new Error("timeout"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-file-analysis-1",
      result: {
        path: "fixtures/prompt-pack-workspace/package.json",
        content: '{\n  "name": "prompt-pack-workspace",\n  "scripts": {\n    "build": "tsc"\n  }\n}',
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-file-analysis-1",
      turnId: randomUUID(),
      userMessageId: "msg-file-analysis-1",
      content:
        "Read fixtures/prompt-pack-workspace/package.json using file tools. Analyze the scripts section and suggest missing scripts.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Read fixtures/prompt-pack-workspace/package.json using file tools. Analyze the scripts section and suggest missing scripts.",
        },
      ],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).not.toContain("recovered item(s)");
    expect(result.assistantContent).not.toContain("deterministic crawl");
    expect(result.assistantContent).toContain("Based on the sources I did retrieve");
  });

  it("preserves file-read dependency evidence in the final synthesis prompt", async () => {
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
                  id: "call-file-index",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "fixtures/prompt-pack-workspace/src/index.ts",
                      startLine: 1,
                      endLine: 80,
                    }),
                  },
                },
                {
                  id: "call-file-package",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "fixtures/prompt-pack-workspace/package.json",
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
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Dependency audit complete." } }],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-dependency-index-1",
        result: {
          path: "fixtures/prompt-pack-workspace/src/index.ts",
          content: [
            'import express from "express";',
            'import { createId, formatTimestamp, clampValue } from "./utils.js";',
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-dependency-package-1",
        result: {
          path: "fixtures/prompt-pack-workspace/package.json",
          content: ["{", '  "dependencies": {', '    "express": "^4.21.0"', "  }", "}"].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-dependency-audit-1",
      turnId: randomUUID(),
      userMessageId: "msg-dependency-audit-1",
      content:
        "Read fixtures/prompt-pack-workspace/src/index.ts and fixtures/prompt-pack-workspace/package.json using file tools. List all imports used by the server entry file and report any missing or suspicious dependencies.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Read fixtures/prompt-pack-workspace/src/index.ts and fixtures/prompt-pack-workspace/package.json using file tools. List all imports used by the server entry file and report any missing or suspicious dependencies.",
        },
      ],
    });

    const synthesisCallArgs = createChatCompletion.mock.calls.at(-1) as unknown as
      | [{ messages?: Array<{ content?: unknown }> }]
      | undefined;
    const synthesisCall = synthesisCallArgs?.[0];
    const synthesisPrompt = (synthesisCall?.messages ?? [])
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(synthesisPrompt).toMatch(/import express from \\?"express\\?";/);
    expect(synthesisPrompt).toMatch(/\\?"dependencies\\?": \{/);
    expect(synthesisPrompt).toMatch(/\\?"express\\?": \\?"\^4\.21\.0\\?"/);
  });

  it("prefetches explicit Prompt Lab file evidence before accepting a prose-only completion", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Using file/code tools, inspect these local files only:",
      "- `F:/code/personal-ai-mobile-app/src/api/streaming.ts`",
      "- `F:/code/personal-ai-mobile-app/src/api/client.ts`",
      "",
      "Summarize the main streaming risks.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Researcher\n- The streaming path has abort and cleanup risk.\n\nSynthesis\n- Audit cleanup and idempotency first.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-streaming-1",
        result: {
          path: "F:/code/personal-ai-mobile-app/src/api/streaming.ts",
          content: "export function streamChatCompletion(signal?: AbortSignal) { /* ... */ }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-client-1",
        result: {
          path: "F:/code/personal-ai-mobile-app/src/api/client.ts",
          content: "export async function createClientStream() { /* ... */ }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-prefetch-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    const invokedPaths = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )
      .map((call) => call[0])
      .filter((call) => call.toolName === "file.read_range")
      .map((call) => String(call.args.path));
    expect(invokedPaths).toContain("F:/code/personal-ai-mobile-app/src/api/streaming.ts");
    expect(result.turnTrace.toolRuns.length).toBeGreaterThanOrEqual(1);
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools");
  });

  it("does not prefetch ordinary chat text that merely mentions local filenames", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Mentioning package.json and .env in prose does not require reading local files.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-ordinary-file-mention-1",
      turnId: randomUUID(),
      userMessageId: "msg-ordinary-file-mention-1",
      content: "A pasted note mentions `package.json` and `.env`. Explain why secrets should stay out of commits.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "A pasted note mentions `package.json` and `.env`. Explain why secrets should stay out of commits.",
        },
      ],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual([]);
    expect(result.assistantContent).toContain("does not require reading local files");
  });

  it("skips sensitive filenames during automatic Prompt Lab prefetch", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file tools to inspect `package.json` and `.env`. Summarize only non-secret configuration shape.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [{ index: 0, message: { role: "assistant", content: "Configuration shape summarized." } }],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prefetch-package-safe",
      result: {
        path: "package.json",
        content: '{ "name": "goatcitadel" }',
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-sensitive-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-sensitive-prefetch-1",
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

    const invokedPaths = invokeTool.mock.calls.map((call) => String(call[0].args.path));
    expect(invokedPaths).toEqual(["package.json"]);
  });

  it("prefetches exact prompt-listed files even without an explicit required tool-family line", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/services/prompt-pack-service.ts`",
      "- `packages/storage/src/realtime-event-repo.ts`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The service and repository files show the current recovery and prune behavior.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-exact-file-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export class PromptPackService {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-exact-file-2",
        result: {
          path: "packages/storage/src/realtime-event-repo.ts",
          content: "export class RealtimeEventRepository {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-exact-file-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-exact-file-prefetch-1",
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

    const invokedPaths = invokeTool.mock.calls.map((call) => String(call[0].args.path));
    expect(invokedPaths).toContain("apps/gateway/src/services/prompt-pack-service.ts");
    expect(invokedPaths).toContain("packages/storage/src/realtime-event-repo.ts");
  });

  it("continues into related repo searches after explicit file prefetch when the prompt also asks for adjacent APIs", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect `scripts/run-prompt-pack-gates.ts` and related prompt-pack APIs. Identify the exact patch points needed so gate runs can intentionally target the expanded overnight v2 pack.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Patch the gate runner and the prompt-pack API seams together.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-read-1",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: "export async function resolvePromptPack() { return null; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts" },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-read-2",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          content: "export const promptPackRoutes = {};",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-read-3",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export class PromptPackService {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-explicit-related-apis-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-explicit-related-apis-1",
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

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({ path: "scripts/run-prompt-pack-gates.ts" }),
    });
    expect(
      invokeTool.mock.calls.some(
        (call) => call[0].toolName === "code.search_files" && String(call[0].args.path) === ".",
      ),
    ).toBe(true);
    expect(
      invokeTool.mock.calls
        .filter((call) => call[0].toolName === "file.read_range")
        .map((call) => String(call[0].args.path)),
    ).toEqual(
      expect.arrayContaining([
        "scripts/run-prompt-pack-gates.ts",
        "apps/gateway/src/routes/prompt-packs.ts",
        "apps/gateway/src/services/prompt-pack-service.ts",
      ]),
    );
  });

  it("treats bare prompt-pack filenames as explicit file evidence and closes the exact-files tail", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file tools to inspect `goatcitadel_prompt_pack.md` and `goatcitadel_prompt_pack_v2.md`. Explain how v2 differs in intent, shape, and operator use.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "v2 is the longer overnight hardening pack, while v1 stays focused on narrower capability checks.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-bare-pack-read-1",
        result: {
          path: "goatcitadel_prompt_pack.md",
          startLine: 1,
          endLine: 220,
          content: "# GoatCitadel Prompt Pack\n\nFocused capability pack.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-bare-pack-read-2",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          startLine: 1,
          endLine: 220,
          content: "# GoatCitadel Prompt Pack v2\n\nExpanded overnight hardening pack.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-bare-file-pack-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-bare-file-pack-1",
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

    const invokedPaths = invokeTool.mock.calls.map((call) => String(call[0].args.path));
    expect(invokedPaths).toContain("goatcitadel_prompt_pack.md");
    expect(invokedPaths).toContain("goatcitadel_prompt_pack_v2.md");
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("Only the files listed above were used as concrete file evidence.");
  });

  it("normalizes Prompt Lab exact-bullet answers to the requested labels and file list", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/services/prompt-pack-service.ts`",
      "- `apps/gateway/src/services/prompt-pack-service.parser-report.test.ts`",
      "- `packages/storage/src/realtime-event-repo.ts`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Observed behavior`, `Recovered failure path`, and `Guardrails`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- **Observed behavior** — The service falls back from missing output to deterministic evidence text.",
              "",
              "- **Recovered failure path** — The repository stores events and the service can recover from captured evidence.",
              "",
              "- **Guardrails** — The fallback remains evidence-only.",
              "",
              "Used exact file evidence from:",
              "`apps/gateway/src/services/prompt-pack-service.ts`.",
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
        auditEventId: "audit-normalize-exact-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export class PromptPackService {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-normalize-exact-2",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.parser-report.test.ts",
          content: "describe('PromptPackService', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-normalize-exact-3",
        result: {
          path: "packages/storage/src/realtime-event-repo.ts",
          content: "export class RealtimeEventRepository {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-normalize-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-normalize-1",
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

    expect(result.assistantContent).toContain("- Observed behavior:");
    expect(result.assistantContent).toContain("- Recovered failure path:");
    expect(result.assistantContent).toContain("- Guardrails:");
    expect(result.assistantContent).toContain("`apps/gateway/src/services/prompt-pack-service.parser-report.test.ts`");
    expect(result.assistantContent).not.toContain("Used exact file evidence from:");
  });

  it("normalizes return-exactly bullet contracts and cites searched concrete files inline", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect how repo-managed imported skills record trust metadata in `skills/extra/<skill-id>/`.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Return exactly three bullets labeled `Observed fields`, `Operator-usable fields`, and `Still ambiguous`.",
      "- Do not return JSON.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- **Observed fields** — The import flow records installed timestamps, source references, review disposition, and upstream metadata.",
              "",
              "- **Operator-usable fields** — Operators can inspect the manifest and trust policy to see where the skill came from and whether it stayed reference-only.",
              "",
              "- **Still ambiguous** — Some scoring or downstream review state is not obvious from these reads alone.",
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
        auditEventId: "audit-return-exactly-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" },
            { path: "docs/SKILL_IMPORT_AND_TRUST_POLICY.md", name: "SKILL_IMPORT_AND_TRUST_POLICY.md" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-return-exactly-read-1",
        result: {
          path: "apps/gateway/src/services/skill-import-service.ts",
          startLine: 640,
          endLine: 710,
          content: "const sourceManifestPath = path.join(installedPath, 'source.json');\nreviewDisposition: 'allow';",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-return-exactly-read-2",
        result: {
          path: "docs/SKILL_IMPORT_AND_TRUST_POLICY.md",
          startLine: 1,
          endLine: 80,
          content:
            "Installed skills are copied into skills/extra/<normalized-skill-id> with a provenance manifest at skills/extra/<skill-id>/source.json.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-return-exactly-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-return-exactly-1",
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
    expect((invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query).toBe(
      "skill-import",
    );
    expect(result.assistantContent).toContain("- Observed fields:");
    expect(result.assistantContent).toContain("- Operator-usable fields:");
    expect(result.assistantContent).toContain("- Still ambiguous:");
    expect(result.assistantContent).toContain("Exact files used in this run:");
    expect(result.assistantContent).toContain("`apps/gateway/src/services/skill-import-service.ts`");
    expect(result.assistantContent).toContain("`docs/SKILL_IMPORT_AND_TRUST_POLICY.md`");
  });

  it("appends exact citation snippets for exact-evidence comparisons", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file tools to inspect `goatcitadel_prompt_pack.md` and `goatcitadel_prompt_pack_v2.md`. Explain how v2 differs in intent, shape, and operator use, with exact citations from the files you used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "v2 is more operational and role-aware, while v1 reads more like a broader prompt-pack document.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citation-v1",
        result: {
          path: "goatcitadel_prompt_pack.md",
          startLine: 1,
          endLine: 40,
          content: "# GoatCitadel Prompt Pack\n\nFocused capability pack for baseline evaluation.\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citation-v2",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          startLine: 1,
          endLine: 40,
          content: "# GoatCitadel Prompt Pack v2\n\nExpanded overnight hardening pack with operator-facing guidance.\n",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-exact-citation-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-exact-citation-1",
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

    expect(result.assistantContent).toContain("Exact citations used:");
    expect(result.assistantContent).toContain("`goatcitadel_prompt_pack.md` lines 1-40");
    expect(result.assistantContent).toContain("`goatcitadel_prompt_pack_v2.md` lines 1-40");
    expect(result.assistantContent).toContain("Exact files used:");
  });

  it("repairs low-signal exact test prompts into target/setup/act/assert/failure bullets", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Use file or code tools to inspect `apps/gateway/src/services/approval-wait-run-service.test.ts` and `apps/gateway/src/services/approval-wait-run-service.ts`. Propose the exact minimal automated test that proves approval resolution does not resume a paused durable run.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must include both the paused state and the absence of an auto-resume side effect.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Need answer with observed/inferred maybe incomplete.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-test-spec-read-1",
        result: {
          path: "apps/gateway/src/services/approval-wait-run-service.test.ts",
          startLine: 1,
          endLine: 80,
          content: "describe('ApprovalWaitRunService', () => {\n  it('stages paused approval waits', () => {});\n});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-test-spec-read-2",
        result: {
          path: "apps/gateway/src/services/approval-wait-run-service.ts",
          startLine: 1,
          endLine: 120,
          content: "export class ApprovalWaitRunService {\n  resumePausedRun() {}\n}\n",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-test-spec-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-test-spec-repair-1",
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

    expect(result.assistantContent).toContain("- Target test file or suite:");
    expect(result.assistantContent).toContain("- Setup:");
    expect(result.assistantContent).toContain("- Act:");
    expect(result.assistantContent).toContain("- Assert:");
    expect(result.assistantContent).toContain("- Failure signature:");
    expect(result.assistantContent).toContain("approval-wait-run-service.test.ts");
    expect(result.assistantContent).toContain("Exact citations used:");
  });

  it("does not emit the local-file-access refusal for Prompt Lab audits that only say if you cannot support a claim", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Using file/code tools, inspect these local files only:",
      "- `F:/code/project/src/index.ts`",
      "",
      "If you cannot support a claim directly from file contents, move it to Unknowns.",
      "Summarize the exported API.",
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
              content: "The file exports `main` and `helper`.",
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
              content: "The file exports `main` and `helper`.",
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
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-local-file-refusal-1",
      result: {
        path: "F:/code/project/src/index.ts",
        content: "export function main() {}\nexport function helper() {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-file-refusal-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-file-refusal-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).not.toContain("I can't directly access your local project files from this runtime");
    expect(result.assistantContent).toContain("exports `main` and `helper`");
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("repairs leaked Prompt Lab missing-evidence fallback text when tool evidence already exists", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Using file/code tools, inspect these local files only:",
      "- `F:/code/project/src/index.ts`",
      "",
      "Summarize the exported API.",
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
              content: [
                "I couldn't verify that with the required tools before answering.",
                "",
                "Missing required tool evidence: file/code tools.",
                "A file-specific or source-backed answer would be speculative here, so I’m stopping instead of bluffing.",
              ].join("\n"),
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
              content: "The file exports `main` and `helper`.",
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
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-repair-1",
      result: {
        path: "F:/code/project/src/index.ts",
        content: "export function main() {}\nexport function helper() {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("exports `main` and `helper`");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools before answering.");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("replaces prose-only Prompt Lab explicit-tools answers with an honest fallback when no tool path is available", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Read `F:/code/sql-teacher/lib/db/sandbox.ts` using file/code tools and review the sandbox safety.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Findings\n- The sandbox uses strict schema guards and appears safe.",
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
      sessionId: "sess-prompt-lab-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-fallback-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    expect(result.assistantContent).toContain("I couldn't verify that with the required tools before answering.");
    expect(result.assistantContent).toContain("Missing required tool evidence: file/code tools");
    expect(result.assistantContent).not.toContain("The sandbox uses strict schema guards and appears safe.");
  });

  it("retries once then accepts a tool-backed answer for Prompt Lab explicit-tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Read `F:/code/project/src/index.ts` using file/code tools and summarize the exports.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The file exports a main function and several helpers.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prefetch-retry-1",
      result: {
        path: "F:/code/project/src/index.ts",
        content: "export function main() {}\nexport function helper() {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-retry-succeed-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-retry-succeed-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    // Prefetch should have fired for the listed file path, satisfying the requirement.
    // The model's prose answer should pass through because tool evidence exists.
    expect(createChatCompletion).toHaveBeenCalled();
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools");
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
    expect(result.turnTrace.toolRuns.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back after retry when Prompt Lab explicit-tools evidence remains missing", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Inspect the build output and explain the bundling strategy.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      // First completion: prose without tools
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The bundling strategy uses tree-shaking and code splitting.",
            },
          },
        ],
      })
      // Second completion (after retry instruction): still prose without tools
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I believe the build uses webpack with default settings.",
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-retry-fail-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-retry-fail-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    // No file paths listed → no prefetch. Model bluffed twice → fallback.
    expect(result.assistantContent).toContain("I couldn't verify that with the required tools before answering.");
    expect(result.assistantContent).toContain("Missing required tool evidence: file/code tools.");
    expect(result.assistantContent).not.toContain("tree-shaking");
    expect(result.assistantContent).not.toContain("webpack");
    // The retry path may re-ask once more after a failed local search attempt.
    expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("prefetches concrete reads after prompt-lab search hits for exact-evidence inspections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect the skill import path, overlap detection behavior, and repo-managed skill provenance metadata. Summarize the concrete evidence an operator can review today and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "Operators can review the install and overlap logic in `apps/gateway/src/services/skill-import-service.ts` and the operator-facing policy in `docs/SKILL_ADOPTION_MATRIX.md`.",
              "Those files together show the import path, overlapping family checks, and the current repo-managed provenance guidance an operator can inspect today.",
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
        auditEventId: "audit-prefetch-search-files-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" },
            { path: "docs/SKILL_ADOPTION_MATRIX.md", name: "SKILL_ADOPTION_MATRIX.md" },
            { path: "skills/extra/cloudflare-api/source.json", name: "source.json" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-read-impl-1",
        result: {
          path: "apps/gateway/src/services/skill-import-service.ts",
          content: "export async function importSkill() { return detectOverlap(); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-read-doc-1",
        result: {
          path: "docs/SKILL_ADOPTION_MATRIX.md",
          content: "# Skill adoption\n- repo-managed provenance is reviewed by operators.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-local-search-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-local-search-prefetch-1",
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

    expect(createChatCompletion).toHaveBeenCalled();
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: ".",
      }),
    });
    expect((invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query).toBeTruthy();
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({
        path: "apps/gateway/src/services/skill-import-service.ts",
      }),
    });
    expect(invokeTool.mock.calls[2]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({
        path: "docs/SKILL_ADOPTION_MATRIX.md",
      }),
    });
    expect(invokeTool.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.assistantContent).toContain("Those files together show");
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
  });

  it("retries prompt-lab repo searches from the repo root when a prompt path is missing", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a Code evaluation. Prefer concrete repo evidence.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves overlapping skill families are blocked from being installed into `skills/extra`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Add the duplicate-family regression beside `apps/gateway/src/services/skill-import-service.test.ts` using the existing skill import fixture shape.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files" && request.args.path === "skills/extra") {
        return {
          outcome: "blocked",
          policyReason:
            "execution error: ENOENT: no such file or directory, stat 'F:\\code\\personal-ai\\skills\\extra'",
          auditEventId: "audit-missing-skills-extra",
          result: {},
        };
      }
      if (request.toolName === "code.search_files" && request.args.path === ".") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-root-search-after-missing-path",
          result: {
            matches: [
              {
                path: "apps/gateway/src/services/skill-import-service.ts",
                name: "skill-import-service.ts",
                type: "file",
              },
              {
                path: "apps/gateway/src/services/skill-import-service.test.ts",
                name: "skill-import-service.test.ts",
                type: "file",
              },
              {
                path: "docs/SKILL_IMPORT_AND_TRUST_POLICY.md",
                name: "SKILL_IMPORT_AND_TRUST_POLICY.md",
                type: "file",
              },
            ],
          },
        };
      }
      if (request.toolName === "file.read_range") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-read-${String(request.args.path)}`,
          result: {
            path: request.args.path,
            startLine: request.args.startLine,
            endLine: request.args.endLine,
            content: "duplicateFamily: existingManifest.duplicateFamily; install rejects overlapping family",
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
      sessionId: "sess-prompt-lab-missing-path-root-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-missing-path-root-search-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "skills/extra" }),
    });
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(
      invokeTool.mock.calls.filter(
        (call) => call[0].toolName === "code.search_files" && call[0].args.path === "skills/extra",
      ),
    ).toHaveLength(1);
    expect(result.assistantContent).toContain("apps/gateway/src/services/skill-import-service.test.ts");
    expect(result.assistantContent).not.toContain("tool-run budget");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
  });

  it("forces synthesis instead of a prompt-lab budget failure once enough file evidence exists", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file tools to inspect these files and produce the exact minimal regression plan:",
      "- `apps/gateway/src/services/skill-import-service.ts`",
      "- `apps/gateway/src/services/skill-import-service.test.ts`",
      "- `docs/SKILL_IMPORT_AND_TRUST_POLICY.md`",
      "- `packages/contracts/src/skills.ts`",
      "- `apps/gateway/src/routes/skills.ts`",
      "- `packages/storage/src/system-settings-repo.ts`",
    ].join("\n");
    const synthesisResponse: ChatCompletionResponse = {
      model: "gemma-4-local",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Use the gathered files to add one focused regression that seeds an existing duplicate family and asserts the second install is rejected.",
          },
        },
      ],
    };
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gemma-4-local",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-extra-read",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "apps/gateway/src/services/skill-import-service.ts",
                      startLine: 1,
                      endLine: 40,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValue(synthesisResponse);
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prefetch-budget-synthesis",
      result: {
        path: "prefetched.ts",
        startLine: 1,
        endLine: 180,
        content: "duplicateFamily and import validation evidence",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-budget-synthesis-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-budget-synthesis-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "llamacpp",
      model: "gemma-4-local",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(6);
    expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(createChatCompletion.mock.calls.some((call) => call[0].tools === undefined)).toBe(true);
    expect(result.assistantContent).toContain("duplicateFamily and import validation evidence");
    expect(result.assistantContent).not.toContain("tool-run budget");
    expect(result.turnTrace.failure?.failureClass).not.toBe("tool_run_budget_exceeded");
  });

  it("prefetches repo search evidence for prompt-lab implicit repo-grounded chat inspections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain how global guidance, workspace guidance, and repo docs are currently loaded.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gemma-4-local",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "The current loading chain is anchored in `apps/gateway/src/services/guidance-loader.ts`, with workspace-specific resolution in `apps/gateway/src/services/workspace-guidance.ts`, and repo docs discovered under `docs/`.",
              "That gives operators an observed chain plus a clear place to test for remaining ambiguity.",
            ].join(" "),
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-repo-chat-prefetch-1",
      result: {
        matches: [
          { path: "apps/gateway/src/services/guidance-loader.ts", name: "guidance-loader.ts" },
          { path: "apps/gateway/src/services/workspace-guidance.ts", name: "workspace-guidance.ts" },
          { path: "docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md", name: "GOATCITADEL_AGENTIC_CODING_WORKFLOW.md" },
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
      sessionId: "sess-prompt-lab-repo-chat-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-repo-chat-prefetch-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "llamacpp",
      model: "gemma-4-local",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool.mock.calls.length).toBeGreaterThan(0);
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: ".",
      }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/services/guidance-loader.ts");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools before answering.");
  });

  it("strips incomplete-tail boilerplate for guidance-loading inspections once concrete repo evidence exists", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and summarize how global guidance, workspace guidance, and repo docs are currently loaded. Present the answer as an observed chain plus one ambiguity worth testing.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Observed Loading Chain",
              "",
              "1. Global guidance resolves from `AGENTS.md`.",
              "2. Workspace guidance resolves from `workspaces/<workspaceId>/AGENTS.md` via the same helper path logic.",
              "3. Repo docs are read through the guidance doc map and service entrypoints.",
              "",
              "## Ambiguity Worth Testing",
              "",
              "Whether runtime consumers always call the guidance helper directly or sometimes bypass it.",
              "",
              "Note: search files failed while I was working, so parts of this answer may be incomplete.",
              "",
              "Best next move: Retry search files with a narrower, more explicit input.",
              "",
              'Say "keep going" to try another approach, or give me a specific URL or narrower query.',
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
        auditEventId: "audit-guidance-loading-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/guidance-document-helpers.ts",
              name: "guidance-document-helpers.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/gateway-service.ts",
              name: "gateway-service.ts",
              type: "file",
            },
            {
              path: "AGENTS.md",
              name: "AGENTS.md",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-loading-read-helper",
        result: {
          path: "apps/gateway/src/services/guidance-document-helpers.ts",
          startLine: 1,
          endLine: 80,
          content: [
            "export function resolveGuidancePath(...) {",
            "  return path.resolve(host.config.rootDir, 'workspaces', normalizedWorkspaceId, fileName);",
            "}",
            "export async function readGuidanceDocument(...) {",
            "  const resolved = resolveGuidancePath(host, docType, scope, normalizedWorkspaceId);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-loading-read-service",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          startLine: 2300,
          endLine: 2360,
          content: [
            "public async listGlobalGuidance(): Promise<GuidanceDocumentRecord[]> {",
            "  return Promise.all((Object.keys(GUIDANCE_DOC_FILE_MAP) as GuidanceDocType[]).map((docType) =>",
            "    this.readGuidanceDocument(docType, 'global'),",
            "  ));",
            "}",
            "public async listWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {",
            "  return Promise.all(WORKSPACE_GUIDANCE_DOC_TYPES.map((docType) =>",
            "    this.readGuidanceDocument(docType, 'workspace', normalizedWorkspaceId),",
            "  ));",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-loading-read-agents",
        result: {
          path: "AGENTS.md",
          bytes: 128,
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
      sessionId: "sess-guidance-loading-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-loading-repair-1",
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
        query: "guidance-document-helpers",
      }),
    });
    expect(result.assistantContent).toContain("## Observed Loading Chain");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
    expect(result.assistantContent).not.toContain('Say "keep going"');
  });

  it("repairs workspace guidance precedence prompts into the actual runtime and operator-visible check", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated check that keeps workspace-scoped guidance precedence both stable and operator-visible.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Findings",
              "",
              "**Observed:** root `AGENTS.md` documents a workspace override.",
              "",
              "## Proposed Minimal Automated Check",
              "",
              "Create `tests/workspace-precedence.test.ts` that scans the filesystem and logs the precedence chain.",
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
        auditEventId: "audit-guidance-precedence-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/guidance-document-helpers.ts",
              name: "guidance-document-helpers.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/gateway-service.ts",
              name: "gateway-service.ts",
              type: "file",
            },
            {
              path: "AGENTS.md",
              name: "AGENTS.md",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-precedence-read-helper",
        result: {
          path: "apps/gateway/src/services/guidance-document-helpers.ts",
          startLine: 1,
          endLine: 60,
          content: [
            "export function resolveGuidancePath(...) {",
            "  return path.resolve(host.config.rootDir, 'workspaces', normalizedWorkspaceId, fileName);",
            "}",
            "export async function readGuidanceDocument(...) {",
            "  const resolved = resolveGuidancePath(host, docType, scope, normalizedWorkspaceId);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-precedence-read-service",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          startLine: 2310,
          endLine: 10460,
          content: [
            "public async listWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {",
            "  return { workspaceId: normalizedWorkspaceId, global: globalDocs, workspace: workspaceDocs };",
            "}",
            "public async resolveRuntimeGuidance(workspaceId: string): Promise<ResolvedRuntimeGuidance> {",
            "  const selected = workspaceDoc.exists ? workspaceDoc : globalDoc.exists ? globalDoc : undefined;",
            "  if (selected.scope === 'workspace') workspaceFilesUsed.push(selected.fileName);",
            "  else globalFilesUsed.push(selected.fileName);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-precedence-read-agents",
        result: {
          path: "AGENTS.md",
          startLine: 7,
          endLine: 9,
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
      sessionId: "sess-guidance-precedence-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-precedence-repair-1",
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
        query: "guidance-document-helpers",
      }),
    });
    expect(result.assistantContent).toContain('resolveRuntimeGuidance("ws-1")');
    expect(result.assistantContent).toContain('listWorkspaceGuidance("ws-1")');
    expect(result.assistantContent).toContain("workspaceFilesUsed");
    expect(result.assistantContent).toContain("workspaces/ws-1/AGENTS.md");
    expect(result.assistantContent).not.toContain("tests/workspace-precedence.test.ts");
  });

  it("repairs durable-run claim exclusivity prompts into the repo claim harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves two workers sharing one database cannot both claim the same queued durable run.",
      "",
      "Answer contract:",
      "- Name the target harness or test file.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must prove one winner and one loser against the same queued run.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `apps/gateway/src/services/tool-path-resolution.test.ts`",
              "- Setup: Add one focused case in `apps/gateway/src/services/tool-path-resolution.test.ts`.",
              "- Act: Exercise the path resolver once.",
              "- Assert: one winner and one loser against the same queued run.",
              "- Failure signature: fail when the same queued run can still be claimed twice.",
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
        auditEventId: "audit-durable-claim-search",
        result: {
          matches: [
            { path: "packages/storage/src/durable-run-repo.ts", name: "durable-run-repo.ts", type: "file" },
            { path: "packages/storage/src/durable-run-repo.test.ts", name: "durable-run-repo.test.ts", type: "file" },
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
        auditEventId: "audit-durable-claim-read-repo",
        result: {
          path: "packages/storage/src/durable-run-repo.ts",
          startLine: 308,
          endLine: 347,
          content: [
            "public tryClaimQueuedRun(input: {",
            "  runId: string;",
            "  workerId: string;",
            "}) : DurableRunRecord | undefined {",
            "  const current = this.getRun(input.runId);",
            "  if (current.status !== 'queued') return undefined;",
            "  const result = this.updateRunStmt.run({ expectedVersion: current.version });",
            "  return (result.changes ?? 0) > 0 ? this.getRun(input.runId) : undefined;",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-claim-read-repo-test",
        result: {
          path: "packages/storage/src/durable-run-repo.test.ts",
          startLine: 1,
          endLine: 139,
          content: [
            "describe('DurableRunRepository', () => {",
            "  it('serializes checkpoint state payloads safely', () => {",
            "    const repo = createRepo();",
            "  });",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-claim-read-service-test",
        result: {
          path: "apps/gateway/src/services/durable-run-service.test.ts",
          startLine: 380,
          endLine: 423,
          content: [
            "it('does not clobber a run after lease ownership moves to another worker', async () => {",
            "  const run = createRun('run-lease-steal', 'queued');",
            "  expect(runs.get(run.runId)?.leaseOwnerId).toBe('worker-other');",
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
      sessionId: "sess-durable-claim-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-durable-claim-repair-1",
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

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "durable-run-service.test.ts",
      }),
    });
    expect(result.assistantContent).toContain("packages/storage/src/durable-run-repo.test.ts");
    expect(result.assistantContent).toContain("tryClaimQueuedRun");
    expect(result.assistantContent).toContain("one winner and one loser");
    expect(result.assistantContent).not.toContain("tool-path-resolution.test.ts");
  });

  it("repairs durable-run retry-gating prompts into the worker backoff test path", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves retry-gated queued durable runs are not claimed before their backoff window expires.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must cover before-window and after-window claim behavior.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `apps/gateway/src/services/durable-run-service.test.ts`",
              "- Setup: Add one focused case beside `F:/code/personal-ai/apps/gateway/src/services/durable-run-service.ts` with a queued durable run plus a retry record whose `nextRetryAt` is still in the future before the worker starts.",
              "- Act: Start the worker once while the backoff window is still open, then move `nextRetryAt` into the past and call `requestRunProcessing(runId)` to trigger a second claim pass.",
              "- Assert: Cover before-window and after-window claim behavior by proving no workflow starts and no lease is claimed before the retry window expires, then exactly one normal claim/execution path starts after the window is due.",
              "- Failure signature: Fail if the queued run is claimed early despite a future retry gate, or if the run is still skipped after the backoff deadline has passed.",
              "Exact citations used:",
              "- `F:/code/personal-ai/apps/gateway/src/services/chat-durable-run-service.test.ts` lines 1-320",
              "",
              "Note: read range failed while I was working, so parts of this answer may be incomplete.",
              "Best next move: Retry read range with a narrower, more explicit input.",
              'Say "keep going" to try another approach, or give me a specific URL or narrower query.',
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
        auditEventId: "audit-durable-backoff-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/durable-run-service.test.ts",
              name: "durable-run-service.test.ts",
              type: "file",
            },
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts", type: "file" },
            { path: "packages/storage/src/durable-run-repo.ts", name: "durable-run-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-backoff-read-test",
        result: {
          path: "apps/gateway/src/services/durable-run-service.test.ts",
          startLine: 124,
          endLine: 165,
          content: [
            "it('waits until retry backoff is due before claiming queued runs', async () => {",
            "  const run = createRun('run-retry', 'queued', 'connector.delivery');",
            "  service.startWorker();",
            "  expect(executeWorkflow).not.toHaveBeenCalled();",
            "  service.requestRunProcessing(run.runId);",
            "  expect(executeWorkflow).toHaveBeenCalledTimes(1);",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-backoff-read-service",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          startLine: 808,
          endLine: 819,
          content: [
            "private hasFutureRetryGate(runId: string, nowIso: string): boolean {",
            "  const latestRetry = this.ctx.storage.durableRuns.listRetries(runId, 100).at(-1);",
            "  return nextRetryAt > now;",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-backoff-read-repo",
        result: {
          path: "packages/storage/src/durable-run-repo.ts",
          startLine: 453,
          endLine: 494,
          content: [
            "public upsertRetry(input: {",
            "  nextRetryAt?: string;",
            "}) {",
            "  return rows[rows.length - 1] ?? record;",
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
      sessionId: "sess-durable-backoff-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-durable-backoff-repair-1",
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

    expect(result.assistantContent).toContain("apps/gateway/src/services/durable-run-service.test.ts");
    expect(result.assistantContent).toContain("before the retry window expires");
    expect(result.assistantContent).toContain("after the backoff deadline has passed");
    expect(result.assistantContent).not.toContain("chat-durable-run-service.test.ts");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
  });

  it("repairs canonical-linkage lifecycle prompts into the runtime lifecycle test harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves runtime lifecycle prefers canonical linkage over payload, preview, or event inference when they disagree, and that diagnostics expose the fallback path.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Setup` must create a disagreement between canonical and inferred data.",
      "- `Assert` must cover both chosen linkage and emitted diagnostics.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `F:/code/personal-ai/AGENTS.md`",
              "- Setup: Setup must create a disagreement between canonical and inferred data.",
              "- Act: Invoke the smallest path that exercises the behavior anchored in `{{SYSTEM_NAME}} Agents.md` once, then capture the single transition or comparison needed for the proof.",
              "- Assert: Assert must cover both chosen linkage and emitted diagnostics.",
              "- Failure signature: Fail when the test can still pass even though runtime lifecycle prefers canonical linkage over payload, preview, or event inference when they disagree, and that diagnostics expose the fallback path. is false, or when the observed side effect/state contradicts the intended guard.",
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
        auditEventId: "audit-runtime-lifecycle-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
              name: "runtime-lifecycle-read-service.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/runtime-lifecycle-read-service.test.ts",
              name: "runtime-lifecycle-read-service.test.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-lifecycle-service.ts",
              name: "approval-lifecycle-service.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-runtime-lifecycle-read-service",
        result: {
          path: "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
          startLine: 280,
          endLine: 315,
          content: [
            "if (!state.sessionId && approval.linkage?.sessionId) {",
            "  state.sessionId = approval.linkage.sessionId;",
            "  state.resolution.sessionIdSource = 'approval_linkage';",
            "}",
            "if (!state.runId) {",
            "  const approvalWaitRunId = getApprovalWaitRunId(approval.approvalId);",
            "  if (approvalWaitRunId) state.resolution.runIdSource = 'approval_wait_run';",
            "}",
            "state.fallbackSources.add('fallback_payload');",
            "state.fallbackSources.add('fallback_preview');",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-runtime-lifecycle-read-test",
        result: {
          path: "apps/gateway/src/services/runtime-lifecycle-read-service.test.ts",
          startLine: 83,
          endLine: 146,
          content: [
            "it('prefers explicit approval linkage over fallback payload fields', async () => {",
            "  const response = await service.getRuntimeLifecycle({ approvalId: 'approval-1' });",
            "  expect(response.resolution).toMatchObject({",
            "    sessionIdSource: 'approval_linkage',",
            "    runIdSource: 'approval_linkage',",
            "    taskIdSource: 'approval_linkage',",
            "  });",
            "  expect(response.resolution?.fallbackSources).toContain('fallback_payload');",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-runtime-lifecycle-read-approval",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          startLine: 1,
          endLine: 12,
          content: "export class ApprovalLifecycleService {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-runtime-lifecycle-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-runtime-lifecycle-repair-1",
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

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "runtime-lifecycle-read-service.test.ts",
      }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/services/runtime-lifecycle-read-service.test.ts");
    expect(result.assistantContent).toContain("approval_linkage");
    expect(result.assistantContent).toContain("fallback_payload");
    expect(result.assistantContent).toContain("fallback_preview");
    expect(result.assistantContent).not.toContain("AGENTS.md");
    expect(result.assistantContent).not.toContain("{{SYSTEM_NAME}}");
  });

  it("repairs runtime lifecycle provenance-map prompts into strict four-bullet evidence", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain how runtime lifecycle currently distinguishes canonical linkage, inferred linkage, and missing linkage across approvals, durable runs, sessions, and turns.",
      "",
      "Answer contract:",
      "- Use exactly four bullets labeled `Canonical`, `Inferred`, `Missing`, and `Overstatement risk`.",
      "- Ground each of the first three bullets in a concrete observed data path or say it remains unproven.",
      "- `Overstatement risk` must name one specific operator-facing phrase or surface that could imply too much certainty.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- `Canonical`: Direct record fields are treated as authoritative links, including `turn_trace` values.",
              "- `Inferred`: Tool runs and turns are also walked.",
              "- `Missing`: Missing linkage remains unproven.",
              '- `Overstatement risk`: `source: "turn_trace"` could imply too much certainty.',
            ].join("\n\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-runtime-provenance-map-search",
          result: {
            matches: [
              {
                path: "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
                name: "runtime-lifecycle-read-service.ts",
              },
              { path: "packages/contracts/src/runtime-lifecycle.ts", name: "runtime-lifecycle.ts" },
              {
                path: "apps/gateway/src/services/approval-lifecycle-service.ts",
                name: "approval-lifecycle-service.ts",
              },
            ],
          },
        };
      }
      const pathArg = typeof request.args.path === "string" ? request.args.path : "";
      const contentByPath: Record<string, string> = {
        "apps/gateway/src/services/runtime-lifecycle-read-service.ts": [
          "assignLifecycleField(state.resolution, 'sessionIdSource', 'approval_linkage');",
          "collectTurnLinks(turns, linked);",
          "linked.runIds.add(turn.durable.runId);",
          "state.resolution.turnIdSource = 'turn_trace';",
          "state.fallbackSources.add('fallback_payload');",
          "state.fallbackSources.add('fallback_preview');",
        ].join("\n"),
        "packages/contracts/src/runtime-lifecycle.ts": [
          "export interface RuntimeLifecycleQuery {",
          "  sessionId?: string;",
          "  turnId?: string;",
          "  runId?: string;",
          "  approvalId?: string;",
          "  taskId?: string;",
          "}",
          "linkedRunCount: number;",
          "linkedApprovalCount: number;",
        ].join("\n"),
        "apps/gateway/src/services/approval-lifecycle-service.ts":
          "return { approvalId, linkage: { sessionId, runId, turnId }, payload, preview };",
      };
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-runtime-provenance-map-read-${pathArg}`,
        result: {
          path: pathArg,
          startLine: 1,
          endLine: 80,
          content: contentByPath[pathArg] ?? "runtime lifecycle related evidence",
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
      sessionId: "sess-runtime-lifecycle-provenance-map-1",
      turnId: randomUUID(),
      userMessageId: "msg-runtime-lifecycle-provenance-map-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent.split("\n").filter((line) => /^- /.test(line))).toHaveLength(4);
    expect(result.assistantContent).toContain("- Canonical:");
    expect(result.assistantContent).toContain("- Inferred:");
    expect(result.assistantContent).toContain("- Missing:");
    expect(result.assistantContent).toContain("- Overstatement risk:");
    expect(result.assistantContent).toContain("packages/contracts/src/runtime-lifecycle.ts");
    expect(result.assistantContent).toContain("apps/gateway/src/services/runtime-lifecycle-read-service.ts");
    expect(result.assistantContent).toContain("turn_trace");
    expect(result.assistantContent).toContain("not canonical proof");
    expect(result.assistantContent).toContain("runtime lifecycle linked IDs");
    expect(result.assistantContent).not.toContain("Direct record fields are treated as authoritative links");
  });

  it("repairs explicit event-link propagation prompts into the events route test harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves explicit `eventClass`, `eventAuthority`, and `links` survive from event producer to storage to operator-facing API.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must name all three fields at producer, persisted, and operator-facing stages.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `F:/code/personal-ai/apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx`",
              "- Setup: Add one focused case in `F:/code/personal-ai/apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx` anchored in `F:/code/personal-ai/packages/storage/src/chat-session-binding-repo.ts`, and stage only the initial repo state needed to prove that explicit `eventClass`, `eventAuthority`, and `links` survive from event producer to storage to operator-facing API..",
              "- Act: Invoke the smallest path that exercises the behavior anchored in `chat-session-binding-repo.ts` once, then capture the single transition or comparison needed for the proof.",
              "- Assert: Assert must name all three fields at producer, persisted, and operator-facing stages.",
              "- Failure signature: Fail when the test can still pass even though explicit `eventClass`, `eventAuthority`, and `links` survive from event producer to storage to operator-facing API. is false, or when the observed side effect/state contradicts the intended guard.",
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
        auditEventId: "audit-events-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/routes/events.ts", name: "events.ts", type: "file" },
            { path: "apps/gateway/src/routes/events.test.ts", name: "events.test.ts", type: "file" },
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-route",
        result: {
          path: "apps/gateway/src/routes/events.ts",
          startLine: 17,
          endLine: 41,
          content: [
            "fastify.get('/api/v1/events', async (request, reply) => {",
            "  const items = fastify.gateway.listRealtimeEvents(parsed.data.limit, parsed.data.cursor);",
            "  return reply.send({ items, nextCursor });",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-route-test",
        result: {
          path: "apps/gateway/src/routes/events.test.ts",
          startLine: 58,
          endLine: 95,
          content: [
            "it('emits SSE event ids from the realtime sequence', async () => {",
            "  listRealtimeEvents: () => [{ eventId: 'event-1', sequence: 42, eventType: 'system', source: 'tests', payload: { ok: true } }],",
            "  const response = await fetch(`${address}/api/v1/events/stream?replay=1`);",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-gateway",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          startLine: 9844,
          endLine: 9852,
          content: [
            "public publishRealtime(",
            "  eventType: string,",
            "  source: string,",
            "  payload: Record<string, unknown>,",
            "  options?: Pick<RealtimeEvent, 'eventClass' | 'eventAuthority' | 'links' | 'correlationId'>,",
            ") {",
            "  const event = this.storage.realtimeEvents.append(eventType, source, payload, options);",
            "  return event;",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-search-2",
        result: {
          matches: [
            {
              path: "packages/storage/src/realtime-event-repo.ts",
              name: "realtime-event-repo.ts",
              type: "file",
            },
            {
              path: "packages/storage/src/realtime-event-repo.test.ts",
              name: "realtime-event-repo.test.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-storage",
        result: {
          path: "packages/storage/src/realtime-event-repo.ts",
          startLine: 70,
          endLine: 118,
          content: [
            "append(eventType, source, payload, options) {",
            "  const event = extractRealtimeMetadata(row);",
            "  return { ...event, payload: stripRealtimeEnvelope(event.payload) };",
            "}",
            "list(limit) {",
            "  return rows.map((row) => ({ ...extractRealtimeMetadata(row), payload: stripRealtimeEnvelope(row.payload) }));",
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
      sessionId: "sess-events-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-events-repair-1",
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

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "events.test.ts",
      }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/routes/events.test.ts");
    expect(result.assistantContent).toContain("GatewayService.publishRealtime");
    expect(result.assistantContent).toContain("eventClass");
    expect(result.assistantContent).toContain("eventAuthority");
    expect(result.assistantContent).toContain("operator-facing API");
    expect(result.assistantContent).toContain("/api/v1/events?limit=1");
    expect(result.assistantContent).not.toContain("ThreadedSurfacePage.tsx");
    expect(result.assistantContent).not.toContain("chat-session-binding-repo.ts");
  });

  it("repairs approval-wake flow inspections into an observed numbered order with exact-file evidence", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect approval wait resolution, downstream wake calls, and operational event emission.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Present the answer as a numbered sequence of the observed write or call order.",
      "- End with two bullets labeled `Operator-visible partial failure` and `Still not proven`.",
      "- If a step was inferred rather than observed, label it inline as `(inferred)`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I'll inspect the relevant files to trace the approval wait resolution flow, downstream wake calls, and operational event emission. Let me read the complete implementation files.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-lifecycle-service.ts",
              name: "approval-lifecycle-service.ts",
              type: "file",
            },
            {
              path: "packages/storage/src/approval-wait-run-repo.ts",
              name: "approval-wait-run-repo.ts",
              type: "file",
            },
            {
              path: "packages/storage/src/approval-effect-repo.ts",
              name: "approval-effect-repo.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-effects-read",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          startLine: 130,
          endLine: 470,
          content: [
            "public enqueueResolutionEffects(approval: ApprovalRequest, input: ApprovalResolveInput): ApprovalEffectRecord[] {",
            "  const approvalWaitRunId = this.ctx.storage.approvalWaitRuns.getRunId(approval.approvalId);",
            "  if (approvalWaitRunId) {",
            "    this.ctx.storage.approvalEffects.upsert({ effectKind: 'approval_wait_wake', targetId: approvalWaitRunId, payload: wakePayload });",
            "  }",
            "  this.requestEffectProcessing();",
            "}",
            "private async executeClaimedEffect(effectId: string, signal?: AbortSignal): Promise<void> {",
            "  switch (effect.effectKind) {",
            "    case 'approval_wait_wake':",
            "      await this.handleWakeEffect(effect, true);",
            "      return;",
            "  }",
            "}",
            "private async handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void> {",
            "  const result = this.deps.wakeDurableRun(effect.targetId, { eventKey: 'approval.resolved' });",
            "  if (result.outcome === 'woke') {",
            "    this.ctx.storage.approvalWaitRuns.markResolved(effect.approvalId, new Date().toISOString());",
            "    this.deps.requestRunProcessing(effect.targetId);",
            "    this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, { result: resultRecord });",
            "    return;",
            "  }",
            "  this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, { result: explicitNonWakeResult });",
            "  this.ctx.publishRealtime('approval_wait_wake_skipped', 'approvals', { approvalId: effect.approvalId, targetId: effect.targetId }, { eventClass: 'operational_signal', eventAuthority: 'retained_stream' });",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-lifecycle-read",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          startLine: 491,
          endLine: 560,
          content: [
            "export async function resolveApproval(host: ApprovalLifecycleHost, approvalId: string, input: ApprovalResolveInput): Promise<ApprovalResolveResult> {",
            "  host.storage.runImmediateTransaction(() => {",
            "    approval = host.storage.approvals.resolve(approvalId, input);",
            "    host.storage.approvalEvents.append({ approvalId, eventType: 'resolved' });",
            "    host.enqueueApprovalResolutionEffects(approval, input);",
            "  });",
            "  const effects = host.storage.approvalEffects.listByApproval(approvalId);",
            "  const resolutionEffects = deriveApprovalResolutionEffectsResult(effects);",
            "  const wakeRunId = resolutionEffects?.approvalWaitDurableRunId;",
            "  if (wakeRunId && approval.linkage?.durableRunId !== wakeRunId) {",
            "    approval = host.storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: wakeRunId });",
            "  }",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-wait-read",
        result: {
          path: "packages/storage/src/approval-wait-run-repo.ts",
          startLine: 20,
          endLine: 66,
          content: [
            "public getRunId(approvalId: string): string | undefined {",
            "  return this.get(approvalId)?.runId;",
            "}",
            "public markResolved(approvalId: string, resolvedAt?: string): ApprovalWaitRunRecord | undefined {",
            "  this.markResolvedStmt.run(resolvedAt ?? new Date().toISOString(), approvalId);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-effect-repo-read",
        result: {
          path: "packages/storage/src/approval-effect-repo.ts",
          startLine: 228,
          endLine: 290,
          content: [
            "public upsert(input: { approvalId: string; effectKind: ApprovalEffectKind; targetId: string; }): ApprovalEffectRecord {",
            "  const idempotencyKey = input.idempotencyKey ?? buildApprovalEffectIdempotencyKey(input);",
            "}",
            "public claimNextPendingEffect(workerId: string, now: string, leaseExpiresAt: string, limit = 25): ApprovalEffectRecord | undefined {",
            "  return this.get(candidate.effect_id);",
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
      sessionId: "sess-approval-wake-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-approval-wake-repair-1",
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
        query: "approval-resolution-effects-service.ts",
      }),
    });
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("1. Observed");
    expect(result.assistantContent).toContain("approval_wait_wake_skipped");
    expect(result.assistantContent).toContain("`Operator-visible partial failure`");
    expect(result.assistantContent).toContain("`Still not proven`");
    expect(result.turnTrace.completion).toMatchObject({
      repaired: true,
      repair: expect.objectContaining({
        applied: true,
        kind: "prompt_pack_harness_normalization",
        source: "prompt_pack_harness",
      }),
    });
  });

  it("answers no-tools conflict prompts directly instead of surfacing a web-off refusal", async () => {
    const prompt =
      "Without assuming tool access, explain how GoatCitadel should answer when two docs appear to conflict and it cannot verify which one is authoritative right now. Keep the answer practical and high-trust.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Say what is known, name the conflicting sources, avoid claiming authority you cannot verify, and tell the operator what to check next.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-no-tools-doc-conflict-1",
      turnId: randomUUID(),
      userMessageId: "msg-no-tools-doc-conflict-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("conflicting sources");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("prefetches repo search evidence for prompt-lab implicit code inspections even without repo-assist wrapping", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves GoatCitadel can parse `pnpm outdated -r` output even when the dependents column wraps.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "The narrowest test belongs next to `packages/storage/src/pnpm-outdated-parser.test.ts` and should exercise `packages/storage/src/pnpm-outdated-parser.ts` with a wrapped dependents column fixture.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-implicit-code-search-1",
      result: {
        matches: [
          { path: "packages/storage/src/pnpm-outdated-parser.ts", name: "pnpm-outdated-parser.ts" },
          { path: "packages/storage/src/pnpm-outdated-parser.test.ts", name: "pnpm-outdated-parser.test.ts" },
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
      sessionId: "sess-implicit-code-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-implicit-code-repo-inspection-1",
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

    expect(invokeTool.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(result.assistantContent).toContain("pnpm-outdated-parser");
    expect(result.assistantContent).not.toContain("No repo files or tool output were provided");
  });

  it("repairs known prompt-lab exact-test prompts with concrete repo test code", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves GoatCitadel can parse `pnpm outdated -r` output even when the dependents column wraps.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Need answer with observed/inferred maybe incomplete.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${request.toolName}`,
          result: {
            matches: [
              {
                path: "apps/gateway/src/services/gateway/update-review.test.ts",
                name: "update-review.test.ts",
              },
              {
                path: "apps/gateway/src/services/gateway/update-review.ts",
                name: "update-review.ts",
              },
            ],
          },
        };
      }
      const pathArg = typeof request.args?.path === "string" ? request.args.path : "";
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-${request.toolName}`,
        result: {
          path: pathArg,
          startLine: 1,
          endLine: 120,
          content: pathArg.endsWith("update-review.test.ts")
            ? "describe('parsePnpmOutdatedOutput', () => { it('parses pnpm outdated table output with wrapped dependents', () => {}); });"
            : "export function parsePnpmOutdatedOutput(output: string): DependencyUpdateReviewItem[] { return []; }",
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
      sessionId: "sess-known-test-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-known-test-repair-1",
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

    expect(result.assistantContent).toContain("apps/gateway/src/services/gateway/update-review.test.ts");
    expect(result.assistantContent).toContain("parsePnpmOutdatedOutput");
    expect(result.assistantContent).toContain("@goatcitadel/orchestration");
    expect(result.assistantContent).not.toContain("Need answer with observed/inferred");
  });

  it("retries prompt-lab synthesis when the provider stops during a tool call after evidence is gathered", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves GoatCitadel can parse `pnpm outdated -r` output even when the dependents column wraps.",
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
                  id: "call-partial-1",
                  type: "function",
                  function: {
                    name: "code_search_files",
                    arguments: '{"query":"more evidence"',
                  },
                },
              ],
            },
            finish_reason: "length",
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
              content: "Use the existing `apps/gateway/src/services/gateway/update-review.test.ts` parser test.",
            },
            finish_reason: "stop",
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${request.toolName}`,
          result: {
            matches: [
              {
                path: "apps/gateway/src/services/gateway/update-review.test.ts",
                name: "update-review.test.ts",
              },
              {
                path: "apps/gateway/src/services/gateway/update-review.ts",
                name: "update-review.ts",
              },
            ],
          },
        };
      }
      const pathArg = typeof request.args?.path === "string" ? request.args.path : "";
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-${request.toolName}`,
        result: {
          path: pathArg,
          startLine: 1,
          endLine: 80,
          content: pathArg.endsWith("update-review.test.ts")
            ? "it('parses pnpm outdated table output with wrapped dependents', () => {});"
            : "export function parsePnpmOutdatedOutput(output: string) { return []; }",
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
      sessionId: "sess-partial-tool-retry-1",
      turnId: randomUUID(),
      userMessageId: "msg-partial-tool-retry-1",
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

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toContain("apps/gateway/src/services/gateway/update-review.test.ts");
    expect(result.turnTrace.failure?.message ?? "").not.toContain("tool calls were fully assembled");
    expect(result.turnTrace.completion?.status).toBe("complete");
  });

  it("prefetches ranked concrete reads for prompt-lab explicit code inspections instead of clarifying or reading low-signal artifacts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect report rendering and benchmark status surfaces. Identify the exact patch points needed so operators can see per-model wall-clock timing and estimate overnight run length.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "Patch the report assembly in `apps/gateway/src/services/prompt-pack-service.ts`,",
              "thread the benchmark timing view through `apps/gateway/src/routes/chat.ts`,",
              "and validate the surface in `apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`.",
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
        auditEventId: "audit-wall-clock-search-1",
        result: {
          matches: [
            {
              path: "artifacts/prompt-lab/manual-import-pack-81737f94-82bc-latest.md",
              name: "manual-import-pack-81737f94-82bc-latest.md",
            },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
            { path: "apps/gateway/src/routes/chat.ts", name: "chat.ts" },
            { path: "ggml/src/benchmark.c", name: "benchmark.c" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-wall-clock-read-impl-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function buildPromptPackReport() { return renderPromptPackTiming(); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-wall-clock-read-companion-1",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('renders prompt-pack timing surfaces', () => expect(true).toBe(true));",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-wall-clock-read-impl-2",
        result: {
          path: "apps/gateway/src/routes/chat.ts",
          content: "export function mapPromptPackStatus() { return { wallClockMs: 42 }; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-explicit-code-wall-clock-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-code-wall-clock-1",
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

    expect(result.assistantContent).not.toContain("What geographic area do you mean exactly");
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(
      invokeTool.mock.calls
        .filter((call) => call[0].toolName === "file.read_range")
        .map((call) => String(call[0].args.path)),
    ).toEqual(
      expect.arrayContaining([
        "apps/gateway/src/services/prompt-pack-service.ts",
        "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
        "apps/gateway/src/routes/chat.ts",
      ]),
    );
    expect(invokeTool.mock.calls.some((call) => JSON.stringify(call[0]).includes("artifacts/prompt-lab"))).toBe(false);
    expect(invokeTool.mock.calls.some((call) => JSON.stringify(call[0]).includes("ggml/src/benchmark.c"))).toBe(false);
  });

  it("continues prompt-lab exact-evidence search prefetch across multiple query seeds until enough concrete reads exist", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect prompt-pack selection, benchmark inputs, and gate-runner APIs. Identify the exact patch points needed to support a qwen-focused overnight extension pack cleanly.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Patch prompt-pack selection, benchmark inputs, and the gate runner once the qwen-focused overnight pack is registered end to end.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-search-1",
        result: {
          matches: [{ path: "scripts/run-prompt-pack-gates.ts", name: "run-prompt-pack-gates.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-read-1",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: "export async function runPromptPackGates() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-search-2",
        result: {
          matches: [{ path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-read-2",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function resolvePromptPackProjectBinding() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-search-3",
        result: {
          matches: [
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-read-3",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('runs prompt-pack benchmark inputs', () => expect(true).toBe(true));",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-qwen-multi-query-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-qwen-multi-query-prefetch-1",
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

    const searchQueries = invokeTool.mock.calls
      .map((call) => call[0])
      .filter((call) => call.toolName === "code.search_files")
      .map((call) => String(call.args.query));
    expect(searchQueries).toEqual(expect.arrayContaining(["benchmark", "gate", "run-prompt-pack-gates"]));
    expect(
      invokeTool.mock.calls
        .filter((call) => call[0].toolName === "file.read_range")
        .map((call) => String(call[0].args.path)),
    ).toEqual(
      expect.arrayContaining(["scripts/run-prompt-pack-gates.ts", "apps/gateway/src/services/prompt-pack-service.ts"]),
    );
  });

  it("continues into baseline file reads after explicit prompt-pack file prefetch when the prompt asks for distinction from the frozen baseline", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves `goatcitadel_prompt_pack_v2.md` parses cleanly and remains distinct from the frozen baseline.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Add a parser-focused regression that reads both `goatcitadel_prompt_pack_v2.md` and `goatcitadel_prompt_pack.md`, then asserts the parsed identities differ.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-pack-v2-read-1",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          content: "# GoatCitadel Prompt Pack v2\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-pack-baseline-read-1",
        result: {
          path: "goatcitadel_prompt_pack.md",
          content: "# GoatCitadel Prompt Pack\n",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-pack-v2-baseline-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-pack-v2-baseline-prefetch-1",
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

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({ path: "goatcitadel_prompt_pack_v2.md" }),
    });
    const invokedPaths = invokeTool.mock.calls
      .filter((call) => call[0].toolName === "file.read_range")
      .map((call) => String(call[0].args.path));
    expect(invokedPaths).toEqual(
      expect.arrayContaining(["goatcitadel_prompt_pack_v2.md", "goatcitadel_prompt_pack.md"]),
    );
    expect(result.assistantContent).toContain("goatcitadel_prompt_pack.md");
  });

  it("filters low-signal temp matches and searches subsystem nouns for explicit event-envelope audits", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect event producers, realtime-event storage, and related contracts. Identify the exact patch points needed so approval, run, session, task, and proactive events publish explicit `eventClass`, `eventAuthority`, and `links`, and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Patch the realtime-event storage and event producer contracts together.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-search-1",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/.codex-tmp/llama-inspect/tools/server/webui/src/lib/markdown/enhance-links.ts",
              name: "enhance-links.ts",
            },
            { path: "F:/code/personal-ai/packages/storage/src/realtime-event-repo.ts", name: "realtime-event-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-read-1",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/realtime-event-repo.ts",
          content: "export class RealtimeEventRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-search-2",
        result: {
          matches: [{ path: "F:/code/personal-ai/packages/contracts/src/realtime.ts", name: "realtime.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-read-2",
        result: {
          path: "F:/code/personal-ai/packages/contracts/src/realtime.ts",
          content: "export interface RealtimeEvent {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-search-3",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-read-3",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "export function publishApprovalEvent() {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-event-envelope-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-event-envelope-prefetch-1",
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

    const searchQueries = invokeTool.mock.calls
      .map((call) => call[0])
      .filter((call) => call.toolName === "code.search_files")
      .map((call) => String(call.args.query));
    expect(searchQueries).toEqual(expect.arrayContaining(["realtime-event", "approval", "session"]));
    expect(searchQueries).not.toContain("eventclass");
    expect(searchQueries).not.toContain("links");
    expect(invokeTool.mock.calls.some((call) => JSON.stringify(call[0]).includes(".codex-tmp"))).toBe(false);
  });
});
