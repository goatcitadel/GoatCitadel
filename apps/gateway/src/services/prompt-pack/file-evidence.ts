import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";

export function extractPromptPackObservedFileEvidence(toolRuns: ChatTurnTraceRecord["toolRuns"]): string[] {
  const candidates = new Set<string>();
  const addCandidate = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim().replace(/\\/g, "/");
    if (trimmed.length < 1) {
      return;
    }
    if (/[/.]/.test(trimmed)) {
      candidates.add(trimmed.toLowerCase());
      const basename = trimmed.split("/").filter(Boolean).slice(-1)[0];
      if (basename) {
        candidates.add(basename.toLowerCase());
      }
    }
  };

  for (const toolRun of toolRuns) {
    if (toolRun.status !== "executed") {
      continue;
    }
    const args = toolRun.args as Record<string, unknown> | undefined;
    addCandidate(args?.path);
    addCandidate(args?.query);
    const result = toolRun.result as Record<string, unknown> | undefined;
    addCandidate(result?.path);
    if (Array.isArray(result?.matches)) {
      for (const match of result.matches as Array<Record<string, unknown>>) {
        addCandidate(match.path);
        addCandidate(match.name);
      }
    }
  }

  return [...candidates].filter((value) => /\.[a-z0-9]+$|package\.json|docker-compose/i.test(value));
}

export function responseMentionsObservedFileEvidence(response: string, candidates: string[]): boolean {
  const normalized = response.toLowerCase();
  return candidates.some((candidate) => normalized.includes(candidate));
}

export function isPromptPackFileEvidenceTool(toolName: string): boolean {
  return toolName.startsWith("fs.") || toolName.startsWith("file.") || toolName.startsWith("code.");
}

export function isPromptPackConcreteFileReadTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "file.read_range" || normalized === "fs.read";
}
