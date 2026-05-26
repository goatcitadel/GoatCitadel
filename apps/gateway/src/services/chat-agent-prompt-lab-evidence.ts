import type { ChatToolRunRecord } from "@goatcitadel/contracts";

import { toolNameMatchesAnyKnownTool } from "./chat-agent-browser-results.js";

function truncatePromptLabPlainText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export const PROMPT_LAB_TEXTUAL_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".mts",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function buildPromptLabExactCitationAppendix(toolRuns: ChatToolRunRecord[]): string | undefined {
  const evidence = collectPromptLabConcreteReadEvidence(toolRuns).slice(0, 8);
  if (evidence.length === 0) {
    return undefined;
  }
  const citationByPath = new Map(
    collectPromptLabConcreteReadCitations(toolRuns).map((citation) => [citation.path.toLowerCase(), citation] as const),
  );
  const lines = ["Exact citations used:"];
  for (const item of evidence) {
    const citation = citationByPath.get(item.path.toLowerCase());
    const inline = formatPromptLabInlineCitation(citation ?? { path: item.path }, toolRuns);
    if (inline) {
      lines.push(`- ${inline}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

export function buildPromptLabExactCitationAppendixForPaths(
  toolRuns: ChatToolRunRecord[],
  allowedPaths: string[],
): string | undefined {
  const normalizedAllowedPaths = new Set(
    allowedPaths.map((path) => normalizePromptLabFilePath(path).toLowerCase()).filter(Boolean),
  );
  if (normalizedAllowedPaths.size === 0) {
    return undefined;
  }
  const evidence = collectPromptLabConcreteReadEvidence(toolRuns)
    .filter((item) => normalizedAllowedPaths.has(item.path.toLowerCase()))
    .slice(0, 8);
  if (evidence.length === 0) {
    return undefined;
  }
  const citationByPath = new Map(
    collectPromptLabConcreteReadCitations(toolRuns)
      .filter((citation) => normalizedAllowedPaths.has(citation.path.toLowerCase()))
      .map((citation) => [citation.path.toLowerCase(), citation] as const),
  );
  const lines = ["Exact citations used:"];
  for (const item of evidence) {
    const citation = citationByPath.get(item.path.toLowerCase());
    const inline = formatPromptLabInlineCitation(citation ?? { path: item.path }, toolRuns);
    if (inline) {
      lines.push(`- ${inline}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

export function formatPromptLabInlineCitation(
  citation: { path: string; startLine?: number; endLine?: number },
  toolRuns: ChatToolRunRecord[],
): string {
  const excerpt = extractPromptLabCitationExcerpt(citation.path, toolRuns);
  const anchoredLine =
    typeof citation.startLine === "number" && typeof excerpt?.lineOffset === "number"
      ? citation.startLine + excerpt.lineOffset
      : undefined;
  const broadRangeSpan =
    typeof citation.startLine === "number" && typeof citation.endLine === "number"
      ? citation.endLine - citation.startLine
      : undefined;
  const displayStartLine =
    anchoredLine ?? (typeof broadRangeSpan === "number" && broadRangeSpan > 24 ? undefined : citation.startLine);
  const displayEndLine =
    anchoredLine ?? (typeof broadRangeSpan === "number" && broadRangeSpan > 24 ? undefined : citation.endLine);
  const range =
    typeof displayStartLine === "number" && typeof displayEndLine === "number" && displayStartLine !== displayEndLine
      ? ` lines ${displayStartLine}-${displayEndLine}`
      : typeof displayStartLine === "number"
        ? ` line ${displayStartLine}`
        : "";
  const quote = excerpt?.quote;
  return quote ? `\`${citation.path}\`${range} ("${quote}")` : `\`${citation.path}\`${range}`;
}

export function formatPromptLabCitationForPath(filePath: string, toolRuns: ChatToolRunRecord[]): string | undefined {
  const citation = collectPromptLabConcreteReadCitations(toolRuns).find(
    (item) => item.path.toLowerCase() === normalizePromptLabFilePath(filePath).toLowerCase(),
  );
  return citation ? formatPromptLabInlineCitation(citation, toolRuns) : undefined;
}

export function extractPromptLabCitationQuote(filePath: string, toolRuns: ChatToolRunRecord[]): string | undefined {
  return extractPromptLabCitationExcerpt(filePath, toolRuns)?.quote;
}

export function extractPromptLabCitationExcerpt(
  filePath: string,
  toolRuns: ChatToolRunRecord[],
): { quote: string; lineOffset?: number } | undefined {
  const normalizedPath = normalizePromptLabFilePath(filePath).toLowerCase();
  const evidence = collectPromptLabConcreteReadEvidence(toolRuns).find(
    (item) => item.path.toLowerCase() === normalizedPath,
  );
  if (!evidence?.content) {
    return undefined;
  }
  const nonEmptyLines = evidence.content
    .split(/\r?\n/)
    .map((line, index) => ({ raw: line, line: line.trim(), index }))
    .filter(({ line }) => line.length > 0 && line !== "```");
  if (nonEmptyLines.length === 0) {
    return undefined;
  }
  const preferredPathSpecificPatterns: RegExp[] = [];
  if (/(?:^|\/)scripts\/run-prompt-pack-gates\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bresolvePromptPack\b/, /\bselectPromptPackGateTargetCodes\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/gateway\/update-review\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bparsePnpmOutdatedOutput\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/gateway\/update-review\.test\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bwrapped dependents\b/i, /\bparsePnpmOutdatedOutput\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bfindDuplicateInstallMatches\b/,
      /\bvalidateMaterialized\b/,
      /\bduplicateFamily\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.test\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bblocks overlapping Cloudflare-family installs\b/i, /\bskills\/extra\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\breplacePackTests\([\s\S]*sourceLabel\b/,
      /\bsourceLabel: input\.sourceLabel\b/,
      /\bsourceLabel: sourcePath\b/,
      /\brefreshPromptPackExportFile\b/,
      /\brenderPromptPackMarkdownReport\b/,
      /\breadPromptPackExportRecord\b/,
      /\bresolvePromptPackExportPath\b/,
      /\bparsePromptPackTests\b/,
      /\bensurePromptPackLoaded\b/,
      /\bresolvePromptPackJudgeTarget\b/,
    );
  }
  if (/(?:^|\/)packages\/storage\/src\/prompt-pack-repo\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bsource_label = excluded\.source_label\b/,
      /\bsourceLabel: input\.sourceLabel \?\? null\b/,
      /\bsourceLabel: row\.source_label \?\? undefined\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.parser-report\.test\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bparses the focused v2 prompt pack markdown\b/i,
      /\bpreserves the real env prompt-pack source label\b/i,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.scoring\.test\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bresolvePromptPackJudgeTarget\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bhandleWakeEffect\b/,
      /\benqueueResolutionEffects\b/,
      /\bskipEffect\b/,
      /\bmarkResolved\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bwakeDurableRun\b/, /\bpaused\b/, /\bwaiting\b/, /\bDurableWakeResult\b/);
  }
  if (/(?:^|\/)packages\/contracts\/src\/durable\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bDurableWakeResult\b/, /\bDurableWakeOutcome\b/, /\bDurableRunStatus\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/durable\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\/api\/v1\/durable\/runs\/:runId\/events\/wake\b/,
      /\bwakeDurableRun\b/,
      /\bDurableWakeResult\b/,
    );
  }
  if (
    /(?:^|\/)(?:packages\/mission-control-shared|apps\/mission-control)\/src\/api\/durable\.ts$/i.test(normalizedPath)
  ) {
    preferredPathSpecificPatterns.push(/\bDurableWakeResult\b/, /\bwakeDurableRun\b/, /\bfetchDurableRun\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bapproval_linkage\b/,
      /\bfallback_payload\b/,
      /\bfallback_preview\b/,
      /\bfallbackSources\b/,
      /\bsessionIdSource\b/,
      /\brunIdSource\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/approval-lifecycle-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\blinkage\b/,
      /\benqueueResolutionEffects\b/,
      /\bresolveApproval\b/,
      /\bpayload\b/,
      /\bpreview\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/approvals\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\blinkage\b/, /\bapproval\b/, /\bpayload\b/, /\bpreview\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/events\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\beventClass\b/, /\beventAuthority\b/, /\blinks\b/, /\/api\/v1\/events/);
  }
  if (/(?:^|\/)packages\/storage\/src\/realtime-event-repo\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bevent_class\b/,
      /\bevent_authority\b/,
      /\b__gcEventLinks\b/,
      /\bappend\b/,
      /\blist\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/realtime-event-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\beventClass\b/, /\beventAuthority\b/, /\blinks\b/, /\bpublish\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/realtime-events-route-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\beventClass\b/, /\beventAuthority\b/, /\blinks\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bconst selected = workspaceDoc\.exists \? workspaceDoc : globalDoc\.exists \? globalDoc : undefined\b/,
      /\bselected\.scope === "workspace"\b/,
      /\bworkspaceFilesUsed\.push\b/,
      /\bglobalFilesUsed\.push\b/,
      /\bresolveRuntimeGuidance\b/,
      /\bworkspace overrides taking precedence over global defaults\b/i,
      /\blistWorkspaceGuidance\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/chat-turn-prep-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bresolveRuntimeGuidance\(workspaceId\)/, /\bprepareAgentChatTurn\b/);
  }
  if (/(?:^|\/)apps\/gateway\/src\/routes\/memory\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bmemoryRoutes\b/,
      /\bregisterMemoryRoutes\b/,
      /\/api\/v1\/memory\/context\/compose/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/memory-route-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(
      /\bMemoryRoutePort\b/,
      /\bcomposeMemoryContext\b/,
      /\brunMemoryMaintenanceNow\b/,
    );
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/memory-context-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bMemoryContextService\b/, /\bcomposeMemoryContext\b/, /\bdistill\b/i);
  }
  if (/(?:^|\/)apps\/gateway\/src\/services\/memory-lifecycle-service\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bMemoryLifecycleService\b/, /\bprune\b/i, /\bmaintenance\b/i);
  }
  if (/(?:^|\/)packages\/storage\/src\/memory-context-repo\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\bMemoryContextRepository\b/, /\bupsert\s*\(/, /\bfindFreshByCacheKey\s*\(/);
  }
  if (
    /(?:^|\/)apps\/mission-control-next\/src\/features\/native-routes\/library\/MemoryRoutePage\.tsx$/i.test(
      normalizedPath,
    )
  ) {
    preferredPathSpecificPatterns.push(
      /\bMemoryRoutePage\b/,
      /\bfetchMemoryItems\b/,
      /\bfetchMemoryQmdStats\b/,
      /\bfetchMemoryMaintenanceStatus\b/,
    );
  }
  if (/(?:^|\/)packages\/mission-control-shared\/src\/hooks\/useMemoryOperatorSnapshot\.ts$/i.test(normalizedPath)) {
    preferredPathSpecificPatterns.push(/\buseMemoryOperatorSnapshot\b/);
  }

  const pathSpecificPreferred = preferredPathSpecificPatterns
    .map((pattern) =>
      nonEmptyLines.find(
        ({ line }) =>
          !/^[{[]?\s*['"]content['"]\s*:/.test(line) && !/^['"]path['"]\s*:/.test(line) && pattern.test(line),
      ),
    )
    .find(Boolean);
  if (pathSpecificPreferred) {
    return {
      quote: truncatePromptLabPlainText(pathSpecificPreferred.line.replace(/^#+\s*/, "").replace(/"/g, "'"), 140),
      lineOffset: pathSpecificPreferred.index,
    };
  }
  const preferred =
    nonEmptyLines.find(
      ({ line }) =>
        !/^import\s+/i.test(line) &&
        !/^\/\*/.test(line) &&
        !/^\*|^\/\//.test(line) &&
        !/^[{[]?\s*['"]content['"]\s*:/.test(line) &&
        !/^['"]path['"]\s*:/.test(line) &&
        (/\b(?:export|async|function|class|interface|type|const|describe|it|test|fastify\.)\b/.test(line) ||
          /\/api\/v1\//.test(line)),
    ) ??
    nonEmptyLines.find(({ line }) => line.length >= 24 && !/^#+\s*$/.test(line) && !/^import\s+/i.test(line)) ??
    nonEmptyLines.find(({ line }) => !/^#+\s*$/.test(line)) ??
    nonEmptyLines[0];
  if (!preferred) {
    return undefined;
  }
  return {
    quote: truncatePromptLabPlainText(preferred.line.replace(/^#+\s*/, "").replace(/"/g, "'"), 140),
    lineOffset: preferred.index,
  };
}

export function extractPromptLabExactBulletLabels(prompt: string): string[] {
  const labelsLine = prompt
    .split(/\r?\n/)
    .find((line) =>
      /\b(?:use|return|provide)\s+exactly\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+bullets?\s+labeled\b/i.test(
        line,
      ),
    );
  if (!labelsLine) {
    return [];
  }
  return [...labelsLine.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

export function promptLabForbidsTemplateOrPlaceholderCitations(prompt: string): boolean {
  return (
    /\bdo not cite\b[\s\S]{0,120}\btemplate files?\b/i.test(prompt) ||
    /\bdo not cite\b[\s\S]{0,120}\bplaceholder paths?\b/i.test(prompt) ||
    /\bwithout template leakage\b/i.test(prompt)
  );
}

export function isPromptLabTemplateOrPlaceholderPath(path: string): boolean {
  const normalized = normalizePromptLabFilePath(path);
  return /(?:^|\/)templates?\//i.test(normalized) || /\{\{[^}]+\}\}/.test(normalized);
}

export function promptLabPathAllowedByPrompt(path: string, prompt: string): boolean {
  if (!path) {
    return false;
  }
  if (promptLabForbidsTemplateOrPlaceholderCitations(prompt) && isPromptLabTemplateOrPlaceholderPath(path)) {
    return false;
  }
  return true;
}

export function filterPromptLabExactFilePathsForPrompt(paths: string[], prompt: string): string[] {
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const rawPath of paths) {
    if (!rawPath || !promptLabPathAllowedByPrompt(rawPath, prompt)) {
      continue;
    }
    const normalized = normalizePromptLabFilePath(rawPath);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    filtered.push(normalized);
  }
  return filtered;
}

export function filterPromptLabConcreteReadEvidenceForPrompt(
  evidence: Array<{ path: string; content: string }>,
  prompt: string,
): Array<{ path: string; content: string }> {
  return evidence.filter((item) => promptLabPathAllowedByPrompt(item.path, prompt));
}

export function filterPromptLabConcreteReadCitationsForPrompt(
  citations: Array<{ path: string; startLine?: number; endLine?: number }>,
  prompt: string,
): Array<{ path: string; startLine?: number; endLine?: number }> {
  return citations.filter((citation) => promptLabPathAllowedByPrompt(citation.path, prompt));
}

export function collectPromptLabConcreteReadEvidence(
  toolRuns: ChatToolRunRecord[],
): Array<{ path: string; content: string }> {
  const evidenceByPath = new Map<string, { path: string; content: string }>();
  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      !toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"])) ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const rawPath =
      typeof result.path === "string" ? result.path : typeof run.args?.path === "string" ? run.args.path : undefined;
    if (!rawPath) {
      continue;
    }
    const normalizedPath = normalizePromptLabFilePath(rawPath);
    const key = normalizedPath.toLowerCase();
    const nextContent = normalizePromptLabEvidenceContent(
      typeof result.content === "string"
        ? result.content
        : typeof result.bodySnippet === "string"
          ? result.bodySnippet
          : typeof result.snippet === "string"
            ? result.snippet
            : "",
    );
    const existing = evidenceByPath.get(key);
    if (!existing) {
      evidenceByPath.set(key, {
        path: normalizedPath,
        content: nextContent,
      });
      continue;
    }
    if (nextContent && !existing.content.includes(nextContent)) {
      existing.content = [existing.content, nextContent].filter(Boolean).join("\n");
    }
    evidenceByPath.set(key, {
      path: normalizedPath,
      content: existing.content,
    });
  }
  return [...evidenceByPath.values()];
}

export function normalizePromptLabEvidenceContent(content: string): string {
  let normalized = content.trim();
  const serializedPayloadContent = extractPromptLabEvidenceTextFromSerializedPayload(normalized);
  if (serializedPayloadContent) {
    normalized = serializedPayloadContent;
  }
  const wrappedContentMatch = normalized.match(/^[{[]?\s*['"]content['"]\s*:\s*(['"])([\s\S]*)\1\s*[,}]?\s*$/);
  if (wrappedContentMatch?.[2]) {
    normalized = wrappedContentMatch[2];
  }
  if (/\\[rn]/.test(normalized)) {
    normalized = normalized
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t");
  }
  return normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"');
}

export function extractPromptLabEvidenceTextFromSerializedPayload(content: string): string | undefined {
  const trimmed = content.trim();
  if (
    !/^(?:\{|\[)/.test(trimmed) ||
    !/['"](content|bodySnippet|snippet|text|body|message|path)['"]\s*:/.test(trimmed)
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return readPromptLabEvidenceTextFromPayload(parsed);
  } catch {
    const singleQuotedContentMatch = trimmed.match(/['"]content['"]\s*:\s*'([\s\S]*?)'(?:\s*[,}])/);
    if (singleQuotedContentMatch?.[1]) {
      return singleQuotedContentMatch[1]
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\'/g, "'");
    }
    const doubleQuotedContentMatch = trimmed.match(/['"]content['"]\s*:\s*"([\s\S]*?)"(?:\s*[,}])/);
    if (doubleQuotedContentMatch?.[1]) {
      return doubleQuotedContentMatch[1]
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"');
    }
    return undefined;
  }
}

export function readPromptLabEvidenceTextFromPayload(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["content", "bodySnippet", "snippet", "text", "body", "message"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function collectPromptLabConcreteReadCitations(
  toolRuns: ChatToolRunRecord[],
): Array<{ path: string; startLine?: number; endLine?: number }> {
  const seen = new Set<string>();
  const citations: Array<{ path: string; startLine?: number; endLine?: number }> = [];
  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      !toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"])) ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const rawPath =
      typeof result.path === "string" ? result.path : typeof run.args?.path === "string" ? run.args.path : undefined;
    if (!rawPath) {
      continue;
    }
    const normalizedPath = normalizePromptLabFilePath(rawPath);
    const key = normalizedPath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const startLine =
      typeof result.startLine === "number"
        ? result.startLine
        : typeof run.args?.startLine === "number"
          ? run.args.startLine
          : undefined;
    const endLine =
      typeof result.endLine === "number"
        ? result.endLine
        : typeof run.args?.endLine === "number"
          ? run.args.endLine
          : undefined;
    citations.push({
      path: normalizedPath,
      startLine,
      endLine,
    });
  }
  return citations;
}

export function pickPromptLabConcreteReadEvidence(
  evidence: Array<{ path: string; content: string }>,
  predicate: (item: { path: string; content: string }) => boolean,
): { path: string; content: string } | undefined {
  return evidence.find(predicate);
}

export function selectPromptLabConcreteReadPathsFromSearchResult(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("matches" in result) || !Array.isArray(result.matches)) {
    return [];
  }
  const uniquePaths = [
    ...new Set(
      result.matches
        .map((match) => {
          if (!match || typeof match !== "object") {
            return undefined;
          }
          const candidatePath = "path" in match && typeof match.path === "string" ? match.path.trim() : "";
          const candidateType = "type" in match && typeof match.type === "string" ? match.type : undefined;
          return looksLikePromptLabConcreteFileCandidate(candidatePath, candidateType) ? candidatePath : undefined;
        })
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (uniquePaths.length === 0) {
    return [];
  }

  const rankedPaths = [...uniquePaths].sort(
    (left, right) => scorePromptLabConcreteReadCandidate(right) - scorePromptLabConcreteReadCandidate(left),
  );
  const selected: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (!candidate || selected.includes(candidate)) {
      return;
    }
    selected.push(candidate);
  };

  const implementationPath = rankedPaths.find(
    (value) =>
      !/(?:^|\/)(?:docs?|artifacts)\//i.test(value) && !/\.test\.[^.]+$/i.test(value) && !/\.spec\.[^.]+$/i.test(value),
  );
  const companionPath = rankedPaths.find(
    (value) =>
      value !== implementationPath &&
      (/(?:^|\/)docs?\//i.test(value) ||
        /\.test\.[^.]+$/i.test(value) ||
        /\.spec\.[^.]+$/i.test(value) ||
        (/\.md$/i.test(value) && !/(?:^|\/)artifacts\//i.test(value))),
  );
  const artifactPath = rankedPaths.find(
    (value) => value !== implementationPath && value !== companionPath && /(?:^|\/)artifacts\//i.test(value),
  );
  const adjacentImplementationPath = rankedPaths.find(
    (value) =>
      value !== implementationPath &&
      value !== companionPath &&
      !/(?:^|\/)(?:docs?|artifacts)\//i.test(value) &&
      !/\.test\.[^.]+$/i.test(value) &&
      !/\.spec\.[^.]+$/i.test(value),
  );

  add(implementationPath);
  add(companionPath);
  add(adjacentImplementationPath);
  add(artifactPath);
  for (const value of rankedPaths) {
    if (selected.length >= 3) {
      break;
    }
    add(value);
  }
  return selected.slice(0, 3);
}

export function looksLikePromptLabConcreteFileCandidate(path: string, type?: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (
    type === "dir" ||
    !normalized ||
    /\/$/.test(normalized) ||
    /(?:^|\/)(?:\.codex-tmp|\.worktrees|data\/tool-artifacts|node_modules|dist|build|coverage|vendor|third_party)(?:\/|$)/i.test(
      normalized,
    )
  ) {
    return false;
  }
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? "";
  if (!basename) {
    return false;
  }
  const extMatch = basename.match(/(\.[a-z0-9]+)$/i);
  const extension = extMatch?.[1]?.toLowerCase();
  if (!extension) {
    return /^(readme|makefile|dockerfile|justfile)$/i.test(basename);
  }
  return PROMPT_LAB_TEXTUAL_FILE_EXTENSIONS.has(extension);
}

export function scorePromptLabConcreteReadCandidate(path: string): number {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  let score = 0;
  if (/(?:^|\/)(apps|packages|scripts|docs|src|test|tests)\//.test(normalized)) {
    score += 20;
  }
  if (
    /(?:^|\/)(?:artifacts\/prompt-lab|artifacts|dist|build|coverage|node_modules|\.worktrees|\.codex-tmp|data\/tool-artifacts|vendor|third_party|ggml)\//.test(
      normalized,
    )
  ) {
    score -= 30;
  }
  if (/(?:^|\/)templates?\//.test(normalized) || /{{[a-z0-9_]+}}/i.test(normalized)) {
    score -= 24;
  }
  if (/\.test\.[^.]+$|\.spec\.[^.]+$/.test(normalized)) {
    score += 6;
  }
  if (/\.md$/.test(normalized)) {
    score += 5;
  }
  if (!/\.test\.[^.]+$|\.spec\.[^.]+$|\.md$/.test(normalized)) {
    score += 10;
  }
  if (/(?:^|\/)(?:routes|services|orchestration|contracts|storage)\//.test(normalized)) {
    score += 4;
  }
  if (/(?:^|\/)(?:routes|services)\//.test(normalized)) {
    score += 6;
  }
  if (/\bprompt-pack\b|prompt_pack|promptpacksworkbench|prompt-packs-workbench/.test(normalized)) {
    score += 14;
  }
  if (/(?:^|\/)packages\/storage\/src\/prompt-pack-/.test(normalized)) {
    score += 10;
  }
  if (/(?:^|\/)apps\/mission-control-next\/src\/features\/prompt-packs\//.test(normalized)) {
    score += 10;
  }
  return score;
}

export function collectPromptLabConcreteReadPaths(toolRuns: ChatToolRunRecord[]): Set<string> {
  const observed = new Set<string>();
  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      !toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"]))
    ) {
      continue;
    }
    const resultPath =
      run.result && typeof run.result === "object" && typeof (run.result as { path?: unknown }).path === "string"
        ? (run.result as { path: string }).path
        : undefined;
    const argsPath = typeof run.args?.path === "string" ? run.args.path : undefined;
    const candidate = resultPath ?? argsPath;
    if (!candidate) {
      continue;
    }
    observed.add(normalizePromptLabFilePath(candidate).toLowerCase());
  }
  return observed;
}

export function promptLabConcreteReadSetMatchesPath(observedPaths: Set<string>, filePath: string): boolean {
  const normalized = normalizePromptLabFilePath(filePath).toLowerCase();
  if (observedPaths.has(normalized)) {
    return true;
  }
  for (const observed of observedPaths) {
    if (observed.endsWith(`/${normalized}`)) {
      return true;
    }
  }
  return false;
}

export function normalizePromptLabFilePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const repoMarker = "/personal-ai/";
  const markerIndex = normalized.toLowerCase().indexOf(repoMarker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + repoMarker.length);
  }
  return normalized.replace(/^\.\//, "");
}
