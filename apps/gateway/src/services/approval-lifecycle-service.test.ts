import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalEffectRecord,
  ApprovalRequest,
  CodeModeRunRecord,
  ToolGrantCreateInput,
} from "@goatcitadel/contracts";
import {
  createApproval,
  createToolGrant,
  expirePendingApprovals,
  listApprovals,
  listApprovalsPage,
  revokeToolGrant,
  resolveApproval,
  resolveApprovalsBulk,
  resolveChatToolApproval,
  type ApprovalLifecycleHost,
} from "./approval-lifecycle-service.js";
import {
  createApprovalRemoteActionToken,
  resolveApprovalWithConsumedRemoteToken,
  resolveApprovalWithRemoteToken,
  type ApprovalRemoteActionContext,
} from "./approval-remote-action-service.js";
import {
  ApprovalEffectsService,
  deriveApprovalResolutionEffectsResult,
} from "./approval-resolution-effects-service.js";
import { ConflictError } from "@goatcitadel/contracts";

describe("approval lifecycle service", () => {
  it("keeps a created tool grant committed when realtime projection fails", () => {
    const host = createApprovalHarness();
    const input: ToolGrantCreateInput = {
      toolPattern: "browser.*",
      decision: "allow",
      scope: "global",
      createdBy: "operator-test",
    };
    const grant = {
      grantId: "grant-1",
      ...input,
      grantType: "persistent" as const,
      constraints: {},
      status: "active" as const,
      usesRemaining: undefined,
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    host.policyEngine.createGrant.mockReturnValue(grant);
    host.publishRealtime.mockImplementationOnce(() => {
      throw new Error("realtime projection unavailable");
    });

    expect(createToolGrant(host, input)).toEqual(grant);
    expect(host.policyEngine.createGrant).toHaveBeenCalledTimes(1);
    expect(host.publishRealtime).toHaveBeenCalledTimes(1);
  });

  it("keeps a revoked tool grant committed when realtime projection fails", () => {
    const host = createApprovalHarness();
    host.policyEngine.revokeGrant.mockReturnValue(true);
    host.publishRealtime.mockImplementationOnce(() => {
      throw new Error("realtime projection unavailable");
    });

    expect(revokeToolGrant(host, "grant-1", "operator-test")).toBe(true);
    expect(host.policyEngine.revokeGrant).toHaveBeenCalledTimes(1);
    expect(host.publishRealtime).toHaveBeenCalledTimes(1);
  });

  it("does not hide tool-grant policy mutation failures", () => {
    const createHost = createApprovalHarness();
    createHost.policyEngine.createGrant.mockImplementationOnce(() => {
      throw new Error("grant create conflict");
    });

    expect(() =>
      createToolGrant(createHost, {
        toolPattern: "browser.*",
        decision: "allow",
        scope: "global",
        createdBy: "operator-test",
      }),
    ).toThrow("grant create conflict");
    expect(createHost.publishRealtime).not.toHaveBeenCalled();

    const revokeHost = createApprovalHarness();
    revokeHost.policyEngine.revokeGrant.mockImplementationOnce(() => {
      throw new Error("grant revoke conflict");
    });

    expect(() => revokeToolGrant(revokeHost, "grant-1", "operator-test")).toThrow("grant revoke conflict");
    expect(revokeHost.publishRealtime).not.toHaveBeenCalled();
  });

  it("rolls back remote-token issuance when resolution wins the observability lock", () => {
    const host = createApprovalHarness();
    const pending = host.storage.approvals.get("approval-1");
    host.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);
    host.storage.remoteActionTokens.create = vi.fn(() => ({
      tokenId: "token-1",
      actionType: "approval.resolve",
      approvalId: "approval-1",
      connectorId: "connector-1",
      mutation: { approvalId: "approval-1" },
      createdAt: "2026-04-11T00:00:00.000Z",
      expiresAt: "2099-04-11T00:15:00.000Z",
      state: "pending",
    }));
    host.enqueueApprovalObservabilityEffects = vi.fn(() => {
      host.storage.approvals.resolve(pending.approvalId, {
        decision: "approve",
        resolvedBy: "operator",
      });
      return [];
    });

    expect(() => createApprovalRemoteActionToken(host, "approval-1", { connectorId: "connector-1" })).toThrow(
      /already resolved/i,
    );
    expect(host.enqueueApprovalRemoteTokenDelivery).not.toHaveBeenCalled();
  });

  it("does not issue or deliver a remote token after the approval deadline", () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });
    host.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);

    expect(() => createApprovalRemoteActionToken(host, "approval-1", { connectorId: "connector-1" })).toThrow(
      /has expired/i,
    );
    expect(host.storage.remoteActionTokens.create).not.toHaveBeenCalled();
    expect(host.enqueueApprovalObservabilityEffects).not.toHaveBeenCalled();
    expect(host.enqueueApprovalRemoteTokenDelivery).not.toHaveBeenCalled();
  });

  it("rolls back remote-token issuance when the approval expires during locked observability work", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));
      const host = createApprovalHarness({
        expiresAt: "2026-04-11T00:00:01.000Z",
      });
      host.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);
      host.storage.remoteActionTokens.create = vi.fn(() => createRemoteActionTokenRecord("token-boundary"));
      host.enqueueApprovalObservabilityEffects = vi.fn(() => {
        host.storage.approvals.isExpiredPendingAtDatabaseNow.mockReturnValue(true);
        return [];
      });

      expect(() => createApprovalRemoteActionToken(host, "approval-1", { connectorId: "connector-1" })).toThrow(
        /has expired/i,
      );
      expect(host.enqueueApprovalRemoteTokenDelivery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back a remote token whose own TTL elapses before the locked transaction commits", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));
      const host = createApprovalHarness({
        expiresAt: "2026-04-11T01:00:00.000Z",
      });
      host.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);
      host.storage.remoteActionTokens.createWithTtl = vi.fn(() => ({
        ...createRemoteActionTokenRecord("token-ttl-boundary"),
        expiresAt: "2026-04-11T00:01:00.000Z",
      }));
      host.enqueueApprovalObservabilityEffects = vi.fn(() => {
        host.storage.remoteActionTokens.findPendingFresh.mockReturnValue(undefined);
        return [];
      });

      expect(() =>
        createApprovalRemoteActionToken(host, "approval-1", {
          connectorId: "connector-1",
          expiresInMs: 60_000,
        }),
      ).toThrow(/expired before issuance committed/i);
      expect(host.enqueueApprovalRemoteTokenDelivery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues relative remote-token TTLs from the database clock under fast and slow host skew", () => {
    vi.useFakeTimers();
    try {
      for (const hostClock of ["2100-04-11T00:00:00.000Z", "2000-04-11T00:00:00.000Z"]) {
        vi.setSystemTime(new Date(hostClock));
        const host = createApprovalHarness();
        host.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);
        const created = {
          ...createRemoteActionTokenRecord(`token-db-clock-${hostClock.slice(0, 4)}`),
          createdAt: "2026-04-11T00:00:00.000Z",
          expiresAt: "2026-04-11T00:01:00.000Z",
        };
        const createWithTtl = vi.fn(() => created);
        Object.assign(host.storage.remoteActionTokens, {
          createWithTtl,
          findPendingFresh: vi.fn(() => created),
        });

        const issued = createApprovalRemoteActionToken(host, "approval-1", {
          connectorId: "connector-1",
          expiresInMs: 60_000,
        });

        expect(issued).toMatchObject({ tokenId: created.tokenId, expiresAt: created.expiresAt });
        expect(createWithTtl).toHaveBeenCalledWith(
          expect.objectContaining({
            approvalId: "approval-1",
            connectorId: "connector-1",
            expiresInMs: 60_000,
          }),
        );
        expect(host.storage.approvals.lockPendingForUpdate).toHaveBeenCalledTimes(2);
        expect(host.storage.approvals.lockPendingForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
          createWithTtl.mock.invocationCallOrder[0]!,
        );
        expect(host.storage.remoteActionTokens.create).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports queued, absent, and failed remote-token delivery without reviving issuance", () => {
    const queuedHost = createApprovalHarness();
    queuedHost.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);
    queuedHost.storage.remoteActionTokens.create = vi.fn(() => createRemoteActionTokenRecord("token-queued"));
    queuedHost.enqueueApprovalRemoteTokenDelivery = vi.fn(() => ({ runId: "delivery-run-1" }));

    expect(createApprovalRemoteActionToken(queuedHost, "approval-1", { connectorId: "connector-1" })).toMatchObject({
      tokenId: "token-queued",
      deliveryStatus: "queued",
      deliveryRunId: "delivery-run-1",
    });

    const absentHost = createApprovalHarness();
    absentHost.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);
    absentHost.storage.remoteActionTokens.create = vi.fn(() => createRemoteActionTokenRecord("token-absent"));
    absentHost.enqueueApprovalRemoteTokenDelivery = vi.fn(() => undefined);

    expect(createApprovalRemoteActionToken(absentHost, "approval-1", { connectorId: "connector-1" })).toMatchObject({
      tokenId: "token-absent",
      deliveryStatus: "not_configured",
    });

    const failedHost = createApprovalHarness();
    failedHost.requireConnectorRecord = vi.fn(() => ({ connectorId: "connector-1" }) as never);
    failedHost.storage.remoteActionTokens.create = vi.fn(() => createRemoteActionTokenRecord("token-failed"));
    failedHost.enqueueApprovalRemoteTokenDelivery = vi.fn(() => {
      throw new Error("connector delivery unavailable");
    });

    expect(createApprovalRemoteActionToken(failedHost, "approval-1", { connectorId: "connector-1" })).toMatchObject({
      tokenId: "token-failed",
      deliveryStatus: "failed",
      deliveryError: "connector delivery unavailable",
    });
  });

  it("binds raw remote-token consumption to the ingress connector when supplied", async () => {
    const host = createApprovalHarness();
    const tokenRecord = createRemoteActionTokenRecord("token-bound-ingress");
    host.consumeRemoteActionToken = vi.fn(() => tokenRecord);
    host.resolveApproval = vi.fn(async () => ({ approval: host.storage.approvals.get("approval-1"), effects: [] }));

    await resolveApprovalWithRemoteToken(host, {
      token: "grat_connector_bound",
      connectorId: "integration:conn-telegram",
      decision: "approve",
      resolvedBy: "telegram:777",
    });

    expect(host.consumeRemoteActionToken).toHaveBeenCalledWith(
      "grat_connector_bound",
      "approval.resolve",
      expect.objectContaining({ expectedConnectorId: "integration:conn-telegram" }),
    );
  });

  it("keeps pending-list reads side-effect free and preserves repository-owned expiry filtering", () => {
    const host = createApprovalHarness();
    const activeApproval: ApprovalRequest = {
      approvalId: "approval-active",
      kind: "browser.search",
      riskLevel: "caution",
      status: "pending",
      payload: {},
      preview: {},
      createdAt: "2026-04-11T00:00:00.000Z",
      expiresAt: "2099-04-11T00:00:00.000Z",
      explanationStatus: "not_requested",
    };
    host.storage.approvals.list = vi.fn(() => [activeApproval]);

    expect(listApprovals(host, "pending").map((approval) => approval.approvalId)).toEqual(["approval-active"]);
    expect(host.storage.approvals.list).toHaveBeenCalledWith("pending", 100, undefined);
    expect(host.storage.approvals.resolve).not.toHaveBeenCalled();
  });

  it("preserves repository-owned pending-page expiry and cursor truth", () => {
    const host = createApprovalHarness();
    const activeApproval = host.storage.approvals.get("approval-1");
    host.storage.approvals.listPage = vi.fn(() => ({
      items: [activeApproval],
      nextCursor: "opaque-next-cursor",
    }));

    expect(listApprovalsPage(host, { status: "pending", limit: 2 })).toEqual({
      items: [expect.objectContaining({ approvalId: "approval-1" })],
      nextCursor: "opaque-next-cursor",
    });
    expect(host.storage.approvals.resolve).not.toHaveBeenCalled();
  });

  it("creates approvals with explicit wait-run linkage and retained-stream metadata", async () => {
    const host = createApprovalHarness();

    const approval = await createApproval(host, {
      kind: "shell.exec",
      riskLevel: "danger",
      payload: {
        sessionId: "session-1",
      },
      preview: {
        label: "Run shell command",
      },
      linkage: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    });

    expect(host.approvalWaitRunService.primeApprovalLifecycle).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    );
    expect(host.approvalWaitRunService.reserveApprovalWaitRun).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", status: "pending" }),
    );
    expect(host.enqueueApprovalWaitMaterialization).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        linkage: expect.objectContaining({ durableRunId: "approval-wait-1" }),
      }),
    );
    expect(host.enqueueApprovalObservabilityEffects).toHaveBeenCalledWith(
      "approval-1",
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "approval.create.realtime",
          delivery: expect.objectContaining({
            kind: "realtime",
            eventType: "approval_created",
            source: "approvals",
            payload: {
              approvalId: "approval-1",
              kind: "shell.exec",
              riskLevel: "danger",
              status: "pending",
            },
            options: expect.objectContaining({
              eventClass: "domain_fact",
              eventAuthority: "retained_stream",
              links: expect.objectContaining({
                approvalId: "approval-1",
                sessionId: "session-1",
                workspaceId: "workspace-1",
              }),
              correlationId: "approval-1",
            }),
          }),
        }),
      ]),
    );
    expect(host.scheduleApprovalExplanation).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        linkage: expect.objectContaining({
          durableRunId: "approval-wait-1",
        }),
      }),
    );
    expect(approval.linkage?.durableRunId).toBe("approval-wait-1");
  });

  it("commits policy registration and its audit outbox extension inside approval creation", async () => {
    const host = createApprovalHarness();
    host.storage.pendingApprovalActions.upsertPending = vi.fn();
    let transactionActive = false;
    host.storage.runImmediateTransaction = vi.fn(<T>(callback: () => T): T => {
      transactionActive = true;
      try {
        return callback();
      } finally {
        transactionActive = false;
      }
    });
    const onCreated = vi.fn((approval: ApprovalRequest) => {
      expect(transactionActive).toBe(true);
      host.storage.pendingApprovalActions.upsertPending({
        approvalId: approval.approvalId,
        actionType: "tool.invoke",
        request: { toolName: "shell.exec" },
      });
      return [
        {
          operationId: "tool.invoke.approval_required.audit:audit-1",
          delivery: {
            kind: "audit" as const,
            stream: "tool_invocations" as const,
            payload: { auditEventId: "audit-1", approvalId: approval.approvalId },
          },
        },
      ];
    });

    await createApproval(
      host,
      {
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { sessionId: "session-1" },
        preview: { label: "Run shell command" },
        linkage: { sessionId: "session-1", workspaceId: "workspace-1" },
      },
      onCreated,
    );

    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        linkage: expect.objectContaining({ durableRunId: "approval-wait-1" }),
      }),
    );
    expect(host.storage.pendingApprovalActions.upsertPending).toHaveBeenCalledTimes(1);
    expect(host.enqueueApprovalObservabilityEffects).toHaveBeenCalledWith(
      "approval-1",
      expect.arrayContaining([expect.objectContaining({ operationId: "tool.invoke.approval_required.audit:audit-1" })]),
    );
  });

  it.each([0, Number.NaN])("fails closed for invalid Gateway approval TTL authority %s", async (ttlMs) => {
    const host = createApprovalHarness();
    host.storage.approvals.createWithTtlDuration = vi.fn(() => {
      throw new Error("ttlMs must be a positive duration");
    });

    await expect(
      createApproval(
        host,
        {
          kind: "shell.exec",
          riskLevel: "danger",
          payload: { sessionId: "session-1" },
          preview: { label: "Run shell command" },
          linkage: { sessionId: "session-1", workspaceId: "workspace-1" },
        },
        undefined,
        { ttlMs },
      ),
    ).rejects.toThrow(/positive duration/i);

    expect(host.storage.approvals.create).not.toHaveBeenCalled();
  });

  it("blocks createApproval when approval.request.before vetoes before approval.create.before fires", async () => {
    const host = createApprovalHarness();
    const seenTriggers: string[] = [];
    host.hooksService.runInlineHooks = vi.fn(async (input: { trigger: string }) => {
      seenTriggers.push(input.trigger);
      if (input.trigger === "approval.request.before") {
        return {
          blockedBy: { type: "block" as const, reason: "policy: blocked" },
          runs: [],
        };
      }
      return { runs: [] };
    });

    await expect(
      createApproval(host, {
        kind: "shell.exec",
        riskLevel: "danger",
        payload: {
          sessionId: "session-1",
        },
        preview: {
          label: "Run shell command",
        },
        linkage: {
          sessionId: "session-1",
          workspaceId: "workspace-1",
        },
      }),
    ).rejects.toThrow(/policy: blocked/);

    expect(seenTriggers).toEqual(["approval.request.before"]);
    expect(host.storage.approvals.create).not.toHaveBeenCalled();
  });

  it("fires approval.request.before then approval.create.before in order on happy path", async () => {
    const host = createApprovalHarness();
    const seenTriggers: string[] = [];
    host.hooksService.runInlineHooks = vi.fn(async (input: { trigger: string }) => {
      seenTriggers.push(input.trigger);
      return { runs: [] };
    });

    const approval = await createApproval(host, {
      kind: "shell.exec",
      riskLevel: "danger",
      payload: {
        sessionId: "session-1",
      },
      preview: {
        label: "Run shell command",
      },
      linkage: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    });

    expect(seenTriggers).toEqual(["approval.request.before", "approval.create.before"]);
    expect(host.storage.approvals.create).toHaveBeenCalledTimes(1);
    expect(approval.approvalId).toBe("approval-1");
  });

  it("returns committed creation truth when observability delivery is unavailable", async () => {
    const host = createApprovalHarness();
    const transactionSpy = vi.spyOn(host.storage, "runImmediateTransaction");
    host.storage.audit.append = vi.fn(async () => {
      throw new Error("audit store unavailable");
    });

    await expect(
      createApproval(host, {
        kind: "shell.exec",
        riskLevel: "danger",
        payload: {
          sessionId: "session-1",
        },
        preview: {
          label: "Run shell command",
        },
        linkage: {
          sessionId: "session-1",
          workspaceId: "workspace-1",
        },
      }),
    ).resolves.toMatchObject({
      approvalId: "approval-1",
      status: "pending",
    });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "created",
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("auto-rejects dangerous shell approvals with durable resolution evidence", async () => {
    const host = createApprovalHarness({
      pendingAction: {
        approvalId: "approval-1",
        actionType: "tool.invoke",
        request: { toolName: "shell.exec" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      shellExplainerPolicy: {
        enabled: true,
        elevateOnDanger: "danger",
        autoRejectOnDanger: true,
        autoRejectDangerThreshold: "danger",
      },
    });

    const approval = await createApproval(host, {
      kind: "shell.exec",
      riskLevel: "caution",
      payload: {
        sessionId: "session-1",
        command: "rm -rf /tmp/gc-danger",
      },
      preview: {
        label: "Run shell command",
      },
      linkage: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    });

    expect(approval).toMatchObject({
      approvalId: "approval-1",
      riskLevel: "danger",
      status: "rejected",
      resolvedBy: "system",
      resolutionNote: expect.stringContaining("Auto-rejected"),
    });
    expect(host.storage.approvals.setShellExplanations).toHaveBeenCalledWith(
      "approval-1",
      expect.arrayContaining([expect.objectContaining({ command: "rm -rf /tmp/gc-danger", highestRisk: "danger" })]),
    );
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "created",
      }),
    );
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "resolved",
        actorId: "system",
        payload: expect.objectContaining({ decision: "reject", status: "rejected" }),
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "rejected",
      expect.objectContaining({ decision: "reject" }),
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", status: "rejected" }),
      expect.objectContaining({ decision: "reject", resolvedBy: "system" }),
    );
    expect(host.scheduleApprovalExplanation).not.toHaveBeenCalled();
  });

  it("returns durable wake linkage from effect rows when resolving approvals", async () => {
    const host = createApprovalHarness({
      pendingAction: {
        approvalId: "approval-1",
        actionType: "tool.invoke",
        request: {},
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      approvalEffects: [
        {
          effectId: "effect-1",
          approvalId: "approval-1",
          effectKind: "approval_wait_wake",
          targetKind: "durable_run",
          targetId: "approval-wait-42",
          idempotencyKey: "approval-1:approval_wait_wake",
          status: "pending",
          attemptCount: 0,
          payload: {},
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        },
      ],
    });

    const result = await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator",
    });

    expect(host.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      {
        decision: "approve",
        resolvedBy: "operator",
      },
      undefined,
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        status: "approved",
      }),
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );
    expect(result.durableRunId).toBe("approval-wait-42");
    expect(result.resolutionEffects).toMatchObject({
      approvalWaitDurableRunId: "approval-wait-42",
    });
    expect(result.approval.linkage?.durableRunId).toBe("approval-wait-42");
    expect(host.storage.approvals.mergeLinkage).toHaveBeenCalledWith("approval-1", {
      durableRunId: "approval-wait-42",
    });
  });

  it("returns committed resolution truth without awaiting observability delivery", async () => {
    const host = createApprovalHarness();
    host.storage.audit.append = vi.fn(async () => {
      throw new Error("audit store unavailable");
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).resolves.toMatchObject({
      approval: {
        approvalId: "approval-1",
        status: "approved",
      },
    });

    expect(host.storage.approvals.resolve).toHaveBeenCalledTimes(1);
    expect(host.storage.approvalEvents.append).toHaveBeenCalledTimes(1);
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["approve", "approved", "resolved_approved"],
    ["reject", "rejected", "resolved_rejected"],
    ["edit", "edited", "resolved_edited"],
  ] as const)(
    "records a content-free, source-linked Journey event for %s resolution",
    async (decision, status, action) => {
      const host = createApprovalHarness({
        approvalLinkage: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          turnId: "turn-1",
          taskId: "task-1",
          durableRunId: "durable-1",
        },
      });

      await resolveApproval(host, "approval-1", {
        decision,
        resolvedBy: "operator-1",
        ...(decision === "edit" ? { editedPayload: { secret: "must-not-project" } } : {}),
      });

      expect(host.storage.governanceJourneyEvents.create).toHaveBeenCalledOnce();
      const journey = host.storage.governanceJourneyEvents.create.mock.calls[0]?.[0];
      expect(journey).toMatchObject({
        schemaVersion: "goatcitadel.journey-event.v1",
        eventId: "approval:journey:approval-event-1",
        idempotencyKey: "approval:lifecycle:approval-event-1",
        scopeKind: "workspace",
        workspaceId: "workspace-1",
        eventType: "approval_lifecycle",
        subjectKind: "approval",
        subjectId: "approval-1",
        action,
        actorId: "operator-1",
        actorType: "operator",
        sessionId: "session-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        sourceKind: "approval_event",
        sourceId: "approval-event-1",
        trustDisposition: status,
        poisoningStatus: "clean",
        evidenceRefs: [{ owner: "approval", refId: "approval-1" }],
        provenance: {
          sourceRequired: true,
          approvalRequired: false,
          taskId: "task-1",
          durableRunId: "durable-1",
        },
        summary: { decision, status, expired: false },
        occurredAt: "2026-04-11T00:01:00.000Z",
        recordedAt: "2026-04-11T00:01:00.000Z",
      });
      expect(journey?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(journey)).not.toContain("must-not-project");
    },
  );

  it("does not invent a Journey scope when approval workspace linkage is missing", async () => {
    const host = createApprovalHarness({ approvalLinkage: { sessionId: "session-1" } });

    await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator-1",
    });

    expect(host.storage.approvals.get("approval-1").status).toBe("approved");
    expect(host.storage.governanceJourneyEvents.create).not.toHaveBeenCalled();
  });

  it("rolls resolution back when its Journey record cannot commit", async () => {
    const host = createApprovalHarness();
    host.storage.governanceJourneyEvents.create.mockImplementationOnce(() => {
      throw new Error("journey store unavailable");
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator-1",
      }),
    ).rejects.toThrow("journey store unavailable");

    expect(host.storage.approvals.get("approval-1").status).toBe("pending");
    expect(host.enqueueApprovalResolutionEffects).not.toHaveBeenCalled();
  });

  it("expires every remaining remote token before enqueueing effects for a terminal resolution", async () => {
    const host = createApprovalHarness();
    host.storage.remoteActionTokens.expirePendingByApprovalId = vi.fn(() => 2);

    await resolveApproval(host, "approval-1", {
      decision: "reject",
      resolvedBy: "operator",
    });

    expect(host.storage.remoteActionTokens.expirePendingByApprovalId).toHaveBeenCalledOnce();
    expect(host.storage.remoteActionTokens.expirePendingByApprovalId).toHaveBeenCalledWith("approval-1");
    expect(host.storage.remoteActionTokens.expirePendingByApprovalId.mock.invocationCallOrder[0]).toBeLessThan(
      host.enqueueApprovalResolutionEffects.mock.invocationCallOrder[0]!,
    );
  });

  it("terminalizes an already-expired generic approval and reports committed expiry truth", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "tool.invoke",
        request: { toolName: "shell.exec", args: { command: "pwd" } },
        createdAt: "2020-04-10T23:59:00.000Z",
        resolutionStatus: "pending",
      },
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toMatchObject({
      mutationCommitted: true,
      message: expect.stringMatching(/has expired and can no longer be resolved/i),
    });

    expect(host.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "reject",
        resolvedBy: "system:approval-expiry",
        resolutionNote: expect.stringMatching(/expired/i),
      }),
      expect.objectContaining({ allowExpired: true }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "rejected",
      expect.objectContaining({
        decision: "reject",
        expired: true,
        requestedDecision: "approve",
      }),
    );
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "resolved",
        actorId: "system:approval-expiry",
        payload: expect.objectContaining({
          decision: "reject",
          status: "rejected",
          expired: true,
          requestedDecision: "approve",
        }),
      }),
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", status: "rejected" }),
      expect.objectContaining({ decision: "reject", resolvedBy: "system:approval-expiry" }),
      { allowExpired: true },
    );
    expect(host.enqueueApprovalObservabilityEffects).toHaveBeenCalledWith(
      "approval-1",
      expect.arrayContaining([expect.objectContaining({ operationId: "approval.resolve.audit" })]),
    );
    expect(host.storage.remoteActionTokens.expirePendingByApprovalId).toHaveBeenCalledWith("approval-1");
    expect(host.storage.governanceJourneyEvents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "expired",
        actorId: "system:approval-expiry",
        actorType: "system",
        sourceKind: "approval_event",
        approvalId: "approval-1",
        summary: { decision: "expired", status: "rejected", expired: true },
      }),
    );
  });

  it("allows only one expiry winner and leaves duplicate resolvers on terminal truth", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "tool.invoke",
        request: { toolName: "shell.exec" },
        createdAt: "2020-04-10T23:59:00.000Z",
        resolutionStatus: "pending",
      },
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator-a",
      }),
    ).rejects.toMatchObject({ mutationCommitted: true });
    await expect(
      resolveApproval(host, "approval-1", {
        decision: "reject",
        resolvedBy: "operator-b",
      }),
    ).rejects.toThrow(/already resolved/i);

    expect(host.storage.approvals.resolve).toHaveBeenCalledTimes(2);
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledTimes(1);
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledTimes(1);
    expect(host.enqueueApprovalObservabilityEffects).toHaveBeenCalledTimes(1);
  });

  it("sweeps expired approvals from the always-running effect worker without a list or resolve request", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "tool.invoke",
        request: { toolName: "shell.exec" },
        createdAt: "2020-04-10T23:59:00.000Z",
        resolutionStatus: "pending",
      },
    });
    host.storage.approvals.listExpiredPending = vi.fn(() => {
      const current = host.storage.approvals.get("approval-1");
      return current.status === "pending" ? [current] : [];
    });
    const effectRows: ApprovalEffectRecord[] = [];
    const getEffect = (effectId: string) => {
      const effect = effectRows.find((candidate) => candidate.effectId === effectId);
      if (!effect) {
        throw new Error(`Missing effect ${effectId}`);
      }
      return effect;
    };
    host.storage.approvalEffects = {
      upsert: vi.fn((input: Record<string, unknown>) => {
        const idempotencyKey = `${String(input.approvalId)}:${String(input.effectKind)}:${String(input.targetKind)}:${String(input.targetId)}`;
        const existing = effectRows.find((effect) => effect.idempotencyKey === idempotencyKey);
        if (existing) {
          return existing;
        }
        const created: ApprovalEffectRecord = {
          effectId: `effect-${effectRows.length + 1}`,
          approvalId: String(input.approvalId),
          effectKind: input.effectKind as ApprovalEffectRecord["effectKind"],
          targetKind: input.targetKind as ApprovalEffectRecord["targetKind"],
          targetId: String(input.targetId),
          idempotencyKey,
          status: "pending",
          attemptCount: 0,
          payload: (input.payload as Record<string, unknown>) ?? {},
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        };
        effectRows.push(created);
        return created;
      }),
      listByApproval: vi.fn((approvalId: string) => effectRows.filter((effect) => effect.approvalId === approvalId)),
      claimNextPendingEffect: vi.fn((workerId: string, claimedAt: string, leaseExpiresAt: string) => {
        const effect = effectRows.find((candidate) => candidate.status === "pending");
        if (!effect) {
          return undefined;
        }
        Object.assign(effect, {
          status: "running",
          attemptCount: effect.attemptCount + 1,
          claimedBy: workerId,
          claimedAt,
          leaseExpiresAt,
          version: effect.version + 1,
          updatedAt: claimedAt,
        });
        return { ...effect };
      }),
      get: vi.fn((effectId: string) => getEffect(effectId)),
      completeEffect: vi.fn(
        (effectId: string, _workerId: string, _version: number, patch: { result?: Record<string, unknown> }) => {
          const effect = getEffect(effectId);
          Object.assign(effect, {
            status: "completed",
            result: patch.result ?? effect.result,
            version: effect.version + 1,
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          return effect;
        },
      ),
      skipEffect: vi.fn(
        (effectId: string, _workerId: string, _version: number, patch: { result?: Record<string, unknown> }) => {
          const effect = getEffect(effectId);
          Object.assign(effect, { status: "skipped", result: patch.result ?? effect.result });
          return effect;
        },
      ),
      failEffect: vi.fn(
        (effectId: string, _workerId: string, _version: number, patch: { result?: Record<string, unknown> }) => {
          const effect = getEffect(effectId);
          Object.assign(effect, { status: "failed", result: patch.result ?? effect.result });
          return effect;
        },
      ),
    } as never;
    const markWaitResolved = vi.fn();
    host.storage.approvalWaitRuns = {
      getRunId: vi.fn(() => "approval-wait-1"),
      markResolved: markWaitResolved,
    } as never;
    host.wakeDurableRun = vi.fn(() => ({
      runId: "approval-wait-1",
      eventKey: "approval.resolved",
      correlationId: "approval-1",
      outcome: "woke",
    }));
    const requestRunProcessing = vi.fn();
    const backgroundTasks = new Set<Promise<void>>();
    const effectsService = new ApprovalEffectsService(
      {
        storage: host.storage as never,
        publishRealtime: host.publishRealtime,
      },
      {
        backgroundTasks,
        wakeDurableRun: host.wakeDurableRun,
        requestRunProcessing,
        findProactiveDurableRunIdsForApproval: host.findProactiveDurableRunIdsForApproval,
        executeCodeModePendingApproval: host.executeCodeModePendingApproval,
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: host.hooksService.enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: host.resolveApprovalHookWorkspaceId,
        recordApprovalResolutionSignals: vi.fn(),
        reconcileExpiredApprovals: (limit) => expirePendingApprovals(host, limit),
      },
    );
    host.enqueueApprovalResolutionEffects = vi.fn((approval, input, options) =>
      effectsService.enqueueResolutionEffects(approval, input, options),
    );

    effectsService.startWorker();
    try {
      await vi.waitFor(() => {
        expect(host.wakeDurableRun).toHaveBeenCalledWith(
          "approval-wait-1",
          expect.objectContaining({ eventKey: "approval.resolved" }),
        );
      });
    } finally {
      effectsService.stopWorker();
      await Promise.allSettled([...backgroundTasks]);
    }

    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "rejected",
      expect.objectContaining({ expired: true }),
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ decision: "reject" }),
      { allowExpired: true },
    );
    expect(markWaitResolved).toHaveBeenCalledWith("approval-1", expect.any(String));
    expect(requestRunProcessing).toHaveBeenCalledWith("approval-wait-1");
    expect(effectRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ effectKind: "approval_wait_wake", status: "completed" })]),
    );
  });

  it("continues the expiry sweep after one candidate fails and reports the first failure", () => {
    const host = createApprovalHarness({ expiresAt: "2020-04-11T00:00:00.000Z" });
    const candidate = host.storage.approvals.get("approval-1");
    host.storage.approvals.listExpiredPending = vi.fn(() => [
      { ...candidate, approvalId: "approval-poison" },
      candidate,
    ]);
    const transactionImplementation = host.storage.runImmediateTransaction.getMockImplementation()!;
    host.storage.runImmediateTransaction
      .mockImplementationOnce(() => {
        throw new Error("poison approval transaction");
      })
      .mockImplementation(transactionImplementation);

    expect(() => expirePendingApprovals(host, 10)).toThrow("poison approval transaction");

    expect(host.storage.runImmediateTransaction).toHaveBeenCalledTimes(2);
    expect(host.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({ decision: "reject", resolvedBy: "system:approval-expiry" }),
      expect.objectContaining({ allowExpired: true }),
    );
  });

  it("rechecks approval expiry inside the winning transaction", async () => {
    const host = createApprovalHarness({
      expiresAt: "2099-04-11T00:00:00.000Z",
    });
    host.storage.approvals.isExpiredPendingAtDatabaseNow.mockReturnValue(true);
    host.storage.approvals.resolve.mockImplementationOnce(() => {
      throw new ConflictError({
        message: "Approval approval-1 has expired and can no longer be resolved",
        details: { reason: "approval_expired", approvalId: "approval-1" },
      });
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.runImmediateTransaction).toHaveBeenCalledTimes(2);
    expect(host.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({ decision: "reject", resolvedBy: "system:approval-expiry" }),
      expect.objectContaining({ allowExpired: true }),
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ decision: "reject" }),
      { allowExpired: true },
    );
  });

  it("commits system expiry when the database CAS reaches the boundary during resolution", async () => {
    const host = createApprovalHarness({ expiresAt: "2099-04-11T00:00:01.000Z" });
    host.storage.approvals.isExpiredPendingAtDatabaseNow.mockReturnValue(true);
    host.storage.approvals.resolve.mockImplementationOnce(() => {
      throw new ConflictError({
        message: "Approval approval-1 has expired and can no longer be resolved",
        details: { reason: "approval_expired", approvalId: "approval-1" },
      });
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toMatchObject({
      mutationCommitted: true,
      message: expect.stringMatching(/has expired and can no longer be resolved/i),
    });
    expect(host.storage.approvals.resolve).toHaveBeenLastCalledWith(
      "approval-1",
      expect.objectContaining({ decision: "reject", resolvedBy: "system:approval-expiry" }),
      expect.objectContaining({ allowExpired: true }),
    );
  });

  it("does not mask unrelated resolution conflicts as expiry reconciliation", async () => {
    const host = createApprovalHarness({ expiresAt: "2020-04-11T00:00:00.000Z" });
    host.storage.approvals.resolve.mockImplementationOnce(() => {
      throw new ConflictError({ message: "downstream resolution effect conflict" });
    });

    await expect(resolveApproval(host, "approval-1", { decision: "approve", resolvedBy: "operator" })).rejects.toThrow(
      "downstream resolution effect conflict",
    );
    expect(host.storage.approvals.resolve).toHaveBeenCalledTimes(1);
  });

  it("marks linked Code Mode runs rejected when approval is rejected", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-1" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord(),
    });

    await resolveApproval(host, "approval-1", {
      decision: "reject",
      resolvedBy: "operator",
    });

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-1",
        status: "rejected",
        error: "Approval approval-1 resolved with reject.",
      }),
    );
  });

  it("rejects edit decisions for immutable Code Mode approvals", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-1" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord(),
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "edit",
        resolvedBy: "operator",
        editedPayload: { source: "return { edited: true };" },
      }),
    ).rejects.toThrow(/Code Mode approvals are immutable/);

    expect(host.storage.approvals.resolve).not.toHaveBeenCalled();
    expect(host.storage.codeModeRuns.upsert).not.toHaveBeenCalled();
    expect(host.storage.chatInlineApprovals.upsert).not.toHaveBeenCalled();
  });

  it("marks linked Code Mode runs expired when approval expires", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-1" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord(),
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toMatchObject({
      mutationCommitted: true,
      message: expect.stringMatching(/has expired and can no longer be resolved/i),
    });

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-1",
        status: "expired",
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        status: "expired",
        runId: "code-run-1",
      }),
    );
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          status: "expired",
          runId: "code-run-1",
        }),
      }),
    );
  });

  it("does not expire already-approved Code Mode runs on a duplicate stale resolve", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      approvalStatus: "approved",
      resolvedAt: "2026-04-11T00:01:00.000Z",
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-1" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord(),
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/already resolved/i);

    expect(host.storage.codeModeRuns.upsert).not.toHaveBeenCalled();
    expect(host.storage.pendingApprovalActions.markResolved).not.toHaveBeenCalled();
    expect(host.storage.approvalEvents.append).not.toHaveBeenCalled();
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("marks expired Code Mode pending actions failed when the run row is missing", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-missing" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.codeModeRuns.upsert).not.toHaveBeenCalled();
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        status: "expired",
        runId: "code-run-missing",
        runUpdateSkipped: true,
        errorCode: "code_mode_run_missing",
      }),
    );
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "pending_action_refused",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          status: "expired",
          runId: "code-run-missing",
          runUpdateSkipped: true,
          errorCode: "code_mode_run_missing",
        }),
      }),
    );
    expect(host.enqueueApprovalObservabilityEffects).toHaveBeenCalledWith(
      "approval-1",
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "code_mode.expired.realtime:code-run-missing",
          delivery: expect.objectContaining({
            kind: "realtime",
            eventType: "code_mode_run_failed",
            payload: expect.objectContaining({
              approvalId: "approval-1",
              status: "expired",
              errorCode: "code_mode_run_missing",
              runId: "code-run-missing",
            }),
            options: expect.objectContaining({
              eventClass: "domain_fact",
              eventAuthority: "durable_history",
              links: expect.objectContaining({
                approvalId: "approval-1",
                runId: "code-run-missing",
              }),
            }),
          }),
        }),
      ]),
    );
  });

  it("uses approval linkage when rejecting Code Mode approvals with corrupt pending run ids", async () => {
    const linkedRun = createCodeModeRunRecord({ runId: "code-run-linked", approvalId: "approval-1" });
    const unrelatedRun = createCodeModeRunRecord({ runId: "code-run-other", approvalId: "approval-other" });
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-other" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRuns: [linkedRun, unrelatedRun],
    });

    await resolveApproval(host, "approval-1", {
      decision: "reject",
      resolvedBy: "operator",
    });

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-linked",
        status: "rejected",
        errorDetails: expect.objectContaining({
          pendingRunId: "code-run-other",
        }),
      }),
    );
    expect(host.storage.codeModeRuns.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-other",
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "rejected",
      expect.objectContaining({
        runId: "code-run-linked",
        pendingRunId: "code-run-other",
      }),
    );
  });

  it("uses approval linkage when rejecting Code Mode approvals with missing pending run ids", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: {},
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord({ runId: "code-run-linked" }),
    });

    await resolveApproval(host, "approval-1", {
      decision: "reject",
      resolvedBy: "operator",
    });

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-linked",
        status: "rejected",
        errorDetails: expect.objectContaining({
          pendingRunId: null,
        }),
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "rejected",
      expect.objectContaining({
        runId: "code-run-linked",
        pendingRunId: null,
      }),
    );
  });

  it("uses approval linkage when expiring Code Mode approvals with missing pending run ids", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: {},
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord({ runId: "code-run-linked" }),
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-linked",
        status: "expired",
        errorDetails: expect.objectContaining({
          pendingRunId: null,
        }),
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        status: "expired",
        runId: "code-run-linked",
        pendingRunId: null,
      }),
    );
  });

  it("uses approval linkage when expiring Code Mode approvals with corrupt pending run ids", async () => {
    const linkedRun = createCodeModeRunRecord({ runId: "code-run-linked", approvalId: "approval-1" });
    const unrelatedRun = createCodeModeRunRecord({ runId: "code-run-other", approvalId: "approval-other" });
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-other" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRuns: [linkedRun, unrelatedRun],
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-linked",
        status: "expired",
        errorDetails: expect.objectContaining({
          pendingRunId: "code-run-other",
        }),
      }),
    );
    expect(host.storage.codeModeRuns.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-other",
      }),
    );
  });

  it("resolves remote-token approvals through the approval host with connector linkage", async () => {
    const host = createApprovalHarness();
    const callOrder: string[] = [];
    host.storage.audit.append = vi.fn(async () => {
      callOrder.push("audit-start");
      await Promise.resolve();
      callOrder.push("audit-finish");
    });
    host.resolveApproval.mockImplementation(async () => {
      callOrder.push("resolve");
      return {
        approval: {
          ...host.storage.approvals.get("approval-1"),
          status: "approved",
        },
        effects: [],
        replay: {
          approval: host.storage.approvals.get("approval-1"),
          events: [],
          pendingAction: undefined,
          effects: [],
        },
        resolutionEffects: {
          proactiveRunIds: [],
        },
      };
    });

    await resolveApprovalWithConsumedRemoteToken(
      host,
      {
        tokenId: "token-1",
        connectorId: "connector-1",
        approvalId: "approval-1",
      },
      {
        decision: "approve",
        editedPayload: {
          shellCommand: "pwd",
        },
        resolutionNote: "approved remotely",
      },
    );

    expect(host.storage.audit.append).not.toHaveBeenCalled();
    expect(host.enqueueApprovalObservabilityEffects).toHaveBeenCalledWith(
      "approval-1",
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "approval.remote_token.consume.audit:token-1",
          delivery: expect.objectContaining({
            kind: "audit",
            payload: expect.objectContaining({
              connectorId: "connector-1",
              tokenId: "token-1",
            }),
          }),
        }),
      ]),
    );
    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "approve",
        editedPayload: {
          shellCommand: "pwd",
        },
        resolutionNote: "approved remotely",
        resolvedBy: "connector:connector-1",
      }),
      {
        remoteToken: {
          connectorId: "connector-1",
          tokenId: "token-1",
        },
      },
    );
    expect(callOrder).toEqual(["resolve"]);
  });

  it("replays the canonical result for an identical consumed-token retry without resolving twice", async () => {
    const host = createApprovalHarness();
    host.resolveApproval = vi.fn((approvalId, input, context) => resolveApproval(host, approvalId, input, context));
    const tokenRecord = {
      tokenId: "token-retry-1",
      connectorId: "connector-1",
      approvalId: "approval-1",
    };
    const input = {
      decision: "approve" as const,
      resolutionNote: "approved remotely",
    };

    const first = await resolveApprovalWithConsumedRemoteToken(host, tokenRecord, input);
    const replay = await resolveApprovalWithConsumedRemoteToken(host, tokenRecord, input);

    expect(first.approval.status).toBe("approved");
    expect(replay.approval.status).toBe("approved");
    expect(host.resolveApproval).toHaveBeenCalledTimes(1);
    expect(host.storage.approvalEvents.append).toHaveBeenCalledTimes(1);
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledTimes(1);

    await expect(
      resolveApprovalWithConsumedRemoteToken(host, tokenRecord, {
        decision: "reject",
      }),
    ).rejects.toThrow(/already resolved as approved, not rejected/i);
  });

  it("rejects same-decision replay when another actor or token won the approval", async () => {
    const host = createApprovalHarness({
      approvalStatus: "approved",
      resolvedAt: "2026-04-11T00:01:00.000Z",
    });

    await expect(
      resolveApprovalWithConsumedRemoteToken(
        host,
        {
          tokenId: "token-loser",
          connectorId: "connector-1",
          approvalId: "approval-1",
        },
        {
          decision: "approve",
          editedPayload: { command: "different request" },
        },
      ),
    ).rejects.toThrow(/different actor or remote token/i);
    expect(host.resolveApproval).not.toHaveBeenCalled();
  });

  it("terminalizes expired remote-token approvals without executing the requested decision", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });
    host.resolveApproval = vi.fn((approvalId, input) => resolveApproval(host, approvalId, input));

    await expect(
      resolveApprovalWithConsumedRemoteToken(
        host,
        {
          tokenId: "token-1",
          connectorId: "connector-1",
          approvalId: "approval-1",
        },
        {
          decision: "approve",
        },
      ),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({ decision: "reject", resolvedBy: "system:approval-expiry" }),
      expect.objectContaining({ allowExpired: true }),
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ decision: "reject" }),
      { allowExpired: true },
    );
  });

  it("reports expired approvals as committed failures in bulk resolution while enqueueing recovery", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });
    host.resolveApproval = vi.fn((approvalId, input) => resolveApproval(host, approvalId, input));
    host.storage.approvals.list = vi.fn(() => [host.storage.approvals.get("approval-1")]);

    const result = await resolveApprovalsBulk(host, {
      decision: "approve",
      resolvedBy: "operator",
    });

    expect(result.items).toEqual([
      {
        approvalId: "approval-1",
        outcome: "failed",
        error: expect.stringMatching(/has expired and can no longer be resolved/i),
      },
    ]);
    expect(host.storage.approvals.resolve).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({ decision: "reject", resolvedBy: "system:approval-expiry" }),
      expect.objectContaining({ allowExpired: true }),
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ decision: "reject" }),
      { allowExpired: true },
    );
  });

  it("resolves approvals through effect enqueue and durable-run wake processing", async () => {
    const effectRows: Array<Record<string, unknown>> = [];
    const requestRunProcessing = vi.fn();
    const host = createApprovalHarness();
    const approvalEffectsStorage = {
      upsert: vi.fn((input: Record<string, unknown>) => {
        const row = {
          effectId: `effect-${effectRows.length + 1}`,
          approvalId: String(input.approvalId),
          effectKind: input.effectKind,
          targetKind: input.targetKind,
          targetId: String(input.targetId),
          idempotencyKey: `${input.approvalId}:${input.effectKind}:${input.targetId}`,
          status: "pending",
          attemptCount: 0,
          payload: (input.payload as Record<string, unknown>) ?? {},
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        };
        effectRows.push(row);
        return row;
      }),
      listByApproval: vi.fn((approvalId: string) => effectRows.filter((row) => row.approvalId === approvalId)),
      completeEffect: vi.fn((effectId: string, _workerId: string, _version: number, patch: Record<string, unknown>) => {
        const row = effectRows.find((candidate) => candidate.effectId === effectId);
        if (!row) {
          return undefined;
        }
        Object.assign(row, {
          status: "completed",
          result: patch.result ?? row.result,
          updatedAt: "2026-04-11T00:01:00.000Z",
        });
        return row;
      }),
      failEffect: vi.fn(),
      skipEffect: vi.fn(),
      get: vi.fn((effectId: string) => effectRows.find((candidate) => candidate.effectId === effectId)),
      claimNextPendingEffect: vi.fn(),
    };
    host.storage.approvalEffects = approvalEffectsStorage as never;
    host.storage.approvalWaitRuns = {
      getRunId: vi.fn(() => "approval-wait-1"),
      markResolved: vi.fn(),
    } as never;
    host.storage.pendingApprovalActions.find = vi.fn(() => undefined);
    host.storage.approvalInbox.findByApprovalAndToken = vi.fn(() => undefined);
    host.storage.chatInlineApprovals.get = vi.fn(() => undefined);
    host.findProactiveDurableRunIdsForApproval = vi.fn(() => []);
    host.wakeDurableRun = vi.fn(() => ({
      runId: "approval-wait-1",
      eventKey: "approval.resolved",
      outcome: "woke",
    }));

    const effectsService = new ApprovalEffectsService(
      {
        storage: host.storage as never,
        publishRealtime: host.publishRealtime,
      } as never,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: host.wakeDurableRun,
        requestRunProcessing,
        findProactiveDurableRunIdsForApproval: host.findProactiveDurableRunIdsForApproval,
        executeCodeModePendingApproval: host.executeCodeModePendingApproval,
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: host.hooksService.enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: host.resolveApprovalHookWorkspaceId,
        recordApprovalResolutionSignals: vi.fn(),
      },
    );
    host.enqueueApprovalResolutionEffects = vi.fn((approval, input) =>
      effectsService.enqueueResolutionEffects(approval, input),
    );

    const result = await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator",
    });

    const wakeEffect = effectRows.find((row) => row.effectKind === "approval_wait_wake");
    expect(wakeEffect).toBeDefined();
    expect(result.resolutionEffects.approvalWaitDurableRunId).toBe("approval-wait-1");

    await (
      effectsService as unknown as {
        handleWakeEffect(effect: Record<string, unknown>, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(wakeEffect as Record<string, unknown>, true);

    expect(host.wakeDurableRun).toHaveBeenCalledWith(
      "approval-wait-1",
      expect.objectContaining({
        eventKey: "approval.resolved",
      }),
    );
    expect(host.storage.approvalWaitRuns.markResolved).toHaveBeenCalled();
    expect(requestRunProcessing).toHaveBeenCalledWith("approval-wait-1");
    expect(approvalEffectsStorage.completeEffect).toHaveBeenCalled();
  });

  it("refreshes the approval response from explicitly settled post-commit effects", async () => {
    const host = createApprovalHarness();
    const settledEffect: ApprovalEffectRecord = {
      effectId: "effect-linked-wake",
      approvalId: "approval-1",
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "turn-1",
      idempotencyKey: "approval-1:linked_chat_turn_wake:chat_turn:turn-1",
      status: "completed",
      attemptCount: 1,
      payload: { runId: "durable-turn-1" },
      result: {
        outcome: "woke",
        turnId: "turn-1",
        runId: "durable-turn-1",
      },
      version: 2,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:01:00.000Z",
      completedAt: "2026-04-11T00:01:00.000Z",
    };
    host.awaitApprovalResolutionEffects = vi.fn(async () => [settledEffect]);

    const result = await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator",
    });

    expect(host.awaitApprovalResolutionEffects).toHaveBeenCalledWith("approval-1");
    expect(result.resolutionEffects?.chatTurnResume).toEqual({
      resumed: true,
      turnId: "turn-1",
      durableRunId: "durable-turn-1",
      wakeOutcome: "woke",
    });
  });

  it("enqueues wait-run and linked-turn recovery when a generic approval expires", async () => {
    const effectRows: Array<Record<string, unknown>> = [];
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });
    const getRunId = vi.fn(() => "approval-wait-1");
    host.storage.approvalWaitRuns = {
      getRunId,
      markResolved: vi.fn(),
    } as never;
    host.storage.approvals.mergeLinkage("approval-1", { turnId: "turn-1" });
    host.storage.approvalEffects = {
      upsert: vi.fn((input: Record<string, unknown>) => {
        const effect = {
          effectId: `effect-${effectRows.length + 1}`,
          status: "pending",
          attemptCount: 0,
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
          ...input,
        };
        effectRows.push(effect);
        return effect;
      }),
      listByApproval: vi.fn(() => effectRows),
      completeEffect: vi.fn(),
      failEffect: vi.fn(),
      skipEffect: vi.fn(),
      get: vi.fn(),
      claimNextPendingEffect: vi.fn(),
    } as never;
    const effectsService = new ApprovalEffectsService(
      {
        storage: host.storage as never,
        publishRealtime: host.publishRealtime,
      } as never,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: host.wakeDurableRun,
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: host.findProactiveDurableRunIdsForApproval,
        executeCodeModePendingApproval: host.executeCodeModePendingApproval,
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: host.hooksService.enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: host.resolveApprovalHookWorkspaceId,
        recordApprovalResolutionSignals: vi.fn(),
      },
    );
    host.enqueueApprovalResolutionEffects = vi.fn((approval, input, options) =>
      effectsService.enqueueResolutionEffects(approval, input, options),
    );

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(effectRows.map((effect) => effect.effectKind)).toEqual(
      expect.arrayContaining([
        "approval_resolution_signals",
        "approval_wait_wake",
        "linked_chat_turn_wake",
        "approval_after_hooks",
      ]),
    );
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ decision: "reject", resolvedBy: "system:approval-expiry" }),
      { allowExpired: true },
    );
    expect(getRunId).toHaveBeenCalledWith("approval-1");
    expect(host.wakeDurableRun).not.toHaveBeenCalled();
  });

  it("marks chat inline approvals resolved when the generic approval route is used", async () => {
    const host = createApprovalHarness();
    host.storage.chatInlineApprovals.get = vi.fn(() => ({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "tool_call",
      toolName: "shell.exec",
      status: "pending",
      reason: "Needs approval",
      riskLevel: "danger",
      details: {
        command: "pwd",
      },
      expiresAt: "2026-04-11T00:05:00.000Z",
      createdAt: "2026-04-11T00:00:00.000Z",
    }));
    host.storage.chatInlineApprovals.upsert = vi.fn();

    await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator-test",
      resolutionNote: "Approved from approvals queue.",
    });

    expect(host.storage.chatInlineApprovals.upsert).toHaveBeenCalledWith({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "tool_call",
      toolName: "shell.exec",
      status: "approved",
      reason: "Approved from approvals queue.",
      riskLevel: "danger",
      details: {
        command: "pwd",
        decision: "approve",
      },
      expiresAt: "2026-04-11T00:05:00.000Z",
      resolvedBy: "operator-test",
    });
  });

  it("uses the shared approval resolution wake result instead of double-waking the linked turn", async () => {
    const approval = {
      approvalId: "approval-1",
      kind: "shell.exec",
      riskLevel: "danger",
      status: "pending",
      payload: {
        sessionId: "session-1",
      },
      preview: {},
      createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
      explanationStatus: "not_requested",
    };
    const resolvedApproval = {
      ...approval,
      status: "approved" as const,
      resolvedBy: "operator-test",
      resolvedAt: new Date("2026-04-09T12:00:02.000Z").toISOString(),
    };

    const host = {
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
        chatInlineApprovals: {
          get: vi.fn(() => ({
            approvalId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "shell.exec",
            status: "pending",
            reason: "Needs approval",
            createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
            updatedAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
            details: {},
          })),
          upsert: vi.fn(),
        },
        chatToolRuns: {
          listBySession: vi.fn(() => []),
        },
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: "turn-1",
            sessionId: "session-1",
            status: "waiting_for_approval",
            durable: {
              runId: "durable-turn-1",
            },
          })),
        },
      },
      policyEngine: {
        listGrants: vi.fn(() => []),
        listActiveGrants: vi.fn(() => []),
        createGrant: vi.fn(),
      },
      resolveApproval: vi.fn(async () => ({
        approval: resolvedApproval,
        effects: [],
        replay: {
          approval: resolvedApproval,
          events: [],
          pendingAction: undefined,
          effects: [],
        },
        durableRunId: "approval-wait-1",
        resolutionEffects: {
          approvalWaitDurableRunId: "approval-wait-1",
          proactiveRunIds: [],
          chatTurnResume: {
            resumed: true,
            turnId: "turn-1",
            durableRunId: "durable-turn-1",
          },
        },
      })),
    } as unknown as ApprovalLifecycleHost;

    const result = await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "once",
      resolvedBy: "operator-test",
    });

    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "approve",
        resolvedBy: "operator-test",
      }),
    );
    expect(result).toMatchObject({
      allowScope: "once",
      resumed: true,
      resumedTurnId: "turn-1",
      resumedRunId: "durable-turn-1",
    });
  });

  it("coerces Code Mode chat approval scopes to once without creating persistent grants", async () => {
    const approval = {
      approvalId: "approval-code",
      kind: "code_mode.run",
      riskLevel: "caution",
      status: "pending",
      payload: {
        sessionId: "session-1",
        codeHash: "code-hash",
        wrapperManifestHash: "wrapper-hash",
        capabilitySnapshotId: "capability-snapshot",
      },
      preview: {},
      createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
      explanationStatus: "not_requested",
    };
    const resolvedApproval = {
      ...approval,
      status: "approved" as const,
      resolvedBy: "operator-test",
      resolvedAt: new Date("2026-04-09T12:00:02.000Z").toISOString(),
    };
    const createGrant = vi.fn();
    const host = {
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
        chatInlineApprovals: {
          get: vi.fn(() => ({
            approvalId: "approval-code",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: "code_mode.run",
            toolName: "code_mode.run",
            status: "pending",
            reason: "Needs approval",
            createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
            details: {},
          })),
          upsert: vi.fn(),
        },
        chatToolRuns: {
          listBySession: vi.fn(() => []),
        },
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
      },
      policyEngine: {
        listGrants: vi.fn(() => []),
        listActiveGrants: vi.fn(() => []),
        createGrant,
      },
      publishRealtime: vi.fn(),
      resolveApproval: vi.fn(async () => ({
        approval: resolvedApproval,
        effects: [],
        replay: {
          approval: resolvedApproval,
          events: [],
          pendingAction: undefined,
          effects: [],
        },
        resolutionEffects: {
          proactiveRunIds: [],
          chatTurnResume: { resumed: false },
        },
      })),
    } as unknown as ApprovalLifecycleHost;

    const result = await resolveChatToolApproval(host, "session-1", "approval-code", "approve", {
      allowScope: "workspace",
      resolvedBy: "operator-test",
    });

    expect(result.allowScope).toBe("once");
    expect(createGrant).not.toHaveBeenCalled();
    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-code",
      expect.objectContaining({
        decision: "approve",
        resolutionNote: "Approved from chat inline control.",
      }),
    );
  });

  it("keeps committed parent session grants when inline detail projection fails", async () => {
    const approval: ApprovalRequest = {
      approvalId: "approval-child",
      kind: "browser.search",
      riskLevel: "caution",
      status: "pending",
      payload: {
        sessionId: "child-session",
      },
      preview: {},
      linkage: {
        sessionId: "child-session",
        workspaceId: "workspace-1",
      },
      createdAt: "2026-04-09T12:00:00.000Z",
      explanationStatus: "not_requested",
    };
    const callOrder: string[] = [];
    const createGrant = vi.fn((input: ToolGrantCreateInput) => {
      callOrder.push(`grant:${input.scopeRef}`);
      return {
        grantId: `grant-${input.scopeRef}`,
        ...input,
        grantType: input.grantType ?? "persistent",
        createdAt: "2026-04-09T12:00:01.000Z",
      };
    });
    const host = {
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
        chatInlineApprovals: {
          get: vi.fn(() => ({
            approvalId: "approval-child",
            sessionId: "child-session",
            turnId: "child-turn",
            toolName: "browser.search",
            status: "pending",
            reason: "Needs approval",
            createdAt: "2026-04-09T12:00:00.000Z",
            details: {},
          })),
          upsert: vi.fn(() => {
            throw new Error("inline projection unavailable");
          }),
        },
        chatDelegationSteps: {
          listParentsByChildSessionIds: vi.fn(
            () =>
              new Map([
                [
                  "child-session",
                  {
                    parentSessionId: "parent-session",
                    runId: "delegation-run",
                    stepId: "worker",
                    role: "worker",
                    index: 1,
                  },
                ],
              ]),
          ),
        },
        chatToolRuns: {
          listBySession: vi.fn(() => []),
        },
      },
      policyEngine: {
        listGrants: vi.fn(() => []),
        listActiveGrants: vi.fn(() => []),
        createGrant,
      },
      publishRealtime: vi.fn(),
      resolveApproval: vi.fn(async () => {
        callOrder.push("resolve");
        return {
          approval: { ...approval, status: "approved" as const },
          effects: [],
          replay: {
            approval: { ...approval, status: "approved" as const },
            events: [],
            pendingAction: undefined,
            effects: [],
          },
          resolutionEffects: {
            proactiveRunIds: [],
            chatTurnResume: { resumed: false },
          },
        };
      }),
    } as unknown as ApprovalLifecycleHost;

    const result = await resolveChatToolApproval(host, "child-session", "approval-child", "approve", {
      allowScope: "session",
      resolvedBy: "operator-test",
    });

    expect(result.allowScope).toBe("session");
    expect(createGrant.mock.calls.map(([input]) => [input.scope, input.scopeRef, input.toolPattern])).toEqual([
      ["session", "child-session", "browser.search"],
      ["session", "parent-session", "browser.search"],
    ]);
    expect(callOrder).toEqual(["resolve", "grant:child-session", "grant:parent-session"]);
    expect(host.storage.chatDelegationSteps.listParentsByChildSessionIds).toHaveBeenCalledWith(
      ["child-session"],
      "workspace-1",
    );
    expect(host.storage.chatInlineApprovals.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-child",
        sessionId: "child-session",
        details: expect.objectContaining({
          allowScope: "session",
          grantScopeRef: "child-session",
        }),
      }),
    );
  });

  it("rejects expired chat tool approvals before creating persistent grants", async () => {
    const approval = {
      approvalId: "approval-1",
      kind: "shell.exec",
      riskLevel: "danger" as const,
      status: "pending" as const,
      payload: {
        sessionId: "session-1",
      },
      preview: {},
      createdAt: "2020-04-09T12:00:00.000Z",
      expiresAt: "2020-04-09T12:01:00.000Z",
      explanationStatus: "not_requested" as const,
    };
    const createGrant = vi.fn();
    const host = {
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
        chatInlineApprovals: {
          get: vi.fn(() => ({
            approvalId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "shell.exec",
            status: "pending",
            reason: "Needs approval",
            createdAt: "2020-04-09T12:00:00.000Z",
            details: {},
          })),
          upsert: vi.fn(),
        },
        chatToolRuns: {
          listBySession: vi.fn(() => []),
        },
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
      },
      policyEngine: {
        listGrants: vi.fn(() => []),
        listActiveGrants: vi.fn(() => []),
        createGrant,
      },
      resolveApproval: vi.fn(async () => {
        throw new Error("Approval approval-1 has expired and can no longer be resolved.");
      }),
    } as unknown as ApprovalLifecycleHost;

    await expect(
      resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
        allowScope: "workspace",
        resolvedBy: "operator-test",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(createGrant).not.toHaveBeenCalled();
    expect(host.resolveApproval).toHaveBeenCalledTimes(1);
  });

  it("terminalizes expired Code Mode chat approvals before creating persistent grants", async () => {
    const pendingAction = {
      approvalId: "approval-1",
      actionType: "code_mode.run",
      request: { runId: "code-run-1" },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "pending",
    };
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction,
      codeModeRun: createCodeModeRunRecord(),
    });
    host.storage.chatInlineApprovals.get = vi.fn(() => ({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "code_mode.run",
      toolName: "code_mode.run",
      status: "pending",
      reason: "Needs approval",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      details: {},
    }));
    host.storage.chatToolRuns.listBySession = vi.fn(() => [
      {
        toolRunId: "tool-run-code",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "code_mode.run",
      },
    ]) as never;
    host.resolveApproval = vi.fn((approvalId, input, context) => resolveApproval(host, approvalId, input, context));

    await expect(
      resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
        allowScope: "workspace",
        resolvedBy: "operator-test",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-1",
        status: "expired",
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        status: "expired",
        runId: "code-run-1",
      }),
    );
    expect(host.policyEngine.createGrant).not.toHaveBeenCalled();
    expect(host.resolveApproval).toHaveBeenCalledTimes(1);
    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "approve",
        resolvedBy: "operator-test",
      }),
    );
  });

  it("resumes an approval-blocked chat turn end to end and keeps duplicate wake processing idempotent", async () => {
    const backgroundTasks = new Set<Promise<void>>();
    const requestRunProcessing = vi.fn();
    const markResolved = vi.fn();
    const executeApprovedPendingAction = vi.fn(async () => ({
      outcome: "executed" as const,
      policyReason: "approved",
      auditEventId: "audit-1",
      result: { ok: true },
    }));
    const effectRows: ApprovalEffectRecord[] = [];
    let pendingAction = {
      approvalId: "approval-1",
      actionType: "tool.invoke",
      request: {
        toolName: "shell.exec",
        args: {
          command: "pwd",
        },
      },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "pending",
      result: undefined as Record<string, unknown> | undefined,
    };
    const runStates = new Map<
      string,
      {
        workflowKey: string;
        status: "waiting" | "queued" | "completed";
        version: number;
      }
    >([
      ["approval-wait-1", { workflowKey: "approval.wait", status: "waiting", version: 1 }],
      ["durable-turn-1", { workflowKey: "chat.turn.execute", status: "waiting", version: 1 }],
    ]);
    const host = createApprovalHarness({
      pendingAction,
    });
    host.storage.pendingApprovalActions = {
      find: vi.fn(() => pendingAction),
      markResolved: vi.fn((_approvalId: string, resolutionStatus: string, result?: Record<string, unknown>) => {
        pendingAction = {
          ...pendingAction,
          resolutionStatus,
          result,
        };
        return pendingAction;
      }),
    } as never;
    host.storage.approvalWaitRuns = {
      getRunId: vi.fn(() => "approval-wait-1"),
      markResolved,
    } as never;
    host.storage.chatInlineApprovals.get = vi.fn(() => ({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "shell.exec",
      status: "pending",
      reason: "Needs approval",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      details: {},
    }));
    const chatToolRunsPatch = vi.fn();
    host.storage.chatToolRuns = {
      listBySession: vi.fn(() => [
        {
          toolRunId: "tool-run-1",
          turnId: "turn-1",
          approvalId: "approval-1",
          toolName: "shell.exec",
          status: "approval_required",
        },
      ]),
      listByTurn: vi.fn(() => [
        {
          toolRunId: "tool-run-1",
          turnId: "turn-1",
          sessionId: "session-1",
          approvalId: "approval-1",
          toolName: "shell.exec",
          status: "approval_required",
        },
      ]),
      patch: chatToolRunsPatch,
    } as never;
    const chatMessagesUpsert = vi.fn();
    host.storage.chatMessages = {
      upsert: chatMessagesUpsert,
    } as never;
    const chatTurnTracesPatch = vi.fn();
    host.storage.chatTurnTraces.get = vi.fn(() => ({
      turnId: "turn-1",
      sessionId: "session-1",
      status: "waiting_for_approval",
      durable: {
        runId: "durable-turn-1",
      },
    })) as never;
    host.storage.chatTurnTraces.patch = chatTurnTracesPatch as never;
    host.storage.durableRuns = {
      getRun: vi.fn((runId: string) => {
        const current = runStates.get(runId);
        if (!current) {
          throw new Error(`Unknown durable run ${runId}`);
        }
        return {
          runId,
          workflowKey: current.workflowKey,
          status: current.status,
          attemptCount: 0,
          maxAttempts: 3,
          version: current.version,
          payload: {},
          metadata: {},
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
        };
      }),
      updateRun: vi.fn((input: { runId: string; status: "completed"; expectedVersion: number }) => {
        const current = runStates.get(input.runId);
        if (!current || current.version !== input.expectedVersion) {
          throw new Error(`Durable run ${input.runId} version conflict.`);
        }
        const next = {
          ...current,
          status: input.status,
          version: current.version + 1,
        };
        runStates.set(input.runId, next);
        return next;
      }),
      createCheckpoint: vi.fn(),
    } as never;
    host.storage.chatDelegationSteps = {
      listParentsByChildSessionIds: vi.fn(() => new Map()),
    } as never;
    host.storage.approvalEffects = createInMemoryApprovalEffectsStore(effectRows) as never;
    host.wakeDurableRun = vi.fn((runId: string, event: { eventKey: string; correlationId?: string }) => {
      const current = runStates.get(runId);
      if (!current) {
        throw new Error(`Unknown durable run ${runId}`);
      }
      if (current.status === "waiting") {
        const next = {
          ...current,
          status: "queued" as const,
          version: current.version + 1,
        };
        runStates.set(runId, next);
        return {
          runId,
          eventKey: event.eventKey,
          correlationId: event.correlationId,
          outcome: "woke" as const,
          run: {
            runId,
            workflowKey: current.workflowKey,
            status: next.status,
            attemptCount: 0,
            maxAttempts: 3,
            version: next.version,
            payload: {},
            createdAt: "2026-04-11T00:00:00.000Z",
            updatedAt: "2026-04-11T00:01:00.000Z",
          },
        };
      }
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_not_waiting" as const,
        detail: `Durable run ${runId} is ${current.status}.`,
        run: {
          runId,
          workflowKey: current.workflowKey,
          status: current.status,
          attemptCount: 0,
          maxAttempts: 3,
          version: current.version,
          payload: {},
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
        },
      };
    });
    host.resolveApproval = vi.fn((approvalId, input) => resolveApproval(host, approvalId, input));

    const effectsService = new ApprovalEffectsService(
      {
        storage: host.storage as never,
        publishRealtime: host.publishRealtime,
      } as never,
      {
        backgroundTasks,
        wakeDurableRun: host.wakeDurableRun,
        requestRunProcessing,
        findProactiveDurableRunIdsForApproval: host.findProactiveDurableRunIdsForApproval,
        executeCodeModePendingApproval: host.executeCodeModePendingApproval,
        executeApprovedPendingAction,
        enqueueAfterHooks: host.hooksService.enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: host.resolveApprovalHookWorkspaceId,
        recordApprovalResolutionSignals: vi.fn(),
      },
    );
    host.enqueueApprovalResolutionEffects = vi.fn((approval, input) =>
      effectsService.enqueueResolutionEffects(approval, input),
    );
    host.awaitApprovalResolutionEffects = vi.fn((approvalId) => effectsService.awaitResolutionEffects(approvalId));

    const resolution = await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "once",
      resolvedBy: "operator-test",
    });
    await Promise.allSettled([...backgroundTasks]);

    const processedEffects = host.storage.approvalEffects.listByApproval("approval-1");
    const processedSummary = deriveApprovalResolutionEffectsResult(processedEffects);

    expect(resolution).toMatchObject({
      allowScope: "once",
      resumed: false,
      resumedTurnId: "turn-1",
    });
    expect(host.awaitApprovalResolutionEffects).toHaveBeenCalledWith("approval-1");
    expect(markResolved).toHaveBeenCalledTimes(1);
    expect(requestRunProcessing).toHaveBeenCalledTimes(1);
    expect(requestRunProcessing).toHaveBeenNthCalledWith(1, "approval-wait-1");
    expect(executeApprovedPendingAction).toHaveBeenCalledTimes(1);
    expect(pendingAction.resolutionStatus).toBe("executed");
    expect(chatToolRunsPatch).toHaveBeenCalledWith("tool-run-1", expect.objectContaining({ status: "executed" }));
    expect(chatMessagesUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        role: "assistant",
      }),
      expect.any(String),
    );
    expect(chatTurnTracesPatch).toHaveBeenCalledWith("turn-1", expect.objectContaining({ status: "completed" }));
    expect(processedEffects.map((effect) => [effect.effectKind, effect.status])).toEqual([
      ["approval_resolution_signals", "completed"],
      ["pending_action_execute", "completed"],
      ["approval_wait_wake", "completed"],
      ["linked_chat_turn_wake", "skipped"],
      ["approval_after_hooks", "completed"],
    ]);
    expect(processedSummary).toMatchObject({
      approvalWaitDurableRunId: "approval-wait-1",
      chatTurnResume: {
        resumed: false,
        turnId: "turn-1",
        durableRunId: "durable-turn-1",
        wakeOutcome: "skipped_not_waiting",
      },
    });

    effectsService.enqueueResolutionEffects(host.storage.approvals.get("approval-1"), {
      decision: "approve",
      resolvedBy: "operator-test",
      resolutionNote: "Approved from chat inline control.",
    });
    await Promise.allSettled([...backgroundTasks]);

    expect(host.storage.approvalEffects.listByApproval("approval-1")).toHaveLength(5);
    expect(requestRunProcessing).toHaveBeenCalledTimes(1);
    expect(executeApprovedPendingAction).toHaveBeenCalledTimes(1);
    expect(host.wakeDurableRun).toHaveBeenCalledTimes(2);
  });

  it("does not create an official-search grant for approve-once replay", async () => {
    const host = createOfficialSearchApprovalHarness({ providers: ["brave"] });
    const result = await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "once",
      resolvedBy: "operator-test",
    });
    expect(result.allowScope).toBe("once");
    expect(host.policyEngine.createGrant).not.toHaveBeenCalled();
  });

  it("creates an exact host-constrained session grant from immutable official-search args", async () => {
    const host = createOfficialSearchApprovalHarness({ providers: ["brave"], engine: "parallel" });
    await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "session",
      resolvedBy: "operator-test",
    });
    expect(host.policyEngine.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "browser.search",
        scope: "session",
        scopeRef: "session-1",
        constraints: { allowedHosts: ["api.search.brave.com"] },
      }),
    );
  });

  it.each([
    ["uppercase backend", { backend: "OFFICIAL" }, ["api.search.brave.com"]],
    ["singular engine", { backend: undefined, engine: "parallel" }, ["api.parallel.ai"]],
    ["providers-only", { backend: undefined, providers: ["brave"] }, ["api.search.brave.com"]],
  ] as const)("creates exact official-search grant hosts for %s selection", async (_label, selection, allowedHosts) => {
    const host = createOfficialSearchApprovalHarness(selection as Record<string, unknown>);
    await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "session",
      resolvedBy: "operator-test",
    });
    expect(host.policyEngine.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "browser.search",
        constraints: { allowedHosts: [...allowedHosts] },
      }),
    );
  });

  it("does not misclassify an unrelated persistent approval with a providers array", async () => {
    const host = createApprovalHarness({
      approvalKind: "http.get",
      approvalPayload: { sessionId: "session-1", url: "https://example.com", providers: ["brave"] },
      chatToolName: "http.get",
    });
    const approval = host.storage.approvals.get("approval-1");
    host.resolveApproval.mockResolvedValue({
      approval: { ...approval, status: "approved", resolvedBy: "operator-test" },
      resolutionEffects: { proactiveRunIds: [], chatTurnResume: { resumed: false } },
    } as never);
    await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "session",
      resolvedBy: "operator-test",
    });
    const grantInput = host.policyEngine.createGrant.mock.calls[0]?.[0];
    expect(grantInput).toMatchObject({ toolPattern: "http.get", scope: "session" });
    expect(grantInput).not.toHaveProperty("constraints");
  });

  it("creates one combined exact-host workspace grant for research mode defaults", async () => {
    const host = createOfficialSearchApprovalHarness({ mode: "research" });
    await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "workspace",
      resolvedBy: "operator-test",
    });
    expect(host.policyEngine.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "browser.search",
        scope: "workspace",
        scopeRef: "workspace-1",
        constraints: { allowedHosts: ["api.parallel.ai", "api.search.brave.com"] },
      }),
    );
  });

  it("reuses only an active grant with the exact official-search host set", async () => {
    const host = createOfficialSearchApprovalHarness({ mode: "research" });
    const existing = {
      grantId: "grant-existing",
      toolPattern: "browser.search",
      decision: "allow" as const,
      scope: "workspace" as const,
      scopeRef: "workspace-1",
      grantType: "persistent" as const,
      constraints: { allowedHosts: ["api.search.brave.com", "api.parallel.ai"] },
      createdBy: "operator-test",
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    host.policyEngine.listActiveGrants.mockReturnValue([existing] as never);
    const result = await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "workspace",
      resolvedBy: "operator-test",
    });
    expect(result.grant?.grantId).toBe("grant-existing");
    expect(host.policyEngine.createGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["unconstrained", undefined],
    ["partial", { allowedHosts: ["api.search.brave.com"] }],
    ["extra", { allowedHosts: ["api.search.brave.com", "api.parallel.ai", "example.com"] }],
  ] as const)("does not reuse an %s persistent grant for official-search consent", async (_label, constraints) => {
    const host = createOfficialSearchApprovalHarness({ mode: "research" });
    host.policyEngine.listActiveGrants.mockReturnValue([
      {
        grantId: "grant-wrong",
        toolPattern: "browser.search",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-1",
        grantType: "persistent",
        constraints,
        createdBy: "operator-test",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ] as never);
    await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "workspace",
      resolvedBy: "operator-test",
    });
    expect(host.policyEngine.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({ constraints: { allowedHosts: ["api.parallel.ai", "api.search.brave.com"] } }),
    );
  });
});

function createApprovalHarness(input?: {
  pendingAction?: {
    approvalId: string;
    actionType: string;
    request: Record<string, unknown>;
    createdAt: string;
    resolutionStatus: string;
  };
  approvalEffects?: Array<Record<string, unknown>>;
  expiresAt?: string;
  approvalKind?: string;
  approvalStatus?: ApprovalRequest["status"];
  resolvedAt?: string;
  codeModeRun?: CodeModeRunRecord;
  codeModeRuns?: CodeModeRunRecord[];
  approvalLinkage?: ApprovalRequest["linkage"];
  shellExplainerPolicy?: ApprovalLifecycleHost["shellExplainerPolicy"];
  approvalPayload?: Record<string, unknown>;
  chatToolName?: string;
}) {
  const pendingAction = input?.pendingAction;
  const codeModeRuns = input?.codeModeRuns ?? (input?.codeModeRun ? [input.codeModeRun] : []);
  const linkedCodeModeRunId =
    codeModeRuns.find((run) => run.approvalId === "approval-1")?.runId ??
    (typeof pendingAction?.request.runId === "string" ? pendingAction.request.runId : undefined);
  let approval: ApprovalRequest = {
    approvalId: "approval-1",
    kind: input?.approvalKind ?? "shell.exec",
    riskLevel: "danger" as const,
    status: input?.approvalStatus ?? ("pending" as const),
    payload: input?.approvalPayload ?? {
      sessionId: "session-1",
      ...(linkedCodeModeRunId ? { runId: linkedCodeModeRunId } : {}),
    },
    preview: {},
    linkage:
      input && Object.prototype.hasOwnProperty.call(input, "approvalLinkage")
        ? input.approvalLinkage
        : {
            sessionId: "session-1",
            workspaceId: "workspace-1",
            ...(linkedCodeModeRunId ? { runId: linkedCodeModeRunId } : {}),
          },
    createdAt: "2026-04-11T00:00:00.000Z",
    resolvedAt: input?.resolvedAt,
    expiresAt: input?.expiresAt,
    explanationStatus: "not_requested" as const,
  };
  const databaseNowMs = Date.now();
  const isExpiredPendingAtDatabaseNow = () => {
    const expiresAt = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
    return approval.status === "pending" && Number.isFinite(expiresAt) && expiresAt <= databaseNowMs;
  };

  const approvals = {
    create: vi.fn((request: Record<string, unknown>) => {
      approval = {
        ...approval,
        kind: String(request.kind),
        riskLevel: request.riskLevel as typeof approval.riskLevel,
        payload: request.payload as typeof approval.payload,
        preview: request.preview as typeof approval.preview,
        linkage: request.linkage as typeof approval.linkage,
      };
      return approval;
    }),
    get: vi.fn(() => approval),
    lockPendingForUpdate: vi.fn(() => {
      if (approval.status !== "pending") {
        throw new ConflictError({ message: `Approval ${approval.approvalId} is already resolved` });
      }
      return approval;
    }),
    resolve: vi.fn(
      (
        _approvalId: string,
        request: {
          decision: "approve" | "reject" | "edit";
          resolvedBy: string;
          resolutionNote?: string;
        },
        options?: { resolvedAt?: string; allowExpired?: boolean },
      ) => {
        if (!options?.allowExpired && isExpiredPendingAtDatabaseNow()) {
          throw new ConflictError({
            message: `Approval ${approval.approvalId} has expired and can no longer be resolved`,
            details: { reason: "approval_expired", approvalId: approval.approvalId },
          });
        }
        approval = {
          ...approval,
          status: request.decision === "approve" ? "approved" : request.decision === "reject" ? "rejected" : "edited",
          resolvedBy: request.resolvedBy,
          resolutionNote: request.resolutionNote,
          resolvedAt: options?.resolvedAt ?? "2026-04-11T00:01:00.000Z",
        };
        return approval;
      },
    ),
    mergeLinkage: vi.fn((_approvalId: string, linkage: Record<string, unknown>) => {
      approval = {
        ...approval,
        linkage: {
          ...(approval.linkage ?? {}),
          ...linkage,
        },
      };
      return approval;
    }),
    setShellExplanations: vi.fn((_approvalId: string, explanations: readonly unknown[]) => {
      approval = {
        ...approval,
        shellExplanations: explanations,
      } as ApprovalRequest;
      return true;
    }),
    list: vi.fn(() => []),
    listPage: vi.fn(() => ({ items: [], nextCursor: undefined })),
    listExpiredPending: vi.fn(() => []),
    isExpiredPendingAtDatabaseNow: vi.fn(isExpiredPendingAtDatabaseNow),
  };
  const createRemoteActionToken = vi.fn();
  let lastCreatedRemoteActionToken: ReturnType<typeof createRemoteActionToken>;
  const remoteActionTokens = {
    create: createRemoteActionToken,
    createWithTtl: vi.fn((request: Record<string, unknown> & { expiresInMs: number }) => {
      lastCreatedRemoteActionToken = remoteActionTokens.create({
        ...request,
        expiresAt: new Date(Date.now() + request.expiresInMs).toISOString(),
      });
      return lastCreatedRemoteActionToken;
    }),
    findPendingFresh: vi.fn((tokenId: string) =>
      lastCreatedRemoteActionToken?.tokenId === tokenId ? lastCreatedRemoteActionToken : undefined,
    ),
    listByApprovalId: vi.fn(() => []),
    expirePendingByApprovalId: vi.fn(() => 0),
  };
  let approvalEventCounter = 0;

  const host = {
    storage: {
      approvals,
      approvalEvents: {
        append: vi.fn((event: Record<string, unknown>) => {
          approvalEventCounter += 1;
          return {
            eventId: `approval-event-${approvalEventCounter}`,
            approvalId: String(event.approvalId),
            eventType: event.eventType,
            actorId: String(event.actorId),
            timestamp: "2026-04-11T00:01:00.000Z",
            payload: event.payload,
          };
        }),
        listByApprovalId: vi.fn(() => []),
      },
      governanceJourneyEvents: {
        create: vi.fn((event: Record<string, unknown>) => event),
      },
      pendingApprovalActions: {
        find: vi.fn(() => pendingAction),
        markResolved: vi.fn(),
      },
      remoteActionTokens,
      audit: {
        append: vi.fn(async () => undefined),
      },
      approvalWaitRuns: {
        getRunId: vi.fn(() => "approval-wait-1"),
      },
      approvalEffects: {
        listByApproval: vi.fn(() => input?.approvalEffects ?? []),
        claimNextPendingEffect: vi.fn(() => undefined),
      },
      approvalInbox: {
        findByApprovalAndToken: vi.fn(() => undefined),
      },
      chatInlineApprovals: {
        get: vi.fn(() => undefined),
        upsert: vi.fn(),
      },
      chatSessionMeta: {
        get: vi.fn(() => ({ workspaceId: "workspace-1" })),
      },
      chatTurnTraces: {
        get: vi.fn(() => ({
          turnId: "turn-1",
          sessionId: "session-1",
          durable: { runId: "durable-turn-1" },
        })),
      },
      chatToolRuns: {
        listBySession: vi.fn(() =>
          input?.chatToolName
            ? ([{ approvalId: "approval-1", turnId: "turn-1", toolName: input.chatToolName }] as never)
            : [],
        ),
      },
      codeModeRuns: {
        find: vi.fn((runId: string) => codeModeRuns.find((run) => run.runId === runId)),
        upsert: vi.fn((record: CodeModeRunRecord) => record),
      },
      runImmediateTransaction: vi.fn(<T>(callback: () => T): T => {
        const approvalBeforeTransaction = approval;
        try {
          return callback();
        } catch (error) {
          approval = approvalBeforeTransaction;
          throw error;
        }
      }),
    },
    policyEngine: {
      listGrants: vi.fn(() => []),
      listActiveGrants: vi.fn(() => []),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      executeApprovedAction: vi.fn(),
    },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ blockedBy: undefined, patch: undefined })),
      enqueueAfterHooks: vi.fn(),
    },
    shellExplainerPolicy: input?.shellExplainerPolicy ?? {
      enabled: true,
      elevateOnDanger: "danger" as const,
      autoRejectOnDanger: false,
    },
    approvalWaitRunService: {
      buildApprovalLinkage: vi.fn((linkage?: Record<string, unknown>) => linkage),
      buildApprovalRealtimeLinks: vi.fn((currentApproval: typeof approval) => ({
        approvalId: currentApproval.approvalId,
        sessionId: currentApproval.linkage?.sessionId,
        runId: currentApproval.linkage?.durableRunId,
        workspaceId: currentApproval.linkage?.workspaceId,
      })),
      reserveApprovalWaitRun: vi.fn((currentApproval: typeof approval) => {
        approval = {
          ...currentApproval,
          linkage: {
            ...(currentApproval.linkage ?? {}),
            durableRunId: "approval-wait-1",
          },
        };
        return approval;
      }),
      primeApprovalLifecycle: vi.fn((_approvalId: string) => {
        return approval;
      }),
    },
    publishRealtime: vi.fn(),
    requireConnectorRecord: vi.fn(),
    consumeRemoteActionToken: vi.fn(),
    consumeRemoteActionTokenById: vi.fn(),
    resolveApproval: vi.fn(),
    resolveDeviceAccessApproval: vi.fn(),
    executeCodeModePendingApproval: vi.fn(),
    resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
    parseApprovalCreateHookPatch: vi.fn(),
    scheduleApprovalExplanation: vi.fn(),
    findProactiveDurableRunIdsForApproval: vi.fn(() => []),
    wakeDurableRun: vi.fn(),
    enqueueApprovalObservabilityEffects: vi.fn(() => []),
    enqueueApprovalWaitMaterialization: vi.fn(),
    enqueueApprovalResolutionEffects: vi.fn(),
    awaitApprovalResolutionEffects: vi.fn(async (approvalId: string) =>
      host.storage.approvalEffects.listByApproval(approvalId),
    ),
    enqueueApprovalRemoteTokenDelivery: vi.fn(),
  };

  return host as typeof host & ApprovalLifecycleHost & ApprovalRemoteActionContext;
}

function createOfficialSearchApprovalHarness(searchArgs: Record<string, unknown>) {
  const host = createApprovalHarness({
    approvalKind: "browser.search",
    approvalPayload: { sessionId: "session-1", query: "current evidence", backend: "official", ...searchArgs },
    chatToolName: "browser.search",
  });
  const approval = host.storage.approvals.get("approval-1");
  host.resolveApproval.mockResolvedValue({
    approval: { ...approval, status: "approved", resolvedBy: "operator-test" },
    resolutionEffects: { proactiveRunIds: [], chatTurnResume: { resumed: false } },
  } as never);
  host.policyEngine.createGrant.mockImplementation(
    (input: ToolGrantCreateInput) =>
      ({
        grantId: `grant-${input.scope}-${input.scopeRef}`,
        ...input,
        grantType: input.grantType ?? "persistent",
        createdAt: "2026-07-14T00:00:00.000Z",
      }) as never,
  );
  return host;
}

function createRemoteActionTokenRecord(tokenId: string) {
  return {
    tokenId,
    actionType: "approval.resolve" as const,
    approvalId: "approval-1",
    connectorId: "connector-1",
    mutation: { approvalId: "approval-1" },
    createdAt: "2026-04-11T00:00:00.000Z",
    expiresAt: "2099-04-11T00:15:00.000Z",
    state: "pending" as const,
  };
}

function createCodeModeRunRecord(overrides: Partial<CodeModeRunRecord> = {}): CodeModeRunRecord {
  return {
    runId: "code-run-1",
    status: "approval_pending",
    language: "typescript",
    saveCandidateOnSuccess: false,
    capabilitySnapshotId: "cap-snap-1",
    codeModeInputHash: "input-hash",
    wrapperManifestHash: "wrapper-hash",
    policySnapshotHash: "policy-hash",
    codeHash: "code-hash",
    approvalId: "approval-1",
    codeArtifact: createArtifact("source.ts"),
    wrapperManifestArtifact: createArtifact("wrapper.json"),
    policySnapshotArtifact: createArtifact("policy.json"),
    stdoutTruncated: false,
    stderrTruncated: false,
    createdAt: "2026-04-11T00:00:00.000Z",
    ...overrides,
  };
}

function createArtifact(label: string) {
  return {
    artifactId: `artifact-${label}`,
    relPath: `code-mode/${label}`,
    sha256: `sha-${label}`,
    sizeBytes: 1,
    mimeType: "application/json",
  };
}

function createInMemoryApprovalEffectsStore(effectRows: ApprovalEffectRecord[]) {
  return {
    upsert: vi.fn(
      (input: {
        approvalId: string;
        effectKind: ApprovalEffectRecord["effectKind"];
        targetKind: ApprovalEffectRecord["targetKind"];
        targetId: string;
        payload?: Record<string, unknown>;
      }) => {
        const idempotencyKey = `${input.approvalId}:${input.effectKind}:${input.targetKind}:${input.targetId}`;
        const existingIndex = effectRows.findIndex((effect) => effect.idempotencyKey === idempotencyKey);
        if (existingIndex >= 0) {
          const existing = effectRows[existingIndex]!;
          const next = {
            ...existing,
            payload: input.payload ?? existing.payload,
            updatedAt: "2026-04-11T00:02:00.000Z",
          };
          effectRows.splice(existingIndex, 1, next);
          return next;
        }
        const effect: ApprovalEffectRecord = {
          effectId: `effect-${effectRows.length + 1}`,
          approvalId: input.approvalId,
          effectKind: input.effectKind,
          targetKind: input.targetKind,
          targetId: input.targetId,
          idempotencyKey,
          status: "pending",
          attemptCount: 0,
          payload: input.payload ?? {},
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        };
        effectRows.push(effect);
        return effect;
      },
    ),
    listByApproval: vi.fn((approvalId: string) =>
      effectRows.filter((effect) => effect.approvalId === approvalId).map((effect) => ({ ...effect })),
    ),
    claimNextPendingEffect: vi.fn((workerId: string, now: string, leaseExpiresAt: string) => {
      const effect = effectRows.find((candidate) => candidate.status === "pending");
      if (!effect) {
        return undefined;
      }
      Object.assign(effect, {
        status: "running",
        attemptCount: effect.attemptCount + 1,
        claimedBy: workerId,
        claimedAt: now,
        leaseExpiresAt,
        updatedAt: now,
        version: effect.version + 1,
      });
      return { ...effect };
    }),
    get: vi.fn((effectId: string) => {
      const effect = effectRows.find((candidate) => candidate.effectId === effectId);
      if (!effect) {
        throw new Error(`Unknown approval effect ${effectId}`);
      }
      return { ...effect };
    }),
    renewEffectLease: vi.fn(
      (effectId: string, workerId: string, expectedVersion: number, now: string, leaseExpiresAt: string) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          leaseExpiresAt,
          updatedAt: now,
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
    completeEffect: vi.fn(
      (effectId: string, workerId: string, expectedVersion: number, patch: { result?: Record<string, unknown> }) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          status: "completed",
          result: patch.result ?? effect.result,
          claimedBy: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          completedAt: "2026-04-11T00:01:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
    skipEffect: vi.fn(
      (effectId: string, workerId: string, expectedVersion: number, patch: { result?: Record<string, unknown> }) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          status: "skipped",
          result: patch.result ?? effect.result,
          claimedBy: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          completedAt: "2026-04-11T00:01:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
    failEffect: vi.fn(
      (
        effectId: string,
        workerId: string,
        expectedVersion: number,
        patch: { result?: Record<string, unknown>; lastError: string },
      ) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          status: "failed",
          result: patch.result ?? effect.result,
          lastError: patch.lastError,
          claimedBy: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          completedAt: "2026-04-11T00:01:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
  };
}
