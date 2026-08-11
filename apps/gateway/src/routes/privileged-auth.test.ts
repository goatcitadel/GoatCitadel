import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AuthConfig } from "../config.js";
import { authPlugin } from "../plugins/auth.js";
import { adminRoutes } from "./admin.js";
import { approvalsRoutes } from "./approvals.js";
import { authRoutes } from "./auth.js";
import { durableRoutes } from "./durable.js";
import { memoryRoutes } from "./memory.js";
import { orchestrationRoutes } from "./orchestration.js";
import { installRouteAccessTracking } from "./route-access.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

const DEVICE_GRANT_ID = "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f";
const COMPANION_SESSION_ID = "4b229ee9-bf83-4012-86c8-620f6e5306e0";
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";

function baseAuthConfig(mode: AuthConfig["mode"]): AuthConfig {
  return {
    mode,
    allowLoopbackBypass: false,
    token: {
      value: "test-token",
      queryParam: "access_token",
    },
    basic: {
      username: "operator",
      password: "password123",
    },
  };
}

function createGatewayMocks() {
  const verifyCompanionRequestSignature = vi.fn(() => undefined);
  const listDeviceAccessGrants = vi.fn(() => [
    {
      grantId: DEVICE_GRANT_ID,
      requestId: "request-device-1",
      actorId: `device:${DEVICE_GRANT_ID}`,
      deviceLabel: "LAN laptop",
      deviceType: "desktop",
      platform: "windows",
      grantedBy: "operator:test",
      createdAt: "2026-03-10T11:55:00.000Z",
      expiresAt: "2026-04-09T11:55:00.000Z",
      lastUsedAt: "2026-03-10T12:05:00.000Z",
      revokedAt: undefined,
      metadata: {},
    },
  ]);
  const resolveGatewayInstallToken = vi.fn(async () => ({
    token: "install-token-1",
    source: "env",
    persistedToEnv: false,
    warnings: [],
  }));
  const listCompanionSessions = vi.fn(() => ({
    items: [
      {
        contractId: "companion.android.v1",
        sessionId: COMPANION_SESSION_ID,
        grantId: DEVICE_GRANT_ID,
        actorId: `companion:${COMPANION_SESSION_ID}`,
        deviceLabel: "LAN laptop",
        deviceType: "desktop",
        platform: "windows",
        createdAt: "2026-03-10T12:10:00.000Z",
        lastSeenAt: "2026-03-10T12:20:00.000Z",
        lastRotatedAt: "2026-03-10T12:20:00.000Z",
        accessTokenExpiresAt: "2026-03-10T12:30:00.000Z",
        refreshTokenExpiresAt: "2026-03-11T12:20:00.000Z",
        signatureAlgorithm: "ed25519",
        grantExpiresAt: "2026-04-09T11:55:00.000Z",
        metadata: {
          clientName: "Android Companion",
        },
      },
    ],
  }));
  const getRetentionPolicy = vi.fn(() => ({
    realtimeEventsDays: 14,
    backupsKeep: 5,
  }));
  const createBackup = vi.fn(async () => ({
    backupId: "backup-1",
    filePath: "F:/code/personal-ai/backups/backup-1.zip",
    createdAt: "2026-04-11T00:00:00.000Z",
  }));
  const getDurableDiagnostics = vi.fn(() => ({
    enabled: true,
    replayFoundationReady: true,
    runCount: 2,
    queuedCount: 0,
    runningCount: 1,
    waitingCount: 1,
    failedCount: 0,
    deadLetterCount: 0,
    recentRuns: [],
    recentDeadLetters: [],
    generatedAt: "2026-04-11T00:00:00.000Z",
  }));
  const resumeDurableRun = vi.fn((runId: string, actorId: string) => ({
    runId,
    status: "running",
    actorId,
  }));
  const listApprovals = vi.fn(() => []);
  const resolveApprovalsBulk = vi.fn(async () => ({
    decision: "reject",
    status: "pending",
    resolvedCount: 1,
    skippedCount: 0,
    failedCount: 0,
    results: [],
  }));
  const resolveApproval = vi.fn(async (approvalId: string) => ({
    approval: {
      approvalId,
      kind: "tool.invoke",
      status: "approved",
      riskLevel: "danger",
      payload: {},
      preview: {},
      createdAt: "2026-04-11T00:00:00.000Z",
    },
  }));
  const createApprovalRemoteActionToken = vi.fn(() => ({
    approvalId: APPROVAL_ID,
    connectorId: "mission-control",
    tokenId: "rat_123",
    token: "grat_token",
    actionType: "approval.resolve",
    mutation: { approvalId: APPROVAL_ID },
    createdAt: "2026-04-11T00:00:00.000Z",
    expiresAt: "2026-04-11T01:00:00.000Z",
    state: "pending",
  }));
  const getApprovalReplay = vi.fn(() => ({
    approval: {
      approvalId: APPROVAL_ID,
      kind: "tool.invoke",
      status: "pending",
      riskLevel: "danger",
      payload: {},
      preview: {},
      createdAt: "2026-04-11T00:00:00.000Z",
    },
    events: [],
    durableRunId: "durable-run-42",
  }));
  const getMemoryMaintenanceStatus = vi.fn(() => ({
    policy: {
      workspaceId: "default",
      enabled: true,
      runMode: "manual",
      timingStrategy: "fixed",
      timeZone: "America/Los_Angeles",
      minHoursSinceLastSuccess: 24,
      minChangedSessions: 1,
      executionTarget: "auto",
      unavailableModelPolicy: "skip",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    },
    state: {
      workspaceId: "default",
      changedSessionCount: 0,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    },
    recommendationCount: 0,
    enabled: true,
    durableReady: true,
  }));
  const listMemoryItems = vi.fn(() => []);
  const runMemoryMaintenanceNow = vi.fn(() => ({
    runId: "mmrun-1",
    workspaceId: "default",
    triggerSource: "manual",
    status: "queued",
    policySnapshot: {},
    sourceSessionCount: 0,
    changedArtifactCount: 0,
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  }));
  const createOrchestrationPlan = vi.fn(async () => ({
    runId: "orch-run-1",
    planId: "plan-1",
    status: "queued",
    startedAt: "2026-04-11T00:00:00.000Z",
    totalCostUsd: 0,
    totalIterations: 0,
  }));
  const getRun = vi.fn(() => ({
    runId: "orch-run-1",
    planId: "plan-1",
    status: "queued",
    startedAt: "2026-04-11T00:00:00.000Z",
    totalCostUsd: 0,
    totalIterations: 0,
  }));

  return {
    gateway: {
      getAuthCredentialPlan: () => ({
        mode: "token",
        warnings: [],
        token: {
          configured: true,
          source: "env",
        },
        basicUsername: {
          configured: false,
          source: "none",
        },
        basicPassword: {
          configured: false,
          source: "none",
        },
      }),
      listDeviceAccessGrants,
      resolveGatewayInstallToken,
      listCompanionSessions,
      getRetentionPolicy,
      createBackup,
      getDurableDiagnostics,
      resumeDurableRun,
      listApprovals,
      resolveApprovalsBulk,
      resolveApproval,
      createApprovalRemoteActionToken,
      getApprovalReplay,
      getMemoryMaintenanceStatus,
      listMemoryItems,
      runMemoryMaintenanceNow,
      createOrchestrationPlan,
      getRun,
      validateDeviceAccessToken: (token: string) =>
        token === "device-bearer"
          ? {
              actorId: `device:${DEVICE_GRANT_ID}`,
              deviceId: DEVICE_GRANT_ID,
              grantId: DEVICE_GRANT_ID,
            }
          : undefined,
      validateCompanionAccessToken: (token: string) =>
        token === "companion-bearer"
          ? {
              actorId: `companion:${COMPANION_SESSION_ID}`,
              deviceId: DEVICE_GRANT_ID,
              grantId: DEVICE_GRANT_ID,
              sessionId: COMPANION_SESSION_ID,
            }
          : undefined,
      verifyCompanionRequestSignature,
    },
    spies: {
      verifyCompanionRequestSignature,
      listDeviceAccessGrants,
      resolveGatewayInstallToken,
      listCompanionSessions,
      getRetentionPolicy,
      createBackup,
      getDurableDiagnostics,
      resumeDurableRun,
      listApprovals,
      resolveApprovalsBulk,
      resolveApproval,
      createApprovalRemoteActionToken,
      getApprovalReplay,
      getMemoryMaintenanceStatus,
      listMemoryItems,
      runMemoryMaintenanceNow,
      createOrchestrationPlan,
      getRun,
    },
  };
}

async function buildApp(mode: AuthConfig["mode"]) {
  const { gateway, spies } = createGatewayMocks();
  const app = Fastify();
  app.decorate("gatewayAuth", gateway as never);
  app.decorate("services", {
    authAdmin: {
      getAuthCredentialPlan: gateway.getAuthCredentialPlan,
      listDeviceAccessGrants: spies.listDeviceAccessGrants,
      resolveGatewayInstallToken: spies.resolveGatewayInstallToken,
      listCompanionSessions: spies.listCompanionSessions,
      getRetentionPolicy: spies.getRetentionPolicy,
      createBackup: spies.createBackup,
    },
    approvals: {
      listApprovals: spies.listApprovals,
      resolveApprovalsBulk: spies.resolveApprovalsBulk,
      resolveApproval: spies.resolveApproval,
      createApprovalRemoteActionToken: spies.createApprovalRemoteActionToken,
      getApprovalReplay: spies.getApprovalReplay,
    },
    durable: {
      getDiagnostics: spies.getDurableDiagnostics,
      resumeRun: spies.resumeDurableRun,
    },
    memory: {
      getMaintenanceStatus: spies.getMemoryMaintenanceStatus,
      listItems: spies.listMemoryItems,
      runMaintenanceNow: spies.runMemoryMaintenanceNow,
    },
    orchestration: {
      createPlan: spies.createOrchestrationPlan,
      getRun: spies.getRun,
    },
  } as never);
  app.decorate("gatewayConfig", {
    assistant: {
      auth: baseAuthConfig(mode),
    },
  } as never);
  // Mirror the production composition seam (app.ts): route-access tracking's
  // global preHandler is registered BEFORE authPlugin, so route-access denials
  // (403) precede the companion request-signature check (401) exactly like the
  // real Gateway.
  installRouteAccessTracking(app);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(approvalsRoutes);
  await app.register(durableRoutes);
  await app.register(memoryRoutes);
  await app.register(orchestrationRoutes);
  return { app, spies };
}

describe("privileged auth boundary", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("allows operator tokens on representative privileged routes", async () => {
    const built = await buildApp("token");
    app = built.app;

    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/admin/retention",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/durable/diagnostics",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/auth/devices?view=all",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/auth/companion/sessions?view=all",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/approvals?status=pending&limit=20",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/approvals/${APPROVAL_ID}/replay`,
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/approvals/${APPROVAL_ID}/resolve`,
        headers: { Authorization: "Bearer test-token" },
        payload: {
          decision: "approve",
          resolvedBy: "operator:test",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/approvals/bulk-resolve",
        headers: { Authorization: "Bearer test-token" },
        payload: {
          decision: "reject",
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/approvals/${APPROVAL_ID}/remote-token`,
        headers: { Authorization: "Bearer test-token" },
        payload: {
          connectorId: "mission-control",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/auth/install-token",
        headers: { Authorization: "Bearer test-token" },
        payload: { generateWhenMissing: true },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/memory/maintenance/status?workspaceId=default",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/memory/items?limit=20",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/memory/maintenance/run-now",
        headers: {
          Authorization: "Bearer test-token",
          "Idempotency-Key": "memory-maint-run-now",
        },
        payload: { workspaceId: "default" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/orchestration/plans",
        headers: {
          Authorization: "Bearer test-token",
          "Idempotency-Key": "orch-plan-create",
        },
        payload: {
          planId: "plan-1",
          goal: "Ship safely",
          mode: "auto",
          maxIterations: 1,
          maxRuntimeMinutes: 5,
          maxCostUsd: 1,
          waves: [
            {
              waveId: "wave-1",
              verify: [],
              budgetUsd: 1,
              ownership: [{ agentId: "agent-1", paths: ["apps/**"] }],
              phases: [
                {
                  phaseId: "phase-1",
                  ownerAgentId: "agent-1",
                  specPath: "spec.md",
                  loopMode: "fresh-context",
                  requiresApproval: false,
                },
              ],
            },
          ],
        },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/orchestration/runs/orch-run-1",
        headers: { Authorization: "Bearer test-token" },
      }),
    ]);

    const routeLabels = [
      "GET /admin/retention",
      "GET /durable/diagnostics",
      "GET /auth/devices",
      "GET /auth/companion/sessions",
      "GET /approvals",
      "GET /approvals/:id/replay",
      "POST /approvals/:id/resolve",
      "POST /approvals/bulk-resolve",
      "POST /approvals/:id/remote-token",
      "POST /auth/install-token",
      "GET /memory/maintenance/status",
      "GET /memory/items",
      "POST /memory/maintenance/run-now",
      "POST /orchestration/plans",
      "GET /orchestration/runs/:id",
    ];
    for (const [index, response] of responses.entries()) {
      expect(
        response.statusCode,
        `${routeLabels[index] ?? `case ${index}`} returned ${response.statusCode}: ${response.body}`,
      ).toBeLessThan(300);
    }
    expect(built.spies.getRetentionPolicy).toHaveBeenCalledTimes(1);
    expect(built.spies.getDurableDiagnostics).toHaveBeenCalledTimes(1);
    expect(built.spies.listDeviceAccessGrants).toHaveBeenCalledTimes(1);
    expect(built.spies.listCompanionSessions).toHaveBeenCalledTimes(1);
    expect(built.spies.listApprovals).toHaveBeenCalledTimes(1);
    expect(built.spies.getApprovalReplay).toHaveBeenCalledTimes(1);
    expect(built.spies.resolveApproval).toHaveBeenCalledTimes(1);
    expect(built.spies.resolveApprovalsBulk).toHaveBeenCalledTimes(1);
    expect(built.spies.createApprovalRemoteActionToken).toHaveBeenCalledTimes(1);
    expect(built.spies.resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(built.spies.getMemoryMaintenanceStatus).toHaveBeenCalledTimes(1);
    expect(built.spies.listMemoryItems).toHaveBeenCalledTimes(1);
    expect(built.spies.runMemoryMaintenanceNow).toHaveBeenCalledTimes(1);
    expect(built.spies.createOrchestrationPlan).toHaveBeenCalledTimes(1);
    expect(built.spies.getRun).toHaveBeenCalledTimes(1);
  });

  it("preserves operator access for auth.mode=none installs", async () => {
    const built = await buildApp("none");
    app = built.app;

    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/admin/retention",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/durable/diagnostics",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/memory/maintenance/status?workspaceId=default",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/orchestration/runs/orch-run-1",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/auth/install-token",
        payload: { generateWhenMissing: true },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
    }
  });

  it("rejects device bearer credentials on representative privileged GET and POST routes", async () => {
    const built = await buildApp("token");
    app = built.app;

    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/admin/retention",
        headers: { Authorization: "Bearer device-bearer" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/approvals?status=pending&limit=20",
        headers: { Authorization: "Bearer device-bearer" },
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/approvals/${APPROVAL_ID}/replay`,
        headers: { Authorization: "Bearer device-bearer" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/approvals/${APPROVAL_ID}/resolve`,
        headers: { Authorization: "Bearer device-bearer" },
        payload: {
          decision: "approve",
          resolvedBy: "device:test",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/auth/install-token",
        headers: { Authorization: "Bearer device-bearer" },
        payload: { generateWhenMissing: true },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/memory/items?limit=20",
        headers: { Authorization: "Bearer device-bearer" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/memory/maintenance/run-now",
        headers: {
          Authorization: "Bearer device-bearer",
          "Idempotency-Key": "memory-maint-run-device",
        },
        payload: { workspaceId: "default" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/orchestration/plans",
        headers: {
          Authorization: "Bearer device-bearer",
          "Idempotency-Key": "orch-plan-device",
        },
        payload: {
          planId: "plan-1",
          goal: "Ship safely",
          mode: "auto",
          maxIterations: 1,
          maxRuntimeMinutes: 5,
          maxCostUsd: 1,
          waves: [
            {
              waveId: "wave-1",
              verify: [],
              budgetUsd: 1,
              ownership: [{ agentId: "agent-1", paths: ["apps/**"] }],
              phases: [
                {
                  phaseId: "phase-1",
                  ownerAgentId: "agent-1",
                  specPath: "spec.md",
                  loopMode: "fresh-context",
                  requiresApproval: false,
                },
              ],
            },
          ],
        },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
    }
    expect(built.spies.getRetentionPolicy).not.toHaveBeenCalled();
    expect(built.spies.listApprovals).not.toHaveBeenCalled();
    expect(built.spies.getApprovalReplay).not.toHaveBeenCalled();
    expect(built.spies.resolveApproval).not.toHaveBeenCalled();
    expect(built.spies.resolveGatewayInstallToken).not.toHaveBeenCalled();
    expect(built.spies.listMemoryItems).not.toHaveBeenCalled();
    expect(built.spies.runMemoryMaintenanceNow).not.toHaveBeenCalled();
    expect(built.spies.createOrchestrationPlan).not.toHaveBeenCalled();
  });

  it("rejects companion bearer credentials on representative privileged GET routes", async () => {
    const built = await buildApp("token");
    app = built.app;

    // Operator-only routes deny the companion at the route-access layer (403)
    // before the signature check runs. The one companion-readable route in this
    // sweep (operator-or-companion GET /api/v1/approvals) passes route access
    // and is then rejected by the companion request-signature layer (401):
    // a bare companion bearer without the device-key signature headers is not
    // fully authenticated, so a stolen token cannot read the approvals queue.
    const probes = [
      {
        url: "/api/v1/admin/retention",
        expectedStatus: 403,
        expectedError: "Operator authentication is required for this control-plane route.",
      },
      {
        url: "/api/v1/durable/diagnostics",
        expectedStatus: 403,
        expectedError: "Operator authentication is required for this control-plane route.",
      },
      {
        url: "/api/v1/memory/maintenance/status?workspaceId=default",
        expectedStatus: 403,
        expectedError: "Operator authentication is required for this control-plane route.",
      },
      {
        url: "/api/v1/orchestration/runs/orch-run-1",
        expectedStatus: 403,
        expectedError: "Operator authentication is required for this control-plane route.",
      },
      {
        url: "/api/v1/auth/devices?view=all",
        expectedStatus: 403,
        expectedError: "Operator authentication is required for this control-plane route.",
      },
      {
        url: "/api/v1/approvals?status=pending&limit=20",
        expectedStatus: 401,
        expectedError: "Missing companion request signature headers.",
      },
      {
        url: `/api/v1/approvals/${APPROVAL_ID}/replay`,
        expectedStatus: 403,
        expectedError: "Operator authentication is required for this control-plane route.",
      },
    ] as const;

    for (const probe of probes) {
      const response = await app.inject({
        method: "GET",
        url: probe.url,
        headers: { Authorization: "Bearer companion-bearer" },
      });
      expect(response.statusCode, probe.url).toBe(probe.expectedStatus);
      expect(response.json(), probe.url).toMatchObject({
        error: probe.expectedError,
      });
    }
    expect(built.spies.getRetentionPolicy).not.toHaveBeenCalled();
    expect(built.spies.getDurableDiagnostics).not.toHaveBeenCalled();
    expect(built.spies.getMemoryMaintenanceStatus).not.toHaveBeenCalled();
    expect(built.spies.getRun).not.toHaveBeenCalled();
    expect(built.spies.listDeviceAccessGrants).not.toHaveBeenCalled();
    expect(built.spies.listApprovals).not.toHaveBeenCalled();
    expect(built.spies.getApprovalReplay).not.toHaveBeenCalled();
    expect(built.spies.verifyCompanionRequestSignature).not.toHaveBeenCalled();
  });

  it("rejects signed companion mutations on privileged POST routes", async () => {
    const built = await buildApp("token");
    app = built.app;

    const headers = {
      Authorization: "Bearer companion-bearer",
      "x-goatcitadel-companion-timestamp": "2026-04-11T00:00:00.000Z",
      "x-goatcitadel-companion-nonce": "nonce-1",
      "x-goatcitadel-companion-signature": "signature-1",
    };

    // Operator-only routes deny the companion at the route-access layer, so
    // signature verification never runs for them (production ordering). The
    // operator-or-companion resolve route admits the signed companion, verifies
    // the signature, and then the handler denies the approve decision because
    // paired companions may only review or reject.
    const probes = [
      {
        url: "/api/v1/auth/install-token",
        payload: { generateWhenMissing: true },
        expectedError: "Operator authentication is required for this control-plane route.",
      },
      {
        url: "/api/v1/approvals/bulk-resolve",
        payload: { decision: "approve" },
        expectedError: "Operator authentication is required for this control-plane route.",
      },
      {
        url: `/api/v1/approvals/${APPROVAL_ID}/resolve`,
        payload: { decision: "approve", resolvedBy: "companion:test" },
        expectedError:
          "Paired companions may review or reject approvals, but approval and edit require operator authority until a server-verifiable device approval key is registered.",
      },
      {
        url: `/api/v1/approvals/${APPROVAL_ID}/remote-token`,
        payload: { connectorId: "mission-control" },
        expectedError: "Operator authentication is required for this control-plane route.",
      },
    ] as const;

    for (const probe of probes) {
      const response = await app.inject({
        method: "POST",
        url: probe.url,
        headers,
        payload: probe.payload,
      });
      expect(response.statusCode, probe.url).toBe(403);
      expect(response.json(), probe.url).toMatchObject({
        error: probe.expectedError,
      });
    }
    // Only the operator-or-companion resolve route reaches the signature layer.
    expect(built.spies.verifyCompanionRequestSignature).toHaveBeenCalledTimes(1);
    expect(built.spies.resolveApprovalsBulk).not.toHaveBeenCalled();
    expect(built.spies.resolveApproval).not.toHaveBeenCalled();
    expect(built.spies.createApprovalRemoteActionToken).not.toHaveBeenCalled();
    expect(built.spies.resolveGatewayInstallToken).not.toHaveBeenCalled();
  });
});
