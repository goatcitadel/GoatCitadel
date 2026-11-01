import { describe, expect, it, vi } from "vitest";
import { ErrandBrowserLaunchError, type ComputerAction, type ErrandBrowser } from "@goatcitadel/policy-engine";
import {
  BROWSER_ERRAND_APPROVAL_UNRECORDED_SUMMARY,
  BROWSER_ERRAND_BUSY_MESSAGE,
  BROWSER_ERRAND_CHANNEL_MESSAGE,
  BROWSER_ERRAND_DISABLED_MESSAGE,
  BROWSER_ERRAND_PROFILE_LOCKED_MESSAGE,
  BROWSER_ERRAND_REMOTE_HARDENED_MESSAGE,
  BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE,
  BROWSER_ERRAND_WINDOW_CLOSED_SUMMARY,
} from "./browser-errand-service.js";
import {
  buildService,
  errandRequest,
  fakeBrowser,
  fakeGate,
  outcome,
  untilAborted,
} from "./browser-errand-test-fixtures.js";

describe("BrowserErrandService", () => {
  it("refuses when the flag is off", async () => {
    const { service, launchBrowser } = buildService(vi.fn, { isEnabled: async () => false });
    await expect(service.run(errandRequest())).rejects.toThrow(BROWSER_ERRAND_DISABLED_MESSAGE);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("refuses on remote_hardened", async () => {
    const { service, launchBrowser } = buildService(vi.fn, { deploymentProfile: () => "remote_hardened" });
    await expect(service.run(errandRequest())).rejects.toThrow(BROWSER_ERRAND_REMOTE_HARDENED_MESSAGE);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("refuses a channel-origin turn", async () => {
    const { service, launchBrowser } = buildService(vi.fn, { sessionChannel: async () => "telegram" });
    await expect(service.run(errandRequest())).rejects.toThrow(BROWSER_ERRAND_CHANNEL_MESSAGE);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent errand", async () => {
    let runs = 0;
    const { service } = buildService(vi.fn, {
      runLoop: async (deps) => ((runs += 1) === 1 ? await untilAborted(deps) : outcome("done")),
    });
    const first = service.run(errandRequest());
    await expect(service.run(errandRequest({ toolRunId: "tool-run-2" }))).rejects.toThrow(BROWSER_ERRAND_BUSY_MESSAGE);
    await vi.waitFor(() => expect(service.getStatus("tool-run-1")?.state).toBe("running"));
    const errandId = service.getStatus("tool-run-1")!.errandId;
    await expect(service.stop(errandId, "operator")).resolves.toBe(true);
    await expect(first).resolves.toMatchObject({ outcome: "stopped" });
    // The window is free again once the first errand ends.
    await expect(service.run(errandRequest({ toolRunId: "tool-run-3" }))).resolves.toMatchObject({ outcome: "done" });
    await service.dispose();
  });

  it("reports window_closed when the browser closes mid-errand", async () => {
    let loopStarted!: () => void;
    const started = new Promise<void>((resolve) => (loopStarted = resolve));
    let runs = 0;
    const built = buildService(vi.fn, {
      runLoop: async (deps) => {
        if ((runs += 1) > 1) return outcome("done");
        loopStarted();
        return await untilAborted(deps);
      },
    });
    const { service, browser, launchBrowser } = built;
    const running = service.run(errandRequest());
    await started;
    browser.fireClosed();
    await expect(running).resolves.toMatchObject({
      outcome: "window_closed",
      summary: BROWSER_ERRAND_WINDOW_CLOSED_SUMMARY,
    });
    expect(service.getStatus("tool-run-1")).toMatchObject({ state: "finished", outcome: "window_closed" });
    // The next errand relaunches instead of reusing the closed window.
    await service.run(errandRequest({ toolRunId: "tool-run-2" }));
    expect(launchBrowser).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it("maps profile_locked to the plain message", async () => {
    const { service } = buildService(vi.fn, {
      launchBrowser: async () => {
        throw new ErrandBrowserLaunchError("profile_locked", "ProcessSingleton: user data directory is already in use");
      },
    });
    const failure = await service.run(errandRequest()).catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(BROWSER_ERRAND_PROFILE_LOCKED_MESSAGE);
    expect(service.getStatus("tool-run-1")).toMatchObject({ state: "finished", outcome: "failed" });
  });

  it("stops the errand and withdraws its approval when the Chat turn is cancelled", async () => {
    const turn = new AbortController();
    const { service, gate } = buildService(vi.fn, { runLoop: untilAborted });
    const running = service.run(errandRequest({ signal: turn.signal }));
    await vi.waitFor(() => expect(service.getStatus("tool-run-1")?.state).toBe("running"));
    turn.abort();
    await expect(running).resolves.toMatchObject({ outcome: "stopped" });
    expect(gate.withdrawPending).toHaveBeenCalledWith("system:errand-stopped");
    await service.dispose();
  });

  it("treats an approval that cannot be recorded as a stop, logs it and says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service } = buildService(vi.fn, {
      createGate: () =>
        fakeGate(vi.fn, {
          request: vi.fn(async () => {
            throw new Error("database is locked");
          }),
        }),
      runLoop: async (deps) => {
        const answer = await deps.requestApproval({} as never);
        return outcome(answer === "stopped" ? "stopped" : "done", { summary: answer });
      },
    });
    await expect(service.run(errandRequest())).resolves.toMatchObject({
      outcome: "stopped",
      summary: BROWSER_ERRAND_APPROVAL_UNRECORDED_SUMMARY,
    });
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] browser errand approval could not be recorded",
      expect.objectContaining({ error: "database is locked" }),
    );
    warn.mockRestore();
    await service.dispose();
  });

  it("halts the rest of an action batch on Take over and waits for Hand back", async () => {
    const wait: ComputerAction = { type: "wait" };
    const asked: number[] = [];
    let batch!: Promise<{ ran: number; halted: boolean }>;
    const { service, browser } = buildService(vi.fn, {
      runLoop: async (deps) => {
        batch = deps.browser.runActions([wait, wait, wait], async (_action, index) => {
          asked.push(index);
          return "proceed";
        });
        const result = await batch;
        return outcome("done", { summary: `ran ${result.ran}` });
      },
    });
    browser.runActions = async (actions, beforeAction) => {
      let ran = 0;
      for (const [index, action] of actions.entries()) {
        if ((await beforeAction(action, index)) === "halt") return { ran, halted: true };
        ran += 1;
        if (index === 0) browser.fireOverlay({ type: "take_over" });
      }
      return { ran, halted: false };
    };
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(service.getStatus("tool-run-1")?.state).toBe("taken_over"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    let settled = false;
    void batch.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    browser.fireOverlay({ type: "hand_back" });
    await expect(running).resolves.toMatchObject({ outcome: "done", summary: "ran 1" });
    expect(asked).toEqual([0]);
    await service.dispose();
  });

  it("uploads a step thumbnail at most every 3 steps and the final screenshot once", async () => {
    const { service, uploads } = buildService(vi.fn, {
      runLoop: async (deps) => {
        for (let step = 1; step <= 7; step += 1) {
          deps.onProgress({ step, text: `step ${step}`, modelScreenshotPng: Buffer.from(`shot-${step}`) });
        }
        return outcome("done", { answer: "ok", steps: 7, finalScreenshotPng: Buffer.from("final") });
      },
    });
    const result = await service.run(errandRequest());
    expect(uploads.map((upload) => upload.bytes.toString())).toEqual(["shot-1", "shot-4", "shot-7", "final"]);
    expect(result).toMatchObject({ outcome: "done", answer: "ok", steps: 7, finalScreenshotAttachmentId: "att-4" });
    expect(service.getStatus("tool-run-1")).toMatchObject({
      state: "finished",
      thumbnailAttachmentId: "att-3",
      finalAttachmentId: "att-4",
      stepCount: 7,
    });
    await service.dispose();
  });

  it("pauses on Take over, resumes on Hand back, and stops from the window", async () => {
    let captures = 0;
    const { service, browser } = buildService(vi.fn, {
      runLoop: async (deps) => {
        await deps.browser.captureForModel();
        captures += 1;
        await deps.browser.captureForModel();
        captures += 1;
        return await untilAborted(deps);
      },
    });
    browser.captureForModel = async () => {
      if (captures === 0) browser.fireOverlay({ type: "take_over" });
      return Buffer.from("model-png");
    };
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(service.getStatus("tool-run-1")?.state).toBe("taken_over"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captures).toBe(1);
    browser.fireOverlay({ type: "hand_back" });
    await vi.waitFor(() => expect(captures).toBe(2));
    browser.fireOverlay({ type: "stop" });
    await expect(running).resolves.toMatchObject({ outcome: "stopped" });
    // The window stays on the final page, with GoatCitadel's overlay hidden.
    expect(browser.renders.at(-1)).toEqual({ mode: "hidden" });
    expect(browser.close).not.toHaveBeenCalled();
    await service.dispose();
    expect(browser.close).toHaveBeenCalled();
  });
});

describe("BrowserErrandService dispose", () => {
  it("withdraws a pending approval before dispose resolves, then closes the window", async () => {
    const order: string[] = [];
    let asked!: () => void;
    const approvalAsked = new Promise<void>((resolve) => (asked = resolve));
    const gate = fakeGate(vi.fn, {
      withdrawPending: vi.fn(async () => {
        order.push("withdraw");
      }),
    });
    const built = buildService(vi.fn, {
      createGate: (deps) => {
        gate.request = vi.fn(
          () =>
            new Promise<"stopped">((resolve) => {
              asked();
              deps.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
            }),
        );
        return gate;
      },
      runLoop: async (deps) => outcome((await deps.requestApproval({} as never)) === "stopped" ? "stopped" : "done"),
    });
    built.browser.close = vi.fn(async () => {
      order.push("close");
    });
    const running = built.service.run(errandRequest());
    await approvalAsked;
    await built.service.dispose();
    expect(gate.withdrawPending).toHaveBeenCalledWith("system:errand-stopped");
    expect(order).toEqual(["withdraw", "close"]);
    await expect(running).resolves.toMatchObject({ outcome: "stopped" });
  });

  it("closes a browser whose launch finishes after dispose", async () => {
    let finishLaunch!: () => void;
    const late = fakeBrowser(vi.fn);
    const built = buildService(vi.fn, {
      disposeSettleMs: 20,
      launchBrowser: () =>
        new Promise<ErrandBrowser>((resolve) => {
          finishLaunch = () => resolve(late);
        }),
    });
    const running = built.service.run(errandRequest());
    await vi.waitFor(() => expect(finishLaunch).toBeTypeOf("function"));
    await built.service.dispose();
    finishLaunch();
    await expect(running).rejects.toThrow(BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE);
    expect(late.close).toHaveBeenCalled();
  });

  it("refuses a run after dispose", async () => {
    const { service, launchBrowser } = buildService(vi.fn);
    await service.dispose();
    await expect(service.run(errandRequest())).rejects.toThrow(BROWSER_ERRAND_SHUTTING_DOWN_MESSAGE);
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});
