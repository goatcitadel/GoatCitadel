import { randomUUID } from "node:crypto";
import type {
  ChatAttachmentRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatCompletionResponse,
  ChatInputPart,
  ChatMode,
  ChatPlanningMode,
  ChatRetrievalMode,
  ChatSessionPrefsRecord,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatTurnTraceRecord,
  ChatWebMode,
} from "@goatcitadel/contracts";
import type { OrchestrationPlan as ModeOrchestrationPlan, OrchestrationRole } from "../orchestration/types.js";
import { isImageMimeType, toTitleCase } from "./chat-turn-helpers.js";
import type { PreparedChatExecutionPlanResolution } from "./chat-turn-types.js";

export interface ResolvedRuntimeGuidance {
  workspaceId: string;
  systemInstruction?: string;
  globalFilesUsed: string[];
  workspaceFilesUsed: string[];
  truncated: boolean;
}

export const CHAT_PLANNER_MAX_STEPS = 8;
export const CHAT_PLANNER_MIN_STEPS = 3;
const CONTROL_ORCHESTRATION_ROLES = new Set<OrchestrationRole>(["synthesizer", "reviewer", "critic", "qa-validator"]);

export function normalizeChatInputParts(
  content: string,
  parts: ChatInputPart[] | undefined,
  attachments: ChatAttachmentRecord[],
): ChatInputPart[] {
  const normalizedParts = Array.isArray(parts) ? parts.filter(Boolean) : [];
  if (normalizedParts.length > 0) {
    return normalizedParts;
  }
  const attachmentParts = attachments.map((attachment) => {
    if (attachment.mediaType === "image" || isImageMimeType(attachment.mimeType)) {
      return {
        type: "image_ref" as const,
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
      };
    }
    if (attachment.mediaType === "audio") {
      return {
        type: "audio_ref" as const,
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
      };
    }
    if (attachment.mediaType === "video") {
      return {
        type: "video_ref" as const,
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
      };
    }
    return {
      type: "file_ref" as const,
      attachmentId: attachment.attachmentId,
      mimeType: attachment.mimeType,
    };
  });
  return [
    {
      type: "text",
      text: content,
    },
    ...attachmentParts,
  ];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeSpecialistToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeSpecialistCandidateFingerprint(input: { title?: string; role?: string }): string {
  return `${normalizeSpecialistToken(input.role ?? "")}:${normalizeSpecialistToken(input.title ?? "")}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function extractSpecialistObjectiveKeywords(content: string): string[] {
  const STOP_WORDS = new Set([
    "about",
    "after",
    "again",
    "also",
    "around",
    "because",
    "build",
    "could",
    "does",
    "from",
    "have",
    "into",
    "need",
    "that",
    "their",
    "them",
    "then",
    "this",
    "through",
    "what",
    "with",
    "would",
  ]);
  const matches = content.toLowerCase().match(/[a-z0-9][a-z0-9._+-]{2,}/g) ?? [];
  return dedupeStrings(
    matches.map(normalizeSpecialistToken).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  ).slice(0, 12);
}

export function mergeSpecialistRoutingHints(
  left: ChatSpecialistCandidateRecord["routingHints"],
  right: ChatSpecialistCandidateRecord["routingHints"],
): ChatSpecialistCandidateRecord["routingHints"] {
  const maxInvocationsPerRun = (() => {
    const values = [left.maxInvocationsPerRun, right.maxInvocationsPerRun].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (values.length === 0) {
      return undefined;
    }
    return Math.min(...values);
  })();
  return {
    preferredModes: dedupeStrings([...left.preferredModes, ...right.preferredModes]) as ChatMode[],
    objectiveKeywords: (() => {
      const values = dedupeStrings([...(left.objectiveKeywords ?? []), ...(right.objectiveKeywords ?? [])]);
      return values.length > 0 ? values : undefined;
    })(),
    requiresProjectBinding: Boolean(left.requiresProjectBinding || right.requiresProjectBinding),
    maxInvocationsPerRun,
  };
}

export function mergeSpecialistEvidence(
  left: ChatSpecialistCandidateRecord["evidence"],
  right: ChatSpecialistCandidateRecord["evidence"],
): ChatSpecialistCandidateRecord["evidence"] {
  const merged = new Map<string, ChatSpecialistCandidateRecord["evidence"][number]>();
  for (const item of [...left, ...right]) {
    const key = [
      item.kind,
      normalizeSpecialistToken(item.summary),
      item.turnId ?? "",
      item.runId ?? "",
      item.toolName ?? "",
      item.skillRef ?? "",
    ].join("|");
    const current = merged.get(key);
    if (!current || (item.confidence ?? 0) > (current.confidence ?? 0)) {
      merged.set(key, item);
    }
  }
  return [...merged.values()].slice(0, 8);
}

export function inferSpecialistBaseRole(role: string): OrchestrationRole {
  const normalized = role.toLowerCase();
  if (/\b(research|analyst|market|source|intel)\b/.test(normalized)) {
    return "researcher";
  }
  if (/\b(qa|test|validator)\b/.test(normalized)) {
    return "qa-validator";
  }
  if (/\b(review|critic|audit|security)\b/.test(normalized)) {
    return "reviewer";
  }
  if (/\b(coder|developer|implement|engineer)\b/.test(normalized)) {
    return "coder";
  }
  if (/\b(product|architect|planner|design)\b/.test(normalized)) {
    return "planner";
  }
  if (/\b(ops|deploy|release|infra)\b/.test(normalized)) {
    return "worker";
  }
  return "worker";
}

function inferSpecialistRoleFromCapability(capability: ChatCapabilityUpgradeSuggestion): string {
  const haystack = `${capability.title} ${capability.summary} ${capability.reason}`.toLowerCase();
  if (/\b(security|auth|permission)\b/.test(haystack)) return "security-reviewer";
  if (/\b(test|qa|validate)\b/.test(haystack)) return "qa";
  if (/\b(research|search|browser|source|latest|market)\b/.test(haystack)) return "researcher";
  if (/\b(deploy|release|ops|infra)\b/.test(haystack)) return "ops";
  if (/\b(architect|architecture|design)\b/.test(haystack)) return "architect";
  if (/\b(product|requirements|prd|plan)\b/.test(haystack)) return "product";
  if (/\b(code|coder|developer|implementation|build)\b/.test(haystack)) return "coder";
  const titleTokens = extractSpecialistObjectiveKeywords(capability.title);
  return titleTokens[0] ? `${titleTokens[0]}-specialist` : "tooling-specialist";
}

function suggestedToolsForRole(role: string): string[] | undefined {
  const normalized = role.toLowerCase();
  if (normalized.includes("research")) return ["browser.search", "browser.navigate"];
  if (normalized.includes("qa")) return ["tests.run"];
  if (normalized.includes("ops")) return ["shell.command"];
  if (normalized.includes("security")) return ["security.review"];
  return undefined;
}

export function buildSpecialistSuggestionFromCapability(input: {
  capability: ChatCapabilityUpgradeSuggestion;
  mode: ChatMode;
  objectiveKeywords: string[];
}): ChatSpecialistCandidateSuggestionRecord {
  const role = inferSpecialistRoleFromCapability(input.capability);
  const title = /\bspecialist\b/i.test(input.capability.title)
    ? input.capability.title
    : `${toTitleCase(role)} specialist`;
  const objectiveKeywords = dedupeStrings([
    ...input.objectiveKeywords,
    ...extractSpecialistObjectiveKeywords(input.capability.title),
    ...extractSpecialistObjectiveKeywords(input.capability.summary),
  ]).slice(0, 10);
  return {
    candidateId: `specialist-${normalizeSpecialistCandidateFingerprint({ title, role })}`,
    title,
    role,
    summary: `Use ${input.capability.title} as a dormant specialist capability for repeat ${input.mode} work of this kind.`,
    reason: input.capability.reason,
    source: "runtime_gap",
    confidence: clamp01(
      input.capability.riskLevel === "low" ? 0.76 : input.capability.riskLevel === "high" ? 0.62 : 0.69,
    ),
    suggestedStatus: "suggested",
    suggestedRoutingMode: input.mode === "code" ? "strong_match_only" : "manual_only",
    requiresApproval: true,
    suggestedTools: suggestedToolsForRole(role),
    suggestedSkills: input.capability.sourceRef ? [input.capability.sourceRef] : undefined,
    routingHints: {
      preferredModes: input.mode === "code" ? ["code"] : ["cowork"],
      objectiveKeywords: objectiveKeywords.length > 0 ? objectiveKeywords : undefined,
      requiresProjectBinding: input.mode === "code",
      maxInvocationsPerRun: 1,
    },
    evidence: [
      {
        evidenceId: randomUUID(),
        kind: input.capability.kind === "mcp_template" ? "tool_gap" : "skill_gap",
        summary: input.capability.summary,
        confidence: clamp01(input.capability.riskLevel === "low" ? 0.78 : 0.66),
        skillRef: input.capability.sourceRef,
      },
    ],
  };
}

export function buildRoleGapSpecialistSuggestion(input: {
  role: string;
  mode: ChatMode;
  objective: string;
  objectiveKeywords: string[];
  confidence: number;
  runId?: string;
  turnId?: string;
}): ChatSpecialistCandidateSuggestionRecord {
  const title = `${toTitleCase(input.role)} specialist`;
  const routingMode: ChatSpecialistCandidateSuggestionRecord["suggestedRoutingMode"] =
    input.confidence >= 0.8 ? "strong_match_only" : "manual_only";
  return {
    candidateId: `specialist-${normalizeSpecialistCandidateFingerprint({ title, role: input.role })}`,
    title,
    role: input.role,
    summary: `Add a dormant ${input.role} specialist so similar ${input.mode} runs can reuse a focused persona instead of rebuilding the roster each time.`,
    reason: `This run implied a recurring ${input.role} gap in the current roster.`,
    source: "runtime_gap",
    confidence: clamp01(input.confidence),
    suggestedStatus: "suggested",
    suggestedRoutingMode: routingMode,
    requiresApproval: true,
    suggestedTools: suggestedToolsForRole(input.role),
    routingHints: {
      preferredModes: input.mode === "code" ? ["code"] : ["cowork"],
      objectiveKeywords:
        input.objectiveKeywords.length > 0
          ? input.objectiveKeywords
          : extractSpecialistObjectiveKeywords(input.objective),
      requiresProjectBinding: input.mode === "code",
      maxInvocationsPerRun: 1,
    },
    evidence: [
      {
        evidenceId: randomUUID(),
        kind: "role_gap",
        summary: `Objective hinted that ${input.role} work would help: ${input.objective.slice(0, 180)}`,
        turnId: input.turnId,
        runId: input.runId,
        confidence: clamp01(input.confidence),
      },
    ],
  };
}

export function scoreSpecialistCandidateMatch(
  candidate: ChatSpecialistCandidateRecord,
  objectiveKeywords: string[],
  stepRole: OrchestrationRole,
): number {
  const baseRole = inferSpecialistBaseRole(candidate.role);
  if (baseRole !== stepRole) {
    return 0;
  }
  const candidateKeywords = dedupeStrings([
    ...(candidate.routingHints.objectiveKeywords ?? []),
    ...extractSpecialistObjectiveKeywords(candidate.title),
    ...extractSpecialistObjectiveKeywords(candidate.summary),
    ...extractSpecialistObjectiveKeywords(candidate.reason),
  ]);
  const overlap =
    candidateKeywords.length > 0
      ? objectiveKeywords.filter((keyword) => candidateKeywords.includes(keyword)).length / candidateKeywords.length
      : 0;
  return clamp01(candidate.confidence * 0.55 + overlap * 0.35 + 0.1);
}

export function buildSpecialistMatchReason(
  candidate: ChatSpecialistCandidateRecord,
  objectiveKeywords: string[],
): string {
  const candidateKeywords = dedupeStrings([
    ...(candidate.routingHints.objectiveKeywords ?? []),
    ...extractSpecialistObjectiveKeywords(candidate.title),
  ]);
  const overlap = objectiveKeywords.filter((keyword) => candidateKeywords.includes(keyword));
  if (overlap.length > 0) {
    return `Matched on ${overlap.slice(0, 3).join(", ")}.`;
  }
  return candidate.reason;
}

export function buildPlanningModeSystemInstruction(planningMode: ChatPlanningMode | undefined): string | undefined {
  if (planningMode !== "advisory") {
    return undefined;
  }
  return [
    "Planning mode is active for this session.",
    "Respond with an advisory plan, specification, or options analysis only.",
    "Do not claim to have executed tools, delegated work, or changed files in this turn.",
    "If tools would help, explain which tool or follow-up action the operator should explicitly run next.",
  ].join("\n");
}

export function mergeChatSystemInstructions(...parts: Array<string | undefined>): string | undefined {
  const merged = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  if (merged.length === 0) {
    return undefined;
  }
  return merged.join("\n\n");
}

export function buildRetrievalTrace(input: {
  content: string;
  retrievalMode: ChatRetrievalMode;
  webMode: ChatWebMode;
  memoryMode: ChatSessionPrefsRecord["memoryMode"];
}): NonNullable<ChatTurnTraceRecord["retrieval"]> {
  const liveIntent = /\b(latest|today|weather|news|price|current|right now|time)\b/i.test(input.content);
  const l0Base = liveIntent ? 0.55 : 0.86;
  const l1Base = input.memoryMode === "off" ? 0.2 : liveIntent ? 0.64 : 0.78;
  const shouldUseLayered = input.retrievalMode === "layered";
  const shouldUseL2 = shouldUseLayered && (liveIntent || l1Base < 0.55) && input.webMode !== "off";
  return {
    l0Used: true,
    l1Used: input.memoryMode !== "off",
    l2Used: shouldUseL2,
    confidenceL0: l0Base,
    confidenceL1: l1Base,
    confidenceL2: shouldUseL2 ? (input.webMode === "deep" ? 0.82 : 0.71) : undefined,
    escalationReason: shouldUseL2 ? (liveIntent ? "explicit_live_data_intent" : "low_retrieval_confidence") : undefined,
  };
}

export function buildExecutionPlanDraftFromOrchestrationPlan(
  templatePlan: ModeOrchestrationPlan,
  input: {
    objective: string;
    advisoryOnly: boolean;
  },
): PreparedChatExecutionPlanResolution["executionPlanDraft"] {
  return {
    source: templatePlan.source,
    advisoryOnly: input.advisoryOnly,
    objective: input.objective,
    summary: templatePlan.summary,
    steps: templatePlan.steps.map((step, index) => ({
      stepId: step.stepId,
      index,
      objective: step.objective,
      successCriteria: step.successCriteria,
      suggestedTools: step.suggestedTools,
      expectedOutput: step.expectedOutput,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds,
      delegatedRole:
        input.advisoryOnly || templatePlan.routeDecision.modePolicy === "chat" ? undefined : step.delegatedRole,
      status: "pending",
    })),
  };
}

export function coercePlannerExecutionPlanDraft(
  payload: Record<string, unknown>,
  templatePlan: ModeOrchestrationPlan,
  input: {
    advisoryOnly: boolean;
    mode: ChatMode;
    objective: string;
  },
): PreparedChatExecutionPlanResolution["executionPlanDraft"] | undefined {
  const rawSteps = Array.isArray(payload.steps)
    ? payload.steps.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : [];
  if (rawSteps.length === 0) {
    return undefined;
  }
  let usedFallback = false;
  const steps = templatePlan.steps.map((templateStep, index) => {
    const raw = rawSteps[index];
    const controlStep = shouldProtectPlannerTemplateStep(templatePlan, templateStep, index);
    const objective =
      !controlStep && typeof raw?.objective === "string" && raw.objective.trim()
        ? raw.objective.trim()
        : templateStep.objective;
    if (objective === templateStep.objective) {
      usedFallback = true;
    }
    const successCriteria =
      !controlStep && typeof raw?.successCriteria === "string" && raw.successCriteria.trim()
        ? raw.successCriteria.trim()
        : templateStep.successCriteria;
    const suggestedTools =
      Array.isArray(raw?.suggestedTools) && !controlStep
        ? dedupeStrings(
            raw.suggestedTools
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean),
          )
        : templateStep.suggestedTools;
    const expectedOutput =
      !controlStep && typeof raw?.expectedOutput === "string" && raw.expectedOutput.trim()
        ? raw.expectedOutput.trim()
        : templateStep.expectedOutput;
    const dependsOnStepIds = (() => {
      if (controlStep || !Array.isArray(raw?.dependsOnStepIds)) {
        return templateStep.dependsOnStepIds;
      }
      const filtered = filterPlannerDependencyIds(raw.dependsOnStepIds, templatePlan, templateStep);
      return filtered.length > 0 ? filtered : templateStep.dependsOnStepIds;
    })();
    const delegatedRole = input.mode === "chat" || input.advisoryOnly ? undefined : templateStep.delegatedRole;
    if (controlStep && raw && plannerStepOverridesTemplate(raw, templateStep)) {
      usedFallback = true;
    }
    return {
      stepId: templateStep.stepId,
      index,
      objective,
      successCriteria,
      suggestedTools: suggestedTools?.length ? suggestedTools : undefined,
      expectedOutput,
      parallelizable:
        !controlStep && typeof raw?.parallelizable === "boolean" ? raw.parallelizable : templateStep.parallelizable,
      dependsOnStepIds,
      delegatedRole,
      status: "pending" as const,
    };
  });
  const summary =
    typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.trim() : templatePlan.summary;
  if (summary === templatePlan.summary) {
    usedFallback = true;
  }
  return {
    source: usedFallback ? "planner_with_template_fallback" : "planner",
    advisoryOnly: input.advisoryOnly,
    objective: input.objective,
    summary,
    steps,
  };
}

function filterPlannerDependencyIds(
  rawDependsOnStepIds: unknown[],
  templatePlan: ModeOrchestrationPlan,
  templateStep: ModeOrchestrationPlan["steps"][number],
): string[] {
  const byId = new Map(templatePlan.steps.map((step) => [step.stepId, step]));
  return dedupeStrings(
    rawDependsOnStepIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return Boolean(
          dependency && dependency.stepId !== templateStep.stepId && dependency.stage < templateStep.stage,
        );
      }),
  );
}

export function applyExecutionPlanDraftToOrchestrationPlan(
  templatePlan: ModeOrchestrationPlan,
  draft: PreparedChatExecutionPlanResolution["executionPlanDraft"],
): ModeOrchestrationPlan {
  const steps = templatePlan.steps.map((step, index) => {
    const planned = draft.steps[index];
    if (!planned) {
      return step;
    }
    if (shouldProtectPlannerTemplateStep(templatePlan, step, index)) {
      return {
        ...step,
        index: step.index,
        label: step.label,
      };
    }
    return {
      ...step,
      index: planned.index,
      objective: planned.objective,
      successCriteria: planned.successCriteria,
      suggestedTools: planned.suggestedTools,
      expectedOutput: planned.expectedOutput,
      parallelizable: planned.parallelizable,
      dependsOnStepIds: planned.dependsOnStepIds,
      delegatedRole: planned.delegatedRole ?? step.delegatedRole,
      label: step.label,
    };
  });
  return {
    ...templatePlan,
    summary: draft.summary,
    source: draft.source,
    advisoryOnly: draft.advisoryOnly,
    routeDecision: {
      ...templatePlan.routeDecision,
      selectedRoles: steps.map((step) => step.label ?? step.role),
      selectedProviders: steps.map((step) => ({
        role: step.label ?? step.role,
        providerId: step.providerId,
        model: step.model,
      })),
    },
    steps,
  };
}

function shouldProtectPlannerTemplateStep(
  plan: ModeOrchestrationPlan,
  step: ModeOrchestrationPlan["steps"][number],
  index: number,
): boolean {
  if (CONTROL_ORCHESTRATION_ROLES.has(step.role)) {
    return true;
  }
  const lastStepIndex = plan.steps.length - 1;
  return index === lastStepIndex && plan.steps.some((candidate) => candidate.role === "synthesizer");
}

function plannerStepOverridesTemplate(
  raw: Record<string, unknown>,
  templateStep: ModeOrchestrationPlan["steps"][number],
): boolean {
  const rawDependsOn = Array.isArray(raw.dependsOnStepIds)
    ? dedupeStrings(raw.dependsOnStepIds.filter((value): value is string => typeof value === "string"))
    : undefined;
  const rawSuggestedTools = Array.isArray(raw.suggestedTools)
    ? dedupeStrings(raw.suggestedTools.filter((value): value is string => typeof value === "string"))
    : undefined;
  return (
    (typeof raw.objective === "string" && raw.objective.trim() !== templateStep.objective) ||
    (typeof raw.successCriteria === "string" && raw.successCriteria.trim() !== (templateStep.successCriteria ?? "")) ||
    (typeof raw.expectedOutput === "string" && raw.expectedOutput.trim() !== (templateStep.expectedOutput ?? "")) ||
    (typeof raw.parallelizable === "boolean" && raw.parallelizable !== templateStep.parallelizable) ||
    (typeof raw.delegatedRole === "string" && raw.delegatedRole.trim() !== (templateStep.delegatedRole ?? "")) ||
    (rawDependsOn !== undefined && rawDependsOn.join("|") !== (templateStep.dependsOnStepIds ?? []).join("|")) ||
    (rawSuggestedTools !== undefined && rawSuggestedTools.join("|") !== (templateStep.suggestedTools ?? []).join("|"))
  );
}

export function parseLooseJsonRecord(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const direct = tryParseJsonRecordCandidate(trimmed);
  if (direct) return direct;
  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch?.[1]) {
    const parsed = tryParseJsonRecordCandidate(codeFenceMatch[1].trim());
    if (parsed) return parsed;
  }
  const openIndex = trimmed.indexOf("{");
  const closeIndex = trimmed.lastIndexOf("}");
  if (openIndex >= 0 && closeIndex > openIndex) {
    const candidate = trimmed.slice(openIndex, closeIndex + 1);
    const parsed = tryParseJsonRecordCandidate(candidate);
    if (parsed) return parsed;
  }
  const parsedScores = parseScoreRecordFromLooseText(trimmed);
  if (parsedScores) {
    return parsedScores;
  }
  return undefined;
}

function tryParseJsonRecordCandidate(candidate: string): Record<string, unknown> | undefined {
  const direct = safeJsonParse<Record<string, unknown> | undefined>(candidate, undefined);
  if (direct && typeof direct === "object") {
    return direct;
  }
  const repaired = normalizeJsonRecordCandidate(candidate);
  if (!repaired || repaired === candidate) {
    return undefined;
  }
  const parsed = safeJsonParse<Record<string, unknown> | undefined>(repaired, undefined);
  if (parsed && typeof parsed === "object") {
    return parsed;
  }
  return undefined;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeJsonRecordCandidate(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\\n/g, "\n")
    .trim();
}

function parseScoreRecordFromLooseText(raw: string): Record<string, unknown> | undefined {
  const normalized = raw.replace(/\*\*/g, "").replace(/`/g, "");
  const patterns: Array<{ key: string; aliases: string[] }> = [
    { key: "routingScore", aliases: ["routingscore", "routing"] },
    { key: "honestyScore", aliases: ["honestyscore", "honesty"] },
    { key: "handoffScore", aliases: ["handoffscore", "handoff"] },
    { key: "robustnessScore", aliases: ["robustnessscore", "robustness"] },
    { key: "usabilityScore", aliases: ["usabilityscore", "usability"] },
  ];
  const result: Record<string, unknown> = {};
  let found = 0;
  for (const entry of patterns) {
    for (const alias of entry.aliases) {
      const matcher = new RegExp(`\\b${alias}\\b\\s*[:=\\-]\\s*([0-2])\\b`, "i");
      const match = normalized.match(matcher);
      if (!match?.[1]) {
        continue;
      }
      result[entry.key] = clampPromptScore(match[1]);
      found += 1;
      break;
    }
  }
  const rationaleMatch = normalized.match(/\brationale\b\s*[:=]\s*([\s\S]{1,900})/i);
  if (rationaleMatch?.[1]) {
    result.rationale = rationaleMatch[1].trim().slice(0, 900);
  }
  if (found >= 3) {
    for (const entry of patterns) {
      if (!Object.hasOwn(result, entry.key)) {
        result[entry.key] = 1;
      }
    }
    return result;
  }
  return undefined;
}

function clampPromptScore(value: string | number): 0 | 1 | 2 {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  if (parsed >= 2) {
    return 2;
  }
  return 1;
}

export function extractCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const value = part as Record<string, unknown>;
        return typeof value.text === "string" ? value.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}
