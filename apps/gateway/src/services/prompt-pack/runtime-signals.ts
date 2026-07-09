import type {
  ChatToolRunRecord,
  PromptPackFailureAttributionRecordV3,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { promptSuppressesToolUse } from "../prompt-pack-execution-profile.js";
import { resolvePromptPackScoreFacingResponseText } from "./trace-and-score-helpers.js";

export interface PromptPackRuntimeSignalDeps {
  resolveRunIntegrity(prompt: string, run: PromptPackRunRecord): { signals: string[] };
  isGuardrailBlockedToolRun(toolRun: ChatToolRunRecord): boolean;
}

export type PromptPackRuntimeSignalClusterRow = {
  expected: string;
  actual: string;
  count: number;
  codes: string[];
  platformSignal: string;
};

export function collectPromptPackObservedToolFamilies(run?: PromptPackRunRecord): string[] {
  const families = new Set<string>();
  for (const toolRun of run?.trace?.toolRuns ?? []) {
    const toolName = toolRun.toolName.toLowerCase();
    if (/^(fs\.|file\.|code\.)/.test(toolName)) {
      families.add("file/code");
    } else if (/^(browser\.|http\.)/.test(toolName)) {
      families.add("web");
    } else if (/^(memory\.|embeddings\.)/.test(toolName)) {
      families.add("memory");
    } else if (toolName === "time.now") {
      families.add("time");
    } else if (/^(shell\.|git\.|tests\.|lint\.|build\.)/.test(toolName)) {
      families.add("command/validation");
    } else {
      families.add("other");
    }
  }
  return families.size > 0 ? [...families].sort() : ["none"];
}

export function collectPromptPackExpectedToolFamilies(test: PromptPackTestRecord, run?: PromptPackRunRecord): string[] {
  const prompt = test.prompt.toLowerCase();
  const metadata = run?.diagnosticMetadata ?? test.diagnosticMetadata;
  // Authored expectation wins over regex inference: packs that declare
  // `Expected Tool Families:` in the diagnostics block are exempt from
  // phrasing-sensitive keyword classification.
  const authoredFamilies = (metadata?.expectedToolFamilies ?? []).map((family) => family.trim()).filter(Boolean);
  if (authoredFamilies.length > 0) {
    return [...new Set(authoredFamilies)].sort();
  }
  const signals = [...(metadata?.capabilityTargets ?? []), ...(metadata?.expectedRuntimeSignals ?? []), prompt]
    .join(" ")
    .toLowerCase();
  if (promptSuppressesToolUse(test.prompt) || /\bno tools?\b|\bdoes not use tools\b|\bwithout tools\b/.test(signals)) {
    return ["none"];
  }
  const families = new Set<string>();
  if (/\bweb\b|browser\.|http\.|lookup|source used|cited sources?/.test(signals)) {
    families.add("web");
  }
  if (/\bmemory\b|memory\.|stored preference|what you know about my preferences/.test(signals)) {
    families.add("memory");
  }
  if (
    (run?.mode ?? test.mode) === "code" ||
    /\bcode-validation\b|\bstorage\b|\bcontracts?\b|\breports?\b|\bui\b|\bfile search\b|\bfile read\b|\bfs\.|file\.|code\./.test(
      signals,
    )
  ) {
    families.add("file/code");
  }
  return families.size > 0 ? [...families].sort() : ["unspecified"];
}

export function buildPromptPackRuntimeSignalClusterRows(
  tests: PromptPackTestRecord[],
  latestRunByTest: Map<string, PromptPackRunRecord>,
  deps: PromptPackRuntimeSignalDeps,
): PromptPackRuntimeSignalClusterRow[] {
  const rows = new Map<string, PromptPackRuntimeSignalClusterRow>();
  for (const test of tests) {
    const run = latestRunByTest.get(test.testId);
    const expectedFamilies = collectPromptPackExpectedToolFamilies(test, run);
    const actualFamilies = collectPromptPackObservedToolFamilies(run);
    const expected = expectedFamilies.join(", ");
    const actual = actualFamilies.join(", ");
    const platformSignals = collectPromptPackPlatformSignals(test, run, expectedFamilies, actualFamilies, deps);
    const platformSignal = platformSignals.length > 0 ? platformSignals.join("; ") : "-";
    const key = `${expected}||${actual}||${platformSignal}`;
    const existing = rows.get(key) ?? {
      expected,
      actual,
      count: 0,
      codes: [],
      platformSignal,
    };
    existing.count += 1;
    existing.codes.push(test.code);
    rows.set(key, existing);
  }
  return [...rows.values()].sort(
    (left, right) => right.count - left.count || left.expected.localeCompare(right.expected),
  );
}

export function collectPromptPackPlatformSignals(
  test: PromptPackTestRecord,
  run: PromptPackRunRecord | undefined,
  expectedFamilies: string[],
  actualFamilies: string[],
  deps: PromptPackRuntimeSignalDeps,
): string[] {
  const signals: string[] = [];
  const nonCodeSurface = (run?.mode ?? test.mode) !== "code";
  if (nonCodeSurface && actualFamilies.includes("file/code") && !expectedFamilies.includes("file/code")) {
    signals.push("unexpected file/code tools on non-code surface");
  }
  if (
    (run?.mode ?? test.mode) === "code" &&
    actualFamilies.includes("memory") &&
    !expectedFamilies.includes("memory")
  ) {
    signals.push("unexpected memory tools on code surface");
  }
  const toolRuns = run?.trace?.toolRuns ?? [];
  if (
    toolRuns.some((toolRun) =>
      ["artifacts.create", "documents.create", "presentations.create"].includes(toolRun.toolName),
    )
  ) {
    signals.push("artifact-tool detour");
  }
  const scoreFacingResponseText = run ? resolvePromptPackScoreFacingResponseText(run) : "";
  const modelAndFailureText = [run?.error, run?.trace?.failure?.message, run?.responseText, run?.finalResponseText]
    .filter(Boolean)
    .join(" ");
  // Budget detection reads harness failure state only - never the model's own text -
  // and code-mode repo tasks legitimately use 8-12 tool calls.
  const runFailureText = [run?.error, run?.trace?.failure?.message].filter(Boolean).join(" ");
  const toolBudgetThreshold = (run?.mode ?? test.mode) === "code" ? 16 : 8;
  if (
    /\b(?:tool run budget|turn budget|tool budget)\b/i.test(runFailureText) ||
    toolRuns.length >= toolBudgetThreshold
  ) {
    signals.push("tool-budget overrun");
  }
  if (/\b(?:no tool output found|function call|responses api|tool output)\b/i.test(modelAndFailureText)) {
    signals.push("provider/tool protocol failure");
  } else if (run) {
    const integrity = deps.resolveRunIntegrity(test.prompt, run);
    if (integrity.signals.includes("trace_failure")) {
      signals.push("trace failure");
    }
  }
  if (
    expectedFamilies.includes("web") &&
    toolRuns.some(
      (toolRun) =>
        /^(browser\.|http\.)/i.test(toolRun.toolName) &&
        (toolRun.status === "failed" || toolRun.status === "blocked" || toolRun.status === "approval_required") &&
        !deps.isGuardrailBlockedToolRun(toolRun),
    ) &&
    !promptPackResponseSeparatesReliedAndAttemptedSources(scoreFacingResponseText)
  ) {
    signals.push("source-hygiene review needed");
  }
  return [...new Set(signals)];
}

export function derivePromptPackPlatformSignalAttributionV3(
  test: PromptPackTestRecord,
  run: PromptPackRunRecord | undefined,
  deps: PromptPackRuntimeSignalDeps,
): PromptPackFailureAttributionRecordV3 | undefined {
  if (!run) {
    return undefined;
  }
  const expectedFamilies = collectPromptPackExpectedToolFamilies(test, run);
  const actualFamilies = collectPromptPackObservedToolFamilies(run);
  const platformSignals = collectPromptPackPlatformSignals(test, run, expectedFamilies, actualFamilies, deps);
  const toEvidence = (signal: string): string =>
    `platform_signal_${signal
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()}`;
  const runtimeSignals = platformSignals.filter(
    (signal) => signal === "provider/tool protocol failure" || signal === "trace failure",
  );
  if (runtimeSignals.length > 0) {
    return {
      primary: "runtime_or_infra_failure",
      confidence: "low",
      evidence: runtimeSignals.map(toEvidence).slice(0, 5),
    };
  }
  return undefined;
}

function promptPackResponseSeparatesReliedAndAttemptedSources(responseText: string): boolean {
  if (!responseText.trim()) {
    return false;
  }
  const hasReliedSources = /(?:^|\n)\s*#{0,3}\s*(?:sources relied on|sources used|source(?:s)? relied upon)\b/i.test(
    responseText,
  );
  const hasAttemptedBoundary =
    /(?:^|\n)\s*#{0,3}\s*(?:blocked or unread sources|attempted sources|blocked sources|unread sources)\b/i.test(
      responseText,
    ) || /\b(search-only|blocked|unread|not treated as relied-on|not relied on)\b/i.test(responseText);
  return hasReliedSources && hasAttemptedBoundary;
}
