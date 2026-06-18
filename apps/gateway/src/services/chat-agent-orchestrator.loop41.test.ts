import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

const WAKE_LIFECYCLE_TASK =
  "Inspect the repo if needed and identify the exact patch points so wake lifecycle writes reflect actual outcome ordering across approval-wait storage and durable wake calls. Concretely read `apps/gateway/src/services/approval-resolution-effects-service.ts`, `packages/storage/src/approval-effect-repo.ts`, `packages/storage/src/approval-wait-run-repo.ts`, and `apps/gateway/src/services/durable-run-service.ts`.";

describe("ChatAgentOrchestrator loop41 durable runtime patch-plan eval integrity", () => {
  it("passes the model's patch-plan answer through verbatim without controller prefetch or fabricated evidence", async () => {
    const modelAnswer = "A generic patch should update the runtime and tests. Parts of this answer may be incomplete.";
    const invokeTool = createPatchPlanEvidenceTool();
    const result = await runPatchPlanTurn(WAKE_LIFECYCLE_TASK, modelAnswer, invokeTool);

    // Eval-integrity invariant: the persisted assistant text is the model's own
    // output, even when it reads degraded — no deterministic patch-plan scaffold,
    // no appended file-evidence sections.
    expect(result.assistantContent).toBe(modelAnswer);
    expect(result.assistantContent).not.toContain("## Exact files used");
    expect(result.assistantContent).not.toContain("## Ordered steps");

    // Eval-integrity invariant: the controller never executes file reads or repo
    // searches on the model's behalf, even though the run contract enables
    // repo-inspection assist and the prompt names concrete files.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toHaveLength(0);
    expect(result.turnTrace.status).toBe("completed");
  });
});

async function runPatchPlanTurn(
  task: string,
  modelAnswer: string,
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>,
) {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: code",
    "- Tool tier: implicit-tools",
    "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
    "- Repo inspection assist: enabled.",
    "- Required tool families: file/code tools",
    "",
    "## User Task",
    task,
    "",
    "Answer contract:",
    "- Cite the exact files whose contents you concretely read.",
    "- Keep the patch plan grouped by exact patch area.",
    "- Include a validation or regression-test step.",
  ].join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
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
    listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
    createChatCompletion,
    invokeTool,
  });

  return orchestrator.run({
    sessionId: `sess-loop41-${randomUUID()}`,
    turnId: randomUUID(),
    userMessageId: `msg-loop41-${randomUUID()}`,
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
}

function createPatchPlanEvidenceTool(): ReturnType<
  typeof vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>
> {
  return vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
    if (request.toolName === "code.search_files") {
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-loop41-search-${String(request.args.query ?? "query").replace(/[^a-z0-9]+/gi, "-")}`,
        result: {
          matches: Object.keys(EVIDENCE_BY_PATH).map((path) => ({
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
      auditEventId: `audit-loop41-read-${path.replace(/[^a-z0-9]+/gi, "-")}`,
      result: {
        path,
        startLine: 1,
        endLine: 160,
        content: EVIDENCE_BY_PATH[path] ?? `// ${path}\nexport const placeholder = true;`,
      },
    };
  });
}

const EVIDENCE_BY_PATH: Record<string, string> = {
  "apps/gateway/src/services/approval-resolution-effects-service.ts": [
    "export class ApprovalEffectsService {",
    "  enqueueResolutionEffects(approval, input) { return this.storage.approvalEffects.upsert({ idempotencyKey: 'approval:effect' }); }",
    "  private async handleWakeEffect(effect, fromWorker) {",
    "    const result = await this.durableRunService.wakeDurableRun(effect.targetId, { eventKey: 'approval.resolved' });",
    "    if (result.woke) this.storage.approvalWaitRuns.markResolved(effect.approvalId, effect.targetId);",
    "    return this.storage.approvalEffects.completeEffect(effect.effectId, { result });",
    "  }",
    "}",
  ].join("\n"),
  "packages/storage/src/approval-effect-repo.ts": [
    "CREATE TABLE approval_effects (effect_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE);",
    "export class ApprovalEffectRepository {",
    "  upsert(input) { return this.insertStmt.run(input.idempotencyKey); }",
    "  completeEffect(effectId, result) { return this.transition(effectId, 'completed', result); }",
    "  skipEffect(effectId, reason) { return this.transition(effectId, 'skipped', reason); }",
    "  failEffect(effectId, error) { return this.transition(effectId, 'failed', error); }",
    "}",
  ].join("\n"),
  "packages/storage/src/approval-wait-run-repo.ts":
    "export class ApprovalWaitRunRepository { markResolved(approvalId, runId) { return { approvalId, runId }; } }",
  "apps/gateway/src/services/durable-run-service.ts": [
    "export class DurableRunService {",
    "  wakeDurableRun(runId, input) { return { woke: true, runId, input }; }",
    "  reconcileRecoverableRuns() { return this.storage.durableRuns.listExpiredRunningRunIds(new Date().toISOString()); }",
    "}",
  ].join("\n"),
};
