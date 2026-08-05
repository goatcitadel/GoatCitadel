import { describe, expect, it } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import { PersonalOpsInMemoryRepository } from "../../../../packages/storage/src/personal-ops-repo.js";
import { PersonalOpsService } from "./personal-ops-service.js";

describe("PersonalOpsService", () => {
  it("uses access workspace as the default create scope", async () => {
    const service = new PersonalOpsService(new PersonalOpsInMemoryRepository());

    const note = await service.createNote({ title: "Operator note" }, { workspaceId: "ops" });
    const reminder = await service.createReminder(
      { title: "Operator reminder", dueAt: "2026-06-06T12:00:00.000Z" },
      { workspaceId: "ops" },
    );

    expect(note.workspaceId).toBe("ops");
    expect(reminder.workspaceId).toBe("ops");
    expect((await service.listNotes({ workspaceId: "ops" })).items.map((item) => item.noteId)).toEqual([note.noteId]);
    expect((await service.listReminders({ workspaceId: "ops" })).items.map((item) => item.reminderId)).toEqual([
      reminder.reminderId,
    ]);
  });

  it("treats update workspaceId as access scope instead of moving notes", async () => {
    const service = new PersonalOpsService(new PersonalOpsInMemoryRepository());
    const note = await service.createNote({ workspaceId: "ops", title: "Original" });

    const updated = await service.updateNote(note.noteId, { workspaceId: "ops", title: "Updated" });

    expect(updated.workspaceId).toBe("ops");
    expect(updated.title).toBe("Updated");
    await expect(service.updateNote(note.noteId, { workspaceId: "other", title: "Wrong scope" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("hides archived notes and completed reminders from default lists", async () => {
    const service = new PersonalOpsService(new PersonalOpsInMemoryRepository());
    const note = await service.createNote({ workspaceId: "ops", title: "Archive me" });
    const reminder = await service.createReminder({
      workspaceId: "ops",
      title: "Complete me",
      dueAt: "2026-06-06T12:00:00.000Z",
    });

    await service.archiveNote(note.noteId, { workspaceId: "ops" });
    await service.completeReminder(reminder.reminderId, { workspaceId: "ops" });

    expect((await service.listNotes({ workspaceId: "ops" })).items).toEqual([]);
    expect((await service.listNotes({ workspaceId: "ops", lifecycleStatus: "archived" })).items[0]?.noteId).toBe(
      note.noteId,
    );
    expect((await service.listReminders({ workspaceId: "ops" })).items).toEqual([]);
    expect((await service.listReminders({ workspaceId: "ops", status: "completed" })).items[0]?.reminderId).toBe(
      reminder.reminderId,
    );
  });
});
