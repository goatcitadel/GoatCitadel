import type { GatewayService } from "./gateway-service.js";

type MemoryRouteGateway = Pick<
  GatewayService,
  | "acceptMemoryMaintenanceRecommendation"
  | "composeMemoryContext"
  | "forgetMemory"
  | "forgetMemoryItem"
  | "getMemoryContext"
  | "getMemoryMaintenancePolicy"
  | "getMemoryMaintenanceRunProvenance"
  | "getMemoryMaintenanceStatus"
  | "getMemoryQmdStats"
  | "listMemoryItemHistory"
  | "listMemoryItems"
  | "listMemoryMaintenanceRecommendations"
  | "listMemoryMaintenanceRuns"
  | "listRecentMemoryContexts"
  | "patchMemoryItem"
  | "patchMemoryMaintenancePolicy"
  | "rejectMemoryMaintenanceRecommendation"
  | "runMemoryMaintenanceNow"
>;

export class MemoryRouteService {
  public constructor(private readonly gateway: MemoryRouteGateway) {}

  public composeContext(input: Parameters<MemoryRouteGateway["composeMemoryContext"]>[0]) {
    return this.gateway.composeMemoryContext(input);
  }

  public getContext(contextId: string) {
    return this.gateway.getMemoryContext(contextId);
  }

  public getMaintenancePolicy(workspaceId?: string) {
    return this.gateway.getMemoryMaintenancePolicy(workspaceId);
  }

  public patchMaintenancePolicy(
    workspaceId: string | undefined,
    patch: Parameters<MemoryRouteGateway["patchMemoryMaintenancePolicy"]>[1],
  ) {
    return this.gateway.patchMemoryMaintenancePolicy(workspaceId, patch);
  }

  public getMaintenanceStatus(workspaceId?: string) {
    return this.gateway.getMemoryMaintenanceStatus(workspaceId);
  }

  public listMaintenanceRuns(workspaceId: string | undefined, limit: number) {
    return this.gateway.listMemoryMaintenanceRuns(workspaceId, limit);
  }

  public runMaintenanceNow(input: Parameters<MemoryRouteGateway["runMemoryMaintenanceNow"]>[0]) {
    return this.gateway.runMemoryMaintenanceNow(input);
  }

  public getMaintenanceRunProvenance(runId: string) {
    return this.gateway.getMemoryMaintenanceRunProvenance(runId);
  }

  public listMaintenanceRecommendations(workspaceId: string | undefined, limit: number) {
    return this.gateway.listMemoryMaintenanceRecommendations(workspaceId, limit);
  }

  public acceptMaintenanceRecommendation(recommendationId: string) {
    return this.gateway.acceptMemoryMaintenanceRecommendation(recommendationId);
  }

  public rejectMaintenanceRecommendation(recommendationId: string) {
    return this.gateway.rejectMemoryMaintenanceRecommendation(recommendationId);
  }

  public getQmdStats(from: string, to: string) {
    return this.gateway.getMemoryQmdStats(from, to);
  }

  public listRecentContexts(limit: number) {
    return this.gateway.listRecentMemoryContexts(limit);
  }

  public listItems(input: Parameters<MemoryRouteGateway["listMemoryItems"]>[0]) {
    return this.gateway.listMemoryItems(input);
  }

  public patchItem(itemId: string, patch: Parameters<MemoryRouteGateway["patchMemoryItem"]>[1], actorId: string) {
    return this.gateway.patchMemoryItem(itemId, patch, actorId);
  }

  public forgetItem(itemId: string, actorId: string) {
    return this.gateway.forgetMemoryItem(itemId, actorId);
  }

  public listItemHistory(itemId: string, limit: number) {
    return this.gateway.listMemoryItemHistory(itemId, limit);
  }

  public forget(input: Parameters<MemoryRouteGateway["forgetMemory"]>[0]) {
    return this.gateway.forgetMemory(input);
  }
}
