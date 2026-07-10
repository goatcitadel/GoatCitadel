import {
  redactStructuredSecrets,
  type ApprovalExplanation,
  type ApprovalRequest,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { ApprovalExplainerConfig } from "../config.js";
import { LlmService } from "./llm-service.js";

export interface ApprovalExplainerRealtimePayload {
  approvalId: string;
  status: "completed" | "failed";
  providerId?: string;
  model?: string;
  error?: string;
}

export class ApprovalExplainerService {
  public constructor(
    private readonly storage: Storage,
    private readonly llmService: LlmService,
    private readonly config: ApprovalExplainerConfig,
    private readonly publishRealtime: (payload: ApprovalExplainerRealtimePayload) => void,
  ) {}

  public shouldExplain(approval: ApprovalRequest): boolean {
    if (!this.config.enabled || this.config.mode !== "async") {
      return false;
    }
    if (approval.explanationStatus === "pending" || approval.explanationStatus === "completed") {
      return false;
    }

    const minRiskScore = riskScore(this.config.minRiskLevel);
    return riskScore(approval.riskLevel) >= minRiskScore;
  }

  public async explainApproval(approval: ApprovalRequest): Promise<void> {
    if (!this.shouldExplain(approval)) {
      return;
    }

    const markedPending = this.storage.approvals.markExplanationPending(approval.approvalId);
    if (!markedPending) {
      return;
    }

    this.storage.approvalEvents.append({
      approvalId: approval.approvalId,
      eventType: "explanation_requested",
      actorId: "system",
      payload: {
        kind: approval.kind,
        riskLevel: approval.riskLevel,
      },
    });

    try {
      const runtime = this.llmService.getRuntimeConfig();
      const providerId = this.config.providerId ?? runtime.activeProviderId;
      const model = this.config.model ?? runtime.activeModel;
      const apiStyle = this.llmService.resolveExecutionApiStyle(providerId, model);

      const promptPayload = buildPromptPayload(approval, this.config.maxPayloadChars);
      const request: ChatCompletionRequest = {
        providerId,
        model,
        messages: [
          {
            role: "system",
            content:
              "You explain technical approval requests for non-technical operators. " +
              "Use plain English and avoid jargon. Return strict JSON only.",
          },
          {
            role: "user",
            content:
              "Summarize this approval request for a layperson. " +
              "Return JSON with keys: summary, riskExplanation, saferAlternative.\n\n" +
              promptPayload,
          },
        ],
        max_tokens: 350,
      };

      if (apiStyle !== "openai-codex-responses") {
        request.temperature = 0.2;
        request.response_format = { type: "json_object" };
      }

      const response = await withTimeout(
        this.llmService.chatCompletions(request),
        this.config.timeoutMs,
        "approval explainer timed out",
      );

      const parsed = parseExplanationResponse(response);
      const explanation: ApprovalExplanation = {
        summary: parsed.summary,
        riskExplanation: parsed.riskExplanation,
        saferAlternative: parsed.saferAlternative,
        generatedAt: new Date().toISOString(),
        providerId,
        model,
      };

      this.storage.approvals.setExplanation(approval.approvalId, explanation);
      this.storage.approvalEvents.append({
        approvalId: approval.approvalId,
        eventType: "explanation_generated",
        actorId: "system",
        payload: {
          providerId,
          model,
        },
      });

      this.publishRealtime({
        approvalId: approval.approvalId,
        status: "completed",
        providerId,
        model,
      });
    } catch (error) {
      const message = truncate((error as Error).message, 500);
      this.storage.approvals.setExplanationFailed(approval.approvalId, message);
      this.storage.approvalEvents.append({
        approvalId: approval.approvalId,
        eventType: "explanation_failed",
        actorId: "system",
        payload: {
          error: message,
        },
      });
      this.publishRealtime({
        approvalId: approval.approvalId,
        status: "failed",
        error: message,
      });
    }
  }
}

function riskScore(value: ApprovalRequest["riskLevel"] | ApprovalExplainerConfig["minRiskLevel"]): number {
  if (value === "safe") return 0;
  if (value === "caution") return 1;
  if (value === "danger") return 2;
  if (value === "nuclear") return 3;
  return 0;
}

function buildPromptPayload(approval: ApprovalRequest, maxPayloadChars: number): string {
  const redacted = redactStructuredSecrets({
    approvalId: approval.approvalId,
    kind: approval.kind,
    riskLevel: approval.riskLevel,
    preview: approval.preview,
    payload: approval.payload,
  }).value;

  const serialized = JSON.stringify(redacted, null, 2);
  return truncate(serialized, maxPayloadChars);
}

function parseExplanationResponse(response: ChatCompletionResponse): {
  summary: string;
  riskExplanation: string;
  saferAlternative?: string;
} {
  const content = extractMessageContent(response);
  if (!content) {
    throw new Error("approval explainer returned empty content");
  }

  const parsed = parseJsonObject(content);
  const summary = asNonEmptyString(parsed.summary, "summary");
  const riskExplanation = asNonEmptyString(parsed.riskExplanation, "riskExplanation");
  const saferAlternative = asOptionalString(parsed.saferAlternative);

  return {
    summary: truncate(summary, 1200),
    riskExplanation: truncate(riskExplanation, 1200),
    saferAlternative: saferAlternative ? truncate(saferAlternative, 1200) : undefined,
  };
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!message) {
    return "";
  }

  const raw = message.content;
  if (typeof raw === "string") {
    return raw;
  }

  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") {
          return text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }

  return "";
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("approval explainer returned non-JSON content");
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function asNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`approval explainer missing required field: ${fieldName}`);
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
