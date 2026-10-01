import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { createTask, fetchTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useTaskCreate } from "./use-task-create";
import { __resetTaskMutationsForTests } from "./task-mutation-state";

vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ createTask: vi.fn(), fetchTask: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: vi.fn() }));
const draft = { title: "Review release", description: "Read the evidence", priority: "normal" as const };
const task = (): TaskRecord => ({
  ...draft,
  taskId: "task-created",
  workspaceId: "ws-a",
  revision: 1,
  status: "inbox",
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z",
});
type Props = Parameters<typeof useTaskCreate>[0];
let control: ReturnType<typeof useTaskCreate>;
function Harness(props: Props) {
  control = useTaskCreate(props);
  return null;
}
const props = (overrides: Partial<Props> = {}): Props => ({ workspaceId: "ws-a", draft, ...overrides });
async function mount(value = props()) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Harness {...value} />
      </StrictMode>,
    );
  });
  return renderer;
}
async function update(renderer: ReactTestRenderer, value: Props) {
  await act(async () =>
    renderer.update(
      <StrictMode>
        <Harness {...value} />
      </StrictMode>,
    ),
  );
}
async function review() {
  await act(async () => control.begin());
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.resetAllMocks();
  __resetTaskMutationsForTests();
  vi.mocked(getGatewayApiBaseUrl).mockReturnValue("http://gateway-a");
  vi.mocked(createTask).mockResolvedValue(task());
  vi.mocked(fetchTask).mockResolvedValue(task());
});

describe("shared task creation", () => {
  it("requires explicit review and confirms exact scoped readback in StrictMode", async () => {
    await mount();
    const done = vi.fn();
    await act(async () => {
      await control.confirm(done);
    });
    expect(createTask).not.toHaveBeenCalled();
    await review();
    await act(async () => {
      await control.confirm(done);
    });
    expect(createTask).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a", ...draft });
    expect(fetchTask).toHaveBeenCalledWith("task-created", "ws-a", undefined, { signal: expect.any(AbortSignal) });
    expect(done).toHaveBeenCalledWith(task(), expect.any(Function));
    expect(control.locked).toBe(false);
  });

  it.each(["scope", "draft"] as const)("rejects a queued review after %s away and back", async (kind) => {
    const renderer = await mount();
    await review();
    const oldConfirm = control.confirm;
    await update(
      renderer,
      kind === "scope" ? props({ workspaceId: "ws-b" }) : props({ draft: { ...draft, title: "Other" } }),
    );
    await update(renderer, props());
    await act(async () => {
      await oldConfirm(vi.fn());
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("cancels an old review on synchronous input invalidation and on unmount", async () => {
    const renderer = await mount();
    await review();
    const oldConfirm = control.confirm;
    await act(async () => control.invalidate());
    await act(async () => {
      await oldConfirm(vi.fn());
    });
    await review();
    const unmountedConfirm = control.confirm;
    await act(async () => renderer.unmount());
    await unmountedConfirm(vi.fn());
    expect(createTask).not.toHaveBeenCalled();
  });

  it("consumes a review exactly once, including queued completion callbacks", async () => {
    await mount();
    await review();
    const confirm = control.confirm;
    await act(async () => {
      await Promise.all([confirm(vi.fn()), confirm(vi.fn())]);
    });
    await act(async () => {
      await confirm(vi.fn());
    });
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("retains a lost-response lock across remount and both scope labels", async () => {
    vi.mocked(createTask).mockRejectedValue(new Error("response lost"));
    const renderer = await mount(props({ citadelId: "citadel-a" }));
    await review();
    await act(async () => {
      await control.confirm(vi.fn());
    });
    await act(async () => renderer.unmount());
    await mount();
    expect(control.uncertain).toBe(true);
    await review();
    await act(async () => {
      await control.confirm(vi.fn());
    });
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it.each(["description", "scope", "runtime", "readback"])(
    "withholds a mismatched %s receipt/readback",
    async (kind) => {
      const saved = task();
      if (kind === "description") saved.description = "Foreign content";
      if (kind === "scope") saved.workspaceId = "ws-b";
      if (kind === "runtime") saved.assignedAgentId = "unexpected-agent";
      if (kind === "readback") vi.mocked(fetchTask).mockResolvedValue({ ...saved, revision: 2 });
      else vi.mocked(createTask).mockResolvedValue(saved);
      await mount();
      await review();
      const done = vi.fn();
      await act(async () => {
        await control.confirm(done);
      });
      expect(done).not.toHaveBeenCalled();
      expect(control.uncertain).toBe(true);
    },
  );

  it("acknowledges the origin after late canonical success without refreshing a new scope", async () => {
    const readback = deferred<TaskRecord>();
    vi.mocked(fetchTask).mockReturnValue(readback.promise);
    const onRecorded = vi.fn(),
      done = vi.fn();
    const renderer = await mount(props({ onRecorded }));
    await review();
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm(done);
    });
    await update(renderer, props({ workspaceId: "ws-b" }));
    await act(async () => {
      readback.resolve(task());
      await pending;
    });
    expect(onRecorded).toHaveBeenCalledWith(task(), draft);
    expect(done).not.toHaveBeenCalled();
    await update(renderer, props());
    expect(control.locked).toBe(false);
  });

  it("does not accept settlement from another installation", async () => {
    const readback = deferred<TaskRecord>();
    vi.mocked(fetchTask).mockReturnValue(readback.promise);
    const onRecorded = vi.fn(),
      done = vi.fn();
    await mount(props({ onRecorded }));
    await review();
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm(done);
    });
    vi.mocked(getGatewayApiBaseUrl).mockReturnValue("http://gateway-b");
    await act(async () => {
      readback.resolve(task());
      await pending;
    });
    expect(onRecorded).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    vi.mocked(getGatewayApiBaseUrl).mockReturnValue("http://gateway-a");
    await mount();
    expect(control.uncertain).toBe(true);
  });

  it("keeps canonical success after an acknowledgement or presentation callback fails", async () => {
    await mount(
      props({
        onRecorded: () => {
          throw new Error("draft view gone");
        },
      }),
    );
    await review();
    await act(async () => {
      await control.confirm(() => {
        throw new Error("view failed");
      });
    });
    expect(control.uncertain).toBe(false);
    expect(control.locked).toBe(false);
    expect(control.message).toContain("created and confirmed");
  });
});
