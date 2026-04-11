import type { FastifyPluginAsync } from "fastify";

export const docsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/docs/openapi.json", async (_request, reply) => {
    return reply.send(buildOpenApiSpec());
  });

  fastify.get("/api/v1/docs", async (_request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>GoatCitadel API Docs</title>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <style>
      body { margin: 0; background: #121212; color: #f4f4f4; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      .header { padding: 16px 20px; border-bottom: 1px solid #2f2f2f; }
      .header h1 { margin: 0; font-size: 18px; }
    </style>
  </head>
  <body>
    <div class="header"><h1>GoatCitadel API v1</h1></div>
    <scalar-api-reference
      theme="purple"
      spec-url="/api/v1/docs/openapi.json"
    ></scalar-api-reference>
  </body>
</html>`);
  });
};

function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "GoatCitadel Gateway API",
      version: "1.0.0",
      description: "Local-first control plane API for GoatCitadel Mission Control.",
    },
    servers: [
      {
        url: "http://127.0.0.1:8787",
        description: "Local gateway",
      },
    ],
    paths: {
      "/health": { get: { summary: "Health check", responses: { "200": { description: "ok" } } } },
      "/api/v1/events/stream": {
        get: { summary: "Realtime event stream (SSE)", responses: { "200": { description: "stream" } } },
      },
      "/api/v1/sessions": { get: { summary: "List sessions", responses: { "200": { description: "Session list" } } } },
      "/api/v1/chat/projects": {
        get: { summary: "List chat projects", responses: { "200": { description: "Project list" } } },
        post: { summary: "Create chat project", responses: { "201": { description: "Project created" } } },
      },
      "/api/v1/chat/sessions": {
        get: { summary: "List chat sessions", responses: { "200": { description: "Chat session list" } } },
        post: { summary: "Create chat session", responses: { "201": { description: "Chat session created" } } },
      },
      "/api/v1/chat/sessions/{sessionId}/messages": {
        get: { summary: "List chat messages", responses: { "200": { description: "Message list" } } },
      },
      "/api/v1/chat/sessions/{sessionId}/agent-send": {
        post: {
          summary: "Send chat message through the branch-aware agent path",
          responses: { "200": { description: "Message sent" } },
        },
      },
      "/api/v1/chat/sessions/{sessionId}/agent-send/stream": {
        post: {
          summary: "Send chat message with streamed branch-aware response",
          responses: { "200": { description: "SSE chunk stream" } },
        },
      },
      "/api/v1/chat/attachments": {
        post: { summary: "Upload chat attachment", responses: { "201": { description: "Attachment uploaded" } } },
      },
      "/api/v1/settings": {
        get: { summary: "Fetch runtime settings", responses: { "200": { description: "Current settings" } } },
        patch: { summary: "Update runtime settings", responses: { "200": { description: "Updated settings" } } },
      },
      "/api/v1/auth/plan": {
        get: {
          summary: "Inspect resolved gateway auth credential sources",
          responses: { "200": { description: "Auth credential plan" } },
        },
      },
      "/api/v1/auth/install-token": {
        post: {
          summary: "Resolve or generate the install token for token-mode gateways",
          responses: { "200": { description: "Install token resolution" } },
        },
      },
      "/api/v1/admin/retention": {
        get: { summary: "Get retention policy", responses: { "200": { description: "Retention policy" } } },
        patch: { summary: "Update retention policy", responses: { "200": { description: "Updated policy" } } },
      },
      "/api/v1/admin/retention/prune": {
        post: { summary: "Prune retention targets", responses: { "200": { description: "Prune result" } } },
      },
      "/api/v1/admin/backups": {
        get: { summary: "List backups", responses: { "200": { description: "Backup list" } } },
      },
      "/api/v1/admin/backups/create": {
        post: { summary: "Create backup", responses: { "201": { description: "Backup created" } } },
      },
      "/api/v1/admin/backups/restore": {
        post: {
          summary: "Restore backup (offline-only for filesystem runtimes)",
          responses: {
            "409": { description: "Offline restore required while the gateway is serving" },
          },
        },
      },
      "/api/v1/admin/backups/verify": {
        post: {
          summary: "Verify backup manifest/payload integrity and 1.0 minimum-set contract coverage",
          responses: { "200": { description: "Backup verification result" } },
        },
      },
      "/api/v1/tools/invoke": {
        post: { summary: "Invoke tool", responses: { "200": { description: "Tool result" } } },
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
  };
}
