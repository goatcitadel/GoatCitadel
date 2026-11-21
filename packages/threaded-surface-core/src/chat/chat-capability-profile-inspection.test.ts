import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import {
  fetchChatTurnCapabilityProfile,
  fetchChatTurnRoutedContext,
} from "@goatcitadel/mission-control-shared/api/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectCapabilityProfile } from "./chat-capability-profile-inspection";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatTurnCapabilityProfile: vi.fn(),
  fetchChatTurnRoutedContext: vi.fn(),
}));

const admittedContext = {
  snapshotId: "snapshot-1",
  snapshotHash: "snapshot-hash",
  sourceRequestHash: "request-hash",
  contentHash: "content-hash",
};
const turn = {
  turnId: "turn-1",
  trace: { routing: { routedContext: admittedContext } },
} as ChatThreadTurnRecord;

describe("deferred Chat capability inspection", () => {
  beforeEach(() => vi.resetAllMocks());

  it("publishes routed context only for the matching admission", async () => {
    const response = {
      state: "admission_bound",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-1",
      routedContext: admittedContext,
    } as Awaited<ReturnType<typeof fetchChatTurnRoutedContext>>;
    vi.mocked(fetchChatTurnRoutedContext)
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({
        ...response,
        workspaceId: "workspace-2",
      });

    await expect(inspectCapabilityProfile("session-1", "workspace-1", turn)).resolves.toMatchObject({
      status: "admission_verified",
      routedContext: admittedContext,
    });
    const refused = await inspectCapabilityProfile("session-1", "workspace-1", turn);
    expect(refused).toMatchObject({ status: "invalid", mismatchFields: ["context scope"] });
    expect(refused.routedContext).toBeUndefined();
    expect(fetchChatTurnRoutedContext).toHaveBeenCalledWith("session-1", "turn-1", "workspace-1");
    expect(fetchChatTurnCapabilityProfile).not.toHaveBeenCalled();
  });

  it("preserves the status of a forbidden immutable profile", async () => {
    const profiledTurn = {
      ...turn,
      trace: { ...turn.trace, capabilityProfileId: "profile-1", capabilityProfileHash: "profile-hash" },
    };
    vi.mocked(fetchChatTurnCapabilityProfile).mockRejectedValueOnce({ status: 403 });
    await expect(inspectCapabilityProfile("session-1", "workspace-1", profiledTurn)).resolves.toMatchObject({
      status: "forbidden",
      profile: null,
      expectedProfileId: "profile-1",
      expectedProfileHash: "profile-hash",
    });
    expect(fetchChatTurnRoutedContext).not.toHaveBeenCalled();
  });
});
