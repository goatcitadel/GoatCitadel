/**
 * Chat slash-command parser/dispatcher.
 *
 * Body-move home for `parseChatCommand`, previously a 670-line method on
 * GatewayService. The function is dispatch-style: parses the leading
 * slash command and delegates to existing public host methods.
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
  McpServerRecord,
  ResearchSummaryRecord,
} from "@goatcitadel/contracts";
import { parseChatModelCommandTarget } from "./chat-model-command.js";
import { normalizePromptTestCode, clampPromptScore } from "./prompt-pack-service.js";
import {
  MCP_SERVER_TEMPLATES,
  parseDelegateCommand,
  parsePipelineCommand,
  parseSlashCommand,
  type GatewayService,
} from "./gateway-service.js";

export type ChatCommandHost = GatewayService;

export type ChatCommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  message: string;
  prefs?: ChatSessionPrefsRecord;
  research?: ResearchSummaryRecord;
  session?: ChatSessionRecord;
};

export async function parseChatCommand(
  host: ChatCommandHost,
  sessionId: string,
  commandText: string,
): Promise<ChatCommandResult> {
  host.getSession(sessionId);
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
    const help = host
      .listChatCommandCatalog()
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
    const sourcePrefs = host.getChatSessionPrefs(sessionId);
    const sourceProjectId = host.storage.chatSessionProjects.get(sessionId)?.projectId;
    const session = host.createChatSession({
      workspaceId: host.storage.chatSessionMeta.ensure(sessionId).workspaceId,
      title: args.join(" ").trim() || undefined,
      projectId: sourceProjectId,
    });
    const {
      sessionId: _sourceSessionId,
      createdAt: _sourceCreatedAt,
      updatedAt: _sourceUpdatedAt,
      ...prefsPatch
    } = sourcePrefs;
    const prefs = host.updateChatSessionPrefs(session.sessionId, prefsPatch);
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
    const prefs = host.updateChatSessionPrefs(sessionId, { mode });
    return { ok: true, command, args, prefs, message: `Mode set to ${prefs.mode}.` };
  }

  if (command === "/plan") {
    const next = (args[0] ?? "").toLowerCase();
    if (!next) {
      const prefs = host.getChatSessionPrefs(sessionId);
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
    const prefs = host.updateChatSessionPrefs(sessionId, {
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
    const prefs = host.updateChatSessionPrefs(sessionId, {
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
    const prefs = host.updateChatSessionPrefs(sessionId, { webMode });
    return { ok: true, command, args, prefs, message: `Web mode set to ${prefs.webMode}.` };
  }

  if (command === "/memory") {
    const memoryMode = (args[0] ?? "").toLowerCase() as "auto" | "on" | "off";
    if (!["auto", "on", "off"].includes(memoryMode)) {
      return { ok: false, command, args, message: "Usage: /memory auto|on|off" };
    }
    const prefs = host.updateChatSessionPrefs(sessionId, { memoryMode });
    return { ok: true, command, args, prefs, message: `Memory mode set to ${prefs.memoryMode}.` };
  }

  if (command === "/dream") {
    const workspaceId = host.normalizeWorkspaceId(host.storage.chatSessionMeta.ensure(sessionId).workspaceId);
    const subcommand = (args[0] ?? "").toLowerCase();
    if (!subcommand) {
      const run = host.runMemoryMaintenanceNow({ workspaceId, triggerSource: "manual" });
      return {
        ok: true,
        command,
        args,
        message: `Memory maintenance queued for ${workspaceId} (${run.runId}).`,
      };
    }
    if (subcommand === "status") {
      const status = host.getMemoryMaintenanceStatus(workspaceId);
      const providerId = status.policy.providerId ?? host.getSettings().llm.activeProviderId;
      const model = status.policy.model ?? host.getSettings().llm.activeModel;
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
    if (!["minimal", "standard", "extended"].includes(thinkingLevel)) {
      return { ok: false, command, args, message: "Usage: /think minimal|standard|extended" };
    }
    const prefs = host.updateChatSessionPrefs(sessionId, { thinkingLevel });
    return { ok: true, command, args, prefs, message: `Thinking level set to ${prefs.thinkingLevel}.` };
  }

  if (command === "/tool") {
    const toolAutonomy = (args[0] ?? "").toLowerCase() as "safe_auto" | "manual";
    if (!["safe_auto", "manual"].includes(toolAutonomy)) {
      return { ok: false, command, args, message: "Usage: /tool safe_auto|manual" };
    }
    const prefs = host.updateChatSessionPrefs(sessionId, { toolAutonomy });
    return { ok: true, command, args, prefs, message: `Tool autonomy set to ${prefs.toolAutonomy}.` };
  }

  if (command === "/proactive") {
    const proactiveMode = (args[0] ?? "").toLowerCase() as ChatProactiveMode;
    if (!["off", "suggest", "auto_safe", "auto_full"].includes(proactiveMode)) {
      return { ok: false, command, args, message: "Usage: /proactive off|suggest|auto_safe|auto_full" };
    }
    const policy = host.updateChatSessionProactivePolicy(sessionId, { proactiveMode });
    const prefs = host.getChatSessionPrefs(sessionId);
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
    host.updateChatSessionProactivePolicy(sessionId, { retrievalMode });
    const prefs = host.getChatSessionPrefs(sessionId);
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
    host.updateChatSessionProactivePolicy(sessionId, { reflectionMode });
    const prefs = host.getChatSessionPrefs(sessionId);
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
    const research = await host.runChatResearch(sessionId, {
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
    const run = await host.runChatDelegation(sessionId, {
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
    const run = await host.runChatDelegation(sessionId, {
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
    const score = await host.scorePromptPackLatestRunByCode({
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
    const results = await host.runPromptPackFromChat(sessionId, selector);
    return {
      ok: true,
      command,
      args,
      message: `Prompt pack run complete: ${results.length} test(s) executed.`,
    };
  }

  if (command === "/skills") {
    const skills = host.listSkills();
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
      const updated = host.setSkillState(skillId, state, `Updated from chat command ${commandText.trim()}`);
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
      const results = await host.listSkillSources(query, 5);
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
      const result = await host.lookupSkillSources(query, 5);
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
      const validation = await host.validateSkillImport({ sourceRef });
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
      const installed = await host.installSkillImport({ sourceRef, confirmHighRisk });
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
      const servers = host.listMcpServers();
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
        updated = action === "connect" ? await host.connectMcpServer(serverId) : host.disconnectMcpServer(serverId);
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
      const templates = host.listMcpTemplates().filter((template) => {
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
      const template = MCP_SERVER_TEMPLATES.find((item) => item.templateId.toLowerCase() === templateId);
      if (!template) {
        return { ok: false, command, args, message: `Unknown MCP template ${templateId}.` };
      }
      const existing = host
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
      const created = host.createMcpServer({
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
    const updated = host.assignChatSessionProject(
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
    const research = await host.runChatResearch(sessionId, {
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
    await host.resolveChatToolApproval(sessionId, approvalId, "approve");
    return { ok: true, command, args, message: `Approved ${approvalId}.` };
  }

  if (command === "/deny") {
    const approvalId = args[0]?.trim();
    if (!approvalId) {
      return { ok: false, command, args, message: "Usage: /deny <approval-id>" };
    }
    await host.resolveChatToolApproval(sessionId, approvalId, "reject");
    return { ok: true, command, args, message: `Denied ${approvalId}.` };
  }

  return {
    ok: false,
    command,
    args,
    message: `Unknown command ${command}. Use /help.`,
  };
}
