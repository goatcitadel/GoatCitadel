// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { createTask, fetchTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkTaskCreate } from "./WorkTaskCreate";
import {
  __resetSessionDraftsForTests,
  discardSessionDraft,
} from "../../../features/native-routes/library/session-drafts";
import { taskCreateDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { KanbanNewTask } from "../../../features/native-routes/ops/KanbanNewTask";
import { __resetTaskMutationsForTests } from "../../../features/native-routes/ops/task-mutation-state";

const gateway = vi.hoisted(() => ({ base: "http://127.0.0.1:8787" }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>()),
  getGatewayApiBaseUrl: () => gateway.base,
}));

vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ createTask: vi.fn(), fetchTask: vi.fn() }));

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "task-new",
  revision: 1,
  workspaceId: "workspace-a",
  title: "Review launch plan",
  status: "inbox",
  priority: "high",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let preferences: ReturnType<typeof useUiPreferences>;
function ScopeProbe() {
  preferences = useUiPreferences();
  return null;
}
const onCreated = vi.fn<(task: TaskRecord) => void>();

beforeEach(() => {
  gateway.base = "http://127.0.0.1:8787";
  window.localStorage.clear();
  __resetTaskMutationsForTests();
  __resetSessionDraftsForTests();
  vi.mocked(fetchTask).mockResolvedValue(task());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

async function render(workspaceId = "workspace-a"): Promise<void> {
  await act(async () =>
    root.render(
      <UiPreferencesProvider>
        <ScopeProbe />
        <QueryClientProvider client={client}>
          <WorkTaskCreate workspaceId={workspaceId} onClose={vi.fn()} onCreated={onCreated} />
        </QueryClientProvider>
      </UiPreferencesProvider>,
    ),
  );
}

async function fill(title = "Review launch plan", priority = "high"): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[maxlength="160"]');
  const select = container.querySelector<HTMLSelectElement>("select");
  if (!input || !select) throw new Error("Missing task inputs");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    select.value = priority;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
}

describe("cockpit task creation", () => {
  it("creates only after review and confirmation in the selected workspace", async () => {
    vi.mocked(createTask).mockResolvedValue(task());
    await render();
    await fill();
    await click("Review task");
    expect(createTask).not.toHaveBeenCalled();
    await click("Confirm create");
    await vi.waitFor(() =>
      expect(createTask).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        title: "Review launch plan",
        priority: "high",
      }),
    );
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(task()));
  });

  it("does not navigate on an unconfirmed Gateway record", async () => {
    vi.mocked(createTask).mockResolvedValue(task({ workspaceId: "other-workspace" }));
    await render();
    await fill();
    await click("Review task");
    await click("Confirm create");
    await vi.waitFor(() => expect(container.textContent).toContain("create outcome is unconfirmed"));
    expect(onCreated).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>("button[disabled]")?.disabled).toBe(true);
  });

  it("prevents retry after a response is lost", async () => {
    vi.mocked(createTask).mockRejectedValue(new Error("Response lost"));
    await render();
    await fill();
    await click("Review task");
    await click("Confirm create");
    await vi.waitFor(() => expect(container.textContent).toContain("create outcome is unconfirmed"));
    await click("Close");
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(container.querySelector('a[href="/ops/kanban?shell=classic&shellScope=visit"]')).not.toBeNull();
  });
});

describe("retained task creation input", () => {
  it("keeps the same workspace's input separate between installations", async () => {
    await render();
    await fill("Installation A draft");
    await act(async () => root.render(null));
    gateway.base = "http://127.0.0.1:9787";
    await render();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    await fill("Installation B draft");
    await act(async () => root.render(null));
    gateway.base = "http://127.0.0.1:8787";
    await render();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Installation A draft");
    await act(async () => root.render(null));
    gateway.base = "http://127.0.0.1:9787";
    await render();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Installation B draft");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("keeps drafts across unmount and isolates workspace input without creating records", async () => {
    await render();
    await fill("Workspace A draft");
    await act(async () => root.render(null));
    await render("workspace-b");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    await fill("Workspace B draft");
    await render();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Workspace A draft");
    await render("workspace-b");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Workspace B draft");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("shares the unsent creation draft with the Classic Kanban owner", async () => {
    await render();
    await fill("Shared task draft");
    const citadelId = preferences.activeCitadelId;
    await act(async () =>
      root.render(
        <UiPreferencesProvider>
          <ScopeProbe />
          <QueryClientProvider client={client}>
            <KanbanNewTask workspaceId="workspace-a" citadelId={citadelId} onCreated={onCreated} />
          </QueryClientProvider>
        </UiPreferencesProvider>,
      ),
    );
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Shared task draft");
    await render();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Shared task draft");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("discarding text retains an uncertain creation lock after remount", async () => {
    vi.mocked(createTask).mockRejectedValue(new Error("Response lost"));
    await render();
    await fill();
    await click("Review task");
    await click("Confirm create");
    await vi.waitFor(() => expect(container.textContent).toContain("create outcome is unconfirmed"));
    await act(async () =>
      discardSessionDraft(taskCreateDraftKey(getGatewayApiBaseUrl(), "workspace-a", preferences.activeCitadelId)),
    );
    await act(async () => root.render(null));
    await render();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("settles a verified origin draft after unmount without clearing another workspace", async () => {
    let resolve!: (value: TaskRecord) => void;
    vi.mocked(createTask).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await fill();
    await click("Review task");
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "Confirm create",
    )!;
    await act(async () => {
      confirm.click();
    });
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    await render("workspace-b");
    await fill("Keep workspace B");
    await act(async () => resolve(task()));
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Keep workspace B");
    expect(onCreated).not.toHaveBeenCalled();
    await render();
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(""));
  });
});

describe("confirmed task draft acknowledgement", () => {
  it("opens its verified task after a delayed query refresh and clearing the submitted input", async () => {
    vi.mocked(createTask).mockResolvedValue(task());
    let release!: () => void;
    const refreshed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(refreshed);
    await render();
    await fill();
    await click("Review task");
    await click("Confirm create");
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(onCreated).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(task()));
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it.each(["input", "input-aba", "workspace-aba", "citadel", "citadel-aba"] as const)(
    "withholds obsolete task navigation after %s during refresh",
    async (kind) => {
      vi.mocked(createTask).mockResolvedValue(task());
      let release!: () => void;
      const refreshed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(refreshed);
      await render();
      await fill();
      await click("Review task");
      await click("Confirm create");
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
      if (kind === "workspace-aba") {
        await render("workspace-b");
        await render();
      } else if (kind === "citadel" || kind === "citadel-aba") {
        const originCitadel = preferences.activeCitadelId;
        await act(async () => preferences.setActiveCitadelId("other-citadel"));
        if (kind === "citadel-aba") await act(async () => preferences.setActiveCitadelId(originCitadel));
      } else {
        await fill("Newer input");
        if (kind === "input-aba") {
          await fill("", "normal");
          expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
          expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe("normal");
        }
      }
      await act(async () => {
        release();
      });
      expect(onCreated).not.toHaveBeenCalled();
      expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(kind === "input" ? "Newer input" : "");
      expect(createTask).toHaveBeenCalledTimes(1);
    },
  );
});

describe("confirmed creation refresh feedback", () => {
  it("retains a failed refresh notice after acknowledging the submitted input", async () => {
    vi.mocked(createTask).mockResolvedValue(task());
    let reject!: (error: Error) => void;
    const refreshed = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(refreshed);
    await render();
    await fill();
    await click("Review task");
    await click("Confirm create");
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    await act(async () => {
      reject(new Error("Refresh unavailable"));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("task was created and confirmed"));
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
  });
});
