import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveHookPhase,
  NotFoundError,
  type DurableRunRecord,
  type HookCreateInput,
  type HookDecision,
  type HookPatchSummary,
  type HookRecord,
  type HookRunRecord,
  type HookTrigger,
  type WorkspaceRecord,
} from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import { projectHookRecordForPublicResponse } from "./hooks-public-projection.js";
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

    const low = await service.createWorkspaceHook({
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
    const high = await service.createWorkspaceHook({
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

  it("crosses the caller-owned effect fence before the first tool hook webhook", async () => {
    const events: string[] = [];
    const { service, workspaceId } = createHarness({
      fetchImpl: async () => {
        events.push("fetch");
        expect(events).toEqual(["fence", "fetch"]);
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await service.createWorkspaceHook({
      workspaceId,
      label: "effect boundary",
      trigger: "tool.call.before",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/effect-boundary" } },
    });
    const expectedInterposition = await service.getToolCallBeforeInterposition(workspaceId);

    const result = await service.runInlineHooks({
      workspaceId,
      trigger: "tool.call.before",
      entityType: "tool_call",
      entityId: "tool-effect-boundary",
      payload: { toolName: "time.now" },
      expectedInterposition,
      beforeExternalDispatch: async () => {
        events.push("fence");
      },
    });

    expect(result.runs).toHaveLength(1);
    expect(events).toEqual(["fence", "fetch"]);
  });

  it("rejects exact-list interposition drift before a tool hook webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const beforeExternalDispatch = vi.fn(async () => undefined);
    const { service, workspaceId } = createHarness({ fetchImpl });
    const hook = await service.createWorkspaceHook({
      workspaceId,
      label: "sealed hook",
      trigger: "tool.call.before",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/original" } },
    });
    const expectedInterposition = await service.getToolCallBeforeInterposition(workspaceId);
    await service.updateWorkspaceHook(workspaceId, hook.hookId, {
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/replaced" } },
    });

    await expect(
      service.runInlineHooks({
        workspaceId,
        trigger: "tool.call.before",
        entityType: "tool_call",
        entityId: "tool-drift",
        payload: { toolName: "time.now" },
        expectedInterposition,
        beforeExternalDispatch,
      }),
    ).rejects.toThrow(/interposition binding drifted/i);
    expect(beforeExternalDispatch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects after-hook action drift before the auxiliary fence or durable enqueue", async () => {
    const beforeExternalDispatch = vi.fn(async () => undefined);
    const { service, workspaceId } = createHarness();
    const hook = await service.createWorkspaceHook({
      workspaceId,
      label: "sealed after hook",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/original-after" } },
    });
    const expectedInterposition = await service.getToolCallBeforeInterposition(workspaceId);
    await service.updateWorkspaceHook(workspaceId, hook.hookId, {
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/replaced-after" } },
    });

    await expect(
      service.enqueueAfterHooks({
        workspaceId,
        trigger: "tool.call.after",
        entityType: "tool_call",
        entityId: "tool-after-drift",
        payload: { toolName: "time.now", outcome: "executed" },
        expectedInterposition,
        beforeExternalDispatch,
      }),
    ).rejects.toThrow(/interposition binding drifted/i);
    expect(beforeExternalDispatch).not.toHaveBeenCalled();
  });

  it("crosses the auxiliary effect fence before materializing an admitted after hook", async () => {
    const { service, workspaceId } = createHarness();
    await service.createWorkspaceHook({
      workspaceId,
      label: "admitted after hook",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/admitted-after" } },
    });
    const expectedInterposition = await service.getToolCallBeforeInterposition(workspaceId);
    const beforeExternalDispatch = vi.fn(async () => undefined);

    const runs = await service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-admitted",
      payload: { toolName: "time.now", outcome: "executed" },
      expectedInterposition,
      beforeExternalDispatch,
    });

    expect(beforeExternalDispatch).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
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

    await service.createWorkspaceHook({
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

    await service.createWorkspaceHook({
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

    await harness.service.createWorkspaceHook({
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
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const { service, workspaceId, requestedRunIds } = createHarness({
      fetchImpl,
    });

    await service.createWorkspaceHook({
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

    const queued = await service.enqueueAfterHooks({
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
    expect(queued[0]?.durableRunId).toBe(`hook-delivery-${queued[0]?.runId}`);
    expect(requestedRunIds).toEqual([queued[0]?.durableRunId]);

    const delivered = await service.executeHookDelivery(queued[0]!.runId, 1);
    const recovered = await service.executeHookDelivery(queued[0]!.runId, 2);
    expect(delivered.status).toBe("completed");
    expect(recovered.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedHeaders?.get("x-goatcitadel-idempotency-key")).toBeTruthy();
    expect(capturedHeaders?.get("x-goatcitadel-signature")).toMatch(/^sha256=/);
  });

  it("does not re-execute a dead-lettered hook delivery", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const { service, workspaceId } = createHarness({ fetchImpl });
    await service.createWorkspaceHook({
      workspaceId,
      label: "after-dead-letter",
      trigger: "tool.call.after",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: { url: "https://hooks.example.test/dead-letter" },
      },
    });
    const queued = (
      await service.enqueueAfterHooks({
        workspaceId,
        trigger: "tool.call.after",
        entityType: "tool_call",
        entityId: "tool-dead-letter",
        payload: { toolName: "shell.exec", outcome: "failed" },
      })
    )[0]!;
    const deadLettered = await service.markHookRunDeadLettered(queued.runId, "retry budget exhausted");

    await expect(service.executeHookDelivery(deadLettered.runId, 99)).resolves.toEqual(deadLettered);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("deduplicates repeated after-hook enqueue requests for the same hook/entity pair", async () => {
    const { service, workspaceId, requestedRunIds } = createHarness();

    await service.createWorkspaceHook({
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

    const first = await service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-dedupe",
      payload: {
        toolName: "shell.exec",
      },
    });
    const second = await service.enqueueAfterHooks({
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
    expect(first[0]?.idempotencyKey).toBe("tool.call.after:tool_call:tool-after-dedupe");
    expect(requestedRunIds).toEqual([first[0]?.durableRunId, first[0]?.durableRunId]);
  });

  it("repairs a queued unlinked after-hook with one deterministic durable child", async () => {
    const { service, workspaceId, requestedRunIds, hookRuns, durableRuns } = createHarness();
    const hook = await service.createWorkspaceHook({
      workspaceId,
      label: "after-gap-repair",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/after-gap-repair" } },
    });
    const hookRunId = "hookrun-gap-repair";
    hookRuns.set(hookRunId, {
      runId: hookRunId,
      hookId: hook.hookId,
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-gap-repair",
      mode: "observe",
      status: "queued",
      idempotencyKey: "tool.call.after:tool_call:tool-gap-repair",
      attemptCount: 0,
      requestPayload: { toolName: "shell.exec" },
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z",
    });

    const first = await service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-gap-repair",
      payload: { toolName: "shell.exec" },
    });
    const takeoverRetry = await service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-gap-repair",
      payload: { toolName: "shell.exec" },
    });

    const stableRunId = `hook-delivery-${hookRunId}`;
    expect(first[0]).toMatchObject({ runId: hookRunId, durableRunId: stableRunId });
    expect(takeoverRetry[0]?.runId).toBe(hookRunId);
    expect([...durableRuns.keys()]).toEqual([stableRunId]);
    expect(durableRuns.get(stableRunId)).toMatchObject({
      workflowKey: "hook.delivery",
      payload: { version: "hook.delivery.v1", hookRunId },
    });
    expect(requestedRunIds).toEqual([stableRunId, stableRunId]);
  });

  it("rolls back hook and deterministic durable creation when attachment fails, then retries cleanly", async () => {
    const { service, workspaceId, hookRuns, durableRuns } = createHarness({ failAttachOnce: true });
    await service.createWorkspaceHook({
      workspaceId,
      label: "after-attach-rollback",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/after-attach-rollback" } },
    });
    const input = {
      workspaceId,
      trigger: "tool.call.after" as const,
      entityType: "tool_call",
      entityId: "tool-attach-rollback",
      payload: { toolName: "shell.exec" },
    };

    await expect(service.enqueueAfterHooks(input)).rejects.toThrow("synthetic attach failure");
    expect(hookRuns.size).toBe(0);
    expect(durableRuns.size).toBe(0);

    const [repaired] = await service.enqueueAfterHooks(input);
    expect(repaired?.durableRunId).toBe(`hook-delivery-${repaired?.runId}`);
    expect(hookRuns.size).toBe(1);
    expect(durableRuns.size).toBe(1);
  });

  it("fails closed instead of adopting a foreign or corrupt durable hook linkage", async () => {
    const { service, workspaceId, requestedRunIds, hookRuns, durableRuns } = createHarness();
    const hook = await service.createWorkspaceHook({
      workspaceId,
      label: "after-link-fence",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/after-link-fence" } },
    });
    const seed = (runId: string, entityId: string, durableRunId?: string) => {
      hookRuns.set(runId, {
        runId,
        hookId: hook.hookId,
        workspaceId,
        trigger: "tool.call.after",
        entityType: "tool_call",
        entityId,
        mode: "observe",
        status: "queued",
        idempotencyKey: `tool.call.after:tool_call:${entityId}`,
        attemptCount: 0,
        ...(durableRunId ? { durableRunId } : {}),
        createdAt: "2026-03-26T00:00:00.000Z",
        updatedAt: "2026-03-26T00:00:00.000Z",
      });
    };
    seed("hookrun-foreign", "tool-foreign", "durable-foreign");
    await expect(
      service.enqueueAfterHooks({
        workspaceId,
        trigger: "tool.call.after",
        entityType: "tool_call",
        entityId: "tool-foreign",
        payload: {},
      }),
    ).rejects.toThrow(/foreign durable linkage/);

    const corruptHookRunId = "hookrun-corrupt";
    const stableRunId = `hook-delivery-${corruptHookRunId}`;
    seed(corruptHookRunId, "tool-corrupt");
    durableRuns.set(stableRunId, {
      runId: stableRunId,
      workflowKey: "foreign.workflow",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 1,
      payload: { hookRunId: "someone-else" },
      version: 1,
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z",
    });
    await expect(
      service.enqueueAfterHooks({
        workspaceId,
        trigger: "tool.call.after",
        entityType: "tool_call",
        entityId: "tool-corrupt",
        payload: {},
      }),
    ).rejects.toThrow(/does not match hook delivery owner/);
    expect(requestedRunIds).toEqual([]);
  });

  it("deduplicates agent-end retries per semantic status without suppressing pause-to-complete progression", async () => {
    const { service, workspaceId, requestedRunIds } = createHarness();

    await service.createWorkspaceHook({
      workspaceId,
      label: "agent-end-lifecycle",
      trigger: "agent_end",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/agent-end-lifecycle",
        },
      },
    });

    const enqueue = async (status: "waiting_for_approval" | "completed") =>
      await service.enqueueAfterHooks({
        workspaceId,
        trigger: "agent_end",
        entityType: "chat_turn",
        entityId: "turn-agent-end-lifecycle",
        idempotencyDiscriminator: status,
        payload: { status },
      });

    const waiting = await enqueue("waiting_for_approval");
    const waitingRetry = await enqueue("waiting_for_approval");
    const completed = await enqueue("completed");
    const completedRetry = await enqueue("completed");

    expect(waitingRetry[0]?.runId).toBe(waiting[0]?.runId);
    expect(completedRetry[0]?.runId).toBe(completed[0]?.runId);
    expect(completed[0]?.runId).not.toBe(waiting[0]?.runId);
    expect(waiting[0]?.durableRunId).not.toBe(completed[0]?.durableRunId);
    expect(waiting[0]?.idempotencyKey).toBe("agent_end:chat_turn:turn-agent-end-lifecycle:waiting_for_approval");
    expect(completed[0]?.idempotencyKey).toBe("agent_end:chat_turn:turn-agent-end-lifecycle:completed");
    expect(requestedRunIds).toEqual([
      waiting[0]?.durableRunId,
      waiting[0]?.durableRunId,
      completed[0]?.durableRunId,
      completed[0]?.durableRunId,
    ]);
  });

  it("delivers overlapping agent-end statuses without treating semantic progression as recursion", async () => {
    let releaseWaiting!: () => void;
    let markWaitingStarted!: () => void;
    const waitingStarted = new Promise<void>((resolve) => {
      markWaitingStarted = resolve;
    });
    const waitingGate = new Promise<void>((resolve) => {
      releaseWaiting = resolve;
    });
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        markWaitingStarted();
        await waitingGate;
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const { service, workspaceId } = createHarness({ fetchImpl });

    await service.createWorkspaceHook({
      workspaceId,
      label: "agent-end-overlap",
      trigger: "agent_end",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: { url: "https://hooks.example.test/agent-end-overlap" },
      },
    });
    const enqueue = async (status: "waiting_for_approval" | "completed") =>
      (
        await service.enqueueAfterHooks({
          workspaceId,
          trigger: "agent_end",
          entityType: "chat_turn",
          entityId: "turn-agent-end-overlap",
          idempotencyDiscriminator: status,
          payload: { status },
        })
      )[0]!;
    const waiting = await enqueue("waiting_for_approval");
    const completed = await enqueue("completed");

    const waitingDelivery = service.executeHookDelivery(waiting.runId, 1);
    await waitingStarted;
    const completedDelivery = await service.executeHookDelivery(completed.runId, 1);
    releaseWaiting();
    const waitingResult = await waitingDelivery;

    expect(waitingResult.status).toBe("completed");
    expect(completedDelivery.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts durable hook delivery without dead-lettering the hook run", async () => {
    const controller = new AbortController();
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const { service, workspaceId } = createHarness({
      fetchImpl: (_url, init) => {
        markDeliveryStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    });

    await service.createWorkspaceHook({
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

    const queued = await service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-abort",
      payload: {
        toolName: "shell.exec",
      },
    });

    const runPromise = service.executeHookDelivery(queued[0]!.runId, 1, { signal: controller.signal });
    await deliveryStarted;
    controller.abort(new Error("lease lost"));

    await expect(runPromise).rejects.toThrow("lease lost");
    expect((await service.listWorkspaceHookRuns(workspaceId))[0]?.status).toBe("running");
  });

  it("keeps a delivered hook completed when realtime projection fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const { service, workspaceId } = createHarness({
      fetchImpl,
      publishRealtime: (eventType) => {
        if (eventType === "hook_run_updated") {
          throw new Error("retained stream unavailable");
        }
      },
    });
    await service.createWorkspaceHook({
      workspaceId,
      label: "after-commit-truth",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/after-commit-truth" } },
    });
    const [queued] = await service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-commit-truth",
      payload: { toolName: "shell.exec" },
    });

    await expect(service.executeHookDelivery(queued!.runId, 1)).resolves.toMatchObject({ status: "completed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await service.listWorkspaceHookRuns(workspaceId))[0]?.status).toBe("completed");
  });

  it("records returned webhook success despite a late lease abort", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort(new Error("lease expired after remote commit"));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const { service, workspaceId } = createHarness({ fetchImpl });
    await service.createWorkspaceHook({
      workspaceId,
      label: "after-late-abort",
      trigger: "tool.call.after",
      mode: "observe",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/after-late-abort" } },
    });
    const [queued] = await service.enqueueAfterHooks({
      workspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: "tool-after-late-abort",
      payload: { toolName: "shell.exec" },
    });

    await expect(service.executeHookDelivery(queued!.runId, 1, { signal: controller.signal })).resolves.toMatchObject({
      status: "completed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects hook creation for unknown workspaces even in observe mode", async () => {
    const { service } = createHarness();

    await expect(
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
    ).rejects.toThrow(/Unknown workspace/);
  });

  it("skips after-hook delivery when the durable kernel is disabled", async () => {
    const { service, workspaceId, requestedRunIds } = createHarness({
      durableKernelEnabled: false,
    });

    await service.createWorkspaceHook({
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

    const queued = await service.enqueueAfterHooks({
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

  it("accepts gateway.dispatch.before for intercept mode hooks", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: { hooks: { allowInterceptingHooks: true } },
    });
    const created = await service.createWorkspaceHook({
      workspaceId,
      label: "dispatch-veto",
      trigger: "gateway.dispatch.before",
      mode: "intercept",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/dispatch" } },
    });
    expect(created.trigger).toBe("gateway.dispatch.before");
    expect(created.mode).toBe("intercept");
  });

  it("rejects gateway.dispatch.before for mutate mode hooks", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: { hooks: { allowMutatingHooks: true, allowInterceptingHooks: true } },
    });
    await expect(
      service.createWorkspaceHook({
        workspaceId,
        label: "dispatch-mutate",
        trigger: "gateway.dispatch.before",
        mode: "mutate",
        action: { type: "webhook", webhook: { url: "https://hooks.example.test/dispatch-mutate" } },
      }),
    ).rejects.toThrow(/does not support mutate hooks/i);
  });

  it("accepts approval.request.before for intercept mode hooks", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: { hooks: { allowInterceptingHooks: true } },
    });
    const created = await service.createWorkspaceHook({
      workspaceId,
      label: "approval-request-veto",
      trigger: "approval.request.before",
      mode: "intercept",
      action: { type: "webhook", webhook: { url: "https://hooks.example.test/approval-request" } },
    });
    expect(created.trigger).toBe("approval.request.before");
    expect(created.mode).toBe("intercept");
  });

  it("rejects approval.request.before for mutate mode hooks", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: { hooks: { allowMutatingHooks: true, allowInterceptingHooks: true } },
    });
    await expect(
      service.createWorkspaceHook({
        workspaceId,
        label: "approval-request-mutate",
        trigger: "approval.request.before",
        mode: "mutate",
        action: { type: "webhook", webhook: { url: "https://hooks.example.test/approval-request-mutate" } },
      }),
    ).rejects.toThrow(/does not support mutate hooks/i);
  });

  it("keeps runtime lifecycle triggers observe-only and phases them correctly", async () => {
    const { service, workspaceId } = createHarness({
      workspacePrefs: {
        hooks: {
          allowMutatingHooks: true,
        },
      },
    });

    expect(deriveHookPhase("before_prompt_build")).toBe("before");
    expect(deriveHookPhase("agent_end")).toBe("after");
    await expect(
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
    ).rejects.toThrow(/observe hooks/i);
  });

  it("reconciles public hook actions without changing the internal raw update contract", async () => {
    const { service, workspaceId } = createHarness();
    const created = await service.createWorkspaceHook({
      workspaceId,
      label: "credentialed hook",
      trigger: "tool.call.after",
      mode: "observe",
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/events?token=hook-short&mode=events",
          secret: "signing-short",
        },
      },
    });

    const publicUpdate = await service.updateWorkspaceHookFromPublicProjection(workspaceId, created.hookId, {
      label: "credentialed hook renamed",
      action: projectHookRecordForPublicResponse(created).action,
    });
    expect(publicUpdate.label).toBe("credentialed hook renamed");
    expect(publicUpdate.action.webhook).toEqual({
      url: "https://hooks.example.test/events?token=hook-short&mode=events",
      secret: "signing-short",
    });
    expect((await service.listWorkspaceHooks(workspaceId))[0]?.action.webhook).toEqual(publicUpdate.action.webhook);

    const blockedTransplant = await service.updateWorkspaceHookFromPublicProjection(workspaceId, created.hookId, {
      action: {
        type: "webhook",
        webhook: {
          url: "https://evil.example/events?token=[REDACTED]&mode=alerts",
        },
      },
    });
    expect(blockedTransplant.action.webhook.url).toBe("https://hooks.example.test/events?token=hook-short&mode=events");
    expect(blockedTransplant.action.webhook.secret).toBe("signing-short");

    const internalUpdate = await service.updateWorkspaceHook(workspaceId, created.hookId, {
      action: {
        type: "webhook",
        webhook: {
          url: "https://hooks.example.test/events?token=replacement-short&mode=alerts",
          secret: "replacement-signing-short",
        },
      },
    });
    expect(internalUpdate.action.webhook).toEqual({
      url: "https://hooks.example.test/events?token=replacement-short&mode=alerts",
      secret: "replacement-signing-short",
    });
  });
});

function createHarness(input?: {
  workspacePrefs?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  durableKernelEnabled?: boolean;
  publishRealtime?: ServiceContext["publishRealtime"];
  failAttachOnce?: boolean;
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
  const durableRuns = new Map<string, DurableRunRecord>();
  const requestedRunIds: string[] = [];
  let hookIndex = 0;
  let hookRunIndex = 0;
  let durableIndex = 0;
  let remainingAttachFailures = input?.failAttachOnce ? 1 : 0;

  const storage = {
    runImmediateTransaction: async <T>(callback: () => T | Promise<T>): Promise<Awaited<T>> => {
      const hookRunSnapshot = new Map(hookRuns);
      const durableRunSnapshot = new Map(durableRuns);
      try {
        return await callback();
      } catch (error) {
        hookRuns.clear();
        durableRuns.clear();
        for (const [key, value] of hookRunSnapshot) {
          hookRuns.set(key, value);
        }
        for (const [key, value] of durableRunSnapshot) {
          durableRuns.set(key, value);
        }
        throw error;
      }
    },
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
      findByIdempotencyForUpdate: (hookId: string, idempotencyKey: string) =>
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
        if (remainingAttachFailures > 0) {
          remainingAttachFailures -= 1;
          throw new Error("synthetic attach failure");
        }
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
    durableRuns: {
      getRun: (runId: string) => {
        const run = durableRuns.get(runId);
        if (!run) {
          throw new NotFoundError({ entity: "Durable run", id: runId });
        }
        return run;
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
    publishRealtime: input?.publishRealtime ?? (() => undefined),
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: (flag) => (flag === "durableKernelV1Enabled" ? (input?.durableKernelEnabled ?? true) : true),
    normalizeWorkspaceId: (value?: string) => value?.trim() || workspaceId,
  };

  const service = new HooksService(ctx, {
    createDurableRun: (durableInput) => {
      const runId = durableInput.runId ?? `durable-${++durableIndex}`;
      const existing = durableRuns.get(runId);
      if (existing) {
        return existing;
      }
      const record: DurableRunRecord = {
        runId,
        workflowKey: durableInput.workflowKey,
        status: "queued",
        attemptCount: 0,
        maxAttempts: durableInput.retryPolicy?.maxAttempts ?? 3,
        payload: durableInput.payload ?? {},
        metadata: {
          retryPolicy: durableInput.retryPolicy ?? {},
          waitForEvent: durableInput.waitForEvent ?? null,
        },
        version: 1,
        createdAt: "2026-03-26T00:00:00.000Z",
        updatedAt: "2026-03-26T00:00:00.000Z",
      };
      durableRuns.set(runId, record);
      return record;
    },
    requestDurableRunProcessing: (runId) => {
      requestedRunIds.push(runId);
    },
    fetchImpl: input?.fetchImpl,
  });

  return {
    service,
    workspaceId,
    requestedRunIds,
    hookRuns,
    durableRuns,
  };
}
