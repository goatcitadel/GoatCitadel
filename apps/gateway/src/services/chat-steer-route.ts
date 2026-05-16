import type {
  ChatSteerRequest,
  ChatSteerResponse,
  ChatGoalRequest,
  ChatGoalStatusResponse,
} from "@goatcitadel/contracts";
import type { ChatSteerService } from "./chat-steer-service.js";

export interface ChatSessionMetaSlice {
  ensure(sessionId: string): {
    pinnedGoal?: string;
    goalTurnBudget?: number;
    goalTurnsUsed: number;
    goalSetAt?: string;
  };
  patch(
    sessionId: string,
    patch: {
      pinnedGoal?: string | null;
      goalTurnBudget?: number | null;
      goalSetAt?: string | null;
    },
  ): {
    pinnedGoal?: string;
    goalTurnBudget?: number;
    goalTurnsUsed: number;
    goalSetAt?: string;
  };
}

export async function handleChatSteerRequest(input: {
  sessionId: string;
  body: ChatSteerRequest;
  steerService: ChatSteerService;
}): Promise<ChatSteerResponse> {
  const instruction = input.body.instruction?.trim();
  if (!instruction) {
    return {
      sessionId: input.sessionId,
      turnId: "",
      accepted: false,
      reason: "instruction is required.",
    };
  }
  return input.steerService.enqueue({ sessionId: input.sessionId, instruction });
}

export async function handleChatGoalSetRequest(input: {
  sessionId: string;
  body: ChatGoalRequest;
  chatSessionMeta: ChatSessionMetaSlice;
  now?: () => string;
}): Promise<ChatGoalStatusResponse> {
  const goal = input.body.goal?.trim();
  if (!goal) {
    throw new Error("goal is required.");
  }
  const setAt = (input.now ?? (() => new Date().toISOString()))();
  const patched = input.chatSessionMeta.patch(input.sessionId, {
    pinnedGoal: goal,
    goalTurnBudget: input.body.turnBudget ?? null,
    goalSetAt: setAt,
  });
  return {
    sessionId: input.sessionId,
    goal: patched.pinnedGoal ?? null,
    turnBudget: patched.goalTurnBudget ?? null,
    turnsUsed: patched.goalTurnsUsed,
    setAt: patched.goalSetAt ?? null,
  };
}

export async function handleChatGoalClearRequest(input: {
  sessionId: string;
  chatSessionMeta: ChatSessionMetaSlice;
}): Promise<ChatGoalStatusResponse> {
  const cleared = input.chatSessionMeta.patch(input.sessionId, {
    pinnedGoal: null,
    goalTurnBudget: null,
    goalSetAt: null,
  });
  return {
    sessionId: input.sessionId,
    goal: cleared.pinnedGoal ?? null,
    turnBudget: cleared.goalTurnBudget ?? null,
    turnsUsed: cleared.goalTurnsUsed,
    setAt: cleared.goalSetAt ?? null,
  };
}

export async function handleChatGoalStatusRequest(input: {
  sessionId: string;
  chatSessionMeta: ChatSessionMetaSlice;
}): Promise<ChatGoalStatusResponse> {
  const current = input.chatSessionMeta.ensure(input.sessionId);
  return {
    sessionId: input.sessionId,
    goal: current.pinnedGoal ?? null,
    turnBudget: current.goalTurnBudget ?? null,
    turnsUsed: current.goalTurnsUsed,
    setAt: current.goalSetAt ?? null,
  };
}
