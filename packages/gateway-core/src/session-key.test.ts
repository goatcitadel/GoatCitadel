import { describe, expect, it } from "vitest";
import { decodeSessionKeySegment, resolveSessionRoute } from "./session-key.js";

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

describe("decodeSessionKeySegment", () => {
  function routeFromKey(kind: "dm" | "group" | "thread", sessionKey: string, channel: string, account: string) {
    const [, , third, fourth] = sessionKey.split(":").map(decodeSessionKeySegment);
    if (kind === "dm") return { channel, account, peer: third };
    if (kind === "group") return { channel, account, room: third };
    return { channel, account, room: third, threadId: fourth };
  }

  it.each([
    { kind: "dm" as const, route: { channel: "xmpp", account: "me", peer: "alice:example.org" } },
    { kind: "dm" as const, route: { channel: "xmpp", account: "me", peer: "a%3Ab" } },
    { kind: "group" as const, route: { channel: "matrix", account: "conn", room: "!room:example.org" } },
    { kind: "group" as const, route: { channel: "matrix", account: "conn", room: "100%:literal%25" } },
    {
      kind: "thread" as const,
      route: { channel: "matrix", account: "conn", room: "!room:example.org", threadId: "$evt:example.org" },
    },
  ])("round-trips a $kind session key back to the same session id ($route)", ({ kind, route }) => {
    const first = resolveSessionRoute(route);
    expect(first.kind).toBe(kind);

    const rebuilt = routeFromKey(kind, first.sessionKey, route.channel, route.account);
    expect(rebuilt).toEqual(route);
    expect(resolveSessionRoute(rebuilt).sessionId).toBe(first.sessionId);
  });

  it("decodes colon escapes before percent escapes", () => {
    expect(decodeSessionKeySegment("!room%3Aexample.org")).toBe("!room:example.org");
    expect(decodeSessionKeySegment("a%253Ab")).toBe("a%3Ab");
    expect(decodeSessionKeySegment("plain")).toBe("plain");
  });
});
