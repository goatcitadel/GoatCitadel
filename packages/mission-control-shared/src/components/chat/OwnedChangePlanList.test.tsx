import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { requestChangePlanRollback, respondToChangePlan } from "../../api/chat";
import { ApiRequestError } from "../../api/http-internal";
import { ChatChangePlanCard } from "./ChatChangePlanCard";
import { ChatChangePlanActionDialog } from "./ChatChangePlanActionDialog";
import { OwnedChangePlanList } from "./OwnedChangePlanList";

vi.mock("../../api/chat", () => ({
  cancelChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  respondToChangePlan: vi.fn(),
  requestChangePlanRollback: vi.fn(),
}));
vi.mock("./ChatChangePlanCard", () => ({ ChatChangePlanCard: () => null }));
vi.mock("./ChatChangePlanActionDialog", () => ({ ChatChangePlanActionDialog: () => null }));

const plan = {
  planId: "pack-plan",
  origin: { workspaceId: "workspace", surface: "settings" },
  revision: 4,
  requiredAction: { kind: "approval", approvalId: "approval", actionId: "action", actionNonce: "nonce" },
} as ChangePlanRecord;
let renderer: ReactTestRenderer;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  act(() => renderer?.unmount());
});

async function open(onUpdated = vi.fn(), onOpenApproval = vi.fn()) {
  await act(async () => {
    renderer = create(<OwnedChangePlanList plans={[plan]} onUpdated={onUpdated} onOpenApproval={onOpenApproval} />);
  });
  await act(async () => {
    renderer.root.findByType(ChatChangePlanCard).props.onReview(plan);
  });
  await act(async () => {
    await renderer.root.findByType(ChatChangePlanActionDialog).props.onOpenApproval(plan);
  });
  return { onUpdated, onOpenApproval };
}

it("resumes an approved pack through its exact canonical action", async () => {
  const completed = { ...plan, status: "completed", revision: 7, requiredAction: null } as ChangePlanRecord;
  vi.mocked(respondToChangePlan).mockResolvedValue(completed);
  const handlers = await open();
  expect(respondToChangePlan).toHaveBeenCalledWith("pack-plan", expect.objectContaining({ workspaceId: "workspace" }), {
    expectedRevision: 4,
    actionId: "action",
    actionNonce: "nonce",
    values: {},
  });
  expect(handlers.onUpdated).toHaveBeenCalledWith(completed);
  expect(handlers.onOpenApproval).not.toHaveBeenCalled();
  expect(renderer.root.findByType(ChatChangePlanActionDialog).props.plan).toBeNull();
});

it("opens the exact owner rollback confirmation before any compensation", async () => {
  const pending = {
    ...plan,
    status: "awaiting_confirmation",
    revision: 5,
    requiredAction: { kind: "confirmation", actionNonce: "rollback-nonce", purpose: "rollback" },
  } as ChangePlanRecord;
  vi.mocked(requestChangePlanRollback).mockResolvedValue(pending);
  const onUpdated = vi.fn();
  await act(async () => {
    renderer = create(<OwnedChangePlanList plans={[plan]} onUpdated={onUpdated} onOpenApproval={vi.fn()} />);
  });
  await act(async () => {
    await renderer.root.findByType(ChatChangePlanCard).props.onRollback(plan);
  });
  expect(requestChangePlanRollback).toHaveBeenCalledWith(
    "pack-plan",
    expect.objectContaining({ workspaceId: "workspace" }),
    4,
  );
  expect(onUpdated).toHaveBeenCalledWith(pending);
  expect(renderer.root.findByType(ChatChangePlanActionDialog).props.plan).toEqual(pending);
  expect(respondToChangePlan).not.toHaveBeenCalled();
});

it("opens a pending approval without inventing a completed plan", async () => {
  vi.mocked(respondToChangePlan).mockRejectedValue(
    new ApiRequestError("Approval is pending", {
      kind: "http",
      method: "POST",
      path: "/change-plans/pack-plan",
      status: 409,
    }),
  );
  const handlers = await open();
  expect(handlers.onUpdated).not.toHaveBeenCalled();
  expect(handlers.onOpenApproval).toHaveBeenCalledWith("approval");
});

it("keeps a denied resume visible without applying or navigating", async () => {
  vi.mocked(respondToChangePlan).mockRejectedValue(
    new ApiRequestError("Approval denied", {
      kind: "http",
      method: "POST",
      path: "/change-plans/pack-plan",
      status: 403,
    }),
  );
  const handlers = await open();
  expect(handlers.onUpdated).not.toHaveBeenCalled();
  expect(handlers.onOpenApproval).not.toHaveBeenCalled();
  expect(renderer.root.findByType(ChatChangePlanActionDialog).props.error).toBe("Approval denied");
});
