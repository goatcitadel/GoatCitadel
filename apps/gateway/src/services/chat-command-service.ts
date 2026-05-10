/**
 * Chat slash-command parser/dispatcher.
 *
 * Parses chat slash commands and dispatches them through an explicit command
 * runtime deps. Pure parsing helpers stay separate from mutable command
 * execution.
 */

import type {
  ChatMode,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatThinkingLevel,
  ChatWebMode,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  McpServerRecord,
  McpServerTemplateRecord,
  PersonalityCatalogResponse,
  ResearchSummaryRecord,
} from "@goatcitadel/contracts";
import { getPersonalityPreset, normalizePersonalityId } from "./channel-personalities.js";
import { parseDelegateCommand, parsePipelineCommand, parseSlashCommand } from "./chat-command-helpers.js";
import { handleGoalCommand } from "./chat-goal-command.js";
import { parseChatModelCommandTarget } from "./chat-model-command.js";
import { normalizePromptTestCode, clampPromptScore } from "./prompt-pack-service.js";

export interface ChatCommandDependencies {
  readonly storage: {
    chatSessionMeta: {
      ensure(sessionId: string): { workspaceId?: string };
    };
    chatSessionProjects: {
      get(sessionId: string): { projectId: string } | undefined;
    };
  };
  assignChatSessionProject(sessionId: string, projectId?: string): { projectId?: string };
  connectMcpServer(serverId: string): Promise<McpServerRecord>;
  createChatSession(input: { workspaceId?: string; title?: string; projectId?: string }): ChatSessionRecord;
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
  }): McpServerRecord;
  disconnectMcpServer(serverId: string): McpServerRecord;
  getChatSessionPrefs(sessionId: string): ChatSessionPrefsRecord;
  getMemoryMaintenanceStatus(workspaceId: string): {
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
  };
  getSession(sessionId: string): unknown;
  getSettings(): {
    llm: {
      activeProviderId?: string;
      activeModel?: string;
    };
  };
  getPersonalityCatalog(): PersonalityCatalogResponse;
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: { role: "user" | "assistant"; sourceRef: string },
  ): void;
  installSkillImport(input: { sourceRef: string; confirmHighRisk?: boolean }): Promise<{ installedSkillId?: string }>;
  listChatSessionLearnedMemory(
    sessionId: string,
    limit?: number,
  ): { items: LearnedMemoryItemRecord[]; conflicts: LearnedMemoryConflictRecord[] };
  listMcpServers(): McpServerRecord[];
  listMcpTemplates(): Array<McpServerTemplateRecord & { installed: boolean }>;
  listSkills(): Array<{ skillId: string; state: string; note?: string }>;
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
  normalizeWorkspaceId(workspaceId?: string): string;
  resolveChatToolApproval(sessionId: string, approvalId: string, decision: "approve" | "reject"): Promise<unknown>;
  runChatDelegation(
    sessionId: string,
    input: {
      objective: string;
      roles: string[];
      mode: "sequential";
      surfaceMode?: ChatMode;
      steps?: Array<{
        stepId: string;
        index: number;
        role: string;
        dependsOnStepIds?: string[];
      }>;
    },
  ): Promise<{
    runId: string;
    taskId?: string;
    steps: import("@goatcitadel/contracts").ChatDelegationStepRecord[];
    stitchedOutput?: string;
  }>;
  runChatResearch(
    sessionId: string,
    input: {
      query: string;
      mode: "quick";
    },
  ): Promise<ResearchSummaryRecord>;
  runMemoryMaintenanceNow(input: { workspaceId: string; triggerSource: "manual" }): { runId: string };
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
  setSkillState(
    skillId: string,
    state: "enabled" | "sleep" | "disabled",
    reason: string,
  ): { skillId: string; state: string };
  setDefaultPersonality(id: string): PersonalityCatalogResponse;
  updateChatSessionPrefs(sessionId: string, patch: Record<string, unknown>): ChatSessionPrefsRecord;
  updateChatSessionProactivePolicy(sessionId: string, patch: Record<string, unknown>): { mode: ChatProactiveMode };
  updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: { status?: "active" | "superseded" | "disabled"; content?: string; confidence?: number },
  ): LearnedMemoryItemRecord;
  validateSkillImport(input: { sourceRef: string }): Promise<{
    valid: boolean;
    errors: string[];
    riskLevel?: string;
    inferredSkillName?: string;
  }>;
}

export type ChatCommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  message: string;
  prefs?: ChatSessionPrefsRecord;
  research?: ResearchSummaryRecord;
  session?: ChatSessionRecord;
};

export interface ChatCommandCatalogItem {
  command: string;
  usage: string;
  description: string;
}

export function listChatCommandCatalog(): ChatCommandCatalogItem[] {
  return [
    { command: "/new", usage: "/new [title]", description: "Start a fresh session." },
    { command: "/mode", usage: "/mode chat|cowork|code", description: "Switch session mode." },
    { command: "/plan", usage: "/plan [on|off]", description: "Show or set advisory planning mode." },
    {
      command: "/model",
      usage: "/model <model-id|provider-id/model-id>",
      description: "Override provider/model for this session.",
    },
    { command: "/web", usage: "/web auto|off|quick|deep", description: "Set web retrieval behavior." },
    { command: "/memory", usage: "/memory auto|on|off", description: "Set memory behavior." },
    {
      command: "/goal",
      usage: "/goal [pause|resume|clear|<objective>] [--max-iterations N] [--budget-usd N]",
      description: "Run a bounded implement-and-test loop toward a verifiable goal.",
    },
    {
      command: "/personality",
      usage: "/personality [id|none]",
      description: "Show or set the global Chat personality default.",
    },
    { command: "/dream", usage: "/dream", description: "Run workspace memory maintenance now." },
    { command: "/dream", usage: "/dream status", description: "Show workspace memory maintenance status." },
    { command: "/think", usage: "/think off|minimal|standard|extended|deep", description: "Set thinking depth." },
    { command: "/tool", usage: "/tool safe_auto|manual", description: "Set tool autonomy mode." },
    {
      command: "/proactive",
      usage: "/proactive off|suggest|auto_safe|auto_full",
      description: "Set proactive mode.",
    },
    { command: "/retrieval", usage: "/retrieval standard|layered", description: "Set retrieval routing mode." },
    { command: "/reflect", usage: "/reflect off|on", description: "Toggle reflection retry mode." },
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
      description: "Change an installed skill's runtime state.",
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
      description: "Validate and install a skill, disabled by default.",
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
): Promise<ChatCommandResult> {
  deps.getSession(sessionId);
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
    const sourcePrefs = deps.getChatSessionPrefs(sessionId);
    const sourceProjectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
    const session = deps.createChatSession({
      workspaceId: deps.storage.chatSessionMeta.ensure(sessionId).workspaceId,
      title: args.join(" ").trim() || undefined,
      projectId: sourceProjectId,
    });
    const {
      sessionId: _sourceSessionId,
      createdAt: _sourceCreatedAt,
      updatedAt: _sourceUpdatedAt,
      ...prefsPatch
    } = sourcePrefs;
    const prefs = deps.updateChatSessionPrefs(session.sessionId, prefsPatch);
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
    const mode = (args[0] ?? "").toLowerCase() as ChatMode;
    if (mode !== "chat" && mode !== "cowork" && mode !== "code") {
      return { ok: false, command, args, message: "Usage: /mode chat|cowork|code" };
    }
    const prefs = deps.updateChatSessionPrefs(sessionId, { mode });
    return { ok: true, command, args, prefs, message: `Mode set to ${prefs.mode}.` };
  }

  if (command === "/plan") {
    const next = (args[0] ?? "").toLowerCase();
    if (!next) {
      const prefs = deps.getChatSessionPrefs(sessionId);
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
    const prefs = deps.updateChatSessionPrefs(sessionId, {
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
    const prefs = deps.updateChatSessionPrefs(sessionId, {
      providerId: target.providerId,
      model: target.model,
    });
    const label = target.providerId ? `${target.providerId}/${prefs.model}` : prefs.model;
    return { ok: true, command, args, prefs, message: `Model set to ${label}.` };
  }

  if (command === "/web") {
    const webMode = (args[0] ?? "").toLowerCase() as ChatWebMode;
    if (!["auto", "off", "quick", "deep"].includes(webMode)) {
      return { ok: false, command, args, message: "Usage: /web auto|off|quick|deep" };
    }
    const prefs = deps.updateChatSessionPrefs(sessionId, { webMode });
    return { ok: true, command, args, prefs, message: `Web mode set to ${prefs.webMode}.` };
  }

  if (command === "/memory") {
    const memoryMode = (args[0] ?? "").toLowerCase() as "auto" | "on" | "off";
    if (!["auto", "on", "off"].includes(memoryMode)) {
      return { ok: false, command, args, message: "Usage: /memory auto|on|off" };
    }
    const prefs = deps.updateChatSessionPrefs(sessionId, { memoryMode });
    return { ok: true, command, args, prefs, message: `Memory mode set to ${prefs.memoryMode}.` };
  }

  if (command === "/goal") {
    const result = await handleGoalCommand(deps, sessionId, args);
    return {
      ok: result.ok,
      command,
      args,
      message: result.message,
    };
  }

  if (command === "/personality") {
    const requested = args.join(" ").trim();
    const catalog = deps.getPersonalityCatalog();
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
    const updated = deps.setDefaultPersonality(normalized);
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
    const workspaceId = deps.normalizeWorkspaceId(deps.storage.chatSessionMeta.ensure(sessionId).workspaceId);
    const subcommand = (args[0] ?? "").toLowerCase();
    if (!subcommand) {
      const run = deps.runMemoryMaintenanceNow({ workspaceId, triggerSource: "manual" });
      return {
        ok: true,
        command,
        args,
        message: `Memory maintenance queued for ${workspaceId} (${run.runId}).`,
      };
    }
    if (subcommand === "status") {
      const status = deps.getMemoryMaintenanceStatus(workspaceId);
      const providerId = status.policy.providerId ?? deps.getSettings().llm.activeProviderId;
      const model = status.policy.model ?? deps.getSettings().llm.activeModel;
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

  if (command === "/think") {
    const thinkingLevel = (args[0] ?? "").toLowerCase() as ChatThinkingLevel;
    if (!["off", "minimal", "standard", "extended", "deep"].includes(thinkingLevel)) {
      return { ok: false, command, args, message: "Usage: /think off|minimal|standard|extended|deep" };
    }
    const prefs = deps.updateChatSessionPrefs(sessionId, { thinkingLevel });
    return { ok: true, command, args, prefs, message: `Thinking level set to ${prefs.thinkingLevel}.` };
  }

  if (command === "/speed") {
    const speedMode = (args[0] ?? "").toLowerCase() as "standard" | "fast";
    if (!["standard", "fast"].includes(speedMode)) {
      return { ok: false, command, args, message: "Usage: /speed standard|fast" };
    }
    const prefs = deps.updateChatSessionPrefs(sessionId, { speedMode });
    return { ok: true, command, args, prefs, message: `Speed mode set to ${prefs.speedMode}.` };
  }

  if (command === "/subagents") {
    const subagentPolicy = (args[0] ?? "").toLowerCase() as "off" | "ask_when_useful" | "auto_when_useful";
    if (!["off", "ask_when_useful", "auto_when_useful"].includes(subagentPolicy)) {
      return { ok: false, command, args, message: "Usage: /subagents off|ask_when_useful|auto_when_useful" };
    }
    const prefs = deps.updateChatSessionPrefs(sessionId, { subagentPolicy });
    return { ok: true, command, args, prefs, message: `Subagent policy set to ${prefs.subagentPolicy}.` };
  }

  if (command === "/tool") {
    const toolAutonomy = (args[0] ?? "").toLowerCase() as "safe_auto" | "manual";
    if (!["safe_auto", "manual"].includes(toolAutonomy)) {
      return { ok: false, command, args, message: "Usage: /tool safe_auto|manual" };
    }
    const prefs = deps.updateChatSessionPrefs(sessionId, { toolAutonomy });
    return { ok: true, command, args, prefs, message: `Tool autonomy set to ${prefs.toolAutonomy}.` };
  }

  if (command === "/proactive") {
    const proactiveMode = (args[0] ?? "").toLowerCase() as ChatProactiveMode;
    if (!["off", "suggest", "auto_safe", "auto_full"].includes(proactiveMode)) {
      return { ok: false, command, args, message: "Usage: /proactive off|suggest|auto_safe|auto_full" };
    }
    const policy = deps.updateChatSessionProactivePolicy(sessionId, { proactiveMode });
    const prefs = deps.getChatSessionPrefs(sessionId);
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
    deps.updateChatSessionProactivePolicy(sessionId, { retrievalMode });
    const prefs = deps.getChatSessionPrefs(sessionId);
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
    deps.updateChatSessionProactivePolicy(sessionId, { reflectionMode });
    const prefs = deps.getChatSessionPrefs(sessionId);
    return {
      ok: true,
      command,
      args,
      prefs,
      message: `Reflection mode set to ${reflectionMode}.`,
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
    });
    return {
      ok: true,
      command,
      args,
      message: `Delegation ${run.runId} completed with ${run.steps.length} steps.`,
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
    });
    return {
      ok: true,
      command,
      args,
      message: `Pipeline ${parsedPipeline.template} completed (${run.steps.length} steps).`,
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
    const skills = deps.listSkills();
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
      const updated = deps.setSkillState(skillId, state, `Updated from chat command ${commandText.trim()}`);
      return {
        ok: true,
        command,
        args,
        message: `Skill ${updated.skillId} is now ${updated.state}.`,
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
      const installed = await deps.installSkillImport({ sourceRef, confirmHighRisk });
      return {
        ok: true,
        command,
        args,
        message: `Installed ${installed.installedSkillId ?? validation.inferredSkillName ?? sourceRef}. Skill starts disabled by default.`,
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

  if (command === "/mcp") {
    const action = (args[0] ?? "").toLowerCase();
    if (!action) {
      const servers = deps.listMcpServers();
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
        updated = action === "connect" ? await deps.connectMcpServer(serverId) : deps.disconnectMcpServer(serverId);
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
      const templates = deps.listMcpTemplates().filter((template) => {
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
      const template = deps.listMcpTemplates().find((item) => item.templateId.toLowerCase() === templateId);
      if (!template) {
        return { ok: false, command, args, message: `Unknown MCP template ${templateId}.` };
      }
      const existing = deps
        .listMcpServers()
        .find((server) => server.label.toLowerCase() === template.label.toLowerCase());
      if (existing) {
        return {
          ok: true,
          command,
          args,
          message: `MCP template ${template.templateId} already exists as ${existing.serverId}.`,
        };
      }
      const created = deps.createMcpServer({
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
    const updated = deps.assignChatSessionProject(
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
    await deps.resolveChatToolApproval(sessionId, approvalId, "approve");
    return { ok: true, command, args, message: `Approved ${approvalId}.` };
  }

  if (command === "/deny") {
    const approvalId = args[0]?.trim();
    if (!approvalId) {
      return { ok: false, command, args, message: "Usage: /deny <approval-id>" };
    }
    await deps.resolveChatToolApproval(sessionId, approvalId, "reject");
    return { ok: true, command, args, message: `Denied ${approvalId}.` };
  }

  return {
    ok: false,
    command,
    args,
    message: `Unknown command ${command}. Use /help.`,
  };
}
