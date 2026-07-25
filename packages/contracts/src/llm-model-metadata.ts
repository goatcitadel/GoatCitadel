import type { ChatCompletionReasoningEffort } from "./llm.js";

export type LlmModelLifecycleStatus = "available" | "experimental" | "deprecated" | "retired";

export interface LlmModelReasoningMetadata {
  /** Explicit semantic effort levels supported by this model. */
  supportedEfforts: ChatCompletionReasoningEffort[];
  /** Optional wire-level mapping for providers whose effort vocabulary differs. */
  providerEffortMap?: Partial<Record<ChatCompletionReasoningEffort, ChatCompletionReasoningEffort>>;
}

export interface LlmModelMetadataEntry {
  contextWindow: number;
  outputTokenLimit: number;
  thinking?: "off" | "auto";
  /** Lifecycle status of the model. Absent implies "available". */
  status?: LlmModelLifecycleStatus;
  /** ISO date (YYYY-MM-DD) the model is scheduled to retire, when known. */
  retiresOn?: string;
  /**
   * Multiplier applied to heuristic (chars/4) token estimates for this model.
   * Newer tokenizers (Opus 4.7+/Fable) count ~30% more tokens; set ~1.3 so
   * context-budget trimming doesn't undercount. Absent implies 1 (no scaling).
   */
  tokenMultiplier?: number;
  /** Explicit reasoning capability. Its absence never authorizes max/ultra. */
  reasoning?: LlmModelReasoningMetadata;
}

export interface LlmModelMetadataManifest {
  version: number;
  entries: Record<string, LlmModelMetadataEntry>;
}
