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
  listNotes(input?: PersonalOpsNoteListInput): NoteRecord[] | Promise<NoteRecord[]>;
  createNote(input: NoteMutationInput): NoteRecord | Promise<NoteRecord>;
  listNoteRevisions(
    noteId: string,
    access?: PersonalOpsWorkspaceAccess,
  ): NoteRevisionRecord[] | Promise<NoteRevisionRecord[]>;
  updateNote(
    noteId: string,
    input: Partial<NoteMutationInput> & { expectedRevision?: number; actorId?: string },
    access?: PersonalOpsWorkspaceAccess,
  ): NoteRecord | Promise<NoteRecord>;
  archiveNote(noteId: string, access?: PersonalOpsWorkspaceAccess): NoteRecord | Promise<NoteRecord>;
  listReminders(input?: PersonalOpsReminderListInput): ReminderRecord[] | Promise<ReminderRecord[]>;
  createReminder(input: ReminderMutationInput): ReminderRecord | Promise<ReminderRecord>;
  completeReminder(reminderId: string, access?: PersonalOpsWorkspaceAccess): ReminderRecord | Promise<ReminderRecord>;
}

export class PersonalOpsService {
  public constructor(private readonly repository: PersonalOpsRepositoryPort) {}

  public async listNotes(input: PersonalOpsNoteListInput = {}): Promise<{ items: NoteRecord[] }> {
    return {
      items: await this.repository.listNotes({
        workspaceId: input.workspaceId,
        lifecycleStatus: input.lifecycleStatus ?? "active",
      }),
    };
  }

  public async createNote(input: NoteMutationInput, access: PersonalOpsWorkspaceAccess = {}): Promise<NoteRecord> {
    return await this.repository.createNote({
      ...input,
      workspaceId: input.workspaceId ?? access.workspaceId,
    });
  }

  public async updateNote(
    noteId: string,
    input: Partial<NoteMutationInput> & { expectedRevision?: number; actorId?: string },
    access: PersonalOpsWorkspaceAccess = {},
  ): Promise<NoteRecord> {
    const scopedWorkspaceId = input.workspaceId ?? access.workspaceId;
    const { workspaceId: _workspaceId, ...patch } = input;
    return await this.repository.updateNote(noteId, patch, { workspaceId: scopedWorkspaceId });
  }

  public async listNoteRevisions(
    noteId: string,
    access: PersonalOpsWorkspaceAccess = {},
  ): Promise<{ items: NoteRevisionRecord[] }> {
    return { items: await this.repository.listNoteRevisions(noteId, access) };
  }

  public async archiveNote(noteId: string, access: PersonalOpsWorkspaceAccess = {}): Promise<NoteRecord> {
    return await this.repository.archiveNote(noteId, access);
  }

  public async listReminders(input: PersonalOpsReminderListInput = {}): Promise<{ items: ReminderRecord[] }> {
    return {
      items: await this.repository.listReminders({
        workspaceId: input.workspaceId,
        status: input.status ?? "scheduled",
      }),
    };
  }

  public async createReminder(
    input: ReminderMutationInput,
    access: PersonalOpsWorkspaceAccess = {},
  ): Promise<ReminderRecord> {
    return await this.repository.createReminder({
      ...input,
      workspaceId: input.workspaceId ?? access.workspaceId,
    });
  }

  public async completeReminder(reminderId: string, access: PersonalOpsWorkspaceAccess = {}): Promise<ReminderRecord> {
    return await this.repository.completeReminder(reminderId, access);
  }
}
