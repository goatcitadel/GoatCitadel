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
    const upload = (key: string, payload: string, query = "relativePath=notes%2Fa.md") =>
      app!.inject({
        method: "POST",
        url: `/api/v1/files/upload?${query}`,
        headers: { "Idempotency-Key": key, "content-type": "application/octet-stream" },
        payload,
      });

    expect((await upload("idem-stream-1", "first", "relativePath=notes%2Fa.md&access_token=secret-a")).statusCode).toBe(
      200,
    );
    expect((await upload("idem-stream-2", "other", "relativePath=notes%2Fa.md&access_token=secret-b")).statusCode).toBe(
      200,
    );
    expect((await upload("idem-stream-3", "longer body")).statusCode).toBe(200);
    expect((await upload("idem-stream-4", "first", "relativePath=notes%2Fb.md")).statusCode).toBe(200);

    expect(received).toEqual(["first", "other", "longer body", "first"]);
    const hashes = claim.mock.calls.map((call) => (call as unknown as [{ payloadHash: string }])[0].payloadHash);
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/u);
    // Same path and length: the token query parameter must not change (or reach) the fingerprint.
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(hashes[3]).not.toBe(hashes[0]);
    expect(JSON.stringify(claim.mock.calls)).not.toMatch(/first|other|longer body|secret-/u);
  });

  it("fingerprints a streamed chat attachment by its own query fields only", async () => {
    const claim = vi.fn(async () => ({ outcome: "claimed" as const, record: { claimToken: "claim" } }));
    const store = { claim, markCompleted: vi.fn(async () => true), markFailed: vi.fn(async () => true) };
    app = Fastify();
    app.decorateRequest("authActorId", "operator:test");
    await app.register(idempotencyHeaderPlugin, { mutationStore: store as never });
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
    app.post("/api/v1/chat/attachments", async (request) => {
      for await (const chunk of request.body as AsyncIterable<Buffer>) void chunk;
      return { ok: true };
    });
    const upload = (key: string, query: string) =>
      app!.inject({
        method: "POST",
        url: `/api/v1/chat/attachments?${query}`,
        headers: { "Idempotency-Key": key, "content-type": "application/octet-stream" },
        payload: "bytes",
      });

    await upload("att-1", "sessionId=s1&fileName=a.png&mimeType=image%2Fpng&access_token=secret-a");
    await upload("att-2", "sessionId=s1&fileName=a.png&mimeType=image%2Fpng&access_token=secret-b");
    await upload("att-3", "sessionId=s1&fileName=b.png&mimeType=image%2Fpng");
    await upload("att-4", "sessionId=s2&fileName=a.png&mimeType=image%2Fpng");

    const hashes = claim.mock.calls.map((call) => (call as unknown as [{ payloadHash: string }])[0].payloadHash);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(hashes[3]).not.toBe(hashes[0]);
    expect(JSON.stringify(claim.mock.calls)).not.toMatch(/secret-/u);
  });
});
