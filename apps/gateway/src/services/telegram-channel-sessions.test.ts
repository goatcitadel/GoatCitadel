import { describe, expect, it } from "vitest";
import {
  applyTelegramChannelSessionRotation,
  createTelegramChannelSessionPatch,
  resolveTelegramChannelSessionId,
} from "./telegram-channel-sessions.js";

/**
 * Pins the identity/isolation contract of resolveTelegramChannelSessionId and
 * applyTelegramChannelSessionRotation (telegram-channel-sessions.ts). This
 * module has no prior test coverage even though it derives the session id a
 * Telegram inbound message is routed to (session-key.ts's
 * resolveSessionRoute), and — via applyTelegramChannelSessionRotation —
 * decides whether a stored session record's nonce gets folded into that
 * derivation. A regression here would either cross-wire two conversations
 * into one session (collision) or silently reuse a session across an
 * intended rotation.
 */
describe("resolveTelegramChannelSessionId", () => {
  it("resolves a stable session id for the same account/peer/room/thread tuple", () => {
    const config: Record<string, unknown> = {};
    const route = { account: "acct-1", peer: "peer-1", room: "room-1", threadId: "thread-1" };

    const first = resolveTelegramChannelSessionId(config, route);
    const second = resolveTelegramChannelSessionId(config, { ...route });

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("resolves distinct session ids across different peers and threads", () => {
    const config: Record<string, unknown> = {};

    const roomOne = resolveTelegramChannelSessionId(config, { account: "acct-1", room: "room-1" });
    const roomTwo = resolveTelegramChannelSessionId(config, { account: "acct-1", room: "room-2" });
    const roomOneThreadOne = resolveTelegramChannelSessionId(config, {
      account: "acct-1",
      room: "room-1",
      threadId: "thread-1",
    });
    const dmPeerOne = resolveTelegramChannelSessionId(config, { account: "acct-1", peer: "peer-1" });

    const ids = [roomOne, roomTwo, roomOneThreadOne, dmPeerOne];
    for (const id of ids) {
      expect(id).toBeDefined();
    }
    // Every scope (different room, a thread within a room, and a bare DM
    // peer) must land on its own session id — otherwise replies from
    // isolated conversations would be routed into the same session.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("applies session rotation without leaking the prior session id", () => {
    const route = { account: "acct-1", room: "chat-100" };

    // No session record has been written yet for this scope, so rotation is
    // a no-op and the session id is derived straight from the route.
    const beforeSessionId = resolveTelegramChannelSessionId({}, route);
    expect(beforeSessionId).toBeDefined();

    // createTelegramChannelSessionPatch is the real production path that
    // establishes/rotates a session record: it stamps a fresh random nonce
    // for the (chatId, threadId) scope.
    const patch = createTelegramChannelSessionPatch({
      config: {},
      chatId: "chat-100",
      actorId: "actor-1",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const rotatedConfig: Record<string, unknown> = { ...patch };

    const afterSessionId = resolveTelegramChannelSessionId(rotatedConfig, route);
    expect(afterSessionId).toBeDefined();
    // The rotated session id must differ from the pre-rotation id — the old
    // id is not reused/leaked once a session record exists for the scope.
    expect(afterSessionId).not.toBe(beforeSessionId);

    // Rotation is stable once applied: re-resolving against the same
    // rotated config does not mint a new id on every call.
    const afterSessionIdAgain = resolveTelegramChannelSessionId(rotatedConfig, route);
    expect(afterSessionIdAgain).toBe(afterSessionId);

    // Confirm the actual mechanism: the room segment fed into
    // resolveSessionRoute gets the stored nonce appended, which is what
    // changes the derived session id above (not incidental hash collision).
    const rotatedRoute = applyTelegramChannelSessionRotation(rotatedConfig, route);
    expect(rotatedRoute.room).not.toBe(route.room);
    expect(rotatedRoute.room).toMatch(/^chat-100~tg_/);
  });
});
