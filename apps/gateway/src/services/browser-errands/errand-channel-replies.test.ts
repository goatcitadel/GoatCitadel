import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { ErrandOwnerOnlyError } from "./errand-approval-press-guard.js";
import {
  classifyErrandReply,
  createErrandReplyHandler,
  ERRAND_REPLY_ALREADY_ANSWERED_COPY,
  ERRAND_REPLY_APPROVED_COPY,
  ERRAND_REPLY_DENIED_COPY,
  ERRAND_REPLY_NEAR_MISS_COPY,
  ERRAND_REPLY_STOPPING_COPY,
  type ErrandReplyHandlerOptions,
} from "./errand-channel-replies.js";

describe("classifyErrandReply", () => {
  it.each([
    ["APPROVE", "approve"],
    ["  APPROVE \n", "approve"],
    ["approve", "near_miss"],
    ["Approve", "near_miss"],
    ["APPROVE please", null],
    ["yes", "near_miss"],
    ["ok", "near_miss"],
    ["OK", "near_miss"],
    ["DENY", "deny"],
    ["deny", "near_miss"],
    ["STOP", "stop"],
    ["stop", "near_miss"],
    ["", null],
    ["hello there", null],
  ] as const)("classifies %j as %s", (text, expected) => {
    expect(classifyErrandReply(text)).toBe(expected);
  });
});

function createHandler(overrides: Partial<ErrandReplyHandlerOptions> = {}) {
  const options = {
    pendingDeliveryFor: vi.fn<ErrandReplyHandlerOptions["pendingDeliveryFor"]>(async () => ({
      approvalId: "approval-1",
      errandId: "errand-1",
    })),
    assertOwner: vi.fn<ErrandReplyHandlerOptions["assertOwner"]>(async () => undefined),
    resolveApproval: vi.fn<ErrandReplyHandlerOptions["resolveApproval"]>(async () => ({})),
    stopErrand: vi.fn<ErrandReplyHandlerOptions["stopErrand"]>(async () => true),
    ...overrides,
  };
  return { options, handle: createErrandReplyHandler(options) };
}

const input = (text: string) => ({
  connectionId: "connection-1",
  channelKey: "telegram",
  target: "chat-1",
  actorId: "user-1",
  text,
});

describe("createErrandReplyHandler", () => {
  it("approves the pending approval as the channel sender", async () => {
    const { options, handle } = createHandler();
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: ERRAND_REPLY_APPROVED_COPY });
    expect(options.pendingDeliveryFor).toHaveBeenCalledWith("connection-1", "chat-1");
    expect(options.assertOwner).toHaveBeenCalledWith({ connectorId: "integration:connection-1", actorId: "user-1" });
    expect(options.resolveApproval).toHaveBeenCalledWith("approval-1", "approve", "telegram:user-1");
  });

  it("denies with DENY", async () => {
    const { options, handle } = createHandler();
    expect(await handle(input("DENY"))).toEqual({ handled: true, reply: ERRAND_REPLY_DENIED_COPY });
    expect(options.resolveApproval).toHaveBeenCalledWith("approval-1", "reject", "telegram:user-1");
  });

  it("stops the errand with STOP under the channel sender", async () => {
    const { options, handle } = createHandler();
    expect(await handle(input("STOP"))).toEqual({ handled: true, reply: ERRAND_REPLY_STOPPING_COPY });
    expect(options.stopErrand).toHaveBeenCalledWith("errand-1", "telegram:user-1");
    expect(options.resolveApproval).not.toHaveBeenCalled();
  });

  it("hints at the capitals for a near miss and resolves nothing", async () => {
    const { options, handle } = createHandler();
    expect(await handle(input("approve"))).toEqual({ handled: true, reply: ERRAND_REPLY_NEAR_MISS_COPY });
    expect(options.resolveApproval).not.toHaveBeenCalled();
  });

  it("passes through when nothing is pending in the conversation", async () => {
    const { options, handle } = createHandler({ pendingDeliveryFor: vi.fn(async () => undefined) });
    expect(await handle(input("APPROVE"))).toEqual({ handled: false });
    expect(options.resolveApproval).not.toHaveBeenCalled();
  });

  it("passes through ordinary text without looking anything up", async () => {
    const { options, handle } = createHandler();
    expect(await handle(input("what are you doing?"))).toEqual({ handled: false });
    expect(options.pendingDeliveryFor).not.toHaveBeenCalled();
  });

  it("refuses a sender who is not the owner and leaves the approval pending", async () => {
    const { options, handle } = createHandler({
      assertOwner: vi.fn(async () => {
        throw new ErrandOwnerOnlyError();
      }),
    });
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: "Only the owner can answer this." });
    expect(options.resolveApproval).not.toHaveBeenCalled();
    expect(options.stopErrand).not.toHaveBeenCalled();
  });

  it("answers an approval resolved elsewhere first with already answered (Review Focus 2)", async () => {
    const { handle } = createHandler({
      resolveApproval: vi.fn(async () => {
        throw new ConflictError({ message: "Approval approval-1 is already resolved" });
      }),
    });
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: ERRAND_REPLY_ALREADY_ANSWERED_COPY });
  });

  it("lets an unexpected resolve failure through", async () => {
    const { handle } = createHandler({
      resolveApproval: vi.fn(async () => {
        throw new Error("storage down");
      }),
    });
    await expect(handle(input("APPROVE"))).rejects.toThrow("storage down");
  });
});
