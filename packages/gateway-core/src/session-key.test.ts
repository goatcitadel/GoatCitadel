import { describe, expect, it } from "vitest";
import { resolveSessionRoute } from "./session-key.js";

describe("resolveSessionRoute", () => {
  it("builds deterministic DM key", () => {
    const route = resolveSessionRoute({
      channel: "telegram",
      account: "me",
      peer: "alice",
    });

    expect(route.kind).toBe("dm");
    expect(route.sessionKey).toBe("telegram:me:alice");
    expect(route.sessionId).toMatch(/^sess_/);
  });

  it("builds deterministic group key", () => {
    const route = resolveSessionRoute({
      channel: "slack",
      account: "me",
      room: "eng",
    });

    expect(route.kind).toBe("group");
    expect(route.sessionKey).toBe("slack:me:eng");
  });

  it("builds deterministic thread key", () => {
    const route = resolveSessionRoute({
      channel: "slack",
      account: "me",
      room: "eng",
      threadId: "123",
    });

    expect(route.kind).toBe("thread");
    expect(route.sessionKey).toBe("slack:me:eng:123");
  });

  it("validates required route segments and normalizes separators", () => {
    expect(() => resolveSessionRoute({ channel: "", account: "me", peer: "alice" })).toThrow(
      "route.channel and route.account are required",
    );
    expect(() => resolveSessionRoute({ channel: "slack", account: "me", threadId: "1" })).toThrow(
      "route.room is required when route.threadId is provided",
    );
    expect(() => resolveSessionRoute({ channel: "slack", account: "me" })).toThrow(
      "route.peer is required for DM sessions",
    );
    expect(() => resolveSessionRoute({ channel: "slack", account: "   ", peer: "alice" })).toThrow(
      "session key segments cannot be empty",
    );

    expect(resolveSessionRoute({ channel: "slack:prod", account: " me ", peer: "alice:bob" }).sessionKey).toBe(
      "slack%3Aprod:me:alice%3Abob",
    );
  });

  it("keeps peers whose ids differ only by the separator in distinct sessions", () => {
    // F-M4: collapsing every `:` to `_` made `a:b` and `a_b` share a session key,
    // cross-wiring two peers' transcripts. The reversible encoding must keep them
    // distinct at both the session-key and derived session-id level.
    const colon = resolveSessionRoute({ channel: "xmpp", account: "me", peer: "a:b" });
    const underscore = resolveSessionRoute({ channel: "xmpp", account: "me", peer: "a_b" });

    expect(colon.sessionKey).not.toBe(underscore.sessionKey);
    expect(colon.sessionKey).toBe("xmpp:me:a%3Ab");
    expect(underscore.sessionKey).toBe("xmpp:me:a_b");
    expect(colon.sessionId).not.toBe(underscore.sessionId);
  });

  it("reversibly encodes percent and colon so no two segment values collide", () => {
    // The literal segment `a%3Ab` (a peer that contains a percent sign) must not
    // collapse onto the encoding of `a:b`; encoding `%` first guarantees this.
    const literalPercent = resolveSessionRoute({ channel: "xmpp", account: "me", peer: "a%3Ab" });
    const encodedColon = resolveSessionRoute({ channel: "xmpp", account: "me", peer: "a:b" });

    expect(literalPercent.sessionKey).toBe("xmpp:me:a%253Ab");
    expect(literalPercent.sessionKey).not.toBe(encodedColon.sessionKey);
    expect(literalPercent.sessionId).not.toBe(encodedColon.sessionId);
  });
});
