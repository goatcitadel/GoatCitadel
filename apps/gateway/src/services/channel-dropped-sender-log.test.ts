import { describe, expect, it } from "vitest";
import { ChannelDroppedSenderLog } from "./channel-dropped-sender-log.js";

function clock(start = "2026-11-15T10:00:00.000Z") {
  let value = Date.parse(start);
  return { now: () => new Date(value), advance: (ms: number) => (value += ms) };
}

describe("ChannelDroppedSenderLog", () => {
  it("lists the newest drop first", () => {
    const time = clock();
    const log = new ChannelDroppedSenderLog({ now: time.now });
    log.record({ connectionId: "c1", senderId: "U1" });
    time.advance(1000);
    log.record({ connectionId: "c1", senderId: "U2" });
    expect(log.list("c1").map((item) => item.senderId)).toEqual(["U2", "U1"]);
  });

  it("keeps one row per sender, with the newest drop time", () => {
    const time = clock();
    const log = new ChannelDroppedSenderLog({ now: time.now });
    log.record({ connectionId: "c1", senderId: "U1" });
    time.advance(5000);
    log.record({ connectionId: "c1", senderId: "U1" });
    expect(log.list("c1")).toEqual([{ senderId: "U1", droppedAt: "2026-11-15T10:00:05.000Z" }]);
  });

  it("keeps at most five senders per connection", () => {
    const time = clock();
    const log = new ChannelDroppedSenderLog({ now: time.now });
    for (let index = 1; index <= 7; index += 1) {
      log.record({ connectionId: "c1", senderId: `U${index}` });
      time.advance(1000);
    }
    expect(log.list("c1").map((item) => item.senderId)).toEqual(["U7", "U6", "U5", "U4", "U3"]);
  });

  it("hides entries older than 30 minutes", () => {
    const time = clock();
    const log = new ChannelDroppedSenderLog({ now: time.now });
    log.record({ connectionId: "c1", senderId: "U1" });
    time.advance(30 * 60 * 1000 + 1);
    expect(log.list("c1")).toEqual([]);
  });

  it("evicts the oldest connection past the connection limit", () => {
    const log = new ChannelDroppedSenderLog({ maxConnections: 2 });
    log.record({ connectionId: "a", senderId: "U1" });
    log.record({ connectionId: "b", senderId: "U1" });
    log.record({ connectionId: "c", senderId: "U1" });
    expect(log.list("a")).toEqual([]);
    expect(log.list("b")).toHaveLength(1);
    expect(log.list("c")).toHaveLength(1);
  });

  it("lists nothing for a connection it never saw", () => {
    expect(new ChannelDroppedSenderLog().list("unknown")).toEqual([]);
  });
});
