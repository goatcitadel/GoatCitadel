import type { ChatToolRunRecord, ChatTurnTraceRecord, LearnedMemoryItemType } from "@goatcitadel/contracts";

export function shouldExtractLearnedMemoryContent(
  content: string,
  source: {
    role: "user" | "assistant";
    sourceRef: string;
    trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
  },
): boolean {
  const normalized = content.trim();
  if (!normalized) {
    return false;
  }
  if (source.role !== "assistant") {
    return true;
  }
  if (
    source.trace?.status === "failed" ||
    source.trace?.status === "waiting_for_approval" ||
    source.trace?.status === "waiting_for_user_input"
  ) {
    return false;
  }
  if (looksLowConfidenceResponse(content)) {
    return false;
  }
  if (hasProblematicBrowserRun(source.trace?.toolRuns ?? [])) {
    return false;
  }
  return true;
}

export function looksLowConfidenceResponse(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    normalized.length < 30 ||
    /\b(i don't know|not sure|can't help|cannot help|unable to|wasn't able to|couldn't retrieve|blocking access|ran out of time|tool issue|site is blocking automated requests|stopped retrying|do not have a reliable enough partial answer)\b/.test(
      normalized,
    ) ||
    normalized.startsWith("a source blocked automated browsing") ||
    normalized.startsWith("i hit a tool issue") ||
    normalized.startsWith("i hit the same tool issue repeatedly")
  );
}

export function extractLearnedMemoryCandidates(
  content: string,
  role: "user" | "assistant",
): Array<{
  itemType: LearnedMemoryItemType;
  content: string;
  confidence: number;
}> {
  const lines = content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);
  const out: Array<{ itemType: LearnedMemoryItemType; content: string; confidence: number }> = [];
  const add = (itemType: LearnedMemoryItemType, text: string, confidence: number) => {
    const normalized = normalizeMemoryText(text);
    if (!normalized) {
      return;
    }
    out.push({
      itemType,
      content: text.trim(),
      confidence: clamp01(confidence),
    });
  };
  for (const line of lines) {
    if (/^(remember|preference|format|always|please format)/i.test(line)) {
      add("preference", line, role === "user" ? 0.9 : 0.6);
      continue;
    }
    if (/\b(top priority|goal|objective|for 1\.0|roadmap)\b/i.test(line)) {
      add("goal", line, role === "user" ? 0.86 : 0.58);
      continue;
    }
    if (/\bmust|never|cannot|can't|do not|without\b/i.test(line) && !isQuestionLikeMemoryLine(line)) {
      add("constraint", line, role === "user" ? 0.82 : 0.56);
      continue;
    }
    if (/\b(project|workspace|stack|integration|session|prompt pack|goatcitadel)\b/i.test(line)) {
      add("project_context", line, role === "user" ? 0.74 : 0.52);
      continue;
    }
    if (/\bis|are|was|were\b/.test(line) && line.length > 18 && line.length < 220 && !isQuestionLikeMemoryLine(line)) {
      add("fact", line, role === "user" ? 0.58 : 0.48);
    }
  }
  return out.slice(0, 8);
}

export function isQuestionLikeMemoryLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.endsWith("?")) {
    return true;
  }
  return /^(what|which|who|when|where|why|how|is|are|am|do|does|did|can|could|should|would|will|has|have|had)\b/.test(
    normalized,
  );
}

export function hasProblematicBrowserRun(toolRuns: ChatToolRunRecord[]): boolean {
  for (const run of toolRuns) {
    if (isProblematicBrowserRun(run)) {
      return true;
    }
  }
  return false;
}

function isProblematicBrowserRun(run: ChatToolRunRecord): boolean {
  if (!(run.toolName.startsWith("browser.") || run.toolName === "http.get")) {
    return false;
  }
  if (run.status === "failed" || run.status === "blocked") {
    return true;
  }
  if (!run.result || typeof run.result !== "object") {
    return false;
  }
  const result = run.result as Record<string, unknown>;
  if (hasProblematicBrowserFailureClass(result.browserFailureClass)) {
    return true;
  }
  if (!Array.isArray(result.fallbackChain)) {
    return false;
  }
  return result.fallbackChain.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const record = entry as Record<string, unknown>;
    return record.status === "failed" || hasProblematicBrowserFailureClass(record.browserFailureClass);
  });
}

function hasProblematicBrowserFailureClass(value: unknown): boolean {
  return (
    value === "remote_blocked" || value === "http_error" || value === "runtime_error" || value === "unusable_output"
  );
}

function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
