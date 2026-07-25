import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlamaCppConfig } from "../config.js";
import { LlamaCppRuntimeService, type LlamaCppRuntimeServiceHooks } from "./llama-cpp-runtime-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LlamaCppRuntimeService leases", () => {
  it("shares one startup/readiness promise across concurrent acquirers and releases idempotently", async () => {
    const ready = deferred<{ healthy: boolean; activeModelId?: string }>();
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return probeCount === 1 ? { healthy: false } : ready.promise;
      }),
    });

    const firstPromise = harness.service.acquireLease({ purpose: "chat_completion" });
    const secondPromise = harness.service.acquireLease({ purpose: "chat_completion" });
    await waitForCondition(() => harness.spawnProcess.mock.calls.length === 1);
    ready.resolve({ healthy: true, activeModelId: "shared-model" });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.leaseId).not.toBe(second.leaseId);
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);
    expect(harness.service.getStatus().leaseDiagnostics).toMatchObject({
      state: "active",
      activeLeaseCount: 2,
      ownership: "owned",
      purposes: [{ purpose: "chat_completion", count: 2 }],
    });

    await first.release();
    await first.release();
    expect(harness.service.getStatus().leaseDiagnostics?.activeLeaseCount).toBe(1);
    await second.release();
    await harness.service.close();
  });

  it("loads cached state once when init races the first lease startup", async () => {
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return probeCount > 2 ? { healthy: true, activeModelId: "fresh-model" } : { healthy: false };
      }),
    });
    const statePath = path.join(harness.rootDir, "data", "llamacpp-runtime-state.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({
        desiredState: "stopped",
        processState: "error",
        healthy: false,
        activeModelId: "stale-cache-model",
        updatedAt: "2026-07-12T00:00:00.000Z",
      }),
      "utf8",
    );

    const leasePromise = harness.service.acquireLease({ purpose: "chat_completion" });
    const initPromise = harness.service.init();
    const [lease] = await Promise.all([leasePromise, initPromise]);

    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);
    expect(harness.service.getStatus()).toMatchObject({
      processState: "running",
      healthy: true,
      activeModelId: "fresh-model",
      leaseDiagnostics: { activeLeaseCount: 1, ownership: "owned" },
    });
    await lease.release();
    await harness.service.close();
  });

  it("lets one waiter abort without cancelling or stranding another shared waiter", async () => {
    const ready = deferred<{ healthy: boolean; activeModelId?: string }>();
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return probeCount === 1 ? { healthy: false } : ready.promise;
      }),
    });
    const controller = new AbortController();

    const abortedWaiter = harness.service.acquireLease({ purpose: "embedding" }, { signal: controller.signal });
    const survivingWaiter = harness.service.acquireLease({ purpose: "chat_completion" });
    await waitForCondition(() => harness.spawnProcess.mock.calls.length === 1);
    controller.abort();
    await expect(abortedWaiter).rejects.toMatchObject({ name: "AbortError" });
    ready.resolve({ healthy: true });

    const survivingLease = await survivingWaiter;
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);
    expect(harness.service.getStatus().leaseDiagnostics).toMatchObject({
      activeLeaseCount: 1,
      purposes: [{ purpose: "chat_completion", count: 1 }],
    });
    await survivingLease.release();
    await harness.service.close();
  });

  it("cancels shared startup promptly when the last waiting lease aborts", async () => {
    const probe = deferred<{ healthy: boolean }>();
    const probeHealth = vi.fn(() => probe.promise);
    const harness = await createHarness({ probeHealth });
    const controller = new AbortController();

    const acquisition = harness.service.acquireLease({ purpose: "chat_completion" }, { signal: controller.signal });
    await waitForCondition(() => probeHealth.mock.calls.length === 1);
    controller.abort();

    await expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.spawnProcess).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      desiredState: "stopped",
      processState: "stopped",
      leaseDiagnostics: { activeLeaseCount: 0 },
    });
    probe.resolve({ healthy: false });
    await harness.service.close();
  });

  it("fences a cancelled pre-spawn startup and lets a new acquirer start cleanly", async () => {
    const persistEntered = deferred<void>();
    const releasePersist = deferred<void>();
    let blockedStartingPersist = false;
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return { healthy: probeCount >= 3 };
      }),
      persistState: async (_path, status) => {
        if (!blockedStartingPersist && status.processState === "starting") {
          blockedStartingPersist = true;
          persistEntered.resolve(undefined);
          await releasePersist.promise;
        }
      },
    });
    const controller = new AbortController();
    const cancelled = harness.service.acquireLease({ purpose: "chat_completion" }, { signal: controller.signal });
    await persistEntered.promise;

    controller.abort();
    await waitForCondition(() => harness.service.getStatus().leaseDiagnostics?.activeLeaseCount === 0);
    const replacement = harness.service.acquireLease({ purpose: "embedding_query" });
    releasePersist.resolve(undefined);

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const lease = await replacement;
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);
    expect(harness.service.getStatus()).toMatchObject({
      processState: "running",
      healthy: true,
      leaseDiagnostics: { activeLeaseCount: 1, ownership: "owned" },
    });
    await lease.release();
    await harness.service.close();
  });

  it("does not restart when a replacement waiter also aborts during startup cancellation", async () => {
    const persistEntered = deferred<void>();
    const releasePersist = deferred<void>();
    let blockedStartingPersist = false;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => ({ healthy: false })),
      persistState: async (_path, status) => {
        if (!blockedStartingPersist && status.processState === "starting") {
          blockedStartingPersist = true;
          persistEntered.resolve(undefined);
          await releasePersist.promise;
        }
      },
    });
    const firstController = new AbortController();
    const first = harness.service.acquireLease({ purpose: "chat_completion" }, { signal: firstController.signal });
    await persistEntered.promise;
    firstController.abort();
    await waitForCondition(() => harness.service.getStatus().leaseDiagnostics?.activeLeaseCount === 0);

    const secondController = new AbortController();
    const second = harness.service.acquireLease({ purpose: "embedding_query" }, { signal: secondController.signal });
    await waitForCondition(() => harness.service.getStatus().leaseDiagnostics?.activeLeaseCount === 1);
    secondController.abort();
    releasePersist.resolve(undefined);

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await waitForCondition(() => harness.service.getStatus().leaseDiagnostics?.activeLeaseCount === 0);
    expect(harness.spawnProcess).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      desiredState: "stopped",
      processState: "stopped",
      leaseDiagnostics: { activeLeaseCount: 0, ownership: "none" },
    });
    await harness.service.close();
  });

  it("does not let a queued manual start resume after stop wins a cancelled startup", async () => {
    const persistEntered = deferred<void>();
    const releasePersist = deferred<void>();
    let blockedStartingPersist = false;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => ({ healthy: false })),
      persistState: async (_path, status) => {
        if (!blockedStartingPersist && status.processState === "starting") {
          blockedStartingPersist = true;
          persistEntered.resolve(undefined);
          await releasePersist.promise;
        }
      },
    });
    const controller = new AbortController();
    const cancelled = harness.service.acquireLease({ purpose: "chat_completion" }, { signal: controller.signal });
    await persistEntered.promise;
    controller.abort();
    await waitForCondition(() => harness.service.getStatus().leaseDiagnostics?.activeLeaseCount === 0);

    const queuedStart = harness.service.start("manual");
    await waitForCondition(() => harness.service.getStatus().leaseDiagnostics?.persistentDemand.manual === true);
    const stopping = harness.service.stop("manual");
    releasePersist.resolve(undefined);

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(queuedStart).rejects.toThrow("superseded by a forced transition");
    await stopping;
    expect(harness.spawnProcess).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      desiredState: "stopped",
      processState: "stopped",
      leaseDiagnostics: {
        activeLeaseCount: 0,
        persistentDemand: { manual: false, api: false, autostart: false },
      },
    });
    await harness.service.close();
  });

  it("handles an asynchronous spawn error when the child has no process identifier", async () => {
    const child = new FakeNoPidChildProcess();
    const onEvent = vi.fn();
    const harness = await createHarness({
      onEvent,
      probeHealth: vi.fn(async () => ({ healthy: false })),
      persistState: async () => undefined,
      spawnProcess: () => {
        setImmediate(() => child.emit("error", new Error("simulated spawn ENOENT")));
        return child as unknown as ChildProcess;
      },
    });

    await expect(harness.service.start("manual")).rejects.toThrow("did not return a process identifier");
    await waitForCondition(() =>
      onEvent.mock.calls.some(
        ([eventType, payload]) =>
          eventType === "llamacpp_spawn_error" &&
          (payload as { message?: string }).message === "simulated spawn ENOENT",
      ),
    );
    expect(harness.service.getStatus()).toMatchObject({
      processState: "error",
      healthy: false,
      pid: undefined,
      lastError: "simulated spawn ENOENT",
      leaseDiagnostics: { ownership: "none" },
    });
    await harness.service.close();
  });

  it("cancels last-release idle shutdown on reacquire and stops only after the new deadline", async () => {
    useLeaseFakeTimers();
    const harness = await createHarness({ idleTimeoutMs: 1_000 });
    const first = await harness.service.acquireLease({ purpose: "chat_completion" });

    await first.release();
    expect(harness.service.getStatus().leaseDiagnostics).toMatchObject({
      state: "idle_pending",
      idleDeadline: "2026-07-13T00:00:01.000Z",
    });
    await vi.advanceTimersByTimeAsync(500);

    const second = await harness.service.acquireLease({ purpose: "embedding" });
    expect(harness.service.getStatus().leaseDiagnostics?.idleDeadline).toBeUndefined();
    await second.release();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.terminateOwnedProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waitForCondition(() => harness.service.getStatus().desiredState === "stopped");

    expect(harness.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    expect(harness.service.getStatus()).toMatchObject({ desiredState: "stopped", processState: "stopped" });
    await second.release();
  });

  it("waits for an in-progress idle termination before satisfying a new lease", async () => {
    useLeaseFakeTimers();
    const terminationEntered = deferred<void>();
    const allowTermination = deferred<void>();
    let terminationCount = 0;
    let probeCount = 0;
    const harness = await createHarness({
      idleTimeoutMs: 100,
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return { healthy: probeCount % 2 === 0 };
      }),
      terminateOwnedProcess: async () => {
        terminationCount += 1;
        if (terminationCount === 1) {
          terminationEntered.resolve(undefined);
          await allowTermination.promise;
        }
      },
    });
    const first = await harness.service.acquireLease({ purpose: "chat_completion" });
    await first.release();
    await vi.advanceTimersByTimeAsync(100);
    await terminationEntered.promise;

    let replacementSettled = false;
    const replacementPromise = harness.service.acquireLease({ purpose: "embedding_query" }).then((lease) => {
      replacementSettled = true;
      return lease;
    });
    await flushAsyncWork();
    expect(replacementSettled).toBe(false);
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);

    allowTermination.resolve(undefined);
    const replacement = await replacementPromise;
    expect(harness.spawnProcess).toHaveBeenCalledTimes(2);
    expect(harness.service.getStatus()).toMatchObject({
      processState: "running",
      healthy: true,
      leaseDiagnostics: { activeLeaseCount: 1, ownership: "owned" },
    });
    await replacement.release();
    await harness.service.close();
  });

  it("waits for an in-progress manual stop before satisfying a new lease", async () => {
    const terminateEntered = deferred<void>();
    const releaseTermination = deferred<void>();
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return { healthy: probeCount % 2 === 0 };
      }),
      terminateOwnedProcess: async () => {
        terminateEntered.resolve(undefined);
        await releaseTermination.promise;
      },
    });
    await harness.service.start("manual");

    const stopping = harness.service.stop("manual");
    await terminateEntered.promise;
    const acquisition = harness.service.acquireLease({ purpose: "embedding_query" });
    let acquisitionSettled = false;
    void acquisition.then(
      () => {
        acquisitionSettled = true;
      },
      () => {
        acquisitionSettled = true;
      },
    );
    await flushAsyncWork();
    expect(acquisitionSettled).toBe(false);

    releaseTermination.resolve(undefined);
    await stopping;
    const lease = await acquisition;
    expect(harness.spawnProcess).toHaveBeenCalledTimes(2);
    expect(harness.service.getStatus()).toMatchObject({
      processState: "running",
      healthy: true,
      leaseDiagnostics: { activeLeaseCount: 1, ownership: "owned" },
    });
    await lease.release();
    await harness.service.close();
  });

  it("retains owned error state when process-tree termination cannot be confirmed", async () => {
    let failTermination = true;
    const harness = await createHarness({
      terminateOwnedProcess: async (process) => {
        if (failTermination) {
          process.emit("exit", null, "SIGTERM");
          throw new Error("process tree still alive");
        }
      },
    });
    await harness.service.start("manual");

    await expect(harness.service.close()).rejects.toThrow("process tree still alive");
    expect(harness.service.getStatus()).toMatchObject({
      processState: "error",
      healthy: false,
      pid: harness.children[0]!.pid,
      lastError: "Failed to terminate owned llama.cpp process tree: process tree still alive",
      leaseDiagnostics: { ownership: "owned" },
    });

    failTermination = false;
    await harness.service.close();
    expect(harness.terminateOwnedProcess).toHaveBeenCalledTimes(2);
  });

  it("never terminates an externally healthy process when lease-only demand ends", async () => {
    useLeaseFakeTimers();
    const harness = await createHarness({
      idleTimeoutMs: 100,
      probeHealth: vi.fn(async () => ({ healthy: true, activeModelId: "external-model" })),
    });

    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    expect(harness.service.getStatus().leaseDiagnostics?.ownership).toBe("external");
    await lease.release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.spawnProcess).not.toHaveBeenCalled();
    expect(harness.terminateOwnedProcess).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      desiredState: "stopped",
      processState: "running",
      healthy: true,
      leaseDiagnostics: { state: "idle", ownership: "external" },
    });
    await harness.service.close();
  });

  it("uses an externally healthy endpoint without requiring a local model path", async () => {
    const harness = await createHarness({
      withoutModelPath: true,
      probeHealth: vi.fn(async () => ({ healthy: true, activeModelId: "external-model" })),
    });

    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });

    expect(harness.spawnProcess).not.toHaveBeenCalled();
    expect(harness.service.getStatus().leaseDiagnostics?.ownership).toBe("external");
    await lease.release();
    await harness.service.close();
  });

  it("re-probes a changed endpoint before restoring idle external-owner truth", async () => {
    let probeCount = 0;
    const probeHealth = vi.fn(async () => {
      probeCount += 1;
      return probeCount <= 2 ? { healthy: true, activeModelId: "old-external-model" } : { healthy: false };
    });
    const harness = await createHarness({ probeHealth });
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    await lease.release();
    const lifecycle = harness.service.getLifecycleSnapshot();

    await harness.service.stop("settings_update");
    const changedConfig = structuredClone(harness.config);
    changedConfig.server.baseUrl = "http://127.0.0.1:8081/v1";
    harness.service.updateConfig(changedConfig);
    const restored = await harness.service.restoreLifecycleSnapshot(lifecycle);

    expect(probeHealth).toHaveBeenCalledTimes(3);
    expect(restored).toMatchObject({
      baseUrl: "http://127.0.0.1:8081/v1",
      healthy: false,
      activeModelId: undefined,
      processState: "stopped",
      leaseDiagnostics: { ownership: "none", state: "idle" },
    });
    await harness.service.close();
  });

  it("keeps API demand persistent after lease release and distinguishes all persistent sources", async () => {
    useLeaseFakeTimers();
    const owned = await createHarness({ idleTimeoutMs: 100 });
    await owned.service.start("api");
    const lease = await owned.service.acquireLease({ purpose: "chat_completion" });
    await lease.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(owned.terminateOwnedProcess).not.toHaveBeenCalled();
    expect(owned.service.getStatus().leaseDiagnostics?.persistentDemand.api).toBe(true);
    await owned.service.stop("api");
    expect(owned.terminateOwnedProcess).toHaveBeenCalledTimes(1);

    const external = await createHarness({ probeHealth: vi.fn(async () => ({ healthy: true })) });
    await external.service.start("manual");
    await external.service.start("api");
    await external.service.start("config_autostart");
    expect(external.service.getStatus().leaseDiagnostics?.persistentDemand).toEqual({
      manual: true,
      api: true,
      autostart: true,
    });
    await external.service.stop("manual");
  });

  it("does not restore manual or API demand into a disabled runtime", async () => {
    const harness = await createHarness({ probeHealth: vi.fn(async () => ({ healthy: true })) });
    await harness.service.start("manual");
    await harness.service.start("api");
    const lifecycle = harness.service.getLifecycleSnapshot();
    await harness.service.stop("settings_update");
    harness.service.updateConfig({ ...harness.config, enabled: false });

    const restored = await harness.service.restoreLifecycleSnapshot(lifecycle);

    expect(restored).toMatchObject({
      enabled: false,
      desiredState: "stopped",
      leaseDiagnostics: {
        state: "closed",
        persistentDemand: { manual: false, api: false, autostart: false },
      },
    });
    await harness.service.close();
  });

  it("does not convert a rollback start into persistent demand", async () => {
    useLeaseFakeTimers();
    const harness = await createHarness({ idleTimeoutMs: 100 });

    await harness.service.start("rollback");

    expect(harness.service.getStatus().leaseDiagnostics).toMatchObject({
      state: "idle_pending",
      persistentDemand: { manual: false, api: false, autostart: false },
    });
    await vi.advanceTimersByTimeAsync(100);
    await waitForCondition(() => harness.service.getStatus().desiredState === "stopped");
    expect(harness.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    await harness.service.close();
  });

  it("preserves active leases across an owned-process crash and budgeted restart", async () => {
    useLeaseFakeTimers();
    let probeCount = 0;
    const harness = await createHarness({
      restartBackoffMs: 200,
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return probeCount === 1 || probeCount === 3 ? { healthy: false } : { healthy: true };
      }),
    });
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    const firstProcess = harness.children[0]!;

    firstProcess.emit("exit", 17, null);
    expect(harness.service.getStatus().leaseDiagnostics).toMatchObject({
      activeLeaseCount: 1,
      ownership: "owned",
      evidence: { lastRestart: { outcome: "scheduled" } },
    });
    await vi.advanceTimersByTimeAsync(200);
    await waitForCondition(() => harness.spawnProcess.mock.calls.length === 2);
    await waitForCondition(
      () => harness.service.getStatus().leaseDiagnostics?.evidence.lastRestart?.outcome === "ready",
    );

    expect(harness.service.getStatus()).toMatchObject({
      processState: "running",
      healthy: true,
      leaseDiagnostics: {
        activeLeaseCount: 1,
        ownership: "owned",
        evidence: { lastRestart: { outcome: "ready" } },
      },
    });
    await lease.release();
    await harness.service.close();
  });

  it("controlled-restarts an alive but unhealthy owned process", async () => {
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return probeCount === 2 || probeCount === 5 ? { healthy: true } : { healthy: false };
      }),
    });
    await harness.service.start("api");

    await harness.service.start("api");

    expect(harness.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    expect(harness.spawnProcess).toHaveBeenCalledTimes(2);
    expect(harness.service.getStatus()).toMatchObject({ processState: "running", healthy: true });
    await harness.service.stop("api");
  });

  it("makes restart-budget exhaustion terminal and visible", async () => {
    useLeaseFakeTimers();
    let probeCount = 0;
    let replacementProbeCount = 0;
    let replacementIdentity = false;
    const harness = await createHarness({
      maxRestarts: 1,
      restartBackoffMs: 100,
      probeHealth: vi.fn(async () => {
        if (replacementIdentity) {
          replacementProbeCount += 1;
          return { healthy: replacementProbeCount % 2 === 0 };
        }
        probeCount += 1;
        return { healthy: probeCount % 2 === 0 };
      }),
    });
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    harness.children[0]!.emit("exit", 19, null);

    await vi.advanceTimersByTimeAsync(100);
    await waitForCondition(
      () => harness.service.getStatus().leaseDiagnostics?.evidence.lastRestart?.outcome === "exhausted",
    );
    expect(harness.service.getStatus().leaseDiagnostics?.evidence.lastRestart?.outcome).toBe("exhausted");
    expect(harness.service.getStatus()).toMatchObject({
      processState: "error",
      lastError: "llama.cpp restart budget exhausted",
      leaseDiagnostics: { evidence: { lastRestart: { outcome: "exhausted" } } },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);
    expect(harness.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    await lease.release();

    replacementIdentity = true;
    const changedConfig = structuredClone(harness.config);
    changedConfig.server.baseUrl = "http://127.0.0.1:8081/v1";
    changedConfig.launch.alias = "replacement-model";
    harness.service.updateConfig(changedConfig);
    expect(harness.service.getStatus()).toMatchObject({
      processState: "stopped",
      activeModelId: undefined,
      lastError: undefined,
      leaseDiagnostics: { ownership: "none", evidence: {} },
    });

    const replacementLease = await harness.service.acquireLease({ purpose: "chat_completion" });
    expect(harness.spawnProcess).toHaveBeenCalledTimes(2);
    expect(harness.service.getStatus()).toMatchObject({
      processState: "running",
      healthy: true,
      activeModelId: "replacement-model",
      leaseDiagnostics: { ownership: "owned", activeLeaseCount: 1 },
    });
    await replacementLease.release();
    await harness.service.close();
  });

  it("exhausts crash restarts when the configured model disappears before respawn", async () => {
    useLeaseFakeTimers();
    let probeCount = 0;
    const harness = await createHarness({
      maxRestarts: 2,
      restartBackoffMs: 100,
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return { healthy: probeCount === 2 };
      }),
      persistState: async () => undefined,
    });
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    await fs.rm(harness.config.launch.modelPath!);

    harness.children[0]!.emit("exit", 19, null);
    await vi.advanceTimersByTimeAsync(100);
    await waitForCondition(
      () =>
        harness.terminateOwnedProcess.mock.calls.length === 1 &&
        harness.service.getStatus().leaseDiagnostics?.evidence.lastRestart?.outcome === "scheduled",
    );
    await vi.advanceTimersByTimeAsync(100);
    await waitForCondition(
      () => harness.service.getStatus().leaseDiagnostics?.evidence.lastRestart?.outcome === "exhausted",
    );
    expect(harness.service.getStatus()).toMatchObject({
      processState: "error",
      lastError: "llama.cpp restart budget exhausted",
      leaseDiagnostics: { evidence: { lastRestart: { outcome: "exhausted" } } },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);

    await lease.release();
    await harness.service.close();
  });

  it("cancels a queued crash restart when the last lease releases", async () => {
    useLeaseFakeTimers();
    let probeCount = 0;
    const harness = await createHarness({
      idleTimeoutMs: 100,
      restartBackoffMs: 500,
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return { healthy: probeCount === 2 };
      }),
    });
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    harness.children[0]!.emit("exit", 23, null);
    expect(harness.service.getStatus().leaseDiagnostics?.evidence.lastRestart?.outcome).toBe("scheduled");

    await lease.release();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);
    expect(harness.service.getStatus().leaseDiagnostics?.activeLeaseCount).toBe(0);
    await harness.service.close();
  });

  it("discards an old endpoint probe that resolves after an identity change", async () => {
    const oldProbe = deferred<{ healthy: boolean; activeModelId?: string }>();
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        return probeCount === 1 ? oldProbe.promise : { healthy: true, activeModelId: "new-model" };
      }),
    });
    const staleRefresh = harness.service.refresh();
    await waitForCondition(() => probeCount === 1);

    const changedConfig = structuredClone(harness.config);
    changedConfig.server.baseUrl = "http://127.0.0.1:9090/v1";
    changedConfig.launch.alias = "new-alias";
    harness.service.updateConfig(changedConfig);
    await expect(harness.service.refresh()).resolves.toMatchObject({
      baseUrl: "http://127.0.0.1:9090/v1",
      healthy: true,
      activeModelId: "new-model",
    });

    oldProbe.resolve({ healthy: true, activeModelId: "old-model" });
    await staleRefresh;
    expect(harness.service.getStatus()).toMatchObject({
      baseUrl: "http://127.0.0.1:9090/v1",
      healthy: true,
      activeModelId: "new-model",
    });
    await harness.service.close();
  });

  it("discards an owned-process probe that resolves after the process exits", async () => {
    useLeaseFakeTimers();
    const delayedProbe = deferred<{ healthy: boolean; activeModelId?: string }>();
    let probeCount = 0;
    const harness = await createHarness({
      probeHealth: vi.fn(async () => {
        probeCount += 1;
        if (probeCount === 1) {
          return { healthy: false };
        }
        if (probeCount === 2) {
          return { healthy: true, activeModelId: "owned-model" };
        }
        return delayedProbe.promise;
      }),
    });
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    const staleRefresh = harness.service.refresh();
    await waitForCondition(() => probeCount === 3);

    harness.children[0]!.emit("exit", 37, null);
    delayedProbe.resolve({ healthy: true, activeModelId: "stale-owned-model" });
    await staleRefresh;

    expect(harness.service.getStatus()).toMatchObject({
      processState: "error",
      healthy: false,
      activeModelId: undefined,
      lastError: "llama.cpp server exited unexpectedly (code=37, signal=null)",
      leaseDiagnostics: { ownership: "owned", evidence: { lastRestart: { outcome: "scheduled" } } },
    });
    await lease.release();
    await harness.service.close();
  });

  it("does not restore identity-scoped evidence from a mismatched cold cache", async () => {
    const harness = await createHarness({
      probeHealth: vi.fn(async () => ({ healthy: true, activeModelId: "current-model" })),
    });
    const statePath = path.join(harness.rootDir, "data", "llamacpp-runtime-state.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({
        runtimeIdentityFingerprint: "old-runtime-identity",
        desiredState: "running",
        processState: "error",
        healthy: false,
        activeModelId: "old-model",
        command: "old-llama-server",
        commandSource: "explicit",
        lastError: "old identity failure",
        updatedAt: "2026-07-12T00:00:00.000Z",
      }),
      "utf8",
    );

    await harness.service.init();
    expect(harness.service.getStatus()).toMatchObject({
      processState: "running",
      healthy: true,
      activeModelId: "current-model",
      command: undefined,
      commandSource: "missing",
      lastError: undefined,
    });
    await harness.service.close();
  });

  it("joins concurrent close callers and fences a delayed init probe", async () => {
    const initProbe = deferred<{ healthy: boolean; activeModelId?: string }>();
    const probeHealth = vi.fn(() => initProbe.promise);
    const harness = await createHarness({ probeHealth });
    const initialization = harness.service.init();
    await waitForCondition(() => probeHealth.mock.calls.length === 1);

    const firstClose = harness.service.close();
    const secondClose = harness.service.close();
    expect(secondClose).toBe(firstClose);
    let closeSettled = false;
    void secondClose.then(() => {
      closeSettled = true;
    });
    await flushAsyncWork();
    expect(closeSettled).toBe(false);

    initProbe.resolve({ healthy: true, activeModelId: "stale-after-close" });
    await Promise.all([initialization, firstClose, secondClose]);
    expect(harness.service.getStatus()).toMatchObject({
      desiredState: "stopped",
      processState: "stopped",
      healthy: false,
      activeModelId: undefined,
      leaseDiagnostics: { state: "closed", ownership: "none" },
    });
  });

  it("joins concurrent close callers while owned termination is in progress", async () => {
    const terminationEntered = deferred<void>();
    const releaseTermination = deferred<void>();
    const harness = await createHarness({
      terminateOwnedProcess: async () => {
        terminationEntered.resolve(undefined);
        await releaseTermination.promise;
      },
    });
    await harness.service.start("manual");

    const firstClose = harness.service.close();
    await terminationEntered.promise;
    const secondClose = harness.service.close();
    expect(secondClose).toBe(firstClose);
    let secondSettled = false;
    void secondClose.then(() => {
      secondSettled = true;
    });
    await flushAsyncWork();
    expect(secondSettled).toBe(false);

    releaseTermination.resolve(undefined);
    await Promise.all([firstClose, secondClose]);
    expect(harness.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    expect(harness.service.getStatus()).toMatchObject({
      processState: "stopped",
      healthy: false,
      pid: undefined,
      leaseDiagnostics: { state: "closed", ownership: "none" },
    });
  });

  it("catches best-effort persistence failures from process-exit callbacks", async () => {
    let rejectWrites = false;
    const onEvent = vi.fn();
    const harness = await createHarness({
      onEvent,
      persistState: async () => {
        if (rejectWrites) {
          throw new Error("state disk unavailable");
        }
      },
    });
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    rejectWrites = true;
    harness.children[0]!.emit("exit", 31, null);

    await waitForCondition(() =>
      onEvent.mock.calls.some(
        ([eventType, payload]) =>
          eventType === "llamacpp_state_persist_failed" &&
          (payload as { context?: string }).context === "unexpected_exit",
      ),
    );
    await lease.release();
    rejectWrites = false;
    await harness.service.close();
  });

  it("settles leases on close but rejects disabled-config transitions while a lease is active", async () => {
    useLeaseFakeTimers();
    const closing = await createHarness({ idleTimeoutMs: 1_000 });
    const first = await closing.service.acquireLease({ purpose: "chat_completion" });
    await first.release();
    const active = await closing.service.acquireLease({ purpose: "embedding" });
    await closing.service.close();

    expect(closing.service.getStatus().leaseDiagnostics).toMatchObject({
      state: "closed",
      activeLeaseCount: 0,
      idleDeadline: undefined,
      evidence: { lastLease: { action: "settled", purpose: "embedding" } },
    });
    expect(closing.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    await active.release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closing.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    await expect(closing.service.acquireLease({ purpose: "chat_completion" })).rejects.toThrow("closed");

    const disabling = await createHarness();
    const disabledLease = await disabling.service.acquireLease({ purpose: "chat_completion" });
    expect(() => disabling.service.updateConfig({ ...disabling.config, enabled: false })).toThrow("active lease");
    expect(disabling.service.getStatus().leaseDiagnostics).toMatchObject({ state: "active", activeLeaseCount: 1 });
    await expect(disabling.service.stop("disabled")).rejects.toThrow("active lease");
    await disabledLease.release();
    disabling.service.updateConfig({ ...disabling.config, enabled: false });
    await disabling.service.stop("disabled");
    expect(disabling.terminateOwnedProcess).toHaveBeenCalledTimes(1);
    await disabledLease.release();
  });

  it("bounds and sanitizes purpose diagnostics without exposing commands", async () => {
    const harness = await createHarness({ probeHealth: vi.fn(async () => ({ healthy: true })) });
    await expect(harness.service.acquireLease({ purpose: "--api-key super-secret" })).rejects.toThrow(
      "diagnostic label",
    );
    const leases = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) => harness.service.acquireLease({ purpose: `consumer_${index}` })),
    );
    const diagnostics = harness.service.getStatus().leaseDiagnostics!;

    expect(diagnostics.activeLeaseCount).toBe(10);
    expect(diagnostics.purposes).toHaveLength(8);
    expect(JSON.stringify(diagnostics)).not.toContain("super-secret");
    expect(JSON.stringify(diagnostics)).not.toContain(process.execPath);
    await Promise.all(leases.map((lease) => lease.release()));
    await harness.service.close();
  });

  it("snapshots and restores exact persistent demand while preserving leases", async () => {
    const harness = await createHarness({ probeHealth: vi.fn(async () => ({ healthy: true })) });
    await harness.service.start("manual");
    await harness.service.start("api");
    await harness.service.start("config_autostart");
    const lease = await harness.service.acquireLease({ purpose: "chat_completion" });
    const snapshot = harness.service.getLifecycleSnapshot();
    const changedConfig = {
      ...harness.config,
      server: { ...harness.config.server, baseUrl: "http://127.0.0.1:9090/v1" },
    };

    expect(snapshot.persistentDemand).toEqual({ manual: true, api: true, autostart: true });
    expect(harness.service.assessConfigTransition(changedConfig)).toEqual({
      allowed: false,
      identityChanged: true,
      activeLeaseCount: 1,
      reason: "active_leases",
    });
    expect(() => harness.service.assertCanApplyConfig(changedConfig)).toThrow("active lease");

    await harness.service.restoreLifecycleSnapshot(snapshot);
    expect(harness.service.getStatus().leaseDiagnostics).toMatchObject({
      activeLeaseCount: 1,
      persistentDemand: snapshot.persistentDemand,
    });
    await lease.release();
    await harness.service.stop("manual");
    await harness.service.restoreLifecycleSnapshot(snapshot);
    expect(harness.service.getStatus().leaseDiagnostics?.persistentDemand).toEqual(snapshot.persistentDemand);
    await harness.service.close();
  });
});

interface Harness {
  service: LlamaCppRuntimeService;
  config: LlamaCppConfig;
  rootDir: string;
  spawnProcess: ReturnType<typeof vi.fn<LlamaCppRuntimeServiceHooks["spawnProcess"]>>;
  terminateOwnedProcess: ReturnType<typeof vi.fn<NonNullable<LlamaCppRuntimeServiceHooks["terminateOwnedProcess"]>>>;
  children: FakeChildProcess[];
}

async function createHarness(
  input: {
    idleTimeoutMs?: number;
    restartBackoffMs?: number;
    maxRestarts?: number;
    withoutModelPath?: boolean;
    spawnProcess?: NonNullable<LlamaCppRuntimeServiceHooks["spawnProcess"]>;
    probeHealth?: NonNullable<LlamaCppRuntimeServiceHooks["probeHealth"]>;
    terminateOwnedProcess?: NonNullable<LlamaCppRuntimeServiceHooks["terminateOwnedProcess"]>;
    persistState?: NonNullable<LlamaCppRuntimeServiceHooks["persistState"]>;
    onEvent?: (eventType: string, payload: Record<string, unknown>) => void;
  } = {},
): Promise<Harness> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamacpp-lease-"));
  tempDirs.push(rootDir);
  const modelPath = path.join(rootDir, "models", "model.gguf");
  await fs.mkdir(path.dirname(modelPath), { recursive: true });
  await fs.writeFile(modelPath, "model", "utf8");
  const config = createConfig(
    input.withoutModelPath ? undefined : modelPath,
    input.restartBackoffMs,
    input.maxRestarts,
  );
  let defaultProbeCount = 0;
  const probeHealth =
    input.probeHealth ??
    vi.fn(async () => {
      defaultProbeCount += 1;
      return { healthy: defaultProbeCount > 1, activeModelId: "owned-model" };
    });
  const children: FakeChildProcess[] = [];
  const spawnProcess = vi.fn<LlamaCppRuntimeServiceHooks["spawnProcess"]>(
    input.spawnProcess ??
      (() => {
        const child = new FakeChildProcess(20_000 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      }),
  );
  const terminateOwnedProcess = vi.fn<NonNullable<LlamaCppRuntimeServiceHooks["terminateOwnedProcess"]>>(
    input.terminateOwnedProcess ?? (async () => undefined),
  );
  const service = new LlamaCppRuntimeService({
    rootDir,
    config,
    leaseIdleTimeoutMs: input.idleTimeoutMs,
    onEvent: input.onEvent,
    runtimeHooks: {
      probeHealth,
      spawnProcess,
      terminateOwnedProcess,
      ...(input.persistState ? { persistState: input.persistState } : {}),
    },
  });
  return { service, config, rootDir, spawnProcess, terminateOwnedProcess, children };
}

function createConfig(modelPath: string | undefined, restartBackoffMs = 100, maxRestarts = 4): LlamaCppConfig {
  return {
    enabled: true,
    autoStart: false,
    server: {
      baseUrl: "http://127.0.0.1:8080/v1",
      command: process.execPath,
      extraArgs: [],
      healthPath: "/health",
      modelsPath: "/v1/models",
      startTimeoutMs: 2_000,
      requestTimeoutMs: 1_000,
      restartBudget: {
        windowMs: 60_000,
        maxRestarts,
        backoffMs: restartBackoffMs,
      },
    },
    launch: {
      alias: "lease-model",
      modelPath,
    },
  };
}

class FakeChildProcess extends EventEmitter {
  public readonly stdout = null;
  public readonly stderr = null;

  public constructor(public readonly pid: number) {
    super();
  }
}

class FakeNoPidChildProcess extends EventEmitter {
  public readonly pid = undefined;
  public readonly stdout = null;
  public readonly stderr = null;
  public readonly kill = vi.fn(() => false);
}

function useLeaseFakeTimers(): void {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    if (predicate()) {
      return;
    }
    await flushAsyncWork();
  }
  throw new Error("Timed out waiting for llama.cpp lease test condition.");
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
