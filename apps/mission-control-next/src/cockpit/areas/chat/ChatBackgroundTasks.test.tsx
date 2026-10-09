// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import {
  controlDurableBackgroundTask,
  fetchDurableBackgroundTaskRail,
} from "@goatcitadel/mission-control-shared/api/durable";
import { __resetBackgroundControlsForTests } from "../../../features/threaded-surface/useDurableBackgroundTaskRail";
import { ChatBackgroundTasks } from "./ChatBackgroundTasks";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";

vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  controlDurableBackgroundTask: vi.fn(),
  fetchDurableBackgroundTaskRail: vi.fn(),
}));
const callbacks = vi.hoisted(() => ({ confirm: undefined as ComponentProps<"button">["onClick"] }));
vi.mock("../../ui/Button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => {
    if (children === "Cancel task") callbacks.confirm = props.onClick;
    return <button {...props} type={props.type ?? "button"}>{children}</button>;
  },
}));
let root: Root;
let container: HTMLDivElement;
let state: DurableBackgroundTaskRailResponse;
let draft: ReturnType<typeof useSessionDraft<{ text: string }>>;
let mounts = 0,
  unmounts = 0;
function DraftProbe() {
  draft = useSessionDraft("background-evidence-navigation", { text: "Saved" }, 1, {
    label: "Background evidence draft",
  });
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return null;
}
const fetchRail = vi.mocked(fetchDurableBackgroundTaskRail);
const control = vi.mocked(controlDurableBackgroundTask);
function input(sessionId = "parent-session"): MissionThreadedRenderSurfaceInput {
  // The component only reads this host-owned projection; no controller/network fixture is mounted.
  return {
    activeSessionSurfaceProps: {
      workspaceId: "workspace",
      selectedSessionId: sessionId,
      thread: { turns: [{ turnId: "turn", trace: { durable: { runId: "parent" } } }] },
    },
  } as unknown as MissionThreadedRenderSurfaceInput;
}
const buttons = (scope: ParentNode, name: string) =>
  Array.from(scope.querySelectorAll("button")).filter((item) => item.textContent === name);
const dialog = () => document.querySelector('[role="dialog"]')!;
async function click(scope: ParentNode, name: string) {
  const button = buttons(scope, name)[0];
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
beforeEach(async () => {
  __resetBackgroundControlsForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  mounts = 0;
  unmounts = 0;
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/chat?sessionId=parent-session");
  state = {
    version: "durable.background_task_rail.v1",
    generatedAt: "2026-10-01T00:00:00.000Z",
    scope: { workspaceId: "workspace", sessionId: "parent-session", verified: true },
    parent: { runId: "parent", status: "completed", version: 2, links: [] },
    coverage: {
      watchers: { complete: true, observedCount: 1, limit: 500 },
      parentSignals: { complete: true, observedCount: 0, limit: 2000 },
    },
    tasks: [
      {
        watcherId: "watcher",
        watcherRevision: 5,
        watcherState: "attached",
        watcherUpdatedAt: "2026-10-01T00:00:00.000Z",
        childRunId: "child",
        childVersion: 3,
        canonicalStatus: "running",
        label: "Exact child",
        scope: { workspaceId: "workspace", sessionId: "child-session", verified: true },
        tools: [],
        approvals: [],
        blockers: [],
        toolCoverage: { complete: true, observedCount: 0, limit: 200 },
        output: { availability: "not_terminal" },
        attention: {
          state: "foreground",
          reason: "watcher_attached",
          required: false,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        signalIntegrity: {
          observedCount: 0,
          acceptedCount: 0,
          duplicateCount: 0,
          outOfOrderCount: 0,
          conflictingSequenceCount: 0,
          highestAcceptedSequence: 0,
          observationComplete: true,
          posture: "clean",
        },
        controls: { detach: { enabled: true }, reattach: { enabled: false }, cancel: { enabled: true } },
        links: [],
      },
    ],
    synthesis: {
      availability: "missing",
      lineage: [],
      missingTerminalChildRunIds: [],
      uncoveredChildRunIds: [],
      uncoveredStepIds: [],
    },
    unknowns: [],
  };
  fetchRail.mockImplementation(async () => structuredClone(state));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CockpitNavigationProvider><ChatBackgroundTasks input={input()} turnId="turn" /></CockpitNavigationProvider>);
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  __resetBackgroundControlsForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.restoreAllMocks();
});

it("keeps an owner conflict visible inside the dialog through refresh and requires a fresh review", async () => {
  await click(container, "Cancel task");
  expect(dialog().textContent).toContain("Task version 3 · Watcher revision 5");
  control.mockRejectedValue(
    new ApiRequestError("409", {
      kind: "http",
      method: "POST",
      status: 409,
      path: "/api/v1/durable/runs/parent/background-tasks/watcher/control",
      body: { error: "Durable run child changed from version 3 to 4 before cancellation." },
    }),
  );
  state.tasks[0]!.childVersion = 4;
  await click(dialog(), "Cancel task");
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Close this review");
  expect(dialog().textContent).toContain("Task version 3 · Watcher revision 5");
  expect(buttons(dialog(), "Cancel task")[0]!.disabled).toBe(true);
  expect(control).toHaveBeenCalledTimes(1);
  await click(dialog(), "Keep running");
  await click(container, "Refresh");
  await click(container, "Cancel task");
  expect(dialog().textContent).toContain("Task version 4 · Watcher revision 5");
  expect(buttons(dialog(), "Cancel task")[0]!.disabled).toBe(false);
});

it("withholds a locally stale confirmation and never upgrades reviewed versions after refresh", async () => {
  await click(container, "Cancel task");
  state.tasks[0]!.childVersion = 4;
  // The same refresh is also used by the active polling owner.
  await click(container, "Refresh");
  await click(dialog(), "Cancel task");
  expect(control).not.toHaveBeenCalled();
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("changed before");
  expect(dialog().textContent).toContain("Task version 3");
});

it("closes a review across URL ABA and rejects its retained control", async () => {
  await click(container, "Cancel task");
  const oldButton = buttons(dialog(), "Cancel task")[0]!;
  await act(async () => {
    window.history.pushState(null, "", "/chat?sessionId=other");
    window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
    window.history.pushState(null, "", "/chat?sessionId=parent-session");
    window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => {
    oldButton.click();
  });
  expect(control).not.toHaveBeenCalled();
});

it("shows and retains an unknown outcome inside review with no duplicate confirmation", async () => {
  await click(container, "Cancel task");
  control.mockRejectedValue(new Error("lost response"));
  await click(dialog(), "Cancel task");
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("unconfirmed");
  expect(buttons(dialog(), "Cancel task")[0]!.disabled).toBe(true);
  await click(dialog(), "Keep running");
  await click(container, "Refresh");
  expect(buttons(container, "Cancel task")[0]!.disabled).toBe(true);
  expect(control).toHaveBeenCalledTimes(1);
});

it("a dismissed or replaced dialog's retained confirmation cannot write", async () => {
  await click(container, "Cancel task");
  const dismissed = callbacks.confirm!;
  await click(dialog(), "Keep running");
  await act(async () => {
    dismissed({} as Parameters<typeof dismissed>[0]);
  });
  expect(control).not.toHaveBeenCalled();
  await click(container, "Cancel task");
  const replaced = callbacks.confirm!;
  await click(dialog(), "Keep running");
  await click(container, "Cancel task");
  await act(async () => {
    replaced({} as Parameters<typeof replaced>[0]);
  });
  expect(control).not.toHaveBeenCalled();
  expect(buttons(dialog(), "Cancel task")[0]!.disabled).toBe(false);
});

it("guards exact run evidence navigation while retaining the real draft and unknown control lock", async () => {
  state.tasks[0]!.childRunId = "child/one?detail";
  await act(async () => {
    root.render(
      <CockpitNavigationProvider>
        <ChatBackgroundTasks input={input()} turnId="turn" />
        <DraftProbe />
      </CockpitNavigationProvider>,
    );
  });
  await click(container, "Cancel task");
  control.mockRejectedValue(new Error("Control response was lost"));
  await click(dialog(), "Cancel task");
  await click(dialog(), "Keep running");
  expect(control).toHaveBeenCalledTimes(1);
  expect(buttons(container, "Cancel task")[0]!.disabled).toBe(true);
  await act(async () => {
    draft.setValue({ text: "Retained draft" });
  });
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  const push = vi.spyOn(window.history, "pushState");
  const href = "/work/runs/child%2Fone%3Fdetail?shell=cockpit";
  const evidence = container.querySelector<HTMLAnchorElement>("a")!;
  expect(evidence.textContent).toBe("Open run evidence");
  expect(evidence.getAttribute("href")).toBe(href);
  await act(async () => {
    evidence.click();
  });
  expect(dialog().textContent).toContain("Unsaved changes");
  expect(push).not.toHaveBeenCalled();
  expect(control).toHaveBeenCalledTimes(1);
  await click(dialog(), "Cancel");
  expect(window.location.pathname + window.location.search).toBe("/chat?sessionId=parent-session");
  expect(draft.value.text).toBe("Retained draft");
  expect(draft.isDirty).toBe(true);
  await act(async () => {
    evidence.click();
  });
  await click(dialog(), "Keep draft and close");
  expect(window.location.pathname + window.location.search).toBe(href);
  expect(push).toHaveBeenCalledTimes(1);
  expect(draft.value.text).toBe("Retained draft");
  expect(draft.isDirty).toBe(true);
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
  expect(container.textContent).toContain("unconfirmed");
  expect(buttons(container, "Cancel task")[0]!.disabled).toBe(true);
  expect(control).toHaveBeenCalledTimes(1);
  expect(assign).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
