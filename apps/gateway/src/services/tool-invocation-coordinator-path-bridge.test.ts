import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  ChatTurnCapabilityToolRuntimeOwnerBinding,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationCoordinatorHost,
  type WorkspacePathBridgeExecutionDecision,
  type WorkspacePathBridgeResolutionContext,
} from "./tool-invocation-coordinator-service.js";
import type { PluginToolHandler } from "./plugin-tool-override-service.js";
import type { ToolProcessSpawnBoundary } from "@goatcitadel/policy-engine";

const STABLE_PLUGIN_OWNER = { kind: "plugin", bindingHash: "a".repeat(64) } as const;
const REPLACEMENT_PLUGIN_OWNER = { kind: "plugin", bindingHash: "b".repeat(64) } as const;
const STABLE_BRIDGE_FINGERPRINT = "c".repeat(64);
const REPLACEMENT_BRIDGE_FINGERPRINT = "d".repeat(64);
const STABLE_BRIDGE_GIT_IDENTITY = "e".repeat(64);
const REPLACEMENT_BRIDGE_GIT_IDENTITY = "f".repeat(64);

interface BridgeStabilityMaterial {
  snapshotFingerprintSha256?: string;
  gitIdentitySha256?: string;
}

interface BridgeStabilityCase {
  label: string;
  policy: BridgeStabilityMaterial;
  preExecute: BridgeStabilityMaterial;
  expectedReason?: "canonicalization_failed" | "git_identity_mismatch";
}

const BRIDGE_STABILITY_CASES: readonly BridgeStabilityCase[] = [
  {
    label: "exact fingerprint and Git identity match",
    policy: {
      snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
      gitIdentitySha256: STABLE_BRIDGE_GIT_IDENTITY,
    },
    preExecute: {
      snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
      gitIdentitySha256: STABLE_BRIDGE_GIT_IDENTITY,
    },
  },
  {
    label: "same-cwd fingerprint drift",
    policy: {
      snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
      gitIdentitySha256: STABLE_BRIDGE_GIT_IDENTITY,
    },
    preExecute: {
      snapshotFingerprintSha256: REPLACEMENT_BRIDGE_FINGERPRINT,
      gitIdentitySha256: STABLE_BRIDGE_GIT_IDENTITY,
    },
    expectedReason: "canonicalization_failed",
  },
  {
    label: "same-cwd Git identity drift",
    policy: {
      snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
      gitIdentitySha256: STABLE_BRIDGE_GIT_IDENTITY,
    },
    preExecute: {
      snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
      gitIdentitySha256: REPLACEMENT_BRIDGE_GIT_IDENTITY,
    },
    expectedReason: "git_identity_mismatch",
  },
  {
    label: "missing pre-execute fingerprint",
    policy: { snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT },
    preExecute: {},
    expectedReason: "canonicalization_failed",
  },
  {
    label: "missing policy and pre-execute fingerprints",
    policy: {},
    preExecute: {},
    expectedReason: "canonicalization_failed",
  },
  {
    label: "extra pre-execute Git identity",
    policy: { snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT },
    preExecute: {
      snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
      gitIdentitySha256: STABLE_BRIDGE_GIT_IDENTITY,
    },
    expectedReason: "git_identity_mismatch",
  },
];

function createMutablePluginRuntime(initialHandler: PluginToolHandler) {
  let currentHandler: PluginToolHandler | undefined = initialHandler;
  let currentOwner: ChatTurnCapabilityToolRuntimeOwnerBinding | undefined = STABLE_PLUGIN_OWNER;
  const service = {
    resolveActiveHandler: vi.fn(() => currentHandler),
    resolveRuntimeOwnerBinding: vi.fn(() => currentOwner as ChatTurnCapabilityToolRuntimeOwnerBinding),
  } as unknown as NonNullable<ToolInvocationCoordinatorHost["pluginToolOverrideService"]>;
  return {
    service,
    setHandler: (handler: PluginToolHandler | undefined) => {
      currentHandler = handler;
    },
    setOwner: (owner: ChatTurnCapabilityToolRuntimeOwnerBinding | undefined) => {
      currentOwner = owner;
    },
  };
}

function createRequest(cwd = "F:\\workspace\\project"): ToolInvokeRequest {
  return {
    toolName: "shell.exec",
    args: { command: "git status --short", cwd },
    agentId: "agent-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
  };
}

function verifiedBridgeDecision(
  snapshotId: string,
  material: BridgeStabilityMaterial,
): WorkspacePathBridgeExecutionDecision {
  return {
    status: "verified",
    snapshotId,
    canonicalCwd: "F:\\canonical\\project",
    ...(material.snapshotFingerprintSha256 ? { snapshotFingerprintSha256: material.snapshotFingerprintSha256 } : {}),
    ...(material.gitIdentitySha256 ? { gitIdentitySha256: material.gitIdentitySha256 } : {}),
  };
}

function createHost(
  input: {
    resolve?: (
      request: ToolInvokeRequest,
      context: WorkspacePathBridgeResolutionContext,
    ) => Promise<WorkspacePathBridgeExecutionDecision>;
    invoke?: (
      request: ToolInvokeRequest,
      options?: { beforeExecute?: (boundary?: ToolProcessSpawnBoundary) => void | Promise<void> },
    ) => Promise<ToolInvokeResult>;
    runInlineHooks?: ToolInvocationCoordinatorHost["hooksService"]["runInlineHooks"];
    pluginHandler?: (args: Record<string, unknown>, context: unknown) => Promise<ToolInvokeResult>;
    pluginToolOverrideService?: ToolInvocationCoordinatorHost["pluginToolOverrideService"];
  } = {},
): ToolInvocationCoordinatorHost {
  const host = {
    policyEngine: {
      invoke: vi.fn(
        input.invoke ??
          (async (): Promise<ToolInvokeResult> => ({
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-1",
            result: { ok: true },
          })),
      ),
      evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    },
    hooksService: {
      runInlineHooks: input.runInlineHooks ?? vi.fn(async () => ({ runs: [] })),
      enqueueAfterHooks: vi.fn(),
    },
    normalizeToolInvokeRequest: vi.fn((request: ToolInvokeRequest) => request),
    isValidToolName: vi.fn(() => true),
    evaluateToolDeploymentGuard: vi.fn(() => undefined),
    resolveToolHookWorkspaceId: vi.fn(() => "workspace-1"),
    primeToolApprovalLifecycle: vi.fn(() => ({}) as ApprovalRequest),
    scheduleApprovalExplanationById: vi.fn(),
    publishRealtime: vi.fn(),
    recordEvidenceEnvelope: vi.fn(),
    ...(input.pluginToolOverrideService
      ? { pluginToolOverrideService: input.pluginToolOverrideService }
      : input.pluginHandler
        ? {
            pluginToolOverrideService: {
              resolveActiveHandler: vi.fn(() => input.pluginHandler),
              resolveRuntimeOwnerBinding: vi.fn(() => STABLE_PLUGIN_OWNER),
            },
          }
        : {}),
    ...(input.resolve ? { resolveWorkspacePathBridgeBeforeExecution: input.resolve } : {}),
  };
  return host as unknown as ToolInvocationCoordinatorHost;
}

describe("ToolInvocationCoordinatorService workspace path execution bridge", () => {
  it("revalidates stable cwd, snapshot, and Git identity at the builtin's deepest spawn seam", async () => {
    const order: string[] = [];
    const resolve = vi.fn(
      async (
        _request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        order.push(`bridge:${context.phase}`);
        return {
          status: "verified",
          snapshotId: `snapshot-${context.phase}`,
          canonicalCwd: "F:\\canonical\\project",
          snapshotFingerprintSha256: "a".repeat(64),
          gitIdentitySha256: "b".repeat(64),
        };
      },
    );
    const invoke = vi.fn(
      async (
        request: ToolInvokeRequest,
        options?: { beforeExecute?: (boundary?: ToolProcessSpawnBoundary) => void | Promise<void> },
      ): Promise<ToolInvokeResult> => {
        order.push("executor:resolved");
        await options?.beforeExecute?.({ toolName: "shell.exec", cwd: String(request.args.cwd) });
        order.push("executor:spawn");
        return { outcome: "executed", policyReason: "allowed", auditEventId: "audit-deepest" };
      },
    );
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));

    await expect(coordinator.invokeTool(createRequest())).resolves.toMatchObject({ outcome: "executed" });
    expect(order).toEqual(["bridge:policy", "executor:resolved", "bridge:pre_execute", "executor:spawn"]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("accepts a canonical POSIX decision and revalidates it at the deepest spawn seam", async () => {
    const order: string[] = [];
    const resolve = vi.fn(
      async (
        _request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        order.push(`bridge:${context.phase}`);
        return {
          status: "verified",
          snapshotId: `posix-${context.phase}`,
          canonicalCwd: "/app/workspace/project",
          snapshotFingerprintSha256: "c".repeat(64),
          gitIdentitySha256: "d".repeat(64),
        };
      },
    );
    const invoke = vi.fn(
      async (
        request: ToolInvokeRequest,
        options?: { beforeExecute?: (boundary?: ToolProcessSpawnBoundary) => void | Promise<void> },
      ): Promise<ToolInvokeResult> => {
        order.push("executor:resolved");
        await options?.beforeExecute?.({ toolName: "shell.exec", cwd: String(request.args.cwd) });
        order.push("executor:spawn");
        return { outcome: "executed", policyReason: "allowed", auditEventId: "audit-posix" };
      },
    );
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));

    await expect(coordinator.invokeTool(createRequest("/app/workspace/project"))).resolves.toMatchObject({
      outcome: "executed",
    });
    expect(order).toEqual(["bridge:policy", "executor:resolved", "bridge:pre_execute", "executor:spawn"]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("fails closed when approved replay has no resolver", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "plugin",
        auditEventId: "plugin-audit",
      }),
    );
    const host = createHost({ pluginHandler });
    const coordinator = new ToolInvocationCoordinatorService(host);

    await expect(coordinator.invokeApprovedExternalRuntimeTool(createRequest())).resolves.toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: workspace path was not freshly verified for execution",
    });
    expect(host.policyEngine.invoke).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", { status: "verified", snapshotId: "historical", canonicalCwd: "/tmp/../project" }],
    ["blocked", { status: "blocked", reasonCode: "outside_jail", snapshotId: "approved-blocked" }],
  ] as const)("fails closed when approved replay receives a %s resolver decision", async (_label, decision) => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "plugin",
        auditEventId: "plugin-audit",
      }),
    );
    const resolve = vi.fn(async () => decision as WorkspacePathBridgeExecutionDecision);
    const host = createHost({ resolve, pluginHandler });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeApprovedExternalRuntimeTool(createRequest());

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: workspace path was not freshly verified for execution",
    });
    expect(host.policyEngine.invoke).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("blocks approved replay when fresh pre-execute verification detects cwd drift", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "plugin",
        auditEventId: "plugin-audit",
      }),
    );
    const resolve = vi.fn(
      async (
        _request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> =>
        context.phase === "policy"
          ? { status: "verified", snapshotId: "approved-policy", canonicalCwd: "F:\\canonical\\project" }
          : { status: "verified", snapshotId: "approved-pre-execute", canonicalCwd: "F:\\swapped\\project" },
    );
    const host = createHost({ resolve, pluginHandler });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeApprovedExternalRuntimeTool(createRequest());

    expect(result).toMatchObject({
      outcome: "blocked",
      result: {
        workspacePathBridge: {
          status: "blocked",
          reasonCode: "round_trip_mismatch",
          snapshotId: "approved-pre-execute",
          priorVerifiedSnapshotIds: ["approved-policy", "approved-pre-execute"],
        },
      },
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(host.policyEngine.invoke).toHaveBeenCalledTimes(1);
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("freshly verifies successful approved replay at policy and immediate pre-handler boundaries", async () => {
    const order: string[] = [];
    const invocationIds: string[] = [];
    const resolve = vi.fn(
      async (
        request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        order.push(`bridge:${context.phase}`);
        invocationIds.push(context.invocationId);
        expect(request.args.cwd).toBe(context.phase === "policy" ? "F:\\workspace\\project" : "F:\\canonical\\project");
        return {
          status: "verified",
          snapshotId: `approved-${context.phase}`,
          canonicalCwd: "F:\\canonical\\project",
          snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
        };
      },
    );
    const invoke = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      order.push("policy");
      expect(request.args.cwd).toBe("F:\\canonical\\project");
      return { outcome: "executed", policyReason: "approved policy", auditEventId: "policy-audit" };
    });
    const pluginHandler = vi.fn(async (args: Record<string, unknown>): Promise<ToolInvokeResult> => {
      order.push("handler");
      expect(args.cwd).toBe("F:\\canonical\\project");
      return { outcome: "executed", policyReason: "plugin", auditEventId: "plugin-audit" };
    });
    const host = createHost({ resolve, invoke, pluginHandler });
    const coordinator = new ToolInvocationCoordinatorService(host);
    const markExternalCallStarted = vi.fn(() => order.push("started"));
    const request = createRequest();

    await expect(
      coordinator.invokeApprovedExternalRuntimeTool(request, markExternalCallStarted),
    ).resolves.toMatchObject({ outcome: "executed" });

    expect(order).toEqual(["bridge:policy", "policy", "bridge:pre_execute", "started", "handler"]);
    expect(new Set(invocationIds).size).toBe(1);
    expect(invocationIds[0]).toMatch(/^approved:[0-9a-f-]{36}$/u);
    expect(request.args.cwd).toBe("F:\\workspace\\project");
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "tool_invoked",
      "policy",
      expect.objectContaining({ workspacePathBridgeSnapshotId: "approved-pre_execute" }),
      expect.any(Object),
    );
    expect(host.recordEvidenceEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          approvalReplay: true,
          workspacePathBridgeSnapshotIds: ["approved-policy", "approved-pre_execute"],
        }),
      }),
    );
  });

  it.each(BRIDGE_STABILITY_CASES)(
    "enforces generic plugin bridge stability for $label",
    async ({ policy, preExecute, expectedReason }) => {
      const pluginHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "plugin",
          auditEventId: "plugin-audit",
        }),
      );
      const resolve = vi.fn(
        async (
          _request: ToolInvokeRequest,
          context: WorkspacePathBridgeResolutionContext,
        ): Promise<WorkspacePathBridgeExecutionDecision> =>
          verifiedBridgeDecision(
            `generic-stability-${context.phase}`,
            context.phase === "policy" ? policy : preExecute,
          ),
      );
      const host = createHost({ resolve, pluginHandler });
      const coordinator = new ToolInvocationCoordinatorService(host);
      const executionFence = vi.fn();
      const markStarted = vi.fn();
      const markNotRequired = vi.fn();

      const result = await coordinator.invokeTool(createRequest(), {
        executionFence,
        externalSideEffect: { markStarted, markNotRequired },
      });

      if (!expectedReason) {
        expect(result).toMatchObject({ outcome: "executed" });
        expect(executionFence).toHaveBeenCalledTimes(1);
        expect(markStarted).toHaveBeenCalledTimes(1);
        expect(pluginHandler).toHaveBeenCalledTimes(1);
        return;
      }
      expect(result).toMatchObject({
        outcome: "blocked",
        result: {
          workspacePathBridge: {
            status: "blocked",
            reasonCode: expectedReason,
            snapshotId: "generic-stability-pre_execute",
          },
        },
      });
      expect(executionFence).not.toHaveBeenCalled();
      expect(markStarted).not.toHaveBeenCalled();
      expect(pluginHandler).not.toHaveBeenCalled();
    },
  );

  it.each(BRIDGE_STABILITY_CASES)(
    "enforces approved replay bridge stability for $label",
    async ({ policy, preExecute, expectedReason }) => {
      const pluginHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "plugin",
          auditEventId: "plugin-audit",
        }),
      );
      const resolve = vi.fn(
        async (
          _request: ToolInvokeRequest,
          context: WorkspacePathBridgeResolutionContext,
        ): Promise<WorkspacePathBridgeExecutionDecision> =>
          verifiedBridgeDecision(
            `approved-stability-${context.phase}`,
            context.phase === "policy" ? policy : preExecute,
          ),
      );
      const host = createHost({ resolve, pluginHandler });
      const coordinator = new ToolInvocationCoordinatorService(host);
      const markExternalCallStarted = vi.fn();

      const result = await coordinator.invokeApprovedExternalRuntimeTool(createRequest(), markExternalCallStarted);

      if (!expectedReason) {
        expect(result).toMatchObject({ outcome: "executed" });
        expect(markExternalCallStarted).toHaveBeenCalledTimes(1);
        expect(pluginHandler).toHaveBeenCalledTimes(1);
        return;
      }
      expect(result).toMatchObject({
        outcome: "blocked",
        result: {
          workspacePathBridge: {
            status: "blocked",
            reasonCode: expectedReason,
            snapshotId: "approved-stability-pre_execute",
          },
        },
      });
      expect(markExternalCallStarted).not.toHaveBeenCalled();
      expect(pluginHandler).not.toHaveBeenCalled();
    },
  );

  it.each(["replacement", "removal", "generation", "owner-unavailable"] as const)(
    "blocks generic plugin execution when %s drift occurs during awaited pre-execute verification",
    async (mutation) => {
      const admittedHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "admitted plugin",
          auditEventId: "admitted-plugin-audit",
        }),
      );
      const replacementHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "replacement plugin",
          auditEventId: "replacement-plugin-audit",
        }),
      );
      const runtime = createMutablePluginRuntime(admittedHandler);
      const resolve = vi.fn(
        async (
          _request: ToolInvokeRequest,
          context: WorkspacePathBridgeResolutionContext,
        ): Promise<WorkspacePathBridgeExecutionDecision> => {
          if (context.phase === "pre_execute") {
            await Promise.resolve();
            if (mutation === "replacement") runtime.setHandler(replacementHandler);
            if (mutation === "removal") runtime.setHandler(undefined);
            if (mutation === "generation") runtime.setOwner(REPLACEMENT_PLUGIN_OWNER);
            if (mutation === "owner-unavailable") runtime.setOwner(undefined);
          }
          return {
            status: "verified",
            snapshotId: `generic-${context.phase}`,
            canonicalCwd: "F:\\canonical\\project",
            snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
          };
        },
      );
      const executionFence = vi.fn();
      const markStarted = vi.fn();
      const markNotRequired = vi.fn();
      const host = createHost({
        resolve,
        pluginToolOverrideService: runtime.service,
      });
      const coordinator = new ToolInvocationCoordinatorService(host);

      const result = await coordinator.invokeTool(createRequest(), {
        executionFence,
        externalSideEffect: { markStarted, markNotRequired },
      });

      expect(result).toMatchObject({
        outcome: "blocked",
        policyReason: expect.stringContaining("runtime owner binding drifted"),
      });
      expect(admittedHandler).not.toHaveBeenCalled();
      expect(replacementHandler).not.toHaveBeenCalled();
      expect(executionFence).not.toHaveBeenCalled();
      expect(markStarted).not.toHaveBeenCalled();
      expect(markNotRequired).not.toHaveBeenCalled();
    },
  );

  it.each(["replacement", "removal", "generation", "owner-unavailable"] as const)(
    "blocks approved replay when %s drift occurs during awaited pre-execute verification",
    async (mutation) => {
      const admittedHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "admitted plugin",
          auditEventId: "admitted-plugin-audit",
        }),
      );
      const replacementHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "replacement plugin",
          auditEventId: "replacement-plugin-audit",
        }),
      );
      const runtime = createMutablePluginRuntime(admittedHandler);
      const resolve = vi.fn(
        async (
          _request: ToolInvokeRequest,
          context: WorkspacePathBridgeResolutionContext,
        ): Promise<WorkspacePathBridgeExecutionDecision> => {
          if (context.phase === "pre_execute") {
            await Promise.resolve();
            if (mutation === "replacement") runtime.setHandler(replacementHandler);
            if (mutation === "removal") runtime.setHandler(undefined);
            if (mutation === "generation") runtime.setOwner(REPLACEMENT_PLUGIN_OWNER);
            if (mutation === "owner-unavailable") runtime.setOwner(undefined);
          }
          return {
            status: "verified",
            snapshotId: `approved-drift-${context.phase}`,
            canonicalCwd: "F:\\canonical\\project",
            snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
          };
        },
      );
      const markExternalCallStarted = vi.fn();
      const host = createHost({
        resolve,
        pluginToolOverrideService: runtime.service,
      });
      const coordinator = new ToolInvocationCoordinatorService(host);

      const result = await coordinator.invokeApprovedExternalRuntimeTool(createRequest(), markExternalCallStarted);

      expect(result).toMatchObject({
        outcome: "blocked",
        policyReason: expect.stringContaining("runtime owner binding drifted"),
      });
      expect(admittedHandler).not.toHaveBeenCalled();
      expect(replacementHandler).not.toHaveBeenCalled();
      expect(markExternalCallStarted).not.toHaveBeenCalled();
    },
  );

  it("threads the approval-worker signal through both bridge phases and stops an aborted replay before its boundary", async () => {
    const controller = new AbortController();
    const admittedHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "admitted plugin",
        auditEventId: "admitted-plugin-audit",
      }),
    );
    const runtime = createMutablePluginRuntime(admittedHandler);
    const resolve = vi.fn(
      async (
        _request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        expect(context.signal).toBe(controller.signal);
        if (context.phase === "pre_execute") {
          await Promise.resolve();
          controller.abort();
        }
        return {
          status: "verified",
          snapshotId: `approved-signal-${context.phase}`,
          canonicalCwd: "F:\\canonical\\project",
          snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
        };
      },
    );
    const markExternalCallStarted = vi.fn();
    const host = createHost({ resolve, pluginToolOverrideService: runtime.service });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeApprovedExternalRuntimeTool(createRequest(), markExternalCallStarted, {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: approved external runtime invocation was cancelled before execution",
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(markExternalCallStarted).not.toHaveBeenCalled();
    expect(admittedHandler).not.toHaveBeenCalled();
  });

  it("passes only the process-local resolver signal into path verification", async () => {
    const trustedSignal = new AbortController().signal;
    const callerSignal = new AbortController().signal;
    const resolve = vi.fn(
      async (
        _request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        expect(context.signal).toBe(trustedSignal);
        expect(context.signal).not.toBe(callerSignal);
        return {
          status: "verified",
          snapshotId: "trusted-signal-snapshot",
          canonicalCwd: "F:\\canonical\\project",
        };
      },
    );
    const request = { ...createRequest(), signal: callerSignal };
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve }));

    await expect(coordinator.invokeTool(request, { workspacePathBridgeSignal: trustedSignal })).resolves.toMatchObject({
      outcome: "executed",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("re-resolves the final hookable cwd immediately before policy execution", async () => {
    const order: string[] = [];
    const historicalInspect = vi.fn(() => ({ status: "verified", canonicalCwd: "F:\\stale" }));
    const resolve = vi.fn(
      async (
        request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        order.push("bridge");
        expect(request.args).toEqual({ command: "git status --short", cwd: "/mnt/f/hooked/project" });
        expect(context).toMatchObject({ phase: "policy" });
        return {
          status: "verified",
          snapshotId: "path-verification-1",
          canonicalCwd: "F:\\canonical\\project",
        };
      },
    );
    const invoke = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      order.push("policy");
      expect(request.args).toEqual({ command: "git status --short", cwd: "F:\\canonical\\project" });
      return { outcome: "executed", policyReason: "allowed", auditEventId: "audit-1" };
    });
    const runInlineHooks = vi.fn(async () => ({
      runs: [],
      patch: { args: { command: "git status --short", cwd: "/mnt/f/hooked/project" } },
    })) as unknown as ToolInvocationCoordinatorHost["hooksService"]["runInlineHooks"];
    const request = createRequest();
    const host = createHost({ resolve, invoke, runInlineHooks });
    const coordinator = new ToolInvocationCoordinatorService(host);

    await expect(coordinator.invokeTool(request)).resolves.toMatchObject({ outcome: "executed" });

    expect(order).toEqual(["bridge", "policy"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(historicalInspect).not.toHaveBeenCalled();
    expect(request.args.cwd).toBe("F:\\workspace\\project");
    expect(host.recordEvidenceEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ workspacePathBridgeSnapshotIds: ["path-verification-1"] }),
      }),
    );
  });

  it("preserves the initial cross-flavor cwd through hooks until fresh resolution", async () => {
    const rawCwd = "/f/Work Space\\Project";
    const resolve = vi.fn(
      async (
        request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        expect(request.args.cwd).toBe(rawCwd);
        expect(context.phase).toBe("policy");
        return { status: "verified", snapshotId: "initial-msys", canonicalCwd: "F:\\Work Space\\Project" };
      },
    );
    const invoke = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      expect(request.args.cwd).toBe("F:\\Work Space\\Project");
      return { outcome: "executed", policyReason: "allowed", auditEventId: "audit-1" };
    });
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));

    await expect(coordinator.invokeTool(createRequest(rawCwd))).resolves.toMatchObject({ outcome: "executed" });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(["shell.exec", "shell.exec_background", "tests.run", "lint.run", "build.run"])(
    "fails closed when the mandatory resolver is absent for %s",
    async (toolName) => {
      const invoke = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "unsafe",
          auditEventId: "audit-1",
        }),
      );
      const coordinator = new ToolInvocationCoordinatorService(createHost({ invoke }));

      const result = await coordinator.invokeTool({ ...createRequest(), toolName });

      expect(result).toMatchObject({
        outcome: "blocked",
        result: { workspacePathBridge: { status: "blocked" } },
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("fails closed before policy when fresh bridge evidence is blocked", async () => {
    const rawPath = "F:\\operator-secret\\outside";
    const resolve = vi.fn(
      async (): Promise<WorkspacePathBridgeExecutionDecision> => ({
        status: "blocked",
        reasonCode: "outside_jail",
        snapshotId: "blocked-snapshot",
      }),
    );
    const invoke = vi.fn(async (): Promise<ToolInvokeResult> => {
      throw new Error("policy must not execute");
    });
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));

    const result = await coordinator.invokeTool(createRequest(rawPath));

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: workspace path was not freshly verified for execution",
      result: {
        workspacePathBridge: {
          status: "blocked",
          reasonCode: "outside_jail",
          snapshotId: "blocked-snapshot",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawPath);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    [
      "throws",
      vi.fn(async () => {
        throw new Error("F:\\secret\\must-not-leak");
      }),
    ],
    ["returns malformed evidence", vi.fn(async () => ({ status: "verified", snapshotId: "missing-cwd" }))],
    [
      "returns a relative execution cwd",
      vi.fn(async () => ({ status: "verified", snapshotId: "relative-cwd", canonicalCwd: "relative\\path" })),
    ],
  ])("fails closed when the fresh resolver %s", async (_label, unsafeResolve) => {
    const invoke = vi.fn(async (): Promise<ToolInvokeResult> => {
      throw new Error("policy must not execute");
    });
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        resolve: unsafeResolve as unknown as (
          request: ToolInvokeRequest,
        ) => Promise<WorkspacePathBridgeExecutionDecision>,
        invoke,
      }),
    );

    const result = await coordinator.invokeTool(createRequest());

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toBe("blocked: workspace path was not freshly verified for execution");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects verified cwd evidence when the final tool request has no cwd binding", async () => {
    const resolve = vi.fn(
      async (): Promise<WorkspacePathBridgeExecutionDecision> => ({
        status: "verified",
        snapshotId: "path-verification-1",
        canonicalCwd: "F:\\canonical\\project",
      }),
    );
    const invoke = vi.fn(async (): Promise<ToolInvokeResult> => {
      throw new Error("policy must not execute");
    });
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));
    const request = createRequest();
    delete request.args.cwd;

    const result = await coordinator.invokeTool(request);

    expect(result.outcome).toBe("blocked");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not let a stale historical inspect authorize execution after retargeting", async () => {
    let retargeted = false;
    const historicalInspect = vi.fn(() => ({
      status: "verified",
      snapshotId: "historical-verification",
      canonicalCwd: "F:\\old-target",
    }));
    const resolve = vi.fn(
      async (): Promise<WorkspacePathBridgeExecutionDecision> =>
        retargeted
          ? { status: "blocked", reasonCode: "symlink_escape" }
          : {
              status: "verified",
              snapshotId: "fresh-verification",
              canonicalCwd: "F:\\canonical\\project",
            },
    );
    const invoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-1",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));

    await expect(coordinator.invokeTool(createRequest())).resolves.toMatchObject({ outcome: "executed" });
    retargeted = true;
    await expect(coordinator.invokeTool(createRequest())).resolves.toMatchObject({
      outcome: "blocked",
      result: { workspacePathBridge: { reasonCode: "symlink_escape" } },
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(historicalInspect).not.toHaveBeenCalled();
  });

  it("enforces fresh bridge evidence before plugin policy and revalidates immediately before the handler", async () => {
    const order: string[] = [];
    const resolve = vi.fn(
      async (
        request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> => {
        order.push(`bridge:${context.phase}`);
        if (context.phase === "policy") {
          expect(request.args.cwd).toBe("/f/Work Space/Project");
        } else {
          expect(request.args.cwd).toBe("F:\\Work Space\\Project");
        }
        return {
          status: "verified",
          snapshotId: `plugin-${context.phase}`,
          canonicalCwd: "F:\\Work Space\\Project",
          snapshotFingerprintSha256: STABLE_BRIDGE_FINGERPRINT,
        };
      },
    );
    const invoke = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      order.push("policy");
      expect(request).toMatchObject({ externalRuntime: true, args: { cwd: "F:\\Work Space\\Project" } });
      return { outcome: "executed", policyReason: "allowed", auditEventId: "policy-audit" };
    });
    const pluginHandler = vi.fn(async (args: Record<string, unknown>, context: unknown): Promise<ToolInvokeResult> => {
      order.push("plugin");
      expect(args.cwd).toBe("F:\\Work Space\\Project");
      expect(context).toMatchObject({ request: { args: { cwd: "F:\\Work Space\\Project" } } });
      return { outcome: "executed", policyReason: "plugin allowed", auditEventId: "plugin-audit" };
    });
    const host = createHost({ resolve, invoke, pluginHandler });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeTool(createRequest("/f/Work Space/Project"));

    expect(order).toEqual(["bridge:policy", "policy", "bridge:pre_execute", "plugin"]);
    expect(result).toMatchObject({ outcome: "executed" });
    expect(host.recordEvidenceEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspacePathBridgeSnapshotIds: ["plugin-policy", "plugin-pre_execute"],
        }),
      }),
    );
  });

  it("blocks a plugin when the pre-execute TOCTOU revalidation detects retargeting", async () => {
    const resolve = vi.fn(
      async (
        _request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> =>
        context.phase === "policy"
          ? { status: "verified", snapshotId: "policy-snapshot", canonicalCwd: "F:\\canonical\\project" }
          : { status: "blocked", reasonCode: "symlink_escape", snapshotId: "pre-execute-snapshot" },
    );
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "unsafe",
        auditEventId: "plugin-audit",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, pluginHandler }));

    const result = await coordinator.invokeTool(createRequest());

    expect(result).toMatchObject({
      outcome: "blocked",
      result: {
        workspacePathBridge: {
          status: "blocked",
          reasonCode: "symlink_escape",
          snapshotId: "pre-execute-snapshot",
          priorVerifiedSnapshotIds: ["policy-snapshot"],
        },
      },
    });
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("preserves non-cwd invocations without a bridge resolver", async () => {
    const invoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-1",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(createHost({ invoke }));
    const request = { ...createRequest(), toolName: "fs.read", args: { path: "README.md" } };

    await coordinator.invokeTool(request);

    expect(invoke).toHaveBeenCalledWith(request);
  });

  it("rejects not-applicable from a resolver for a mandatory cwd tool", async () => {
    const resolve = vi.fn(async (): Promise<WorkspacePathBridgeExecutionDecision> => ({ status: "not_applicable" }));
    const invoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "unsafe",
        auditEventId: "audit-1",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));

    await expect(coordinator.invokeTool(createRequest())).resolves.toMatchObject({ outcome: "blocked" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
