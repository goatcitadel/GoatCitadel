import type { ChatSteerResponse } from "@goatcitadel/contracts";

export interface ChatSteerQueuedInstruction {
  instruction: string;
  enqueuedAt: string;
}

interface ActiveTurnState {
  turnId: string;
  queue: ChatSteerQueuedInstruction[];
}

export class ChatSteerService {
  private readonly perSession = new Map<string, ActiveTurnState>();

  public registerActiveTurn(input: { sessionId: string; turnId: string }): void {
    this.perSession.set(input.sessionId, { turnId: input.turnId, queue: [] });
  }

  public unregisterActiveTurn(input: { sessionId: string; turnId: string }): void {
    const current = this.perSession.get(input.sessionId);
    if (current && current.turnId === input.turnId) {
      this.perSession.delete(input.sessionId);
    }
  }

  public enqueue(input: { sessionId: string; instruction: string }): ChatSteerResponse {
    const state = this.perSession.get(input.sessionId);
    if (!state) {
      return {
        sessionId: input.sessionId,
        turnId: "",
        accepted: false,
        reason: "No active turn to steer.",
      };
    }
    state.queue.push({ instruction: input.instruction, enqueuedAt: new Date().toISOString() });
    return {
      sessionId: input.sessionId,
      turnId: state.turnId,
      accepted: true,
    };
  }

  public drainPending(input: { sessionId: string; turnId: string }): ChatSteerQueuedInstruction[] {
    const state = this.perSession.get(input.sessionId);
    if (!state || state.turnId !== input.turnId) {
      return [];
    }
    const drained = state.queue;
    state.queue = [];
    return drained;
  }
}
