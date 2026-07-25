import { describe, expect, it } from "vitest";
import {
  RuntimeAuthorityProjectionService,
  type RuntimeAuthorityProjectionDependencies,
} from "./runtime-authority-projection-service.js";

const NOW = new Date("2026-07-13T20:00:00.000Z");

describe("RuntimeAuthorityProjectionService", () => {
  it("keeps the durable repository authoritative when a retained event contradicts terminal outcome", async () => {
    const service = createService({
      listDurableRuns: () => [durableRun({ status: "completed" })],
      listRealtimeEvents: () => [
        {
          eventType: "system",
          eventAuthority: "retained_stream",
          links: { runId: "run-a" },
          timestamp: "2026-07-13T19:59:00.000Z",
          payload: { type: "durable_run_failed" },
        },
      ],
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "run:run-a")).toMatchObject({
      authorityClass: "canonical_record",
      freshness: "current",
      state: "Terminal outcome: completed.",
    });
    expect(result.items.find((item) => item.id === "run-signal:run-a")).toMatchObject({
      authorityClass: "retained_signal",
      freshness: "contradictory",
      posture: "critical",
    });
  });

  it("marks expired leases and stale heartbeats as derived stale worker health", async () => {
    const runningRuns = [
      durableRun({
        status: "running",
        leaseExpiresAt: "2026-07-13T20:05:00.000Z",
        leaseHeartbeatAt: "2026-07-13T19:50:00.000Z",
      }),
      durableRun({
        runId: "run-expired",
        status: "running",
        leaseExpiresAt: "2026-07-13T19:59:59.000Z",
        leaseHeartbeatAt: "2026-07-13T19:59:30.000Z",
      }),
    ];
    const service = createService({
      listDurableRuns: () => runningRuns,
      countDurableRuns: () => runningRuns.length,
      listRunningDurableRuns: () => ({ items: runningRuns, total: runningRuns.length }),
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });
    const stale = result.items.find((item) => item.id === "worker:run-a");
    const expired = result.items.find((item) => item.id === "worker:run-expired");

    expect(stale).toMatchObject({ authorityClass: "derived_projection", freshness: "stale", posture: "attention" });
    expect(expired).toMatchObject({ authorityClass: "derived_projection", freshness: "stale", posture: "critical" });
    expect(stale?.state).not.toContain("worker-secret-id");
  });

  it("separates approval decision truth from pending, failed, and manual-reconciliation effects", async () => {
    const approvals = ["pending-effect", "failed-effect", "manual-effect"].map((approvalId) => ({
      approvalId,
      kind: "tool",
      status: "approved",
      linkage: { workspaceId: "workspace-a" },
      createdAt: "2026-07-13T19:00:00.000Z",
      resolvedAt: "2026-07-13T19:01:00.000Z",
    }));
    const service = createService({
      listApprovals: () => approvals,
      listApprovalEffects: (approvalIds) =>
        approvalIds.map((approvalId) => ({
          approvalId,
          total: 1,
          effects: [
            {
              effectId: `effect-${approvalId}`,
              approvalId,
              status:
                approvalId === "pending-effect" ? "pending" : approvalId === "failed-effect" ? "failed" : "completed",
              result: approvalId === "manual-effect" ? { failureKind: "manual_reconciliation" } : {},
              updatedAt: "2026-07-13T19:02:00.000Z",
            },
          ],
        })),
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "approval:pending-effect")?.state).toMatch(/settlement is pending/i);
    expect(result.items.find((item) => item.id === "approval:failed-effect")?.state).toMatch(/effect failed/i);
    expect(result.items.find((item) => item.id === "approval:manual-effect")?.state).toMatch(/manual reconciliation/i);
    expect(result.items.find((item) => item.id === "approval-ui-materialization")).toMatchObject({
      authorityClass: "derived_projection",
      owner: "Mission Control",
    });
  });

  it.each([
    {
      identityFailure: "missing effect identity",
      overrides: {
        listApprovalEffects: (approvalIds: string[]) =>
          approvalIds.map((approvalId) => ({
            approvalId,
            total: 1,
            effects: [{ approvalId, status: "completed", updatedAt: "2026-07-13T19:02:00.000Z" }],
          })),
      },
    },
    {
      identityFailure: "foreign approval identity",
      overrides: {
        listApprovalEffects: (approvalIds: string[]) =>
          approvalIds.map((approvalId) => ({
            approvalId,
            total: 1,
            effects: [
              {
                effectId: "effect-foreign",
                approvalId: "approval-foreign",
                status: "completed",
                updatedAt: "2026-07-13T19:02:00.000Z",
              },
            ],
          })),
      },
    },
    {
      identityFailure: "duplicate identity within one batch",
      overrides: {
        listApprovalEffects: (approvalIds: string[]) =>
          approvalIds.map((approvalId) => ({
            approvalId,
            total: 2,
            effects: [1, 2].map(() => ({
              effectId: "effect-duplicate",
              approvalId,
              status: "completed",
              updatedAt: "2026-07-13T19:02:00.000Z",
            })),
          })),
      },
    },
    {
      identityFailure: "duplicate identity across batches",
      overrides: {
        listApprovals: () => [approval("approval-a", "workspace-a"), approval("approval-b", "workspace-a")],
        listApprovalEffects: (approvalIds: string[]) =>
          approvalIds.map((approvalId) => ({
            approvalId,
            total: 1,
            effects: [
              {
                effectId: "effect-cross-batch-duplicate",
                approvalId,
                status: "completed",
                updatedAt: "2026-07-13T19:02:00.000Z",
              },
            ],
          })),
      },
    },
  ] satisfies Array<{
    identityFailure: string;
    overrides: Partial<RuntimeAuthorityProjectionDependencies>;
  }>)("fails approval settlement closed on $identityFailure", async ({ overrides }) => {
    const result = await createService(overrides).getProjection({ workspaceId: "workspace-a" });
    const approvalItems = result.items.filter((item) => item.id.startsWith("approval:"));

    expect(approvalItems.length).toBeGreaterThan(0);
    expect(approvalItems.every((item) => item.posture === "unavailable" && item.freshness === "missing")).toBe(true);
    expect(approvalItems.every((item) => /settlement is unavailable/i.test(item.state))).toBe(true);
  });

  it.each([
    {
      name: "missing",
      inspection: undefined,
      expected: { authorityClass: "unavailable", freshness: "missing", posture: "unavailable" },
    },
    {
      name: "tampered",
      inspection: {
        observedAt: "2026-07-13T19:59:00.000Z",
        createdAt: "2026-07-13T19:00:00.000Z",
        verified: false,
        contractVerified: false,
        issueCodes: ["hash_mismatch"],
      },
      expected: { authorityClass: "canonical_record", freshness: "contradictory", posture: "critical" },
    },
    {
      name: "stale",
      inspection: {
        observedAt: "2026-07-13T19:59:00.000Z",
        createdAt: "2026-07-11T19:00:00.000Z",
        verified: true,
        contractVerified: true,
        issueCodes: [],
      },
      expected: { authorityClass: "canonical_record", freshness: "stale", posture: "attention" },
    },
  ])(
    "labels $name backup proof without treating filesystem presence as verification",
    async ({ inspection, expected }) => {
      const service = createService({ inspectLatestBackupTrust: async () => inspection });
      const result = await service.getProjection({ workspaceId: "workspace-a" });
      const backup = result.items.find((item) => item.id === (inspection ? "backup-latest" : "backup-unavailable"));
      expect(backup).toMatchObject(expected);
      expect(backup?.state).not.toMatch(/[A-Z]:\\|\/home\//);
    },
  );

  it("accepts exactly twenty bounded backup issue codes but rejects cap-plus-one and malformed codes", async () => {
    const exactCap = await createService({
      inspectLatestBackupTrust: async () => ({
        observedAt: "2026-07-13T19:59:00.000Z",
        createdAt: "2026-07-13T19:00:00.000Z",
        verified: false,
        contractVerified: false,
        issueCodes: Array.from({ length: 20 }, (_, index) => `issue_${index}`),
      }),
    }).getProjection({ workspaceId: "workspace-a" });
    expect(exactCap.items.find((item) => item.id === "backup-latest")).toMatchObject({
      authorityClass: "canonical_record",
      freshness: "contradictory",
      state: "Backup verification failed with 20 bounded issue code(s).",
    });

    for (const issueCodes of [
      Array.from({ length: 21 }, (_, index) => `issue_${index}`),
      ["x".repeat(81)],
      ["hash_mismatch", 42],
    ]) {
      const result = await createService({
        inspectLatestBackupTrust: async () => ({
          observedAt: "2026-07-13T19:59:00.000Z",
          createdAt: "2026-07-13T19:00:00.000Z",
          verified: false,
          contractVerified: false,
          issueCodes,
        }),
      }).getProjection({ workspaceId: "workspace-a" });
      expect(result.items.find((item) => item.id === "backup-unavailable")).toMatchObject({
        authorityClass: "unavailable",
        posture: "unavailable",
      });
    }
  });

  it.each([
    {
      owner: "mesh nodes",
      overrides: {
        listMeshNodes: () =>
          Array.from({ length: 200 }, (_, index) => ({
            nodeId: `node-${index}`,
            status: "online",
            lastSeenAt: "2026-07-13T19:59:30.000Z",
          })),
      },
    },
    {
      owner: "mesh leases",
      overrides: {
        listMeshLeases: () =>
          Array.from({ length: 200 }, (_, index) => ({
            leaseKey: `lease-${index}`,
            holderNodeId: "node-a",
            fencingToken: index + 1,
            expiresAt: "2026-07-13T20:10:00.000Z",
            updatedAt: "2026-07-13T19:59:30.000Z",
          })),
      },
    },
  ] satisfies Array<{ owner: string; overrides: Partial<RuntimeAuthorityProjectionDependencies> }>)(
    "marks an exact-cap $owner window incomplete without authoritative totals",
    async ({ overrides }) => {
      const result = await createService(overrides).getProjection({ workspaceId: "workspace-a" });

      expect(result.items.find((item) => item.id === "mesh-workers-window-incomplete")).toMatchObject({
        authorityClass: "unavailable",
        freshness: "unknown",
        posture: "unavailable",
      });
    },
  );

  it("does not emit a clear reconciliation status from an exact-cap external-effect window", async () => {
    const service = createService({
      listExternalSideEffects: () =>
        Array.from({ length: 50 }, (_, index) => ({
          ...sideEffect(`resolved-${index}`, "workspace-a"),
          status: "completed",
          resumeState: "completed",
        })),
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "manual-reconciliation-window-incomplete")).toMatchObject({
      authorityClass: "unavailable",
      freshness: "unknown",
      posture: "unavailable",
    });
    expect(result.items.some((item) => item.id === "manual-reconciliation-clear")).toBe(false);
  });

  it("fails duplicate external side-effect owner rows closed without duplicate critical cards", async () => {
    const duplicate = sideEffect("effect-duplicate", "workspace-a");
    const service = createService({ listExternalSideEffects: () => [duplicate, duplicate] });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "manual-reconciliation-malformed")).toMatchObject({
      authorityClass: "unavailable",
      posture: "unavailable",
    });
    expect(result.items.some((item) => item.id.startsWith("manual-reconciliation:"))).toBe(false);
    expect(result.items.some((item) => item.id === "manual-reconciliation-clear")).toBe(false);
  });

  it.each([
    {
      owner: "mesh nodes",
      overrides: {
        listMeshNodes: () => [{ nodeId: "node-a", status: "invented", lastSeenAt: "not-a-date" }],
      },
      unavailableId: "mesh-workers-malformed",
    },
    {
      owner: "mesh leases",
      overrides: {
        listMeshLeases: () => [{ leaseKey: "lease-a", fencingToken: 0, expiresAt: "not-a-date" }],
      },
      unavailableId: "mesh-workers-malformed",
    },
    {
      owner: "external side effects",
      overrides: {
        listExternalSideEffects: () => [
          {
            runId: "effect-a",
            workspaceId: "workspace-a",
            status: "invented",
            resumeState: "completed",
            updatedAt: "2026-07-13T19:05:00.000Z",
          },
        ],
      },
      unavailableId: "manual-reconciliation-malformed",
    },
  ] satisfies Array<{
    owner: string;
    overrides: Partial<RuntimeAuthorityProjectionDependencies>;
    unavailableId: string;
  }>)("fails malformed $owner input closed", async ({ overrides, unavailableId }) => {
    const result = await createService(overrides).getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === unavailableId)).toMatchObject({
      authorityClass: "unavailable",
      posture: "unavailable",
    });
  });

  it("filters run, approval, and reconciliation records to the requested workspace even if a dependency over-returns", async () => {
    const service = createService({
      listDurableRuns: () => [
        durableRun({ runId: "run-a", payload: { workspaceId: "workspace-a" } }),
        durableRun({ runId: "run-b", payload: { workspaceId: "workspace-b" } }),
      ],
      resolveDurableRunWorkspaceId: (run) => (run as { payload?: { workspaceId?: string } }).payload?.workspaceId,
      listApprovals: () => [approval("approval-a", "workspace-a"), approval("approval-b", "workspace-b")],
      listExternalSideEffects: () => [sideEffect("effect-a", "workspace-a"), sideEffect("effect-b", "workspace-b")],
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("run-a");
    expect(serialized).toContain("approval-a");
    expect(result.items.filter((item) => item.id.startsWith("manual-reconciliation:"))).toHaveLength(1);
    expect(result.items.find((item) => item.id.startsWith("manual-reconciliation:"))?.scope).toEqual({
      kind: "workspace",
      workspaceId: "workspace-a",
    });
    expect(serialized).not.toContain("run-b");
    expect(serialized).not.toContain("approval-b");
    expect(serialized).not.toContain("effect-a");
    expect(serialized).not.toContain("effect-b");
  });

  it("fails unscoped durable and running rows closed instead of promoting them into the default workspace", async () => {
    const unscopedRun = durableRun({
      runId: "unscoped-run",
      status: "running",
      payload: {},
      leaseExpiresAt: "2026-07-13T20:10:00.000Z",
      leaseHeartbeatAt: "2026-07-13T19:59:30.000Z",
    });
    const service = createService({
      listDurableRuns: () => [unscopedRun],
      countDurableRuns: () => 1,
      listRunningDurableRuns: () => ({ items: [unscopedRun], total: 1 }),
      resolveDurableRunWorkspaceId: () => undefined,
    });

    const result = await service.getProjection({ workspaceId: "default" });

    expect(result.items.find((item) => item.id === "runs-malformed")).toMatchObject({
      authorityClass: "unavailable",
      posture: "unavailable",
    });
    expect(result.items.find((item) => item.id === "durable-workers-malformed")).toMatchObject({
      authorityClass: "unavailable",
      posture: "unavailable",
    });
    expect(result.items.some((item) => item.id === "run:unscoped-run")).toBe(false);
    expect(result.items.some((item) => item.id === "runs-empty" || item.id === "durable-worker-idle")).toBe(false);
  });

  it("keeps an explicitly foreign run out of the default workspace without treating it as unscoped", async () => {
    const foreignRun = durableRun({ runId: "foreign-run", payload: { workspaceId: "workspace-b" } });
    const service = createService({
      listDurableRuns: () => [foreignRun],
      countDurableRuns: () => 1,
      resolveDurableRunWorkspaceId: (run) => (run as { payload?: { workspaceId?: string } }).payload?.workspaceId,
    });

    const result = await service.getProjection({ workspaceId: "default" });

    expect(result.items.find((item) => item.id === "runs-empty")).toMatchObject({ authorityClass: "unavailable" });
    expect(result.items.some((item) => item.id === "runs-malformed" || item.id === "run:foreign-run")).toBe(false);
  });

  it("does not claim a workspace has no runs when a noisy cross-workspace owner window is saturated", async () => {
    const noisyRuns = Array.from({ length: 500 }, (_, index) =>
      durableRun({ runId: `run-b-${index}`, payload: { workspaceId: "workspace-b" } }),
    );
    const service = createService({
      listDurableRuns: () => noisyRuns,
      countDurableRuns: () => 501,
      resolveDurableRunWorkspaceId: (run) => (run as { payload?: { workspaceId?: string } }).payload?.workspaceId,
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "runs-window-incomplete")).toMatchObject({
      authorityClass: "unavailable",
      freshness: "missing",
    });
    expect(result.items.some((item) => item.id === "runs-empty")).toBe(false);
  });

  it.each([
    { mismatch: "0 returned / 1 counted", runs: [], count: 1 },
    {
      mismatch: "1 foreign returned / 2 counted",
      runs: [durableRun({ runId: "run-b", payload: { workspaceId: "workspace-b" } })],
      count: 2,
    },
  ])("fails a below-cap global run-window mismatch closed for $mismatch", async ({ runs, count }) => {
    const service = createService({
      listDurableRuns: () => runs,
      countDurableRuns: () => count,
      resolveDurableRunWorkspaceId: (run) => (run as { payload?: { workspaceId?: string } }).payload?.workspaceId,
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "runs-window-incomplete")).toMatchObject({
      authorityClass: "unavailable",
      posture: "unavailable",
    });
    expect(result.items.some((item) => item.id === "runs-empty")).toBe(false);
  });

  it("preserves stable empty truth when the global owner returns and counts zero runs", async () => {
    const service = createService({ listDurableRuns: () => [], countDurableRuns: () => 0 });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "runs-empty")).toMatchObject({
      authorityClass: "unavailable",
      freshness: "missing",
    });
    expect(result.items.some((item) => item.id === "runs-window-incomplete")).toBe(false);
  });

  it("reads running workers independently so terminal display caps cannot hide an older active lease", async () => {
    const recentTerminalRuns = Array.from({ length: 20 }, (_, index) =>
      durableRun({ runId: `terminal-${index}`, updatedAt: `2026-07-13T19:${String(index).padStart(2, "0")}:00.000Z` }),
    );
    const active = durableRun({
      runId: "older-active",
      status: "running",
      updatedAt: "2026-07-13T18:00:00.000Z",
      leaseExpiresAt: "2026-07-13T20:10:00.000Z",
      leaseHeartbeatAt: "2026-07-13T19:59:30.000Z",
    });
    const service = createService({
      listDurableRuns: () => recentTerminalRuns,
      countDurableRuns: () => recentTerminalRuns.length + 1,
      listRunningDurableRuns: () => ({ items: [active], total: 1 }),
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "worker:older-active")).toMatchObject({
      authorityClass: "derived_projection",
      freshness: "current",
      posture: "ok",
    });
    expect(result.items.some((item) => item.id === "durable-worker-idle")).toBe(false);
  });

  it("marks saturated running-run reads unavailable instead of silently claiming the workspace is idle", async () => {
    const foreignRunning = Array.from({ length: 500 }, (_, index) =>
      durableRun({ runId: `foreign-running-${index}`, status: "running", payload: { workspaceId: "workspace-b" } }),
    );
    const service = createService({
      listRunningDurableRuns: () => ({ items: foreignRunning, total: 501 }),
      resolveDurableRunWorkspaceId: (run) => (run as { payload?: { workspaceId?: string } }).payload?.workspaceId,
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "durable-workers-window-incomplete")).toMatchObject({
      authorityClass: "unavailable",
    });
    expect(result.items.some((item) => item.id === "durable-worker-idle")).toBe(false);
  });

  it("fails duplicate and malformed owner rows closed and recognizes unknown-after-send effect settlement", async () => {
    const duplicateRun = durableRun({
      runId: "duplicate-running",
      status: "running",
      leaseExpiresAt: "2026-07-13T20:10:00.000Z",
      leaseHeartbeatAt: "2026-07-13T19:59:30.000Z",
    });
    const service = createService({
      listDurableRuns: () => [duplicateRun, duplicateRun],
      countDurableRuns: () => 2,
      listRunningDurableRuns: () => ({ items: [duplicateRun, duplicateRun], total: 2 }),
      listApprovalEffects: (approvalIds) =>
        approvalIds.map((approvalId) => ({
          approvalId,
          total: 1,
          effects: [
            {
              effectId: `effect-${approvalId}`,
              approvalId,
              status: "completed",
              result: { externalOutcome: "unknown_after_send", manualReconciliationRequired: true },
              updatedAt: "2026-07-13T19:02:00.000Z",
            },
          ],
        })),
      listExternalSideEffects: () => [
        {
          runId: "invalid-effect",
          workspaceId: "workspace-a",
          status: "made_up",
          resumeState: "completed",
          updatedAt: "2026-07-13T19:05:00.000Z",
        },
      ],
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.find((item) => item.id === "runs-malformed")?.authorityClass).toBe("unavailable");
    expect(result.items.find((item) => item.id === "durable-workers-malformed")?.authorityClass).toBe("unavailable");
    expect(result.items.find((item) => item.id === "approval:approval-a")?.state).toMatch(/manual reconciliation/i);
    expect(result.items.find((item) => item.id === "manual-reconciliation-malformed")?.authorityClass).toBe(
      "unavailable",
    );
    expect(result.items.some((item) => item.id === "manual-reconciliation-clear")).toBe(false);
  });

  it("keeps local runtime health, config recovery, and release identity classifications separate and secret-free", async () => {
    const service = createService({
      getLocalRuntimeStatus: () => ({
        enabled: true,
        desiredState: "running",
        processState: "running",
        healthy: false,
        pid: 1234,
        baseUrl: "http://internal-host:8080/secret",
        command: "C:\\private\\llama.exe --api-key sk-secret-value",
        updatedAt: "2026-07-13T19:59:30.000Z",
        leaseDiagnostics: { state: "active", activeLeaseCount: 2, ownership: "owned" },
      }),
      getRuntimeIdentity: () => ({
        identitySource: "git_checkout",
        integrity: "clean",
        release: {
          verified: false,
          certificateState: "parsed",
          generatedAt: "2026-07-13T18:00:00.000Z",
        },
      }),
      getConfigGenerationHealth: () => ({
        revision: 8,
        generationId: "generation-8",
        transactionState: "idle",
        mirrorRepairPending: false,
        lastRecovery: { outcome: "recovered_invalid_active", recovered: true, revision: 8 },
      }),
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });
    const serialized = JSON.stringify(result);

    expect(result.items.find((item) => item.id === "local-runtime-lease-health")).toMatchObject({
      authorityClass: "derived_projection",
      posture: "critical",
    });
    expect(result.items.find((item) => item.id === "release-certificate")).toMatchObject({
      authorityClass: "canonical_record",
      freshness: "contradictory",
      posture: "critical",
    });
    expect(result.items.find((item) => item.id === "running-build-identity")?.authorityClass).toBe("inferred");
    expect(result.items.find((item) => item.id === "config-generation-recovery")).toMatchObject({
      authorityClass: "derived_projection",
      posture: "attention",
    });
    expect(serialized).not.toMatch(/internal-host|private|llama\.exe|sk-secret-value|1234/);
  });

  it.each([
    {
      owner: "durable runs",
      overrides: { listDurableRuns: () => Array.from({ length: 501 }, () => ({})) },
      unavailableId: "runs-unavailable",
    },
    {
      owner: "retained realtime events",
      overrides: { listRealtimeEvents: () => Array.from({ length: 201 }, () => ({})) },
      unavailableId: "run-signals-unavailable",
    },
    {
      owner: "approvals",
      overrides: { listApprovals: () => Array.from({ length: 13 }, () => ({})) },
      unavailableId: "approvals-unavailable",
    },
    {
      owner: "mesh nodes",
      overrides: { listMeshNodes: () => Array.from({ length: 201 }, () => ({})) },
      unavailableId: "mesh-workers-unavailable",
    },
    {
      owner: "mesh leases",
      overrides: { listMeshLeases: () => Array.from({ length: 201 }, () => ({})) },
      unavailableId: "mesh-workers-unavailable",
    },
    {
      owner: "external side effects",
      overrides: { listExternalSideEffects: () => Array.from({ length: 51 }, () => ({})) },
      unavailableId: "manual-reconciliation-unavailable",
    },
    {
      owner: "running durable runs",
      overrides: {
        listRunningDurableRuns: () => ({ items: Array.from({ length: 501 }, () => ({})), total: 501 }),
      },
      unavailableId: "durable-workers-unavailable",
    },
    {
      owner: "contradictory running-run totals",
      overrides: {
        listRunningDurableRuns: () => ({
          items: [durableRun({ runId: "running-a", status: "running" })],
          total: 0,
        }),
      },
      unavailableId: "durable-workers-unavailable",
    },
  ] satisfies Array<{
    owner: string;
    overrides: Partial<RuntimeAuthorityProjectionDependencies>;
    unavailableId: string;
  }>)(
    "fails $owner over-return or cap metadata closed before projection work",
    async ({ overrides, unavailableId }) => {
      const service = createService(overrides);

      const result = await service.getProjection({ workspaceId: "workspace-a" });

      expect(result.items.find((item) => item.id === unavailableId)).toMatchObject({
        authorityClass: "unavailable",
        posture: "unavailable",
      });
    },
  );

  it("fails closed on absent owners and malformed legacy rows while bounding public strings and arrays", async () => {
    const oversized = "x".repeat(2_000);
    const service = createService({
      listDurableRuns: () => Array.from({ length: 100 }, () => ({ runId: oversized, status: "made_up" })),
      listRealtimeEvents: () => [{ eventType: oversized, links: { runId: oversized }, createdAt: "not-a-date" }],
      listApprovals: () => [{ approvalId: oversized, status: "approved", kind: oversized }],
      listApprovalEffects: () => [{ status: "invented", result: { secret: oversized } }],
      listMeshNodes: () => [{ status: "online", lastSeenAt: "not-a-date" }],
      listMeshLeases: () => [{ expiresAt: "not-a-date" }],
      inspectLatestBackupTrust: async () => undefined,
      getRuntimeIdentity: () => undefined,
      getConfigGenerationHealth: () => ({ revision: "wrong", generationId: oversized }),
      listExternalSideEffects: () => [{ runId: oversized, status: "unknown_external_outcome" }],
    });

    const result = await service.getProjection({ workspaceId: "workspace-a" });

    expect(result.items.length).toBeLessThanOrEqual(40);
    expect(result.items.some((item) => item.authorityClass === "unavailable")).toBe(true);
    expect(
      result.items
        .filter((item) => item.authorityClass === "unavailable")
        .every((item) => item.canonicalRef === undefined),
    ).toBe(true);
    for (const item of result.items) {
      expect(item.state.length).toBeLessThanOrEqual(240);
      expect(item.basis.length).toBeLessThanOrEqual(240);
      expect(item.caveat?.length ?? 0).toBeLessThanOrEqual(240);
    }
    expect(JSON.stringify(result)).not.toContain(oversized);
  });
});

function createService(
  overrides: Partial<RuntimeAuthorityProjectionDependencies> = {},
): RuntimeAuthorityProjectionService {
  const deps: RuntimeAuthorityProjectionDependencies = {
    now: () => NOW,
    listDurableRuns: () => [durableRun()],
    countDurableRuns: () => 1,
    listRunningDurableRuns: () => ({ items: [], total: 0 }),
    resolveDurableRunWorkspaceId: (run) =>
      (run as { payload?: { workspaceId?: string } }).payload?.workspaceId ?? "workspace-a",
    listRealtimeEvents: () => [],
    listApprovals: () => [approval("approval-a", "workspace-a")],
    listApprovalEffects: (approvalIds) => approvalIds.map((approvalId) => ({ approvalId, effects: [], total: 0 })),
    listMeshNodes: () => [{ nodeId: "node-a", status: "online", lastSeenAt: "2026-07-13T19:59:30.000Z" }],
    listMeshLeases: () => [
      {
        leaseKey: "lease-a",
        holderNodeId: "node-a",
        fencingToken: 1,
        expiresAt: "2026-07-13T20:10:00.000Z",
        updatedAt: "2026-07-13T19:59:30.000Z",
      },
    ],
    inspectLatestBackupTrust: async () => ({
      observedAt: "2026-07-13T19:59:00.000Z",
      createdAt: "2026-07-13T19:00:00.000Z",
      verified: true,
      contractVerified: true,
      issueCodes: [],
    }),
    getRuntimeIdentity: () => ({
      identitySource: "git_checkout",
      integrity: "clean",
      release: {
        verified: true,
        certificateState: "parsed",
        generatedAt: "2026-07-13T18:00:00.000Z",
      },
    }),
    getLocalRuntimeStatus: () => ({
      enabled: true,
      desiredState: "running",
      processState: "running",
      healthy: true,
      updatedAt: "2026-07-13T19:59:30.000Z",
      leaseDiagnostics: {
        state: "active",
        activeLeaseCount: 1,
        ownership: "owned",
      },
    }),
    getConfigGenerationHealth: () => ({
      revision: 8,
      generationId: "generation-8",
      transactionState: "idle",
      mirrorRepairPending: false,
      lastRecovery: { outcome: "not_needed", recovered: false },
    }),
    listExternalSideEffects: () => [],
    ...overrides,
  };
  return new RuntimeAuthorityProjectionService(deps);
}

function durableRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-a",
    workflowKey: "chat_turn",
    status: "completed",
    payload: { workspaceId: "workspace-a" },
    createdAt: "2026-07-13T19:00:00.000Z",
    updatedAt: "2026-07-13T19:10:00.000Z",
    finishedAt: "2026-07-13T19:10:00.000Z",
    leaseOwnerId: "worker-secret-id",
    ...overrides,
  };
}

function approval(approvalId: string, workspaceId: string) {
  return {
    approvalId,
    kind: "tool",
    status: "approved",
    linkage: { workspaceId },
    createdAt: "2026-07-13T19:00:00.000Z",
    resolvedAt: "2026-07-13T19:01:00.000Z",
  };
}

function sideEffect(runId: string, workspaceId: string) {
  return {
    runId,
    workspaceId,
    status: "unknown_external_outcome",
    resumeState: "manual_review_unknown_external_outcome",
    updatedAt: "2026-07-13T19:05:00.000Z",
  };
}
