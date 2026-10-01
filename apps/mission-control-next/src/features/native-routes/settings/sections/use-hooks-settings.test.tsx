import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECRET_REDACTION_MARKER, type HookRecord, type HookRunRecord } from "@goatcitadel/contracts";
import { useHooksSettings } from "./use-hooks-settings";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetIntegrationConnectionMutationsForTests } from "../integration-connection-mutation";
const api = vi.hoisted(() => ({
  createWorkspaceHook: vi.fn(),
  deleteWorkspaceHook: vi.fn(),
  fetchWorkspaceHookRuns: vi.fn(),
  fetchWorkspaceHooks: vi.fn(),
  redriveWorkspaceHookRun: vi.fn(),
  testWorkspaceHook: vi.fn(),
}));
vi.mock("./hooks-api", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://hook-fixture",
}));
const stamp = "2026-09-30T12:00:00.000Z";
const form = {
  label: "Observer",
  trigger: "tool.call.after" as const,
  mode: "observe" as const,
  url: "https://fixture.invalid/private-path",
  secret: "synthetic-not-retained",
};
const hook: HookRecord = {
  hookId: "hook",
  workspaceId: "one",
  label: "Observer",
  trigger: "tool.call.after",
  phase: "after",
  mode: "observe",
  enabled: true,
  priority: 100,
  timeoutMs: 5000,
  failPolicy: "open",
  dataScope: "metadata",
  action: { type: "webhook", webhook: { url: SECRET_REDACTION_MARKER, secretRef: "keychain:fixture" } },
  createdAt: stamp,
  updatedAt: stamp,
};
const run: HookRunRecord = {
  runId: "run",
  hookId: hook.hookId,
  workspaceId: "one",
  trigger: hook.trigger,
  entityType: "hook_test",
  entityId: hook.hookId,
  mode: "observe",
  status: "completed",
  idempotencyKey: "fixture-run",
  attemptCount: 1,
  createdAt: stamp,
  updatedAt: stamp,
};
let root: ReactTestRenderer, s: ReturnType<typeof useHooksSettings>, hooks: HookRecord[], runs: HookRunRecord[];
function Harness({ workspaceId = "one" }) {
  s = useHooksSettings(workspaceId);
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function mount(workspaceId = "one") {
  await act(async () => {
    root = create(<Harness workspaceId={workspaceId} />);
  });
}
async function createReview() {
  await act(async () => s.openView("new"));
  await act(async () => s.setForm(form));
  await act(async () => s.reviewCreate());
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetIntegrationConnectionMutationsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No live transport in hook lifecycle tests");
    }),
  );
  hooks = [];
  runs = [];
  api.fetchWorkspaceHooks.mockImplementation(async (workspaceId: string) => ({
    items: structuredClone(hooks.filter((item) => item.workspaceId === workspaceId)),
  }));
  api.fetchWorkspaceHookRuns.mockImplementation(async (workspaceId: string) => ({
    items: structuredClone(runs.filter((item) => item.workspaceId === workspaceId)),
  }));
  api.createWorkspaceHook.mockImplementation(async () => {
    hooks = [hook];
    return structuredClone(hook);
  });
  api.deleteWorkspaceHook.mockImplementation(async () => {
    hooks = [];
    return { deleted: true };
  });
  api.testWorkspaceHook.mockImplementation(async () => {
    runs = [run];
    return structuredClone(run);
  });
  api.redriveWorkspaceHookRun.mockImplementation(async () => {
    const receipt: HookRunRecord = {
      ...run,
      runId: "redrive",
      status: "queued",
      idempotencyKey: "fixture-redrive",
      attemptCount: 0,
    };
    runs = [receipt, run];
    return receipt;
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
describe("shared reviewed hook lifecycle", () => {
  it("cancels before writes and retains public fields without endpoint or signing secret", async () => {
    await mount();
    await createReview();
    expect(s.review?.description).toContain("Future matching events may send metadata");
    expect(s.review?.description).not.toContain(form.secret);
    await act(async () => s.cancelReview());
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.createWorkspaceHook).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    await mount();
    expect(s.form.label).toBe(form.label);
    expect(s.form.url).toBe("");
    expect(s.form.secret).toBe("");
  });
  it("admits one reviewed create and verifies public receipt/custody plus canonical readback", async () => {
    await mount();
    await createReview();
    expect(api.createWorkspaceHook).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.all([s.confirmReview(), s.confirmReview()]);
    });
    expect(api.createWorkspaceHook).toHaveBeenCalledExactlyOnceWith("one", {
      label: form.label,
      trigger: form.trigger,
      mode: form.mode,
      enabled: true,
      priority: 100,
      timeoutMs: 5000,
      failPolicy: "open",
      dataScope: "metadata",
      action: { type: "webhook", webhook: { url: form.url, secret: form.secret } },
    });
    expect(s.notice?.message).toContain("private endpoint and secret values are hidden");
    expect(s.notice?.message).not.toContain(form.secret);
    expect(s.form.secret).toBe("");
    expect(s.form.url).toBe("");
    expect(s.mutation.locked).toBe(false);
    expect(s.review).toBeNull();
  });
  it("withholds a create after a workspace round trip during preflight", async () => {
    await mount();
    await createReview();
    const pending = deferred<{ items: HookRecord[] }>();
    api.fetchWorkspaceHooks.mockReturnValueOnce(pending.promise);
    let action!: Promise<boolean>;
    await act(async () => {
      action = s.confirmReview();
    });
    await act(async () => root.update(<Harness workspaceId="two" />));
    await act(async () => root.update(<Harness workspaceId="one" />));
    await act(async () => {
      pending.resolve({ items: [] });
      await action;
    });
    expect(api.createWorkspaceHook).not.toHaveBeenCalled();
    expect(s.mutation.locked).toBe(false);
    expect(s.form.url).toBe("");
    expect(s.form.secret).toBe("");
  });
  it("withholds a create after editing away and back during preflight", async () => {
    await mount();
    await createReview();
    const pending = deferred<{ items: HookRecord[] }>();
    api.fetchWorkspaceHooks.mockReturnValueOnce(pending.promise);
    let action!: Promise<boolean>;
    await act(async () => {
      action = s.confirmReview();
    });
    await act(async () => s.setForm({ ...form, label: "Different" }));
    await act(async () => s.setForm(form));
    await act(async () => {
      pending.resolve({ items: [] });
      await action;
    });
    expect(api.createWorkspaceHook).not.toHaveBeenCalled();
  });
  it("acknowledges the late origin without clearing newer inputs or publishing old notices", async () => {
    await mount();
    await createReview();
    const pending = deferred<HookRecord>();
    api.createWorkspaceHook.mockReturnValueOnce(pending.promise);
    let action!: Promise<boolean>;
    await act(async () => {
      action = s.confirmReview();
    });
    await act(async () => s.setForm({ ...form, label: "New input", secret: "new-secret" }));
    await act(async () => {
      hooks = [hook];
      pending.resolve(hook);
      await action;
    });
    expect(s.form.label).toBe("New input");
    expect(s.form.secret).toBe("new-secret");
    expect(s.notice).toBeNull();
    expect(s.mutation.locked).toBe(false);
  });
  for (const failure of ["lost response", "foreign receipt", "unconfirmed readback"] as const)
    it(`retains shared workspace uncertainty after ${failure}`, async () => {
      await mount();
      await createReview();
      if (failure === "lost response") api.createWorkspaceHook.mockRejectedValueOnce(new Error("Response lost"));
      if (failure === "foreign receipt")
        api.createWorkspaceHook.mockResolvedValueOnce({ ...hook, workspaceId: "other" });
      if (failure === "unconfirmed readback") api.createWorkspaceHook.mockResolvedValueOnce(hook);
      await act(async () => {
        await s.confirmReview();
      });
      expect(s.mutation.phase).toBe("uncertain");
      await act(async () => root.unmount());
      await mount();
      expect(s.mutation.locked).toBe(true);
      await createReview();
      expect(s.review).toBeNull();
      expect(api.createWorkspaceHook).toHaveBeenCalledOnce();
      await act(async () => root.unmount());
      await mount("two");
      expect(s.mutation.locked).toBe(false);
    });
  it("reviews a real test and reports the exact failed delivery rather than success", async () => {
    hooks = [hook];
    await mount();
    await act(async () => s.selectHook("hook"));
    await act(async () => s.reviewHook("test", hook));
    expect(s.review?.description).toContain("real configured delivery path");
    expect(api.testWorkspaceHook).not.toHaveBeenCalled();
    api.testWorkspaceHook.mockImplementationOnce(async () => {
      const saved = { ...run, status: "failed" as const };
      runs = [saved];
      return saved;
    });
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.testWorkspaceHook).toHaveBeenCalledExactlyOnceWith("one", "hook");
    expect(s.notice?.message).toContain("failed, attempt 1");
    expect(s.mutation.locked).toBe(false);
  });
  it("only replays a fresh completed observer and preserves queued outcome truth", async () => {
    hooks = [hook];
    runs = [run];
    await mount();
    await act(async () => s.selectHook("hook"));
    await act(async () => s.reviewRedrive({ ...run, status: "running" }));
    expect(s.review).toBeNull();
    await act(async () => s.reviewRedrive(run));
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.redriveWorkspaceHookRun).toHaveBeenCalledExactlyOnceWith("one", "run");
    expect(s.notice?.message).toContain("queued, attempt 0");
    expect(s.notice?.message).toContain("does not prove delivery");
  });
  it("withholds stale delete then verifies exact record absence without claiming secret destruction", async () => {
    hooks = [hook];
    await mount();
    await act(async () => s.selectHook("hook"));
    await act(async () => s.reviewHook("delete", hook));
    hooks = [{ ...hook, label: "Changed" }];
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.deleteWorkspaceHook).not.toHaveBeenCalled();
    expect(s.review).toBeNull();
    expect(s.notice?.message).toContain("The hook changed");
    hooks = [hook];
    await act(async () => s.reviewHook("delete", hook));
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.deleteWorkspaceHook).toHaveBeenCalledExactlyOnceWith("one", "hook");
    expect(s.notice?.message).toContain("secret cleanup is unverified");
    expect(s.hooks).toEqual([]);
  });
});
