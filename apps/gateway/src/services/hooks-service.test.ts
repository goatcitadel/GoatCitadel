import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveHookPhase,
  type HookCreateInput,
  type HookDecision,
  type HookPatchSummary,
  type HookRecord,
  type HookRunRecord,
  type HookTrigger,
  type WorkspaceRecord,
} from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { ServiceContext } from "./service-context.js";
import { HooksService } from "./hooks-service.js";

describe("HooksService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("orders inline hooks by priority and merges patches deterministically", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: {
        hooks: {
          allowMutatingHooks: true,
        },
      },
      fetchImpl: async (url) => {
        const endpoint = typeof url === "string" ? url : url.toString();
        const body = endpoint.includes("high")
          ? { patch: { providerId: "primary", model: "high" } }
          : { patch: { model: "low" } };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });

    const low = service.createWorkspaceHook({
      workspaceId,
      label: "low",
      trigger: "llm.model.select.before",
      mode: "mutate",
      priority: 100,
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/low",
        },
      },
    });
    const high = service.createWorkspaceHook({
      workspaceId,
      label: "high",
      trigger: "llm.model.select.before",
      mode: "mutate",
      priority: 200,
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/high",
        },
      },
    });

    const result = await service.runInlineHooks<{
      providerId?: string;
      model?: string;
      order?: string[];
    }>({
      workspaceId,
      trigger: "llm.model.select.before",
      entityType: "chat_completion",
      entityId: "session-1",
      payload: {
        providerId: "default",
        model: "baseline",
      },
      parsePatch: (value) => {
        const model = typeof value.model === "string" ? value.model : undefined;
        const providerId = typeof value.providerId === "string" ? value.providerId : undefined;
        if (!model && !providerId) {
          return undefined;
        }
        return {
          ...(providerId ? { providerId } : {}),
          ...(model ? { model, order: [model] } : {}),
        };
      },
      mergePatch: (current, next) => ({
        ...(current ?? {}),
        ...next,
        order: [...(current?.order ?? []), ...(next.order ?? [])],
      }),
    });

    expect(result.blockedBy).toBeUndefined();
    expect(result.runs.map((run) => run.hookId)).toEqual([high.hookId, low.hookId]);
    expect(result.patch).toEqual({
      providerId: "primary",
      model: "low",
      order: ["high", "low"],
    });
  });

  it("times out fail-open hooks without blocking the caller", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: {
        hooks: {
          allowMutatingHooks: true,
        },
      },
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("timed out"));
            },
            { once: true },
          );
        }),
    });

    service.createWorkspaceHook({
      workspaceId,
      label: "timeout",
      trigger: "tool.call.before",
      mode: "mutate",
      timeoutMs: 25,
      failPolicy: "open",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/timeout",
        },
      },
    });

    const result = await service.runInlineHooks({
      workspaceId,
      trigger: "tool.call.before",
      entityType: "tool_call",
      entityId: "tool-1",
      payload: {
        toolName: "shell.exec",
      },
      parsePatch: () => undefined,
    });

    expect(result.blockedBy).toBeUndefined();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.status).toBe("timed_out");
  });

  it("throws for fail-closed intercept hooks when the webhook fails", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: {
        hooks: {
          allowInterceptingHooks: true,
        },
      },
      fetchImpl: async () => {
        throw new Error("downstream unavailable");
      },
    });

    service.createWorkspaceHook({
      workspaceId,
      label: "fail-closed",
      trigger: "llm.request.before",
      mode: "intercept",
      failPolicy: "closed",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/fail-closed",
        },
      },
    });

    await expect(
      service.runInlineHooks({
        workspaceId,
        trigger: "llm.request.before",
        entityType: "chat_completion",
        entityId: "session-closed",
        payload: {
          messages: [],
        },
        parsePatch: () => undefined,
      }),
    ).rejects.toThrow(/fail-closed/i);
  });

  it("skips recursive execution of the same hook/entity pair", async () => {
    let nestedResult: Awaited<ReturnType<HooksService["runInlineHooks"]>> | undefined;
    const harness = createHarness({
      workspacePrefs: {
        hooks: {
          allowMutatingHooks: true,
        },
      },
      fetchImpl: async () => {
        if (!nestedResult) {
          nestedResult = await harness.service.runInlineHooks({
            workspaceId: harness.workspaceId,
            trigger: "tool.call.before",
            entityType: "tool_call",
            entityId: "recursive-tool",
            payload: {
              toolName: "shell.exec",
            },
            parsePatch: () => undefined,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    harness.service.createWorkspaceHook({
      workspaceId: harness.workspaceId,
      label: "recursive",
      trigger: "tool.call.before",
      mode: "mutate",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/recursive",
        },
      },
    });

    const result = await harness.service.runInlineHooks({
      workspaceId: harness.workspaceId,
      trigger: "tool.call.before",
      entityType: "tool_call",
      entityId: "recursive-tool",
      payload: {
        toolName: "shell.exec",
      },
      parsePatch: () => undefined,
    });

    expect(result.runs[0]?.status).toBe("completed");
    expect(nestedResult?.runs[0]?.status).toBe("skipped");
  });

  it("queues after hooks and signs outbound delivery with an idempotency header", async () => {
    let capturedHeaders: Headers | undefined;
    const { service, workspaceId, requestedRunIds } = createHarness({
      fetchImpl: async (_url, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    service.createWorkspaceHook({
      workspaceId,
      label: "after",
      trigger: "tool.call.after",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/after",
          secret: "super-secret",
        },
      },
    });

    const queued = service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-1",
      payload: {
        toolName: "shell.exec",
        outcome: "executed",
      },
    });

    expect(queued).toHaveLength(1);
    expect(queued[0]?.durableRunId).toMatch(/^durable-/);
    expect(requestedRunIds).toEqual([queued[0]?.durableRunId]);

    const delivered = await service.executeHookDelivery(queued[0]!.runId, 1);
    expect(delivered.status).toBe("completed");
    expect(capturedHeaders?.get("x-goatcitadel-idempotency-key")).toBeTruthy();
    expect(capturedHeaders?.get("x-goatcitadel-signature")).toMatch(/^sha256=/);
  });

  it("deduplicates repeated after-hook enqueue requests for the same hook/entity pair", () => {
    const { service, workspaceId, requestedRunIds } = createHarness();

    service.createWorkspaceHook({
      workspaceId,
      label: "after-dedupe",
      trigger: "tool.call.after",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/after-dedupe",
        },
      },
    });

    const first = service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-dedupe",
      payload: {
        toolName: "shell.exec",
      },
    });
    const second = service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-dedupe",
      payload: {
        toolName: "shell.exec",
      },
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.runId).toBe(first[0]?.runId);
    expect(requestedRunIds).toEqual([first[0]?.durableRunId, first[0]?.durableRunId]);
  });

  it("aborts durable hook delivery without dead-lettering the hook run", async () => {
    const controller = new AbortController();
    const { service, workspaceId } = createHarness({
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    });

    service.createWorkspaceHook({
      workspaceId,
      label: "after-abort",
      trigger: "tool.call.after",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/after-abort",
        },
      },
    });

    const queued = service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-abort",
      payload: {
        toolName: "shell.exec",
      },
    });

    const runPromise = service.executeHookDelivery(queued[0]!.runId, 1, { signal: controller.signal });
    controller.abort(new Error("lease lost"));

    await expect(runPromise).rejects.toThrow("lease lost");
    expect(service.listWorkspaceHookRuns(workspaceId)[0]?.status).toBe("running");
  });

  it("rejects hook creation for unknown workspaces even in observe mode", () => {
    const { service } = createHarness();

    expect(() =>
      service.createWorkspaceHook({
        workspaceId: "missing-workspace",
        label: "observe",
        trigger: "tool.call.after",
        mode: "observe",
        action: {
          type: "webhook",
          webhook: {
            url: "https://hooks.example.test/observe",
          },
        },
      }),
    ).toThrow(/Unknown workspace/);
  });

  it("skips after-hook delivery when the durable kernel is disabled", () => {
    const { service, workspaceId, requestedRunIds } = createHarness({
      durableKernelEnabled: false,
    });

    service.createWorkspaceHook({
      workspaceId,
      label: "after-disabled",
      trigger: "tool.call.after",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/after-disabled",
        },
      },
    });

    const queued = service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-disabled",
      payload: {
        toolName: "shell.exec",
      },
    });

    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe("skipped");
    expect(queued[0]?.errorText).toBe("durable_kernel_disabled");
    expect(queued[0]?.durableRunId).toBeUndefined();
    expect(requestedRunIds).toEqual([]);
  });

  it("keeps runtime lifecycle triggers observe-only and phases them correctly", () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: {
        hooks: {
          allowMutatingHooks: true,
        },
      },
    });

    expect(deriveHookPhase("before_prompt_build")).toBe("before");
    expect(deriveHookPhase("agent_end")).toBe("after");
    expect(() =>
      service.createWorkspaceHook({
        workspaceId,
        label: "agent-end-mutate",
        trigger: "agent_end",
        mode: "mutate",
        action: {
          type: "webhook",
          webhook: {
            url: "https://hooks.example.test/agent-end",
          },
        },
      }),
    ).toThrow(/observe hooks/i);
  });
});

function createHarness(input?: {
  workspacePrefs?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  durableKernelEnabled?: boolean;
}) {
  const workspaceId = "ws_test";
  const workspace: WorkspaceRecord = {
    workspaceId,
    name: "Hooks Workspace",
    slug: "hooks-workspace",
    lifecycleStatus: "active",
    workspacePrefs: input?.workspacePrefs,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
  };
  const hooks = new Map<string, HookRecord>();
  const hookRuns = new Map<string, HookRunRecord>();
  const requestedRunIds: string[] = [];
  let hookIndex = 0;
  let hookRunIndex = 0;
  let durableIndex = 0;

  const storage = {
    workspaces: {
      get: (id: string) => {
        if (id !== workspace.workspaceId) {
          throw new Error(`Unknown workspace ${id}`);
        }
        return workspace;
      },
    },
    systemSettings: {
      get: () => undefined,
    },
    audit: {
      append: async () => undefined,
    },
    workspaceHooks: {
      list: (id: string) => [...hooks.values()].filter((hook) => hook.workspaceId === id),
      listByTrigger: (id: string, trigger: HookTrigger) =>
        [...hooks.values()]
          .filter((hook) => hook.workspaceId === id && hook.trigger === trigger && hook.enabled)
          .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt)),
      get: (id: string, hookId: string) => {
        const record = hooks.get(hookId);
        if (!record || record.workspaceId !== id) {
          throw new Error(`Unknown hook ${hookId}`);
        }
        return record;
      },
      create: (input: HookCreateInput) => {
        const hookId = `hook-${++hookIndex}`;
        const record: HookRecord = {
          hookId,
          workspaceId: input.workspaceId,
          label: input.label,
          trigger: input.trigger,
          phase: deriveHookPhase(input.trigger),
          mode: input.mode,
          enabled: input.enabled !== false,
          priority: input.priority ?? 100,
          timeoutMs: input.timeoutMs ?? 5_000,
          failPolicy: input.failPolicy ?? "open",
          action: input.action,
          createdAt: `2026-03-26T00:00:0${hookIndex}.000Z`,
          updatedAt: `2026-03-26T00:00:0${hookIndex}.000Z`,
        };
        hooks.set(hookId, record);
        return record;
      },
      update: (id: string, hookId: string, input: Partial<HookCreateInput>) => {
        const current = hooks.get(hookId);
        if (!current || current.workspaceId !== id) {
          throw new Error(`Unknown hook ${hookId}`);
        }
        const next: HookRecord = {
          ...current,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.failPolicy !== undefined ? { failPolicy: input.failPolicy } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          updatedAt: "2026-03-26T00:01:00.000Z",
        };
        hooks.set(hookId, next);
        return next;
      },
      delete: (id: string, hookId: string) => {
        const current = hooks.get(hookId);
        if (!current || current.workspaceId !== id) {
          return false;
        }
        return hooks.delete(hookId);
      },
    },
    hookRuns: {
      create: (input: Omit<HookRunRecord, "runId" | "createdAt" | "updatedAt">) => {
        const runId = `hookrun-${++hookRunIndex}`;
        const record: HookRunRecord = {
          ...input,
          runId,
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z",
        };
        hookRuns.set(runId, record);
        return record;
      },
      get: (runId: string) => {
        const record = hookRuns.get(runId);
        if (!record) {
          throw new Error(`Unknown hook run ${runId}`);
        }
        return record;
      },
      findByIdempotency: (hookId: string, idempotencyKey: string) =>
        [...hookRuns.values()].find((run) => run.hookId === hookId && run.idempotencyKey === idempotencyKey),
      listByWorkspace: (id: string) => [...hookRuns.values()].filter((run) => run.workspaceId === id),
      markAttempt: (
        runId: string,
        input: {
          status: HookRunRecord["status"];
          attemptCount: number;
          errorText?: string;
          requestPayload?: Record<string, unknown>;
        },
      ) => {
        const current = hookRuns.get(runId);
        if (!current) {
          throw new Error(`Unknown hook run ${runId}`);
        }
        const next: HookRunRecord = {
          ...current,
          status: input.status,
          attemptCount: input.attemptCount,
          errorText: input.errorText,
          requestPayload: input.requestPayload ?? current.requestPayload,
          updatedAt: "2026-03-26T00:00:10.000Z",
        };
        hookRuns.set(runId, next);
        return next;
      },
      markOutcome: (
        runId: string,
        input: {
          status: HookRunRecord["status"];
          decision?: HookDecision;
          patchSummary?: HookPatchSummary;
          errorText?: string;
          latencyMs?: number;
          responsePayload?: Record<string, unknown>;
          completedAt?: string;
        },
      ) => {
        const current = hookRuns.get(runId);
        if (!current) {
          throw new Error(`Unknown hook run ${runId}`);
        }
        const next: HookRunRecord = {
          ...current,
          status: input.status,
          decision: input.decision,
          patchSummary: input.patchSummary,
          errorText: input.errorText,
          latencyMs: input.latencyMs,
          responsePayload: input.responsePayload,
          completedAt: input.completedAt ?? "2026-03-26T00:00:20.000Z",
          updatedAt: "2026-03-26T00:00:20.000Z",
        };
        hookRuns.set(runId, next);
        return next;
      },
      attachDurableRun: (runId: string, durableRunId: string) => {
        const current = hookRuns.get(runId);
        if (!current) {
          throw new Error(`Unknown hook run ${runId}`);
        }
        const next: HookRunRecord = {
          ...current,
          durableRunId,
          updatedAt: "2026-03-26T00:00:05.000Z",
        };
        hookRuns.set(runId, next);
        return next;
      },
    },
  };

  const ctx: ServiceContext = {
    storage: storage as never,
    config: {
      assistant: {
        durable: {
          enabled: true,
        },
      },
    } as GatewayRuntimeConfig,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: {} as never,
    publishRealtime: () => undefined,
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: (flag) => (flag === "durableKernelV1Enabled" ? (input?.durableKernelEnabled ?? true) : true),
    normalizeWorkspaceId: (value?: string) => value?.trim() || workspaceId,
  };

  const service = new HooksService(ctx, {
    createDurableRun: () => ({
      runId: `durable-${++durableIndex}`,
      status: "queued",
    }),
    requestDurableRunProcessing: (runId) => {
      requestedRunIds.push(runId);
    },
    fetchImpl: input?.fetchImpl,
  });

  return {
    service,
    workspaceId,
    requestedRunIds,
  };
}
