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
  listByWorkspace(workspaceId: string, includeArchived?: boolean): Promise<OpsSavedBoardRecord[]>;
  get(workspaceId: string, boardId: string): Promise<OpsSavedBoardRecord>;
  createWithOutcome(
    input: OpsSavedBoardCreateInput,
    actorId: string,
  ): Promise<{ record: OpsSavedBoardRecord; inserted: boolean }>;
  update(boardId: string, input: OpsSavedBoardUpdateInput, actorId: string): Promise<OpsSavedBoardRecord>;
  archive(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): Promise<OpsSavedBoardRecord>;
  restore(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): Promise<OpsSavedBoardRecord>;
}

export interface OpsSavedBoardWorkspacePort {
  get(workspaceId: string): Promise<{ workspaceId: string }>;
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

  public async list(workspaceId: string, includeArchived = false): Promise<OpsSavedBoardRecord[]> {
    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    await this.requireWorkspace(normalizedWorkspaceId);
    return await this.storage.opsSavedBoards.listByWorkspace(normalizedWorkspaceId, includeArchived);
  }

  public async get(workspaceId: string, boardId: string): Promise<OpsSavedBoardRecord> {
    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    await this.requireWorkspace(normalizedWorkspaceId, normalizedBoardId);
    return await this.runBoardScoped(normalizedBoardId, () =>
      this.storage.opsSavedBoards.get(normalizedWorkspaceId, normalizedBoardId),
    );
  }

  public async create(input: OpsSavedBoardCreateInput, actorId: string): Promise<OpsSavedBoardRecord> {
    const normalized = normalizeOpsSavedBoardCreateInput(input);
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    await this.requireWorkspace(normalized.workspaceId);
    const outcome = await this.storage.opsSavedBoards.createWithOutcome(normalized, normalizedActorId);
    if (outcome.inserted) await this.publishChange("create", outcome.record);
    return outcome.record;
  }

  public async update(boardId: string, input: OpsSavedBoardUpdateInput, actorId: string): Promise<OpsSavedBoardRecord> {
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const normalized = normalizeOpsSavedBoardUpdateInput(input);
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    await this.requireWorkspace(normalized.workspaceId, normalizedBoardId);
    const record = await this.runBoardScoped(normalizedBoardId, () =>
      this.storage.opsSavedBoards.update(normalizedBoardId, normalized, normalizedActorId),
    );
    await this.publishChange("update", record);
    return record;
  }

  public async archive(
    boardId: string,
    input: OpsSavedBoardStatusInput,
    actorId: string,
  ): Promise<OpsSavedBoardRecord> {
    return await this.transition("archive", boardId, input, actorId);
  }

  public async restore(
    boardId: string,
    input: OpsSavedBoardStatusInput,
    actorId: string,
  ): Promise<OpsSavedBoardRecord> {
    return await this.transition("restore", boardId, input, actorId);
  }

  private async transition(
    operation: "archive" | "restore",
    boardId: string,
    input: OpsSavedBoardStatusInput,
    actorId: string,
  ): Promise<OpsSavedBoardRecord> {
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const normalized = normalizeOpsSavedBoardStatusInput(input);
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    await this.requireWorkspace(normalized.workspaceId, normalizedBoardId);
    const record = await this.runBoardScoped(normalizedBoardId, () =>
      this.storage.opsSavedBoards[operation](normalizedBoardId, normalized, normalizedActorId),
    );
    await this.publishChange(operation, record);
    return record;
  }

  private async publishChange(operation: OpsSavedBoardChangeOperation, record: OpsSavedBoardRecord): Promise<void> {
    const signal: OpsSavedBoardChangeSignal = Object.freeze({
      workspaceId: record.workspaceId,
      boardId: record.boardId,
      revision: record.revision,
      epoch: this.realtimeEpoch,
      operation,
    });
    try {
      await this.options.publishChange(signal);
    } catch (error) {
      await this.reportPublicationFailure(error, signal);
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

  private async requireWorkspace(workspaceId: string, boardId?: string): Promise<void> {
    try {
      const workspace = await this.storage.workspaces.get(workspaceId);
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

  private async runBoardScoped<T>(boardId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
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
