import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { idempotencyHeaderPlugin } from "./idempotency.js";

describe("idempotency fingerprint for a streamed upload", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("fingerprints the upload's description and leaves the body unread for the route", async () => {
    const claim = vi.fn(async () => ({ outcome: "claimed" as const, record: { claimToken: "claim" } }));
    const store = { claim, markCompleted: vi.fn(async () => true), markFailed: vi.fn(async () => true) };
    const received: string[] = [];
    app = Fastify();
    app.decorateRequest("authActorId", "operator:test");
    await app.register(idempotencyHeaderPlugin, { mutationStore: store as never });
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
    app.post("/api/v1/files/upload", async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request.body as AsyncIterable<Buffer>) chunks.push(chunk);
      received.push(Buffer.concat(chunks).toString());
      return { ok: true };
    });
    const upload = (key: string, payload: string) =>
      app!.inject({
        method: "POST",
        url: "/api/v1/files/upload?relativePath=notes%2Fa.md",
        headers: { "Idempotency-Key": key, "content-type": "application/octet-stream" },
        payload,
      });

    expect((await upload("idem-stream-1", "first")).statusCode).toBe(200);
    expect((await upload("idem-stream-2", "other")).statusCode).toBe(200);
    expect((await upload("idem-stream-3", "longer body")).statusCode).toBe(200);

    expect(received).toEqual(["first", "other", "longer body"]);
    const hashes = claim.mock.calls.map((call) => (call as unknown as [{ payloadHash: string }])[0].payloadHash);
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(JSON.stringify(claim.mock.calls)).not.toMatch(/first|other|longer body/u);
  });
});
