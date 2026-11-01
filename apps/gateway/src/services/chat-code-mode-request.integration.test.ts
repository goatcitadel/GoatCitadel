import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatToolRunRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { loadGatewayConfig } from "../config.js";
import type { ApprovedCodeModeRequest, CapabilitySystemService } from "./capability-system-service.js";
import {
  buildChatTurnRuntimeAuthoritySeal,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import { CODE_MODE_OFF_TOOL_ERROR } from "./code-mode-request-tool.js";
import {
  GENERAL_CHAT_POST_COMMIT_EFFECTS,
  markGeneralChatPostCommitPending,
  type GeneralChatPostCommitProgress,
} from "./chat-durable-run-service.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";
import { GatewayService } from "./gateway-service.js";

/**
 * A chat turn's `code_mode.request` through the real Gateway tool path: the policy engine creates the approval, the
 * operator resolves it, the approval effects run the pending action through the Gateway hook, and the waiting turn's
 * tool run and wake follow the existing `tool.invoke` path.
 */
const ENV_KEYS = [
  "NODE_ENV",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let gateway: GatewayService | undefined;

const FIXTURE_RUN_PREFIX = "durable-code-mode-";
const SOURCE = "return { pages: 3, path: input.path };";
const ARGS = { goal: "count the pages of saturday-plan.pdf", source: SOURCE, input: { path: "saturday-plan.pdf" } };

describe("code_mode.request through the real Gateway approval path", { timeout: 180_000 }, () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await gateway?.close().catch(() => undefined);
    gateway = undefined;
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  async function startGateway(): Promise<GatewayService> {
    const root = createIsolatedConfigRoot();
    process.env.NODE_ENV = "test";
    process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
    process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
    process.env.GOATCITADEL_ROOT_DIR = root;
    gateway = new GatewayService(await loadGatewayConfig(root));
    await gateway.initCritical();
    settleFixtureWaits(gateway);
    return gateway;
  }

  /**
   * The runtime settles a parked turn's post-commit work (memory, commitments) moments after it parks. These fixture
   * turns have no real transcript for that work, so their waits are reported settled; the wake then re-enters the run.
   */
  function settleFixtureWaits(live: GatewayService): void {
    const deps = (
      live as unknown as {
        durableRunService: {
          deps: {
            onGeneralChatPostCommit(run: DurableRunRecord, progress: GeneralChatPostCommitProgress): unknown;
          };
        };
      }
    ).durableRunService.deps;
    const original = deps.onGeneralChatPostCommit;
    deps.onGeneralChatPostCommit = async (run, progress) => {
      if (!run.runId.startsWith(FIXTURE_RUN_PREFIX)) return await original(run, progress);
      for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
        if (!progress.completedEffects.includes(effect)) await progress.runEffect(effect, () => undefined);
      }
      return {};
    };
  }

  /** A chat turn parked on its `code_mode.request` approval, as the runner leaves it. */
  async function requestInWaitingTurn(live: GatewayService, label: string) {
    const sessionId = `session-code-mode-${label}`;
    const turnId = `turn-code-mode-${label}`;
    const toolRunId = `tool-run-code-mode-${label}`;
    const runId = `${FIXTURE_RUN_PREFIX}${label}`;
    const now = new Date().toISOString();
    const userMessageId = `${turnId}-user`;
    const assistantMessageId = `${turnId}-assistant`;
    await live.storage.chatSessionMeta.ensure(sessionId, now, "default");
    const requested = await live.invokeTool({
      toolName: "code_mode.request",
      args: ARGS,
      agentId: "assistant",
      sessionId,
      turnId,
      toolRunId,
      workspaceId: "default",
      surface: "chat",
      policyContext: { authActorSource: "loopback", operatorId: "operator", surface: "chat" },
    });
    expect(requested.outcome).toBe("approval_required");
    const approvalId = requested.approvalId!;
    // The turn parks on this approval, so its durable wait correlates with the approval id (as the runtime writes it).
    await createWaitingChatTurnRun(live, {
      runId,
      sessionId,
      turnId,
      userMessageId,
      assistantMessageId,
      now,
      approvalId,
    });
    await live.storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId,
      assistantMessageId,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting" },
      startedAt: now,
    });
    await live.storage.chatToolRuns.create({
      toolRunId,
      sessionId,
      turnId,
      toolName: "code_mode.request",
      args: ARGS,
      status: "approval_required",
      approvalId,
    });
    await live.storage.chatInlineApprovals.upsert({
      approvalId,
      sessionId,
      turnId,
      kind: "code_mode.request",
      toolName: "code_mode.request",
      status: "pending",
    });
    return { sessionId, turnId, toolRunId, runId, approvalId };
  }

  function capabilitySystem(live: GatewayService): CapabilitySystemService {
    return (live as unknown as { capabilitySystemService: CapabilitySystemService }).capabilitySystemService;
  }

  async function settledToolRun(live: GatewayService, turnId: string, toolRunId: string): Promise<ChatToolRunRecord> {
    return await pollFor(
      async () => (await live.storage.chatToolRuns.listByTurn(turnId)).find((run) => run.toolRunId === toolRunId),
      (run) => Boolean(run && run.status !== "approval_required"),
      `tool run ${toolRunId} to settle`,
      20_000,
    )
      .then((run) => run!)
      .catch(async (error: unknown) => {
        const effects = (
          await live.storage.approvalEffects.listByApproval(
            (await live.storage.chatToolRuns.listByTurn(turnId))[0]!.approvalId!,
          )
        ).map((e) => ({
          kind: e.effectKind,
          status: e.status,
          lastError: e.lastError,
          result: JSON.stringify(e.result).slice(0, 800),
        }));
        throw new Error(`${(error as Error).message}\nDEBUG effects: ${JSON.stringify(effects, null, 1)}`);
      });
  }

  async function wakeEffect(live: GatewayService, approvalId: string, turnId: string) {
    return await pollFor(
      async () =>
        (await live.storage.approvalEffects.listByApproval(approvalId)).find(
          (effect) => effect.effectKind === "linked_chat_turn_wake" && effect.targetId === turnId,
        ),
      (effect) => Boolean(effect),
      "the linked chat turn wake",
    );
  }

  /** The wake really re-entered the parked durable run: the effect settled as `woke`, not skipped on a terminal run. */
  async function expectTurnResumed(live: GatewayService, approvalId: string, turnId: string, runId: string) {
    const settled = await pollFor(
      async () => await wakeEffect(live, approvalId, turnId),
      (effect) => Boolean(effect && effect.status !== "pending" && effect.status !== "running"),
      "the linked chat turn wake to settle",
    );
    expect(settled, JSON.stringify(settled?.result).slice(0, 2_000)).toMatchObject({
      status: "completed",
      result: { runId, outcome: "woke", operatorStatus: "woke" },
    });
  }

  /** An approved request also executed its pending action before the turn resumed. */
  async function expectApprovedTurnResumed(live: GatewayService, approvalId: string, turnId: string, runId: string) {
    await expectTurnResumed(live, approvalId, turnId, runId);
    const effects = await live.storage.approvalEffects.listByApproval(approvalId);
    expect(effects.find((effect) => effect.effectKind === "pending_action_execute")).toMatchObject({
      status: "completed",
    });
    expect((await live.storage.pendingApprovalActions.find(approvalId))?.resolutionStatus).toBe("executed");
  }

  it("executes approved request", async () => {
    const live = await startGateway();
    const runSpy = vi
      .spyOn(capabilitySystem(live), "runApprovedCodeModeRequest")
      .mockImplementation(async (request: ApprovedCodeModeRequest) => ({
        runId: `code-run-request-${request.approvalId}`,
        status: "completed",
        result: { pages: 3 },
        durationMs: 5,
      }));
    const turn = await requestInWaitingTurn(live, "approved");
    const approval = await live.storage.approvals.get(turn.approvalId);
    expect(approval).toMatchObject({ kind: "code_mode.request", status: "pending" });
    expect(runSpy).not.toHaveBeenCalled();

    await live.resolveApproval(turn.approvalId, { decision: "approve", resolvedBy: "operator" });

    const toolRun = await settledToolRun(live, turn.turnId, turn.toolRunId);
    expect(toolRun.status).toBe("executed");
    expect(toolRun.result).toMatchObject({ status: "completed", result: { pages: 3 } });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toMatchObject({
      approvalId: turn.approvalId,
      approvedSourceSha256: createHash("sha256").update(SOURCE).digest("hex"),
      goal: ARGS.goal,
      language: "javascript",
      source: SOURCE,
      input: ARGS.input,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    });
    const resolved = await live.storage.approvals.get(turn.approvalId);
    expect(resolved).toMatchObject({ kind: "code_mode.request", status: "approved", resolvedBy: "operator" });
    expect(await wakeEffect(live, turn.approvalId, turn.turnId)).toMatchObject({ targetKind: "chat_turn" });
    await expectApprovedTurnResumed(live, turn.approvalId, turn.turnId, turn.runId);
  });

  it("Code Mode off when approved from Inbox", async () => {
    const live = await startGateway();
    const service = capabilitySystem(live);
    // The shipped default: Code Mode is off, so the real service refuses before anything runs. A host without the
    // Code Mode sandbox (the Linux CI runner) reports sandbox_unsupported first, so pin the sandbox as supported.
    const shipped = await service.getCodeModeReadiness();
    expect(shipped).toMatchObject({ enabled: false, canRun: false });
    vi.spyOn(service, "getCodeModeReadiness").mockResolvedValue({
      ...shipped,
      sandboxSupported: true,
      reason: "code_mode_off",
    });
    const turn = await requestInWaitingTurn(live, "off");

    await live.resolveApproval(turn.approvalId, { decision: "approve", resolvedBy: "operator" });

    // Executed-with-error: the turn resumes with the error in the tool result, so the model can explain it.
    const toolRun = await settledToolRun(live, turn.turnId, turn.toolRunId);
    expect(toolRun.status).toBe("executed");
    expect(toolRun.result).toMatchObject({ status: "failed", error: CODE_MODE_OFF_TOOL_ERROR });
    await expectApprovedTurnResumed(live, turn.approvalId, turn.turnId, turn.runId);
  });

  it("a guest error resumes the turn", async () => {
    const live = await startGateway();
    vi.spyOn(capabilitySystem(live), "runApprovedCodeModeRequest").mockImplementation(
      async (request: ApprovedCodeModeRequest) => ({
        runId: `code-run-request-${request.approvalId}`,
        status: "failed",
        error: "TypeError: input.path is undefined",
        durationMs: 4,
      }),
    );
    const turn = await requestInWaitingTurn(live, "guest-error");

    await live.resolveApproval(turn.approvalId, { decision: "approve", resolvedBy: "operator" });

    const toolRun = await settledToolRun(live, turn.turnId, turn.toolRunId);
    expect(toolRun.status).toBe("executed");
    expect(toolRun.result).toMatchObject({ status: "failed", error: "TypeError: input.path is undefined" });
    await expectApprovedTurnResumed(live, turn.approvalId, turn.turnId, turn.runId);
  });

  it("deny resumes the turn", async () => {
    const live = await startGateway();
    const runSpy = vi.spyOn(capabilitySystem(live), "runApprovedCodeModeRequest");
    const turn = await requestInWaitingTurn(live, "denied");

    await live.resolveApproval(turn.approvalId, { decision: "reject", resolvedBy: "operator" });

    const toolRun = await settledToolRun(live, turn.turnId, turn.toolRunId);
    expect(toolRun.status).toBe("blocked");
    expect(toolRun.result).toMatchObject({ approvalOutcome: "denied" });
    expect(toolRun.failureGuidance).toContain("did not execute");
    expect(runSpy).not.toHaveBeenCalled();
    await expectTurnResumed(live, turn.approvalId, turn.turnId, turn.runId);
  });

  it("expiry resumes the turn", async () => {
    const live = await startGateway();
    const runSpy = vi.spyOn(capabilitySystem(live), "runApprovedCodeModeRequest");
    const turn = await requestInWaitingTurn(live, "expired");
    expireApprovalNow(live, turn.approvalId);

    expect(await live.approvalRuntime.expirePendingApprovals(10)).toBeGreaterThanOrEqual(1);

    const toolRun = await settledToolRun(live, turn.turnId, turn.toolRunId);
    expect(toolRun.status).toBe("blocked");
    expect(toolRun.result).toMatchObject({ approvalOutcome: "expired" });
    expect(runSpy).not.toHaveBeenCalled();
    // Expiry only queues the wake; the effects worker's poll loop (not started for this fixture) drains it.
    await live.approvalEffectsService.awaitResolutionEffects(turn.approvalId);
    await expectTurnResumed(live, turn.approvalId, turn.turnId, turn.runId);
  });

  it("docs.* reads an attachment only in the session it was uploaded to", async () => {
    const live = await startGateway();
    const now = new Date().toISOString();
    for (const sessionId of ["session-attachment-owner", "session-attachment-other"]) {
      await live.storage.sessions.upsert({
        sessionId,
        sessionKey: `mission:operator:${sessionId}`,
        kind: "dm",
        channel: "mission",
        account: "operator",
        timestamp: now,
      });
      await live.storage.chatSessionMeta.ensure(sessionId, now, "default");
    }
    const uploaded = await live.routeServices.chatAttachments.uploadChatAttachment({
      sessionId: "session-attachment-owner",
      fileName: "saturday-plan.txt",
      mimeType: "text/plain",
      bytesBase64: Buffer.from("Farmers market at nine").toString("base64"),
    });
    // Outside a Code Mode run the call asks first; the approved call runs the gateway's attachment hook.
    const extract = async (sessionId: string) => {
      const requested = await live.invokeTool({
        toolName: "docs.extract_text",
        args: { attachmentId: uploaded.attachmentId },
        agentId: "assistant",
        sessionId,
        workspaceId: "default",
        surface: "chat",
        policyContext: { authActorSource: "loopback", operatorId: "operator", surface: "chat" },
      });
      expect(requested.outcome).toBe("approval_required");
      const resolved = await live.resolveApproval(requested.approvalId!, {
        decision: "approve",
        resolvedBy: "operator",
      });
      return resolved.effects.find((effect) => effect.effectKind === "pending_action_execute")?.result;
    };

    expect(await extract("session-attachment-owner")).toMatchObject({
      outcome: "executed",
      result: { name: "saturday-plan.txt", text: "Farmers market at nine" },
    });
    const other = await extract("session-attachment-other");
    expect(other).toMatchObject({
      outcome: "blocked",
      policyReason: "execution error: Attachment is not part of this session.",
    });
    expect(JSON.stringify(other)).not.toContain("Farmers market");
  });
});

const POST_COMMIT_ELIGIBILITY = {
  version: 1 as const,
  autonomyEnabledAtParentSettlement: true,
  evalIntegrityTurn: false,
  humanSession: true,
};

/** The canonical durable Chat run a turn parks on while it waits for an approval (same shape the runtime writes). */
async function createWaitingChatTurnRun(
  live: GatewayService,
  input: {
    runId: string;
    sessionId: string;
    turnId: string;
    userMessageId: string;
    assistantMessageId: string;
    now: string;
    approvalId: string;
  },
): Promise<void> {
  const storage = live.storage;
  const request = { content: `Count the pages of saturday-plan.pdf (${input.turnId})` };
  const requestActor = { actorKind: "operator" as const, actorId: "operator" };
  const lifecycle = await storage.chatSessionLifecycles.ensureActive({
    workspaceId: "default",
    sessionId: input.sessionId,
    actorId: requestActor.actorId,
    idempotencyKey: `lifecycle:${input.sessionId}`,
    correlationId: `lifecycle:${input.sessionId}`,
    metadataTimestamp: input.now,
  });
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const { admission } = await storage.sessionMutationAdmissions.admit({
    workspaceId: "default",
    sessionId: input.sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    turnId: input.turnId,
    runtimeOwnerId: `code-mode-request-test:${input.runId}`,
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: lifecycle.generation,
    actorKind: requestActor.actorKind,
    actorId: requestActor.actorId,
    operation: "chat_send",
    materialSha256: admissionMaterialSha256,
    idempotencyKey: `admission:${input.runId}`,
    correlationId: `admission:${input.runId}`,
  });
  const generationId = `waiting-generation:${input.runId}`;
  const waitForEvent = { eventKey: "approval.resolved", correlationId: input.approvalId };
  const authority = buildChatTurnRuntimeAuthoritySeal({
    runId: input.runId,
    turnId: input.turnId,
    transitionKind: "waiting",
    durableStatus: "waiting",
    traceStatus: "waiting_for_approval",
    transitionAt: input.now,
    postCommitGenerationId: generationId,
    postCommitEligibility: POST_COMMIT_ELIGIBILITY,
    waitForEvent,
    requiredFinalizers: ["general"],
  });
  const pendingMetadata = markGeneralChatPostCommitPending(
    { retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT }, waitForEvent },
    input.now,
    "waiting_for_approval",
    POST_COMMIT_ELIGIBILITY,
    generationId,
  );
  await storage.durableRuns.createRun({
    runId: input.runId,
    workflowKey: "chat.turn.execute",
    status: "waiting",
    maxAttempts: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      admissionMaterialSha256,
      workspaceId: admission.workspaceId,
      admissionAggregateRevision: admission.aggregateRevision,
      admissionControllerGeneration: admission.controllerGeneration,
      effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
      requestActor,
      sessionId: input.sessionId,
      turnId: input.turnId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request,
    },
    metadata: withChatTurnRuntimeAuthority(pendingMetadata, authority),
    now: input.now,
  });
  await storage.durableRuns.createCheckpoint({
    runId: input.runId,
    checkpointKind: "run_waiting",
    state: withChatTurnRuntimeAuthorityCheckpoint({ waitForEvent }, authority),
    createdAt: input.now,
  });
}

/** Backdates one approval in this fixture's own temporary SQLite database, so the expiry sweep picks it up. */
function expireApprovalNow(live: GatewayService, approvalId: string): void {
  const sql = (
    live.storage as unknown as { gatewaySql?: { prepare(sql: string): { run(...args: unknown[]): unknown } } }
  ).gatewaySql;
  if (!sql) throw new Error("This fixture needs the SQLite storage driver.");
  sql.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE approval_id = ?").run(approvalId);
}

/** A temp root with only the tracked config fixtures, never the operator's live config. */
function createIsolatedConfigRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-code-mode-request-"));
  tempRoots.push(root);
  const repoConfig = path.join(findRepoRoot(), "config");
  const target = path.join(root, "config");
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(repoConfig)) {
    if (name.endsWith(".example.json") || name === "llm-model-metadata.json") {
      fs.copyFileSync(path.join(repoConfig, name), path.join(target, name));
    }
  }
  fs.copyFileSync(path.join(target, "goatcitadel.example.json"), path.join(target, "goatcitadel.json"));
  fs.copyFileSync(path.join(target, "tool-policy.example.json"), path.join(target, "tool-policy.json"));
  return root;
}

async function pollFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last).slice(0, 4_000)}`);
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}
