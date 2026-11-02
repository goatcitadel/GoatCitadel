import { describe, expect, it, vi } from "vitest";
import type { DiscordPairingRecord } from "@goatcitadel/contracts";
import {
  resolveApprovalWithRemoteTokenId,
  type ApprovalRemoteActionContext,
} from "../approval-remote-action-service.js";
import { createErrandPressGuard, ERRAND_OWNER_ONLY_COPY, ErrandOwnerOnlyError } from "./errand-approval-press-guard.js";

const OWNER = "1001";
const FRIEND = "2002";
const CONSUMED = new Error("token consumed");

const telegramConfig = {
  inboundAccessMode: "pairing",
  ownerActorIds: [OWNER],
  telegramPairing: {
    approved: [OWNER, FRIEND].map((actorId) => ({ actorId, approvedAt: "2026-11-01T00:00:00.000Z" })),
    pending: [],
  },
};
const discordConfig = { inboundAccessMode: "pairing", ownerActorIds: [OWNER] };

function pairing(userId: string): DiscordPairingRecord {
  return {
    pairingId: `p-${userId}`,
    connectionId: "conn-1",
    userId,
    code: "ABC123",
    status: "approved",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function setup(kind: string, channel: "telegram" | "discord") {
  const consume = vi.fn(async () => {
    throw CONSUMED;
  });
  const guard = createErrandPressGuard({
    connection: async () => ({ key: channel, config: channel === "telegram" ? telegramConfig : discordConfig }),
    readDiscordPairings: async () => [pairing(OWNER), pairing(FRIEND)],
  });
  const context = {
    storage: {
      remoteActionTokens: { get: () => ({ tokenId: "tok-1", approvalId: "approval-1" }) },
      approvals: { get: async () => ({ approvalId: "approval-1", kind }) },
    },
    assertErrandPressOwner: guard,
    consumeRemoteActionTokenById: consume,
  } as unknown as ApprovalRemoteActionContext;
  const press = (actorId: string) =>
    resolveApprovalWithRemoteTokenId(context, {
      tokenId: "tok-1",
      connectorId: "integration:conn-1",
      decision: "approve",
      channelActorId: actorId,
    });
  return { press, consume };
}

describe("errand approval buttons answer only to the owner", () => {
  it.each(["telegram", "discord"] as const)(
    "%s: a paired non-owner is refused and the token stays unspent",
    async (channel) => {
      const { press, consume } = setup("browser.errand.action", channel);
      await expect(press(FRIEND)).rejects.toBeInstanceOf(ErrandOwnerOnlyError);
      expect(consume).not.toHaveBeenCalled();
    },
  );

  it.each(["telegram", "discord"] as const)("%s: the owner goes on to resolve", async (channel) => {
    const { press, consume } = setup("browser.errand.action", channel);
    await expect(press(OWNER)).rejects.toBe(CONSUMED);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it.each(["telegram", "discord"] as const)(
    "%s: a non-errand approval from a paired non-owner is unchanged",
    async (channel) => {
      const { press, consume } = setup("tool.exec", channel);
      await expect(press(FRIEND)).rejects.toBe(CONSUMED);
      expect(consume).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses an errand approval when no owner check is wired", async () => {
    const consume = vi.fn();
    const bare = {
      storage: {
        remoteActionTokens: { get: () => ({ tokenId: "tok-1", approvalId: "approval-1" }) },
        approvals: { get: async () => ({ approvalId: "approval-1", kind: "browser.errand.action" }) },
      },
      consumeRemoteActionTokenById: consume,
    } as unknown as ApprovalRemoteActionContext;
    await expect(
      resolveApprovalWithRemoteTokenId(bare, {
        tokenId: "tok-1",
        connectorId: "integration:conn-1",
        decision: "approve",
        channelActorId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ErrandOwnerOnlyError);
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuses when the connection cannot be read, and carries the agreed copy", async () => {
    const guard = createErrandPressGuard({
      connection: async () => Promise.reject(new Error("gone")),
      readDiscordPairings: async () => [],
    });
    await expect(guard({ connectorId: "integration:conn-1", actorId: OWNER })).rejects.toThrow(ERRAND_OWNER_ONLY_COPY);
    await expect(guard({ connectorId: "mission-control", actorId: OWNER })).rejects.toBeInstanceOf(
      ErrandOwnerOnlyError,
    );
  });
});
