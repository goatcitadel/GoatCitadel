// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalDecisionBar } from "./ApprovalDecisionBar";
import { __resetInboxApprovalAttemptsForTests } from "./inbox-approval-attempts";

const api = vi.hoisted(() => ({ fetchApproval: vi.fn(), resolveApproval: vi.fn() }));
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "default", showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ resolveApproval: api.resolveApproval }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));

const approval: ApprovalRequest = {
  approvalId: "approval-a",
  kind: "file.write",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: { targets: ["workspace/note.txt"] },
  createdAt: "2026-09-28T00:00:00Z",
  explanationStatus: "pending",
};
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  __resetInboxApprovalAttemptsForTests();
  api.fetchApproval.mockReset().mockResolvedValue(approval);
  api.resolveApproval.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (entry) => !entry.closest('[aria-hidden="true"]') && entry.textContent === label,
  )!;

const renderBar = async (record: ApprovalRequest, expiryShownNearby = false) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalDecisionBar
          approval={record}
          workspaceId="default"
          expiryShownNearby={expiryShownNearby}
          onResolved={vi.fn()}
          onInvalidated={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  );

it("denies in one neutral click, because denying is the safe choice", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalDecisionBar approval={approval} workspaceId="default" onResolved={vi.fn()} onInvalidated={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  const deny = button("Deny");
  expect(deny.className).toContain("bg-raised");
  expect(deny.className).not.toContain("text-status-failed");
  expect(button("Review danger approval").className).toContain("text-status-failed");
  api.resolveApproval.mockResolvedValue({ approval: { ...approval, status: "rejected" }, effects: [] });
  await act(async () => deny.click());
  expect(document.body.querySelector("[role=dialog]")).toBeNull();
  expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-a", "reject");
});

it("shows Expired before the missing-preview message", async () => {
  await renderBar({ ...approval, preview: {}, expiresAt: "2020-01-01T00:00:00Z" });
  expect(document.body.textContent).toContain("has expired and can no longer be decided");
  expect(document.body.textContent).not.toContain("can't be decided yet");
});

it("treats a malformed expiresAt as not expired, as the list does", async () => {
  await renderBar({ ...approval, expiresAt: "not-a-date" });
  expect(button("Deny")).toBeDefined();
  expect(document.body.textContent).not.toContain("has expired");
});

it("leaves the expiry to a surrounding view that states it, and states the disclaimer once", async () => {
  await renderBar({ ...approval, expiresAt: "2099-01-01T00:00:00Z" }, true);
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("Expiry:");
  expect(text.split(/does not prove the action ran/).length - 1).toBe(1);
});

it("shows the expiry itself where nothing around it does (Library, Chat)", async () => {
  await renderBar({ ...approval, expiresAt: "2099-01-01T00:00:00Z" });
  expect(document.body.textContent).toContain("Expiry:");
});

/** A skill switch change as the Gateway asks for it: danger, and linked to no workspace. */
const skillApproval: ApprovalRequest = {
  approvalId: "5f0b6d2e-6c1a-4d3e-9b7a-2f1e0c9d8b7a",
  kind: "skill.lifecycle",
  riskLevel: "danger",
  status: "pending",
  payload: {
    skillLifecycle: {
      schemaVersion: "goatcitadel.skill-lifecycle-approval.v1",
      scopeKind: "global",
      subjectKind: "skill",
      subjectId: "planner",
      action: "skill_state_set",
      requestSha256: "a".repeat(64),
      expectedStateSha256: "b".repeat(64),
    },
    request: {
      schemaVersion: "goatcitadel.skill-lifecycle-request.v1",
      requesterId: "operator",
      mutation: { skillId: "planner", state: "enabled", note: null },
    },
  },
  preview: {
    title: "Approve skill state change",
    action: "skill_state_set",
    skillId: "planner",
    state: "enabled",
    currentState: "disabled",
  },
  createdAt: "2026-10-29T10:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  explanationStatus: "not_requested",
};

const renderDecision = (record: ApprovalRequest, workspaceId: string | null, onResolved = vi.fn()) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalDecisionBar
          compact
          reviewedInPlace
          approval={record}
          workspaceId={workspaceId}
          onResolved={onResolved}
          onInvalidated={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  );

it("reads a skill approval without a workspace and approves it in one click", async () => {
  api.fetchApproval.mockResolvedValue(skillApproval);
  api.resolveApproval.mockResolvedValue({
    approval: { ...skillApproval, status: "approved", resolvedBy: "operator", resolvedAt: "2026-10-29T10:01:00Z" },
    effects: [],
  });
  const onResolved = vi.fn();
  await renderDecision(skillApproval, null, onResolved);
  expect(document.body.textContent).not.toContain("The selected workspace changed");

  await act(async () => button("Approve once").click());
  // The check before deciding reads the approval without a workspace: scoped to one, it would not be found.
  expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith(skillApproval.approvalId, {});
  expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(skillApproval.approvalId, "approve");
  expect(onResolved).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector("[role=dialog]")).toBeNull();
});

it("leaves Settings approvals scoped to their workspace", async () => {
  const workspaceApproval: ApprovalRequest = { ...approval, riskLevel: "caution" };
  api.resolveApproval.mockResolvedValue({ approval: { ...workspaceApproval, status: "approved" }, effects: [] });
  api.fetchApproval.mockResolvedValue(workspaceApproval);
  const onResolved = vi.fn();
  await renderDecision(workspaceApproval, "default", onResolved);
  await act(async () => button("Approve once").click());
  expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval-a", { workspaceId: "default" });
  expect(onResolved).toHaveBeenCalledTimes(1);

  // An approval the workspace can't find is not decided, whatever its id.
  const path = "/api/v1/approvals/approval-a";
  const missing = new ApiRequestError("missing", { kind: "http", method: "GET", path, status: 404 });
  api.fetchApproval.mockReset().mockRejectedValue(missing);
  api.resolveApproval.mockReset();
  __resetInboxApprovalAttemptsForTests();
  await act(async () => root.render(null));
  await renderDecision(workspaceApproval, "default");
  await act(async () => button("Approve once").click());
  expect(api.resolveApproval).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("This approval changed or is no longer in the current pending queue.");
});
