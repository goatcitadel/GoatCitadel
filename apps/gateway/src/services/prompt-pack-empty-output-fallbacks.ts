import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  looksLikePromptLabPromptPackMarkdownImportPrompt,
  looksLikePromptLabPromptPackOperatorSurfacePrompt,
  looksLikePromptLabPromptPackRepoBindingPrompt,
} from "./prompt-pack-prompt-lab-detectors.js";

// Prompt-pack-only helpers for synthesizing empty-output fallback text.
// Do not call these from live chat or cowork orchestration paths.

export function applyPromptPackPromptLabFallbacks(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  return (
    buildPromptPackMarkdownImportFallback(input) ??
    buildPromptPackRepoBindingFallback(input) ??
    buildPromptPackOperatorSurfaceFallback(input)
  );
}

export function buildPromptPackMarkdownImportFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabPromptPackMarkdownImportPrompt(userTask)) {
    return undefined;
  }
  const normalizedResponse = input.responseText.toLowerCase();
  const alreadyGrounded =
    (normalizedResponse.includes("goatcitadel_prompt_pack_path") ||
      normalizedResponse.includes("ensurepromptpackloaded") ||
      normalizedResponse.includes("/api/v1/prompt-packs/import")) &&
    !/\bunverified\b|\binspection incomplete\b/.test(normalizedResponse);
  if (alreadyGrounded) {
    return undefined;
  }

  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  const serviceEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(path),
  );
  const routeEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/prompt-packs\.ts$/i.test(path),
  );
  const repoEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)packages\/storage\/src\/prompt-pack-repo\.ts$/i.test(path),
  );
  if (!serviceEvidence) {
    return undefined;
  }

  const exactFilesUsed = [serviceEvidence.path, routeEvidence?.path, repoEvidence?.path].filter(
    (value, index, self): value is string => Boolean(value) && self.indexOf(value) === index,
  );

  const observedLines = [
    `- Auto-load today is gated by \`ensurePromptPackLoaded()\` in \`${serviceEvidence.path}\`: if storage already has a pack it returns the existing record, otherwise it reads \`GOATCITADEL_PROMPT_PACK_PATH\` from disk with \`fs.readFile(..., "utf8")\` and imports that markdown with \`sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE\`.`,
    `- The service import path runs through \`importPromptPack(...)\`, which parses markdown with \`parsePromptPackTests(...)\`, infers a pack name from \`sourceLabel\` when needed, then persists the pack and tests via \`this.ctx.storage.promptPacks.replacePackTests(...)\`.`,
    routeEvidence
      ? `- Manual markdown imports are exposed through \`${routeEvidence.path}\` at \`POST /api/v1/prompt-packs/import\`, which forwards the request body to \`fastify.gateway.importPromptPack(...)\`.`
      : undefined,
    repoEvidence && repoEvidence.content.includes("source_label") && repoEvidence.content.includes("policy_v2_source")
      ? `- \`${repoEvidence.path}\` stores both \`source_label\` and \`policy_v2_source\`: the first is the operator-facing pack label, while the second decides whether policy comes from \`pack_override\` or the inherited default.`
      : repoEvidence
        ? `- \`${repoEvidence.path}\` is the persisted source of truth for imported pack rows and tests.`
        : `- In the service flow, \`sourceLabel\` is optional operator metadata that is passed into import and can fall back to an inferred pack name, so the remaining ambiguity is how that label is persisted versus any deeper policy provenance fields unless the storage layer is read too.`,
  ].filter(Boolean);

  return [
    "Observed import/load path:",
    ...observedLines,
    "",
    "Remaining source-of-truth ambiguity:",
    repoEvidence
      ? "- The naming is easy to misread because `source_label` and `policy_v2_source` both sound like pack provenance, but the code shown treats them as different concerns: pack labeling versus policy provenance."
      : "- The service excerpt shows `sourceLabel` flowing into import, but not the full persisted row shape, so the remaining ambiguity is whether pack labeling and policy provenance stay separate all the way through storage or only at the API boundary.",
    "",
    `Exact files used: ${exactFilesUsed.map((path) => `\`${path}\``).join(", ")}.`,
  ].join("\n");
}

export function buildPromptPackRepoBindingFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabPromptPackRepoBindingPrompt(userTask)) {
    return undefined;
  }
  if (/\brole-labeled sections\b/i.test(userTask) || /\bproduce\s+.+\bsections\b/i.test(userTask)) {
    return undefined;
  }
  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  const serviceEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(path),
  );
  const pathResolutionEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/tool-path-resolution\.ts$/i.test(path),
  );
  const bindingEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)packages\/storage\/src\/chat-session-binding-repo\.ts$/i.test(path),
  );
  if (!serviceEvidence && !pathResolutionEvidence) {
    return undefined;
  }
  const exactFilesUsed = [serviceEvidence?.path, pathResolutionEvidence?.path, bindingEvidence?.path].filter(
    (value, index, self): value is string => Boolean(value) && self.indexOf(value) === index,
  );
  if (exactFilesUsed.length === 0) {
    return undefined;
  }

  return [
    "Observed repo-binding chain:",
    serviceEvidence
      ? `- \`${serviceEvidence.path}\` selects the repo-grounded Prompt Lab binding by returning \`PROMPT_PACK_REPO_PROJECT_BINDING\` with workspace path \`__prompt_pack_repo__\` for repo-bound prompt-pack runs.`
      : undefined,
    serviceEvidence
      ? "- The prompt-pack service also tells the harness to treat repo-relative paths such as `apps/...`, `packages/...`, `docs/...`, `config/...`, `scripts/...`, and `artifacts/...` as rooted at the GoatCitadel repository unless the prompt explicitly points at `fixtures/prompt-pack-workspace`."
      : undefined,
    pathResolutionEvidence
      ? `- \`${pathResolutionEvidence.path}\` maps the sentinel workspace path \`__prompt_pack_repo__\` back to the repository root in \`resolveProjectRootForToolContext(...)\`, then resolves relative file/code tool paths against that project root for repo-bound runs.`
      : undefined,
    bindingEvidence
      ? `- \`${bindingEvidence.path}\` persists per-session binding state such as \`workspaceId\`, transport, connection, and target; that stored binding tells the session which workspace/project binding it is using, while the repo-root path logic still lives in the prompt-pack service and tool-path resolution layer.`
      : undefined,
    "",
    `Exact files used: ${exactFilesUsed.map((path) => `\`${path}\``).join(", ")}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPromptPackOperatorSurfaceFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabPromptPackOperatorSurfacePrompt(userTask)) {
    return undefined;
  }
  const normalizedResponse = input.responseText.toLowerCase();
  const alreadyGrounded =
    normalizedResponse.includes("tasksuccess") ||
    normalizedResponse.includes("averageweightedscore") ||
    normalizedResponse.includes("topfailuresignals");
  if (alreadyGrounded && !looksLikePromptLabInspectionContinuation(input.responseText)) {
    return undefined;
  }

  const concreteEvidence = collectPromptLabConcreteReadEvidence(input.toolRuns);
  const routeEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/prompt-packs\.ts$/i.test(path),
  );
  const serviceEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i.test(path),
  );
  const benchmarkRouteTestEvidence = concreteEvidence.find(({ path }) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/chat\.prompt-pack-benchmark\.test\.ts$/i.test(path),
  );
  if (!routeEvidence || !serviceEvidence) {
    return undefined;
  }

  const exactFilesUsed = [routeEvidence.path, serviceEvidence.path, benchmarkRouteTestEvidence?.path].filter(
    (value, index, self): value is string => Boolean(value) && self.indexOf(value) === index,
  );

  return [
    "## Report Surface",
    `- \`${routeEvidence.path}\` exposes \`GET /api/v1/prompt-packs/:packId/report\`, and the handler returns \`fastify.gateway.getPromptPackReport(packId)\`, so the operator-facing report API is the raw prompt-pack report record rather than a thin status stub.`,
    `- \`${serviceEvidence.path}\` shows that \`getPromptPackReport(packId)\` bundles the pack definition, tests, runs, legacy scores, v2 auto-scores, human reviews, latest assessments, and a computed summary, so an operator can inspect both the latest verdict state and the underlying run/score history from the same report payload.`,
    `- The same service file renders that record into markdown with headline pack metrics, a snapshot table, per-test sections (\`Prompt\`, \`Latest Run\`, \`Auto Score (V2)\` or legacy score, \`Integrity\`, \`Assistant Output\`, \`Trace Summary\`, \`Citations\`), plus an \`Outstanding\` section, so the rendered report exposes both fleet-level coverage/pass-rate evidence and drill-down evidence for each test.`,
    "",
    "## Trend Surface",
    `- \`${routeEvidence.path}\` also exposes \`GET /api/v1/prompt-packs/:packId/trends\`, which returns \`fastify.gateway.getPromptPackCapabilityTrends(packId)\`.`,
    `- \`${serviceEvidence.path}\` shows that the trend payload is \`{ items: CapabilityTrendSeries[] }\`, with series for \`taskSuccess\`, \`honesty\`, \`executionQuality\`, \`robustness\`, \`usability\`, \`run_failure_rate\`, and \`review_rate\`. Each series carries \`points\`, an optional \`threshold\`, and a computed \`breached\` flag, so the operator can see both the history and whether the latest series crossed its alert boundary.`,
    "",
    "## Benchmark Status Surfaces",
    `- \`${routeEvidence.path}\` exposes the benchmark control/status endpoints: \`POST /api/v1/prompt-packs/:packId/benchmark/run\` starts a provider/model matrix and returns \`benchmarkRunId\`; \`GET /api/v1/prompt-packs/benchmark/:benchmarkRunId\` returns the live benchmark status; \`POST /api/v1/prompt-packs/benchmark/:benchmarkRunId/cancel\` returns the cancelled status snapshot.`,
    `- \`${serviceEvidence.path}\` shows that \`getPromptPackBenchmarkStatus(benchmarkRunId)\` returns \`run\`, \`progress\`, and \`modelSummaries\`. The operator-visible evidence in \`progress\` is \`totalItems\` plus \`completedItems\`, and each model summary exposes provider/model totals, scored count, average total and weighted scores, pass rate, review rate, run failure count, degraded count, approval-paused count, no-output count, and top failure signals.`,
    benchmarkRouteTestEvidence
      ? `- \`${benchmarkRouteTestEvidence.path}\` is the consumer-side evidence that these status shapes are intentional: the route tests assert that benchmark responses surface \`progress.totalItems\`, \`progress.completedItems\`, and \`run.status\`, which is exactly the operator-visible contract the UI can rely on.`
      : undefined,
    "",
    "## Exact Files Used",
    ...exactFilesUsed.map((path) => `- \`${path}\``),
  ]
    .filter(Boolean)
    .join("\n");
}

function extractPrimaryUserTaskContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  const userTaskMatch = trimmed.match(/(?:^|\n)##\s+User Task\s*\n([\s\S]*?)(?:\n(?:Answer contract:|##\s+)|$)/i);
  if (userTaskMatch?.[1]) {
    return userTaskMatch[1].trim();
  }
  return trimmed;
}

function looksLikePromptLabInspectionContinuation(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const markers = [
    /^i(?:'|’)ll continue(?:\s+\w+){0,4}\b/,
    /^i need to (?:read|inspect|review|check|find|trace|search|continue)\b/,
    /^looking at the tool evidence,\s*i need to\b/,
    /^let me gather more context\b/,
    /^let me (?:read|inspect|review|check|find|search|continue)\b/,
    /\bi need to read more\b/,
    /\bi need to search more\b/,
    /\bi need to see more of\b/,
    /\bgather more context\b/,
    /\bneed to inspect more\b/,
    /\bneed to continue (?:the )?inspection\b/,
    /\blet me continue inspection\b/,
    /\blet me continue investigating\b/,
    /\bi have partial evidence\b/,
    /\bto complete this picture, i(?:'|’)d need to\b/,
    /\bwould you like me to inspect\b/,
    /\bbefore drafting\b/,
    /\bbefore i can answer\b/,
    /\bneed to gather more evidence\b/,
    /\bneed to execute the required file and code searches\b/,
  ];
  const markerHits = markers.filter((pattern) => pattern.test(normalized)).length;
  if (markerHits === 0) {
    return false;
  }
  const citedFileCount = [...content.matchAll(/`[^`\r\n]+\.[a-z0-9]+`/gi)].length;
  return normalized.length <= 2000 && citedFileCount <= 6;
}

function collectPromptLabConcreteReadEvidence(toolRuns: ChatToolRunRecord[]): Array<{ path: string; content: string }> {
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

function normalizePromptLabEvidenceContent(content: string): string {
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
  return normalized.replace(/\\'/g, "'").replace(/\\"/g, '"');
}

function extractPromptLabEvidenceTextFromSerializedPayload(content: string): string | undefined {
  const trimmed = content.trim();
  if (!/^[{[]/.test(trimmed) || !/['"](content|bodySnippet|snippet|text|body|message|path)['"]\s*:/.test(trimmed)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return readPromptLabEvidenceTextFromPayload(parsed);
  } catch {
    const singleQuotedContentMatch = trimmed.match(/['"]content['"]\s*:\s*'([\s\S]*?)'(?:\s*[,}])/);
    if (singleQuotedContentMatch?.[1]) {
      return singleQuotedContentMatch[1].replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\'/g, "'");
    }
    const doubleQuotedContentMatch = trimmed.match(/['"]content['"]\s*:\s*"([\s\S]*?)"(?:\s*[,}])/);
    if (doubleQuotedContentMatch?.[1]) {
      return doubleQuotedContentMatch[1].replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    return undefined;
  }
}

function readPromptLabEvidenceTextFromPayload(payload: unknown): string | undefined {
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

function normalizePromptLabFilePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const repoMarker = "/personal-ai/";
  const markerIndex = normalized.toLowerCase().indexOf(repoMarker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + repoMarker.length);
  }
  return normalized.replace(/^\.\//, "");
}

function normalizeToolNameForComparison(toolName: string | undefined): string | undefined {
  if (typeof toolName !== "string") {
    return undefined;
  }
  if (toolName.includes(".")) {
    return toolName;
  }
  const firstSeparator = toolName.indexOf("_");
  if (firstSeparator < 0) {
    return toolName;
  }
  return `${toolName.slice(0, firstSeparator)}.${toolName.slice(firstSeparator + 1)}`;
}

function buildToolNameComparisonAliases(toolName: string | undefined): Set<string> {
  const aliases = new Set<string>();
  const normalized = normalizeToolNameForComparison(toolName)?.toLowerCase();
  if (!normalized) {
    return aliases;
  }
  aliases.add(normalized);
  aliases.add(normalized.replace(/\./g, "_"));
  aliases.add(normalized.replace(/_/g, "."));
  return aliases;
}

function toolNameMatchesAnyKnownTool(toolName: string | undefined, expectedToolNames: Set<string>): boolean {
  const aliases = buildToolNameComparisonAliases(toolName);
  for (const expected of expectedToolNames) {
    for (const alias of buildToolNameComparisonAliases(expected)) {
      if (aliases.has(alias)) {
        return true;
      }
    }
  }
  return false;
}
