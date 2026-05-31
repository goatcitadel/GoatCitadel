import { beforeEach, describe, expect, it, vi } from "vitest";

import * as integrations from "./integrations";
import * as memory from "./memory";
import * as promptPacks from "./prompt-packs";
import * as improvement from "./improvement";
import * as platform from "./platform";
import * as tasks from "./tasks";

const apiMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
}));

async function expectCall(operation: Promise<unknown>, path: string, init?: Partial<RequestInit>) {
  await operation;
  const [actualPath, actualInit] = apiMocks.request.mock.calls.at(-1) ?? [];
  expect(actualPath).toBe(path);
  if (init) {
    expect(actualInit).toMatchObject(init);
  }
}

describe("shared API wrappers", () => {
  beforeEach(() => {
    apiMocks.request.mockClear();
    apiMocks.request.mockResolvedValue({ ok: true });
  });

  it("routes integration and channel wrapper calls through the gateway API", async () => {
    await expectCall(integrations.fetchIntegrationCatalog("chat" as never), "/api/v1/integrations/catalog?kind=chat");
    await expectCall(integrations.fetchIntegrationCatalog(), "/api/v1/integrations/catalog");
    await expectCall(integrations.fetchChannelSetupDefinitions(), "/api/v1/channels/setup-definitions");
    await expectCall(
      integrations.fetchChannelSetupDefinition("slack/channel"),
      "/api/v1/channels/catalog/slack%2Fchannel/setup-definition",
    );
    await expectCall(
      integrations.fetchChannelSetupDrafts({ catalogId: "slack", connectionId: "conn 1", limit: 25 }),
      "/api/v1/channels/drafts?catalogId=slack&connectionId=conn+1&limit=25",
    );
    await expectCall(integrations.fetchChannelSetupDrafts(), "/api/v1/channels/drafts");
    await expectCall(integrations.createChannelSetupDraft({ catalogId: "slack" } as never), "/api/v1/channels/drafts", {
      method: "POST",
      body: JSON.stringify({ catalogId: "slack" }),
    });
    await expectCall(
      integrations.updateChannelSetupDraft("draft/1", { values: { token: "x" } } as never),
      "/api/v1/channels/drafts/draft%2F1",
      { method: "PATCH" },
    );
    await expectCall(integrations.validateChannelSetupDraft("draft/1"), "/api/v1/channels/drafts/draft%2F1/validate", {
      method: "POST",
    });
    await expectCall(integrations.testChannelSetupDraft("draft/1"), "/api/v1/channels/drafts/draft%2F1/test", {
      method: "POST",
    });
    await expectCall(integrations.finalizeChannelSetupDraft("draft/1"), "/api/v1/channels/drafts/draft%2F1/finalize", {
      method: "POST",
    });
    await expectCall(
      integrations.createChannelRepairDraft("conn/1"),
      "/api/v1/channels/connections/conn%2F1/repair-draft",
      { method: "POST" },
    );
    await expectCall(
      integrations.createChannelRotateSecretDraft("conn/1"),
      "/api/v1/channels/connections/conn%2F1/rotate-secret-draft",
      { method: "POST" },
    );
    await expectCall(integrations.retestChannelConnection("conn/1"), "/api/v1/channels/connections/conn%2F1/retest", {
      method: "POST",
    });
    await expectCall(integrations.fetchSlackOAuthStatus(), "/api/v1/integrations/slack/oauth/status");
    await expectCall(integrations.startSlackOAuth(), "/api/v1/integrations/slack/oauth/start", { method: "POST" });
    await expectCall(
      integrations.discoverTelegramTargets({ setupCode: "123" }),
      "/api/v1/integrations/telegram/discover-targets",
      { method: "POST" },
    );
    await expectCall(
      integrations.fetchChannelTargetDirectory("conn/1", { refresh: true, query: "ops" }),
      "/api/v1/channels/connections/conn%2F1/target-directory?refresh=true&query=ops",
    );
    await expectCall(integrations.fetchChannelPersonalities(), "/api/v1/channels/personalities");
    await expectCall(
      integrations.fetchIntegrationFormSchema("catalog/1"),
      "/api/v1/integrations/catalog/catalog%2F1/form-schema",
    );
    await expectCall(
      integrations.fetchIntegrationConnections("chat" as never),
      "/api/v1/integrations/connections?kind=chat&limit=300",
    );
    await expectCall(integrations.fetchIntegrationConnections(), "/api/v1/integrations/connections?limit=300");
    await expectCall(integrations.fetchConnectorRecords("gmail" as never), "/api/v1/connectors?connectorType=gmail");
    await expectCall(integrations.fetchConnectorRecords(), "/api/v1/connectors");
    await expectCall(
      integrations.createIntegrationConnection({ catalogId: "slack", enabled: true }),
      "/api/v1/integrations/connections",
      { method: "POST" },
    );
    await expectCall(
      integrations.updateIntegrationConnection("conn/1", { enabled: false }),
      "/api/v1/integrations/connections/conn%2F1",
      { method: "PATCH" },
    );
    await expectCall(integrations.deleteIntegrationConnection("conn/1"), "/api/v1/integrations/connections/conn%2F1", {
      method: "DELETE",
    });
    await expectCall(
      integrations.fetchIntegrationConnectionDiagnostics("conn/1"),
      "/api/v1/integrations/connections/conn%2F1/diagnostics",
    );
    await expectCall(
      integrations.invokeIntegrationConnectionAction("conn/1", "sync now", { dryRun: true }),
      "/api/v1/integrations/connections/conn%2F1/actions/sync%20now",
      { method: "POST" },
    );
    await expectCall(integrations.commsSend({ connectionId: "c" } as never), "/api/v1/comms/send", { method: "POST" });
    await expectCall(integrations.commsReply({ connectionId: "c" } as never), "/api/v1/comms/reply", {
      method: "POST",
    });
    await expectCall(integrations.commsReact({ connectionId: "c" } as never), "/api/v1/comms/react", {
      method: "POST",
    });
    await expectCall(integrations.commsUnsend({ connectionId: "c" } as never), "/api/v1/comms/unsend", {
      method: "POST",
    });
    await expectCall(integrations.commsTyping({ connectionId: "c" } as never), "/api/v1/comms/typing", {
      method: "POST",
    });
    await expectCall(integrations.fetchChannelCapabilities("conn/1"), "/api/v1/comms/capabilities/conn%2F1");
    await expectCall(integrations.fetchChannelRuntimeStatus("conn/1"), "/api/v1/comms/runtime/conn%2F1");
    await expectCall(integrations.fetchChannelDiagnostics("conn/1"), "/api/v1/comms/diagnostics/conn%2F1");
    await expectCall(integrations.commsGmailRead({ query: "from:a" } as never), "/api/v1/comms/gmail/read", {
      method: "POST",
    });
    await expectCall(integrations.commsGmailSend({ to: ["a"] } as never), "/api/v1/comms/gmail/send", {
      method: "POST",
    });
    await expectCall(integrations.commsCalendarList({} as never), "/api/v1/comms/calendar/list", { method: "POST" });
    await expectCall(integrations.commsCalendarCreate({} as never), "/api/v1/comms/calendar/create", {
      method: "POST",
    });
    await expectCall(
      integrations.fetchDiscordPairings("conn/1"),
      "/api/v1/integrations/connections/conn%2F1/discord/pairings",
    );
    await expectCall(
      integrations.approveDiscordPairing("conn/1", "pair/1"),
      "/api/v1/integrations/connections/conn%2F1/discord/pairings/pair%2F1/approve",
      { method: "POST" },
    );
    await expectCall(
      integrations.revokeDiscordPairing("conn/1", "pair/1"),
      "/api/v1/integrations/connections/conn%2F1/discord/pairings/pair%2F1/revoke",
      { method: "POST" },
    );
    await expectCall(
      integrations.reconnectDiscordRuntime("conn/1"),
      "/api/v1/integrations/connections/conn%2F1/discord/reconnect",
      { method: "POST" },
    );
    await expectCall(integrations.fetchIntegrationPlugins(), "/api/v1/integrations/plugins");
    await expectCall(
      integrations.installIntegrationPlugin({ source: "npm:pkg" }),
      "/api/v1/integrations/plugins/install",
      {
        method: "POST",
      },
    );
    await expectCall(
      integrations.enableIntegrationPlugin("plugin/1"),
      "/api/v1/integrations/plugins/plugin%2F1/enable",
      {
        method: "POST",
      },
    );
    await expectCall(
      integrations.disableIntegrationPlugin("plugin/1"),
      "/api/v1/integrations/plugins/plugin%2F1/disable",
      {
        method: "POST",
      },
    );
    await expectCall(integrations.fetchObsidianIntegrationStatus(), "/api/v1/integrations/obsidian/status");
    await expectCall(
      integrations.patchObsidianIntegrationConfig({ vaultPath: "/vault" }),
      "/api/v1/integrations/obsidian/config",
      {
        method: "PATCH",
      },
    );
    await expectCall(integrations.testObsidianIntegration(), "/api/v1/integrations/obsidian/test", { method: "POST" });
    await expectCall(
      integrations.searchObsidianNotes({ query: "goat", limit: 5 }),
      "/api/v1/integrations/obsidian/search",
      {
        method: "POST",
      },
    );
    await expectCall(
      integrations.readObsidianNote("Inbox/Today.md"),
      "/api/v1/integrations/obsidian/note?path=Inbox%2FToday.md",
    );
    await expectCall(
      integrations.appendObsidianNote({ path: "Inbox.md", markdownBlock: "- item" }),
      "/api/v1/integrations/obsidian/append",
      {
        method: "POST",
      },
    );
    await expectCall(
      integrations.captureObsidianInboxEntry({ id: "1", request: "Review", notes: "note" }),
      "/api/v1/integrations/obsidian/inbox/capture",
      { method: "POST" },
    );
  });

  it("routes memory, prompt-pack, improvement, and task wrappers", async () => {
    await expectCall(memory.knowledgeMemoryWrite({} as never), "/api/v1/knowledge/memory/write", { method: "POST" });
    await expectCall(memory.knowledgeMemorySearch({} as never), "/api/v1/knowledge/memory/search", { method: "POST" });
    await expectCall(memory.knowledgeDocsIngest({} as never), "/api/v1/knowledge/docs/ingest", { method: "POST" });
    await expectCall(memory.knowledgeEmbeddingsIndex({} as never), "/api/v1/knowledge/embeddings/index", {
      method: "POST",
    });
    await expectCall(memory.knowledgeEmbeddingsQuery({} as never), "/api/v1/knowledge/embeddings/query", {
      method: "POST",
    });
    await expectCall(memory.fetchMemoryFiles("project/docs"), "/api/v1/memory/files?dir=project%2Fdocs");
    await expectCall(
      memory.composeMemoryContext({ scope: "chat", prompt: "hi", relationScope: "project" }),
      "/api/v1/memory/context/compose",
      { method: "POST", body: JSON.stringify({ scope: "chat", prompt: "hi", relationScope: "project" }) },
    );
    await expectCall(memory.fetchMemoryContext("ctx/1"), "/api/v1/memory/context/ctx%2F1");
    await expectCall(memory.fetchMemoryQmdStats("a", "b", 10), "/api/v1/memory/qmd/stats?from=a&to=b&limit=10");
    await expectCall(
      memory.runMemoryRetrievalBenchmark({ prompts: ["runtime truth"], workspace: "goatcitadel" }),
      "/api/v1/memory/retrieval-benchmark",
      { method: "POST" },
    );
    await expectCall(
      memory.fetchMemoryItems({ namespace: "n", status: "active", query: "q", limit: 999 }),
      "/api/v1/memory/items?namespace=n&status=active&query=q&limit=500",
    );
    await expectCall(
      memory.patchMemoryItem("item/1", { status: "forgotten" } as never),
      "/api/v1/memory/items/item%2F1",
      {
        method: "PATCH",
      },
    );
    await expectCall(memory.forgetMemoryItem("item/1", "operator"), "/api/v1/memory/items/item%2F1/forget", {
      method: "POST",
    });
    await expectCall(memory.fetchMemoryItemHistory("item/1", 3000), "/api/v1/memory/items/item%2F1/history?limit=2000");
    await expectCall(
      memory.fetchMemoryEntities({ workspaceId: "workspace 1", status: "active", query: "project", limit: 999 }),
      "/api/v1/memory/entities?workspaceId=workspace+1&status=active&query=project&limit=500",
    );
    await expectCall(memory.createMemoryEntity({ title: "Project" } as never), "/api/v1/memory/entities", {
      method: "POST",
    });
    await expectCall(memory.forgetMemoryEntity("entity/1"), "/api/v1/memory/entities/entity%2F1/forget", {
      method: "POST",
    });
    await expectCall(
      memory.fetchMemoryRelations({ workspaceId: "workspace", status: "all", entityId: "entity/1", limit: 7 }),
      "/api/v1/memory/relations?workspaceId=workspace&status=all&limit=7&entityId=entity%2F1",
    );
    await expectCall(
      memory.createMemoryRelation({ fromEntityId: "a", toEntityId: "b", relationType: "uses" }),
      "/api/v1/memory/relations",
      {
        method: "POST",
      },
    );
    await expectCall(
      memory.fetchMemoryDecisions({ workspaceId: "workspace", dueForReview: false, limit: 3 }),
      "/api/v1/memory/decisions?workspaceId=workspace&limit=3&dueForReview=false",
    );
    await expectCall(
      memory.createMemoryDecision({ decision: "Ship it", rationale: "Enough proof." }),
      "/api/v1/memory/decisions",
      {
        method: "POST",
      },
    );
    await expectCall(
      memory.addMemoryDecisionRetrospective("decision/1", { outcome: "validated", notes: "Worked." }),
      "/api/v1/memory/decisions/decision%2F1/retrospective",
      {
        method: "POST",
      },
    );
    await expectCall(memory.forgetMemoryDecision("decision/1"), "/api/v1/memory/decisions/decision%2F1/forget", {
      method: "POST",
    });
    await expectCall(
      memory.fetchStructuredMemoryHistory("decision", "decision/1", 999),
      "/api/v1/memory/structured/decision/decision%2F1/history?limit=500",
    );
    await expectCall(
      memory.fetchMemoryMaintenancePolicy("workspace 1"),
      "/api/v1/memory/maintenance/policy?workspaceId=workspace%201",
    );
    await expectCall(memory.patchMemoryMaintenancePolicy(undefined, {} as never), "/api/v1/memory/maintenance/policy", {
      method: "PATCH",
    });
    await expectCall(memory.fetchMemoryMaintenanceStatus(), "/api/v1/memory/maintenance/status");
    await expectCall(
      memory.fetchMemoryMaintenanceRuns("workspace", 999),
      "/api/v1/memory/maintenance/runs?workspaceId=workspace&limit=500",
    );
    await expectCall(memory.runMemoryMaintenanceNow({} as never), "/api/v1/memory/maintenance/run-now", {
      method: "POST",
    });
    await expectCall(
      memory.fetchMemoryMaintenanceRunProvenance("run/1"),
      "/api/v1/memory/maintenance/runs/run%2F1/provenance",
    );
    await expectCall(
      memory.fetchMemoryMaintenanceRecommendations("workspace", 0),
      "/api/v1/memory/maintenance/recommendations?workspaceId=workspace&limit=1",
    );
    await expectCall(
      memory.acceptMemoryMaintenanceRecommendation("rec/1"),
      "/api/v1/memory/maintenance/recommendations/rec%2F1/accept",
      { method: "POST" },
    );
    await expectCall(
      memory.rejectMemoryMaintenanceRecommendation("rec/1"),
      "/api/v1/memory/maintenance/recommendations/rec%2F1/reject",
      { method: "POST" },
    );
    await expectCall(memory.forgetMemory({ namespace: "n" }), "/api/v1/memory/forget", { method: "POST" });

    await expectCall(promptPacks.importPromptPack({ content: "pack" }), "/api/v1/prompt-packs/import", {
      method: "POST",
    });
    await expectCall(promptPacks.fetchPromptPacks(5000), "/api/v1/prompt-packs?limit=2000");
    await expectCall(promptPacks.fetchPromptPackTests("pack/1", 0), "/api/v1/prompt-packs/pack%2F1/tests?limit=1");
    await expectCall(
      promptPacks.runPromptPackTest("pack/1", "test/1"),
      "/api/v1/prompt-packs/pack%2F1/tests/test%2F1/run",
      {
        method: "POST",
      },
    );
    await expectCall(
      promptPacks.scorePromptPackTest("pack/1", "test/1", { runId: "run" }),
      "/api/v1/prompt-packs/pack%2F1/tests/test%2F1/score",
      { method: "POST" },
    );
    await expectCall(
      promptPacks.autoScorePromptPackTest("pack/1", "test/1"),
      "/api/v1/prompt-packs/pack%2F1/tests/test%2F1/auto-score",
      {
        method: "POST",
      },
    );
    await expectCall(
      promptPacks.fetchPromptPackReviews("pack/1", "test/1"),
      "/api/v1/prompt-packs/pack%2F1/tests/test%2F1/reviews",
    );
    await expectCall(promptPacks.autoScorePromptPackBatch("pack/1"), "/api/v1/prompt-packs/pack%2F1/auto-score", {
      method: "POST",
    });
    await expectCall(promptPacks.fetchPromptPackReport("pack/1"), "/api/v1/prompt-packs/pack%2F1/report");
    await expectCall(
      promptPacks.runPromptPackBenchmark("pack/1", { providers: [] }),
      "/api/v1/prompt-packs/pack%2F1/benchmark/run",
      {
        method: "POST",
      },
    );
    await expectCall(promptPacks.fetchPromptPackBenchmark("bench/1"), "/api/v1/prompt-packs/benchmark/bench%2F1");
    await expectCall(
      promptPacks.cancelPromptPackBenchmark("bench/1"),
      "/api/v1/prompt-packs/benchmark/bench%2F1/cancel",
      {
        method: "POST",
      },
    );
    await expectCall(
      promptPacks.runPromptPackReplayRegression("pack/1", { testCodes: ["a"] }),
      "/api/v1/prompt-packs/pack%2F1/replay-regression/run",
      { method: "POST" },
    );
    await expectCall(
      promptPacks.fetchPromptPackReplayRegressionStatus("run/1"),
      "/api/v1/prompt-packs/replay-regression/run%2F1",
    );
    await expectCall(promptPacks.fetchPromptPackTrends("pack/1"), "/api/v1/prompt-packs/pack%2F1/trends");
    await expectCall(promptPacks.fetchPromptPackExport("pack/1"), "/api/v1/prompt-packs/pack%2F1/export");
    await expectCall(promptPacks.exportPromptPackReport("pack/1"), "/api/v1/prompt-packs/pack%2F1/export", {
      method: "POST",
    });
    await expectCall(promptPacks.resetPromptPack("pack/1"), "/api/v1/prompt-packs/pack%2F1/reset", { method: "POST" });

    await expectCall(improvement.fetchImprovementReports(999), "/api/v1/improvement/reports?limit=260");
    await expectCall(improvement.fetchImprovementReport("report/1"), "/api/v1/improvement/reports/report%2F1");
    await expectCall(improvement.fetchHarnessAuditReport(), "/api/v1/improvement/harness-audit");
    await expectCall(improvement.runImprovementReplay(), "/api/v1/improvement/replay/run", { method: "POST" });
    await expectCall(improvement.fetchImprovementReplayRuns(999), "/api/v1/improvement/replay/runs?limit=300");
    await expectCall(
      improvement.fetchImprovementSignals(999, "workspace"),
      "/api/v1/improvement/signals?limit=500&workspaceId=workspace",
    );
    await expectCall(improvement.fetchImprovementSignal("signal/1"), "/api/v1/improvement/signals/signal%2F1");
    await expectCall(
      improvement.fetchImprovementCandidates(999, "workspace"),
      "/api/v1/improvement/candidates?limit=300&workspaceId=workspace",
    );
    await expectCall(improvement.fetchImprovementCandidate("cand/1"), "/api/v1/improvement/candidates/cand%2F1");
    await expectCall(
      improvement.fetchCuratorReviewItems({ limit: 999, workspaceId: "workspace" }),
      "/api/v1/improvement/curator-review?limit=300&workspaceId=workspace",
    );
    await expectCall(
      improvement.fetchCuratorReviewItem("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/curator-review",
    );
    await expectCall(
      improvement.validateImprovementCandidate("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/validate",
      { method: "POST" },
    );
    await expectCall(
      improvement.approveImprovementCandidate("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/approve",
      { method: "POST" },
    );
    await expectCall(
      improvement.rejectImprovementCandidate("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/reject",
      { method: "POST" },
    );
    await expectCall(
      improvement.snoozeImprovementCandidate("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/snooze",
      { method: "POST" },
    );
    await expectCall(
      improvement.activateImprovementCandidate("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/activate",
      { method: "POST" },
    );
    await expectCall(
      improvement.promoteImprovementCandidate("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/promote",
      { method: "POST" },
    );
    await expectCall(
      improvement.requestImprovementActivation("cand/1"),
      "/api/v1/improvement/candidates/cand%2F1/activation-request",
      {
        method: "POST",
      },
    );
    await expectCall(
      improvement.fetchImprovementActivation("activation/1"),
      "/api/v1/improvement/activations/activation%2F1",
    );
    await expectCall(
      improvement.pauseImprovementActivation("activation/1"),
      "/api/v1/improvement/activations/activation%2F1/pause",
      {
        method: "POST",
      },
    );
    await expectCall(
      improvement.rollbackImprovementActivation("activation/1"),
      "/api/v1/improvement/activations/activation%2F1/rollback",
      { method: "POST" },
    );
    await expectCall(improvement.fetchCapabilityGapEvents(999), "/api/v1/improvement/capability-gaps?limit=500");
    await expectCall(improvement.fetchRepairCandidates(999), "/api/v1/improvement/repair-candidates?limit=300");
    await expectCall(
      improvement.updateRepairCandidateValidation("cand/1", { status: "passed" as never }),
      "/api/v1/improvement/repair-candidates/cand%2F1/validation",
      { method: "PATCH" },
    );
    await expectCall(improvement.fetchImprovementReplayRun("run/1"), "/api/v1/improvement/replay/runs/run%2F1");
    await expectCall(improvement.draftReplayOverride("run/1", { overrides: [] }), "/api/v1/replay/runs/run%2F1/draft", {
      method: "POST",
    });
    await expectCall(
      improvement.executeReplayOverride("run/1", { overrides: [] }),
      "/api/v1/replay/runs/run%2F1/execute",
      {
        method: "POST",
      },
    );
    await expectCall(improvement.fetchReplayDiff("run/1"), "/api/v1/replay/run%2F1/diff");
    await expectCall(
      improvement.approveImprovementAutoTune("tune/1"),
      "/api/v1/improvement/autotune/tune%2F1/approve",
      {
        method: "POST",
      },
    );
    await expectCall(improvement.revertImprovementAutoTune("tune/1"), "/api/v1/improvement/autotune/tune%2F1/revert", {
      method: "POST",
    });

    await expectCall(
      tasks.fetchTasks("open" as never, " workspace "),
      "/api/v1/tasks?limit=100&view=active&status=open&workspaceId=workspace",
    );
    await expectCall(
      tasks.fetchTasksByView("trash", undefined, "w"),
      "/api/v1/tasks?limit=100&view=trash&workspaceId=w",
    );
    await expectCall(tasks.createTask({ title: "Task" }), "/api/v1/tasks", { method: "POST" });
    await expectCall(tasks.updateTask("task/1", { title: "New" }), "/api/v1/tasks/task%2F1", { method: "PATCH" });
    await expectCall(
      tasks.deleteTask("task/1", { mode: "hard", deletedBy: "me" }),
      "/api/v1/tasks/task%2F1?mode=hard",
      {
        method: "DELETE",
      },
    );
    await expectCall(tasks.restoreTask("task/1"), "/api/v1/tasks/task%2F1/restore", { method: "POST" });
    await expectCall(tasks.fetchTaskActivities("task/1"), "/api/v1/tasks/task%2F1/activities");
    await expectCall(tasks.addTaskActivity("task/1", { message: "hi" }), "/api/v1/tasks/task%2F1/activities", {
      method: "POST",
    });
    await expectCall(tasks.fetchTaskDeliverables("task/1"), "/api/v1/tasks/task%2F1/deliverables");
    await expectCall(
      tasks.fetchTaskDeliverables("task/1", "workspace"),
      "/api/v1/tasks/task%2F1/deliverables?workspaceId=workspace",
    );
    await expectCall(tasks.addTaskDeliverable("task/1", { title: "Artifact" }), "/api/v1/tasks/task%2F1/deliverables", {
      method: "POST",
    });
    await expectCall(
      tasks.addTaskDeliverable("task/1", { title: "Artifact", workspaceId: "workspace" }),
      "/api/v1/tasks/task%2F1/deliverables?workspaceId=workspace",
      {
        method: "POST",
      },
    );
    await expectCall(tasks.fetchTaskSubagents("task/1"), "/api/v1/tasks/task%2F1/subagents");
    await expectCall(
      tasks.registerTaskSubagent("task/1", { agentSessionId: "agent/1" }),
      "/api/v1/tasks/task%2F1/subagents",
      {
        method: "POST",
      },
    );
    await expectCall(
      tasks.updateTaskSubagent("agent/1", { status: "completed" as never }),
      "/api/v1/subagents/agent%2F1",
      {
        method: "PATCH",
      },
    );
  });

  it("routes platform runtime wrappers and clamps query limits", async () => {
    await expectCall(platform.fetchAddonsCatalog(), "/api/v1/addons/catalog");
    await expectCall(platform.fetchInstalledAddons(), "/api/v1/addons/installed");
    await expectCall(platform.fetchAddonStatus("addon/1"), "/api/v1/addons/addon%2F1/status");
    await expectCall(platform.fetchAddonSlots(), "/api/v1/addons/slots");
    await expectCall(
      platform.fetchAddonSlots({ route: "/ops/approvals", slot: "ops.approvals.actions" }),
      "/api/v1/addons/slots?route=%2Fops%2Fapprovals&slot=ops.approvals.actions",
    );
    await expectCall(
      platform.fetchAddonSlots({ route: "/ops/approvals" }),
      "/api/v1/addons/slots?route=%2Fops%2Fapprovals",
    );
    await expectCall(
      platform.fetchAddonSlots({ slot: "library.skills.cards" }),
      "/api/v1/addons/slots?slot=library.skills.cards",
    );
    await expectCall(platform.installAddon("addon/1", {} as never), "/api/v1/addons/addon%2F1/install", {
      method: "POST",
    });
    await expectCall(platform.updateAddon("addon/1"), "/api/v1/addons/addon%2F1/update", { method: "POST" });
    await expectCall(platform.enableAddon("addon/1"), "/api/v1/addons/addon%2F1/enable", { method: "POST" });
    await expectCall(platform.disableAddon("addon/1"), "/api/v1/addons/addon%2F1/disable", { method: "POST" });
    await expectCall(platform.launchAddon("addon/1"), "/api/v1/addons/addon%2F1/launch", { method: "POST" });
    await expectCall(platform.stopAddon("addon/1"), "/api/v1/addons/addon%2F1/stop", { method: "POST" });
    await expectCall(platform.uninstallAddon("addon/1"), "/api/v1/addons/addon%2F1/uninstall", { method: "DELETE" });
    await expectCall(platform.fetchCapabilityPacks(), "/api/v1/capability-packs");
    await expectCall(platform.fetchCapabilityPackPreview("pack/1"), "/api/v1/capability-packs/pack%2F1/preview");
    await expectCall(
      platform.fetchLocalCapabilityPackPreview({ packId: "local-pack" } as never),
      "/api/v1/capability-packs/local/preview",
      { method: "POST" },
    );
    await expectCall(platform.installCapabilityPack("pack/1"), "/api/v1/capability-packs/pack%2F1/install", {
      method: "POST",
    });
    await expectCall(
      platform.installLocalCapabilityPack({ packId: "local-pack" } as never),
      "/api/v1/capability-packs/local/install",
      { method: "POST" },
    );
    await expectCall(
      platform.fetchEvidenceEnvelopes({ sessionId: "s", turnId: "t", runId: "r", limit: 7 }),
      "/api/v1/evidence/envelopes?sessionId=s&turnId=t&runId=r&limit=7",
    );
    await expectCall(platform.fetchOrchestrationRunContext("run/1"), "/api/v1/orchestration/runs/run%2F1/context");
    await expectCall(platform.fetchOrchestrationRun("run/1"), "/api/v1/orchestration/runs/run%2F1");
    await expectCall(
      platform.fetchOrchestrationRunCheckpoints("run/1"),
      "/api/v1/orchestration/runs/run%2F1/checkpoints",
    );
    await expectCall(
      platform.cancelOrchestrationRun("run/1", { actorId: "operator", workspaceId: "workspace/1" }),
      "/api/v1/orchestration/runs/run%2F1/cancel",
      {
        method: "POST",
        body: JSON.stringify({ actorId: "operator", workspaceId: "workspace/1" }),
      },
    );
    await expectCall(platform.fetchLlmConfig(), "/api/v1/llm/config");
    await expectCall(platform.fetchLlmModels("openai/codex"), "/api/v1/llm/models?providerId=openai%2Fcodex");
    await expectCall(platform.fetchLlmModels(), "/api/v1/llm/models");
    await expectCall(
      platform.fetchLlmProviderAdvice({ preference: "low_cost", maxCandidates: 2 }),
      "/api/v1/llm/provider-advice",
      {
        method: "POST",
      },
    );
    await expectCall(
      platform.fetchLlmRuntimeMeasurements({ providerId: "openai", model: "gpt 5", limit: 2 }),
      "/api/v1/llm/runtime-measurements?providerId=openai&model=gpt+5&limit=2",
    );
    await expectCall(platform.fetchLlmLocalEngines(), "/api/v1/llm/local-engines");
    await expectCall(platform.fetchLlmEvalProofRuns(999), "/api/v1/llm/eval-proof?limit=200");
    await expectCall(platform.runLlmEvalProof({ prompt: "compare" }), "/api/v1/llm/eval-proof", {
      method: "POST",
    });
    await expectCall(platform.fetchAssemblyRuns(25), "/api/v1/assembly/runs?limit=25");
    await expectCall(platform.createAssemblyRun({} as never), "/api/v1/assembly/runs", { method: "POST" });
    await expectCall(platform.fetchAssemblyRunDetail("run/1"), "/api/v1/assembly/runs/run%2F1");
    await expectCall(platform.fetchAssemblyReputations(12), "/api/v1/assembly/reputation?limit=12");
    await expectCall(
      platform.previewLlmModels({ providerId: "p", baseUrl: "http://x" }),
      "/api/v1/llm/models/preview",
      {
        method: "POST",
      },
    );
    await expectCall(platform.generateLlmImage({} as never), "/api/v1/llm/images", { method: "POST" });
    await expectCall(platform.createLlmChatCompletion({ messages: [] }), "/api/v1/llm/chat-completions", {
      method: "POST",
    });
    await expectCall(platform.fetchProviderSecretStatus("provider/1"), "/api/v1/secrets/providers/provider%2F1/status");
    await expectCall(platform.saveProviderSecret("provider/1", "key"), "/api/v1/secrets/providers/provider%2F1", {
      method: "POST",
    });
    await expectCall(platform.deleteProviderSecret("provider/1"), "/api/v1/secrets/providers/provider%2F1", {
      method: "DELETE",
    });
    await expectCall(platform.fetchOpenAICodexOAuthStatus(), "/api/v1/llm/providers/openai-codex/oauth/status");
    await expectCall(
      platform.startOpenAICodexOAuthDeviceFlow(),
      "/api/v1/llm/providers/openai-codex/oauth/device/start",
      {
        method: "POST",
      },
    );
    await expectCall(
      platform.pollOpenAICodexOAuthDeviceFlow("flow"),
      "/api/v1/llm/providers/openai-codex/oauth/device/poll",
      {
        method: "POST",
      },
    );
    await expectCall(platform.deleteOpenAICodexOAuthCredential(), "/api/v1/llm/providers/openai-codex/oauth", {
      method: "DELETE",
    });
    await expectCall(platform.fetchMeshStatus(), "/api/v1/mesh/status");
    await expectCall(platform.fetchMeshNodes(), "/api/v1/mesh/nodes?limit=200");
    await expectCall(platform.fetchMeshLeases(5), "/api/v1/mesh/leases?limit=5");
    await expectCall(platform.fetchMeshSessionOwners(), "/api/v1/mesh/sessions/owners?limit=500");
    await expectCall(platform.fetchMeshReplicationOffsets(), "/api/v1/mesh/replication/offsets?limit=500");
    await expectCall(platform.fetchNpuStatus(), "/api/v1/npu/status");
    await expectCall(platform.fetchNpuModels(), "/api/v1/npu/models");
    await expectCall(platform.startNpuRuntime(), "/api/v1/npu/start", { method: "POST" });
    await expectCall(platform.stopNpuRuntime(), "/api/v1/npu/stop", { method: "POST" });
    await expectCall(platform.refreshNpuRuntime(), "/api/v1/npu/refresh", { method: "POST" });
    await expectCall(platform.fetchLlamaCppStatus(), "/api/v1/llamacpp/status");
    await expectCall(platform.fetchLlamaCppModels(), "/api/v1/llamacpp/models");
    await expectCall(platform.detectLlamaCppInstall(), "/api/v1/llamacpp/install");
    await expectCall(
      platform.startLlamaCppHuggingFaceDownload({ repo: "r", filename: "f" }),
      "/api/v1/llamacpp/huggingface/download",
      {
        method: "POST",
      },
    );
    await expectCall(
      platform.fetchLlamaCppHuggingFaceDownload("job/1"),
      "/api/v1/llamacpp/huggingface/downloads/job%2F1",
    );
    await expectCall(
      platform.cancelLlamaCppHuggingFaceDownload("job/1"),
      "/api/v1/llamacpp/huggingface/downloads/job%2F1/cancel",
      {
        method: "POST",
      },
    );
    await expectCall(platform.startLlamaCppRuntime(), "/api/v1/llamacpp/start", { method: "POST" });
    await expectCall(platform.stopLlamaCppRuntime(), "/api/v1/llamacpp/stop", { method: "POST" });
    await expectCall(platform.refreshLlamaCppRuntime(), "/api/v1/llamacpp/refresh", { method: "POST" });
    await expectCall(platform.fetchLlamaCppAdvisor({} as never), "/api/v1/llamacpp/advisor", { method: "POST" });
    await expectCall(platform.fetchDaemonStatus(), "/api/v1/daemon/status");
    await expectCall(platform.startDaemon(), "/api/v1/daemon/start", { method: "POST" });
    await expectCall(platform.stopDaemon(), "/api/v1/daemon/stop", { method: "POST" });
    await expectCall(platform.restartDaemon(), "/api/v1/daemon/restart", { method: "POST" });
    await expectCall(platform.fetchDaemonLogs(9999), "/api/v1/daemon/logs?tail=2000");
    await expectCall(
      platform.evaluateUiChangeRisk({ pageId: "settings", changes: [] }),
      "/api/v1/ui/change-risk/evaluate",
      {
        method: "POST",
      },
    );
  });
});
