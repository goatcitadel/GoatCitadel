import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type A2AOutboundSendResponse,
  type A2ATaskPushDeliveryResult,
  type ApprovalEffectRecord,
  type ApprovalRequest,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import {
  buildCitadelWardApprovalPayload,
  CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
  CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
  CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
} from "./citadel-ward-approval.js";
import {
  buildCitadelWardApprovalEffectDeps,
  buildCitadelWardApprovalEffectUpsert,
  CITADEL_WARD_A2A_OUTBOUND_EFFECT_KIND,
  CITADEL_WARD_A2A_PUSH_EFFECT_KIND,
  CITADEL_WARD_INTEGRATION_ACTION_EFFECT_KIND,
  CitadelWardApprovalEffectError,
  isCitadelWardEffectKind,
  runCitadelWardApprovalEffect,
  type CitadelWardApprovalEffectExecutors,
} from "./citadel-ward-approval-effect-service.js";
import type { IntegrationActionHost } from "./integration-action-service.js";

const ACTIVEPIECES_WARD_ACTION = "integration.automation.activepieces.trigger_webhook";
const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";

function activepiecesConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: CONNECTION_ID,
    catalogId: "automation.activepieces",
    kind: "automation",
    key: "activepieces",
    label: "Activepieces",
    enabled: true,
    status: "connected",
    workspaceId: "ws-guarded",
    config: { webhookUrl: "https://flows.example.test/hook" },
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function wardApproval(
  kind: string,
  request: Record<string, unknown>,
  overrides: Partial<ApprovalRequest> & { wardAction?: string; citadelId?: string } = {},
): ApprovalRequest {
  const { wardAction = ACTIVEPIECES_WARD_ACTION, citadelId = "citadel-guarded", ...rest } = overrides;
  const payload = buildCitadelWardApprovalPayload({ wardAction, citadelId, request });
  return {
    approvalId: "approval-ward-1",
    kind,
    riskLevel: "caution",
    status: "approved",
    payload: { ...payload },
    preview: {},
    createdAt: "2026-07-07T00:00:00.000Z",
    explanationStatus: "not_requested",
    ...rest,
  };
}

function integrationApproval(overrides: Partial<ApprovalRequest> & { citadelId?: string } = {}): ApprovalRequest {
  return wardApproval(
    CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
    { connectionId: CONNECTION_ID, actionId: "trigger_webhook", invokeRequest: { input: {} } },
    overrides,
  );
}

function approvalStore(...approvals: ApprovalRequest[]) {
  return approvalAndPushStore(approvals, {});
}

function approvalAndPushStore(
  approvals: ApprovalRequest[],
  pushConfigs: Record<string, { lastEventSequence: number }>,
) {
  const byId = new Map(approvals.map((approval) => [approval.approvalId, approval]));
  return {
    a2aTaskPushConfigs: {
      find: vi.fn(async (taskId: string, peerId: string) => pushConfigs[`${taskId}:${peerId}`] as never),
    },
    approvals: {
      get: vi.fn(async (approvalId: string) => {
        const approval = byId.get(approvalId);
        if (!approval) throw new NotFoundError({ entity: "approval", id: approvalId });
        return approval;
      }),
    },
  };
}

function fakeA2A() {
  return {
    sendOutbound: vi.fn(
      async (): Promise<A2AOutboundSendResponse> => ({
        checkedAt: "2026-07-07T00:00:00.000Z",
        peerId: "peer-1",
        method: "SendMessage",
        transport: "JSONRPC",
        status: "sent",
        idempotencyKey: "citadel-ward:approval-ward-1",
        auditRef: "extfx-1",
        warnings: [],
      }),
    ),
    deliverApprovedPush: vi.fn(
      async (): Promise<A2ATaskPushDeliveryResult[]> => [
        {
          taskId: "task-1",
          peerId: "peer-1",
          url: "https://peer.example.test/push",
          eventSequence: 3,
          eventKind: "status",
          status: "delivered",
          attemptCount: 1,
          checkedAt: "2026-07-07T00:00:00.000Z",
        } as A2ATaskPushDeliveryResult,
      ],
    ),
    recordRefusedPushApproval: vi.fn(async () => undefined),
  };
}

function webhookFetch() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ id: "run-1", message: "flow accepted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** An integration host over a real in-memory runner store, so replay dedupe is the real ledger. */
function createRealIntegrationHost(
  connection: IntegrationConnection,
  wards: Array<{ actionPattern: string; effect: string }>,
  citadelByWorkspace: Record<string, string> = { "ws-guarded": "citadel-guarded" },
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ward-effect-"));
  const raw = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const asyncStorage = createSqliteAsyncStorage(raw);
  const fetchMock = webhookFetch();
  const host: IntegrationActionHost = {
    storage: {
      integrationConnections: { get: vi.fn(async () => connection) },
      runImmediateTransaction: asyncStorage.runImmediateTransaction.bind(asyncStorage),
      workspaces: {
        find: (id: string) => (citadelByWorkspace[id] ? { citadelId: citadelByWorkspace[id] } : undefined),
      },
      citadels: { listWards: (citadelId: string) => (citadelId === "citadel-guarded" ? (wards as never) : []) },
    },
    fetchWithDiagnosticsTimeout: fetchMock,
    readConnectionConfigValue: (config, key) => (typeof config[key] === "string" ? (config[key] as string) : undefined),
    resolveConnectionSecret: () => undefined,
    publishRealtime: vi.fn(async () => undefined),
    mutationStore: asyncStorage.mutationIdempotency,
    sideEffectRunStore: asyncStorage.externalSideEffectRuns,
    createApproval: vi.fn(async () => {
      throw new Error("an approved replay must not open another approval");
    }),
  };
  const cleanup = async () => {
    await asyncStorage.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { host, fetchMock, cleanup };
}

function claimedEffect(approval: ApprovalRequest, decision: "approve" | "reject", expired = false) {
  const upsert = buildCitadelWardApprovalEffectUpsert(approval, decision, expired)!;
  return {
    ...upsert,
    effectId: "effect-1",
    status: "running",
    attemptCount: 1,
    result: {},
    claimedBy: "worker-1",
    version: 1,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  } as ApprovalEffectRecord;
}

function fakeSettlement() {
  return {
    workerId: "worker-1",
    approvalEffects: {
      completeEffect: vi.fn(async () => ({}) as ApprovalEffectRecord),
      failEffect: vi.fn(async () => ({}) as ApprovalEffectRecord),
    },
    isEffectStillClaimed: vi.fn(async () => true),
    deferForRetry: vi.fn(async () => undefined),
  };
}

describe("citadel ward approval effects", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("enqueues one effect for an approved, rejected or expired ward approval and none for other kinds", () => {
    const integration = integrationApproval();
    expect(buildCitadelWardApprovalEffectUpsert(integration, "approve")).toEqual({
      approvalId: "approval-ward-1",
      effectKind: CITADEL_WARD_INTEGRATION_ACTION_EFFECT_KIND,
      targetKind: "citadel_ward_action",
      targetId: "approval-ward-1",
      idempotencyKey: `approval-ward-1:${CITADEL_WARD_INTEGRATION_ACTION_EFFECT_KIND}:citadel_ward_action:approval-ward-1`,
      payload: { decision: "approve", payloadHash: integration.payload.payloadHash },
    });
    const outbound = wardApproval(
      CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
      { outbound: {}, actorId: "a" },
      {
        status: "rejected",
      },
    );
    expect(buildCitadelWardApprovalEffectUpsert(outbound, "reject")).toMatchObject({
      effectKind: CITADEL_WARD_A2A_OUTBOUND_EFFECT_KIND,
      payload: { decision: "reject", payloadHash: outbound.payload.payloadHash },
    });
    const push = wardApproval(CITADEL_WARD_A2A_PUSH_APPROVAL_KIND, { taskId: "t" }, { status: "rejected" });
    expect(buildCitadelWardApprovalEffectUpsert(push, "reject", true)).toMatchObject({
      effectKind: CITADEL_WARD_A2A_PUSH_EFFECT_KIND,
      payload: { decision: "reject", expired: true },
    });
    expect(buildCitadelWardApprovalEffectUpsert({ ...integration, kind: "tool.invoke" }, "approve")).toBeUndefined();
    expect(isCitadelWardEffectKind(CITADEL_WARD_A2A_PUSH_EFFECT_KIND)).toBe(true);
    expect(isCitadelWardEffectKind("communications_mail_send_apply")).toBe(false);
  });

  it("runs the approved integration action once across two effect runs", async () => {
    const real = createRealIntegrationHost(activepiecesConnection(), [
      { actionPattern: "integration.*", effect: "require_approval" },
    ]);
    cleanups.push(real.cleanup);
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(integrationApproval()),
      integrationHost: () => real.host,
      a2a: () => fakeA2A(),
    });

    const first = await executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" });
    const second = await executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" });

    expect(real.fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ disposition: "executed", replayed: false });
    expect(second).toMatchObject({ disposition: "replayed", replayed: true });
    expect(real.host.createApproval).not.toHaveBeenCalled();
  });

  it("ward tightened to deny before execution blocks the action", async () => {
    const real = createRealIntegrationHost(activepiecesConnection(), [
      { actionPattern: "integration.*", effect: "deny" },
    ]);
    cleanups.push(real.cleanup);
    const approval = integrationApproval();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(approval),
      integrationHost: () => real.host,
      a2a: () => fakeA2A(),
    });
    const settlement = fakeSettlement();

    await runCitadelWardApprovalEffect(claimedEffect(approval, "approve"), executors, settlement);

    expect(settlement.approvalEffects.failEffect).toHaveBeenCalledWith(
      "effect-1",
      "worker-1",
      1,
      expect.objectContaining({ result: { errorCode: "ward_denied" } }),
    );
    expect(settlement.approvalEffects.completeEffect).not.toHaveBeenCalled();
    expect(settlement.deferForRetry).not.toHaveBeenCalled();
    expect(real.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the connection's citadel changed after approval", async () => {
    const real = createRealIntegrationHost(activepiecesConnection({ workspaceId: "ws-moved" }), [
      { actionPattern: "integration.*", effect: "require_approval" },
    ]);
    cleanups.push(real.cleanup);
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(integrationApproval()),
      integrationHost: () => real.host,
      a2a: () => fakeA2A(),
    });

    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" })).rejects.toMatchObject({
      code: "blocked",
      message: expect.stringMatching(/citadel changed after approval/),
    });
    expect(real.fetchMock).not.toHaveBeenCalled();
  });

  it("tampered request fails with payload_hash_mismatch and executes nothing", async () => {
    const integration = integrationApproval();
    const tampered: ApprovalRequest = {
      ...integration,
      payload: {
        ...integration.payload,
        request: { connectionId: CONNECTION_ID, actionId: "trigger_webhook", invokeRequest: { input: { x: 1 } } },
      },
    };
    const integrationHost = vi.fn();
    const a2a = fakeA2A();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(tampered),
      integrationHost: integrationHost as never,
      a2a: () => a2a,
    });

    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" })).rejects.toMatchObject({
      code: "payload_hash_mismatch",
    });
    expect(integrationHost).not.toHaveBeenCalled();
    expect(a2a.sendOutbound).not.toHaveBeenCalled();
  });

  it("non-approved approval fails with approval_not_approved", async () => {
    const a2a = fakeA2A();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(integrationApproval({ status: "pending" }), {
        ...integrationApproval(),
        approvalId: "approval-other",
        kind: "tool.invoke",
      }),
      integrationHost: vi.fn() as never,
      a2a: () => a2a,
    });

    for (const approvalId of ["approval-ward-1", "approval-other", "approval-missing"]) {
      const error = await executors.executeApprovedCitadelWardAction({ approvalId }).catch((caught) => caught);
      expect(error).toBeInstanceOf(CitadelWardApprovalEffectError);
      expect(error).toMatchObject({ code: "approval_not_approved" });
    }
    expect(a2a.sendOutbound).not.toHaveBeenCalled();
  });

  it("rejection completes with disposition rejected and records the refused push", async () => {
    const push = wardApproval(
      CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
      { taskId: "task-1", peerId: "peer-1", eventSequence: 3, eventKind: "status", urlHash: "hash-1" },
      { status: "rejected", wardAction: "a2a.outbound.push" },
    );
    const a2a = fakeA2A();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(push),
      integrationHost: vi.fn() as never,
      a2a: () => a2a,
    });

    const settlement = fakeSettlement();
    await runCitadelWardApprovalEffect(claimedEffect(push, "reject"), executors, settlement);
    expect(settlement.approvalEffects.completeEffect).toHaveBeenCalledWith("effect-1", "worker-1", 1, {
      result: { disposition: "rejected", kind: CITADEL_WARD_A2A_PUSH_APPROVAL_KIND },
    });
    expect(a2a.recordRefusedPushApproval).toHaveBeenCalledWith({
      approvalId: "approval-ward-1",
      taskId: "task-1",
      peerId: "peer-1",
      eventSequence: 3,
      disposition: "rejected",
    });

    const expiredSettlement = fakeSettlement();
    await runCitadelWardApprovalEffect(claimedEffect(push, "reject", true), executors, expiredSettlement);
    expect(expiredSettlement.approvalEffects.completeEffect).toHaveBeenCalledWith("effect-1", "worker-1", 1, {
      result: { disposition: "expired", kind: CITADEL_WARD_A2A_PUSH_APPROVAL_KIND },
    });
    expect(a2a.recordRefusedPushApproval).toHaveBeenLastCalledWith(expect.objectContaining({ disposition: "expired" }));

    const integration = integrationApproval({ status: "rejected" });
    const integrationExecutors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(integration),
      integrationHost: vi.fn() as never,
      a2a: () => a2a,
    });
    await expect(
      integrationExecutors.recordCitadelWardApprovalRefused({ approvalId: "approval-ward-1", expired: false }),
    ).resolves.toEqual({ disposition: "rejected", kind: CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND });
    expect(a2a.recordRefusedPushApproval).toHaveBeenCalledTimes(2);
  });

  it("a2a outbound and push kinds dispatch to the route service with the ward approval reference", async () => {
    const outboundRequest = { peerId: "peer-1", method: "SendMessage", params: { text: "hi" } };
    const outbound = wardApproval(
      CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
      { outbound: outboundRequest, actorId: "operator-1" },
      { wardAction: "a2a.outbound.jsonrpc.SendMessage", citadelId: "personal" },
    );
    const push = wardApproval(
      CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
      { taskId: "task-1", peerId: "peer-1", eventSequence: 3, eventKind: "status", urlHash: "hash-1" },
      { approvalId: "approval-push-1", wardAction: "a2a.outbound.push" },
    );
    const a2a = fakeA2A();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(outbound, push),
      integrationHost: vi.fn() as never,
      a2a: () => a2a,
    });

    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" })).resolves.toMatchObject({
      disposition: "sent",
      replayed: false,
    });
    expect(a2a.sendOutbound).toHaveBeenCalledWith(
      { ...outboundRequest, idempotencyKey: "citadel-ward:approval-ward-1" },
      "operator-1",
      undefined,
      { wardApproval: { approvalId: "approval-ward-1", wardAction: "a2a.outbound.jsonrpc.SendMessage" } },
    );

    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-push-1" })).resolves.toMatchObject({
      disposition: "delivered",
      eventSequence: 3,
    });
    expect(a2a.deliverApprovedPush).toHaveBeenCalledWith({
      approvalId: "approval-push-1",
      wardAction: "a2a.outbound.push",
      taskId: "task-1",
      peerId: "peer-1",
      eventSequence: 3,
      urlHash: "hash-1",
      citadelId: "citadel-guarded",
    });

    a2a.sendOutbound.mockResolvedValueOnce({
      ...(await a2a.sendOutbound.mock.results[0]!.value),
      status: "blocked",
      warnings: ["A Citadel Ward denies a2a.outbound.jsonrpc.SendMessage (citadel personal)."],
    });
    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" })).rejects.toMatchObject({
      code: "ward_denied",
    });
    a2a.deliverApprovedPush.mockResolvedValueOnce([
      { ...(await a2a.deliverApprovedPush.mock.results[0]!.value)[0]!, status: "blocked", error: "URL changed" },
    ]);
    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-push-1" })).rejects.toMatchObject({
      code: "blocked",
      message: expect.stringMatching(/URL changed/),
    });
  });

  it("defers only unexpected errors and fails a missing executor closed", async () => {
    const approval = integrationApproval();
    const settlement = fakeSettlement();
    const failing: CitadelWardApprovalEffectExecutors = {
      executeApprovedCitadelWardAction: vi.fn(async () => {
        throw new Error("storage offline");
      }),
    };
    await runCitadelWardApprovalEffect(claimedEffect(approval, "approve"), failing, settlement);
    expect(settlement.deferForRetry).toHaveBeenCalledTimes(1);
    expect(settlement.approvalEffects.failEffect).not.toHaveBeenCalled();

    const missing = fakeSettlement();
    await runCitadelWardApprovalEffect(claimedEffect(approval, "approve"), {}, missing);
    expect(missing.approvalEffects.failEffect).toHaveBeenCalledWith(
      "effect-1",
      "worker-1",
      1,
      expect.objectContaining({ lastError: "Citadel Ward effect is missing its executor." }),
    );
  });

  function approvedPush() {
    return wardApproval(
      CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
      { taskId: "task-1", peerId: "peer-1", eventSequence: 3, eventKind: "status", urlHash: "hash-1" },
      { wardAction: "a2a.outbound.push" },
    );
  }

  it("an empty push result is settled only when the config already moved past the event", async () => {
    const push = approvedPush();
    const settledA2A = fakeA2A();
    settledA2A.deliverApprovedPush.mockResolvedValue([]);
    const settled = buildCitadelWardApprovalEffectDeps({
      storage: approvalAndPushStore([push], { "task-1:peer-1": { lastEventSequence: 3 } }),
      integrationHost: vi.fn() as never,
      a2a: () => settledA2A,
    });
    await expect(settled.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" })).resolves.toEqual({
      disposition: "already_settled",
      eventSequence: 3,
    });

    for (const pushConfigs of [{}, { "task-1:peer-1": { lastEventSequence: 2 } }]) {
      const goneA2A = fakeA2A();
      goneA2A.deliverApprovedPush.mockResolvedValue([]);
      const gone = buildCitadelWardApprovalEffectDeps({
        storage: approvalAndPushStore([push], pushConfigs),
        integrationHost: vi.fn() as never,
        a2a: () => goneA2A,
      });
      const settlement = fakeSettlement();
      await runCitadelWardApprovalEffect(claimedEffect(push, "approve"), gone, settlement);
      expect(settlement.approvalEffects.completeEffect).not.toHaveBeenCalled();
      expect(settlement.approvalEffects.failEffect).toHaveBeenCalledWith(
        "effect-1",
        "worker-1",
        1,
        expect.objectContaining({
          lastError: expect.stringMatching(/gone, disabled or no longer at event 3; nothing was delivered/),
          result: { errorCode: "blocked" },
        }),
      );
      // The approved event is recorded refused (a no-op when the config already moved past it).
      expect(goneA2A.recordRefusedPushApproval).toHaveBeenCalledWith({
        approvalId: "approval-ward-1",
        taskId: "task-1",
        peerId: "peer-1",
        eventSequence: 3,
        disposition: "failed",
        reason: expect.stringMatching(/^blocked: .*nothing was delivered/),
      });
    }
    expect(settledA2A.recordRefusedPushApproval).not.toHaveBeenCalled();
  });

  it("a push ward tightened to deny fails the effect with ward_denied and delivers nothing", async () => {
    const push = approvedPush();
    const a2a = fakeA2A();
    a2a.deliverApprovedPush.mockResolvedValue([
      {
        taskId: "task-1",
        peerId: "peer-1",
        url: "https://peer.example.test/push",
        eventSequence: 3,
        eventKind: "status",
        status: "blocked",
        attemptCount: 1,
        checkedAt: "2026-07-07T00:00:00.000Z",
        error: "A Citadel Ward denies a2a.outbound.push (citadel citadel-guarded).",
      } as A2ATaskPushDeliveryResult,
    ]);
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(push),
      integrationHost: vi.fn() as never,
      a2a: () => a2a,
    });
    const settlement = fakeSettlement();

    await runCitadelWardApprovalEffect(claimedEffect(push, "approve"), executors, settlement);

    expect(settlement.approvalEffects.failEffect).toHaveBeenCalledWith(
      "effect-1",
      "worker-1",
      1,
      expect.objectContaining({ result: { errorCode: "ward_denied" } }),
    );
    expect(settlement.approvalEffects.completeEffect).not.toHaveBeenCalled();
    expect(settlement.deferForRetry).not.toHaveBeenCalled();
    expect(a2a.sendOutbound).not.toHaveBeenCalled();
    // The owner already recorded the blocked delivery, so this refusal record is a no-op there.
    expect(a2a.recordRefusedPushApproval).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "failed", reason: expect.stringMatching(/^ward_denied: /) }),
    );
  });

  it("a hash mismatch on a push approval records the push refused with disposition failed", async () => {
    const push = approvedPush();
    const tampered: ApprovalRequest = {
      ...push,
      payload: { ...push.payload, request: { ...(push.payload.request as object), urlHash: "hash-other" } },
    };
    const a2a = fakeA2A();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(tampered),
      integrationHost: vi.fn() as never,
      a2a: () => a2a,
    });
    const settlement = fakeSettlement();

    await runCitadelWardApprovalEffect(claimedEffect(push, "approve"), executors, settlement);

    expect(settlement.approvalEffects.failEffect).toHaveBeenCalledWith(
      "effect-1",
      "worker-1",
      1,
      expect.objectContaining({ result: { errorCode: "payload_hash_mismatch" } }),
    );
    expect(a2a.deliverApprovedPush).not.toHaveBeenCalled();
    expect(a2a.recordRefusedPushApproval).toHaveBeenCalledWith({
      approvalId: "approval-ward-1",
      taskId: "task-1",
      peerId: "peer-1",
      eventSequence: 3,
      disposition: "failed",
      reason: expect.stringMatching(/^payload_hash_mismatch: /),
    });
  });

  it("an integration or outbound refusal records no push", async () => {
    const real = createRealIntegrationHost(activepiecesConnection(), [
      { actionPattern: "integration.*", effect: "deny" },
    ]);
    cleanups.push(real.cleanup);
    const a2a = fakeA2A();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(integrationApproval()),
      integrationHost: () => real.host,
      a2a: () => a2a,
    });

    await expect(executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" })).rejects.toMatchObject({
      code: "ward_denied",
    });
    expect(a2a.recordRefusedPushApproval).not.toHaveBeenCalled();
  });

  it("two approvals of one keyed integration request execute the provider once", async () => {
    const real = createRealIntegrationHost(activepiecesConnection(), [
      { actionPattern: "integration.*", effect: "require_approval" },
    ]);
    cleanups.push(real.cleanup);
    const keyed = {
      connectionId: CONNECTION_ID,
      actionId: "trigger_webhook",
      invokeRequest: { input: {}, idempotencyKey: "client-key-1" },
    };
    const first = wardApproval(CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND, keyed);
    const second = wardApproval(CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND, keyed, {
      approvalId: "approval-ward-2",
    });
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(first, second),
      integrationHost: () => real.host,
      a2a: () => fakeA2A(),
    });

    const firstResult = await executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" });
    const secondResult = await executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-2" });

    expect(real.fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({ disposition: "executed" });
    expect(secondResult).toMatchObject({ disposition: "replayed", replayed: true });
  });

  it("an approved outbound replay runs under the request's own idempotency key when it has one", async () => {
    const outboundRequest = {
      peerId: "peer-1",
      method: "SendMessage",
      params: { text: "hi" },
      idempotencyKey: "client-key-1",
    };
    const approval = wardApproval(
      CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
      { outbound: outboundRequest, actorId: "operator-1" },
      { wardAction: "a2a.outbound.jsonrpc.SendMessage", citadelId: "personal" },
    );
    const a2a = fakeA2A();
    const executors = buildCitadelWardApprovalEffectDeps({
      storage: approvalStore(approval),
      integrationHost: vi.fn() as never,
      a2a: () => a2a,
    });

    await executors.executeApprovedCitadelWardAction({ approvalId: "approval-ward-1" });

    expect(a2a.sendOutbound).toHaveBeenCalledWith(outboundRequest, "operator-1", undefined, {
      wardApproval: { approvalId: "approval-ward-1", wardAction: "a2a.outbound.jsonrpc.SendMessage" },
    });
  });
});
