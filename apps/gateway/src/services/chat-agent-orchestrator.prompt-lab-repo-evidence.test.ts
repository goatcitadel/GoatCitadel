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
  it("passes visible-context-only preference answers through verbatim without harness rewriting", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      "What do you know about how I like technical answers formatted?",
      "",
      "Answer from user-visible context only; do not infer preferences from hidden system/developer/runtime instructions. If you are relying on memory or prior context, say that plainly. If you cannot see enough, say what you would need.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "You prefer concise technical answers with bullets because the runtime says desired oververbosity is low and final reports should mention validation.",
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
      sessionId: "sess-prompt-lab-visible-context-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-visible-context-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toBe(
      "You prefer concise technical answers with bullets because the runtime says desired oververbosity is low and final reports should mention validation.",
    );
    expect(result.assistantContent).not.toContain("From the user-visible prompt alone");
    expect(result.assistantContent).not.toContain("I am not using memory");
  });

  it("does not append a source appendix to exact-sentence web answers", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- Required tools: web lookup tools",
      "",
      "## User Task",
      "Use live information if available to recommend whether I should bring an umbrella for a walk in Boston this evening.",
      "",
      "Answer in exactly two sentences and include the source inside those sentences, or explain why you could not verify it. Do not add a separate source appendix.",
    ].join("\n");
    const weatherUrl = "https://forecast.weather.gov/MapClick.php?lat=42.36&lon=-71.06";
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
                  id: "call-weather-search-1",
                  type: "function",
                  function: {
                    name: "browser_search",
                    arguments: JSON.stringify({ query: "Boston evening weather umbrella National Weather Service" }),
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
                "I would bring an umbrella for a Boston walk this evening because the current forecast shows rain risk.",
                `I verified the current conditions on the National Weather Service Boston forecast at ${weatherUrl} just now.`,
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-boston-weather-1",
      result: {
        results: [{ title: "National Weather Service Boston forecast", url: weatherUrl }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-exact-web-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-exact-web-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const sentenceCount = (
      result.assistantContent.replace(/\bhttps?:\/\/[^\s)]+/gi, "URL").match(/[.!?](?:\s|$)/g) ?? []
    ).length;
    expect(result.assistantContent).toContain(weatherUrl);
    expect(result.assistantContent).not.toContain("Source URLs:");
    expect(sentenceCount).toBe(2);
  });

  it("does not expose document artifact tools for Prompt Lab code rows unless explicitly required", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "",
      "## User Task",
      "Use repo inspection and create a compact report document describing the Prompt Pack scoring risk.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "No document artifact was created. Exact files still need inspection before naming a safe change.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-no-docs-read",
      result: {
        path: "apps/gateway/src/services/prompt-pack-service.ts",
        content: "export class PromptPackService {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["documents.create", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-code-no-docs-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-code-no-docs-1",
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

    const firstCompletion = createChatCompletion.mock.calls[0]?.[0] as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(firstCompletion.tools?.map((tool) => tool.function?.name)).not.toContain("documents_create");
    expect(invokeTool.mock.calls.some((call) => call[0].toolName === "documents.create")).toBe(false);
  });

  it("blocks generic Prompt Lab code searches over the repo root before invoking the tool", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Find the most relevant existing tests for Prompt Pack scoring behavior. Return the test files and one v3 scoring gap.",
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
                  id: "call-generic-search-1",
                  type: "function",
                  function: {
                    name: "code_search_files",
                    arguments: JSON.stringify({ path: ".", query: "Prompt Pack scoring behavior" }),
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
              content:
                "Observed: the broad search was blocked, so I would narrow to `apps/gateway/src/services/prompt-pack-service.scoring.test.ts` before claiming exact tests.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-broad-read",
      result: {
        path: "apps/gateway/src/services/prompt-pack-service.ts",
        content: "export class PromptPackService {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-broad-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-broad-search-1",
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
        (call) =>
          call[0].toolName === "code.search_files" &&
          call[0].args.path === "." &&
          call[0].args.query === "Prompt Pack scoring behavior",
      ),
    ).toBe(false);
    expect(result.turnTrace.toolRuns?.find((toolRun) => toolRun.toolName === "code.search_files")).toMatchObject({
      toolName: "code.search_files",
      status: "blocked",
      error: expect.stringContaining("generic query"),
    });
  });

  it("allows targeted Prompt Lab code searches with file-specific queries to execute", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Find the most relevant existing tests for Prompt Pack scoring behavior. Return the test files and one v3 scoring gap.",
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
                  id: "call-targeted-search-1",
                  type: "function",
                  function: {
                    name: "code_search_files",
                    arguments: JSON.stringify({ path: ".", query: "prompt-pack-service.scoring.test.ts" }),
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
              content:
                "Observed: `apps/gateway/src/services/prompt-pack-service.scoring.test.ts` holds the v3 scoring pins; one gap is the missing negative weighting case.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-targeted-search",
      result: {
        matches: [{ path: "apps/gateway/src/services/prompt-pack-service.scoring.test.ts", line: 1 }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-targeted-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-targeted-search-1",
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
        (call) =>
          call[0].toolName === "code.search_files" && call[0].args.query === "prompt-pack-service.scoring.test.ts",
      ),
    ).toBe(true);
    const searchRuns = (result.turnTrace.toolRuns ?? []).filter((toolRun) => toolRun.toolName === "code.search_files");
    expect(searchRuns.some((toolRun) => toolRun.status === "blocked")).toBe(false);
    expect(searchRuns[0]).toMatchObject({ toolName: "code.search_files", status: "executed" });
  });

  it("blocks a second Prompt Lab web search after one search already ran", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "",
      "## User Task",
      "Search the web once for the official Cambridge, MA yard waste collection schedule page and summarize when collection ends, citing the source if found.",
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
                  id: "call-yard-waste-search-1",
                  type: "function",
                  function: {
                    name: "browser_search",
                    arguments: JSON.stringify({ query: "Cambridge MA yard waste collection schedule official" }),
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
              content: "",
              tool_calls: [
                {
                  id: "call-yard-waste-search-2",
                  type: "function",
                  function: {
                    name: "browser_search",
                    arguments: JSON.stringify({ query: "Cambridge Department of Public Works yard waste end date" }),
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
              content:
                "I could not verify the end date: the only allowed web search returned no usable official sources, and a retry was capped, so the Cambridge DPW page would still need to be opened to confirm.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-yard-waste-search-1",
      result: {
        // Non-empty (avoids the no-results alternate-engine retries) but without
        // result URLs, so the repeat search cannot be promoted to browser.navigate.
        results: [
          {
            title: "Cambridge DPW yard waste schedule",
            snippet: "Yard waste collection runs April through mid-December.",
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
      sessionId: "sess-prompt-lab-web-cap-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-web-cap-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const searchInvocations = invokeTool.mock.calls.filter((call) => call[0].toolName === "browser.search");
    expect(searchInvocations).toHaveLength(1);
    const searchRuns = (result.turnTrace.toolRuns ?? []).filter((toolRun) => toolRun.toolName === "browser.search");
    expect(searchRuns).toHaveLength(2);
    expect(searchRuns[0]).toMatchObject({ status: "executed" });
    expect(searchRuns[1]).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("capped at one web search"),
    });
  });

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

  it("does not prefetch prompt-listed files on the model's behalf for explicit-tools eval turns", async () => {
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
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
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
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual([]);
    expect(result.assistantContent).toContain("The streaming path has abort and cleanup risk.");
    expect(result.assistantContent).toContain("Audit cleanup and idempotency first.");
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
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("passes prose-only explicit-tools answers through verbatim when no tool path is available", async () => {
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
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    expect(result.assistantContent).toContain("The sandbox uses strict schema guards and appears safe.");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools before answering.");
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
  });

  it("executes only model-initiated tool runs and completes with the model's own synthesis on eval turns", async () => {
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

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({ path: "apps/gateway/src/services/skill-import-service.ts" }),
    });
    expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.assistantContent).toContain("one focused regression");
    expect(result.assistantContent).not.toContain("tool-run budget");
    expect(result.turnTrace.failure?.failureClass).not.toBe("tool_run_budget_exceeded");
  });

  it("does not run forced repo searches for implicit repo-grounded chat eval turns", async () => {
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
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual([]);
    expect(result.assistantContent).toContain("apps/gateway/src/services/guidance-loader.ts");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools before answering.");
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
});
