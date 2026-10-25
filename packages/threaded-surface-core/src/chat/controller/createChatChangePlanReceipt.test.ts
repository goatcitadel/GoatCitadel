import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { createChatChangePlanReceipt } from "./createChatChangePlanReceipt";

function plan(overrides: Partial<ChangePlanRecord>): ChangePlanRecord {
  return {
    planId: "plan-1",
    revision: 3,
    status: "completed",
    phase: "terminal",
    origin: { workspaceId: "default", surface: "chat", sessionId: "session-a", actorId: "operator" },
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ChangePlanRecord;
}

function receiptFor(plans: ChangePlanRecord[]) {
  return createChatChangePlanReceipt({
    thread: { turns: [] } as never,
    changePlanState: {
      chatChangePlans: plans,
      dismissedChangePlanReceiptKeys: new Set(),
      changePlanActionPending: false,
      setDismissedChangePlanReceiptKeys: vi.fn(),
      setActivityOpenRequest: vi.fn(),
    },
    modelPlans: {
      reviewChatChangePlan: vi.fn(),
      cancelPendingChatChangePlan: vi.fn(),
      makeChatChangePlanDefault: vi.fn(),
    } as never,
  }).changePlanReceipt;
}

describe("createChatChangePlanReceipt", () => {
  it("shows this conversation's own change plan in its transcript", () => {
    expect(receiptFor([plan({})])?.plan.planId).toBe("plan-1");
  });

  it("keeps a Settings change out of whichever conversation happens to be open (#496)", () => {
    // A Settings plan has no session, so it reached every open Chat as a "COMPLETED" receipt.
    const settings = plan({
      planId: "settings-plan",
      origin: { workspaceId: "default", surface: "settings" } as never,
    });
    expect(receiptFor([settings])).toBeUndefined();
    expect(receiptFor([{ ...settings, status: "awaiting_approval", phase: "authorization" } as never])).toBeUndefined();
    // It does not hide the conversation's own plan either.
    expect(receiptFor([settings, plan({})])?.plan.planId).toBe("plan-1");
  });
});
