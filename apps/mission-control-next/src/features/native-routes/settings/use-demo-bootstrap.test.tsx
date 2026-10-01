// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoBootstrapStateResponse } from "@goatcitadel/contracts";
import { useDemoBootstrap } from "./use-demo-bootstrap";
import { demoFixture } from "./demo-bootstrap.test-support";
import { __resetDemoReceiptsForTests } from "./demo-bootstrap-state";
import { __resetOnboardingAttemptsForTests } from "./onboarding-completion-state";
const api = vi.hoisted(() => ({
  base: "installation-a",
  fetchDemoState: vi.fn(),
  bootstrapDemo: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchChatProjects: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchTask: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTask: api.fetchTask }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root,
  fixture: ReturnType<typeof demoFixture>,
  state: DemoBootstrapStateResponse,
  control: ReturnType<typeof useDemoBootstrap>;
function Probe({ scope = "workspace-a" }) {
  control = useDemoBootstrap(scope);
  return null;
}
async function render(scope = "workspace-a") {
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe scope={scope} />
      </StrictMode>,
    ),
  );
}
async function review() {
  await act(async () => control.begin());
  expect(control.review).not.toBeNull();
}
beforeEach(() => {
  vi.resetAllMocks();
  api.base = "installation-a";
  fixture = demoFixture();
  state = fixture.empty;
  api.fetchDemoState.mockImplementation(async () => structuredClone(state));
  api.bootstrapDemo.mockImplementation(async () => {
    state = fixture.state;
    return structuredClone(fixture.receipt);
  });
  api.fetchWorkspaces.mockResolvedValue({ items: [fixture.workspace] });
  api.fetchChatProjects.mockResolvedValue({ items: [fixture.project] });
  api.fetchChatSessions.mockResolvedValue({ items: [fixture.session] });
  api.fetchTask.mockImplementation(async (id: string) => {
    const task = fixture.tasks.find((item) => item.taskId === id);
    if (!task) throw Error("not found");
    return task;
  });
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  __resetDemoReceiptsForTests();
  __resetOnboardingAttemptsForTests();
});
describe("shared reviewed demo bootstrap", () => {
  it("confirms actual owner records separately from opening and does not invent a CAS token", async () => {
    await render();
    await review();
    expect(api.bootstrapDemo).not.toHaveBeenCalled();
    const once = control.confirm;
    await act(async () => {
      await once();
      await once();
    });
    expect(api.bootstrapDemo).toHaveBeenCalledExactlyOnceWith();
    expect(control.receipt?.status).toBe("ready");
    expect(control.locked).toBe(false);
    const navigate = vi.fn();
    await act(async () => control.open(navigate));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      workspaceId: fixture.workspace.workspaceId,
      citadelId: fixture.workspace.citadelId,
      projectId: fixture.project.projectId,
      sessionId: fixture.session.sessionId,
    });
    const signals = api.fetchDemoState.mock.calls.map((call) => call[0].signal);
    expect(new Set(signals).size).toBe(signals.length);
  });
  it("cancels review with zero writes", async () => {
    await render();
    await review();
    await act(async () => control.cancel());
    await act(async () => control.confirm());
    expect(api.bootstrapDemo).not.toHaveBeenCalled();
  });
  it("rejects a stored review callback after a refresh even when the owner returns identical records", async () => {
    await render();
    await review();
    const confirm = control.confirm;
    await act(async () => control.refresh());
    await act(async () => confirm());
    expect(api.bootstrapDemo).not.toHaveBeenCalled();
  });
  it.each(["scope", "refresh", "unmount"])("withholds a late preflight after %s", async (kind) => {
    await render();
    await review();
    const wait = deferred<DemoBootstrapStateResponse>();
    api.fetchDemoState.mockReturnValueOnce(wait.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = control.confirm();
    });
    if (kind === "scope") {
      await render("workspace-b");
      await render();
    }
    if (kind === "refresh") await act(async () => control.refresh());
    if (kind === "unmount") await act(async () => root.render(null));
    await act(async () => {
      wait.resolve(fixture.empty);
      await pending;
    });
    expect(api.bootstrapDemo).not.toHaveBeenCalled();
  });
  it("blocks a changed canonical demo before POST", async () => {
    await render();
    await review();
    state = fixture.state;
    await act(async () => control.confirm());
    expect(api.bootstrapDemo).not.toHaveBeenCalled();
    expect(control.message).toContain("changed");
  });
  it("retains partial notes after remount even when the GET counts records as ready", async () => {
    fixture.receipt.status = "partial";
    fixture.receipt.notes = ["Memory seed skipped: policy withheld the sample"];
    await render();
    await review();
    await act(async () => control.confirm());
    await act(async () => root.render(null));
    await render("classic-view");
    expect(control.state?.status).toBe("ready");
    expect(control.receipt?.status).toBe("partial");
    expect(control.receipt?.notes[0]).toContain("skipped");
  });
  it.each(["lost", "foreign-record", "readback", "installation"])(
    "retains a post-dispatch %s uncertainty across shells",
    async (kind) => {
      await render();
      await review();
      if (kind === "lost") api.bootstrapDemo.mockRejectedValue(new Error("lost response"));
      if (kind === "foreign-record")
        api.fetchChatSessions.mockResolvedValue({ items: [{ ...fixture.session, workspaceId: "foreign" }] });
      if (kind === "readback")
        api.bootstrapDemo.mockImplementation(async () => {
          state = { ...fixture.state, project: { ...fixture.state.project!, projectId: "other" } };
          return fixture.receipt;
        });
      if (kind === "installation")
        api.bootstrapDemo.mockImplementation(async () => {
          api.base = "installation-b";
          return fixture.receipt;
        });
      await act(async () => control.confirm());
      api.base = "installation-a";
      await act(async () => root.render(null));
      await render("classic-view");
      expect(control.attempt?.phase).toBe("unknown");
      await act(async () => control.begin());
      expect(control.review).toBeNull();
      expect(api.bootstrapDemo).toHaveBeenCalledTimes(1);
    },
  );
  it("does not open a destination after navigation while its canonical children are loading", async () => {
    state = fixture.state;
    await render();
    const wait = deferred<{ items: (typeof fixture.workspace)[] }>();
    api.fetchWorkspaces.mockReturnValueOnce(wait.promise);
    const navigate = vi.fn();
    let pending!: Promise<void>;
    act(() => {
      pending = control.open(navigate);
    });
    await vi.waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalled());
    await render("workspace-b");
    await render();
    await act(async () => {
      wait.resolve({ items: [fixture.workspace] });
      await pending;
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});
