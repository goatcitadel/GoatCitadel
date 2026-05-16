import { describe, expect, it } from "vitest";
import { ChatSteerService } from "./chat-steer-service";

describe("ChatSteerService", () => {
  it("returns rejected when no active turn is registered for the session", () => {
    const service = new ChatSteerService();
    const result = service.enqueue({ sessionId: "s-1", instruction: "go faster" });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/no active turn/i);
  });

  it("accepts when an active turn is registered and drains in order", () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    expect(service.enqueue({ sessionId: "s-1", instruction: "first" }).accepted).toBe(true);
    expect(service.enqueue({ sessionId: "s-1", instruction: "second" }).accepted).toBe(true);
    const drained = service.drainPending({ sessionId: "s-1", turnId: "t-1" });
    expect(drained.map((item) => item.instruction)).toEqual(["first", "second"]);
    expect(service.drainPending({ sessionId: "s-1", turnId: "t-1" })).toEqual([]);
  });

  it("clears the active turn on unregister", () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    service.unregisterActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    expect(service.enqueue({ sessionId: "s-1", instruction: "x" }).accepted).toBe(false);
  });

  it("rejects steer for stale turnId", () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-2" }); // replaces t-1
    const drained = service.drainPending({ sessionId: "s-1", turnId: "t-1" });
    expect(drained).toEqual([]);
  });
});
