import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { scriptsRoutes } from "./scripts.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function fixture() {
  const item = {
    id: "a".repeat(64),
    workspaceId: "one",
    kind: "generated",
    sourceId: "artifact",
    retention: "permanent",
    retentionVersion: 0,
  };
  const services = {
    scripts: {
      list: vi.fn(async (workspace: string) => ({ items: workspace === "one" ? [item] : [] })),
      update: vi.fn(async () => item),
    },
    chatSessions: {
      getChatGeneratedArtifact: vi.fn(async () => ({ content: "Fixture source" })),
      downloadManagedProjectFile: vi.fn(async () => ({ bytes: Buffer.from("managed source") })),
    },
    chatTools: { getChatToolArtifactContent: vi.fn(async () => ({ content: "tool source" })) },
    capabilities: { getCodeModeRunArtifactPreview: vi.fn(async () => ({ content: "verified source" })) },
    files: {
      downloadWorkspaceFile: vi.fn(async () => ({ isText: true, content: "workspace source", truncated: true })),
    },
  };
  const app = Fastify();
  apps.push(app);
  app.decorate("services", services as never);
  app.addHook("onRequest", async (request) => {
    request.authActorId = "operator";
    request.authActorSource = "loopback";
  });
  app.register(scriptsRoutes);
  return { app, services, item };
}
it("requires a direct local operator, validates scope, and never reads foreign artifact content", async () => {
  const { app, services, item } = fixture();
  const remote = await app.inject({ url: "/api/v1/scripts?workspaceId=one", remoteAddress: "192.0.2.1" });
  expect(remote.statusCode).toBe(403);
  const forwarded = await app.inject({
    url: "/api/v1/scripts?workspaceId=one",
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  expect(forwarded.statusCode).toBe(403);
  expect((await app.inject({ url: "/api/v1/scripts" })).statusCode).toBe(400);
  const foreign = await app.inject({ url: `/api/v1/scripts/${item.id}/preview?workspaceId=other` });
  expect(foreign.statusCode).toBe(404);
  expect(services.chatSessions.getChatGeneratedArtifact).not.toHaveBeenCalled();
  const allowed = await app.inject({ url: `/api/v1/scripts/${item.id}/preview?workspaceId=one` });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().content).toBe("Fixture source");
  expect(allowed.headers["cache-control"]).toBe("no-store");
  expect(services.chatSessions.getChatGeneratedArtifact).toHaveBeenCalledWith("artifact", { workspaceId: "one" });
});
it("validates retention versions and binds the authenticated actor", async () => {
  const { app, services, item } = fixture();
  const input = { workspaceId: "one", id: item.id, retention: "temporary", expectedVersion: 0 };
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/v1/scripts/retention",
        payload: { ...input, expectedVersion: -1 },
      })
    ).statusCode,
  ).toBe(400);
  expect(services.scripts.update).not.toHaveBeenCalled();
  const response = await app.inject({ method: "PATCH", url: "/api/v1/scripts/retention", payload: input });
  expect(response.statusCode).toBe(200);
  expect(services.scripts.update).toHaveBeenCalledWith(input, "operator");
});
it("dispatches previews through scoped file, tool and hash-verifying Code Mode readers", async () => {
  const { app, services, item } = fixture();
  const preview = () => app.inject({ url: `/api/v1/scripts/${item.id}/preview?workspaceId=one` });
  Object.assign(item, { kind: "managed", sessionId: "session", path: "run.ts", revision: "revision" });
  expect((await preview()).json().content).toBe("managed source");
  expect(services.chatSessions.downloadManagedProjectFile).toHaveBeenCalledWith("session", "operator", {
    path: "run.ts",
    revisionId: "revision",
  });
  item.kind = "tool";
  expect((await preview()).json().content).toBe("tool source");
  expect(services.chatTools.getChatToolArtifactContent).toHaveBeenCalledWith("artifact", { workspaceId: "one" });
  Object.assign(item, { kind: "code", runId: "run" });
  expect((await preview()).json().content).toBe("verified source");
  expect(services.capabilities.getCodeModeRunArtifactPreview).toHaveBeenCalledWith("run", "source", {
    workspaceId: "one",
  });
  item.kind = "workspace";
  expect((await preview()).json()).toEqual({ content: "workspace source", truncated: true });
  expect(services.files.downloadWorkspaceFile).toHaveBeenCalledWith("run.ts", { maxBytes: 65536, readPrefix: true });
  Object.assign(item, { kind: "managed", sessionId: undefined });
  expect((await preview()).statusCode).toBe(409);
});
