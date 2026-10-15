// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ChangePlanRecord, OperatorInboxResponse } from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { InspectorProvider } from "../../app/inspector";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { InboxArea } from "../inbox/InboxArea";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";

const api = vi.hoisted(() => ({ read: vi.fn(), inbox: vi.fn(), list: vi.fn(), resolve: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/approvals")>()),
  fetchApproval: api.read,
  fetchApprovals: api.list,
}));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/operator-inbox")>()),
  fetchOperatorInbox: api.inbox,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  resolveApproval: api.resolve,
}));
const approvalId = "approval /?# exact";
function plan(): ChangePlanRecord {
  const value = awaitingLlamaApproval(llamaPlanFixture());
  if (value.requiredAction?.kind !== "approval") throw new Error("Missing canonical approval fixture");
  return { ...value, approvalRefs: [approvalId], requiredAction: { ...value.requiredAction, approvalId } };
}
function approval(workspaceId = "workspace-a"): ApprovalRequest {
  return {
    approvalId,
    kind: "tool_execution",
    riskLevel: "danger",
    status: "pending",
    payload: {},
    preview: { targets: ["reviewed/selected-file.ts"], commands: [] },
    createdAt: "2026-09-30T00:00:00.000Z",
    explanationStatus: "completed",
    explanation: {
      summary: "Selected canonical approval evidence",
      riskExplanation: "Review the exact file.",
      generatedAt: "2026-09-30T00:00:00.000Z",
    },
    linkage: { workspaceId, runId: "run/one", sessionId: "session:one" },
  };
}
const emptyProjection: OperatorInboxResponse = {
  authority: "derived_projection",
  workspaceId: "workspace-a",
  generatedAt: "2026-09-30T00:00:00.000Z",
  items: [],
  coverage: [{ source: "approvals", state: "current" }],
  counts: {
    needs_decision: { known: 0, complete: true },
    proposals: { known: 0, complete: true },
    needs_attention: { known: 0, complete: true },
    updates: { known: 0, complete: true },
  },
};
function Destination() {
  const route = useCockpitRoute();
  if (route.resolution.kind !== "native") return <p role="status">Destination unavailable.</p>;
  if (route.area === "inbox") return <InboxArea />;
  return <SettingsApprovalOwnerAction plan={plan()} owner="llama-setup" workspaceId="workspace-a" />;
}
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  localStorage.clear();
  localStorage.setItem("goatcitadel.ui.workspace_id.v1", "workspace-a");
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.history.replaceState(
    { retained: "settings-context" },
    "",
    "/settings/advanced?workspaceId=stale&approvalId=old&runId=run%2Fone&sessionId=session%3Aone&extra=one&extra=two&source=settings&shell=cockpit#review",
  );
  api.read.mockReset().mockResolvedValue(approval());
  api.inbox.mockReset().mockResolvedValue(emptyProjection);
  api.list.mockReset().mockResolvedValue({ items: [] });
  api.resolve.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <CockpitNavigationProvider>
            <InspectorProvider>
              <Destination />
            </InspectorProvider>
          </CockpitNavigationProvider>
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
}
async function openSettingsApproval() {
  await render();
  const link = [...host.querySelectorAll<HTMLAnchorElement>("a")].find(
    (item) => item.textContent === "Review required approval",
  );
  expect(link).toBeDefined();
  await act(async () => link!.click());
}
function expectCanonicalLocation() {
  const target = new URL(window.location.href);
  expect(target.pathname).toBe("/inbox");
  expect(target.searchParams.getAll("approvalId")).toEqual([approvalId]);
  expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
  expect(target.searchParams.get("runId")).toBe("run/one");
  expect(target.searchParams.get("sessionId")).toBe("session:one");
  expect(target.searchParams.getAll("extra")).toEqual(["one", "two"]);
  expect(target.searchParams.get("shell")).toBe("cockpit");
  expect(target.hash).toBe("#review");
}
describe("Settings approval destination with actual native Inbox owners", () => {
  it("navigates once and reads the exact authorized approval outside the pending projection", async () => {
    const originalDocument = window.document,
      push = vi.spyOn(window.history, "pushState");
    await openSettingsApproval();
    await vi.waitFor(() => expect(host.textContent).toContain("Selected canonical approval evidence"));
    expectCanonicalLocation();
    expect(host.querySelector('[aria-label="Current approval"]')).not.toBeNull();
    expect(host.textContent).toContain("reviewed/selected-file.ts");
    expect(push).toHaveBeenCalledOnce();
    expect(window.document).toBe(originalDocument);
    expect(api.inbox).toHaveBeenCalledWith("workspace-a");
    expect(api.read.mock.calls.every(([id]) => id === approvalId)).toBe(true);
    expect(api.read.mock.calls.some(([, options]) => !options.workspaceId)).toBe(true);
    expect(api.read.mock.calls.some(([, options]) => options.workspaceId === "workspace-a")).toBe(true);
    expect(api.resolve).not.toHaveBeenCalled();
  });
  it("keeps a missing canonical record explicit without showing an unrelated pending approval", async () => {
    api.read.mockRejectedValue(
      new ApiRequestError("Approval missing", {
        kind: "http",
        method: "GET",
        path: "/api/approvals/selected",
        status: 404,
      }),
    );
    await openSettingsApproval();
    await vi.waitFor(() => expect(host.textContent).toContain("Approval not found."));
    expectCanonicalLocation();
    expect(host.querySelector('[aria-label="Current approval"]')).toBeNull();
    expect(api.read.mock.calls.every(([id]) => id === approvalId)).toBe(true);
    expect(api.resolve).not.toHaveBeenCalled();
  });
  it("preserves the selected endpoint permission error without missing state or decision controls", async () => {
    const denied = new ApiRequestError("Access denied", {
      kind: "http",
      method: "GET",
      path: "/api/approvals/selected",
      status: 403,
    });
    api.read.mockRejectedValue(denied);
    await openSettingsApproval();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expectCanonicalLocation();
    expect(
      client
        .getQueryCache()
        .findAll()
        .some((query) => query.state.error === denied),
    ).toBe(true);
    expect(host.textContent).not.toContain("Approval not found.");
    expect(host.querySelector('[aria-label="Current approval"]')).toBeNull();
    expect(api.resolve).not.toHaveBeenCalled();
  });
  it("normalizes a retained exact legacy record path without another history entry", async () => {
    window.history.replaceState(
      { retained: "legacy-record" },
      "",
      "/inbox/approvals/" +
        encodeURIComponent(approvalId) +
        "?workspaceId=workspace-a&runId=run%2Fone&sessionId=session%3Aone&extra=one&extra=two&shell=cockpit#review",
    );
    const push = vi.spyOn(window.history, "pushState");
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("Selected canonical approval evidence"));
    expectCanonicalLocation();
    expect(push).not.toHaveBeenCalled();
    expect(window.history.state.retained).toBe("legacy-record");
    expect(api.read.mock.calls.every(([id]) => id === approvalId)).toBe(true);
    expect(api.resolve).not.toHaveBeenCalled();
  });
  it("rejects a conflicting legacy/query selection before any canonical record read", async () => {
    window.history.replaceState(
      { retained: true },
      "",
      "/inbox/approvals/" + encodeURIComponent(approvalId) + "?approvalId=other&workspaceId=workspace-a",
    );
    await render();
    expect(host.textContent).toContain("Destination unavailable.");
    expect(api.read).not.toHaveBeenCalled();
    expect(api.resolve).not.toHaveBeenCalled();
  });
  it("requires visible workspace review before revealing a foreign canonical record", async () => {
    api.read.mockResolvedValue(approval("workspace-b"));
    await openSettingsApproval();
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Approval workspace review"]')).not.toBeNull());
    expectCanonicalLocation();
    expect(host.querySelector('[aria-label="Current approval"]')).toBeNull();
    expect(host.textContent).not.toContain("Selected canonical approval evidence");
    expect(api.resolve).not.toHaveBeenCalled();
  });
});
