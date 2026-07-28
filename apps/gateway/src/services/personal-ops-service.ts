import type {
  NoteMutationInput,
  NoteRecord,
  NoteRevisionRecord,
  ReminderMutationInput,
  ReminderRecord,
} from "@goatcitadel/contracts";

export interface PersonalOpsWorkspaceAccess {
  workspaceId?: string;
}

export interface PersonalOpsNoteListInput {
  workspaceId?: string;
  lifecycleStatus?: NoteRecord["lifecycleStatus"] | "all";
}

export interface PersonalOpsReminderListInput {
  workspaceId?: string;
  status?: ReminderRecord["status"] | "all";
}

export interface PersonalOpsRepositoryPort {
  listNotes(input?: PersonalOpsNoteListInput): NoteRecord[];
  createNote(input: NoteMutationInput): NoteRecord;
  listNoteRevisions(noteId: string, access?: PersonalOpsWorkspaceAccess): NoteRevisionRecord[];
  updateNote(
    noteId: string,
    input: Partial<NoteMutationInput> & { expectedRevision?: number; actorId?: string },
    access?: PersonalOpsWorkspaceAccess,
  ): NoteRecord;
  archiveNote(noteId: string, access?: PersonalOpsWorkspaceAccess): NoteRecord;
  listReminders(input?: PersonalOpsReminderListInput): ReminderRecord[];
  createReminder(input: ReminderMutationInput): ReminderRecord;
  completeReminder(reminderId: string, access?: PersonalOpsWorkspaceAccess): ReminderRecord;
}

export class PersonalOpsService {
  public constructor(private readonly repository: PersonalOpsRepositoryPort) {}

  public listNotes(input: PersonalOpsNoteListInput = {}): { items: NoteRecord[] } {
    return {
      items: this.repository.listNotes({
        workspaceId: input.workspaceId,
        lifecycleStatus: input.lifecycleStatus ?? "active",
      }),
    };
  }

  public createNote(input: NoteMutationInput, access: PersonalOpsWorkspaceAccess = {}): NoteRecord {
    return this.repository.createNote({
      ...input,
      workspaceId: input.workspaceId ?? access.workspaceId,
    });
  }

  public updateNote(
    noteId: string,
    input: Partial<NoteMutationInput> & { expectedRevision?: number; actorId?: string },
    access: PersonalOpsWorkspaceAccess = {},
  ): NoteRecord {
    const scopedWorkspaceId = input.workspaceId ?? access.workspaceId;
    const { workspaceId: _workspaceId, ...patch } = input;
    return this.repository.updateNote(noteId, patch, { workspaceId: scopedWorkspaceId });
  }

  public listNoteRevisions(noteId: string, access: PersonalOpsWorkspaceAccess = {}): { items: NoteRevisionRecord[] } {
    return { items: this.repository.listNoteRevisions(noteId, access) };
  }

  public archiveNote(noteId: string, access: PersonalOpsWorkspaceAccess = {}): NoteRecord {
    return this.repository.archiveNote(noteId, access);
  }

  public listReminders(input: PersonalOpsReminderListInput = {}): { items: ReminderRecord[] } {
    return {
      items: this.repository.listReminders({
        workspaceId: input.workspaceId,
        status: input.status ?? "scheduled",
      }),
    };
  }

  public createReminder(input: ReminderMutationInput, access: PersonalOpsWorkspaceAccess = {}): ReminderRecord {
    return this.repository.createReminder({
      ...input,
      workspaceId: input.workspaceId ?? access.workspaceId,
    });
  }

  public completeReminder(reminderId: string, access: PersonalOpsWorkspaceAccess = {}): ReminderRecord {
    return this.repository.completeReminder(reminderId, access);
  }
}
