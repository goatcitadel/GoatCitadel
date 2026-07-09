import type { ChatMode } from "@goatcitadel/contracts";
import type { RuntimeDecisionTraceRepository } from "@goatcitadel/storage";
import type { SurfaceClassification, SurfaceHeuristicContext } from "./surface-router-heuristics.js";
import { classifySurfaceHeuristic } from "./surface-router-heuristics.js";
import type { SurfaceRouteOverrideExemplar } from "./improvement-service.js";

export interface SurfaceRouteRequest {
  prompt: string;
  citadelId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  context: SurfaceHeuristicContext;
}

export interface SurfaceJudgeInput {
  prompt: string;
  citadelId: string;
  priors: SurfaceRouteOverrideExemplar[];
}

export interface SurfaceJudgeResult {
  mode: ChatMode;
  confidence: number;
}

export interface SurfaceRouterServiceDeps {
  classify?: (prompt: string, ctx: SurfaceHeuristicContext) => SurfaceClassification;
  traceRepo: Pick<RuntimeDecisionTraceRepository, "append">;
  judge?: (input: SurfaceJudgeInput) => Promise<SurfaceJudgeResult | undefined>;
  fetchExemplars?: (citadelId: string) => SurfaceRouteOverrideExemplar[];
  judgeThreshold?: number;
}

export class SurfaceRouterService {
  private readonly classify: NonNullable<SurfaceRouterServiceDeps["classify"]>;
  private readonly traceRepo: SurfaceRouterServiceDeps["traceRepo"];
  private readonly judge: SurfaceRouterServiceDeps["judge"];
  private readonly fetchExemplars: SurfaceRouterServiceDeps["fetchExemplars"];
  private readonly judgeThreshold: number;

  constructor(deps: SurfaceRouterServiceDeps) {
    this.classify = deps.classify ?? classifySurfaceHeuristic;
    this.traceRepo = deps.traceRepo;
    this.judge = deps.judge;
    this.fetchExemplars = deps.fetchExemplars;
    this.judgeThreshold = deps.judgeThreshold ?? 0.7;
  }

  public async route(request: SurfaceRouteRequest): Promise<SurfaceClassification> {
    let result = this.classify(request.prompt, request.context);
    if (result.confidence < this.judgeThreshold && this.judge) {
      const priors = this.fetchExemplars ? this.fetchExemplars(request.citadelId) : [];
      const judged = await this.judge({ prompt: request.prompt, citadelId: request.citadelId, priors });
      if (judged) {
        result = {
          mode: "chat",
          confidence: judged.confidence,
          source: "judge",
          rationale: `llm-judge normalized to chat-only surface (heuristic was low-confidence: ${result.confidence.toFixed(2)})`,
          alternatives: [],
        };
      }
    }
    result = {
      ...result,
      mode: "chat",
      alternatives: [],
    };
    this.traceRepo.append({
      kind: "routing_choice",
      scope: {
        citadelId: request.citadelId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        turnId: request.turnId,
      },
      selected: result.mode,
      rationale: `${result.rationale} (source=${result.source}, confidence=${result.confidence.toFixed(2)})`,
      alternatives: result.alternatives.map((mode) => ({
        label: mode,
        outcome: "not_chosen" as const,
        reasonNotChosen: `lower-confidence alternative to ${result.mode}`,
      })),
    });
    return result;
  }
}
