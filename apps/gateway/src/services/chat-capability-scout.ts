import { createHash } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";
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
  evaluateToolAccess(input: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse>;
  listSkills(): Promise<SkillListItem[]>;
  resolveSkillActivation(input: SkillResolveInput): Promise<{
    suppressed: Array<{
      skill: string;
      state: "enabled" | "sleep" | "disabled";
      confidence: number;
      reason: string;
    }>;
  }>;
  listSkillSources(query?: string, limit?: number): Promise<SkillSourceListResponse>;
  lookupSkillSources(queryOrUrl: string, limit?: number): Promise<SkillSourceLookupResponse>;
  listMcpTemplates(): Promise<Array<McpServerTemplateRecord & { installed: boolean }>>;
  listMcpTemplateDiscovery(): Promise<McpTemplateDiscoveryResult[]>;
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

const log = logger.child("chat-capability-scout");

function logScoutFailure(stage: string, error: unknown): void {
  log.warn(`${stage} failed`, { error: error instanceof Error ? error.message : String(error) });
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "do",
  "for",
  "from",
  "get",
  "give",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "make",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "show",
  "something",
  "that",
  "the",
  "this",
  "to",
  "with",
  "you",
]);

const ACTION_INTENT =
  /\b(add|book|browse|build|call|calendar|capture|change|check|clone|connect|create|debug|deploy|download|email|fetch|find|fix|install|invoke|list|lookup|open|read|run|schedule|search|send|set up|setup|sync|use|write)\b/i;
const GAP_SIGNAL =
  /\b(can't|cannot|couldn't|do not have|don't have|missing|not available|not installed|not connected|unable)\b/i;

export async function scoutCapabilityUpgradeSuggestions(
  input: CapabilityScoutInput,
): Promise<ChatCapabilityUpgradeSuggestion[]> {
  const presentationArtifactIntent = detectPresentationArtifactIntent(input.content);
  const documentArtifactIntent = !presentationArtifactIntent && detectDocumentArtifactIntent(input.content);
  if (!looksToolOrientedRequest(input.content) && !presentationArtifactIntent && !documentArtifactIntent) {
    return [];
  }
  if (
    !looksLikeCapabilityGap(input.assistantText, input.trace) &&
    !looksLikeMissingRequestedPresentationArtifact(input, presentationArtifactIntent) &&
    !looksLikeMissingRequestedDocumentArtifact(input, documentArtifactIntent)
  ) {
    return [];
  }

  const ranked: RankedSuggestion[] = [];
  let discoveryFailed = false;
  const [skills, activation] = await Promise.all([
    input.deps.listSkills(),
    input.deps.resolveSkillActivation({ text: input.content }),
  ]);
  const suppressed = activation.suppressed;

  for (const item of suppressed) {
    const skill = skills.find((candidate) => normalize(candidate.name) === normalize(item.skill));
    const searchBlob = [
      item.skill,
      skill?.instructionBody,
      ...(skill?.keywords ?? []),
      ...(skill?.declaredTools ?? []),
      ...(skill?.requires ?? []),
    ]
      .filter(Boolean)
      .join(" ");
    const score = scoreMatch(input.content, searchBlob) + (item.state === "disabled" ? 0.45 : 0.3);
    if (score < 0.42) {
      continue;
    }
    ranked.push({
      score,
      suggestion: {
        kind: "existing_but_disabled",
        title: `${skill?.name ?? item.skill} is available but currently ${item.state}`,
        summary:
          item.state === "disabled"
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
      access = await input.deps.evaluateToolAccess({
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
        reason:
          access.reasonCodes.length > 0
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
  const searchQuery = presentationArtifactIntent
    ? "powerpoint presentation slides deck pptx"
    : documentArtifactIntent
      ? "document generation docx pdf markdown html csv json"
      : buildCapabilitySearchQuery(input.content);
  if (directSourceUrl || searchQuery) {
    try {
      const sourceResults = directSourceUrl
        ? await input.deps.lookupSkillSources(directSourceUrl, 3)
        : await input.deps.listSkillSources(searchQuery, 6);
      for (const item of sourceResults.items) {
        const score =
          scoreMatch(input.content, `${item.name} ${item.description} ${item.tags.join(" ")}`) +
          item.combinedScore / 10;
        if (score < 0.4) {
          continue;
        }
        const recommendedAction =
          directSourceUrl && item.installability === "direct" ? "install_skill_enable" : "install_skill_disabled";
        ranked.push({
          score,
          suggestion: {
            kind: "skill_import",
            title:
              recommendedAction === "install_skill_enable"
                ? `Install and enable skill: ${item.name}`
                : `Install skill: ${item.name}`,
            summary: item.description,
            reason:
              recommendedAction === "install_skill_enable"
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
      discoveryFailed = true;
      logScoutFailure("skill source discovery", error);
    }
  }

  try {
    const [templates, discovery] = await Promise.all([
      input.deps.listMcpTemplates(),
      input.deps.listMcpTemplateDiscovery(),
    ]);
    const templateById = new Map(templates.map((template) => [template.templateId, template]));
    for (const item of discovery) {
      const template = templateById.get(item.templateId);
      if (!template || item.installed) {
        continue;
      }
      const score =
        scoreMatch(
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
    discoveryFailed = true;
    logScoutFailure("mcp template discovery", error);
  }

  if (!discoveryFailed && ranked.length === 0) {
    ranked.push({
      score: 0.32,
      suggestion: buildCodeModeCapabilityBuildSuggestion(input),
    });
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

function looksLikeMissingRequestedPresentationArtifact(
  input: CapabilityScoutInput,
  presentationIntent: boolean,
): boolean {
  if (!presentationIntent) {
    return false;
  }
  const ranPresentationTool = (input.trace?.toolRuns ?? []).some(
    (run) => run.toolName === "presentations.create" && run.status === "executed",
  );
  if (ranPresentationTool) {
    return false;
  }
  const assistantText = input.assistantText.toLowerCase();
  const claimsCreatedDeck =
    /\b(power\s?point|pptx?|slide\s+deck|presentation)\b/.test(assistantText) &&
    /\b(created|saved|exported|attached|workspace|artifact|\.pptx)\b/.test(assistantText);
  return !claimsCreatedDeck;
}

function looksLikeMissingRequestedDocumentArtifact(input: CapabilityScoutInput, documentIntent: boolean): boolean {
  if (!documentIntent) {
    return false;
  }
  const ranDocumentTool = (input.trace?.toolRuns ?? []).some(
    (run) => run.toolName === "documents.create" && run.status === "executed",
  );
  if (ranDocumentTool) {
    return false;
  }
  const assistantText = input.assistantText.toLowerCase();
  const claimsCreatedDocument =
    /\b(docx?|word\s+doc(?:ument)?|pdf|markdown|md|html|csv|json|txt|report|brief|memo|document)\b/.test(
      assistantText,
    ) &&
    /\b(created|saved|exported|attached|workspace|artifact|\.(?:docx|pdf|md|html|csv|json|txt))\b/.test(assistantText);
  return !claimsCreatedDocument;
}

function detectPresentationArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    /\b(power\s?point|pptx?|(?:slide|pitch|investor|presentation)\s+deck|slides?|presentation)\b/.test(normalized) &&
    /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver|format|file)\b/.test(normalized)
  );
}

function detectDocumentArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    /\b(docx?|word\s+doc(?:ument)?|pdf|markdown|md|html|csv|json|text\s+file|txt|report|brief|memo|handout|worksheet|document)\b/.test(
      normalized,
    ) && /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver|format|file)\b/.test(normalized)
  );
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
  const tokens = tokenize(content)
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 6);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.join(" ");
}

function buildCodeModeCapabilityBuildSuggestion(input: CapabilityScoutInput): ChatCapabilityUpgradeSuggestion {
  const sourceTurnId = input.trace?.turnId;
  const candidateId = `candidate-${sha256Text(
    ["code-mode-gap", input.sessionId, sourceTurnId ?? "", input.content].join(":"),
  ).slice(0, 12)}`;
  const intendedBehavior = summarizeReusableBehavior(input.content);
  return {
    kind: "code_mode_build",
    title: buildCodeModeBuildTitle(input.content),
    summary:
      "No callable, disabled, importable, or configurable capability matched this gap. GoatCitadel can stage a self-authored SKILL.md capability candidate for review from this conversation.",
    reason:
      "A new reusable capability is justified only after the installed skill catalog, disabled skills, hosted/importable skills, MCP templates, and tool-profile repairs did not produce a suitable match.",
    sourceProvider: "code_mode",
    sourceRef: `code-mode://capability-gap/${encodeURIComponent(sourceTurnId ?? input.sessionId)}`,
    riskLevel: "medium",
    recommendedAction: "build_code_mode_skill_candidate",
    candidateId,
    sourceSessionId: input.sessionId,
    sourceTurnId,
    intendedBehavior,
    candidateType: "self_generated_skill",
    requiredPermissions: [],
    validationExpectation:
      "The governed capability build must stage a validated candidate bundle with artifact hashes before the skill can be reviewed.",
    rollbackPosture:
      "The candidate remains non-callable until approved, and rejection, revocation, or rollback keeps previous callable skills intact.",
    requiresUserApproval: true,
  };
}

function buildCodeModeBuildTitle(content: string): string {
  const tokens = tokenize(content)
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 5);
  if (tokens.length === 0) {
    return "Build reusable capability";
  }
  const label = tokens.map((token) => token[0]!.toUpperCase() + token.slice(1)).join(" ");
  return `Build reusable skill: ${label}`;
}

function summarizeReusableBehavior(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "Capture the missing workflow as a reusable, reviewable GoatCitadel skill.";
  }
  const clipped = normalized.length > 220 ? `${normalized.slice(0, 217).trimEnd()}...` : normalized;
  return `Capture future requests like this as a reusable, reviewable GoatCitadel skill: ${clipped}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
