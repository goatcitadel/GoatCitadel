import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  readChatDelegationResultSchema,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatDelegationResultSchema,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";

type Input = Pick<
  ChatTurnAgentRunnerInput,
  | "parentDelegationStepId"
  | "policyRunId"
  | "canonicalDurableRunId"
  | "sessionId"
  | "turnId"
  | "workspaceId"
  | "canonicalWriteFence"
>;
type Storage = Pick<AsyncStorage, "chatDelegationSteps" | "durableRuns">;
export interface AdmittedDelegatedResultContract {
  schema: ChatDelegationResultSchema;
  schemaSha256: string;
  stepId: string;
  runId: string;
}

export async function resolveAdmittedDelegatedResultContract(
  storage: Storage,
  input: Input,
): Promise<AdmittedDelegatedResultContract | undefined> {
  if (!input.parentDelegationStepId) return undefined;
  const step = await storage.chatDelegationSteps.get(input.parentDelegationStepId);
  if (step.instructionSnapshot?.resultSchema === undefined) return undefined;
  if (!input.canonicalWriteFence || !input.policyRunId || !step.durableRunId)
    throw new Error("Structured child results require current durable admission.");
  const schema = readChatDelegationResultSchema(step.instructionSnapshot.resultSchema);
  const schemaSha256 = createHash("sha256").update(canonicalJsonString(schema)).digest("hex");
  const contract = { schema, schemaSha256, stepId: step.stepId, runId: step.durableRunId };
  await input.canonicalWriteFence(async () => {
    await assertCurrent(storage, input, contract);
    if (await storage.durableRuns.getLatestCheckpointByKind(contract.runId, "delegated_result_correction")) {
      throw new Error(
        "The child result correction was already consumed. Review the incomplete child instead of replaying its correction.",
      );
    }
  });
  return contract;
}

/** A deterministic durable claim is committed before correction dispatch. */
export async function claimDelegatedResultCorrection(
  storage: Storage,
  input: Input,
  contract: AdmittedDelegatedResultContract,
): Promise<void> {
  if (!input.canonicalWriteFence) throw new Error("Structured child results lost current durable admission.");
  await input.canonicalWriteFence(async () => {
    await assertCurrent(storage, input, contract);
    if (await storage.durableRuns.getLatestCheckpointByKind(contract.runId, "delegated_result_correction")) {
      throw new Error("The child result correction was already consumed.");
    }
    await storage.durableRuns.createCheckpoint({
      checkpointId: `delegated-result-correction:${contract.runId}`,
      runId: contract.runId,
      checkpointKind: "delegated_result_correction",
      state: {
        version: 1,
        stepId: contract.stepId,
        turnId: input.turnId,
        schemaSha256: contract.schemaSha256,
        consumed: true,
      },
    });
  });
}

async function assertCurrent(storage: Storage, input: Input, contract: AdmittedDelegatedResultContract): Promise<void> {
  const [step, run] = await Promise.all([
    storage.chatDelegationSteps.get(contract.stepId),
    storage.durableRuns.getRun(contract.runId),
  ]);
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey,
    durableRunId: run.runId,
    payload: run.payload,
  });
  if (
    step.status !== "running" ||
    step.runId !== input.policyRunId ||
    step.childSessionId !== input.sessionId ||
    step.childTurnId !== input.turnId ||
    step.durableRunId !== contract.runId ||
    run.status !== "running" ||
    !authority ||
    authority.sessionId !== input.sessionId ||
    (input.canonicalDurableRunId !== undefined && input.canonicalDurableRunId !== contract.runId) ||
    authority.turnId !== input.turnId ||
    authority.workspaceId !== input.workspaceId ||
    authority.request.parentDelegationStepId !== contract.stepId ||
    authority.request.policyRunId !== input.policyRunId ||
    canonicalJsonString(step.instructionSnapshot?.resultSchema) !== canonicalJsonString(contract.schema)
  ) {
    throw new Error("Structured child result contract no longer matches its canonical child binding.");
  }
}
