import type {
  ChatCapabilityUpgradeSuggestion,
  ChatTurnTraceRecord,
  McpServerTemplateRecord,
  McpTemplateDiscoveryResult,
  SkillListItem,
  SkillSourceLookupResponse,
  SkillResolveInput,
  SkillSourceListResponse,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolCatalogEntry,
} from "@goatcitadel/contracts";

interface CapabilityScoutDeps {
  listToolCatalog(): ToolCatalogEntry[];
  evaluateToolAccess(input: ToolAccessEvaluateRequest): ToolAccessEvaluateResponse;
  listSkills(): SkillListItem[];
  resolveSkillActivation(input: SkillResolveInput): {
    suppressed: Array<{
      skill: string;
      state: "enabled" | "sleep" | "disabled";
      confidence: number;
      reason: string;
    }>;
  };
  listSkillSources(query?: string, limit?: number): Promise<SkillSourceListResponse>;
  lookupSkillSources(queryOrUrl: string, limit?: number): Promise<SkillSourceLookupResponse>;
  listMcpTemplates(): Array<McpServerTemplateRecord & { installed: boolean }>;
  listMcpTemplateDiscovery(): McpTemplateDiscoveryResult[];
}

interface CapabilityScoutInput {
  content: string;
  assistantText: string;
  sessionId: string;
  trace?: ChatTurnTraceRecord;
  deps: CapabilityScoutDeps;
}

interface RankedSuggestion {
  score: number;
  suggestion: ChatCapabilityUpgradeSuggestion;
}

function logScoutFailure(stage: string, error: unknown): void {
  console.warn(`[chat-capability-scout] ${stage} failed`, error);
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "be", "can", "do", "for", "from", "get", "give", "have", "i",
  "if", "in", "is", "it", "make", "me", "my", "of", "on", "or", "please", "show", "something",
  "that", "the", "this", "to", "with", "you",
]);

const ACTION_INTENT = /\b(add|book|browse|build|call|calendar|capture|change|check|clone|connect|create|debug|deploy|download|email|fetch|find|fix|install|invoke|list|lookup|open|read|run|schedule|search|send|set up|setup|sync|use|write)\b/i;
const GAP_SIGNAL = /\b(can't|cannot|couldn't|do not have|don't have|missing|not available|not installed|not connected|unable)\b/i;

export async function scoutCapabilityUpgradeSuggestions(
  input: CapabilityScoutInput,
): Promise<ChatCapabilityUpgradeSuggestion[]> {
  if (!looksToolOrientedRequest(input.content)) {
    return [];
  }
  if (!looksLikeCapabilityGap(input.assistantText, input.trace)) {
    return [];
  }

  const ranked: RankedSuggestion[] = [];
  const skills = input.deps.listSkills();
  const suppressed = input.deps.resolveSkillActivation({ text: input.content }).suppressed;

  for (const item of suppressed) {
    const skill = skills.find((candidate) => normalize(candidate.name) === normalize(item.skill));
    const searchBlob = [
      item.skill,
      skill?.instructionBody,
      ...(skill?.keywords ?? []),
      ...(skill?.declaredTools ?? []),
      ...(skill?.requires ?? []),
    ].filter(Boolean).join(" ");
    const score = scoreMatch(input.content, searchBlob) + (item.state === "disabled" ? 0.45 : 0.3);
    if (score < 0.42) {
      continue;
    }
    ranked.push({
      score,
      suggestion: {
        kind: "existing_but_disabled",
        title: `${skill?.name ?? item.skill} is available but currently ${item.state}`,
        summary: item.state === "disabled"
          ? "A matching installed skill exists, but it is disabled right now."
          : "A matching installed skill exists, but GoatCitadel is keeping it inactive for this request.",
        reason: humanizeSuppressionReason(item.reason),
        riskLevel: "low",
        recommendedAction: "enable_skill",
        candidateId: skill?.skillId,
        sourceRef: skill?.dir,
        requiresUserApproval: true,
      },
    });
  }

  for (const tool of rankToolMatches(input.content, input.deps.listToolCatalog()).slice(0, 4)) {
    let access: ToolAccessEvaluateResponse;
    try {
      access = input.deps.evaluateToolAccess({
        toolName: tool.toolName,
        sessionId: input.sessionId,
        agentId: "assistant",
        args: {},
      });
    } catch {
      continue;
    }
    if (access.allowed) {
      continue;
    }
    ranked.push({
      score: tool.score + 0.35,
      suggestion: {
        kind: "existing_but_disabled",
        title: `${tool.toolName} exists but is not currently allowed`,
        summary: tool.description,
        reason: access.reasonCodes.length > 0
          ? `Current tool/profile policy blocked this capability: ${access.reasonCodes.join(", ")}.`
          : "Current tool/profile policy is blocking this capability.",
        riskLevel: tool.riskLevel === "danger" || tool.riskLevel === "nuclear" ? "high" : "medium",
        recommendedAction: "switch_tool_profile",
        candidateId: tool.toolName,
        requiresUserApproval: true,
      },
    });
  }

  const directSourceUrl = extractDirectSourceUrl(input.content);
  const searchQuery = buildCapabilitySearchQuery(input.content);
  if (directSourceUrl || searchQuery) {
    try {
      const sourceResults = directSourceUrl
        ? await input.deps.lookupSkillSources(directSourceUrl, 3)
        : await input.deps.listSkillSources(searchQuery, 6);
      for (const item of sourceResults.items) {
        const score = scoreMatch(input.content, `${item.name} ${item.description} ${item.tags.join(" ")}`) + (item.combinedScore / 10);
        if (score < 0.4) {
          continue;
        }
        const recommendedAction = directSourceUrl && item.installability === "direct"
          ? "install_skill_enable"
          : "install_skill_disabled";
        ranked.push({
          score,
          suggestion: {
            kind: "skill_import",
            title: recommendedAction === "install_skill_enable"
              ? `Install and enable skill: ${item.name}`
              : `Install skill: ${item.name}`,
            summary: item.description,
            reason: recommendedAction === "install_skill_enable"
              ? "The request already points to a direct hosted skill source GoatCitadel can import and activate."
              : "No active installed capability matched cleanly, but a curated skill source looks relevant.",
            sourceProvider: item.sourceProvider === "local" ? undefined : item.sourceProvider,
            sourceRef: item.repositoryUrl ?? item.sourceUrl,
            riskLevel: item.sourceProvider === "github" ? "medium" : "low",
            recommendedAction,
            candidateId: item.canonicalKey,
            requiresUserApproval: true,
          },
        });
      }
    } catch (error) {
      logScoutFailure("skill source discovery", error);
    }
  }

  try {
    const templateById = new Map(input.deps.listMcpTemplates().map((template) => [template.templateId, template]));
    const discovery = input.deps.listMcpTemplateDiscovery();
    for (const item of discovery) {
      const template = templateById.get(item.templateId);
      if (!template || item.installed) {
        continue;
      }
      const score = scoreMatch(
        input.content,
        `${template.label} ${template.description} ${template.category} ${template.transport}`,
      ) + readinessScore(item.readiness);
      if (score < 0.45) {
        continue;
      }
      ranked.push({
        score,
        suggestion: {
          kind: "mcp_template",
          title: `Add MCP template: ${template.label}`,
          summary: template.description,
          reason: buildMcpReadinessReason(item),
          sourceProvider: "mcp_template",
          sourceRef: template.templateId,
          riskLevel: template.trustTier === "trusted" ? "low" : "medium",
          recommendedAction: "add_mcp_template",
          candidateId: template.templateId,
          requiresUserApproval: true,
        },
      });
    }
  } catch (error) {
    logScoutFailure("mcp template discovery", error);
  }

  const deduped = new Map<string, RankedSuggestion>();
  for (const entry of ranked.sort((a, b) => b.score - a.score)) {
    const key = `${entry.suggestion.kind}:${entry.suggestion.candidateId ?? entry.suggestion.title}`;
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }
  return [...deduped.values()].slice(0, 3).map((entry) => entry.suggestion);
}

function looksToolOrientedRequest(content: string): boolean {
  return ACTION_INTENT.test(content);
}

function looksLikeCapabilityGap(assistantText: string, trace?: ChatTurnTraceRecord): boolean {
  if (GAP_SIGNAL.test(assistantText)) {
    return true;
  }
  const toolRuns = trace?.toolRuns ?? [];
  const executed = toolRuns.filter((item) => item.status === "executed");
  const blocked = toolRuns.filter((item) => item.status === "blocked" || item.status === "failed");
  return executed.length === 0 && (trace?.status === "failed" || blocked.length > 0);
}

function rankToolMatches(content: string, catalog: ToolCatalogEntry[]): Array<ToolCatalogEntry & { score: number }> {
  return catalog
    .map((tool) => ({
      ...tool,
      score: scoreMatch(
        content,
        `${tool.toolName} ${tool.description} ${tool.category} ${tool.examples.map((item) => item.title).join(" ")}`,
      ),
    }))
    .filter((tool) => tool.score >= 0.35)
    .sort((a, b) => b.score - a.score);
}

function buildCapabilitySearchQuery(content: string): string | undefined {
  const tokens = tokenize(content).filter((token) => !STOP_WORDS.has(token)).slice(0, 6);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.join(" ");
}

function extractDirectSourceUrl(content: string): string | undefined {
  const match = content.match(/https?:\/\/\S+/i);
  if (!match) {
    return undefined;
  }
  return match[0].replace(/[),.;!?]+$/, "");
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function scoreMatch(query: string, haystack: string): number {
  const normalizedHaystack = normalize(haystack);
  const normalizedQuery = normalize(query);
  let score = 0;
  if (normalizedQuery.length >= 8 && normalizedHaystack.includes(normalizedQuery)) {
    score += 0.65;
  }
  const tokens = tokenize(normalizedQuery).filter((token) => !STOP_WORDS.has(token));
  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) {
    return score;
  }
  let tokenHits = 0;
  for (const token of uniqueTokens) {
    if (normalizedHaystack.includes(token)) {
      tokenHits += 1;
    }
  }
  score += Math.min(0.55, tokenHits / Math.max(uniqueTokens.length, 1));
  return score;
}

function readinessScore(readiness: McpTemplateDiscoveryResult["readiness"]): number {
  if (readiness === "ready") {
    return 0.35;
  }
  if (readiness === "needs_auth") {
    return 0.25;
  }
  if (readiness === "needs_url") {
    return 0.15;
  }
  return 0.05;
}

function buildMcpReadinessReason(item: McpTemplateDiscoveryResult): string {
  if (item.readiness === "ready") {
    return "This MCP template looks ready to add with minimal setup.";
  }
  if (item.readiness === "needs_auth") {
    return "This MCP template matches the request, but it still needs credentials before first use.";
  }
  if (item.readiness === "needs_url") {
    return "This MCP template matches the request, but it still needs an endpoint URL before use.";
  }
  if (item.readiness === "needs_command") {
    return "This MCP template matches the request, but it still needs a local command/runtime configured.";
  }
  return "This MCP template looks relevant, but it still needs setup before GoatCitadel can use it.";
}

function humanizeSuppressionReason(reason: string): string {
  if (reason === "skill_disabled") {
    return "The matching skill is installed but disabled.";
  }
  if (reason === "below_guarded_auto_threshold") {
    return "The matching skill is in guarded mode and did not auto-activate with enough confidence.";
  }
  return reason.replaceAll("_", " ");
}

function normalize(input: string): string {
  return input.trim().toLowerCase();
}
