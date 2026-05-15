import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import {
  findPlanPhase,
  parseDelegateCommand,
  parsePipelineCommand,
  parseSlashCommand,
  splitChatPrefsPatch,
  toChatSessionRecord,
} from "./gateway-service.js";

describe("GatewayService loop24 pure helper coverage", () => {
  it("finds phases across waves and maps chat sessions without changing route shapes", () => {
    const phase = { phaseId: "phase-2", ownerAgentId: "qa" };
    const plan = {
      waves: [
        { waveId: "wave-1", phases: [{ phaseId: "phase-1" }] },
        { waveId: "wave-2", phases: [phase] },
      ],
    };

    expect(findPlanPhase(plan as never, "phase-2")).toBe(phase);
    expect(findPlanPhase(plan as never, "missing")).toBeUndefined();

    const missionRecord = toChatSessionRecord(
      {
        sessionId: "session-1",
        sessionKey: "mission:session-1",
        channel: "mission",
        account: "operator",
        displayName: "Mission session",
        updatedAt: "2026-05-14T20:00:00.000Z",
        lastActivityAt: "2026-05-14T20:01:00.000Z",
        tokenTotal: 42,
        costUsdTotal: 0.25,
      } as never,
      {
        includeInHistory: true,
        pinned: true,
        lifecycleStatus: "active",
        tags: ["ops"],
      },
      {
        projectId: "project-1",
        name: "Runtime",
        workspaceId: "workspace-project",
      } as never,
      {
        searchHits: 2,
        generatedArtifacts: [{ artifactId: "artifact-1" }] as never,
      },
    );

    expect(missionRecord).toMatchObject({
      sessionId: "session-1",
      workspaceId: "workspace-project",
      scope: "mission",
      title: "Mission session",
      pinned: true,
      tags: ["ops"],
      projectId: "project-1",
      projectName: "Runtime",
      searchHits: 2,
      tokenTotal: 42,
      costUsdTotal: 0.25,
    });

    const externalRecord = toChatSessionRecord(
      {
        sessionId: "session-2",
        sessionKey: "slack:session-2",
        channel: "slack",
        account: "workspace",
        displayName: "External session",
        updatedAt: "2026-05-14T20:00:00.000Z",
        lastActivityAt: "2026-05-14T20:01:00.000Z",
      } as never,
      {
        workspaceId: "workspace-explicit",
        mode: "code",
        title: "Explicit title",
        origin: "operator",
        includeInHistory: false,
        pinned: false,
        lifecycleStatus: "archived",
        archivedAt: "2026-05-14T21:00:00.000Z",
        folderId: "folder-1",
        folderName: "Archive",
      },
    );

    expect(externalRecord).toMatchObject({
      workspaceId: "workspace-explicit",
      scope: "external",
      mode: "code",
      title: "Explicit title",
      origin: "operator",
      includeInHistory: false,
      lifecycleStatus: "archived",
      archivedAt: "2026-05-14T21:00:00.000Z",
      folderId: "folder-1",
      folderName: "Archive",
      tags: [],
    });
  });

  it("normalizes slash, delegate, and pipeline commands for route-level callers", () => {
    expect(parseSlashCommand("plain text")).toBeUndefined();
    expect(parseSlashCommand("  /delegate QA :: verify runtime  ")).toEqual([
      "/delegate",
      "QA",
      "::",
      "verify",
      "runtime",
    ]);

    expect(parseDelegateCommand("/delegate QA, Coder, qa, ??? :: Validate route diagnostics")).toEqual({
      roles: ["qa", "coder"],
      objective: "Validate route diagnostics",
    });
    expect(parseDelegateCommand("/delegate :: Use defaults")).toMatchObject({
      roles: ["product", "architect", "coder", "qa", "ops"],
      objective: "Use defaults",
    });
    expect(parseDelegateCommand("/delegate qa")).toEqual({ roles: [], error: "missing delimiter" });
    expect(parseDelegateCommand("/delegate qa ::   ")).toEqual({
      roles: ["qa"],
      objective: "",
      error: "invalid delegate payload",
    });

    expect(parsePipelineCommand("/pipeline BUILD :: ship the patch")).toEqual({
      template: "build",
      roles: ["architect", "coder", "qa"],
      objective: "ship the patch",
    });
    expect(parsePipelineCommand("/pipeline unknown :: nope")).toBeUndefined();
    expect(parsePipelineCommand("/pipeline release ::   ")).toBeUndefined();
    expect(parsePipelineCommand("/pipeline release")).toBeUndefined();
  });

  it("splits chat preference updates into base and autonomy patches", () => {
    const split = splitChatPrefsPatch({
      mode: "code",
      planningMode: "detailed",
      providerId: "openai",
      model: "gpt-5",
      imageProviderId: "openai",
      imageModel: "gpt-image-1",
      webMode: "enabled",
      memoryMode: "auto",
      thinkingLevel: "high",
      speedMode: "quality",
      subagentPolicy: "auto",
      toolAutonomy: "supervised",
      visionFallbackModel: "gpt-5-mini",
      orchestrationEnabled: true,
      orchestrationIntensity: "high",
      orchestrationVisibility: "full",
      orchestrationProviderPreference: "balanced",
      orchestrationReviewDepth: "deep",
      orchestrationParallelism: 3,
      codeAutoApply: true,
      proactiveMode: "enabled",
      autonomyBudget: {
        maxActionsPerHour: 8,
        maxActionsPerTurn: 2,
        cooldownSeconds: 30,
      },
      retrievalMode: "workspace",
      reflectionMode: "summaries",
    } as never);

    expect(split.basePatch).toMatchObject({
      mode: "code",
      planningMode: "detailed",
      providerId: "openai",
      model: "gpt-5",
      orchestrationEnabled: true,
      orchestrationParallelism: 3,
      codeAutoApply: true,
    });
    expect(split.basePatch).not.toHaveProperty("autonomyBudget");
    expect(split.basePatch).not.toHaveProperty("proactiveMode");
    expect(split.autonomyPatch).toEqual({
      proactiveMode: "enabled",
      maxActionsPerHour: 8,
      maxActionsPerTurn: 2,
      cooldownSeconds: 30,
      retrievalMode: "workspace",
      reflectionMode: "summaries",
    });

    expect(splitChatPrefsPatch({} as never).autonomyPatch).toEqual({
      proactiveMode: undefined,
      maxActionsPerHour: undefined,
      maxActionsPerTurn: undefined,
      cooldownSeconds: undefined,
      retrievalMode: undefined,
      reflectionMode: undefined,
    });
  });
});
