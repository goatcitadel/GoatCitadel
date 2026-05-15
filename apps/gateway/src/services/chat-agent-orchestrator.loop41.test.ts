import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop41 durable runtime patch-plan repairs", () => {
  it.each([
    {
      name: "wake lifecycle ordering",
      task: "Inspect the repo if needed and identify the exact patch points so wake lifecycle writes reflect actual outcome ordering across approval-wait storage and durable wake calls. Concretely read `apps/gateway/src/services/approval-resolution-effects-service.ts`, `packages/storage/src/approval-effect-repo.ts`, `packages/storage/src/approval-wait-run-repo.ts`, and `apps/gateway/src/services/durable-run-service.ts`.",
      expected: [
        "## Ordered steps",
        "ApprovalEffectsService.handleWakeEffect",
        "markResolved",
        "completeEffect",
        "## Partial-failure case to preserve visibly",
      ],
    },
    {
      name: "runtime lifecycle provenance",
      task: "Inspect the repo if needed and identify the exact patch points for canonical-linkage-first reads, provenance fields, and lifecycle assembly. Concretely read `packages/contracts/src/runtime-lifecycle.ts`, `apps/gateway/src/services/runtime-lifecycle-read-service.ts`, `apps/gateway/src/services/runtime-lifecycle-read-service.test.ts`, and `packages/storage/src/realtime-event-repo.ts`.",
      expected: [
        "## Reader path",
        "## Provenance field additions",
        "## Diagnostics path",
        "## Regression test to add",
        "approval_linkage",
      ],
    },
    {
      name: "two-worker durable harness",
      task: "Inspect the repo if needed and identify the exact patch points for two-worker harness coverage: claim and recovery test, claim race, recovery, and single-process limitations. Concretely read `packages/storage/src/durable-run-repo.test.ts`, `packages/storage/src/durable-run-repo.ts`, `apps/gateway/src/services/durable-run-service.ts`, and `apps/gateway/src/services/durable-run-service.test.ts`.",
      expected: [
        "## Harness entrypoint",
        "createSharedRepos",
        "## Worker orchestration helper",
        "## Scenario 1: claim race",
        "## Scenario 2: lease-expiry recovery",
      ],
    },
    {
      name: "approval effects outbox hardening",
      task: "Inspect the repo if needed and identify the exact patch points for approval-effects hardening across approval resolution, downstream effect handling, idempotent effect tracking, the outbox path, and canonical approval state. Concretely read `apps/gateway/src/services/approval-lifecycle-service.ts`, `apps/gateway/src/services/approval-resolution-effects-service.ts`, `packages/storage/src/approval-effect-repo.ts`, `apps/gateway/src/services/approval-resolution-effects-service.test.ts`, and `apps/gateway/src/routes/approvals.ts`.",
      expected: [
        "## Canonical approval writes",
        "## Downstream effect tracking writes",
        "## Idempotency or dedupe mechanism",
        "## Proving test",
        "approval_effects.idempotency_key",
      ],
    },
  ])("repairs $name prompts with concrete durable/runtime evidence", async ({ task, expected }) => {
    const result = await runPatchPlanRepair(task);

    for (const text of expected) {
      expect(result.assistantContent).toContain(text);
    }
    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).not.toContain("generic patch");
    expect(result.assistantContent).not.toContain("maybe incomplete");
  });
});

async function runPatchPlanRepair(task: string): Promise<{ assistantContent: string }> {
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
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "A generic patch should update the runtime and tests. Parts of this answer may be incomplete.",
        },
      },
    ],
  });
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
    createChatCompletion,
    invokeTool: createPatchPlanEvidenceTool(),
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

function createPatchPlanEvidenceTool(): (request: ToolInvokeRequest) => Promise<ToolInvokeResult> {
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
  "packages/contracts/src/runtime-lifecycle.ts": [
    "export type RuntimeLifecycleFieldSource = 'approval_linkage' | 'fallback_payload' | 'fallback_preview' | 'realtime_links';",
    "export interface RuntimeLifecycleResolution { fallbackSources: RuntimeLifecycleFieldSource[]; }",
  ].join("\n"),
  "apps/gateway/src/services/runtime-lifecycle-read-service.ts": [
    "export class RuntimeLifecycleReadService {",
    "  getRuntimeLifecycle(input) { const preferApprovalCanonical = Boolean(input.approvalId); return { preferApprovalCanonical }; }",
    "  private applyApprovalCanonical() { return 'approval_linkage'; }",
    "  private listApprovalEffects() { return []; }",
    "}",
  ].join("\n"),
  "apps/gateway/src/services/runtime-lifecycle-read-service.test.ts":
    "describe('RuntimeLifecycleReadService', () => { function createHost() { return { approval_linkage: true }; } });",
  "packages/storage/src/realtime-event-repo.ts":
    "export class RealtimeEventRepository { append(input) { return input.links; } list() { return []; } }",
  "packages/storage/src/durable-run-repo.test.ts":
    "describe('DurableRunRepository', () => { function createRepo(dbPath) { return new DurableRunRepository(dbPath); } });",
  "packages/storage/src/durable-run-repo.ts": [
    "export class DurableRunRepository {",
    "  tryClaimQueuedRun(input) { return { status: 'running', leaseOwnerId: input.workerId, leaseHeartbeatAt: input.now, leaseExpiresAt: input.expiresAt }; }",
    "  renewLease(input) { return input.workerId === 'worker-b' ? {} : undefined; }",
    "  listExpiredRunningRunIds(now) { return ['run-expired']; }",
    "}",
  ].join("\n"),
  "apps/gateway/src/services/durable-run-service.test.ts":
    "describe('DurableRunService', () => { it('rejects stale heartbeat and terminal writes after lease ownership moves', async () => {}); });",
  "apps/gateway/src/services/approval-lifecycle-service.ts": [
    "export class ApprovalLifecycleService {",
    "  resolveApproval(input) {",
    "    this.host.storage.approvals.resolve(input.approvalId, input);",
    "    this.host.enqueueApprovalResolutionEffects(input.approval, input);",
    "  }",
    "}",
  ].join("\n"),
  "apps/gateway/src/services/approval-resolution-effects-service.test.ts":
    "describe('ApprovalEffectsService', () => { it('enqueues the canonical approval effect set from current linkage', async () => {}); });",
  "apps/gateway/src/routes/approvals.ts":
    "export async function approvalsRoutes(app) { app.post('/approvals/:id/resolve', async () => approvals.resolveApproval()); }",
};
