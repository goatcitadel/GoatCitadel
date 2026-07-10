import { randomUUID } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";

export class ChatTurnWriteConflictError extends ConflictError {
  constructor(message: string) {
    super({ code: "STATE_CONFLICT", message });
  }
}

export class ChatTurnStreamRegistrationMismatchError extends ConflictError {
  public readonly turnId: string;
  public readonly registrationId: string;

  constructor(turnId: string, registrationId: string) {
    super({
      code: "STATE_CONFLICT",
      message: `Chat turn stream registration ${registrationId} is no longer active for turn ${turnId}.`,
    });
    this.turnId = turnId;
    this.registrationId = registrationId;
  }
}

export interface ActiveChatTurnExecution {
  sessionId: string;
  turnId: string;
  operation: string;
  startedAt: string;
  controller: AbortController;
}

interface ActiveChatTurnStreamState {
  readonly registrationId: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  startedAt: string;
  nextSequence: number;
  completed: boolean;
}

/**
 * Immutable producer capability for one exact stream registration.
 *
 * The bound methods deliberately keep registration identity inside the
 * registry. Producers can fence writes and finalization without asking a broad
 * Gateway host which registration happens to be current.
 */
export interface ActiveChatTurnStreamExecution {
  readonly registrationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly startedAt: string;
  readonly nextSequence: number;
  readonly completed: boolean;
  isActive(): boolean;
  requireActive(targetTurnId?: string): void;
  claimNextSequence(targetTurnId?: string): number;
  complete(): boolean;
  close(): boolean;
}

export class ChatTurnExecutionRegistry {
  private readonly activeWriteLeases = new Map<string, string>();
  private readonly activeExecutions = new Map<string, ActiveChatTurnExecution>();
  private readonly activeStreams = new Map<
    string,
    { state: ActiveChatTurnStreamState; lease: ActiveChatTurnStreamExecution }
  >();

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

  /**
   * Whether any chat turn is currently mid-execution across all sessions. Used
   * as a workspace-wide idle signal so background janitors (e.g. the S3 curator
   * idle sweep) never run while a turn is in flight.
   */
  public hasAnyActiveChatTurnExecution(): boolean {
    return this.activeExecutions.size > 0;
  }

  public isCancellationRequested(turnId: string): boolean {
    return this.activeExecutions.get(turnId)?.controller.signal.aborted ?? false;
  }

  public registerActiveStream(
    sessionId: string,
    turnId: string,
    latestSequence: number,
    runId?: string,
    options?: { onClose?: () => void },
  ): ActiveChatTurnStreamExecution {
    const state: ActiveChatTurnStreamState = {
      registrationId: randomUUID(),
      sessionId,
      turnId,
      runId,
      startedAt: new Date().toISOString(),
      nextSequence: latestSequence + 1,
      completed: false,
    };
    const requireActive = (targetTurnId = turnId): ActiveChatTurnStreamState => {
      if (targetTurnId !== turnId) {
        throw new ChatTurnStreamRegistrationMismatchError(targetTurnId, state.registrationId);
      }
      const active = this.activeStreams.get(turnId);
      if (!active || active.state !== state || state.completed) {
        throw new ChatTurnStreamRegistrationMismatchError(turnId, state.registrationId);
      }
      return state;
    };
    const lease = Object.freeze({
      registrationId: state.registrationId,
      sessionId: state.sessionId,
      turnId: state.turnId,
      runId: state.runId,
      startedAt: state.startedAt,
      get nextSequence(): number {
        return state.nextSequence;
      },
      get completed(): boolean {
        return state.completed;
      },
      isActive: (): boolean => {
        const active = this.activeStreams.get(turnId);
        return active?.state === state && !state.completed;
      },
      requireActive: (targetTurnId?: string): void => {
        requireActive(targetTurnId);
      },
      claimNextSequence: (targetTurnId?: string): number => {
        const active = requireActive(targetTurnId);
        const sequence = active.nextSequence;
        active.nextSequence += 1;
        return sequence;
      },
      complete: (): boolean => this.completeActiveStream(turnId, state.registrationId),
      close: (): boolean => {
        const closed = this.closeActiveStream(turnId, state.registrationId);
        if (closed) {
          options?.onClose?.();
        }
        return closed;
      },
    }) satisfies ActiveChatTurnStreamExecution;
    this.activeStreams.set(turnId, { state, lease });
    return lease;
  }

  public completeActiveStream(turnId: string, registrationId: string): boolean {
    const active = this.activeStreams.get(turnId);
    if (!active || active.state.registrationId !== registrationId) {
      return false;
    }
    active.state.completed = true;
    return true;
  }

  public requireActiveStreamRegistration(turnId: string, registrationId: string): ActiveChatTurnStreamExecution {
    const active = this.activeStreams.get(turnId);
    if (!active || active.state.completed || active.state.registrationId !== registrationId) {
      throw new ChatTurnStreamRegistrationMismatchError(turnId, registrationId);
    }
    return active.lease;
  }

  public closeActiveStream(turnId: string, registrationId: string): boolean {
    const active = this.activeStreams.get(turnId);
    if (!active || active.state.registrationId !== registrationId) {
      return false;
    }
    this.activeStreams.delete(turnId);
    return true;
  }

  public getActiveStream(turnId: string): ActiveChatTurnStreamExecution | undefined {
    return this.activeStreams.get(turnId)?.lease;
  }

  public listActiveStreamsForSession(sessionId: string): ActiveChatTurnStreamExecution[] {
    return [...this.activeStreams.values()]
      .map(({ lease }) => lease)
      .filter((stream) => stream.sessionId === sessionId && !stream.completed);
  }

  public close(reason = "Chat turn execution registry closed."): void {
    for (const execution of this.activeExecutions.values()) {
      if (!execution.controller.signal.aborted) {
        execution.controller.abort(new Error(reason));
      }
    }
    this.activeExecutions.clear();
    this.activeStreams.clear();
    this.activeWriteLeases.clear();
  }
}
