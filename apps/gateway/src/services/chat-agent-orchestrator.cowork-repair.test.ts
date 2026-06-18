import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator Cowork repair behavior", () => {
  it("never runs repo inspection tools on the model's behalf for explicit-tools prompt-lab chat turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded but durable state, approval state, or lifecycle views still load. Cite the exact files used.",
    ].join("\n");
    const modelAnswer =
      "Trust durable state first, then treat live status as projected until the approval and lifecycle surfaces agree.";
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

    // Even though the run contract demands tool use, the controller never executes
    // searches or reads on the model's behalf: skipping the tools is the model's
    // own score-facing failure.
    expect(invokeTool).not.toHaveBeenCalled();
    // The model declined to call tools, so its answer passes through verbatim with
    // no appended evidence or citation appendix.
    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("Exact files used:");
  });

  it("does not prefetch repo evidence for repo-grounded chat inspections; the model's answer passes through verbatim", async () => {
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
    const modelAnswer = [
      "authoritative state: trust the durable lifecycle state persisted by the run service.",
      "projected state: the operator-facing status summary is a derived surface.",
      "still-unclear state: the current reads do not settle how stale live updates are reconciled after delivery gaps.",
    ].join(" ");
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

    // Eval-integrity turn: the controller never runs searches or reads on the
    // model's behalf, and the model's own text is returned without an appended
    // "## Exact files used" evidence appendix.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("## Exact files used");
  });

  it("still normalizes live cowork role-contract output when no eval profile is set", async () => {
    // Production behavior: a LIVE cowork turn (no normalizationProfile) whose
    // prompt requests an exact role order still gets deterministic contract
    // normalization when the model's draft misses the requested sections.
    const livePrompt = [
      "Plan a small community workshop.",
      "Output exactly these sections in this order:",
      "- Planner",
      "- Risk Review",
      "Rules: keep the role order only.",
    ].join("\n");
    const degradedAnswer = "Here are some loose thoughts about the workshop without any structure.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: degradedAnswer } }],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-live-cowork-normalization-1",
      turnId: randomUUID(),
      userMessageId: "msg-live-cowork-normalization-1",
      content: livePrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: livePrompt }],
    });

    expect(result.assistantContent).not.toBe(degradedAnswer);
    expect(result.assistantContent).toContain("Planner");
    expect(result.assistantContent).toContain("Risk Review");
  });

  it("does not run forced repo prefetch for prompt-lab implicit cowork inspections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and produce role-labeled sections describing the current override chain and the most valuable next simplification for operators.",
    ].join("\n");
    const modelAnswer = [
      "## Researcher",
      "- `packages/storage/src/workspace-hook-repo.ts` and `packages/storage/src/workspace-repo.ts` show the current override chain starts in storage-backed workspace resolution.",
      "",
      "## Architect",
      "- `AGENTS.md` is the clearest operator-facing contract today, so the next simplification is to make that precedence chain load from one canonical source instead of scattered lookup rules.",
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
      listToolCatalog: () =>
        createToolCatalog(["memory.search", "memory.read", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    // Eval-integrity is keyed strictly on the server-set normalization profile
    // (content sniffing must never flip production semantics).
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
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toBe(modelAnswer);
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
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "file.read_range") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-implicit-file-read-1",
          result: {
            path: "F:/code/project/src/index.ts",
            content: "export function main() {}\nexport function helper() {}",
          },
        };
      }
      return {
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-implicit-shell-1",
        approvalId: "approval-shell-1",
      };
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
      normalizationProfile: "prompt_pack_harness",
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
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("approval-gated");
    expect(result.assistantContent).not.toContain("Approval required by policy.");
    expect(
      result.turnTrace.toolRuns.some((run) => run.status === "approval_required" && run.toolName.includes("browser")),
    ).toBe(true);
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

  it("passes cowork prompt-lab output through verbatim even when it exceeds an explicit word limit", async () => {
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
    const modelAnswer = [
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
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    // The model blew the 80-word budget; on eval-integrity turns the harness must
    // NOT compact or rewrite the answer to satisfy the contract — the over-limit
    // output is the model's own score-facing failure.
    expect(modelAnswer.split(/\s+/).filter(Boolean).length).toBeGreaterThan(80);
    expect(result.assistantContent).toBe(modelAnswer);
  });

  it("does not force web search for implicit everyday cowork research prompts on eval turns", async () => {
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
    const modelAnswer = "## Researcher\n- I checked the market context.\n\n## Operator Handoff\n- Arrive near opening.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
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
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
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

    // The model never requested browser.search, so the controller must not run a
    // web search on its behalf; the model's answer is returned verbatim with no
    // appended source or citation block.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("Source URLs:");
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
      normalizationProfile: "prompt_pack_harness",
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
