import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerLocalStateActivity, workerLocalStateActivity } from "./worker-local-state-activity.js";
import { createFileWorkerDurableState } from "./worker-durable-state.js";
import { writeWorkerProcessReport } from "./worker-process-report.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("worker local state activity", () => {
  it.each([false, true])("holds queued writers until native custody returns after cancellation=%s", async (cancel) => {
    const activity = new WorkerLocalStateActivity(),
      observed = deferred(),
      finish = deferred(),
      resuming = deferred(),
      resumed = deferred();
    const events: string[] = [],
      stop = new AbortController();
    activity.installWriterGate({
      pause: () => {
        events.push("pause");
      },
      resume: async () => {
        events.push("resume");
        resuming.resolve();
        await resumed.promise;
      },
    });
    const observation = activity.quiescent(async () => {
      events.push("observe");
      observed.resolve();
      await finish.promise;
    }, stop.signal);
    const outcome = observation.then(
      () => "complete",
      () => "cancelled",
    );
    await observed.promise;
    const writer = activity.mutation(async () => {
      events.push("write");
    });
    if (cancel) stop.abort();
    finish.resolve();
    await resuming.promise;
    expect(events).toEqual(["pause", "observe", "resume"]);
    resumed.resolve();
    await writer;
    expect(await outcome).toBe(cancel ? "cancelled" : "complete");
    expect(events).toEqual(["pause", "observe", "resume", "write"]);
  });
  it.each(["pause", "resume"])("permanently refuses writers after native %s failure", async (stage) => {
    const activity = new WorkerLocalStateActivity(),
      calls: string[] = [];
    activity.installWriterGate({
      pause: () => {
        calls.push("pause");
        if (stage === "pause") throw new Error("lost custody");
      },
      resume: async () => {
        calls.push("resume");
        throw new Error("lost custody");
      },
    });
    await expect(
      activity.quiescent(async () => {
        calls.push("observe");
      }, new AbortController().signal),
    ).rejects.toThrow("lost custody");
    await expect(
      activity.mutation(async () => {
        calls.push("write");
      }),
    ).rejects.toThrow("custody");
    expect(() => activity.beginExternalWriter()).toThrow("custody");
    expect(calls).toEqual(stage === "pause" ? ["pause"] : ["pause", "observe", "resume"]);
  });
  it("keeps lost custody authoritative when the observation also fails", async () => {
    const activity = new WorkerLocalStateActivity();
    activity.installWriterGate({
      pause() {},
      async resume() {
        throw new Error("lost custody");
      },
    });
    await expect(
      activity.quiescent(async () => {
        throw new Error("observation failed");
      }, new AbortController().signal),
    ).rejects.toThrow("lost custody");
    await expect(activity.mutation(async () => "unsafe")).rejects.toThrow("custody");
  });
  it("installs native writer coordination once before any local or external activity", async () => {
    const gate = { pause() {}, async resume() {} },
      first = new WorkerLocalStateActivity();
    first.installWriterGate(gate);
    expect(() => first.installWriterGate(gate)).toThrow("before activity");
    const late = new WorkerLocalStateActivity();
    await late.mutation(async () => {});
    expect(() => late.installWriterGate(gate)).toThrow("before activity");
    const external = new WorkerLocalStateActivity();
    external.beginExternalWriter()(true);
    expect(() => external.installWriterGate(gate)).toThrow("before activity");
  });
  it("requires every external writer to join and never clears uncertain cleanup on a later call", async () => {
    const activity = new WorkerLocalStateActivity(),
      signal = new AbortController().signal;
    const first = activity.beginExternalWriter(),
      second = activity.beginExternalWriter();
    first(true);
    first(true);
    await expect(activity.quiescent(async () => 1, signal)).rejects.toThrow("cleanup");
    second(true);
    await expect(activity.quiescent(async () => 1, signal)).resolves.toBe(1);
    const uncertain = activity.beginExternalWriter();
    uncertain(false);
    uncertain(true);
    await expect(activity.quiescent(async () => 1, signal)).rejects.toThrow("cleanup");
    await expect(activity.mutation(async () => 2)).resolves.toBe(2);
  });

  it("rechecks external writers when a queued measurement gets its turn", async () => {
    const activity = new WorkerLocalStateActivity(),
      entered = deferred(),
      finish = deferred();
    const write = activity.mutation(async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    const observation = activity.quiescent(async () => {
      throw new Error("must not measure");
    }, new AbortController().signal);
    const refused = expect(observation).rejects.toThrow("cleanup");
    const joined = activity.beginExternalWriter();
    finish.resolve();
    await write;
    await refused;
    joined(true);
    await expect(activity.quiescent(async () => 1, new AbortController().signal)).resolves.toBe(1);
  });

  it("drains earlier writes and keeps later writes behind a held observation", async () => {
    const activity = new WorkerLocalStateActivity(),
      writing = deferred(),
      finishWrite = deferred();
    const observing = deferred(),
      finishObservation = deferred(),
      events: string[] = [];
    const first = activity.mutation(async () => {
      events.push("write");
      writing.resolve();
      await finishWrite.promise;
    });
    await writing.promise;
    const observation = activity.quiescent(async () => {
      events.push("observe");
      observing.resolve();
      await finishObservation.promise;
    }, new AbortController().signal);
    const later = activity.mutation(async () => {
      events.push("later");
    });
    expect(events).toEqual(["write"]);
    finishWrite.resolve();
    await observing.promise;
    expect(events).toEqual(["write", "observe"]);
    finishObservation.resolve();
    await Promise.all([first, observation, later]);
    expect(events).toEqual(["write", "observe", "later"]);
  });

  it("cancels a queued observation without allowing successors to bypass the active writer", async () => {
    const activity = new WorkerLocalStateActivity(),
      started = deferred(),
      finish = deferred();
    const first = activity.mutation(async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const stop = new AbortController();
    const skipped = activity.quiescent(async () => {
      throw new Error("must not enter");
    }, stop.signal);
    const rejection = expect(skipped).rejects.toThrow("cancel queued");
    stop.abort(new Error("cancel queued"));
    await rejection;
    let entered = false;
    const later = activity.mutation(async () => {
      entered = true;
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    finish.resolve();
    await Promise.all([first, later]);
    expect(entered).toBe(true);
  });

  it("retains exclusion after active cancellation until the observer finishes", async () => {
    const activity = new WorkerLocalStateActivity(),
      started = deferred(),
      finish = deferred();
    const stop = new AbortController();
    const held = activity.quiescent(async () => {
      started.resolve();
      await finish.promise;
    }, stop.signal);
    await started.promise;
    const rejected = expect(held).rejects.toMatchObject({ name: "AbortError" });
    stop.abort();
    let entered = false;
    const later = activity.mutation(async () => {
      entered = true;
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    finish.resolve();
    await Promise.all([rejected, later]);
    expect(entered).toBe(true);
  });

  it("rejects nested activity instead of deadlocking and releases after failures", async () => {
    const activity = new WorkerLocalStateActivity();
    await expect(
      activity.quiescent(() => activity.mutation(async () => undefined), new AbortController().signal),
    ).rejects.toThrow("cannot be nested");
    await expect(
      activity.mutation(async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    await expect(activity.mutation(async () => 7)).resolves.toBe(7);
  });

  it("registers actual durable writes/deletes and report publication with the shared owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "gc-local-state-activity-"));
    const state = createFileWorkerDurableState(root),
      report = join(root, "report.json");
    const started = deferred(),
      finish = deferred();
    let held: Promise<void> | undefined;
    let writes: Promise<unknown>[] = [];
    try {
      await state.write("keep", "old");
      await state.write("remove", "retained");
      held = workerLocalStateActivity.quiescent(async () => {
        started.resolve();
        await finish.promise;
      }, new AbortController().signal);
      await started.promise;
      const reportInput = { complete: true };
      writes = [state.write("keep", "new"), state.delete("remove"), writeWorkerProcessReport(report, reportInput)];
      reportInput.complete = false;
      expect(await state.read("keep")).toBe("old");
      expect(await state.read("remove")).toBe("retained");
      await expect(readFile(report)).rejects.toMatchObject({ code: "ENOENT" });
      finish.resolve();
      await held;
      await Promise.all(writes);
      expect(await state.read("keep")).toBe("new");
      expect(await state.read("remove")).toBeUndefined();
      expect(JSON.parse(await readFile(report, "utf8"))).toEqual({ complete: true });
    } finally {
      finish.resolve();
      await held;
      await Promise.allSettled(writes);
      await rm(root, { recursive: true, force: true });
    }
  });
});
