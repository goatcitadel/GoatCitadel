import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { registerChatArtifactRenderRoutes } from "./chat.artifact-render.js";

const renderResponse = {
  artifactId: "artifact-1",
  contentHash: "a".repeat(64),
  renders: [
    {
      artifactId: "artifact-1",
      contentHash: "a".repeat(64),
      viewport: "desktop",
      attachmentId: "att-1",
      sha256: "b".repeat(64),
      width: 1440,
      height: 900,
      createdAt: "2026-10-12T10:00:00.000Z",
    },
  ],
};

function buildApp(chatArtifactRenders: Record<string, unknown>): FastifyInstance {
  const app = Fastify();
  app.decorate("services", { chatArtifactRenders } as never);
  registerChatArtifactRenderRoutes(app);
  return app;
}

describe("chat artifact render routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("validates the workspace, renders html artifacts, and lists stored renders", async () => {
    const service = {
      renderChatGeneratedArtifact: vi.fn(async () => renderResponse),
      listChatArtifactRenders: vi.fn(async () => renderResponse),
    };
    app = buildApp(service);

    const missingWorkspace = await app.inject({
      method: "POST",
      url: "/api/v1/chat/generated-artifacts/artifact-1/renders",
      payload: {},
    });
    expect(missingWorkspace.statusCode).toBe(400);
    expect(service.renderChatGeneratedArtifact).not.toHaveBeenCalled();

    const rendered = await app.inject({
      method: "POST",
      url: "/api/v1/chat/generated-artifacts/artifact-1/renders",
      payload: { workspaceId: "default" },
    });
    expect(rendered.statusCode).toBe(201);
    expect(rendered.json()).toEqual(renderResponse);
    expect(service.renderChatGeneratedArtifact).toHaveBeenCalledWith("artifact-1", "default");

    const listedWithoutWorkspace = await app.inject({
      method: "GET",
      url: "/api/v1/chat/generated-artifacts/artifact-1/renders",
    });
    expect(listedWithoutWorkspace.statusCode).toBe(400);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/chat/generated-artifacts/artifact-1/renders?workspaceId=default",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(renderResponse);
    expect(listed.headers["cache-control"]).toContain("no-store");
    expect(service.listChatArtifactRenders).toHaveBeenCalledWith("artifact-1", "default");
  });

  it("accepts a critique request and returns the dispatched turn", async () => {
    const critique = {
      sessionId: "sess-1",
      turnId: "turn-critique",
      visuallyInspected: true,
      renders: renderResponse.renders,
    };
    const service = {
      renderChatGeneratedArtifact: vi.fn(),
      listChatArtifactRenders: vi.fn(),
      critiqueChatGeneratedArtifact: vi.fn(async () => critique),
    };
    app = buildApp(service);
    app.decorateRequest("authActorId", "operator-1");
    app.decorateRequest("authActorSource", "token");

    const missingWorkspace = await app.inject({
      method: "POST",
      url: "/api/v1/chat/generated-artifacts/artifact-1/critique",
      payload: {},
    });
    expect(missingWorkspace.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/chat/generated-artifacts/artifact-1/critique",
      payload: { workspaceId: "default" },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual(critique);
    expect(service.critiqueChatGeneratedArtifact).toHaveBeenCalledWith(
      "artifact-1",
      "default",
      { operatorId: "operator-1", authActorId: "operator-1", authActorSource: "token" },
      expect.anything(),
    );
  });

  it("maps a non-html artifact to a 409 conflict", async () => {
    app = buildApp({
      renderChatGeneratedArtifact: vi.fn(async () => {
        throw new ConflictError({ message: "Only html artifacts can be rendered." });
      }),
      listChatArtifactRenders: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/generated-artifacts/artifact-1/renders",
      payload: { workspaceId: "default" },
    });
    expect(response.statusCode).toBe(409);
  });
});
