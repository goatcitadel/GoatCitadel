import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installEmptyBodyTolerantJsonParser } from "./empty-json-body-parser.js";

describe("empty-body tolerant JSON parser", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function buildProbeApp() {
    app = Fastify();
    installEmptyBodyTolerantJsonParser(app);
    app.post("/probe", async (request) => ({ received: request.body ?? null }));
    return app;
  }

  it("accepts a body-less POST that still carries an application/json content-type", async () => {
    const probe = buildProbeApp();

    const response = await probe.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: null });
  });

  it("treats a whitespace-only JSON body as empty", async () => {
    const probe = buildProbeApp();

    const response = await probe.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
      payload: "  \n ",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: null });
  });

  it("still parses non-empty JSON payloads", async () => {
    const probe = buildProbeApp();

    const response = await probe.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ kind: "company" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: { kind: "company" } });
  });

  it("still rejects malformed JSON with a 400", async () => {
    const probe = buildProbeApp();

    const response = await probe.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
  });

  it("still rejects prototype-poisoning payloads like Fastify's default parser", async () => {
    const probe = buildProbeApp();

    const protoResponse = await probe.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
      payload: '{"__proto__": {"polluted": true}}',
    });
    const constructorResponse = await probe.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
      payload: '{"constructor": {"prototype": {"polluted": true}}}',
    });

    expect(protoResponse.statusCode).toBe(400);
    expect(constructorResponse.statusCode).toBe(400);
  });
});
