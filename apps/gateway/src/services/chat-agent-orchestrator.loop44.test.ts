import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

const MODEL_ANSWER = "I can give a brief plan, but the requested role sections and evidence are incomplete.";

describe("ChatAgentOrchestrator loop44 cowork eval-turn pass-through", () => {
  it("passes a repo-grounded cowork answer through verbatim without forced repo prefetch runs", async () => {
    const result = await runRepoGroundedCoworkEvalTurn({
      sessionId: "sess-loop44-workspace-routes-guidance",
      task: "Use role-labeled Product, Ops, and Synthesis sections to inspect workspace routes, guidance docs, related services, route default active view, archived/all filtering, guidance-scope boundaries, slug conflicts, prefs durability, and first fresh regression checks to add.",
      instruction: "Keep exactly these sections in order: `Product`, `Ops`, `Synthesis`.",
      evidence: WORKSPACE_GUIDANCE_EVIDENCE,
    });

    expect(result.assistantContent).toBe(MODEL_ANSWER);
    expect(result.invokeTool).not.toHaveBeenCalled();
    expect(result.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("passes a plain cowork answer through verbatim without role-contract rewriting", async () => {
    const result = await runPlainCoworkEvalTurn({
      sessionId: "sess-loop44-rank1-hardening",
      task: "Use role-labeled QA, Product, and Ops sections to propose the Rank 1 hardening suite for paused versus waiting typed DurableWakeResult outcomes, approval wake skip ordering, and operator-visible lifecycle truth. Keep two-worker lease recovery out of this first suite.",
      instruction: "Keep exactly these sections in order: `QA`, `Product`, `Ops`.",
    });

    expect(result.assistantContent).toBe(MODEL_ANSWER);
    expect(result.invokeTool).not.toHaveBeenCalled();
    expect(result.createChatCompletion).toHaveBeenCalledTimes(1);
  });
});

interface CoworkEvalTurnResult {
  assistantContent: string;
  createChatCompletion: ReturnType<typeof vi.fn>;
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
}

async function runPlainCoworkEvalTurn(input: {
  sessionId: string;
  task: string;
  instruction: string;
}): Promise<CoworkEvalTurnResult> {
  return runCoworkEvalTurn({
    ...input,
    toolNames: [],
    invokeTool: vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(),
  });
}

async function runRepoGroundedCoworkEvalTurn(input: {
  sessionId: string;
  task: string;
  instruction: string;
  evidence: Record<string, string>;
}): Promise<CoworkEvalTurnResult> {
  return runCoworkEvalTurn({
    sessionId: input.sessionId,
    task: input.task,
    instruction: input.instruction,
    toolNames: ["code.search_files", "file.read_range"],
    invokeTool: createEvidenceTool(input.evidence),
  });
}

async function runCoworkEvalTurn(input: {
  sessionId: string;
  task: string;
  instruction: string;
  toolNames: string[];
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
}): Promise<CoworkEvalTurnResult> {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: cowork",
    input.toolNames.length > 0 ? "- Tool tier: implicit-tools" : "- Tool tier: no-tools",
    "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
    input.toolNames.length > 0
      ? "- This is a repo-grounded evaluation. Inspect the repository before answering whenever current repo state matters."
      : undefined,
    input.toolNames.length > 0 ? "- Repo inspection assist: enabled." : undefined,
    input.toolNames.length > 0 ? "- Required tool families: file/code tools" : undefined,
    "",
    "## User Task",
    input.task,
    "",
    input.instruction,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: MODEL_ANSWER,
        },
      },
    ],
  });
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(input.toolNames),
    createChatCompletion,
    invokeTool: input.invokeTool,
  });

  const result = await orchestrator.run({
    sessionId: input.sessionId,
    turnId: randomUUID(),
    userMessageId: `${input.sessionId}-message`,
    content: wrappedPrompt,
    mode: "cowork",
    providerId: "openai-codex",
    model: "gpt-5.5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: input.toolNames.length > 0 ? "safe_auto" : "manual",
    normalizationProfile: "prompt_pack_harness",
    historyMessages: [{ role: "user", content: wrappedPrompt }],
  });

  return {
    assistantContent: result.assistantContent,
    createChatCompletion,
    invokeTool: input.invokeTool,
  };
}

function createEvidenceTool(
  evidence: Record<string, string>,
): (request: ToolInvokeRequest) => Promise<ToolInvokeResult> {
  return vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
    if (request.toolName === "code.search_files") {
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-loop44-search-${String(request.args.query ?? "query").replace(/[^a-z0-9]+/gi, "-")}`,
        result: {
          matches: Object.keys(evidence).map((path) => ({
            path,
            name: path.split("/").at(-1),
            type: "file",
          })),
        },
      };
    }
    const path = String(request.args.path ?? "");
    return {
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: `audit-loop44-read-${path.replace(/[^a-z0-9]+/gi, "-")}`,
      result: {
        path,
        startLine: 1,
        endLine: 160,
        content: evidence[path] ?? `// ${path}\nexport const placeholder = true;`,
      },
    };
  });
}

const WORKSPACE_GUIDANCE_EVIDENCE: Record<string, string> = {
  "apps/gateway/src/routes/workspaces.ts": [
    "app.get('/api/v1/workspaces', async (request) => listWorkspaces({ view: request.query.view ?? 'active' }));",
    "const workspaceGuidanceTypes = ['goatcitadel', 'agents', 'claude', 'vision'];",
    "const globalGuidanceTypes = ['goatcitadel', 'agents', 'claude', 'vision', 'contributing', 'security'];",
    "app.get('/api/v1/workspaces/:id/guidance/:docType', async () => readWorkspaceGuidance());",
  ].join("\n"),
  "apps/gateway/src/routes/workspaces.test.ts": [
    "it('defaults workspace list to active view', async () => {});",
    "it('rejects workspace guidance doc types that only global guidance accepts', async () => {});",
  ].join("\n"),
  "packages/storage/src/workspace-repo.ts": [
    "export class WorkspaceRepository {",
    "  list(input) { return input.view === 'archived' ? this.archivedRows() : this.activeRows(); }",
    "  archive(workspaceId) { return this.updateLifecycle(workspaceId, 'archived'); }",
    "  restore(workspaceId) { return this.updateLifecycle(workspaceId, 'active'); }",
    "  updateSlug(slug) { if (this.slugExists(slug)) throw new ConflictError('duplicate slug'); }",
    "  updatePrefs(prefs) { return JSON.stringify(prefs ?? {}); }",
    "}",
  ].join("\n"),
  "packages/storage/src/workspace-repo.test.ts": [
    "it('lists archived rows only for archived/all views', async () => {});",
    "it('rejects duplicate slug create and update', async () => {});",
    "it('round-trips empty prefs without malformed JSON', async () => {});",
  ].join("\n"),
};
