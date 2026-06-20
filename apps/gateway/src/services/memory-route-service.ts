import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";

type MemoryRoutePort = Pick<
  MemoryLifecycleService,
  | "acceptMaintenanceRecommendation"
  | "composeContext"
  | "batchMutateMemoryItems"
  | "forgetMemory"
  | "forgetMemoryItem"
  | "forgetMemoryDecision"
  | "forgetMemoryEntity"
  | "listMemoryDecisions"
  | "listMemoryEntities"
  | "listMemoryRelations"
  | "listStructuredMemoryHistory"
  | "addMemoryDecisionRetrospective"
  | "createMemoryDecision"
  | "createMemoryEntity"
  | "createMemoryRelation"
  | "getContext"
  | "getContextStats"
  | "getMaintenancePolicy"
  | "getMaintenanceRunProvenance"
  | "getMaintenanceStatus"
  | "getRetrievalStatus"
  | "listMaintenanceRecommendations"
  | "listMaintenanceRuns"
  | "listMemoryItemHistory"
  | "listMemoryItems"
  | "listMemoryLearnings"
  | "createMemoryLearning"
  | "listMemoryFeedback"
  | "listMemoryQualityIssues"
  | "recordMemoryFeedback"
  | "patchMemoryQualityIssue"
  | "listTraceMemoryCandidates"
  | "proposeTraceMemoryCandidate"
  | "promoteTraceMemoryCandidate"
  | "recallMemory"
  | "proposeMemoryLearning"
  | "supersedeMemoryLearning"
  | "forgetMemoryLearning"
  | "checkMemoryLearningStaleness"
  | "listRecentContexts"
  | "patchMaintenancePolicy"
  | "patchMemoryItem"
  | "rejectMaintenanceRecommendation"
  | "runMaintenanceNow"
  | "runMemoryQualityScan"
  | "runRetrievalBenchmark"
>;

export class MemoryRouteService {
  public constructor(private readonly memory: MemoryRoutePort) {}

  public composeContext(input: Parameters<MemoryRoutePort["composeContext"]>[0]) {
    return this.memory.composeContext(input);
  }

  public getContext(contextId: string) {
    return this.memory.getContext(contextId);
  }

  public getMaintenancePolicy(workspaceId?: string) {
    return this.memory.getMaintenancePolicy(workspaceId);
  }

  public patchMaintenancePolicy(
    workspaceId: string | undefined,
    patch: Parameters<MemoryRoutePort["patchMaintenancePolicy"]>[1],
  ) {
    return this.memory.patchMaintenancePolicy(workspaceId, patch);
  }

  public getMaintenanceStatus(workspaceId?: string) {
    return this.memory.getMaintenanceStatus(workspaceId);
  }

  public listMaintenanceRuns(workspaceId: string | undefined, limit: number) {
    return this.memory.listMaintenanceRuns(workspaceId, limit);
  }

  public runMaintenanceNow(input: Parameters<MemoryRoutePort["runMaintenanceNow"]>[0]) {
    return this.memory.runMaintenanceNow(input);
  }

  public getMaintenanceRunProvenance(runId: string) {
    return this.memory.getMaintenanceRunProvenance(runId);
  }

  public listMaintenanceRecommendations(workspaceId: string | undefined, limit: number) {
    return this.memory.listMaintenanceRecommendations(workspaceId, limit);
  }

  public acceptMaintenanceRecommendation(recommendationId: string) {
    return this.memory.acceptMaintenanceRecommendation(recommendationId);
  }

  public rejectMaintenanceRecommendation(recommendationId: string) {
    return this.memory.rejectMaintenanceRecommendation(recommendationId);
  }

  public getQmdStats(from: string, to: string) {
    return this.memory.getContextStats(from, to);
  }

  public getRetrievalStatus() {
    return this.memory.getRetrievalStatus();
  }

  public runRetrievalBenchmark(input: Parameters<MemoryRoutePort["runRetrievalBenchmark"]>[0]) {
    return this.memory.runRetrievalBenchmark(input);
  }

  public listRecentContexts(limit: number) {
    return this.memory.listRecentContexts(limit);
  }

  public recall(input: Parameters<MemoryRoutePort["recallMemory"]>[0]) {
    return this.memory.recallMemory(input);
  }

  public listFeedback(input: Parameters<MemoryRoutePort["listMemoryFeedback"]>[0]) {
    return this.memory.listMemoryFeedback(input);
  }

  public recordFeedback(input: Parameters<MemoryRoutePort["recordMemoryFeedback"]>[0], actorId: string) {
    return this.memory.recordMemoryFeedback(input, actorId);
  }

  public listQualityIssues(input: Parameters<MemoryRoutePort["listMemoryQualityIssues"]>[0]) {
    return this.memory.listMemoryQualityIssues(input);
  }

  public runQualityScan(input: Parameters<MemoryRoutePort["runMemoryQualityScan"]>[0], actorId: string) {
    return this.memory.runMemoryQualityScan(input, actorId);
  }

  public patchQualityIssue(
    issueId: string,
    input: Parameters<MemoryRoutePort["patchMemoryQualityIssue"]>[1],
    actorId: string,
  ) {
    return this.memory.patchMemoryQualityIssue(issueId, input, actorId);
  }

  public listTraceCandidates(input: Parameters<MemoryRoutePort["listTraceMemoryCandidates"]>[0]) {
    return this.memory.listTraceMemoryCandidates(input);
  }

  public proposeTraceCandidate(input: Parameters<MemoryRoutePort["proposeTraceMemoryCandidate"]>[0], actorId: string) {
    return this.memory.proposeTraceMemoryCandidate(input, actorId);
  }

  public promoteTraceCandidate(candidateId: string, actorId: string) {
    return this.memory.promoteTraceMemoryCandidate(candidateId, actorId);
  }

  public listItems(input: Parameters<MemoryRoutePort["listMemoryItems"]>[0]) {
    return this.memory.listMemoryItems(input);
  }

  public batchMutateItems(input: Parameters<MemoryRoutePort["batchMutateMemoryItems"]>[0], actorId: string) {
    return this.memory.batchMutateMemoryItems(input, actorId);
  }

  public patchItem(itemId: string, patch: Parameters<MemoryRoutePort["patchMemoryItem"]>[1], actorId: string) {
    return this.memory.patchMemoryItem(itemId, patch, actorId);
  }

  public forgetItem(itemId: string, actorId: string) {
    return this.memory.forgetMemoryItem(itemId, actorId);
  }

  public listItemHistory(itemId: string, limit: number) {
    return this.memory.listMemoryItemHistory(itemId, limit);
  }

  public forget(input: Parameters<MemoryRoutePort["forgetMemory"]>[0]) {
    return this.memory.forgetMemory(input);
  }

  public listLearnings(input: Parameters<MemoryRoutePort["listMemoryLearnings"]>[0]) {
    return this.memory.listMemoryLearnings(input);
  }

  public createLearning(input: Parameters<MemoryRoutePort["createMemoryLearning"]>[0], actorId: string) {
    return this.memory.createMemoryLearning(input, actorId);
  }

  public proposeLearning(input: Parameters<MemoryRoutePort["proposeMemoryLearning"]>[0], actorId: string) {
    return this.memory.proposeMemoryLearning(input, actorId);
  }

  public supersedeLearning(
    learningId: string,
    input: Parameters<MemoryRoutePort["supersedeMemoryLearning"]>[1],
    actorId: string,
  ) {
    return this.memory.supersedeMemoryLearning(learningId, input, actorId);
  }

  public forgetLearning(learningId: string, actorId: string) {
    return this.memory.forgetMemoryLearning(learningId, actorId);
  }

  public checkLearningStaleness(input: Parameters<MemoryRoutePort["checkMemoryLearningStaleness"]>[0]) {
    return this.memory.checkMemoryLearningStaleness(input);
  }

  public listEntities(input: Parameters<MemoryRoutePort["listMemoryEntities"]>[0]) {
    return this.memory.listMemoryEntities(input);
  }

  public createEntity(input: Parameters<MemoryRoutePort["createMemoryEntity"]>[0], actorId: string) {
    return this.memory.createMemoryEntity(input, actorId);
  }

  public forgetEntity(entityId: string, actorId: string) {
    return this.memory.forgetMemoryEntity(entityId, actorId);
  }

  public listRelations(input: Parameters<MemoryRoutePort["listMemoryRelations"]>[0]) {
    return this.memory.listMemoryRelations(input);
  }

  public createRelation(input: Parameters<MemoryRoutePort["createMemoryRelation"]>[0], actorId: string) {
    return this.memory.createMemoryRelation(input, actorId);
  }

  public listDecisions(input: Parameters<MemoryRoutePort["listMemoryDecisions"]>[0]) {
    return this.memory.listMemoryDecisions(input);
  }

  public createDecision(input: Parameters<MemoryRoutePort["createMemoryDecision"]>[0], actorId: string) {
    return this.memory.createMemoryDecision(input, actorId);
  }

  public addDecisionRetrospective(
    decisionId: string,
    input: Parameters<MemoryRoutePort["addMemoryDecisionRetrospective"]>[1],
    actorId: string,
  ) {
    return this.memory.addMemoryDecisionRetrospective(decisionId, input, actorId);
  }

  public forgetDecision(decisionId: string, actorId: string) {
    return this.memory.forgetMemoryDecision(decisionId, actorId);
  }

  public listStructuredHistory(
    recordKind: Parameters<MemoryRoutePort["listStructuredMemoryHistory"]>[0],
    recordId: string,
    limit: number,
  ) {
    return this.memory.listStructuredMemoryHistory(recordKind, recordId, limit);
  }
}
