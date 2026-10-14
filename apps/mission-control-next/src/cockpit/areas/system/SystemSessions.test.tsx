// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SystemSessions } from "./SystemSessions";
const fixture = vi.hoisted(() => ({
  search: "",
  hash: "",
  navigate: vi.fn(),
  workspace: "workspace-a",
  value: {} as Record<string, unknown>,
  control: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ search: fixture.search, hash: fixture.hash, navigate: fixture.navigate }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: fixture.workspace, setActiveWorkspaceId: vi.fn() }),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot", () => ({
  useOpsRuntimeSnapshot: () => fixture.value,
}));
vi.mock("../chat/SessionControlManager", () => ({
  SessionControlManager: (props: { sessionId: string; workspaceId: string }) => {
    fixture.control(props);
    return <p>Canonical control owner</p>;
  },
}));
vi.mock("../../../features/native-routes/ops/RunDetailRoutePage", () => ({
  RunDetailRoutePage: (props: unknown) => {
    fixture.run(props);
    return <p>Existing run evidence owner</p>;
  },
}));
let host: HTMLDivElement, root: Root;
const render = () => act(() => root.render(<SystemSessions />));
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fixture.search = "?workspaceId=workspace-a&extra=keep";
  fixture.hash = "#control";
  fixture.workspace = "workspace-a";
  fixture.value = {
    data: {
      sessions: [
        {
          sessionId: "session-a",
          displayName: "Owner conversation",
          channel: "web",
          lastActivityAt: "2026-10-13T00:00:00Z",
        },
      ],
      dashboard: { pendingApprovals: 3, activeSubagents: 1, recentEvents: [] },
      sourceStatus: { sessions: { status: "ok" }, dashboard: { status: "ok" } },
    },
    loading: false,
    error: null,
    isStale: false,
    reload: vi.fn(),
  };
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
it("uses the existing evidence list and selects details through native navigation preserving scope and fragment", () => {
  render();
  expect(host.textContent).toContain("Session evidence");
  expect(host.textContent).toContain("Owner conversation");
  expect(fixture.control).not.toHaveBeenCalled();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Inspect Owner conversation"]')!.click());
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(
    "/system/sessions?workspaceId=workspace-a&extra=keep&sessionId=session-a#control",
  );
});
it("binds the canonical control owner to the selected session and active workspace independently of list presence", () => {
  fixture.search += "&sessionId=older-session";
  render();
  expect(fixture.control).toHaveBeenCalledWith({ sessionId: "older-session", workspaceId: "workspace-a" });
  expect(host.textContent).toContain("This record is unavailable in the current response.");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!.click());
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(
    "/system/sessions?workspaceId=workspace-a&extra=keep#control",
  );
});
it.each(["?runId=r%2F1&sessionId=s", "?view=run-detail"])("preserves the existing run evidence owner: %s", (search) => {
  fixture.search = search;
  render();
  expect(host.textContent).toContain("Existing run evidence owner");
  expect(fixture.control).not.toHaveBeenCalled();
  expect(fixture.run).toHaveBeenCalledWith(
    expect.objectContaining({
      route: expect.objectContaining({ area: "ops", section: "sessions" }),
      activeWorkspaceId: "workspace-a",
    }),
  );
});
it("keeps a failed session source visible as degraded instead of a clean empty list", () => {
  const data = fixture.value.data as { sessions: unknown[]; sourceStatus: Record<string, unknown> };
  data.sessions = [];
  data.sourceStatus.sessions = { status: "error", message: "Canonical sessions unavailable" };
  render();
  expect(host.textContent).toContain("Live runtime data is degraded");
  expect(fixture.control).not.toHaveBeenCalled();
});
