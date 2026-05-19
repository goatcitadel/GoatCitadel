import { randomUUID } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";

export class ChatTurnWriteConflictError extends ConflictError {
  constructor(message: string) {
    super({ code: "STATE_CONFLICT", message });
  }
}

export interface ActiveChatTurnExecution {
  sessionId: string;
  turnId: string;
  operation: string;
  startedAt: string;
  controller: AbortController;
}

export interface ActiveChatTurnStreamExecution {
  sessionId: string;
  turnId: string;
  runId?: string;
  startedAt: string;
  nextSequence: number;
  completed: boolean;
}

export class ChatTurnExecutionRegistry {
  private readonly activeWriteLeases = new Map<string, string>();
  private readonly activeExecutions = new Map<string, ActiveChatTurnExecution>();
  private readonly activeStreams = new Map<string, ActiveChatTurnStreamExecution>();

  public acquireWriteLease(sessionId: string, operation: string): string {
    const existing = this.activeWriteLeases.get(sessionId);
    if (existing) {
      throw new ChatTurnWriteConflictError(
        `A chat turn write is already in progress for session ${sessionId}. Wait for the current ${existing} to finish and retry.`,
      );
    }
    const leaseToken = `${operation}:${randomUUID()}`;
    this.activeWriteLeases.set(sessionId, operation);
    return leaseToken;
  }

  public releaseWriteLease(sessionId: string, leaseToken: string): void {
    const expectedOperation = leaseToken.split(":", 1)[0];
    if (this.activeWriteLeases.get(sessionId) === expectedOperation) {
      this.activeWriteLeases.delete(sessionId);
    }
  }

  public clearSessionWriteLease(sessionId: string): void {
    this.activeWriteLeases.delete(sessionId);
  }

  public async withWriteLease<T>(sessionId: string, operation: string, work: () => Promise<T>): Promise<T> {
    const leaseToken = this.acquireWriteLease(sessionId, operation);
    try {
      return await work();
    } finally {
      this.releaseWriteLease(sessionId, leaseToken);
    }
  }

  public async *withWriteLeaseStream<T>(
    sessionId: string,
    operation: string,
    work: () => AsyncGenerator<T>,
  ): AsyncGenerator<T> {
    const leaseToken = this.acquireWriteLease(sessionId, operation);
    try {
      yield* work();
    } finally {
      this.releaseWriteLease(sessionId, leaseToken);
    }
  }

  public beginActiveExecution(sessionId: string, turnId: string, operation: string): AbortController {
    const controller = new AbortController();
    this.activeExecutions.set(turnId, {
      sessionId,
      turnId,
      operation,
      startedAt: new Date().toISOString(),
      controller,
    });
    return controller;
  }

  public endActiveExecution(turnId: string, controller: AbortController): void {
    const active = this.activeExecutions.get(turnId);
    if (!active || active.controller !== controller) {
      return;
    }
    this.activeExecutions.delete(turnId);
  }

  public getActiveExecution(turnId: string): ActiveChatTurnExecution | undefined {
    return this.activeExecutions.get(turnId);
  }

  public isCancellationRequested(turnId: string): boolean {
    return this.activeExecutions.get(turnId)?.controller.signal.aborted ?? false;
  }

  public registerActiveStream(
    sessionId: string,
    turnId: string,
    latestSequence: number,
    runId?: string,
  ): ActiveChatTurnStreamExecution {
    const state: ActiveChatTurnStreamExecution = {
      sessionId,
      turnId,
      runId,
      startedAt: new Date().toISOString(),
      nextSequence: latestSequence + 1,
      completed: false,
    };
    this.activeStreams.set(turnId, state);
    return state;
  }

  public completeActiveStream(turnId: string): void {
    const active = this.activeStreams.get(turnId);
    if (!active) {
      return;
    }
    active.completed = true;
  }

  public closeActiveStream(turnId: string): void {
    this.activeStreams.delete(turnId);
  }

  public getActiveStream(turnId: string): ActiveChatTurnStreamExecution | undefined {
    return this.activeStreams.get(turnId);
  }

  public listActiveStreamsForSession(sessionId: string): ActiveChatTurnStreamExecution[] {
    return [...this.activeStreams.values()].filter((stream) => stream.sessionId === sessionId && !stream.completed);
  }
}
