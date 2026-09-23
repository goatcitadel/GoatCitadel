import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  type ChatDelegateRequest,
  type ChatDelegateResponse,
  type ChatUserInputPromptRecord,
  type ChatTurnTraceRecord,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import type { ChatDelegationRunOptions } from "./chat-delegation-service.js";
import {
  assertChatTurnToolUseOpen,
  CHAT_TURN_CONTROL_KEY,
  readChatTurnControl,
  updateChatTurnControl,
  type ChatTurnControl,
} from "./chat-turn-control.js";

export const CONFIRMED_DELEGATION_WORKFLOW = "chat.confirmed-delegation.v1";
export const CONFIRMED_DELEGATION_WAKE_EVENT = "chat.confirmed_delegation.resolved";

export interface ConfirmedDelegationProposal {
  promptId: string;
  bindingHash: string;
  objective: string;
  roles: string[];
  declined?: boolean;
}

export interface ConfirmedDelegationHost {
  storage: Storage;
  runDelegation(
    sessionId: string,
    request: ChatDelegateRequest,
    options: ChatDelegationRunOptions,
  ): Promise<ChatDelegateResponse>;
}

export type ConfirmedDelegationResult =
  | { prompt: ChatUserInputPromptRecord }
  | { result: ChatDelegateResponse; waiting: boolean; proposalId: string };

/** A projection alone cannot authorize recovery of a parked delegation. */
export async function hasConfirmedDelegationWaitingEvidence(
  storage: Pick<Storage, "chatDelegationRuns">,
  run: DurableRunRecord,
  trace: ChatTurnTraceRecord,
): Promise<boolean> {
  const link = trace.routing?.confirmedDelegation;
  const wait = run.metadata?.waitForEvent as { eventKey?: unknown; correlationId?: unknown } | undefined;
  const proposal = (run.metadata?.[CHAT_TURN_CONTROL_KEY] as ChatTurnControl | undefined)?.delegationProposal;
  if (
    trace.status !== "waiting_for_tool" ||
    link?.waiting !== true ||
    run.workflowKey !== "chat.turn.execute" ||
    run.payload.version !== "chat.turn.execute.v2" ||
    trace.durable?.runId !== run.runId ||
    run.payload.sessionId !== trace.sessionId ||
    run.payload.turnId !== trace.turnId ||
    wait?.eventKey !== CONFIRMED_DELEGATION_WAKE_EVENT ||
    wait.correlationId !== link.runId ||
    !proposal ||
    proposal.declined ||
    proposal.promptId !== link.proposalId ||
    typeof proposal.bindingHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proposal.bindingHash) ||
    !Array.isArray(proposal.roles) ||
    !proposal.roles.length
  )
    return false;
  const answers = Array.isArray(run.payload.userInputResponses) ? run.payload.userInputResponses : [];
  const answer = answers.find((value) => value && typeof value === "object" && value.promptId === proposal.promptId);
  if (answer?.response?.kind !== "single_select" || answer.response.optionId !== "run_plan") return false;
  try {
    const delegation = await storage.chatDelegationRuns.get(link.runId);
    return (
      delegation.parentRunId === run.runId &&
      delegation.sessionId === trace.sessionId &&
      delegation.workflowTemplate === CONFIRMED_DELEGATION_WORKFLOW &&
      delegation.executionPlanId === proposal.promptId &&
      delegation.mode === "sequential" &&
      delegation.objective === proposal.objective &&
      canonicalJsonString(delegation.roles) === canonicalJsonString(proposal.roles)
    );
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

/** Called only inside the canonical wake transaction, after waiting authority verification. */
export async function resumeConfirmedDelegationWait(
  storage: Pick<Storage, "chatDelegationRuns" | "chatTurnTraces">,
  run: DurableRunRecord,
  event: { eventKey: string; correlationId?: string },
): Promise<void> {
  if (event.eventKey !== CONFIRMED_DELEGATION_WAKE_EVENT) return;
  if (run.status !== "waiting" || typeof run.payload.turnId !== "string")
    throw new ConflictError({ message: "Confirmed delegation is no longer waiting." });
  const trace = await storage.chatTurnTraces.get(run.payload.turnId);
  if (
    event.correlationId !== trace.routing?.confirmedDelegation?.runId ||
    !(await hasConfirmedDelegationWaitingEvidence(storage, run, trace))
  )
    throw new ConflictError({ message: "Confirmed delegation wake does not match its stored plan." });
  const resumed = await storage.chatTurnTraces.patchIfStatus(trace.turnId, ["waiting_for_tool"], {
    status: "queued",
    pendingUserInput: null,
    durable: { ...trace.durable!, status: "queued" },
  });
  if (!resumed) throw new ConflictError({ message: "Confirmed delegation wait changed before wake." });
}

/** A routing hint for this active turn, never permission to start a child. */
export function suggestActiveTurnDelegationRoles(content: string): string[] {
  const text = content.toLowerCase();
  if (
    /\b(?:no|without|avoid|never|do not|don't|don’t)\b[^.;!?\n]*\b(?:subagents?|agents?|delegat\w*|tools?)\b/u.test(
      text,
    ) ||
    /\b(?:answer directly|single run)\b/u.test(text)
  )
    return [];
  const explicit =
    /\b(?:use|start|run|spawn|ask|delegate(?: to)?)\b[^.;!?\n]*\b(?:subagents?|agents?|specialists?|qa|researcher|coder|reviewer)\b/u.test(
      text,
    );
  if (!explicit) {
    // A bounded hint for clearly separate work streams; ordinary questions do
    // not pay for an extra planning completion.
    if (text.length < 90) return [];
    const work = [
      [/\b(?:research|investigate|compare sources)\b/u, "researcher"],
      [/\b(?:implement|refactor|build the)\b/u, "coder"],
      [/\b(?:test|verify|qa)\b/u, "qa"],
      [/\b(?:review|audit)\b/u, "reviewer"],
    ] as const;
    const useful = work.filter(([pattern]) => pattern.test(text)).map(([, role]) => role);
    return useful.length >= 3 ? useful.slice(0, 3) : [];
  }
  const roles = [
    [/\b(?:qa|tester|testing specialist)\b/u, "qa"],
    [/\b(?:researcher|research agent)\b/u, "researcher"],
    [/\b(?:coder|coding agent|developer)\b/u, "coder"],
    [/\b(?:reviewer|review agent)\b/u, "reviewer"],
  ] as const;
  const selected = roles.filter(([pattern]) => pattern.test(text)).map(([, role]) => role);
  return selected.length ? selected.slice(0, 3) : ["researcher"];
}

function bindingHash(input: ChatTurnAgentRunnerInput): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        sessionId: input.sessionId,
        turnId: input.turnId,
        content: input.capabilityProfileContent ?? input.content,
        profileHash: input.capabilityProfile?.hashes.profileHash,
        providerId: input.providerId,
        model: input.model,
        subagentPolicy: input.subagentPolicy,
        permissionProfileId: input.permissionProfileId,
      }),
    )
    .digest("hex");
}

/** Reuses durable prompt response seals and the existing manual delegation aggregate. */
export async function resolveConfirmedDelegation(
  host: ConfirmedDelegationHost,
  input: ChatTurnAgentRunnerInput,
): Promise<ConfirmedDelegationResult | undefined> {
  const storage = host.storage;
  if (
    input.subagentPolicy !== "ask_when_useful" ||
    input.parentDelegationStepId ||
    input.normalizationProfile === "prompt_pack_harness"
  )
    return;
  const content = input.capabilityProfileContent ?? input.content;
  const control = await readChatTurnControl(storage, input.sessionId, input.turnId);
  let proposal = control.delegationProposal;
  if (proposal?.declined) return;
  const roles = proposal?.roles ?? suggestActiveTurnDelegationRoles(content);
  if (!roles.length) return;
  const trace = await storage.chatTurnTraces.get(input.turnId);
  if (!trace.durable?.runId || !input.capabilityProfile) return;
  const runId = trace.durable.runId;
  const expectedHash = bindingHash(input);
  if (!proposal) {
    const proposed: ConfirmedDelegationProposal = {
      promptId: randomUUID(),
      bindingHash: expectedHash,
      objective: content,
      roles,
    };
    const state = await updateChatTurnControl(storage, input.sessionId, input.turnId, (current) => ({
      ...current,
      delegationProposal: current.delegationProposal ?? proposed,
    }));
    proposal = state.delegationProposal!;
  }
  if (proposal.bindingHash !== expectedHash)
    throw new ConflictError({ message: "The delegation proposal no longer matches its admitted turn." });
  await assertChatTurnToolUseOpen(storage, input.sessionId, input.turnId);
  const run = await storage.durableRuns.getRun(runId);
  const answers = Array.isArray(run.payload.userInputResponses) ? run.payload.userInputResponses : [];
  const answer = answers.find((value) => value && typeof value === "object" && value.promptId === proposal!.promptId);
  if (!answer)
    return {
      prompt: {
        promptId: proposal.promptId,
        turnId: input.turnId,
        kind: "single_select",
        required: true,
        dismissible: false,
        title: "Delegate this task?",
        question: `Use ${proposal.roles.join(", ")} for this task?\n\n${proposal.objective.slice(0, 4000)}`,
        options: [
          {
            optionId: "run_plan",
            label: "Run this plan",
            description: "Start the listed specialists with the current permissions.",
          },
          {
            optionId: "answer_directly",
            label: "Answer directly",
            description: "Continue this turn without subagents.",
          },
        ],
      },
    };
  if (answer.response?.kind !== "single_select" || !["run_plan", "answer_directly"].includes(answer.response.optionId))
    throw new ConflictError({ message: "The delegation confirmation is invalid." });
  if (answer.response.optionId === "answer_directly") {
    await updateChatTurnControl(storage, input.sessionId, input.turnId, (current) => ({
      ...current,
      delegationProposal: { ...proposal!, declined: true },
    }));
    return;
  }
  const frozenProposal = proposal;
  const result = await host.runDelegation(
    input.sessionId,
    {
      objective: proposal.objective,
      roles: proposal.roles,
      mode: "sequential",
      providerId: input.providerId,
      model: input.model,
      steps: proposal.roles.map((role, index) => ({
        stepId: `confirmed-${index + 1}`,
        index,
        role,
        objective: proposal!.objective,
        label: role,
        parallelizable: false,
      })),
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
      policyRunId: runId,
      policyTaskId: input.policyTaskId,
      fullWebAccess: input.fullWebAccess,
    },
    {
      admittedProfile: input.capabilityProfile,
      abortSignal: input.signal,
      workflowTemplate: CONFIRMED_DELEGATION_WORKFLOW,
      executionPlanId: proposal.promptId,
      stableRunKey: proposal.promptId,
      requireChildWatchers: true,
      preDispatchGuard: async () => {
        await assertChatTurnToolUseOpen(storage, input.sessionId, input.turnId);
        const latest = await readChatTurnControl(storage, input.sessionId, input.turnId);
        if (latest.delegationProposal?.bindingHash !== frozenProposal.bindingHash || latest.delegationProposal.declined)
          throw new ConflictError({ message: "Delegation confirmation is no longer current." });
      },
    },
  );
  return {
    result,
    proposalId: proposal.promptId,
    waiting: result.steps.some((step) => step.status === "pending" || step.status === "running"),
  };
}

/** Resolve the parent's verified immutable profile using server-owned lineage. */
export async function readConfirmedDelegationParentProfile(storage: Storage, stepId?: string) {
  if (!stepId) return undefined;
  const step = await storage.chatDelegationSteps.get(stepId);
  const delegation = await storage.chatDelegationRuns.get(step.runId);
  if (delegation.workflowTemplate !== CONFIRMED_DELEGATION_WORKFLOW) return undefined;
  if (!delegation.parentRunId) throw new ConflictError({ message: "Confirmed delegation has no parent authority." });
  const profile = await storage.chatTurnCapabilityProfiles.findByRun(delegation.parentRunId);
  if (!profile || profile.identity.sessionId !== delegation.sessionId)
    throw new ConflictError({ message: "Confirmed delegation has no admitted capability profile." });
  const control = await readChatTurnControl(storage, profile.identity.sessionId, profile.identity.turnId);
  if (
    control.toolClosure ||
    !control.delegationProposal ||
    control.delegationProposal.promptId !== delegation.executionPlanId ||
    control.delegationProposal.declined
  )
    throw new ConflictError({ message: "Confirmed delegation authority is no longer current." });
  return profile;
}

/** A child can finish after its parent parked or its original observer exited. */
export async function reconcileConfirmedDelegationChild(
  host: {
    storage: Storage;
    materialize: import("./chat-delegation-service.js").ChatDelegationService["materializeTerminalDurableChild"];
    reconcileWaiting(runId: string): Promise<boolean>;
    wake(
      runId: string,
      event: { eventKey: string; correlationId: string; payload: Record<string, unknown> },
    ): Promise<unknown>;
  },
  input: {
    durableRunId: string;
    childSessionId: string;
    childTurnId: string;
    parentDelegationStepId: string;
    trace: import("@goatcitadel/contracts").ChatTurnTraceRecord;
    output?: string;
  },
): Promise<void> {
  if (!["completed", "failed", "partial", "cancelled"].includes(input.trace.status)) return;
  const storage = host.storage;
  const step = await storage.chatDelegationSteps.get(input.parentDelegationStepId);
  const delegation = await storage.chatDelegationRuns.get(step.runId);
  if (delegation.workflowTemplate !== CONFIRMED_DELEGATION_WORKFLOW || !delegation.parentRunId) return;
  const parent = await storage.durableRuns.getRun(delegation.parentRunId);
  if (typeof parent.payload.turnId !== "string" || parent.payload.sessionId !== delegation.sessionId) return;
  const control = await readChatTurnControl(storage, delegation.sessionId, parent.payload.turnId);
  if (control.delegationProposal?.promptId !== delegation.executionPlanId)
    throw new ConflictError({ message: "Delegation completion has a mismatched proposal." });
  const settled = await host.materialize({ ...input, delegationRunId: delegation.runId, stepId: step.stepId });
  if (settled.outcome === "rejected" || ["completed", "failed", "cancelled", "dead_lettered"].includes(parent.status))
    return;
  if (parent.status !== "waiting" || !(await host.reconcileWaiting(parent.runId))) return;
  await host.wake(parent.runId, {
    eventKey: CONFIRMED_DELEGATION_WAKE_EVENT,
    correlationId: delegation.runId,
    payload: { delegationRunId: delegation.runId, childTurnId: input.childTurnId },
  });
}

/** Catch up missed child completions after a park/commit race or process exit. */
export async function reconcileWaitingConfirmedDelegations(
  host: Parameters<typeof reconcileConfirmedDelegationChild>[0],
): Promise<void> {
  const storage = host.storage;
  const failures: unknown[] = [];
  for (const runId of await storage.durableRuns.listRunIdsByStatus("waiting")) {
    try {
      const parent = await storage.durableRuns.getRun(runId);
      const wait = parent.metadata?.waitForEvent as { eventKey?: string; correlationId?: string } | undefined;
      if (wait?.eventKey !== CONFIRMED_DELEGATION_WAKE_EVENT || !wait.correlationId) continue;
      const delegation = await storage.chatDelegationRuns.get(wait.correlationId);
      if (
        delegation.parentRunId !== runId ||
        delegation.workflowTemplate !== CONFIRMED_DELEGATION_WORKFLOW ||
        typeof parent.payload.turnId !== "string" ||
        parent.payload.sessionId !== delegation.sessionId
      )
        throw new ConflictError({ message: "Waiting delegation has a mismatched durable owner." });
      const control = await readChatTurnControl(storage, delegation.sessionId, parent.payload.turnId);
      if (control.delegationProposal?.promptId !== delegation.executionPlanId)
        throw new ConflictError({ message: "Waiting delegation has a mismatched plan." });
      for (const step of await storage.chatDelegationSteps.listByRun(delegation.runId)) {
        if (step.status !== "running" || !step.durableRunId || !step.childTurnId || !step.childSessionId) continue;
        const trace = await storage.chatTurnTraces.get(step.childTurnId);
        if (!["completed", "failed", "partial", "cancelled"].includes(trace.status)) continue;
        const message = trace.assistantMessageId ? await storage.chatMessages.get(trace.assistantMessageId) : undefined;
        await host.materialize({
          delegationRunId: delegation.runId,
          stepId: step.stepId,
          durableRunId: step.durableRunId,
          childSessionId: step.childSessionId,
          childTurnId: step.childTurnId,
          trace,
          output: message?.content,
        });
      }
      const steps = await storage.chatDelegationSteps.listByRun(delegation.runId);
      if (!control.toolClosure && steps.some((step) => step.status === "running")) continue;
      if (!(await host.reconcileWaiting(runId))) continue; // The next owner tick retries the same stored plan.
      await host.wake(runId, {
        eventKey: CONFIRMED_DELEGATION_WAKE_EVENT,
        correlationId: delegation.runId,
        payload: { delegationRunId: delegation.runId, recovered: true },
      });
    } catch (error) {
      // A corrupt or temporarily unavailable owner must not starve independent
      // waiting turns. Report failures after the remaining owners reconcile.
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Confirmed delegation recovery could not reconcile every waiting turn.");
}
