import type { RuntimeDecisionTraceRepository } from "@goatcitadel/storage";
import type { SurfaceClassification, SurfaceHeuristicContext } from "./surface-router-heuristics.js";
import { classifySurfaceHeuristic } from "./surface-router-heuristics.js";

export interface SurfaceRouteRequest {
  prompt: string;
  citadelId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  context: SurfaceHeuristicContext;
}

export interface SurfaceRouterServiceDeps {
  classify?: (prompt: string, ctx: SurfaceHeuristicContext) => SurfaceClassification;
  traceRepo: Pick<RuntimeDecisionTraceRepository, "append">;
}

export class SurfaceRouterService {
  private readonly classify: NonNullable<SurfaceRouterServiceDeps["classify"]>;
  private readonly traceRepo: SurfaceRouterServiceDeps["traceRepo"];

  constructor(deps: SurfaceRouterServiceDeps) {
    this.classify = deps.classify ?? classifySurfaceHeuristic;
    this.traceRepo = deps.traceRepo;
  }

  public route(request: SurfaceRouteRequest): SurfaceClassification {
    const result = this.classify(request.prompt, request.context);
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
