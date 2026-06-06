import type {
  PersonalOpsNoteListInput,
  PersonalOpsReminderListInput,
  PersonalOpsService,
  PersonalOpsWorkspaceAccess,
} from "./personal-ops-service.js";

export type PersonalOpsRoutePort = Pick<
  PersonalOpsService,
  "archiveNote" | "completeReminder" | "createNote" | "createReminder" | "listNotes" | "listReminders" | "updateNote"
>;

export class PersonalOpsRouteService {
  public constructor(private readonly personalOps: PersonalOpsRoutePort) {}

  public listNotes(input: PersonalOpsNoteListInput) {
    return this.personalOps.listNotes(input);
  }

  public createNote(input: Parameters<PersonalOpsRoutePort["createNote"]>[0], access?: PersonalOpsWorkspaceAccess) {
    return this.personalOps.createNote(input, access);
  }

  public updateNote(
    noteId: string,
    input: Parameters<PersonalOpsRoutePort["updateNote"]>[1],
    access?: PersonalOpsWorkspaceAccess,
  ) {
    return this.personalOps.updateNote(noteId, input, access);
  }

  public archiveNote(noteId: string, access?: PersonalOpsWorkspaceAccess) {
    return this.personalOps.archiveNote(noteId, access);
  }

  public listReminders(input: PersonalOpsReminderListInput) {
    return this.personalOps.listReminders(input);
  }

  public createReminder(
    input: Parameters<PersonalOpsRoutePort["createReminder"]>[0],
    access?: PersonalOpsWorkspaceAccess,
  ) {
    return this.personalOps.createReminder(input, access);
  }

  public completeReminder(reminderId: string, access?: PersonalOpsWorkspaceAccess) {
    return this.personalOps.completeReminder(reminderId, access);
  }
}

export function createPersonalOpsRouteService(personalOps: PersonalOpsRoutePort): PersonalOpsRouteService {
  return new PersonalOpsRouteService(personalOps);
}
