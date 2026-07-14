import {
  NotFoundError,
  normalizeOpsSavedBoardCreateInput,
  normalizeOpsSavedBoardStatusInput,
  normalizeOpsSavedBoardUpdateInput,
  type OpsSavedBoardCreateInput,
  type OpsSavedBoardRecord,
  type OpsSavedBoardStatusInput,
  type OpsSavedBoardUpdateInput,
} from "@goatcitadel/contracts";

export interface OpsSavedBoardRepositoryPort {
  listByWorkspace(workspaceId: string, includeArchived?: boolean): OpsSavedBoardRecord[];
  get(workspaceId: string, boardId: string): OpsSavedBoardRecord;
  createWithOutcome(
    input: OpsSavedBoardCreateInput,
    actorId: string,
  ): { record: OpsSavedBoardRecord; inserted: boolean };
  update(boardId: string, input: OpsSavedBoardUpdateInput, actorId: string): OpsSavedBoardRecord;
  archive(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): OpsSavedBoardRecord;
  restore(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): OpsSavedBoardRecord;
}

export interface OpsSavedBoardWorkspacePort {
  get(workspaceId: string): { workspaceId: string };
}

export interface OpsSavedBoardServiceStoragePort {
  opsSavedBoards: OpsSavedBoardRepositoryPort;
  workspaces: OpsSavedBoardWorkspacePort;
}

export type OpsSavedBoardChangeOperation = "archive" | "create" | "restore" | "update";

export interface OpsSavedBoardChangeSignal {
  workspaceId: string;
  boardId: string;
  revision: number;
  epoch: string;
  operation: OpsSavedBoardChangeOperation;
}

export interface OpsSavedBoardServiceOptions {
  realtimeEpoch: string;
  publishChange(signal: OpsSavedBoardChangeSignal): void | PromiseLike<void>;
  reportPublicationFailure(error: unknown, signal: OpsSavedBoardChangeSignal): void | PromiseLike<void>;
}

/**
 * Gateway owner for saved Ops board workspace and actor boundaries.
 *
 * The repository remains the authority for idempotency, the board cap, and
 * revision CAS. This layer proves the exact workspace before every repository
 * operation and ensures a foreign-workspace lookup is indistinguishable from
 * a missing board.
 */
export class OpsSavedBoardService {
  private readonly realtimeEpoch: string;

  public constructor(
    private readonly storage: OpsSavedBoardServiceStoragePort,
    private readonly options: OpsSavedBoardServiceOptions,
  ) {
    this.realtimeEpoch = normalizeIdentifier(options.realtimeEpoch, "realtimeEpoch");
    if (typeof options.publishChange !== "function" || typeof options.reportPublicationFailure !== "function") {
      throw new TypeError("Ops saved board post-commit publication ports are required.");
    }
  }

  public list(workspaceId: string, includeArchived = false): OpsSavedBoardRecord[] {
    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    this.requireWorkspace(normalizedWorkspaceId);
    return this.storage.opsSavedBoards.listByWorkspace(normalizedWorkspaceId, includeArchived);
  }

  public get(workspaceId: string, boardId: string): OpsSavedBoardRecord {
    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    this.requireWorkspace(normalizedWorkspaceId, normalizedBoardId);
    return this.runBoardScoped(normalizedBoardId, () =>
      this.storage.opsSavedBoards.get(normalizedWorkspaceId, normalizedBoardId),
    );
  }

  public create(input: OpsSavedBoardCreateInput, actorId: string): OpsSavedBoardRecord {
    const normalized = normalizeOpsSavedBoardCreateInput(input);
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    this.requireWorkspace(normalized.workspaceId);
    const outcome = this.storage.opsSavedBoards.createWithOutcome(normalized, normalizedActorId);
    if (outcome.inserted) this.publishChange("create", outcome.record);
    return outcome.record;
  }

  public update(boardId: string, input: OpsSavedBoardUpdateInput, actorId: string): OpsSavedBoardRecord {
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const normalized = normalizeOpsSavedBoardUpdateInput(input);
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    this.requireWorkspace(normalized.workspaceId, normalizedBoardId);
    const record = this.runBoardScoped(normalizedBoardId, () =>
      this.storage.opsSavedBoards.update(normalizedBoardId, normalized, normalizedActorId),
    );
    this.publishChange("update", record);
    return record;
  }

  public archive(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): OpsSavedBoardRecord {
    return this.transition("archive", boardId, input, actorId);
  }

  public restore(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): OpsSavedBoardRecord {
    return this.transition("restore", boardId, input, actorId);
  }

  private transition(
    operation: "archive" | "restore",
    boardId: string,
    input: OpsSavedBoardStatusInput,
    actorId: string,
  ): OpsSavedBoardRecord {
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const normalized = normalizeOpsSavedBoardStatusInput(input);
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    this.requireWorkspace(normalized.workspaceId, normalizedBoardId);
    const record = this.runBoardScoped(normalizedBoardId, () =>
      this.storage.opsSavedBoards[operation](normalizedBoardId, normalized, normalizedActorId),
    );
    this.publishChange(operation, record);
    return record;
  }

  private publishChange(operation: OpsSavedBoardChangeOperation, record: OpsSavedBoardRecord): void {
    const signal: OpsSavedBoardChangeSignal = Object.freeze({
      workspaceId: record.workspaceId,
      boardId: record.boardId,
      revision: record.revision,
      epoch: this.realtimeEpoch,
      operation,
    });
    try {
      const result = this.options.publishChange(signal);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error: unknown) => this.reportPublicationFailure(error, signal));
      }
    } catch (error) {
      this.reportPublicationFailure(error, signal);
    }
  }

  private reportPublicationFailure(error: unknown, signal: OpsSavedBoardChangeSignal): void {
    try {
      const result = this.options.reportPublicationFailure(error, signal);
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // The canonical board mutation already committed. Diagnostics cannot
      // turn it into a reported write failure or trigger mutation replay.
    }
  }

  private requireWorkspace(workspaceId: string, boardId?: string): void {
    try {
      const workspace = this.storage.workspaces.get(workspaceId);
      if (!workspace || workspace.workspaceId !== workspaceId) {
        throw new NotFoundError({ entity: "Workspace", id: workspaceId });
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw boardId ? boardNotFound(boardId) : error;
      }
      throw error;
    }
  }

  private runBoardScoped<T>(boardId: string, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof NotFoundError) throw boardNotFound(boardId);
      throw error;
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function boardNotFound(boardId: string): NotFoundError {
  return new NotFoundError({ entity: "Ops saved board", id: boardId });
}

function normalizeIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    [...value].length < 1 ||
    [...value].length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Ops saved board ${field} is not a canonical identifier.`);
  }
  return value;
}
