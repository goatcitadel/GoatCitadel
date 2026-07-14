import type { TurnRuntime, TurnRuntimeRequest, TurnRuntimeResult } from "@goatcitadel/orchestration";
import {
  ChatTurnAgentRunner,
  type ChatTurnAgentRunnerDeps,
  type ChatTurnAgentRunnerInput,
  type ResolvedChatTurnToolSchema,
} from "./chat-turn-agent-runner.js";

export class GatewayTurnRuntime implements TurnRuntime {
  private readonly orchestrator: ChatTurnAgentRunner;

  public constructor(deps: ChatTurnAgentRunnerDeps) {
    this.orchestrator = new ChatTurnAgentRunner(deps);
  }

  public run(input: TurnRuntimeRequest): Promise<TurnRuntimeResult> {
    return this.orchestrator.run(input);
  }

  public async *runStream(input: TurnRuntimeRequest) {
    yield* this.orchestrator.runStream(input);
  }

  public resolveCapabilityToolSchema(input: ChatTurnAgentRunnerInput): Promise<ResolvedChatTurnToolSchema> {
    return this.orchestrator.resolveCapabilityToolSchema(input);
  }
}
