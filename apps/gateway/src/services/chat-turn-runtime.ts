import type { TurnRuntime, TurnRuntimeRequest, TurnRuntimeResult } from "@goatcitadel/orchestration";
import {
  ChatAgentOrchestrator,
  type ChatAgentOrchestratorDeps,
} from "./chat-agent-orchestrator.js";

export class GatewayTurnRuntime implements TurnRuntime {
  private readonly orchestrator: ChatAgentOrchestrator;

  public constructor(deps: ChatAgentOrchestratorDeps) {
    this.orchestrator = new ChatAgentOrchestrator(deps);
  }

  public run(input: TurnRuntimeRequest): Promise<TurnRuntimeResult> {
    return this.orchestrator.run(input);
  }

  public async *runStream(input: TurnRuntimeRequest) {
    yield* this.orchestrator.runStream(input);
  }
}
