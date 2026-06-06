import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PersonalOpsInMemoryRepository } from "../../../../packages/storage/src/personal-ops-repo.js";
import { PersonalOpsService } from "../services/personal-ops-service.js";
import { createPersonalOpsRouteService } from "../services/personal-ops-route-service.js";
import { personalOpsRoutes } from "./personal-ops.js";

describe("personal ops routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists, updates, and archives notes by workspace", async () => {
    app = await buildApp();

    const alphaCreate = await app.inject({
      method: "POST",
      url: "/api/v1/notes",
      payload: {
        workspaceId: "alpha",
        title: "  First note  ",
        body: "  body  ",
        tags: ["ops", "ops", ""],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/notes",
      payload: {
        workspaceId: "beta",
        title: "Beta note",
      },
    });

    expect(alphaCreate.statusCode).toBe(201);
    const alphaNote = alphaCreate.json();
    expect(alphaNote.title).toBe("First note");
    expect(alphaNote.tags).toEqual(["ops"]);

    const alphaList = await app.inject({ method: "GET", url: "/api/v1/notes?workspaceId=alpha" });
    expect(alphaList.json().items.map((item: { noteId: string }) => item.noteId)).toEqual([alphaNote.noteId]);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/notes/${encodeURIComponent(alphaNote.noteId)}`,
      payload: {
        workspaceId: "alpha",
        title: "Updated note",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().title).toBe("Updated note");

    const archive = await app.inject({
      method: "POST",
      url: `/api/v1/notes/${encodeURIComponent(alphaNote.noteId)}/archive`,
      payload: { workspaceId: "alpha" },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().lifecycleStatus).toBe("archived");

    const active = await app.inject({ method: "GET", url: "/api/v1/notes?workspaceId=alpha" });
    expect(active.json().items).toEqual([]);

    const archived = await app.inject({
      method: "GET",
      url: "/api/v1/notes?workspaceId=alpha&lifecycleStatus=archived",
    });
    expect(archived.json().items.map((item: { noteId: string }) => item.noteId)).toEqual([alphaNote.noteId]);
  });

  it("lists and completes reminders by workspace", async () => {
    app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/reminders",
      payload: {
        workspaceId: "alpha",
        title: "Review notes",
        dueAt: "2026-06-06T12:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/reminders",
      payload: {
        workspaceId: "beta",
        title: "Beta reminder",
        dueAt: "2026-06-07T12:00:00.000Z",
      },
    });

    expect(created.statusCode).toBe(201);
    const reminder = created.json();
    const alphaList = await app.inject({ method: "GET", url: "/api/v1/reminders?workspaceId=alpha" });
    expect(alphaList.json().items.map((item: { reminderId: string }) => item.reminderId)).toEqual([
      reminder.reminderId,
    ]);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/reminders/${encodeURIComponent(reminder.reminderId)}/complete`,
      payload: { workspaceId: "alpha" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");

    const scheduled = await app.inject({ method: "GET", url: "/api/v1/reminders?workspaceId=alpha" });
    expect(scheduled.json().items).toEqual([]);

    const completedList = await app.inject({
      method: "GET",
      url: "/api/v1/reminders?workspaceId=alpha&status=completed",
    });
    expect(completedList.json().items.map((item: { reminderId: string }) => item.reminderId)).toEqual([
      reminder.reminderId,
    ]);
  });

  it("rejects malformed note and reminder input before delegation", async () => {
    const createNote = vi.fn();
    const createReminder = vi.fn();
    app = Fastify();
    app.decorate("services", { personalOps: { createNote, createReminder } } as never);
    await app.register(personalOpsRoutes);

    const badNote = await app.inject({
      method: "POST",
      url: "/api/v1/notes",
      payload: { title: "" },
    });
    const badReminder = await app.inject({
      method: "POST",
      url: "/api/v1/reminders",
      payload: { title: "Bad due date", dueAt: "tomorrow" },
    });

    expect(badNote.statusCode).toBe(400);
    expect(badReminder.statusCode).toBe(400);
    expect(createNote).not.toHaveBeenCalled();
    expect(createReminder).not.toHaveBeenCalled();
  });
});

async function buildApp(): Promise<FastifyInstance> {
  const built = Fastify();
  const service = new PersonalOpsService(new PersonalOpsInMemoryRepository());
  built.decorate("services", { personalOps: createPersonalOpsRouteService(service) } as never);
  await built.register(personalOpsRoutes);
  return built;
}
