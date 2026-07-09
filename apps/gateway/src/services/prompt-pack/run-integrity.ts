import { createHash } from "node:crypto";
import type {
  ChatTurnTraceRecord,
  PromptPackRunIntegrityRecord,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { applyPromptPackPromptLabFallbacks } from "../prompt-pack-empty-output-fallbacks.js";
import {
  extractPromptPackObservedFileEvidence,
  isPromptPackConcreteFileReadTool,
  isPromptPackFileEvidenceTool,
} from "./file-evidence.js";
import {
  hasJsonLikeStructuredOutput,
  hasMarkdownTableOutput,
  promptPositivelyRequiresJsonOutput,
  promptPositivelyRequiresTableOutput,
} from "./response-shape.js";
import { resolvePromptPackScoreFacingResponseText } from "./trace-and-score-helpers.js";

function buildPromptPackConstraintsBlock(toolRuns: ChatTurnTraceRecord["toolRuns"] | undefined): string | undefined {
  const problematic = (toolRuns ?? [])
    .filter((item) => item.status === "failed" || item.status === "blocked" || item.status === "approval_required")
    .slice(-6);
  if (problematic.length === 0) {
    return undefined;
  }
  const lines = ["## Constraints", "- Tool issues encountered during this run:"];
  for (const item of problematic) {
    lines.push(`- \`${item.toolName}\`: ${item.error ?? item.status}`);
  }
  lines.push("- Fallback used: best-effort response without repeating blocked tool calls.");
  return lines.join("\n");
}

function buildPromptPackExecutedEvidenceBlock(
  toolRuns: ChatTurnTraceRecord["toolRuns"] | undefined,
): string | undefined {
  const executed = (toolRuns ?? []).filter((item) => item.status === "executed");
  if (executed.length < 1) {
    return undefined;
  }
  const executedToolNames = [...new Set(executed.map((item) => item.toolName.trim()).filter(Boolean))].slice(0, 4);
  const observedFiles = extractPromptPackObservedFileEvidence(executed).slice(0, 4);
  const lines = ["## Evidence Captured"];
  if (executedToolNames.length > 0) {
    lines.push(`- Executed tools: ${executedToolNames.map((toolName) => `\`${toolName}\``).join(", ")}.`);
  }
  if (observedFiles.length > 0) {
    lines.push(`- Observed files: ${observedFiles.map((value) => `\`${value}\``).join(", ")}.`);
  }
  lines.push("- Fallback used: summarize only the evidence captured before the assistant output was lost.");
  return lines.join("\n");
}

function buildPromptPackMissingOutputFallback(trace?: ChatTurnTraceRecord): string | undefined {
  const toolRuns = trace?.toolRuns ?? [];
  const evidenceBlock = buildPromptPackExecutedEvidenceBlock(toolRuns);
  const constraintsBlock = buildPromptPackConstraintsBlock(toolRuns);
  const failureMessage = trace?.failure?.message?.trim();
  if (evidenceBlock) {
    return [
      "The assistant did not return a final message, so this run fell back to the captured tool evidence.",
      "",
      evidenceBlock,
      constraintsBlock,
      failureMessage ? `Failure state: ${failureMessage}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
  }
  if (constraintsBlock) {
    return [
      "The assistant did not return a final message, so this run fell back to the captured tool trace.",
      "",
      constraintsBlock,
    ].join("\n");
  }

  if (failureMessage) {
    return [
      "The assistant did not return a final message, so this run fell back to the captured failure state.",
      "",
      `Failure state: ${failureMessage}`,
    ].join("\n");
  }

  return undefined;
}

export function derivePromptPackResponseArtifacts(input: {
  prompt: string;
  rawResponseText: string;
  trace?: ChatTurnTraceRecord;
}): {
  derivedResponseText?: string;
  derivedResponseSignals?: string[];
} {
  const normalized = (input.rawResponseText ?? "").trim();
  if (normalized.length > 0) {
    return {};
  }
  const derivedResponseSignals: string[] = [];
  const promptPackPromptLabFallback = applyPromptPackPromptLabFallbacks({
    prompt: input.prompt,
    responseText: normalized,
    toolRuns: input.trace?.toolRuns ?? [],
  })?.trim();
  if (promptPackPromptLabFallback) {
    derivedResponseSignals.push("prompt_lab_contract_fallback");
    return {
      derivedResponseText: promptPackPromptLabFallback,
      derivedResponseSignals,
    };
  }
  const missingOutputFallback = buildPromptPackMissingOutputFallback(input.trace)?.trim();
  if (!missingOutputFallback) {
    return {};
  }
  derivedResponseSignals.push("trace_missing_output_fallback");
  return {
    derivedResponseText: missingOutputFallback,
    derivedResponseSignals,
  };
}

export function evaluatePromptPackRunIntegrity(input: {
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
  outputTokenCount?: number;
}): PromptPackRunIntegrityRecord {
  const responseText = input.responseText.trim();
  const completionStatus = input.trace?.completion?.status;
  const finishReason = input.trace?.completion?.finishReason;
  const signals: string[] = [];
  // Signals that describe degradation around a completed turn rather than a
  // broken response. They stay visible in reports but do not invalidate the
  // run for scoring.
  const degradedOnlySignals = new Set<string>();
  if (input.trace?.status === "failed" || input.trace?.status === "cancelled") {
    signals.push("run_failed");
  }
  if (input.trace?.durable?.status === "failed") {
    signals.push("durable_failed");
    if (input.trace?.status === "completed" && responseText.length > 0) {
      degradedOnlySignals.add("durable_failed");
    }
  }
  const completionRepair = input.trace?.completion?.repair;
  if (completionRepair?.applied) {
    const repairKind = completionRepair.kind ?? "unknown";
    const repairSignal = `response_repaired_${repairKind}`;
    signals.push(repairSignal);
    // Only repairs whose content came from a genuine model re-ask are
    // non-invalidating. Deterministic/controller-authored replacements
    // (deterministic_empty_output_synthesis, cowork_contract_normalization,
    // prompt_pack_harness_normalization, unknown kinds) invalidate the run:
    // their text is not the model's answer.
    if (repairKind === "incomplete_truncated_completion" || repairKind === "degraded_answer_synthesis") {
      degradedOnlySignals.add(repairSignal);
    }
  }
  if (
    input.trace?.failure?.message &&
    !isPromptPackRecoveredGuardrailTraceFailure({
      responseText,
      trace: input.trace,
      completionStatus,
    })
  ) {
    signals.push("trace_failure");
  }

  if (!responseText) {
    const invalidatingEmptySignals = signals.filter((signal) => !degradedOnlySignals.has(signal));
    return {
      validationStatus: invalidatingEmptySignals.length > 0 ? "invalid" : "unknown",
      signals: [...signals, "no_assistant_output"],
      completionStatus,
      finishReason,
      outputTokenCount: input.outputTokenCount,
    };
  }

  if (completionStatus && completionStatus !== "complete") {
    signals.push(`completion_${completionStatus}`);
  }
  const fragmentaryStart = looksLikePromptPackFragmentaryStart(responseText);
  if (fragmentaryStart) {
    signals.push("fragmentary_start");
  }
  const midSequenceStart = detectPromptPackMidSequenceStart(responseText);
  if (midSequenceStart) {
    signals.push("mid_sequence_start");
  }
  const cutOffEnding = detectPromptPackOutputCutOff(responseText);
  if (cutOffEnding) {
    signals.push("cut_off_ending");
  }
  if (finishReason && /^(length|content_filter|cancelled)$/i.test(finishReason)) {
    const normalizedFinishReason = finishReason.toLowerCase();
    if (
      normalizedFinishReason !== "length" ||
      completionStatus !== "complete" ||
      fragmentaryStart ||
      midSequenceStart ||
      cutOffEnding
    ) {
      signals.push(`finish_reason_${normalizedFinishReason}`);
    }
  }
  signals.push(...evaluatePromptPackStrictPromptConstraints(input.prompt, responseText));

  const invalidatingSignals = signals.filter((signal) => !degradedOnlySignals.has(signal));
  return {
    validationStatus: invalidatingSignals.length > 0 ? "invalid" : "valid",
    signals,
    completionStatus,
    finishReason,
    outputTokenCount: input.outputTokenCount,
    responseChecksumSha256: createHash("sha256").update(responseText).digest("hex"),
  };
}

export function resolvePromptPackRunIntegrity(
  prompt: string,
  run: Pick<PromptPackRunRecord, "responseText" | "trace" | "integrity">,
): PromptPackRunIntegrityRecord {
  if (run.integrity) {
    return {
      ...run.integrity,
      completionStatus: run.integrity.completionStatus ?? run.trace?.completion?.status,
      finishReason: run.integrity.finishReason ?? run.trace?.completion?.finishReason,
    };
  }
  return evaluatePromptPackRunIntegrity({
    prompt,
    responseText: resolvePromptPackScoreFacingResponseText(run),
    trace: run.trace,
  });
}

export function assertPromptPackRunScorable(test: PromptPackTestRecord, run: PromptPackRunRecord): void {
  if (run.status !== "completed") {
    throw new Error(`Cannot score ${test.code}: run status is ${run.status}.`);
  }
  const integrity = resolvePromptPackRunIntegrity(test.prompt, run);
  if (integrity.validationStatus === "invalid") {
    throw new Error(
      `Cannot score ${test.code}: run integrity is invalid (${integrity.signals.join(", ") || "unknown"}).`,
    );
  }
}

function evaluatePromptPackStrictPromptConstraints(prompt: string, responseText: string): string[] {
  const signals: string[] = [];
  const lowerPrompt = prompt.toLowerCase();
  const numberedLines = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line));
  const responseWordCount = countPromptPackWords(responseText);

  const maxWordMatch =
    lowerPrompt.match(/\bunder\s+(\d+)\s+words?\b/i) ??
    lowerPrompt.match(/\b(\d+)\s+words?\s+maximum\b/i) ??
    lowerPrompt.match(/\b(\d+)\s+word\s+maximum\b/i);
  if (maxWordMatch) {
    const maxWords = Number.parseInt(maxWordMatch[1] ?? "0", 10);
    if (Number.isFinite(maxWords) && maxWords > 0 && responseWordCount > maxWords) {
      signals.push("max_word_limit_exceeded");
    }
  }

  const stepCountMatch = lowerPrompt.match(/\b(\d+)-step\b/);
  if (stepCountMatch) {
    const expectedSteps = Number.parseInt(stepCountMatch[1] ?? "0", 10);
    if (Number.isFinite(expectedSteps) && expectedSteps > 0 && numberedLines.length !== expectedSteps) {
      signals.push("step_count_mismatch");
    }
  }

  const perStepWordMatch = lowerPrompt.match(/\beach step must be\s+(\d+)\s+words?\s+or\s+(?:fewer|less)\b/i);
  if (
    perStepWordMatch &&
    numberedLines.some(
      (line) => countPromptPackWords(line.replace(/^\d+\.\s+/, "")) > Number.parseInt(perStepWordMatch[1] ?? "0", 10),
    )
  ) {
    signals.push("step_word_limit_exceeded");
  }

  if (lowerPrompt.includes("no step may repeat a verb")) {
    const seenLeadingWords = new Set<string>();
    let repeated = false;
    for (const line of numberedLines) {
      const leadingWord = line
        .replace(/^\d+\.\s+/, "")
        .split(/\s+/, 1)[0]
        ?.toLowerCase()
        .replace(/[^a-z]/g, "");
      if (!leadingWord) {
        continue;
      }
      if (seenLeadingWords.has(leadingWord)) {
        repeated = true;
        break;
      }
      seenLeadingWords.add(leadingWord);
    }
    if (repeated) {
      signals.push("repeated_step_verb");
    }
  }

  if (lowerPrompt.includes("no explanation outside the steps")) {
    const nonStepContent = responseText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^\d+\.\s+/.test(line));
    if (nonStepContent.length > 0) {
      signals.push("non_step_content_present");
    }
  }

  const exactSentenceCount = extractPromptPackExactSentenceCount(prompt);
  if (exactSentenceCount !== undefined) {
    const actualSentenceCount = countPromptPackSentences(responseText);
    const nonEmptyLines = responseText.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (
      actualSentenceCount !== exactSentenceCount ||
      (exactSentenceCount <= 2 && nonEmptyLines.length > exactSentenceCount)
    ) {
      signals.push("sentence_count_mismatch");
    }
  }

  if (lowerPrompt.includes("no headings") && /(?:^|\n)\s*#{1,6}\s+\S/m.test(responseText)) {
    signals.push("heading_present");
  }
  if (lowerPrompt.includes("no lists") && /(?:^|\n)\s*(?:[-*]\s+|\d+\.\s+)/m.test(responseText)) {
    signals.push("list_present");
  }
  if (promptPositivelyRequiresJsonOutput(prompt) && !hasJsonLikeStructuredOutput(responseText)) {
    signals.push("missing_requested_json_output");
  }
  if (promptPositivelyRequiresTableOutput(prompt) && !hasMarkdownTableOutput(responseText)) {
    signals.push("missing_requested_table_output");
  }

  return [...new Set(signals)];
}

function isPromptPackRecoveredGuardrailTraceFailure(input: {
  responseText: string;
  trace: ChatTurnTraceRecord;
  completionStatus?: string;
}): boolean {
  const message = input.trace.failure?.message ?? "";
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  const isPromptLabGuardrail =
    normalized.includes("prompt lab web rows are capped") ||
    normalized.includes("prompt lab web tool budget is reserved") ||
    normalized.includes("prompt lab code search over");
  if (!isPromptLabGuardrail || input.completionStatus !== "complete" || input.responseText.trim().length < 80) {
    return false;
  }
  const toolRuns = input.trace.toolRuns ?? [];
  return toolRuns.some(
    (toolRun) =>
      toolRun.status === "executed" &&
      (toolRun.toolName.startsWith("browser.") ||
        isPromptPackConcreteFileReadTool(toolRun.toolName) ||
        isPromptPackFileEvidenceTool(toolRun.toolName)),
  );
}

function extractPromptPackExactSentenceCount(prompt: string): number | undefined {
  const normalized = prompt.toLowerCase();
  const match =
    normalized.match(/\banswer\s+in\s+(?:exactly\s+)?(\d+|one|two|three|four|five)\s+sentences?\b/) ??
    normalized.match(/\b(?:exactly|only)\s+(\d+|one|two|three|four|five)\s+sentences?\b/);
  if (!match) {
    return undefined;
  }
  return parsePromptPackSmallNumber(match[1]);
}

function parsePromptPackSmallNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return (
    {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
    } as const
  )[value.toLowerCase() as "one" | "two" | "three" | "four" | "five"];
}

function countPromptPackSentences(responseText: string): number {
  const normalized = responseText
    .replace(/\bhttps?:\/\/\S+/gi, " URL")
    .replace(/\b(?:e\.g|i\.e|U\.S|U\.K|Mr|Mrs|Ms|Dr)\./g, (value) => value.replaceAll(".", ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return 0;
  }
  const matches = normalized.match(/[^.!?]+[.!?](?=\s|$)/g) ?? [];
  const consumed = matches.join(" ").trim();
  const trailing = normalized.slice(consumed.length).trim();
  return matches.length + (trailing.length > 0 ? 1 : 0);
}

function detectPromptPackMidSequenceStart(responseText: string): boolean {
  const numberedLines = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line));
  if (numberedLines.length === 0) {
    return false;
  }
  const firstStep = Number.parseInt(numberedLines[0]?.match(/^(\d+)\./)?.[1] ?? "0", 10);
  return Number.isFinite(firstStep) && firstStep > 1;
}

function looksLikePromptPackFragmentaryStart(responseText: string): boolean {
  const firstLine = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return false;
  }
  if (/^(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|```|\||\{|\[|>)/.test(firstLine)) {
    return false;
  }
  return /^(?:and|or|but|so|because|then|are|is|was|were|the|a|an|to|of|for|with|from|if|when|while)\b/.test(firstLine);
}

function detectPromptPackOutputCutOff(responseText: string): boolean {
  if ((responseText.match(/```/g) ?? []).length % 2 === 1) {
    return true;
  }
  const lastLine = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!lastLine) {
    return false;
  }
  const semanticLastLine = stripPromptPackTerminalMarkdown(lastLine);
  if (/[.!?`)\]"'}]$/.test(semanticLastLine)) {
    return false;
  }
  if (looksLikeCompletePromptPackPathLine(lastLine)) {
    return false;
  }
  if (looksLikeCompletePromptPackUrlLine(lastLine)) {
    return false;
  }
  if (looksLikeCompletePromptPackShortEmphasisLine(lastLine)) {
    return false;
  }
  if (
    /\b(?:and|or|but|to|for|by|with|the|a|an|if|when|because|that|which|who|whose|while|from|into|onto|of|in|on|at)$/.test(
      lastLine.toLowerCase(),
    )
  ) {
    return true;
  }
  const wordCount = countPromptPackWords(semanticLastLine);
  if (/^[-*]\s*$/.test(lastLine) || /^#+\s*$/.test(lastLine)) {
    return true;
  }
  return wordCount <= 4 && responseText.length > 200;
}

function stripPromptPackTerminalMarkdown(line: string): string {
  let normalized = line
    .trim()
    .replace(/^[-*]\s+/, "")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    const next = normalized
      .replace(/^`([^`]+)`$/u, "$1")
      .replace(/^\*\*([\s\S]+)\*\*$/u, "$1")
      .replace(/^__([\s\S]+)__$/u, "$1")
      .replace(/^\*([^*]+)\*$/u, "$1")
      .replace(/^_([^_]+)_$/u, "$1")
      .trim();
    if (next !== normalized) {
      normalized = next;
      changed = true;
    }
  }
  return normalized;
}

function looksLikeCompletePromptPackShortEmphasisLine(line: string): boolean {
  const normalized = line.trim();
  if (!/^[-*]\s+\*\*.+\*\*$/.test(normalized)) {
    return false;
  }
  const inner = normalized
    .replace(/^[-*]\s+\*\*/, "")
    .replace(/\*\*$/, "")
    .trim();
  if (!inner || inner.length > 80) {
    return false;
  }
  if (!/[A-Za-z]/.test(inner)) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9 /:=()'’"_-]*$/.test(inner);
}

function looksLikeCompletePromptPackPathLine(line: string): boolean {
  const candidate = line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^`(.+)`$/u, "$1");
  return /[\\/]/.test(candidate) && /(?:^|[\\/])[^\\/\s]+\.[a-z0-9]{1,10}$/i.test(candidate);
}

function looksLikeCompletePromptPackUrlLine(line: string): boolean {
  const candidate = line.trim().replace(/^[-*]\s+/, "");
  return /\bhttps?:\/\/[^\s<>)]+[)]?$/i.test(candidate);
}

function countPromptPackWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => /[A-Za-z0-9]/.test(token)).length;
}
