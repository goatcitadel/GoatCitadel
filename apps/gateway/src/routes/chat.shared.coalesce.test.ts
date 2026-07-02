import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_SSE_HEARTBEAT_INTERVAL_MS, coalesceStreamingDeltas, streamSseReply } from "./chat.shared.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("coalesceStreamingDeltas", () => {
  it("merges adjacent same-type deltas into one combined chunk within window", async () => {
    async function* source() {
      yield { type: "assistant.delta", delta: "hello " };
      yield { type: "assistant.delta", delta: "world" };
      yield { type: "tool_call.start", id: "t1" };
      yield { type: "assistant.delta", delta: "!" };
    }
    const out: unknown[] = [];
    for await (const chunk of coalesceStreamingDeltas(source(), { windowMs: 50 })) {
      out.push(chunk);
    }
    const deltas = out.filter((c) => (c as { type: string }).type === "assistant.delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0] as { delta: string }).delta).toBe("hello world");
    expect((deltas[1] as { delta: string }).delta).toBe("!");
  });

  it("does NOT drop buffered content on completion", async () => {
    async function* source() {
      yield { type: "assistant.delta", delta: "a" };
      yield { type: "assistant.delta", delta: "b" };
      yield { type: "assistant.delta", delta: "c" };
    }
    const out: Array<{ type: string; delta?: string }> = [];
    for await (const chunk of coalesceStreamingDeltas(source(), { windowMs: 1000 })) {
      out.push(chunk as never);
    }
    const combined = out
      .filter((c) => c.type === "assistant.delta")
      .map((c) => c.delta ?? "")
      .join("");
    expect(combined).toBe("abc");
  });

  it("passes through non-delta event types immediately", async () => {
    async function* source() {
      yield { type: "tool_call.start", id: "x" };
      yield { type: "tool_call.end", id: "x" };
    }
    const out: unknown[] = [];
    for await (const chunk of coalesceStreamingDeltas(source(), { windowMs: 50 })) {
      out.push(chunk);
    }
    expect(out).toHaveLength(2);
  });

  it("coalesces production bare-delta events emitted by the gateway", async () => {
    async function* source() {
      yield { type: "delta", delta: "alpha ", sessionId: "s1", eventId: "e1", sequence: 1 };
      yield { type: "delta", delta: "beta", sessionId: "s1", eventId: "e2", sequence: 2 };
      yield { type: "delta", delta: " gamma", sessionId: "s1", eventId: "e3", sequence: 3 };
    }
    const out: Array<Record<string, unknown>> = [];
    for await (const chunk of coalesceStreamingDeltas(source(), { windowMs: 1000 })) {
      out.push(chunk as Record<string, unknown>);
    }
    expect(out).toHaveLength(1);
    expect(out[0]?.delta).toBe("alpha beta gamma");
    // The latest event's metadata wins (eventId/sequence from the last in group).
    expect(out[0]?.eventId).toBe("e3");
    expect(out[0]?.sequence).toBe(3);
  });
});

describe("streamSseReply", () => {
  it("keeps idle chat SSE streams alive with heartbeat comments", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const raw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        chunks.push(chunk);
        return true;
      }),
      end: vi.fn(function end(this: { writableEnded: boolean }) {
        this.writableEnded = true;
      }),
    });
    const requestRaw = new EventEmitter();
    const reply = {
      raw,
      hijack: vi.fn(),
      getHeader: vi.fn(() => undefined),
      log: { error: vi.fn() },
    };

    async function* idleSource(signal: AbortSignal): AsyncGenerator<unknown> {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield* [];
    }

    const stream = streamSseReply(reply as never, { raw: requestRaw as never }, "session-heartbeat", idleSource);
    await vi.waitFor(() => expect(chunks).toContain(": connected\n\n"));

    await vi.advanceTimersByTimeAsync(CHAT_SSE_HEARTBEAT_INTERVAL_MS);

    expect(chunks).toContain(": heartbeat\n\n");
    raw.emit("close");
    await stream;
    expect(raw.end).toHaveBeenCalledTimes(1);
  });
});
