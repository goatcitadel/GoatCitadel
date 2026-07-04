import type { MemoryCitation } from "@goatcitadel/contracts";
import type { DistillationPayload, RankedMemoryCandidate } from "./types.js";

export interface DistillerRequest {
  prompt: string;
  candidates: RankedMemoryCandidate[];
}

export function buildDistillerPrompt(request: DistillerRequest): string {
  const evidence = buildDistillerEvidence(request.candidates);

  return [
    "You are a memory distiller for an AI assistant.",
    "Use only the provided evidence. Do not fabricate facts.",
    "Return strict JSON with keys: summary, facts, risks, openQuestions, saferNextSteps, citations.",
    "facts is an array of {text, citationIds}. citationIds must reference provided IDs.",
    "citations is an array of {candidateId, sourceType, sourceRef, snippet, score}.",
    "",
    `User prompt:\n${request.prompt}`,
    "",
    `Evidence:\n${evidence}`,
  ].join("\n");
}

export function buildDistillerEvidence(candidates: RankedMemoryCandidate[]): string {
  return candidates.map(formatDistillerEvidenceCandidate).join("\n\n---\n\n");
}

export function formatDistillerEvidenceCandidate(candidate: RankedMemoryCandidate): string {
  return `ID=${candidate.candidateId}\nSOURCE=${candidate.sourceType}:${candidate.sourceRef}\nTEXT=${candidate.text}`;
}

export interface ParsedDistillation {
  payload: DistillationPayload;
  citations: MemoryCitation[];
}

export function parseDistillerJson(raw: string): ParsedDistillation {
  const parsed = parseJsonObject(raw);
  const payload: DistillationPayload = {
    summary: asString(parsed.summary),
    facts: asArray(parsed.facts)
      .map((item) => {
        const object = asObject(item);
        return {
          text: asString(object.text),
          citationIds: asArray(object.citationIds)
            .map((value) => asString(value))
            .filter(Boolean),
        };
      })
      .filter((entry) => entry.text.length > 0),
    risks: asArray(parsed.risks)
      .map((value) => asString(value))
      .filter(Boolean),
    openQuestions: asArray(parsed.openQuestions)
      .map((value) => asString(value))
      .filter(Boolean),
    saferNextSteps: asArray(parsed.saferNextSteps)
      .map((value) => asString(value))
      .filter(Boolean),
  };
  const citations: MemoryCitation[] = asArray(parsed.citations)
    .map((item) => {
      const object = asObject(item);
      const sourceType = parseSourceType(asString(object.sourceType));
      return {
        candidateId: asString(object.candidateId),
        sourceType,
        sourceRef: asString(object.sourceRef),
        snippet: optionalString(object.snippet),
        score: Number(asNumber(object.score).toFixed(3)),
      };
    })
    .filter((entry) => entry.candidateId && entry.sourceRef);

  if (!payload.summary && payload.facts.length === 0) {
    throw new Error("distillation payload is empty");
  }

  return { payload, citations };
}

function parseSourceType(value: string): MemoryCitation["sourceType"] {
  if (value === "file" || value === "memory_item") {
    return value;
  }
  return "transcript";
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("distiller output did not contain a JSON object");
  }
  const slice = trimmed.slice(start, end + 1);
  const parsed = JSON.parse(slice) as unknown;
  return asObject(parsed);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  const parsed = asString(value);
  return parsed || undefined;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
