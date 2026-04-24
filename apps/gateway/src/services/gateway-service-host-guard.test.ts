import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SERVICES_DIR = new URL(".", import.meta.url);
const HOST_GUARD_EXCLUDED_PATHS = new Set([
  "gateway-service.ts",
  "gateway-runtime-factory.ts",
  "service-context.ts",
  "gateway/build-service-context.ts",
]);

const HOST_COUPLING_PATTERNS = [
  /import\s+(?:type\s+)?\{[^}]*\bGatewayService\b[^}]*\}\s+from\s+"[^"]*gateway-service\.js";/m,
  /type\s+\w+Host\s*=\s*GatewayService\b/m,
  /GatewayService\["[^"]+"\]/m,
];

const EXTRACTED_GATEWAY_SERVICE_SYMBOLS = [
  "ApprovalReplayResult",
  "ApprovalResolveResult",
  "DurableChatTurnExecutionPayload",
  "DurableChatTurnUserInputResumeRecord",
  "InspectableChatStreamChunk",
  "PersistableChatStreamChunk",
  "PreparedChatExecutionPlanResolution",
  "RemoteApprovalActionTokenIssueResult",
  "RuntimeSettings",
  "ResolvedRuntimeGuidance",
  "CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT",
  "CHAT_PLANNER_MAX_STEPS",
  "CHAT_PLANNER_MIN_STEPS",
  "ChatTurnCancelledError",
  "CompanionAccessValidationResult",
  "CompanionSessionRecord",
  "DEFAULT_DELEGATION_ROLES",
  "applyExecutionPlanDraftToOrchestrationPlan",
  "buildCompanionSigningPayload",
  "buildDelegationFailureGuidance",
  "buildEmptyAssistantTurnFallbackText",
  "buildExecutionPlanDraftFromOrchestrationPlan",
  "buildMemoryContextSystemMessage",
  "buildPlanningModeSystemInstruction",
  "buildRetrievalTrace",
  "buildRoleGapSpecialistSuggestion",
  "buildSpecialistMatchReason",
  "buildSpecialistSuggestionFromCapability",
  "calculateSavings",
  "coercePlannerExecutionPlanDraft",
  "createChatCompletionDeadline",
  "decodeBase64Url",
  "dedupeChatCitations",
  "delayChatCompletionRetry",
  "detectDelegationRoles",
  "extractCompletionText",
  "extractSpecialistObjectiveKeywords",
  "extractPromptFromMessages",
  "getRemainingChatCompletionTimeoutMs",
  "inferDegradedAssistantTurnFailure",
  "inferSpecialistBaseRole",
  "isChatTurnCancelledError",
  "isCompanionSessionCurrentlyActive",
  "isCompanionSessionOperatorActive",
  "isCompanionSessionRefreshable",
  "isImageMimeType",
  "isPersistableChatStreamChunk",
  "isRecord",
  "mapCompanionSessionRow",
  "mergeChatSystemInstructions",
  "mergeExecutionPlanStepStatuses",
  "mergeSpecialistEvidence",
  "mergeSpecialistRoutingHints",
  "normalizeChatInputParts",
  "normalizeChatCompletionAttemptError",
  "normalizeCompanionAuditEvent",
  "normalizeCompanionNonce",
  "normalizeCompanionRequestPath",
  "normalizeCompanionSignature",
  "normalizeSpecialistCandidateFingerprint",
  "normalizeToolProtocolRetryRequest",
  "parseLooseJsonRecord",
  "renderExecutionPlanAsMarkdown",
  "scoreSpecialistCandidateMatch",
  "shouldRetryToolProtocolError",
  "shouldRetryTransientProviderError",
  "splitIntoChunks",
  "toCompanionSessionAdminRecord",
  "toCompanionSessionInfoResponse",
  "toTitleCase",
  "truncateSummaryLine",
];

async function collectServiceFiles(dir: URL, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectServiceFiles(new URL(`${entry.name}/`, dir), relativePath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    files.push(relativePath);
  }

  return files;
}

describe("gateway service host guard", () => {
  it("does not allow GatewayService host coupling outside gateway-service.ts", async () => {
    const files = await collectServiceFiles(SERVICES_DIR);
    const offenders: string[] = [];

    for (const relativePath of files) {
      if (HOST_GUARD_EXCLUDED_PATHS.has(relativePath)) {
        continue;
      }
      const source = await fs.readFile(new URL(relativePath, SERVICES_DIR), "utf8");
      if (HOST_COUPLING_PATTERNS.some((pattern) => pattern.test(source))) {
        offenders.push(relativePath);
      }
    }

    offenders.sort();
    expect(offenders).toEqual([]);
  });

  it("does not allow imports of extracted helper and payload types from gateway-service.ts", async () => {
    const files = await collectServiceFiles(SERVICES_DIR);
    const offenders: string[] = [];

    for (const relativePath of files) {
      if (relativePath === "gateway-service.ts") {
        continue;
      }
      const source = await fs.readFile(new URL(relativePath, SERVICES_DIR), "utf8");
      const importedSymbols = extractGatewayServiceNamedImports(source);
      const extractedImports = importedSymbols.filter((symbol) => EXTRACTED_GATEWAY_SERVICE_SYMBOLS.includes(symbol));
      if (extractedImports.length > 0) {
        offenders.push(`${relativePath}: ${extractedImports.sort().join(", ")}`);
      }
    }

    offenders.sort();
    expect(offenders).toEqual([]);
  });
});

function extractGatewayServiceNamedImports(source: string): string[] {
  const importedSymbols: string[] = [];
  const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?\{(?<symbols>[\s\S]*?)\}\s+from\s+"[^"]*gateway-service\.js";?/g;
  for (const match of source.matchAll(importPattern)) {
    const symbols = match.groups?.symbols;
    if (!symbols) {
      continue;
    }
    importedSymbols.push(
      ...symbols
        .split(",")
        .map((symbol) =>
          symbol
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/i)[0]
            ?.trim(),
        )
        .filter((symbol): symbol is string => Boolean(symbol)),
    );
  }
  return importedSymbols;
}
