import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, type ToolInvokeRequest } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "../chat-turn-agent-runner.js";
import { composeChatTurnControl, type ChatTurnControlCompositionHost } from "./chat-turn-control-composition.js";

const assertChatTurnToolUseOpen = vi.hoisted(() => vi.fn(async () => {}));
const preserveCancelledChatTurnOutput = vi.hoisted(() => vi.fn(async () => {}));
const delegation = vi.hoisted(() => ({
  resolveConfirmedDelegation: vi.fn(async () => undefined),
  reconcileConfirmedDelegationChild: vi.fn(async () => {}),
  reconcileWaitingConfirmedDelegations: vi.fn(async () => {}),
  readConfirmedDelegationParentProfile: vi.fn(async () => undefined),
}));
vi.mock("../chat-turn-control.js", () => ({ assertChatTurnToolUseOpen }));
vi.mock("../chat-turn-interruption-recovery-service.js", () => ({ preserveCancelledChatTurnOutput }));
vi.mock("../chat-confirmed-delegation-service.js", () => delegation);

function fixture(parentPayload: Record<string, unknown> = { sessionId: "session-1", turnId: "parent-turn" }) {
  const calls: string[] = [];
  const storage = { durableRuns: { getRun: vi.fn(async () => ({ payload: parentPayload })) } };
  const host = {
    storage,
    runDelegation: vi.fn(),
    materialize: vi.fn(),
    reconcileWaiting: vi.fn(),
    wake: vi.fn(),
    captureCancelledOutput: vi.fn(() => {
      calls.push("capture");
      return { throughSequence: 3, tail: "partial" };
    }),
    rejectPendingChatTurnApprovals: vi.fn(async () => {
      calls.push("reject");
    }),
  } as unknown as ChatTurnControlCompositionHost;
  preserveCancelledChatTurnOutput.mockImplementation(async () => {
    calls.push("preserve");
  });
  return { host, storage, calls, control: composeChatTurnControl(host) };
}

describe("composeChatTurnControl", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["a different session", { sessionId: "other-session", turnId: "parent-turn" }],
    ["no parent turn", { sessionId: "session-1" }],
  ])("refuses a fan-out parent with %s before checking tool use", async (_label, payload) => {
    const { control } = fixture(payload);
    await expect(control.assertParentToolUseOpen("parent-run", "session-1")).rejects.toBeInstanceOf(ConflictError);
    expect(assertChatTurnToolUseOpen).not.toHaveBeenCalled();
  });

  it("checks the fan-out parent's own turn for open tool use", async () => {
    const { control, storage } = fixture();
    await control.assertParentToolUseOpen("parent-run", "session-1");
    expect(storage.durableRuns.getRun).toHaveBeenCalledWith("parent-run");
    expect(assertChatTurnToolUseOpen).toHaveBeenCalledWith(storage, "session-1", "parent-turn");
  });

  it("settles a cancelled turn by capturing output, withdrawing approvals, then preserving the prefix", async () => {
    const { control, host, storage, calls } = fixture();
    await control.onChatTurnCancelled("session-1", "turn-1", "operator");
    expect(calls).toEqual(["capture", "reject", "preserve"]);
    expect(host.rejectPendingChatTurnApprovals).toHaveBeenCalledWith("session-1", "turn-1", "operator");
    expect(preserveCancelledChatTurnOutput).toHaveBeenCalledWith(storage, "session-1", "turn-1", {
      throughSequence: 3,
      tail: "partial",
    });
  });

  it("routes dispatch fences and delegation calls to their owners with the composed host", async () => {
    const { control, host, storage } = fixture();
    await control.assertToolDispatchAllowed({ sessionId: "s", turnId: "t", toolName: "fs.read" } as ToolInvokeRequest);
    expect(assertChatTurnToolUseOpen).toHaveBeenCalledWith(storage, "s", "t");

    const input = { sessionId: "s", turnId: "t" } as ChatTurnAgentRunnerInput;
    await control.resolveConfirmedDelegation(input);
    expect(delegation.resolveConfirmedDelegation).toHaveBeenCalledWith(host, input);

    await control.reconcileWaitingDelegations();
    expect(delegation.reconcileWaitingConfirmedDelegations).toHaveBeenCalledWith(host);

    const child = { durableRunId: "run", childSessionId: "s", childTurnId: "t", parentDelegationStepId: "step" };
    await control.reconcileDelegationChild(child as Parameters<typeof control.reconcileDelegationChild>[0]);
    expect(delegation.reconcileConfirmedDelegationChild).toHaveBeenCalledWith(host, child);

    await control.readParentProfile("step");
    expect(delegation.readConfirmedDelegationParentProfile).toHaveBeenCalledWith(storage, "step");
  });
});
