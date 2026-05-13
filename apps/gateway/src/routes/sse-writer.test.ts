import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { writeSseChunk, writeSsePayload } from "./sse-writer.js";

class FakeWritable extends EventEmitter {
  public readonly writes: string[] = [];
  public destroyed = false;
  public writableEnded = false;
  public acceptWrites = true;

  public write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.acceptWrites;
  }
}

describe("sse-writer", () => {
  it("waits for drain when the writable stream applies backpressure", async () => {
    const raw = new FakeWritable();
    raw.acceptWrites = false;

    let resolved = false;
    const pending = writeSseChunk(raw, "data: one\n\n").then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    raw.acceptWrites = true;
    raw.emit("drain");

    await expect(pending).resolves.toBe(true);
    expect(raw.writes).toEqual(["data: one\n\n"]);
  });

  it("writes named payload events with ids", async () => {
    const raw = new FakeWritable();

    await expect(writeSsePayload(raw, { type: "ready" }, { eventName: "stream-ready", eventId: 42 })).resolves.toBe(
      true,
    );

    expect(raw.writes).toEqual(["event: stream-ready\n", "id: 42\n", 'data: {"type":"ready"}\n\n']);
  });

  it("stops promptly when aborted while waiting for drain", async () => {
    const raw = new FakeWritable();
    raw.acceptWrites = false;
    const controller = new AbortController();

    const pending = writeSseChunk(raw, "data: one\n\n", controller.signal);
    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("stop");
  });
});
