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
  showTechnicalDetails: false,
  value: {} as Record<string, unknown>,
  control: vi.fn(),
  mounts: vi.fn(),
  unmounts: vi.fn(),
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ search: fixture.search, hash: fixture.hash, navigate: fixture.navigate }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({
    activeWorkspaceId: fixture.workspace,
    setActiveWorkspaceId: vi.fn(),
    showTechnicalDetails: fixture.showTechnicalDetails,
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot", () => ({
  useOpsRuntimeSnapshot: () => fixture.value,
}));
vi.mock("../chat/SessionControlManager", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    SessionControlManager: (props: { sessionId: string; workspaceId: string }) => {
      fixture.control(props);
      // The workspace this instance mounted with: a prop change alone must not look like a remount.
      const mountedWith = useRef(props.workspaceId);
      useEffect(() => {
        const workspaceId = mountedWith.current;
        fixture.mounts(workspaceId);
        return () => fixture.unmounts(workspaceId);
      }, []);
      return <p>Session controls</p>;
    },
  };
});
vi.mock("./SystemOwnerLink", () => ({
  SystemOwnerLink: ({ href, children }: { href: string; children: string }) => <a href={href}>{children}</a>,
}));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ href, children }: { href: string; children: string }) => <a href={href}>{children}</a>,
}));
let host: HTMLDivElement, root: Root;
const render = () => act(() => root.render(<SystemSessions />));
const sectionTitled = (title: string) =>
  [...host.querySelectorAll("section section")].find((node) => node.querySelector("h2")?.textContent === title);
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fixture.search = "?workspaceId=workspace-a&extra=keep";
  fixture.hash = "#control";
  fixture.workspace = "workspace-a";
  fixture.showTechnicalDetails = false;
  fixture.value = {
    data: {
      sessions: [
        {
          sessionId: "session-a",
          displayName: "Owner conversation",
          channel: "web",
          kind: "dm",
          account: "operator",
          health: "healthy",
          budgetState: "ok",
          tokenInput: 1,
          tokenOutput: 1,
          tokenTotal: 2,
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
it("renders a native page with no Classic chrome or copy", () => {
  render();
  expect(host.querySelector("h1")?.textContent).toBe("Sessions");
  expect(host.querySelector(".cockpit-embedded-classic")).toBeNull();
  expect(host.textContent).not.toMatch(/Session evidence|posture/i);
  expect(sectionTitled("Recent sessions")?.textContent).toContain("Owner conversation");
  expect(fixture.control).not.toHaveBeenCalled();
});
it("selects details through native navigation preserving scope and fragment", () => {
  render();
  const details = host.querySelector<HTMLButtonElement>('[aria-label="Details: Owner conversation"]')!;
  expect(details.textContent).toBe("Details");
  act(() => details.click());
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(
    "/system/sessions?workspaceId=workspace-a&extra=keep&sessionId=session-a#control",
  );
});
it("shows a listed session by name, keeping its id out of view", () => {
  fixture.search += "&sessionId=session-a";
  render();
  expect(host.querySelector("#selected-session h2")?.textContent).toBe("Owner conversation");
  expect(host.textContent).not.toContain("session-a");
  expect(fixture.control).toHaveBeenCalledWith({ sessionId: "session-a", workspaceId: "workspace-a" });
});
it("binds the session controls to an unlisted session and the active workspace, and closes it", () => {
  fixture.search += "&sessionId=older-session";
  render();
  expect(fixture.control).toHaveBeenCalledWith({ sessionId: "older-session", workspaceId: "workspace-a" });
  expect(host.textContent).toContain("isn't in the recent list");
  const close = host.querySelector<HTMLButtonElement>("#selected-session button")!;
  expect(close.textContent).toBe("Close session");
  act(() => close.click());
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(
    "/system/sessions?workspaceId=workspace-a&extra=keep#control",
  );
});
it("remounts the session controls when the workspace changes, so no state carries over", () => {
  fixture.search += "&sessionId=session-a";
  render();
  expect(fixture.mounts).toHaveBeenCalledExactlyOnceWith("workspace-a");
  fixture.workspace = "workspace-b";
  render();
  expect(fixture.unmounts).toHaveBeenCalledExactlyOnceWith("workspace-a");
  expect(fixture.mounts).toHaveBeenLastCalledWith("workspace-b");
  expect(fixture.control).toHaveBeenLastCalledWith({ sessionId: "session-a", workspaceId: "workspace-b" });
});
it("does not blame the recent list for a selected session when the list couldn't be read", () => {
  const data = fixture.value.data as { sessions: unknown[]; sourceStatus: Record<string, unknown> };
  data.sessions = [];
  data.sourceStatus.sessions = { status: "error", message: "down" };
  fixture.search += "&sessionId=older-session";
  render();
  expect(host.textContent).toContain("Recent sessions couldn't be read, so this session's details aren't shown");
  expect(host.textContent).not.toContain("isn't in the recent list");
  expect(fixture.control).toHaveBeenCalledWith({ sessionId: "older-session", workspaceId: "workspace-a" });
});
it("keeps a failed session source visible instead of a clean empty list", () => {
  const data = fixture.value.data as { sessions: unknown[]; sourceStatus: Record<string, unknown> };
  data.sessions = [];
  data.sourceStatus.sessions = { status: "error", message: "Sessions unavailable upstream" };
  render();
  expect(host.textContent).toContain("Sessions couldn't be read");
  expect(host.textContent).toContain("1 session source is unavailable");
  expect(host.textContent).not.toContain("No sessions have recent activity");
  expect(sectionTitled("Across all workspaces")?.textContent).toContain("3");
});
it("labels the installation-wide approval count", () => {
  render();
  expect(host.textContent).toContain("Pending approvals, all workspaces");
  expect(host.textContent).not.toContain("Decision queue pressure");
});
it("opens a run link in Work with its scope and fragment", () => {
  fixture.search = "?runId=run_0123456789abcdef&workspaceId=workspace-a&sessionId=s&view=run-detail";
  fixture.hash = "#receipt";
  render();
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(
    "/work/runs/run_0123456789abcdef?workspaceId=workspace-a#receipt",
    { replace: true },
  );
});
it.each(["?view=run-detail", "?runId=%20padded%20", "?runId=..", "?runId=.", "?runId=a&runId=b"])(
  "explains a missing or unusable run: %s",
  (search) => {
    fixture.search = search;
    render();
    expect(host.querySelector("h1")?.textContent).toBe("Run detail");
    expect(host.textContent).toContain("No run chosen");
    expect(host.querySelector("a")?.textContent).toBe("Open Work › History");
    expect(fixture.navigate).not.toHaveBeenCalled();
  },
);
