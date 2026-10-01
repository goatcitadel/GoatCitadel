// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAiReadinessResponse } from "@goatcitadel/contracts";
import { useLocalAiSettings } from "./use-local-ai-settings";
import { __resetLocalAiRequestStateForTests } from "./local-ai-request-state";
import { deferred, localAiFixture, localAiJob } from "./local-ai.test-support";
const api = vi.hoisted(() => ({
  fetchLocalAiReadiness: vi.fn(),
  startLocalAiDownload: vi.fn(),
  startLocalAiServe: vi.fn(),
}));
const prefs = vi.hoisted(() => ({ activeCitadelId: "first" }));
vi.mock("@goatcitadel/mission-control-shared/api/local-ai", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
let view: ReactTestRenderer | undefined;
let hook: ReturnType<typeof useLocalAiSettings>;
let owner: LocalAiReadinessResponse;
function Harness() {
  hook = useLocalAiSettings();
  return null;
}
async function render() {
  await act(async () => {
    const tree = (
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    if (view) view.update(tree);
    else view = create(tree);
  });
}
async function review(kind: "download" | "serve" = "download") {
  await act(async () => hook.requestReview(kind));
}
async function confirm() {
  await act(async () => hook.confirm());
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetLocalAiRequestStateForTests();
  prefs.activeCitadelId = "first";
  owner = localAiFixture();
  api.fetchLocalAiReadiness.mockImplementation(async () => structuredClone(owner));
  api.startLocalAiDownload.mockImplementation(async () => {
    const job = localAiJob();
    owner.downloads.push(job);
    return structuredClone(job);
  });
  api.startLocalAiServe.mockImplementation(async () => {
    const job = { ...localAiJob(), health: "unknown" as const };
    owner.serveJobs.push(job);
    return structuredClone(job);
  });
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
});
describe("Local AI request lifecycle", () => {
  it("reads in StrictMode without mutation and cancellation sends no request", async () => {
    await render();
    expect(hook.readiness).toEqual(owner);
    await review();
    expect(hook.review?.model.modelId).toBe("fixture-model");
    await act(async () => hook.cancel());
    await confirm();
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
    expect(api.startLocalAiServe).not.toHaveBeenCalled();
  });
  it.each(["download", "serve"] as const)(
    "records only the exact reviewed %s approval request with owner readback",
    async (kind) => {
      await render();
      await review(kind);
      await confirm();
      expect(kind === "download" ? api.startLocalAiDownload : api.startLocalAiServe).toHaveBeenCalledExactlyOnceWith({
        modelId: "fixture-model",
        backend: "llama_cpp",
        approvalMode: "request",
      });
      expect(hook.stateFor(kind)?.phase).toBe("confirmed");
      expect(hook.notice?.message).toContain("No model download or server start was performed");
      expect(hook.review).toBeNull();
    },
  );
  it.each(["catalog", "recommendation", "runtime"])("rejects changed %s evidence before dispatch", async (change) => {
    await render();
    await review();
    if (change === "catalog") owner.catalog[0]!.label = "Changed model";
    if (change === "recommendation") owner.recommendations[0]!.fit = "not_recommended";
    if (change === "runtime") owner.hardware.runtimes[0]!.detected = false;
    await confirm();
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
    expect(hook.notice?.message).toContain("No approval request was sent");
    expect(hook.queueing).toBe(false);
  });
  it("does not silently substitute a removed explicit selection on refresh", async () => {
    await render();
    await act(async () => hook.setSelectedModelKey(JSON.stringify(["fixture-model", "llama_cpp"])));
    owner.recommendations[0]!.modelId = "replacement";
    await act(async () => hook.reload());
    expect(hook.topRecommendation).toBeNull();
    await review();
    expect(hook.review).toBeNull();
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
  });
  it.each(["selection", "away-back", "unmount"])("cancels a late preflight after %s", async (change) => {
    await render();
    await review();
    const pending = deferred<LocalAiReadinessResponse>();
    api.fetchLocalAiReadiness.mockReturnValueOnce(pending.promise);
    let done!: Promise<void>;
    await act(async () => {
      done = hook.confirm();
    });
    if (change === "selection") await act(async () => hook.setSelectedModelKey("other"));
    if (change === "away-back") {
      prefs.activeCitadelId = "second";
      await render();
      prefs.activeCitadelId = "first";
      await render();
    }
    if (change === "unmount") {
      await act(async () => view?.unmount());
      view = undefined;
    }
    await act(async () => {
      pending.resolve(owner);
      await done;
    });
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
  });
  it("rejects an old review after switching installations before confirmation", async () => {
    await render();
    await review();
    prefs.activeCitadelId = "second";
    await render();
    expect(hook.review).toBeNull();
    await confirm();
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
  });
  it("admits one dispatch and retains an uncertain result across remount", async () => {
    await render();
    await review();
    const pending = deferred<ReturnType<typeof localAiJob>>();
    api.startLocalAiDownload.mockReturnValueOnce(pending.promise);
    let done!: Promise<void>;
    await act(async () => {
      done = hook.confirm();
    });
    await confirm();
    expect(api.startLocalAiDownload).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ ...localAiJob(), modelId: "wrong" });
      await done;
    });
    expect(hook.stateFor("download")?.phase).toBe("uncertain");
    await act(async () => view?.unmount());
    view = undefined;
    await render();
    expect(hook.queueing).toBe(true);
    await review();
    await confirm();
    expect(api.startLocalAiDownload).toHaveBeenCalledTimes(1);
  });
  it("withholds success when the exact retained job is missing", async () => {
    api.startLocalAiDownload.mockResolvedValue(localAiJob());
    await render();
    await review();
    await confirm();
    expect(hook.stateFor("download")?.phase).toBe("uncertain");
    expect(hook.notice?.message).toContain("could not be confirmed");
  });
  it("retains the installation-wide uncertain lock across Citadels and component remount", async () => {
    api.startLocalAiDownload.mockRejectedValueOnce(new Error("Response lost"));
    await render();
    await review();
    await confirm();
    expect(hook.stateFor("download")?.phase).toBe("uncertain");
    prefs.activeCitadelId = "another-citadel";
    await act(async () => view?.unmount());
    view = undefined;
    await render();
    expect(hook.stateFor("download")?.phase).toBe("uncertain");
    expect(hook.queueing).toBe(true);
    await review();
    await confirm();
    expect(api.startLocalAiDownload).toHaveBeenCalledTimes(1);
  });
  it("does not read or display another installation after an in-flight POST", async () => {
    await render();
    await review();
    const pending = deferred<ReturnType<typeof localAiJob>>();
    api.startLocalAiDownload.mockReturnValueOnce(pending.promise);
    let done!: Promise<void>;
    await act(async () => {
      done = hook.confirm();
    });
    prefs.activeCitadelId = "second";
    await render();
    const reads = api.fetchLocalAiReadiness.mock.calls.length;
    await act(async () => {
      pending.resolve(localAiJob());
      await done;
    });
    expect(api.fetchLocalAiReadiness).toHaveBeenCalledTimes(reads);
    expect(hook.notice).toBeNull();
    prefs.activeCitadelId = "first";
    await render();
    expect(hook.stateFor("download")?.phase).toBe("uncertain");
  });
  it("hides old evidence during reload and distinguishes incomplete or failed reads from empty jobs", async () => {
    await render();
    const pending = deferred<LocalAiReadinessResponse>();
    api.fetchLocalAiReadiness.mockReturnValueOnce(pending.promise);
    let done!: Promise<void>;
    await act(async () => {
      done = hook.reload();
    });
    expect(hook.readiness).toBeNull();
    await act(async () => {
      pending.resolve({} as LocalAiReadinessResponse);
      await done;
    });
    expect(hook.readiness).toBeNull();
    expect(hook.data?.issues[0]?.message).toContain("incomplete");
    api.fetchLocalAiReadiness.mockRejectedValueOnce(new Error("Unavailable owner"));
    await act(async () => hook.reload());
    expect(hook.readiness).toBeNull();
    expect(hook.data?.issues[0]?.message).toContain("Unavailable owner");
  });
});
