import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationCoordinatorHost,
  type WorkspacePathBridgeExecutionDecision,
  type WorkspacePathBridgeResolutionContext,
} from "./tool-invocation-coordinator-service.js";
import type { ToolProcessSpawnBoundary } from "@goatcitadel/policy-engine";

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

  it.each(BRIDGE_STABILITY_CASES)(
    "enforces builtin bridge stability for $label",
    async ({ policy, preExecute, expectedReason }) => {
      const resolve = vi.fn(
        async (
          _request: ToolInvokeRequest,
          context: WorkspacePathBridgeResolutionContext,
        ): Promise<WorkspacePathBridgeExecutionDecision> =>
          verifiedBridgeDecision(
            `builtin-stability-${context.phase}`,
            context.phase === "policy" ? policy : preExecute,
          ),
      );
      const invoke = vi.fn(
        async (
          request: ToolInvokeRequest,
          options?: { beforeExecute?: (boundary?: ToolProcessSpawnBoundary) => void | Promise<void> },
        ): Promise<ToolInvokeResult> => {
          await options?.beforeExecute?.({ toolName: "shell.exec", cwd: String(request.args.cwd) });
          return { outcome: "executed", policyReason: "allowed", auditEventId: "audit-stability" };
        },
      );
      const host = createHost({ resolve, invoke });
      const coordinator = new ToolInvocationCoordinatorService(host);
      const executionFence = vi.fn();

      const invocation = coordinator.invokeTool(createRequest(), { executionFence });

      if (!expectedReason) {
        await expect(invocation).resolves.toMatchObject({ outcome: "executed" });
        expect(executionFence).toHaveBeenCalledTimes(1);
        return;
      }
      await expect(invocation).rejects.toMatchObject({
        name: "ToolExecutionPreconditionError",
        result: {
          workspacePathBridge: {
            status: "blocked",
            reasonCode: expectedReason,
            snapshotId: "builtin-stability-pre_execute",
          },
        },
      });
      expect(host.policyEngine.invoke).toHaveBeenCalledTimes(1);
      expect(executionFence).not.toHaveBeenCalled();
    },
  );

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

  it("blocks a builtin when the pre-execute TOCTOU revalidation detects retargeting", async () => {
    const resolve = vi.fn(
      async (
        _request: ToolInvokeRequest,
        context: WorkspacePathBridgeResolutionContext,
      ): Promise<WorkspacePathBridgeExecutionDecision> =>
        context.phase === "policy"
          ? { status: "verified", snapshotId: "policy-snapshot", canonicalCwd: "F:\\canonical\\project" }
          : { status: "blocked", reasonCode: "symlink_escape", snapshotId: "pre-execute-snapshot" },
    );
    const spawned = vi.fn();
    const invoke = vi.fn(
      async (
        request: ToolInvokeRequest,
        options?: { beforeExecute?: (boundary?: ToolProcessSpawnBoundary) => void | Promise<void> },
      ): Promise<ToolInvokeResult> => {
        await options?.beforeExecute?.({ toolName: "shell.exec", cwd: String(request.args.cwd) });
        spawned();
        return { outcome: "executed", policyReason: "unsafe", auditEventId: "audit-unsafe" };
      },
    );
    const coordinator = new ToolInvocationCoordinatorService(createHost({ resolve, invoke }));

    await expect(coordinator.invokeTool(createRequest())).rejects.toMatchObject({
      name: "ToolExecutionPreconditionError",
      result: {
        workspacePathBridge: {
          status: "blocked",
          reasonCode: "symlink_escape",
          snapshotId: "pre-execute-snapshot",
        },
      },
    });
    expect(spawned).not.toHaveBeenCalled();
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

    expect(invoke).toHaveBeenCalledWith(request, { beforeExecute: expect.any(Function) });
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
