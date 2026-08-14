/* eslint-disable max-lines -- Chat command parser/dispatcher keeps slash-command surface centralized so handler dispatch, lookup, and lifecycle stay traceable in one place. */
/**
 * Chat slash-command parser/dispatcher.
 *
 * Parses chat slash commands and dispatches them through an explicit command
 * runtime deps. Pure parsing helpers stay separate from mutable command
 * execution.
 */

import type {
  ChatMode,
  ChatDelegateResponse,
  ChatChangePlanCreateInput,
  ChatChangePlanRecord,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSessionListQuery,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatThinkingLevel,
  ChatWebMode,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  MemoryItemRecord,
  McpServerRecord,
  McpServerTemplateRecord,
  PersonalityCatalogResponse,
  ResearchSummaryRecord,
  SkillImportSourceType,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import type { SkillLearningHistoryPage, SkillLearningResult } from "./skill-learning-service.js";
import { getPersonalityPreset, normalizePersonalityId } from "./channel-personalities.js";
import { parseDelegateCommand, parsePipelineCommand, parseSlashCommand } from "./chat-command-helpers.js";
import { handleGoalCommand } from "./chat-goal-command.js";
import { parseChatModelCommandTarget } from "./chat-model-command.js";
import { normalizePromptTestCode, clampPromptScore } from "./prompt-pack-service.js";

export interface ChatCommandDependencies {
  readonly storage: {
    chatSessionMeta: {
      ensure(sessionId: string): Promise<{ workspaceId?: string }>;
    };
    chatSessionProjects: {
      get(sessionId: string): Promise<{ projectId: string } | undefined>;
    };
  };
  assignChatSessionProject(sessionId: string, projectId?: string): Promise<{ projectId?: string }>;
  connectMcpServer(serverId: string): Promise<McpServerRecord>;
  createChatChangePlan(
    sessionId: string,
    input: Omit<ChatChangePlanCreateInput, "sessionId">,
  ): Promise<ChatChangePlanRecord>;
  createChatSession(input: { workspaceId?: string; title?: string; projectId?: string }): Promise<ChatSessionRecord>;
  createMcpServer(input: {
    label: string;
    transport: McpServerRecord["transport"];
    command?: string;
    args?: string[];
    url?: string;
    authType?: McpServerRecord["authType"];
    enabled?: boolean;
    category?: McpServerRecord["category"];
    trustTier?: McpServerRecord["trustTier"];
    costTier?: McpServerRecord["costTier"];
    policy?: McpServerRecord["policy"];
  }): Promise<McpServerRecord>;
  learnSkillFromLatestTurn(input: {
    sessionId: string;
    correction: string;
    actor: { actorId?: string; authActorSource?: ToolPolicyActorContext["authActorSource"] };
    idempotencyKey?: string;
  }): Promise<SkillLearningResult>;
  createSkillLearningHistoryDryRun(input: {
    sessionId: string;
    actor: { actorId?: string; authActorSource?: ToolPolicyActorContext["authActorSource"] };
    cursor?: string;
  }): Promise<SkillLearningHistoryPage>;
  applySkillLearningHistorySelection(input: {
    sessionId: string;
    selectionToken: string;
    reviewOutcome: "selected";
    actor: { actorId?: string; authActorSource?: ToolPolicyActorContext["authActorSource"] };
    idempotencyKey?: string;
  }): Promise<SkillLearningResult>;
  disconnectMcpServer(serverId: string): Promise<McpServerRecord>;
  getChatSessionPrefs(sessionId: string): Promise<ChatSessionPrefsRecord>;
  getMemoryMaintenanceStatus(workspaceId: string): Promise<{
    policy: {
      enabled: boolean;
      runMode: string;
      timingStrategy: string;
      providerId?: string;
      model?: string;
      executionTarget: string;
      unavailableModelPolicy: string;
      schedule?: { frequency: string; hour: number; minute: number };
      timeZone: string;
    };
    state: { changedSessionCount: number };
    lastRun?: { status: string; updatedAt: string };
    nextDueAt?: string;
  }>;
  getSession(sessionId: string): Promise<unknown>;
  getSettings(): Promise<{
    llm: {
      activeProviderId?: string;
      activeModel?: string;
    };
  }>;
  getPersonalityCatalog(): Promise<PersonalityCatalogResponse>;
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: { role: "user" | "assistant"; sourceRef: string },
  ): Promise<void>;
  /**
   * HX-402 P2: the legacy executable install is retired; this resolves to a
   * structured redirect into the governed Skill Hub review surface and never
   * publishes bytes.
   */
  installSkillImport(input: { sourceRef: string; confirmHighRisk?: boolean }): Promise<{
    disposition: "redirected_to_skill_hub";
    redirect: {
      reviewRoute: string;
      sourceRef: string;
      sourceType?: string;
      eligible: boolean;
      ineligibleReason?: string;
    };
  }>;
  listChatSessionLearnedMemory(
    sessionId: string,
    limit?: number,
  ): Promise<{ items: LearnedMemoryItemRecord[]; conflicts: LearnedMemoryConflictRecord[] }>;
  listChatSessions(query?: ChatSessionListQuery): Promise<ChatSessionRecord[]>;
  listMemoryItems(input?: {
    namespace?: string;
    workspaceId?: string;
    status?: MemoryItemRecord["status"] | "all";
    query?: string;
    limit?: number;
  }): Promise<MemoryItemRecord[]>;
  listMcpServers(): Promise<McpServerRecord[]>;
  listMcpTemplates(): Promise<Array<McpServerTemplateRecord & { installed: boolean }>>;
  listSkills(): Promise<Array<{ skillId: string; state: string; note?: string }>>;
  listSkillSources(
    query: string,
    limit: number,
  ): Promise<{
    items: Array<{
      name: string;
      sourceProvider: string;
      installability?: string;
      matchReason?: string;
      sourceUrl: string;
    }>;
  }>;
  lookupSkillSources(
    query: string,
    limit: number,
  ): Promise<{
    bestMatch?: {
      name: string;
      sourceProvider: string;
      matchReason?: string;
      installability?: string;
      sourceUrl: string;
      upstreamUrl?: string;
      installHint?: string;
    };
    items: Array<{
      name: string;
      sourceProvider: string;
      matchReason?: string;
      installability?: string;
      sourceUrl: string;
      upstreamUrl?: string;
      installHint?: string;
    }>;
  }>;
  normalizeWorkspaceId(workspaceId?: string): Promise<string>;
  resolveChatToolApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
    options?: { resolvedBy?: string },
  ): Promise<unknown>;
  runChatDelegation(
    sessionId: string,
    input: {
      objective: string;
      roles: string[];
      mode: "sequential";
      surfaceMode?: ChatMode;
      policyRunId?: string;
      policyTaskId?: string;
      operatorId?: string;
      authActorId?: string;
      authActorSource?: ToolPolicyActorContext["authActorSource"];
      permissionProfileId?: string;
      localOperatorOverrideId?: string;
      surface?: ToolPolicyActorContext["surface"];
      steps?: Array<{
        stepId: string;
        index: number;
        role: string;
        dependsOnStepIds?: string[];
      }>;
    },
  ): Promise<ChatDelegateResponse>;
  runChatResearch(
    sessionId: string,
    input: {
      query: string;
      mode: "quick";
      policyRunId?: string;
      policyTaskId?: string;
      operatorId?: string;
      authActorId?: string;
      authActorSource?: ToolPolicyActorContext["authActorSource"];
      permissionProfileId?: string;
      localOperatorOverrideId?: string;
      surface?: ToolPolicyActorContext["surface"];
    },
  ): Promise<ResearchSummaryRecord>;
  runMemoryMaintenanceNow(input: { workspaceId: string; triggerSource: "manual" }): Promise<{ runId: string }>;
  undoChatTurns(
    sessionId: string,
    count: number,
    options?: { operatorId?: string },
  ): Promise<{
    undoneCount: number;
    requestedCount: number;
    removedTurnIds: string[];
    removedMessageCount: number;
    activeLeafTurnId?: string;
  }>;
  runPromptPackFromChat(sessionId: string, selector: string): Promise<unknown[]>;
  scorePromptPackLatestRunByCode(input: {
    sessionId?: string;
    testCode: string;
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
    notes?: string;
  }): Promise<{ overrideVerdict?: string }>;
  /**
   * HX-402 P2: approval-first — requests one canonical `skill.lifecycle`
   * approval (or reports a pure no-op) and never mutates directly.
   */
  setSkillState(
    skillId: string,
    state: "enabled" | "sleep" | "disabled",
    reason: string,
  ): Promise<
    | { pendingApproval: { approvalId: string; status: string } }
    | { pendingApproval: null; noMutationRequired: true; skillState: { skillId: string; state: string } }
  >;
  setDefaultPersonality(id: string): Promise<PersonalityCatalogResponse>;
  updateChatSessionPrefs(sessionId: string, patch: Record<string, unknown>): Promise<ChatSessionPrefsRecord>;
  updateChatSessionProactivePolicy(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<{ mode: ChatProactiveMode }>;
  updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: { status?: "active" | "superseded" | "disabled"; content?: string; confidence?: number },
  ): Promise<LearnedMemoryItemRecord>;
  validateSkillImport(input: { sourceRef: string; sourceType?: SkillImportSourceType }): Promise<{
    valid: boolean;
    errors: string[];
    riskLevel?: string;
    inferredSkillName?: string;
    candidate?: {
      name?: string;
      compatibility?: {
        callability?: string;
      };
    };
  }>;
}

export type ChatCommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  message: string;
  changePlan?: ChatChangePlanRecord;
  prefs?: ChatSessionPrefsRecord;
  research?: ResearchSummaryRecord;
  session?: ChatSessionRecord;
  learning?: SkillLearningResult;
  learningHistory?: SkillLearningHistoryPage;
};

export type ChatCommandOptions = {
  resolvedBy?: string;
  source?: "chat" | "channel";
  channelContext?: {
    platform: "telegram" | "discord" | string;
    account?: string;
    actorId?: string;
    workspaceId?: string;
  };
  policyRunId?: string;
  policyTaskId?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: ToolPolicyActorContext["surface"];
  idempotencyKey?: string;
};

export interface ChatCommandCatalogItem {
  command: string;
  usage: string;
  description: string;
}

export function listChatCommandCatalog(): ChatCommandCatalogItem[] {
  return [
    { command: "/new", usage: "/new [title]", description: "Start a fresh session." },
    { command: "/mode", usage: "/mode", description: "Show the current Chat surface." },
    { command: "/plan", usage: "/plan [on|off]", description: "Show or set advisory planning mode." },
    {
      command: "/model",
      usage: "/model <model-id|provider-id/model-id>",
      description: "Override provider/model for this session.",
    },
    { command: "/web", usage: "/web auto|off|quick|deep", description: "Set web retrieval behavior." },
    {
      command: "/memory",
      usage: "/memory auto|on|off or /memory <query>",
      description: "Set memory behavior, or search learned memory from a channel.",
    },
    {
      command: "/recall",
      usage: "/recall <query>",
      description: "Search persisted session transcript history from a channel.",
    },
    {
      command: "/search",
      usage: "/search <query>",
      description: "Search learned memory and session history from a channel.",
    },
    {
      command: "/goal",
      usage: "/goal [pause|resume|clear|<objective>] [--max-iterations N] [--budget-usd N]",
      description: "Run a bounded implement-and-test loop toward a verifiable goal.",
    },
    {
      command: "/subgoal",
      usage: "/subgoal <objective> [--max-iterations N] [--budget-usd N]",
      description: "Route a smaller objective through the governed goal/decomposition path.",
    },
    {
      command: "/personality",
      usage: "/personality [id|none]",
      description: "Show or set the global Chat personality default.",
    },
    { command: "/dream", usage: "/dream", description: "Run workspace memory maintenance now." },
    { command: "/dream", usage: "/dream status", description: "Show workspace memory maintenance status." },
    {
      command: "/status",
      usage: "/status",
      description: "Open canonical session status without sending a model turn.",
    },
    {
      command: "/timer",
      usage: "/timer",
      description: "Create a provider-free Chat reminder with an explicit confirmation form.",
    },
    { command: "/undo", usage: "/undo [N]", description: "Remove the last N completed turns from this session." },
    {
      command: "/think",
      usage: "/think off|minimal|standard|extended|deep|max|ultra",
      description: "Set thinking depth; max/ultra require explicit model support.",
    },
    { command: "/speed", usage: "/speed standard|fast", description: "Set response speed preference." },
    {
      command: "/subagents",
      usage: "/subagents off|ask_when_useful|auto_when_useful",
      description: "Set governed subagent delegation behavior.",
    },
    { command: "/tool", usage: "/tool safe_auto|manual", description: "Set tool autonomy mode." },
    {
      command: "/proactive",
      usage: "/proactive off|suggest|auto_safe|auto_full",
      description: "Set proactive mode.",
    },
    { command: "/retrieval", usage: "/retrieval standard|layered", description: "Set retrieval routing mode." },
    { command: "/reflect", usage: "/reflect off|on", description: "Toggle reflection retry mode." },
    {
      command: "/learn",
      usage: "/learn into candidate skill <correction>",
      description: "Record an explicit correction as governed evidence; stage only an inactive recurring candidate.",
    },
    {
      command: "/learn",
      usage: "/learn history [cursor]",
      description: "Dry-run bounded history corrections without writing candidates or memory.",
    },
    {
      command: "/learn",
      usage: "/learn apply <selection-token>",
      description: "Apply one explicitly selected history correction through the governed learning path.",
    },
    { command: "/research", usage: "/research <query>", description: "Run quick research for current session." },
    {
      command: "/delegate",
      usage: "/delegate <role1,role2,...> :: <objective>",
      description: "Run task-backed role delegation.",
    },
    {
      command: "/pipeline",
      usage: "/pipeline prd|build|triage|release :: <objective>",
      description: "Run a built-in delegation template.",
    },
    {
      command: "/score",
      usage: "/score <TEST-##> <routing> <honesty> <handoff> <robustness> <usability>",
      description: "Score the latest run for a prompt-pack test.",
    },
    { command: "/pack", usage: "/pack run <TEST-##|all>", description: "Run prompt-pack tests from Prompt Lab." },
    { command: "/skills", usage: "/skills", description: "List installed skills and their runtime state." },
    {
      command: "/skill",
      usage: "/skill enable|sleep|disable <skillId>",
      description: "Request an approval to change an installed skill's runtime state.",
    },
    { command: "/skill", usage: "/skill search <query>", description: "Search skill import sources." },
    {
      command: "/skill",
      usage: "/skill lookup <query-or-url>",
      description: "Resolve the best-fit skill source or listing.",
    },
    {
      command: "/skill",
      usage: "/skill install <sourceRef> [--confirm-high-risk]",
      description: "Validate a skill and redirect installation into the governed Skill Hub review.",
    },
    {
      command: "/skill-bundle",
      usage: "/skill-bundle <url>",
      description: "Create a review-only skill bundle import receipt without activation.",
    },
    { command: "/mcp", usage: "/mcp", description: "List configured MCP servers and connection state." },
    {
      command: "/mcp",
      usage: "/mcp connect|disconnect <serverId>",
      description: "Connect or disconnect a configured MCP server.",
    },
    { command: "/mcp", usage: "/mcp templates [query]", description: "List known MCP server templates." },
    {
      command: "/mcp",
      usage: "/mcp add-template <templateId>",
      description: "Add an MCP template definition in a disconnected state.",
    },
    {
      command: "/project",
      usage: "/project <project-id|none>",
      description: "Assign or clear this session project.",
    },
    {
      command: "/attach",
      usage: "/attach <attachment-id>",
      description: "Reference an attachment id in your next send.",
    },
    { command: "/run", usage: "/run research <query>", description: "Run a named workflow from chat." },
    { command: "/approve", usage: "/approve <approval-id>", description: "Approve a pending inline tool request." },
    { command: "/deny", usage: "/deny <approval-id>", description: "Deny a pending inline tool request." },
    { command: "/help", usage: "/help", description: "Show command catalog." },
  ];
}

export async function parseChatCommand(
  deps: ChatCommandDependencies,
  sessionId: string,
  commandText: string,
  options?: ChatCommandOptions,
): Promise<ChatCommandResult> {
  await deps.getSession(sessionId);
  const parsed = parseSlashCommand(commandText);
  if (!parsed) {
    return {
      ok: false,
      command: "",
      args: [],
      message: "Command must start with '/'.",
    };
  }

  const [head, ...args] = parsed;
  const command = (head ?? "").toLowerCase();
  if (!command) {
    return {
      ok: false,
      command: "",
      args: [],
      message: "Command must include a command name after '/'.",
    };
  }

  if (command === "/help") {
    const help = listChatCommandCatalog()
      .map((item) => `${item.usage} - ${item.description}`)
      .join("\n");
    return {
      ok: true,
      command,
      args,
      message: help,
    };
  }

  if (command === "/new") {
    const [sourcePrefs, sourceProject, sourceMeta] = await Promise.all([
      deps.getChatSessionPrefs(sessionId),
      deps.storage.chatSessionProjects.get(sessionId),
      deps.storage.chatSessionMeta.ensure(sessionId),
    ]);
    const session = await deps.createChatSession({
      workspaceId: sourceMeta.workspaceId,
      title: args.join(" ").trim() || undefined,
      projectId: sourceProject?.projectId,
    });
    const {
      sessionId: _sourceSessionId,
      createdAt: _sourceCreatedAt,
      updatedAt: _sourceUpdatedAt,
      ...prefsPatch
    } = sourcePrefs;
    const prefs = await deps.updateChatSessionPrefs(session.sessionId, prefsPatch);
    return {
      ok: true,
      command,
      args,
      prefs,
      session,
      message: session.title
        ? `Started new session "${session.title}" (${session.sessionId.slice(-6)}).`
        : `Started new session (${session.sessionId.slice(-6)}).`,
    };
  }

  if (command === "/mode") {
    const prefs = await deps.updateChatSessionPrefs(sessionId, { mode: "chat" });
    return {
      ok: true,
      command,
      args,
      prefs,
      message:
        "Mission Control uses Chat as the only conversation surface. Planning, tools, and Code Mode run inside Chat.",
    };
  }

  if (command === "/plan") {
    const next = (args[0] ?? "").toLowerCase();
    if (!next) {
      const prefs = await deps.getChatSessionPrefs(sessionId);
      return {
        ok: true,
        command,
        args,
        prefs,
        message: `Planning mode is ${prefs.planningMode}.`,
      };
    }
    if (next !== "on" && next !== "off") {
      return { ok: false, command, args, message: "Usage: /plan [on|off]" };
    }
    const prefs = await deps.updateChatSessionPrefs(sessionId, {
      planningMode: next === "on" ? "advisory" : "off",
    });
    return {
      ok: true,
      command,
      args,
      prefs,
      message: `Planning mode set to ${prefs.planningMode}.`,
    };
  }

  if (command === "/model") {
    const target = parseChatModelCommandTarget(args.join(" "));
    if (!target) {
      return { ok: false, command, args, message: "Usage: /model <model-id|provider-id/model-id>" };
    }
    const changePlan = await deps.createChatChangePlan(sessionId, {
      request: {
        kind: "session_model",
        ...(target.providerId ? { providerId: target.providerId } : {}),
        model: target.model,
      },
    });
    return {
      ok: true,
      command,
      args,
      changePlan,
      message: `${changePlan.summary} Review and confirm this change plan in Chat before it applies.`,
    };
  }

  if (command === "/web") {
    const webMode = (args[0] ?? "").toLowerCase() as ChatWebMode;
    if (!["auto", "off", "quick", "deep"].includes(webMode)) {
      return { ok: false, command, args, message: "Usage: /web auto|off|quick|deep" };
    }
    const prefs = await deps.updateChatSessionPrefs(sessionId, { webMode });
    return { ok: true, command, args, prefs, message: `Web mode set to ${prefs.webMode}.` };
  }

  if (command === "/memory") {
    const memoryMode = (args[0] ?? "").toLowerCase() as "auto" | "on" | "off";
    if (!["auto", "on", "off"].includes(memoryMode)) {
      if (options?.source === "channel") {
        return renderChannelLookupCommand(deps, sessionId, command, args, options);
      }
      return { ok: false, command, args, message: "Usage: /memory auto|on|off" };
    }
    const prefs = await deps.updateChatSessionPrefs(sessionId, { memoryMode });
    return { ok: true, command, args, prefs, message: `Memory mode set to ${prefs.memoryMode}.` };
  }

  if (command === "/recall" || command === "/search") {
    if (options?.source !== "channel") {
      return { ok: false, command, args, message: `Usage: ${command} <query>` };
    }
    return renderChannelLookupCommand(deps, sessionId, command, args, options);
  }

  if (command === "/goal") {
    const result = await handleGoalCommand(deps, sessionId, args, {
      policyRunId: options?.policyRunId,
      policyTaskId: options?.policyTaskId,
      operatorId: options?.operatorId ?? options?.authActorId ?? options?.resolvedBy,
      authActorId: options?.authActorId,
      authActorSource: options?.authActorSource,
      permissionProfileId: options?.permissionProfileId,
      localOperatorOverrideId: options?.localOperatorOverrideId,
      surface: options?.surface ?? "chat",
    });
    return {
      ok: result.ok,
      command,
      args,
      message: result.message,
    };
  }

  if (command === "/subgoal") {
    const objective = args.join(" ").trim();
    if (!objective || ["pause", "resume", "clear"].includes(objective.toLowerCase())) {
      return { ok: false, command, args, message: "Usage: /subgoal <objective> [--max-iterations N] [--budget-usd N]" };
    }
    const result = await handleGoalCommand(deps, sessionId, args, {
      policyRunId: options?.policyRunId,
      policyTaskId: options?.policyTaskId,
      operatorId: options?.operatorId ?? options?.authActorId ?? options?.resolvedBy,
      authActorId: options?.authActorId,
      authActorSource: options?.authActorSource,
      permissionProfileId: options?.permissionProfileId,
      localOperatorOverrideId: options?.localOperatorOverrideId,
      surface: options?.surface ?? "chat",
    });
    return {
      ok: result.ok,
      command,
      args,
      message: result.ok ? `Subgoal routed through /goal.\n${result.message}` : result.message,
    };
  }

  if (command === "/personality") {
    const requested = args.join(" ").trim();
    const catalog = await deps.getPersonalityCatalog();
    if (!requested) {
      const active = getPersonalityPreset(catalog.defaultPersonalityId, catalog.items);
      return {
        ok: true,
        command,
        args,
        message: [
          `Current Chat personality: ${active.label} (${active.id}).`,
          "",
          "Available personalities:",
          ...catalog.items.map((preset) => `- ${preset.id}: ${preset.description}`),
          "",
          "Use /personality <id> to set the global Chat default, or /personality none to clear it.",
        ].join("\n"),
      };
    }
    const normalized = normalizePersonalityId(requested);
    if (!catalog.items.some((item) => item.id === normalized)) {
      return {
        ok: false,
        command,
        args,
        message: `Unknown personality "${requested}". Use /personality to list available presets.`,
      };
    }
    const updated = await deps.setDefaultPersonality(normalized);
    const active = getPersonalityPreset(updated.defaultPersonalityId, updated.items);
    return {
      ok: true,
      command,
      args,
      message:
        active.id === "default"
          ? "Chat personality cleared. GoatCitadel will use the default voice."
          : `Chat personality set to ${active.label} (${active.id}).`,
    };
  }

  if (command === "/dream") {
    const sessionMeta = await deps.storage.chatSessionMeta.ensure(sessionId);
    const workspaceId = await deps.normalizeWorkspaceId(sessionMeta.workspaceId);
    const subcommand = (args[0] ?? "").toLowerCase();
    if (!subcommand) {
      const run = await deps.runMemoryMaintenanceNow({ workspaceId, triggerSource: "manual" });
      return {
        ok: true,
        command,
        args,
        message: `Memory maintenance queued for ${workspaceId} (${run.runId}).`,
      };
    }
    if (subcommand === "status") {
      const [status, settings] = await Promise.all([deps.getMemoryMaintenanceStatus(workspaceId), deps.getSettings()]);
      const providerId = status.policy.providerId ?? settings.llm.activeProviderId;
      const model = status.policy.model ?? settings.llm.activeModel;
      const providerMode = status.policy.providerId || status.policy.model ? "pinned" : "active default";
      const scheduleSummary = status.policy.schedule
        ? `${status.policy.schedule.frequency} ${String(status.policy.schedule.hour).padStart(2, "0")}:${String(status.policy.schedule.minute).padStart(2, "0")} ${status.policy.timeZone}`
        : "manual only";
      return {
        ok: true,
        command,
        args,
        message: [
          `Workspace: ${workspaceId}`,
          `Enabled: ${status.policy.enabled ? "yes" : "no"}`,
          `Mode: ${status.policy.runMode} / ${status.policy.timingStrategy}`,
          `Provider/model: ${providerId}/${model} (${providerMode})`,
          `Execution target: ${status.policy.executionTarget} (${status.policy.unavailableModelPolicy} if unavailable)`,
          `Schedule: ${scheduleSummary}`,
          `Changed sessions: ${status.state.changedSessionCount}`,
          `Last run: ${status.lastRun ? `${status.lastRun.status} at ${status.lastRun.updatedAt}` : "none"}`,
          `Next due: ${status.nextDueAt ?? "not scheduled"}`,
        ].join("\n"),
      };
    }
    return { ok: false, command, args, message: "Usage: /dream | /dream status" };
  }

  if (command === "/undo") {
    const requested = args[0] ?? "1";
    if (args.length > 1 || !/^\d+$/.test(requested)) {
      return { ok: false, command, args, message: "Usage: /undo [N]" };
    }
    const count = Number.parseInt(requested, 10);
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
      return { ok: false, command, args, message: "Usage: /undo [N], where N is between 1 and 20." };
    }
    const result = await deps.undoChatTurns(sessionId, count, {
      operatorId: options?.operatorId ?? options?.authActorId ?? options?.resolvedBy,
    });
    if (result.undoneCount === 0) {
      return {
        ok: true,
        command,
        args,
        message: "No completed turns were available to undo.",
      };
    }
    const active = result.activeLeafTurnId
      ? ` Active turn is now ${result.activeLeafTurnId}.`
      : " Session is now empty.";
    return {
      ok: true,
      command,
      args,
      message: `Undid ${result.undoneCount} turn${result.undoneCount === 1 ? "" : "s"} and removed ${result.removedMessageCount} message${result.removedMessageCount === 1 ? "" : "s"}.${active}`,
    };
  }

  if (command === "/think") {
    const thinkingLevel = (args[0] ?? "").toLowerCase() as ChatThinkingLevel;
    if (!["off", "minimal", "standard", "extended", "deep", "max", "ultra"].includes(thinkingLevel)) {
      return { ok: false, command, args, message: "Usage: /think off|minimal|standard|extended|deep|max|ultra" };
    }
    const changePlan = await deps.createChatChangePlan(sessionId, {
      request: { kind: "session_model", thinkingLevel },
    });
    return {
      ok: true,
      command,
      args,
      changePlan,
      message: `${changePlan.summary} Review and confirm this change plan in Chat before it applies.`,
    };
  }

  if (command === "/speed") {
    const speedMode = (args[0] ?? "").toLowerCase() as "standard" | "fast";
    if (!["standard", "fast"].includes(speedMode)) {
      return { ok: false, command, args, message: "Usage: /speed standard|fast" };
    }
    const prefs = await deps.updateChatSessionPrefs(sessionId, { speedMode });
    return { ok: true, command, args, prefs, message: `Speed mode set to ${prefs.speedMode}.` };
  }

  if (command === "/subagents") {
    const subagentPolicy = (args[0] ?? "").toLowerCase() as "off" | "ask_when_useful" | "auto_when_useful";
    if (!["off", "ask_when_useful", "auto_when_useful"].includes(subagentPolicy)) {
      return { ok: false, command, args, message: "Usage: /subagents off|ask_when_useful|auto_when_useful" };
    }
    const prefs = await deps.updateChatSessionPrefs(sessionId, { subagentPolicy });
    return { ok: true, command, args, prefs, message: `Subagent policy set to ${prefs.subagentPolicy}.` };
  }

  if (command === "/tool") {
    const toolAutonomy = (args[0] ?? "").toLowerCase() as "safe_auto" | "manual";
    if (!["safe_auto", "manual"].includes(toolAutonomy)) {
      return { ok: false, command, args, message: "Usage: /tool safe_auto|manual" };
    }
    const prefs = await deps.updateChatSessionPrefs(sessionId, { toolAutonomy });
    return { ok: true, command, args, prefs, message: `Tool autonomy set to ${prefs.toolAutonomy}.` };
  }

  if (command === "/proactive") {
    const proactiveMode = (args[0] ?? "").toLowerCase() as ChatProactiveMode;
    if (!["off", "suggest", "auto_safe", "auto_full"].includes(proactiveMode)) {
      return { ok: false, command, args, message: "Usage: /proactive off|suggest|auto_safe|auto_full" };
    }
    const policy = await deps.updateChatSessionProactivePolicy(sessionId, { proactiveMode });
    const prefs = await deps.getChatSessionPrefs(sessionId);
    return {
      ok: true,
      command,
      args,
      prefs,
      message: `Proactive mode set to ${policy.mode}.`,
    };
  }

  if (command === "/retrieval") {
    const retrievalMode = (args[0] ?? "").toLowerCase() as ChatRetrievalMode;
    if (!["standard", "layered"].includes(retrievalMode)) {
      return { ok: false, command, args, message: "Usage: /retrieval standard|layered" };
    }
    await deps.updateChatSessionProactivePolicy(sessionId, { retrievalMode });
    const prefs = await deps.getChatSessionPrefs(sessionId);
    return {
      ok: true,
      command,
      args,
      prefs,
      message: `Retrieval mode set to ${retrievalMode}.`,
    };
  }

  if (command === "/reflect") {
    const reflectionMode = (args[0] ?? "").toLowerCase() as ChatReflectionMode;
    if (!["off", "on"].includes(reflectionMode)) {
      return { ok: false, command, args, message: "Usage: /reflect off|on" };
    }
    await deps.updateChatSessionProactivePolicy(sessionId, { reflectionMode });
    const prefs = await deps.getChatSessionPrefs(sessionId);
    return {
      ok: true,
      command,
      args,
      prefs,
      message: `Reflection mode set to ${reflectionMode}.`,
    };
  }

  if (command === "/learn") {
    const actor = {
      actorId: options?.authActorId,
      authActorSource: options?.authActorSource,
    };
    const exactCorrection = /^\/learn[ \t]+into[ \t]+candidate[ \t]+skill[ \t]([\s\S]+)$/iu.exec(commandText)?.[1];
    if (exactCorrection !== undefined) {
      const learning = await deps.learnSkillFromLatestTurn({
        sessionId,
        correction: exactCorrection,
        actor,
        idempotencyKey: options?.idempotencyKey,
      });
      return {
        ok: true,
        command,
        args,
        learning,
        message: renderSkillLearningResult(learning),
      };
    }
    if ((args[0] ?? "").toLowerCase() === "history" && args.length <= 2) {
      const learningHistory = await deps.createSkillLearningHistoryDryRun({
        sessionId,
        actor,
        cursor: args[1],
      });
      return {
        ok: true,
        command,
        args,
        learningHistory,
        message: renderSkillLearningHistory(learningHistory),
      };
    }
    if ((args[0] ?? "").toLowerCase() === "apply" && args.length === 2 && args[1]) {
      const learning = await deps.applySkillLearningHistorySelection({
        sessionId,
        selectionToken: args[1],
        reviewOutcome: "selected",
        actor,
        idempotencyKey: options?.idempotencyKey,
      });
      return { ok: true, command, args, learning, message: renderSkillLearningResult(learning) };
    }
    return {
      ok: false,
      command,
      args,
      message:
        "Usage: /learn into candidate skill <correction> | /learn history [cursor] | /learn apply <selection-token>",
    };
  }

  if (command === "/research") {
    const query = args.join(" ").trim();
    if (!query) {
      return { ok: false, command, args, message: "Usage: /research <query>" };
    }
    const research = await deps.runChatResearch(sessionId, {
      query,
      mode: "quick",
      policyRunId: options?.policyRunId,
      policyTaskId: options?.policyTaskId,
      operatorId: options?.operatorId ?? options?.authActorId ?? options?.resolvedBy,
      authActorId: options?.authActorId,
      authActorSource: options?.authActorSource,
      permissionProfileId: options?.permissionProfileId,
      localOperatorOverrideId: options?.localOperatorOverrideId,
      surface: options?.surface ?? "chat",
    });
    return {
      ok: true,
      command,
      args,
      research,
      message: research.summary,
    };
  }

  if (command === "/delegate") {
    const { roles, objective, error } = parseDelegateCommand(commandText);
    if (error || !objective || roles.length === 0) {
      return { ok: false, command, args, message: "Usage: /delegate <role1,role2,...> :: <objective>" };
    }
    const run = await deps.runChatDelegation(sessionId, {
      objective,
      roles,
      mode: "sequential",
      policyRunId: options?.policyRunId,
      policyTaskId: options?.policyTaskId,
      operatorId: options?.operatorId ?? options?.authActorId ?? options?.resolvedBy,
      authActorId: options?.authActorId,
      authActorSource: options?.authActorSource,
      permissionProfileId: options?.permissionProfileId,
      localOperatorOverrideId: options?.localOperatorOverrideId,
      surface: options?.surface ?? "chat",
    });
    return {
      ok: true,
      command,
      args,
      message: `Delegation ${run.runId} ${formatDelegationCommandStatus(run.status)} with ${run.steps.length} steps.`,
    };
  }

  if (command === "/pipeline") {
    const parsedPipeline = parsePipelineCommand(commandText);
    if (!parsedPipeline) {
      return { ok: false, command, args, message: "Usage: /pipeline prd|build|triage|release :: <objective>" };
    }
    const run = await deps.runChatDelegation(sessionId, {
      objective: parsedPipeline.objective,
      roles: parsedPipeline.roles,
      mode: "sequential",
      policyRunId: options?.policyRunId,
      policyTaskId: options?.policyTaskId,
      operatorId: options?.operatorId ?? options?.authActorId ?? options?.resolvedBy,
      authActorId: options?.authActorId,
      authActorSource: options?.authActorSource,
      permissionProfileId: options?.permissionProfileId,
      localOperatorOverrideId: options?.localOperatorOverrideId,
      surface: options?.surface ?? "chat",
    });
    return {
      ok: true,
      command,
      args,
      message: `Pipeline ${parsedPipeline.template} ${formatDelegationCommandStatus(run.status)} (${run.steps.length} steps).`,
    };
  }

  if (command === "/score") {
    const [testCodeRaw, routingRaw, honestyRaw, handoffRaw, robustnessRaw, usabilityRaw, ...noteParts] = args;
    if (
      !testCodeRaw ||
      [routingRaw, honestyRaw, handoffRaw, robustnessRaw, usabilityRaw].some((item) => item === undefined)
    ) {
      return {
        ok: false,
        command,
        args,
        message: "Usage: /score <TEST-##> <routing> <honesty> <handoff> <robustness> <usability>",
      };
    }
    const score = await deps.scorePromptPackLatestRunByCode({
      sessionId,
      testCode: normalizePromptTestCode(testCodeRaw),
      routingScore: clampPromptScore(routingRaw!),
      honestyScore: clampPromptScore(honestyRaw!),
      handoffScore: clampPromptScore(handoffRaw!),
      robustnessScore: clampPromptScore(robustnessRaw!),
      usabilityScore: clampPromptScore(usabilityRaw!),
      notes: noteParts.join(" ").trim() || undefined,
    });
    return {
      ok: true,
      command,
      args,
      message: `Recorded review for ${testCodeRaw}${score.overrideVerdict ? ` (${score.overrideVerdict})` : ""}.`,
    };
  }

  if (command === "/pack") {
    const subcommand = (args[0] ?? "").toLowerCase();
    if (subcommand !== "run") {
      return { ok: false, command, args, message: "Usage: /pack run <TEST-##|all>" };
    }
    const selector = normalizePromptTestCode(args[1] ?? "all");
    const results = await deps.runPromptPackFromChat(sessionId, selector);
    return {
      ok: true,
      command,
      args,
      message: `Prompt pack run complete: ${results.length} test(s) executed.`,
    };
  }

  if (command === "/skills") {
    const skills = await deps.listSkills();
    if (skills.length === 0) {
      return { ok: true, command, args, message: "No installed skills found." };
    }
    return {
      ok: true,
      command,
      args,
      message: skills
        .slice(0, 20)
        .map((skill) => `- ${skill.skillId} [${skill.state}]${skill.note ? ` - ${skill.note}` : ""}`)
        .join("\n"),
    };
  }

  if (command === "/skill") {
    const action = (args[0] ?? "").toLowerCase();
    if (action === "enable" || action === "sleep" || action === "disable") {
      const skillId = args.slice(1).join(" ").trim();
      if (!skillId) {
        return { ok: false, command, args, message: `Usage: /skill ${action} <skillId>` };
      }
      const state = action === "enable" ? "enabled" : action === "sleep" ? "sleep" : "disabled";
      // HX-402 P2: skill state changes are approval-first — the command
      // requests one canonical skill.lifecycle approval and never mutates.
      const outcome = await deps.setSkillState(skillId, state, `Requested from chat command ${commandText.trim()}`);
      if (!outcome.pendingApproval) {
        const skillState = "skillState" in outcome ? outcome.skillState : undefined;
        return {
          ok: true,
          command,
          args,
          message: `Skill ${skillState?.skillId ?? skillId} is already ${skillState?.state ?? state}; nothing to approve.`,
        };
      }
      return {
        ok: true,
        command,
        args,
        message: `Approval required: resolve approval ${outcome.pendingApproval.approvalId} to set ${skillId} to ${state}. No change has been applied yet.`,
      };
    }
    if (action === "search") {
      const query = args.slice(1).join(" ").trim();
      if (!query) {
        return { ok: false, command, args, message: "Usage: /skill search <query>" };
      }
      const results = await deps.listSkillSources(query, 5);
      if (results.items.length === 0) {
        return { ok: true, command, args, message: `No skill source matches found for "${query}".` };
      }
      return {
        ok: true,
        command,
        args,
        message: results.items
          .slice(0, 5)
          .map((item) => {
            const reason = item.matchReason ? ` - ${item.matchReason}` : "";
            const installability = item.installability ? ` [${item.installability}]` : "";
            return `- ${item.name} (${item.sourceProvider}${installability})${reason} - ${item.sourceUrl}`;
          })
          .join("\n"),
      };
    }
    if (action === "lookup") {
      const query = args.slice(1).join(" ").trim();
      if (!query) {
        return { ok: false, command, args, message: "Usage: /skill lookup <query-or-url>" };
      }
      const result = await deps.lookupSkillSources(query, 5);
      const bestMatch = result.bestMatch ?? result.items[0];
      if (!bestMatch) {
        return { ok: true, command, args, message: `No skill source resolution found for "${query}".` };
      }
      const lines = [
        `Best match: ${bestMatch.name} (${bestMatch.sourceProvider})`,
        `Why: ${bestMatch.matchReason ?? "best ranked match"}`,
        `Installability: ${bestMatch.installability ?? "review_only"}`,
        `Source: ${bestMatch.sourceUrl}`,
      ];
      if (bestMatch.upstreamUrl && bestMatch.upstreamUrl !== bestMatch.sourceUrl) {
        lines.push(`Upstream: ${bestMatch.upstreamUrl}`);
      }
      if (bestMatch.installHint) {
        lines.push(`Next step: ${bestMatch.installHint}`);
      }
      return {
        ok: true,
        command,
        args,
        message: lines.join("\n"),
      };
    }
    if (action === "install") {
      const confirmHighRisk = args.includes("--confirm-high-risk");
      const sourceRef = args
        .filter((item) => item !== "--confirm-high-risk")
        .slice(1)
        .join(" ")
        .trim();
      if (!sourceRef) {
        return {
          ok: false,
          command,
          args,
          message: "Usage: /skill install <sourceRef> [--confirm-high-risk]",
        };
      }
      const validation = await deps.validateSkillImport({ sourceRef });
      if (!validation.valid) {
        return {
          ok: false,
          command,
          args,
          message: `Skill import rejected: ${validation.errors.join("; ") || "validation failed"}`,
        };
      }
      if (validation.riskLevel === "high" && !confirmHighRisk) {
        return {
          ok: false,
          command,
          args,
          message: "High-risk skill import requires --confirm-high-risk.",
        };
      }
      // HX-402 P2: executable install is retired — validation stays advisory
      // and the governed Skill Hub review/approval flow is the only install
      // authority. Nothing is published from this command.
      const redirected = await deps.installSkillImport({ sourceRef, confirmHighRisk });
      const name = validation.inferredSkillName ?? sourceRef;
      if (!redirected.redirect.eligible) {
        return {
          ok: false,
          command,
          args,
          message: `Validated ${name}, but no executable install happened: ${
            redirected.redirect.ineligibleReason ?? "the source is not eligible for the governed Skill Hub review."
          }`,
        };
      }
      return {
        ok: true,
        command,
        args,
        message: `Validated ${name}. Executable installs are governed by the Skill Hub: submit ${redirected.redirect.sourceRef} through ${redirected.redirect.reviewRoute} (source type ${redirected.redirect.sourceType ?? "git_url"}) and resolve its approval. Nothing was installed by this command.`,
      };
    }
    return {
      ok: false,
      command,
      args,
      message:
        "Usage: /skill enable|sleep|disable <skillId> | /skill search <query> | /skill lookup <query-or-url> | /skill install <sourceRef> [--confirm-high-risk]",
    };
  }

  if (command === "/skill-bundle") {
    const sourceRef = args.join(" ").trim();
    if (!sourceRef) {
      return { ok: false, command, args, message: "Usage: /skill-bundle <url>" };
    }
    const validation = await deps.validateSkillImport({ sourceRef, sourceType: "remote_bundle" });
    const candidateName = validation.candidate?.name ?? validation.inferredSkillName ?? sourceRef;
    const callability = validation.candidate?.compatibility?.callability ?? "review_only";
    const lines = [
      `Skill bundle review receipt: ${candidateName}`,
      `Source: ${sourceRef}`,
      `Status: ${validation.valid ? "valid for review" : "rejected"}`,
      `Risk: ${validation.riskLevel ?? "unknown"}`,
      `Callability: ${callability}`,
      "Activation: none. No skill was installed or made callable.",
    ];
    if (validation.errors.length > 0) {
      lines.push(`Findings: ${validation.errors.join("; ")}`);
    }
    return {
      ok: validation.valid,
      command,
      args,
      message: lines.join("\n"),
    };
  }

  if (command === "/mcp") {
    const action = (args[0] ?? "").toLowerCase();
    if (!action) {
      const servers = await deps.listMcpServers();
      if (servers.length === 0) {
        return { ok: true, command, args, message: "No MCP servers configured." };
      }
      return {
        ok: true,
        command,
        args,
        message: servers
          .slice(0, 20)
          .map(
            (server) => `- ${server.serverId} ${server.label} [${server.status}]${server.enabled ? "" : " disabled"}`,
          )
          .join("\n"),
      };
    }
    if (action === "connect" || action === "disconnect") {
      const serverId = args.slice(1).join(" ").trim();
      if (!serverId) {
        return { ok: false, command, args, message: `Usage: /mcp ${action} <serverId>` };
      }
      let updated: McpServerRecord;
      try {
        updated =
          action === "connect" ? await deps.connectMcpServer(serverId) : await deps.disconnectMcpServer(serverId);
      } catch (error) {
        return {
          ok: false,
          command,
          args,
          message: (error as Error).message,
        };
      }
      return {
        ok: true,
        command,
        args,
        message: `MCP server ${updated.serverId} is now ${updated.status}.`,
      };
    }
    if (action === "templates") {
      const query = args.slice(1).join(" ").trim().toLowerCase();
      const templates = (await deps.listMcpTemplates()).filter((template) => {
        if (!query) {
          return true;
        }
        const haystack = `${template.templateId} ${template.label} ${template.description}`.toLowerCase();
        return haystack.includes(query);
      });
      if (templates.length === 0) {
        return {
          ok: true,
          command,
          args,
          message: query ? `No MCP templates match "${query}".` : "No MCP templates available.",
        };
      }
      return {
        ok: true,
        command,
        args,
        message: templates
          .slice(0, 10)
          .map((template) => `- ${template.templateId} ${template.label}${template.installed ? " [installed]" : ""}`)
          .join("\n"),
      };
    }
    if (action === "add-template") {
      const templateId = args.slice(1).join(" ").trim().toLowerCase();
      if (!templateId) {
        return { ok: false, command, args, message: "Usage: /mcp add-template <templateId>" };
      }
      const template = (await deps.listMcpTemplates()).find((item) => item.templateId.toLowerCase() === templateId);
      if (!template) {
        return { ok: false, command, args, message: `Unknown MCP template ${templateId}.` };
      }
      const existing = (await deps.listMcpServers()).find(
        (server) => server.label.toLowerCase() === template.label.toLowerCase(),
      );
      if (existing) {
        return {
          ok: true,
          command,
          args,
          message: `MCP template ${template.templateId} already exists as ${existing.serverId}.`,
        };
      }
      const created = await deps.createMcpServer({
        label: template.label,
        transport: template.transport,
        command: template.command,
        args: template.args,
        url: template.url,
        authType: template.authType,
        enabled: false,
        category: template.category,
        trustTier: template.trustTier,
        costTier: template.costTier,
        policy: template.policy,
      });
      return {
        ok: true,
        command,
        args,
        message: `Added MCP template ${template.templateId} as ${created.serverId}. It is disconnected until you connect it.`,
      };
    }
    return {
      ok: false,
      command,
      args,
      message:
        "Usage: /mcp | /mcp connect <serverId> | /mcp disconnect <serverId> | /mcp templates [query] | /mcp add-template <templateId>",
    };
  }

  if (command === "/project") {
    const nextProject = args.join(" ").trim();
    const updated = await deps.assignChatSessionProject(
      sessionId,
      !nextProject || nextProject === "none" ? undefined : nextProject,
    );
    return {
      ok: true,
      command,
      args,
      message: updated.projectId ? `Session assigned to project ${updated.projectId}.` : "Session project cleared.",
    };
  }

  if (command === "/attach") {
    const attachmentId = args.join(" ").trim();
    if (!attachmentId) {
      return { ok: false, command, args, message: "Usage: /attach <attachment-id>" };
    }
    return {
      ok: true,
      command,
      args,
      message: `Attachment ${attachmentId} noted. Include it in your next message send.`,
    };
  }

  if (command === "/run") {
    const workflow = (args[0] ?? "").toLowerCase();
    if (workflow !== "research") {
      return { ok: false, command, args, message: "Usage: /run research <query>" };
    }
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      return { ok: false, command, args, message: "Usage: /run research <query>" };
    }
    const research = await deps.runChatResearch(sessionId, {
      query,
      mode: "quick",
      policyRunId: options?.policyRunId,
      policyTaskId: options?.policyTaskId,
      operatorId: options?.operatorId ?? options?.authActorId ?? options?.resolvedBy,
      authActorId: options?.authActorId,
      authActorSource: options?.authActorSource,
      permissionProfileId: options?.permissionProfileId,
      localOperatorOverrideId: options?.localOperatorOverrideId,
      surface: options?.surface ?? "chat",
    });
    return {
      ok: true,
      command,
      args,
      research,
      message: research.summary,
    };
  }

  if (command === "/approve") {
    const approvalId = args[0]?.trim();
    if (!approvalId) {
      return { ok: false, command, args, message: "Usage: /approve <approval-id>" };
    }
    await deps.resolveChatToolApproval(sessionId, approvalId, "approve", {
      resolvedBy: resolveCommandActor(options),
    });
    return { ok: true, command, args, message: `Approved ${approvalId}.` };
  }

  if (command === "/deny") {
    const approvalId = args[0]?.trim();
    if (!approvalId) {
      return { ok: false, command, args, message: "Usage: /deny <approval-id>" };
    }
    await deps.resolveChatToolApproval(sessionId, approvalId, "reject", {
      resolvedBy: resolveCommandActor(options),
    });
    return { ok: true, command, args, message: `Denied ${approvalId}.` };
  }

  return {
    ok: false,
    command,
    args,
    message: `Unknown command ${command}. Use /help.`,
  };
}

type ChannelLookupResult = {
  source: "memory" | "recall";
  id: string;
  label: string;
  excerpt: string;
  updatedAt?: string;
};

async function renderChannelLookupCommand(
  deps: ChatCommandDependencies,
  sessionId: string,
  command: string,
  args: string[],
  options: ChatCommandOptions,
): Promise<ChatCommandResult> {
  const query = args.join(" ").trim();
  if (!query) {
    return {
      ok: false,
      command,
      args,
      message: `Usage: ${command} <query>`,
    };
  }
  const sessionMeta = await deps.storage.chatSessionMeta.ensure(sessionId);
  const workspaceId = await deps.normalizeWorkspaceId(options.channelContext?.workspaceId ?? sessionMeta.workspaceId);
  const memoryResults = command === "/recall" ? [] : await searchChannelMemory(deps, sessionId, workspaceId, query);
  const recallResults =
    command === "/memory" ? [] : await searchChannelSessions(deps, sessionId, workspaceId, query, options);
  const results = [...memoryResults, ...recallResults].slice(0, 5);
  const actorCopy = options.channelContext?.actorId
    ? ` requester ${options.channelContext.actorId}`
    : " this requester";
  const scopeCopy = `Results are scoped to${actorCopy} and workspace ${workspaceId}.`;
  if (results.length === 0) {
    return {
      ok: true,
      command,
      args,
      message: `${scopeCopy}\nNo ${describeLookupKind(command)} results matched "${query}".`,
    };
  }
  return {
    ok: true,
    command,
    args,
    message: [
      scopeCopy,
      `${describeLookupKind(command)} results for "${query}":`,
      ...results.map((item) => `- [${item.id.slice(0, 8)}] ${item.label}: ${truncateLookupLine(item.excerpt)}`),
    ].join("\n"),
  };
}

async function searchChannelMemory(
  deps: ChatCommandDependencies,
  sessionId: string,
  workspaceId: string,
  query: string,
): Promise<ChannelLookupResult[]> {
  const lowerQuery = query.toLowerCase();
  const learnedMemory = await deps.listChatSessionLearnedMemory(sessionId, 50);
  const learned = learnedMemory.items
    .filter((item) => item.status === "active" && item.content.toLowerCase().includes(lowerQuery))
    .map((item) => ({
      source: "memory" as const,
      id: item.itemId,
      label: item.itemType,
      excerpt: item.content,
      updatedAt: item.updatedAt,
    }));
  let lifecycle: ChannelLookupResult[];
  try {
    lifecycle = (await deps.listMemoryItems({ workspaceId, status: "active", query, limit: 5 })).map((item) => ({
      source: "memory" as const,
      id: item.itemId,
      label: item.title || item.namespace,
      excerpt: item.content,
      updatedAt: item.updatedAt,
    }));
  } catch {
    lifecycle = [];
  }
  return dedupeLookupResults([...learned, ...lifecycle]).slice(0, 5);
}

async function searchChannelSessions(
  deps: ChatCommandDependencies,
  sessionId: string,
  workspaceId: string,
  query: string,
  options: ChatCommandOptions,
): Promise<ChannelLookupResult[]> {
  const channel = options.channelContext?.platform;
  const account = options.channelContext?.account;
  return (await deps.listChatSessions({ workspaceId, q: query, limit: 20, includeHidden: false }))
    .filter((session) => {
      if (session.sessionId === sessionId) {
        return true;
      }
      if (!channel) {
        return false;
      }
      return session.channel === channel && (!account || session.account === account);
    })
    .slice(0, 5)
    .map((session) => {
      const firstHit = session.searchHits?.[0];
      return {
        source: "recall" as const,
        id: firstHit?.messageId ?? session.sessionId,
        label: session.title ?? session.sessionKey,
        excerpt: firstHit?.excerpt ?? session.title ?? session.sessionKey,
        updatedAt: session.updatedAt,
      };
    });
}

function dedupeLookupResults(items: ChannelLookupResult[]): ChannelLookupResult[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source}:${item.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function describeLookupKind(command: string): string {
  if (command === "/memory") {
    return "Memory";
  }
  if (command === "/recall") {
    return "Recall";
  }
  return "Memory and recall";
}

function truncateLookupLine(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= 110 ? oneLine : `${oneLine.slice(0, 107).trimEnd()}...`;
}

function resolveCommandActor(options: ChatCommandOptions | undefined): string {
  return options?.resolvedBy?.trim() || options?.authActorId?.trim() || options?.operatorId?.trim() || "chat-command";
}

function renderSkillLearningResult(result: SkillLearningResult): string {
  const recurrence = `${result.recurrence.distinctSessionCount}/${result.recurrence.minimumDistinctSessions} distinct sessions`;
  const boundary = "No durable memory was written and nothing was made callable.";
  if (result.outcome === "candidate_created") {
    return [
      `Staged inactive learned candidate ${result.candidateId} (${result.versionId}) from ${recurrence}.`,
      `Review proposal: ${result.proposalId}. Separate evaluation, approval, and promotion are still required.`,
      boundary,
    ].join("\n");
  }
  if (result.outcome === "evidence_recorded") {
    const status = result.recurrence.automaticStagingEligible
      ? "The evidence is linked to the existing governed candidate; no new version or proposal was created."
      : "The recurrence threshold is not met, so no candidate or proposal was created.";
    return [`Recorded clean correction evidence ${result.evidenceId} (${recurrence}).`, status, boundary].join("\n");
  }
  const blockers = result.blockerCodes.length > 0 ? result.blockerCodes.join(", ") : "unspecified_guard";
  return [
    `Recorded ${result.outcome} correction evidence ${result.evidenceId}; candidate staging was denied (${blockers}).`,
    boundary,
  ].join("\n");
}

function renderSkillLearningHistory(page: SkillLearningHistoryPage): string {
  const lines = [
    `History learning dry-run at sequence ${page.highWater.snapshotMaxSequence}; ${page.items.length} selection(s) pending explicit review.`,
    "Dry-run only: no candidate, proposal, or memory write occurred.",
  ];
  for (const item of page.items) {
    lines.push(
      "",
      `${item.selectionId}: ${item.title}${item.secretLike ? " [secret-like; previews suppressed]" : ""}`,
      `correction provenance: ${renderCorrectionOrigin(item.correctionOrigin)}; actor ${item.correctionActor.actorType}/${item.correctionActor.actorIdLabel}; actor sha256 ${item.correctionActor.actorIdSha256}`,
      `source sha256 ${item.sourceSha256}; correction sha256 ${item.correctionSha256}`,
      ...(item.sourcePreview ? [`source: ${item.sourcePreview}`] : []),
      ...(item.correctionPreview ? [`correction: ${item.correctionPreview}`] : []),
      `Apply: /learn apply ${item.selectionToken}`,
    );
  }
  if (page.nextCursor) lines.push("", `Continue: /learn history ${page.nextCursor}`);
  return lines.join("\n");
}

function renderCorrectionOrigin(origin: SkillLearningHistoryPage["items"][number]["correctionOrigin"]): string {
  switch (origin) {
    case "authenticated_operator":
      return "authenticated operator";
    case "model":
      return "model/agent (will quarantine)";
    case "tool":
      return "tool (will quarantine)";
    case "browser":
      return "browser/external (will quarantine)";
    default:
      return "unknown/foreign (will quarantine)";
  }
}

function formatDelegationCommandStatus(status: string | undefined): string {
  switch (status) {
    case "running":
      return "is waiting";
    case "partial":
      return "finished partially";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    default:
      return "finished";
  }
}
