import { describe, expect, it, vi } from "vitest";
import { CapabilitiesRouteService } from "./capabilities-route-service.js";
import { MemoryRouteService } from "./memory-route-service.js";
import { OrchestrationRouteService } from "./orchestration-route-service.js";

function createDelegatingPort(methods: string[]) {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      vi.fn((...args: unknown[]) => ({
        method,
        args,
      })),
    ]),
  ) as Record<string, ReturnType<typeof vi.fn>>;
}

describe("route service facades", () => {
  it("delegates every memory route method to the memory lifecycle port", () => {
    const port = createDelegatingPort([
      "acceptMaintenanceRecommendation",
      "composeContext",
      "forgetMemory",
      "forgetMemoryItem",
      "listMemoryFeedback",
      "listTraceMemoryCandidates",
      "proposeTraceMemoryCandidate",
      "promoteTraceMemoryCandidate",
      "recallMemory",
      "recordMemoryFeedback",
      "getContext",
      "getContextStats",
      "getMaintenancePolicy",
      "getMaintenanceRunProvenance",
      "getMaintenanceStatus",
      "getRetrievalStatus",
      "listMaintenanceRecommendations",
      "listMaintenanceRuns",
      "listMemoryItemHistory",
      "listMemoryItems",
      "listRecentContexts",
      "patchMaintenancePolicy",
      "patchMemoryItem",
      "rejectMaintenanceRecommendation",
      "runMaintenanceNow",
    ]);
    const service = new MemoryRouteService(port as never);

    expect(service.composeContext({ workspaceId: "workspace-1" } as never)).toEqual({
      method: "composeContext",
      args: [{ workspaceId: "workspace-1" }],
    });
    expect(service.getContext("context-1")).toEqual({ method: "getContext", args: ["context-1"] });
    expect(service.getMaintenancePolicy("workspace-1")).toEqual({
      method: "getMaintenancePolicy",
      args: ["workspace-1"],
    });
    expect(service.patchMaintenancePolicy("workspace-1", { enabled: false } as never)).toEqual({
      method: "patchMaintenancePolicy",
      args: ["workspace-1", { enabled: false }],
    });
    expect(service.getMaintenanceStatus()).toEqual({ method: "getMaintenanceStatus", args: [undefined] });
    expect(service.listMaintenanceRuns(undefined, 25)).toEqual({
      method: "listMaintenanceRuns",
      args: [undefined, 25],
    });
    expect(service.runMaintenanceNow({ workspaceId: "workspace-1" } as never)).toEqual({
      method: "runMaintenanceNow",
      args: [{ workspaceId: "workspace-1" }],
    });
    expect(service.getMaintenanceRunProvenance("run-1")).toEqual({
      method: "getMaintenanceRunProvenance",
      args: ["run-1"],
    });
    expect(service.listMaintenanceRecommendations("workspace-1", 10)).toEqual({
      method: "listMaintenanceRecommendations",
      args: ["workspace-1", 10],
    });
    expect(service.acceptMaintenanceRecommendation("rec-1")).toEqual({
      method: "acceptMaintenanceRecommendation",
      args: ["rec-1"],
    });
    expect(service.rejectMaintenanceRecommendation("rec-2")).toEqual({
      method: "rejectMaintenanceRecommendation",
      args: ["rec-2"],
    });
    expect(service.getQmdStats("2026-05-01", "2026-05-14")).toEqual({
      method: "getContextStats",
      args: ["2026-05-01", "2026-05-14"],
    });
    expect(service.getRetrievalStatus()).toEqual({ method: "getRetrievalStatus", args: [] });
    expect(service.listRecentContexts(7)).toEqual({ method: "listRecentContexts", args: [7] });
    expect(service.recall({ mode: "summary" } as never)).toEqual({
      method: "recallMemory",
      args: [{ mode: "summary" }],
    });
    expect(service.listFeedback({ workspaceId: "workspace-1" } as never)).toEqual({
      method: "listMemoryFeedback",
      args: [{ workspaceId: "workspace-1" }],
    });
    expect(service.recordFeedback({ kind: "useful" } as never, "operator")).toEqual({
      method: "recordMemoryFeedback",
      args: [{ kind: "useful" }, "operator"],
    });
    expect(service.listTraceCandidates({ status: "proposed" } as never)).toEqual({
      method: "listTraceMemoryCandidates",
      args: [{ status: "proposed" }],
    });
    expect(service.proposeTraceCandidate({ proposedInsight: "remember this" } as never, "agent")).toEqual({
      method: "proposeTraceMemoryCandidate",
      args: [{ proposedInsight: "remember this" }, "agent"],
    });
    expect(service.promoteTraceCandidate("trace-1", "operator")).toEqual({
      method: "promoteTraceMemoryCandidate",
      args: ["trace-1", "operator"],
    });
    expect(service.listItems({ workspaceId: "workspace-1" } as never)).toEqual({
      method: "listMemoryItems",
      args: [{ workspaceId: "workspace-1" }],
    });
    expect(service.patchItem("item-1", { state: "kept" } as never, "operator")).toEqual({
      method: "patchMemoryItem",
      args: ["item-1", { state: "kept" }, "operator"],
    });
    expect(service.forgetItem("item-1", "operator")).toEqual({
      method: "forgetMemoryItem",
      args: ["item-1", "operator", undefined],
    });
    const forgetHooks = { onCommit: vi.fn(), afterCommit: vi.fn() };
    expect(service.forgetItem("item-1", "operator", forgetHooks)).toEqual({
      method: "forgetMemoryItem",
      args: ["item-1", "operator", forgetHooks],
    });
    expect(service.listItemHistory("item-1", 5)).toEqual({
      method: "listMemoryItemHistory",
      args: ["item-1", 5],
    });
    expect(service.forget({ workspaceId: "workspace-1", query: "old" } as never)).toEqual({
      method: "forgetMemory",
      args: [{ workspaceId: "workspace-1", query: "old" }, undefined],
    });
    expect(service.forget({ workspaceId: "workspace-1", query: "old" } as never, forgetHooks)).toEqual({
      method: "forgetMemory",
      args: [{ workspaceId: "workspace-1", query: "old" }, forgetHooks],
    });
  });

  it("delegates capability catalog, proposal, candidate, and Code Mode calls", () => {
    const port = createDelegatingPort([
      "createCodeModeRun",
      "createProposal",
      "getCandidateDetail",
      "getCatalogSnapshot",
      "getCompactToolDirectorySnapshot",
      "getCodeModeRun",
      "getCodeModeRunInScope",
      "getProposalDetail",
      "getToolSchema",
      "listCatalog",
      "listCodeModeExecutionBackends",
      "listCodeModeRuns",
      "listProposals",
      "promoteCandidate",
      "revokeCandidate",
      "rollbackCandidate",
    ]);
    const service = new CapabilitiesRouteService(port as never);

    expect(service.listCapabilityCatalog("all")).toEqual({ method: "listCatalog", args: ["all"] });
    expect(service.getCapabilityCatalogSnapshot("snapshot-1")).toEqual({
      method: "getCatalogSnapshot",
      args: ["snapshot-1"],
    });
    expect(service.getCompactToolDirectorySnapshot(120_000)).toEqual({
      method: "getCompactToolDirectorySnapshot",
      args: [120_000],
    });
    expect(service.getToolSchema("tool.safe_read")).toEqual({
      method: "getToolSchema",
      args: ["tool.safe_read"],
    });
    expect(service.listCapabilityProposals()).toEqual({ method: "listProposals", args: [100] });
    expect(service.listCapabilityProposals(5)).toEqual({ method: "listProposals", args: [5] });
    expect(service.createCapabilityProposal({ title: "Add API" } as never)).toEqual({
      method: "createProposal",
      args: [{ title: "Add API" }],
    });
    expect(service.getCapabilityProposalDetail("proposal-1")).toEqual({
      method: "getProposalDetail",
      args: ["proposal-1"],
    });
    expect(service.getCapabilityCandidateDetail("candidate-1")).toEqual({
      method: "getCandidateDetail",
      args: ["candidate-1"],
    });
    expect(service.promoteCapabilityCandidate("candidate-1", "version-2")).toEqual({
      method: "promoteCandidate",
      args: ["candidate-1", "version-2"],
    });
    expect(service.revokeCapabilityCandidate("candidate-1")).toEqual({
      method: "revokeCandidate",
      args: ["candidate-1", undefined],
    });
    expect(service.rollbackCapabilityCandidate("candidate-1", "version-1")).toEqual({
      method: "rollbackCandidate",
      args: ["candidate-1", "version-1"],
    });
    expect(service.listCodeModeRuns()).toEqual({ method: "listCodeModeRuns", args: [100] });
    expect(service.getCodeModeRun("run-1")).toEqual({ method: "getCodeModeRun", args: ["run-1"] });
    expect(service.getCodeModeRunInScope("run-1", { workspaceId: "default" })).toEqual({
      method: "getCodeModeRunInScope",
      args: ["run-1", { workspaceId: "default" }],
    });
    expect(service.listCodeModeExecutionBackends()).toEqual({
      method: "listCodeModeExecutionBackends",
      args: [],
    });
    expect(service.createCodeModeRun({ workspaceId: "workspace-1" } as never)).toEqual({
      method: "createCodeModeRun",
      args: [{ workspaceId: "workspace-1" }],
    });
  });

  it("delegates orchestration route calls without reshaping route contract arguments", async () => {
    const port = createDelegatingPort([
      "approvePhase",
      "createOrchestrationPlan",
      "createPlanFromRecipe",
      "exportActivepiecesTemplate",
      "exportN8nTemplate",
      "getRun",
      "getRunTrace",
      "listRecipeTemplates",
      "listRunCheckpoints",
      "listRunContexts",
      "previewRecipe",
      "runOrchestrationPlan",
    ]);
    const service = new OrchestrationRouteService(port as never);

    await expect(service.createPlan({ planId: "plan-1" } as never)).resolves.toEqual({
      method: "createOrchestrationPlan",
      args: [{ planId: "plan-1" }],
    });
    expect(service.previewRecipe({ recipeId: "recipe-1" } as never)).toEqual({
      method: "previewRecipe",
      args: [{ recipeId: "recipe-1" }],
    });
    await expect(service.createPlanFromRecipe({ recipeId: "recipe-1" } as never)).resolves.toEqual({
      method: "createPlanFromRecipe",
      args: [{ recipeId: "recipe-1" }],
    });
    expect(service.exportActivepiecesTemplate({ recipeId: "recipe-1" } as never)).toEqual({
      method: "exportActivepiecesTemplate",
      args: [{ recipeId: "recipe-1" }],
    });
    expect(service.exportN8nTemplate({ recipeId: "recipe-1" } as never)).toEqual({
      method: "exportN8nTemplate",
      args: [{ recipeId: "recipe-1" }],
    });
    expect(service.listRecipeTemplates()).toEqual({ method: "listRecipeTemplates", args: [] });
    await expect(service.runPlan("plan-1")).resolves.toEqual({
      method: "runOrchestrationPlan",
      args: ["plan-1"],
    });
    await expect(service.approvePhase("run-1", "phase-1", "operator", 1.25, "workspace-1")).resolves.toEqual({
      method: "approvePhase",
      args: ["run-1", "phase-1", "operator", 1.25, "workspace-1"],
    });
    expect(service.getRun("run-1", "workspace-1")).toEqual({
      method: "getRun",
      args: ["run-1", "workspace-1"],
    });
    expect(service.listRunCheckpoints("run-1")).toEqual({
      method: "listRunCheckpoints",
      args: ["run-1", undefined],
    });
    expect(service.getRunTrace("run-1", "workspace-1")).toEqual({
      method: "getRunTrace",
      args: ["run-1", "workspace-1"],
    });
    expect(service.listRunContexts("run-1")).toEqual({
      method: "listRunContexts",
      args: ["run-1"],
    });
  });
});
