import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest } from "@goatcitadel/contracts";
import type { ErrandTargetInfo } from "@goatcitadel/policy-engine";
import { createErrandApprovalGate, type ErrandApprovalGateDeps } from "./errand-approval-gate.js";
import { ERRAND_ESCALATE_AFTER_MS } from "./errand-constants.js";
import type { ErrandApprovalInput } from "./errand-loop.js";
import type { ErrandEscalationStage } from "./errand-escalation.js";
import type { ErrandOrigin } from "./errand-origin.js";

const PNG = Buffer.from("png");
const CHANNEL_ORIGIN: ErrandOrigin = {
  kind: "channel",
  connectionId: "conn-1",
  channelKey: "telegram",
  target: "chat-1",
  conversation: "direct",
  actorId: "owner",
};

function target(partial: Partial<ErrandTargetInfo> = {}): ErrandTargetInfo {
  return {
    x: 100,
    y: 200,
    tagName: "BUTTON",
    role: "button",
    text: "Place order",
    isPasswordLike: false,
    isOneTimeCode: false,
    isOpaque: false,
    rect: { x: 80, y: 190, width: 40, height: 20 },
    ...partial,
  };
}

function approvalInput(): ErrandApprovalInput {
  return {
    category: "purchase",
    title: 'Click "Place order"',
    body: "Buy the cart",
    target: target(),
    pageUrl: "https://shop.example/checkout",
    peopleScreenshotPng: PNG,
  } as ErrandApprovalInput;
}

/** A gate over in-memory approval records, so the 30-second timer runs on fake time. */
function setup(origin: ErrandOrigin | undefined, options: { escalateThrows?: boolean } = {}) {
  const records = new Map<string, ApprovalRequest>();
  let created = 0;
  const update = (approvalId: string, patch: Partial<ApprovalRequest>): void => {
    records.set(approvalId, { ...records.get(approvalId)!, ...patch });
  };
  const approvals: ErrandApprovalGateDeps["approvals"] = {
    createApproval: vi.fn(async (input: ApprovalCreateInput, onCreated) => {
      created += 1;
      const approval = {
        approvalId: `approval-${created}`,
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        preview: input.preview,
        payload: input.payload,
        linkage: input.linkage,
        expiresAt: input.expiresAt,
        createdAt: new Date().toISOString(),
      } as unknown as ApprovalRequest;
      records.set(approval.approvalId, approval);
      await onCreated?.(approval);
      return approval;
    }),
    resolveApproval: vi.fn(async (approvalId, input) => {
      update(approvalId, { status: input.decision === "approve" ? "approved" : "rejected" });
    }),
    withdrawApproval: vi.fn(async (approvalId) => update(approvalId, { status: "rejected" })),
  };
  const state = { target: target() };
  const browser = {
    currentUrl: () => "https://shop.example/checkout",
    describeTargetBeneathOverlay: vi.fn(async () => state.target),
    describeFocusedBeneathOverlay: vi.fn(async () => null),
    captureForPeople: vi.fn(async () => PNG),
    overlay: {
      render: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ mode: "driving", bannerText: "Working" })),
      onEvent: vi.fn(() => () => undefined),
    },
  };
  let uploads = 0;
  const escalate = vi.fn((_approval: ApprovalRequest, _origin: ErrandOrigin, _stage: ErrandEscalationStage) => {
    if (options.escalateThrows) {
      throw new Error("escalate threw before returning a promise");
    }
    return Promise.resolve();
  });
  const controller = new AbortController();
  const gate = createErrandApprovalGate({
    sessionId: "session-1",
    turnId: "turn-1",
    toolRunId: "tool-run-1",
    browser: browser as unknown as ErrandApprovalGateDeps["browser"],
    approvals,
    storage: {
      approvals: { get: async (approvalId: string) => records.get(approvalId)! },
      approvalEvents: { append: vi.fn(async () => undefined), listByApprovalId: async () => [] },
      chatInlineApprovals: { upsert: vi.fn(async () => undefined) },
    } as unknown as ErrandApprovalGateDeps["storage"],
    attachments: {
      upload: vi.fn(async () => {
        uploads += 1;
        return { attachmentId: `attachment-${uploads}`, sha256: "a".repeat(64) };
      }),
    },
    realtime: { subscribeRealtime: () => () => undefined },
    signal: controller.signal,
    now: () => Date.now(),
    ...(origin ? { origin } : {}),
    escalate,
  });
  const resolve = (approvalId: string, decision: "approve" | "reject") =>
    approvals.resolveApproval(approvalId, { decision, resolvedBy: "operator" });
  return { gate, escalate, controller, records, state, resolve };
}

/** Lets the gate finish its awaited work (uploads, creation) without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("errand approval gate escalation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("escalates a PC errand's approval at 30 seconds, not before", async () => {
    const { gate, escalate, controller } = setup({ kind: "pc" });
    const answer = gate.request(approvalInput());
    await settle();
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS - 1);
    expect(escalate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", kind: "browser.errand.action" }),
      { kind: "pc" },
      "waited",
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("stopped");
  });

  it("never escalates an approval answered at 10 seconds", async () => {
    const { gate, escalate, resolve } = setup({ kind: "pc" });
    const answer = gate.request(approvalInput());
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await resolve("approval-1", "reject");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("denied");
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS * 2);
    expect(escalate).not.toHaveBeenCalled();
  });

  it("never escalates once the errand stops", async () => {
    const { gate, escalate, controller } = setup({ kind: "pc" });
    const answer = gate.request(approvalInput());
    await settle();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("stopped");
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS * 2);
    expect(escalate).not.toHaveBeenCalled();
  });

  it("asks a channel errand's conversation immediately and sends the phone stage at 30 seconds", async () => {
    const { gate, escalate, controller } = setup(CHANNEL_ORIGIN);
    const answer = gate.request(approvalInput());
    await settle();
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalId: "approval-1" }),
      CHANNEL_ORIGIN,
      "asked",
    );
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS - 1);
    expect(escalate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(escalate).toHaveBeenCalledTimes(2);
    expect(escalate).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalId: "approval-1" }),
      CHANNEL_ORIGIN,
      "waited",
    );
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS * 2);
    expect(escalate).toHaveBeenCalledTimes(2);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("stopped");
  });

  it("sends a channel errand's approval answered at 10 seconds only to its conversation, never the phone", async () => {
    const { gate, escalate, resolve } = setup(CHANNEL_ORIGIN);
    const answer = gate.request(approvalInput());
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await resolve("approval-1", "reject");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("denied");
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS * 2);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(expect.anything(), CHANNEL_ORIGIN, "asked");
  });

  it("logs an escalation that throws synchronously and keeps waiting for the decision", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { gate, escalate, resolve } = setup(CHANNEL_ORIGIN, { escalateThrows: true });
    const answer = gate.request(approvalInput());
    await settle();
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS);
    expect(escalate).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval could not be sent beyond the window and Chat",
      expect.objectContaining({ approvalId: "approval-1", stage: "asked" }),
    );
    await resolve("approval-1", "approve");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("approved");
    warn.mockRestore();
  });

  it("gives each re-ask its own timer", async () => {
    const { gate, escalate, controller, resolve, state, records } = setup({ kind: "pc" });
    const answer = gate.request(approvalInput());
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    // Approved, but the page changed underneath: the gate asks again with a new approval.
    state.target = target({ text: "Cancel order" });
    await resolve("approval-1", "approve");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(records.get("approval-2")?.status).toBe("pending");
    // Past 30 s from the first approval (now 31 s): its timer was cleared, and the re-ask's has not run out yet.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(escalate).not.toHaveBeenCalled();
    // Past 30 s from the re-ask (created at about 10.5 s).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-2" }),
      { kind: "pc" },
      "waited",
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("stopped");
  });

  it("asks only in the window and Chat when no escalation is wired", async () => {
    const { gate, escalate, controller } = setup(undefined);
    const answer = gate.request(approvalInput());
    await settle();
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS * 2);
    expect(escalate).not.toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("stopped");
  });
});
