import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { registerChatSessionRoutes } from "./chat.sessions.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const url = "/api/v1/chat/sessions/session/workbench/file";

describe("Workbench path action preconditions", () => {
  it("offers review without applying and rejects unreviewed actions", async () => {
    app = Fastify();
    const preview = vi.fn().mockResolvedValue({ revision: "a".repeat(64), affectedPaths: [] });
    const apply = vi.fn();
    app.decorate("services", { chatSessions: { previewChatSessionWorkbenchFileOperation: preview, runChatSessionWorkbenchFileOperation: apply } });
    registerChatSessionRoutes(app);
    const actionUrl = `${url}-operation`;
    const input = { operation: "delete", path: "folder" };
    expect((await app.inject({ method: "POST", url: `${actionUrl}/preview`, payload: input })).statusCode).toBe(200);
    expect(preview).toHaveBeenCalledWith("session", input);
    for (const expectedRevision of [undefined, null, "", "wrong", 0]) {
      expect((await app.inject({ method: "POST", url: actionUrl, payload: { ...input, expectedRevision } })).statusCode).toBe(400);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it("forwards the exact review and preserves commit truth and safe errors", async () => {
    app = Fastify();
    const apply = vi.fn().mockResolvedValueOnce({ operation: "delete", path: "folder" })
      .mockRejectedValueOnce(new ConflictError({ code: "WRITE_CONFLICT", message: "Review the file action again.", details: { reason: "WORKBENCH_PATH_REVISION_CONFLICT" } }))
      .mockRejectedValueOnce(Object.assign(new Error("private filesystem failure"), { mutationCommitted: true }));
    app.decorate("services", { chatSessions: { runChatSessionWorkbenchFileOperation: apply } });
    registerChatSessionRoutes(app);
    const committed: boolean[] = [];
    app.addHook("onResponse", async (request) => { committed.push(request.mutationCommitted === true); });
    const payload = { operation: "delete", path: "folder", expectedRevision: "a".repeat(64) };
    const input = { method: "POST" as const, url: `${url}-operation`, payload };
    expect((await app.inject(input)).statusCode).toBe(200);
    expect(apply).toHaveBeenLastCalledWith("session", payload);
    const conflict = await app.inject(input);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ details: { reason: "WORKBENCH_PATH_REVISION_CONFLICT" } });
    const uncertain = await app.inject(input);
    expect(uncertain.statusCode).toBe(500);
    expect(uncertain.body).not.toContain("private filesystem");
    expect(committed).toEqual([true, false, true]);
  });
});

function fixture(save = vi.fn().mockResolvedValue({ path: "file.txt", content: "saved", revision: "b".repeat(64) })) {
  app = Fastify();
  app.decorate("services", { chatSessions: { saveChatSessionWorkbenchFile: save } });
  registerChatSessionRoutes(app);
  return { server: app, save };
}

describe("Workbench save preconditions", () => {
  it("rejects missing or malformed revisions before invoking the file owner", async () => {
    const { server, save } = fixture();
    for (const expectedRevision of [undefined, "", "not-a-revision", 0]) {
      const response = await server.inject({ method: "PUT", url, payload: { path: "file.txt", content: "unguarded", expectedRevision } });
      expect(response.statusCode).toBe(400);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("forwards the reviewed revision or explicit absence and marks successful writes committed", async () => {
    const { server, save } = fixture();
    let committed = false;
    server.addHook("onResponse", async (request) => { committed = request.mutationCommitted; });
    for (const expectedRevision of ["a".repeat(64), null]) {
      const input = { path: "file.txt", content: "saved", expectedRevision };
      expect((await server.inject({ method: "PUT", url, payload: input })).statusCode).toBe(200);
      expect(save).toHaveBeenLastCalledWith("session", input);
      expect(committed).toBe(true);
    }
  });

  it("returns 409 for stale saves and retains committed truth on ambiguous post-write failure", async () => {
    const save = vi.fn().mockRejectedValueOnce(new ConflictError({ code: "WRITE_CONFLICT", message: "Review the latest file.",
      details: { reason: "WORKBENCH_FILE_REVISION_CONFLICT" } }))
      .mockRejectedValueOnce(Object.assign(new Error("private filesystem details"), { mutationCommitted: true }));
    const { server } = fixture(save);
    const committed: boolean[] = [];
    server.addHook("onResponse", async (request) => { committed.push(request.mutationCommitted === true); });
    const input = { method: "PUT" as const, url, payload: { path: "file.txt", content: "saved", expectedRevision: "a".repeat(64) } };
    const stale = await server.inject(input);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "WORKBENCH_FILE_REVISION_CONFLICT" } });
    const uncertain = await server.inject(input);
    expect(uncertain.statusCode).toBe(500);
    expect(uncertain.body).not.toContain("private filesystem");
    expect(committed).toEqual([false, true]);
  });
});
