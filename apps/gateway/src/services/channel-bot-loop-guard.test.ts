import { describe, expect, it } from "vitest";
import { ChannelBotLoopGuard, type BotLoopGuardKey } from "./channel-bot-loop-guard.js";

const CONFIG = { maxEventsPerWindow: 20, windowSeconds: 60, cooldownSeconds: 60, enabled: true };
const KEY: BotLoopGuardKey = {
  scope: "ws1",
  conversation: "c1",
  participantA: "bot1",
  participantB: "bot2",
};

describe("ChannelBotLoopGuard", () => {
  it("allows the first 20 events in a 60s window", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 20; i++) {
      now += 100;
      expect(guard.decide(KEY).action).toBe("allow");
    }
  });

  it("suppresses event 21 within the window with reason rate-cap", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 20; i++) {
      now += 100;
      guard.decide(KEY);
    }
    now += 100;
    const decision = guard.decide(KEY);
    expect(decision.action).toBe("suppress");
    if (decision.action === "suppress") {
      expect(decision.reason).toBe("rate-cap");
    }
  });

  it("allows again after cooldown elapses", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 21; i++) {
      now += 100;
      guard.decide(KEY);
    }
    now += 70_000;
    expect(guard.decide(KEY).action).toBe("allow");
  });

  it("reports cooldown reason for attempts during cooldown", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 21; i++) {
      now += 100;
      guard.decide(KEY);
    }
    now += 1000;
    const decision = guard.decide(KEY);
    expect(decision.action).toBe("suppress");
    if (decision.action === "suppress") {
      expect(decision.reason).toBe("cooldown");
    }
  });

  it("different pairs in same conversation are independent", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    const pairB: BotLoopGuardKey = { ...KEY, participantA: "bot3", participantB: "bot4" };
    for (let i = 0; i < 20; i++) {
      now += 100;
      guard.decide(KEY);
    }
    expect(guard.decide(pairB).action).toBe("allow");
  });

  it("keeps pairs distinct when participant ids contain spaces", () => {
    // Ids with spaces are reachable: Nextcloud Talk forwards actor.id
    // unvalidated and Nextcloud user ids may contain spaces; Signal actor ids
    // are unvalidated bridge pass-throughs. With a plain-space separator both
    // pairs below canonicalize to "s c a b x", so capping pair one would
    // wrongly suppress pair two.
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    const pairOne: BotLoopGuardKey = { scope: "s", conversation: "c", participantA: "a", participantB: "b x" };
    const pairTwo: BotLoopGuardKey = { scope: "s", conversation: "c", participantA: "a b", participantB: "x" };
    for (let i = 0; i < 20; i++) {
      now += 100;
      guard.decide(pairOne);
    }
    now += 100;
    expect(guard.decide(pairOne).action).toBe("suppress");
    expect(guard.decide(pairTwo).action).toBe("allow");
  });

  it("keeps a space-bearing conversation id from bleeding into the participant fields", () => {
    // Space-joined, both keys read "s c a b x"; the conversation/participant
    // boundary must survive ids that contain spaces.
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    const roomKey: BotLoopGuardKey = { scope: "s", conversation: "c a", participantA: "b", participantB: "x" };
    const otherRoomKey: BotLoopGuardKey = { scope: "s", conversation: "c", participantA: "a b", participantB: "x" };
    for (let i = 0; i < 20; i++) {
      now += 100;
      guard.decide(roomKey);
    }
    now += 100;
    expect(guard.decide(otherRoomKey).action).toBe("allow");
  });

  it("canonicalizes pair order (A,B) === (B,A)", () => {
    const guard = new ChannelBotLoopGuard(CONFIG, () => 1_000_000);
    const reversed: BotLoopGuardKey = {
      ...KEY,
      participantA: KEY.participantB,
      participantB: KEY.participantA,
    };
    for (let i = 0; i < 20; i++) {
      guard.decide(KEY);
    }
    expect(guard.decide(reversed).action).toBe("suppress");
  });

  it("inspect() reports state without mutating", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    for (let i = 0; i < 5; i++) {
      now += 100;
      guard.decide(KEY);
    }
    const before = guard.inspect(KEY);
    expect(before.eventsInWindow).toBe(5);
    guard.inspect(KEY);
    expect(guard.inspect(KEY).eventsInWindow).toBe(5);
  });

  it("gc() evicts idle keys past cooldown horizon", () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(CONFIG, () => now);
    guard.decide(KEY);
    now += 200_000;
    expect(guard.gc()).toBeGreaterThanOrEqual(1);
    expect(guard.inspect(KEY).eventsInWindow).toBe(0);
  });

  it("when disabled, never suppresses", () => {
    const guard = new ChannelBotLoopGuard({ ...CONFIG, enabled: false }, () => 1_000_000);
    for (let i = 0; i < 100; i++) {
      expect(guard.decide(KEY).action).toBe("allow");
    }
  });
});
