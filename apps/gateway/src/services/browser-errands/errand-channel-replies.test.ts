import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { ErrandOwnerOnlyError } from "./errand-approval-press-guard.js";
import {
  classifyErrandReply,
  createErrandAwaitsAnswer,
  createErrandReplyHandler,
  ERRAND_REPLY_ALREADY_ANSWERED_COPY,
  ERRAND_REPLY_APPROVED_COPY,
  ERRAND_REPLY_DENIED_COPY,
  ERRAND_REPLY_NEAR_MISS_COPY,
  ERRAND_REPLY_STOP_NEAR_MISS_COPY,
  ERRAND_REPLY_STOPPING_COPY,
  encodeErrandReplyMarker,
  parseErrandReplyMarker,
  type ErrandReplyAnswer,
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
    ["constructor", null],
    ["toString", null],
    ["__proto__", null],
    ["hasOwnProperty", null],
    ["CONSTRUCTOR", null],
  ] as const)("classifies %j as %s", (text, expected) => {
    expect(classifyErrandReply(text)).toBe(expected);
  });
});

describe("createErrandAwaitsAnswer", () => {
  const arrival = (text: string) => ({ connectionId: "connection-1", target: "chat-1", text, sentAt: 5_000 });

  it.each(["APPROVE", " DENY ", "STOP"])(
    "says %j waits for an answer when a delivered approval is pending",
    async (text) => {
      const pending = vi.fn(async () => ({ approvalId: "approval-1", errandId: "errand-1" }));
      await expect(createErrandAwaitsAnswer(pending)(arrival(text))).resolves.toBe(true);
      expect(pending).toHaveBeenCalledWith("connection-1", "chat-1", 5_000);
    },
  );

  it("is false with nothing pending, and never looks up a near miss or ordinary text", async () => {
    const pending = vi.fn(async () => undefined);
    await expect(createErrandAwaitsAnswer(pending)(arrival("APPROVE"))).resolves.toBe(false);
    pending.mockClear();
    for (const text of ["approve", "ok", "hello", "constructor"]) {
      await expect(createErrandAwaitsAnswer(pending)(arrival(text))).resolves.toBe(false);
    }
    expect(pending).not.toHaveBeenCalled();
  });
});

function createHandler(overrides: Partial<ErrandReplyHandlerOptions> = {}) {
  let clock = 1_000_000;
  const order: string[] = [];
  const options = {
    pendingDeliveryFor: vi.fn<ErrandReplyHandlerOptions["pendingDeliveryFor"]>(async () => ({
      approvalId: "approval-1",
      errandId: "errand-1",
    })),
    assertOwner: vi.fn<ErrandReplyHandlerOptions["assertOwner"]>(async () => undefined),
    resolveApproval: vi.fn<ErrandReplyHandlerOptions["resolveApproval"]>(async () => {
      order.push("resolve");
      return {};
    }),
    stopErrand: vi.fn<ErrandReplyHandlerOptions["stopErrand"]>(async () => {
      order.push("stop");
      return true;
    }),
    now: () => clock,
    ...overrides,
  };
  const recordAnswer = vi.fn(async (answer: ErrandReplyAnswer) => {
    order.push(`record:${answer.decision}:${answer.approvalId}`);
  });
  const input = (text: string, target = "chat-1") => ({
    connectionId: "connection-1",
    channelKey: "telegram",
    target,
    actorId: "user-1",
    text,
    sentAt: 5_000,
    recordAnswer,
  });
  return {
    options,
    order,
    recordAnswer,
    input,
    handle: createErrandReplyHandler(options),
    advance: (ms: number) => (clock += ms),
  };
}

const notOwner = () =>
  vi.fn(async () => {
    throw new ErrandOwnerOnlyError();
  });

describe("createErrandReplyHandler", () => {
  it("records the answered approval, then approves it as the channel sender", async () => {
    const { options, order, input, handle } = createHandler();
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: ERRAND_REPLY_APPROVED_COPY });
    expect(options.pendingDeliveryFor).toHaveBeenCalledWith("connection-1", "chat-1", 5_000);
    expect(options.assertOwner).toHaveBeenCalledWith({ connectorId: "integration:connection-1", actorId: "user-1" });
    expect(options.resolveApproval).toHaveBeenCalledWith("approval-1", "approve", "telegram:user-1");
    expect(order).toEqual(["record:approve:approval-1", "resolve"]);
  });

  it("denies with DENY", async () => {
    const { options, input, handle } = createHandler();
    expect(await handle(input("DENY"))).toEqual({ handled: true, reply: ERRAND_REPLY_DENIED_COPY });
    expect(options.resolveApproval).toHaveBeenCalledWith("approval-1", "reject", "telegram:user-1");
  });

  it("records, then stops the errand with STOP under the channel sender", async () => {
    const { options, order, input, handle } = createHandler();
    expect(await handle(input("STOP"))).toEqual({ handled: true, reply: ERRAND_REPLY_STOPPING_COPY });
    expect(options.stopErrand).toHaveBeenCalledWith("errand-1", "telegram:user-1");
    expect(options.resolveApproval).not.toHaveBeenCalled();
    expect(order).toEqual(["record:stop:approval-1", "stop"]);
  });

  it.each([
    ["approve", ERRAND_REPLY_NEAR_MISS_COPY],
    ["yes", ERRAND_REPLY_NEAR_MISS_COPY],
    ["Deny", ERRAND_REPLY_NEAR_MISS_COPY],
    ["stop", ERRAND_REPLY_STOP_NEAR_MISS_COPY],
    ["Stop", ERRAND_REPLY_STOP_NEAR_MISS_COPY],
    [" sToP ", ERRAND_REPLY_STOP_NEAR_MISS_COPY],
  ])("hints %j with %j and resolves nothing", async (text, copy) => {
    const { options, recordAnswer, input, handle } = createHandler();
    expect(await handle(input(text))).toEqual({ handled: true, reply: copy });
    expect(options.resolveApproval).not.toHaveBeenCalled();
    expect(options.stopErrand).not.toHaveBeenCalled();
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("sends a near-miss hint to one conversation at most once every 30 seconds", async () => {
    const { input, handle, advance } = createHandler();
    expect(await handle(input("approve"))).toEqual({ handled: true, reply: ERRAND_REPLY_NEAR_MISS_COPY });
    advance(29_999);
    expect(await handle(input("stop"))).toEqual({ handled: true });
    expect(await handle(input("approve", "chat-2"))).toEqual({ handled: true, reply: ERRAND_REPLY_NEAR_MISS_COPY });
    advance(1);
    expect(await handle(input("approve"))).toEqual({ handled: true, reply: ERRAND_REPLY_NEAR_MISS_COPY });
  });

  it("sends the owner-only refusal to one conversation at most once every 30 seconds", async () => {
    const { options, input, handle, advance } = createHandler({ assertOwner: notOwner() });
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: "Only the owner can answer this." });
    advance(10_000);
    expect(await handle(input("APPROVE"))).toEqual({ handled: true });
    advance(20_000);
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: "Only the owner can answer this." });
    expect(options.resolveApproval).not.toHaveBeenCalled();
  });

  it("passes through when nothing is pending in the conversation", async () => {
    const { options, input, handle } = createHandler({ pendingDeliveryFor: vi.fn(async () => undefined) });
    expect(await handle(input("APPROVE"))).toEqual({ handled: false });
    expect(options.resolveApproval).not.toHaveBeenCalled();
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "keeps the owner's %j as ordinary chat while an approval is pending",
    async (text) => {
      const { options, recordAnswer, input, handle } = createHandler();
      expect(await handle(input(text))).toEqual({ handled: false });
      expect(recordAnswer).not.toHaveBeenCalled();
      expect(options.resolveApproval).not.toHaveBeenCalled();
      expect(options.stopErrand).not.toHaveBeenCalled();
    },
  );

  it("passes through ordinary text without looking anything up", async () => {
    const { options, input, handle } = createHandler();
    expect(await handle(input("what are you doing?"))).toEqual({ handled: false });
    expect(options.pendingDeliveryFor).not.toHaveBeenCalled();
  });

  it.each(["ok", "yes", "approve", "deny", "stop", "Approve"])(
    "lets a non-owner's %j through to Chat as an ordinary message",
    async (text) => {
      const { options, input, handle } = createHandler({ assertOwner: notOwner() });
      expect(await handle(input(text))).toEqual({ handled: false });
      expect(options.resolveApproval).not.toHaveBeenCalled();
    },
  );

  it("on a retry, decides again on the recorded approval while the errand still waits on it", async () => {
    const { options, recordAnswer, input, handle } = createHandler();
    const retry = { ...input("APPROVE"), answered: { approvalId: "approval-1", decision: "deny" as const } };
    expect(await handle(retry)).toEqual({ handled: true, reply: ERRAND_REPLY_DENIED_COPY });
    expect(options.resolveApproval).toHaveBeenCalledWith("approval-1", "reject", "telegram:user-1");
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("on a retry, never answers another approval, and answers already answered when none is waiting", async () => {
    const { options, input, handle } = createHandler();
    const retry = { ...input("APPROVE"), answered: { approvalId: "approval-0", decision: "approve" as const } };
    expect(await handle(retry)).toEqual({ handled: true, reply: ERRAND_REPLY_ALREADY_ANSWERED_COPY });
    options.pendingDeliveryFor.mockResolvedValue(undefined);
    expect(await handle({ ...retry, answered: { approvalId: "approval-1", decision: "approve" } })).toEqual({
      handled: true,
      reply: ERRAND_REPLY_ALREADY_ANSWERED_COPY,
    });
    expect(options.resolveApproval).not.toHaveBeenCalled();
    expect(options.stopErrand).not.toHaveBeenCalled();
  });

  it("round-trips the marker and rejects unreadable ones", () => {
    const marker = encodeErrandReplyMarker({ approvalId: "a:b-1", decision: "stop" });
    expect(marker).toBe("errand-reply:stop:a:b-1");
    expect(parseErrandReplyMarker(marker)).toEqual({ approvalId: "a:b-1", decision: "stop" });
    expect(parseErrandReplyMarker("errand-reply:approval-1")).toBeUndefined();
    expect(parseErrandReplyMarker("errand-reply:maybe:approval-1")).toBeUndefined();
  });

  it("refuses a sender who is not the owner and leaves the approval pending", async () => {
    const { options, recordAnswer, input, handle } = createHandler({ assertOwner: notOwner() });
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: "Only the owner can answer this." });
    expect(options.resolveApproval).not.toHaveBeenCalled();
    expect(options.stopErrand).not.toHaveBeenCalled();
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("answers an approval resolved elsewhere first with already answered (Review Focus 2)", async () => {
    const { input, handle } = createHandler({
      resolveApproval: vi.fn(async () => {
        throw new ConflictError({ message: "Approval approval-1 is already resolved" });
      }),
    });
    expect(await handle(input("APPROVE"))).toEqual({ handled: true, reply: ERRAND_REPLY_ALREADY_ANSWERED_COPY });
  });

  it("resolves nothing when the answer cannot be recorded first", async () => {
    const { options, input, handle } = createHandler();
    const failing = { ...input("APPROVE"), recordAnswer: vi.fn(async () => Promise.reject(new Error("claim lost"))) };
    await expect(handle(failing)).rejects.toThrow("claim lost");
    expect(options.resolveApproval).not.toHaveBeenCalled();
  });

  it("lets an unexpected resolve failure through", async () => {
    const { input, handle } = createHandler({
      resolveApproval: vi.fn(async () => {
        throw new Error("storage down");
      }),
    });
    await expect(handle(input("APPROVE"))).rejects.toThrow("storage down");
  });
});
