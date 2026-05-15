import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { docsRoutes } from "./docs.js";

describe("docs routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("serves the OpenAPI document used by the docs viewer", async () => {
    app = Fastify();
    await app.register(docsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/docs/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      openapi: "3.1.0",
      info: {
        title: "GoatCitadel Gateway API",
        version: "1.0.0",
      },
      servers: [
        {
          url: "http://127.0.0.1:8787",
          description: "Local gateway",
        },
      ],
      paths: {
        "/api/v1/chat/sessions": {
          get: { summary: "List chat sessions" },
          post: { summary: "Create chat session" },
        },
        "/api/v1/chat/sessions/{sessionId}/agent-send/stream": {
          post: {
            summary: "Send chat message with streamed branch-aware response",
          },
        },
        "/api/v1/admin/backups/restore": {
          post: {
            responses: {
              "409": {
                description: "Offline restore required while the gateway is serving",
              },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
          basicAuth: {
            type: "http",
            scheme: "basic",
          },
        },
      },
      security: [{ bearerAuth: [] }, { basicAuth: [] }],
    });
  });

  it("serves the Scalar docs shell with the local OpenAPI spec URL", async () => {
    app = Fastify();
    await app.register(docsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/docs",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html; charset=utf-8");
    expect(response.body).toContain("<title>GoatCitadel API Docs</title>");
    expect(response.body).toContain('spec-url="/api/v1/docs/openapi.json"');
    expect(response.body).toContain("<scalar-api-reference");
  });
});
