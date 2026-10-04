import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { REALTIME_EVENT_TIMEOUT_MS, realtimeChecks } from "./realtime";

const mocks = vi.hoisted(() => ({
  connectEventStream: vi.fn(),
  createChatSession: vi.fn(),
  disconnect: vi.fn(),
  removeItem: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ connectEventStream: mocks.connectEventStream }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ createChatSession: mocks.createChatSession }));

const CURSOR_KEY = "goatcitadel.events.cursor.v1";

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  vi.stubGlobal("localStorage", { removeItem: mocks.removeItem });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Makes the stream deliver the session-created event for `sessionId` shortly after the session is created. */
function armSessionCreatedEvent(sessionId: string, replayed: boolean): void {
  let listener: ((event: unknown, delivery: unknown) => void) | undefined;
  mocks.connectEventStream.mockImplementation((onEvent: (event: unknown, delivery: unknown) => void) => {
    listener = onEvent;
    return mocks.disconnect;
  });
  mocks.createChatSession.mockImplementation(async () => {
    setTimeout(
      () =>
        listener?.(
          {
            eventId: "e-1",
            sequence: 7,
            eventType: "chat_session_updated",
            source: "chat",
            timestamp: "t",
            payload: { type: "chat_session_created", sessionId },
          },
          { replayed },
        ),
      0,
    );
    return { sessionId };
  });
}

describe("session creation event", () => {
  it("passes when the event arrives and always disconnects", async () => {
    armSessionCreatedEvent("s-1", false);
    const check = findCheck(realtimeChecks, "events.session-created");
    const ctx = makeTestContext();
    await expect(check.run(ctx)).resolves.toMatchObject({
      status: "pass",
      summary: "Received chat_session_updated for s-1 (sequence 7).",
      evidence: { eventType: "chat_session_updated", sequence: 7, replayed: false },
    });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.steps.map((step) => step.title)).toEqual(check.steps);
  });

  it("reports in the evidence when the matched event was a replayed catch-up frame", async () => {
    armSessionCreatedEvent("s-1", true);
    await expect(findCheck(realtimeChecks, "events.session-created").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      evidence: { eventType: "chat_session_updated", sequence: 7, replayed: true },
    });
  });

  it("fails after the timeout when no matching event arrives", async () => {
    vi.useFakeTimers();
    mocks.connectEventStream.mockReturnValue(mocks.disconnect);
    mocks.createChatSession.mockResolvedValue({ sessionId: "s-2" });
    const running = findCheck(realtimeChecks, "events.session-created").run(makeTestContext());
    const assertion = expect(running).rejects.toThrow("did not happen within 15 s");
    await vi.advanceTimersByTimeAsync(REALTIME_EVENT_TIMEOUT_MS + 1_000);
    await assertion;
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects when the session cannot be created", async () => {
    mocks.connectEventStream.mockReturnValue(mocks.disconnect);
    mocks.createChatSession.mockRejectedValue(new Error("session refused"));
    await expect(findCheck(realtimeChecks, "events.session-created").run(makeTestContext())).rejects.toThrow(
      "session refused",
    );
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("stale stream cursor", () => {
  it("clears the stored cursor before the stream is opened", async () => {
    const calls: string[] = [];
    mocks.removeItem.mockImplementation((key: string) => {
      calls.push(`remove ${key}`);
    });
    mocks.connectEventStream.mockImplementation(() => {
      calls.push("connect");
      return mocks.disconnect;
    });
    mocks.createChatSession.mockRejectedValue(new Error("stop here"));
    await expect(findCheck(realtimeChecks, "events.session-created").run(makeTestContext())).rejects.toThrow(
      "stop here",
    );
    expect(calls).toEqual([`remove ${CURSOR_KEY}`, "connect"]);
  });

  it("still opens the stream when storage is unavailable", async () => {
    mocks.removeItem.mockImplementation(() => {
      throw new Error("storage blocked");
    });
    armSessionCreatedEvent("s-1", false);
    await expect(findCheck(realtimeChecks, "events.session-created").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
    });
    expect(mocks.connectEventStream).toHaveBeenCalledTimes(1);
  });
});
