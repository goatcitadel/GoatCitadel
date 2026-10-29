import type { ChatThreadResponse, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { carryOverStreamedThinking } from "./chat-thread-reducer";

const turn = (turnId: string, thinking?: string) => ({ turnId, thinking }) as unknown as ChatThreadTurnRecord;
const thread = (sessionId: string, turns: ChatThreadTurnRecord[]) => ({ sessionId, turns }) as ChatThreadResponse;

describe("carryOverStreamedThinking", () => {
  it("keeps reasoning the browser streamed when a reloaded thread has none", () => {
    const previous = thread("s1", [turn("t1", "Weigh the two loops"), turn("t2")]);
    const next = thread("s1", [turn("t1"), turn("t2"), turn("t3")]);
    const merged = carryOverStreamedThinking(previous, next)!;
    expect(merged.turns.map((t) => t.thinking)).toEqual(["Weigh the two loops", undefined, undefined]);
    expect(next.turns[0]!.thinking).toBeUndefined();
  });

  it("prefers reasoning the new copy already has", () => {
    const merged = carryOverStreamedThinking(thread("s1", [turn("t1", "older")]), thread("s1", [turn("t1", "newer")]));
    expect(merged!.turns[0]!.thinking).toBe("newer");
  });

  it("keeps a resumed pass's newer reasoning over the copy the earlier pass saved", () => {
    const merged = carryOverStreamedThinking(
      thread("s1", [turn("t1", "Plan the command.Approved, so I run it.")]),
      thread("s1", [turn("t1", "Plan the command.")]),
    );
    expect(merged!.turns[0]!.thinking).toBe("Plan the command.Approved, so I run it.");
  });

  it("returns the new copy untouched when nothing is carried, or when the conversation changed", () => {
    const next = thread("s1", [turn("t1")]);
    expect(carryOverStreamedThinking(thread("s1", [turn("t1")]), next)).toBe(next);
    expect(carryOverStreamedThinking(null, next)).toBe(next);
    const other = thread("s2", [turn("t1")]);
    expect(carryOverStreamedThinking(thread("s1", [turn("t1", "private")]), other)).toBe(other);
    expect(carryOverStreamedThinking(thread("s1", [turn("t1", "x")]), null)).toBeNull();
  });
});
