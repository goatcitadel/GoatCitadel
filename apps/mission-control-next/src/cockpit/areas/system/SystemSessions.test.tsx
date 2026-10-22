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
vi.mock("../../data/use-workspace-name", () => ({
  useWorkspaceName: (_citadel: string | undefined, id: string | undefined) =>
    id === "workspace-a" ? "Workspace A" : undefined,
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
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Details: Owner conversation"]')!.click());
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(
    "/system/sessions?workspaceId=workspace-a&extra=keep&sessionId=session-a#control",
  );
});
it("session Details button: accessible name starts with the visible text", () => {
  render();
  const details = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Details")!;
  expect(details.getAttribute("aria-label")).toMatch(/^Details/);
  expect(details.getAttribute("aria-label")).toBe("Details: Owner conversation");
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
  // The embedded run page drops its own h1, so the cockpit header names the selected run.
  expect(host.querySelector("h1")?.textContent).toBe(search.includes("runId") ? "Run" : "Run detail");
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
it("passes the workspace name, never the id, to the embedded session pages", () => {
  render();
  expect(host.textContent).toContain("Workspace A");
  expect(host.textContent).not.toMatch(/Workspace\s*workspace-a/);
});
it("contains the embedded session pages", () => {
  render();
  const inspect = host.querySelector('[aria-label="Inspect Owner conversation"]');
  expect(inspect?.closest(".cockpit-embedded-classic")).not.toBeNull();
});
it("titles a run detail with Run and names the workspace", () => {
  fixture.search = "?workspaceId=workspace-a&runId=run_0123456789abcdef";
  render();
  expect(host.querySelector("h1")?.textContent).toBe("Run");
  expect(fixture.run).toHaveBeenCalledWith(expect.objectContaining({ activeWorkspaceName: "Workspace A" }));
  expect(host.querySelector("h1")?.closest(".cockpit-embedded-classic")).toBeNull();
  expect(host.textContent).toContain("Existing run evidence owner");
});
it("labels the installation-wide approval count in the session panel", () => {
  render();
  expect(host.textContent).toContain("Pending approvals, all workspaces");
  expect(host.textContent).not.toContain("Decision queue pressure");
});
