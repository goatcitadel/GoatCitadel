import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { REALTIME_EVENT_TIMEOUT_MS, realtimeChecks } from "./realtime";

const mocks = vi.hoisted(() => ({ connectEventStream: vi.fn(), createChatSession: vi.fn(), disconnect: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ connectEventStream: mocks.connectEventStream }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ createChatSession: mocks.createChatSession }));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session creation event", () => {
  it("passes when the event arrives and always disconnects", async () => {
    let listener: ((event: unknown) => void) | undefined;
    mocks.connectEventStream.mockImplementation((onEvent: (event: unknown) => void) => {
      listener = onEvent;
      return mocks.disconnect;
    });
    mocks.createChatSession.mockImplementation(async () => {
      setTimeout(
        () =>
          listener?.({
            eventId: "e-1",
            sequence: 7,
            eventType: "chat_session_updated",
            source: "chat",
            timestamp: "t",
            payload: { type: "chat_session_created", sessionId: "s-1" },
          }),
        0,
      );
      return { sessionId: "s-1" };
    });
    await expect(findCheck(realtimeChecks, "events.session-created").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Received chat_session_updated for s-1 (sequence 7).",
    });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
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
});
