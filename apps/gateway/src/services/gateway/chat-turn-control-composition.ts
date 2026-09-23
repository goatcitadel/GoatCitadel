import { ConflictError, type ToolInvokeRequest } from "@goatcitadel/contracts";
import {
  readConfirmedDelegationParentProfile,
  reconcileConfirmedDelegationChild,
  reconcileWaitingConfirmedDelegations,
  resolveConfirmedDelegation,
  type ConfirmedDelegationHost,
} from "../chat-confirmed-delegation-service.js";
import type { ChatTurnAgentRunnerInput } from "../chat-turn-agent-runner.js";
import { assertChatTurnToolUseOpen } from "../chat-turn-control.js";
import { preserveCancelledChatTurnOutput } from "../chat-turn-interruption-recovery-service.js";

type DelegationReconciliationHost = Parameters<typeof reconcileConfirmedDelegationChild>[0];

/** Gateway collaborators behind a Chat turn's tool-use closure and confirmed delegation. */
export interface ChatTurnControlCompositionHost
  extends ConfirmedDelegationHost, Omit<DelegationReconciliationHost, "storage"> {
  captureCancelledOutput(sessionId: string, turnId: string): Parameters<typeof preserveCancelledChatTurnOutput>[3];
  rejectPendingChatTurnApprovals(sessionId: string, turnId: string, actorId: string): Promise<void>;
}

/**
 * One owner for the turn-control and confirmed-delegation wiring the Gateway hands to its turn runtime,
 * durable runs, fan-out and tool coordinator, so each binding is composed once.
 */
export function composeChatTurnControl(host: ChatTurnControlCompositionHost) {
  const { storage } = host;
  return {
    resolveConfirmedDelegation: (input: ChatTurnAgentRunnerInput) => resolveConfirmedDelegation(host, input),
    reconcileWaitingDelegations: () => reconcileWaitingConfirmedDelegations(host),
    reconcileDelegationChild: (input: Parameters<typeof reconcileConfirmedDelegationChild>[1]) =>
      reconcileConfirmedDelegationChild(host, input),
    readParentProfile: (stepId?: string) => readConfirmedDelegationParentProfile(storage, stepId),
    assertToolDispatchAllowed: (request: ToolInvokeRequest) =>
      assertChatTurnToolUseOpen(storage, request.sessionId, request.turnId),
    assertParentToolUseOpen: async (parentRunId: string, sessionId: string) => {
      const parent = await storage.durableRuns.getRun(parentRunId);
      if (parent.payload.sessionId !== sessionId || typeof parent.payload.turnId !== "string") {
        throw new ConflictError({ message: "Automatic fan-out has a mismatched parent turn." });
      }
      await assertChatTurnToolUseOpen(storage, sessionId, parent.payload.turnId);
    },
    onChatTurnCancelled: async (sessionId: string, turnId: string, actorId: string) => {
      const outputSnapshot = host.captureCancelledOutput(sessionId, turnId);
      await host.rejectPendingChatTurnApprovals(sessionId, turnId, actorId);
      await preserveCancelledChatTurnOutput(storage, sessionId, turnId, outputSnapshot);
    },
  };
}

export type ChatTurnControlComposition = ReturnType<typeof composeChatTurnControl>;
