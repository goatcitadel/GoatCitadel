import { z } from "zod";

export interface ChatContinuitySourceSpan {
  messageId: string;
  contentHash: string;
  start: number;
  end: number;
}
export type ChatContinuityEntryKind =
  | "decision"
  | "constraint"
  | "question"
  | "effect"
  | "artifact"
  | "next_step"
  | "context";
export interface ChatContinuityCanonicalLink {
  kind: "effect" | "artifact";
  canonicalRef: string;
  label: string;
  completed?: boolean;
}
export interface ChatContinuityEntry {
  kind: ChatContinuityEntryKind;
  text: string;
  authority: "operator_context" | "agent_proposal" | "external_data" | "canonical_receipt";
  source?: ChatContinuitySourceSpan;
  canonicalRef?: string;
  completed?: boolean;
  redacted?: boolean;
}
export interface ChatContinuityLedgerV1 {
  version: 1;
  sourceHash: string;
  turnIds: string[];
  originalAsk?: ChatContinuitySourceSpan;
  latestAsk?: ChatContinuitySourceSpan;
  entries: ChatContinuityEntry[];
  omittedSourceRefs: ChatContinuitySourceSpan[];
}

const spanSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((span) => span.end >= span.start);
const ledgerSchema = z.object({
  version: z.literal(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  turnIds: z.array(z.string().min(1).max(256)).min(1).max(64),
  originalAsk: spanSchema.optional(),
  latestAsk: spanSchema.optional(),
  omittedSourceRefs: z.array(spanSchema).max(256),
  entries: z
    .array(
      z.object({
        kind: z.enum(["decision", "constraint", "question", "effect", "artifact", "next_step", "context"]),
        text: z.string().max(24_000),
        authority: z.enum(["operator_context", "agent_proposal", "external_data", "canonical_receipt"]),
        source: spanSchema.optional(),
        canonicalRef: z.string().min(1).max(300).optional(),
        completed: z.boolean().optional(),
        redacted: z.boolean().optional(),
      }),
    )
    .max(192),
});
const SUMMARY_FORMAT = "goatcitadel.chat-continuity.v1";

/** Versioned serialization in the existing summary column preserves immutable legacy rows. */
export function encodeChatContinuitySummary(summary: string, ledger: ChatContinuityLedgerV1): string {
  const parsed = ledgerSchema.safeParse(ledger);
  if (!parsed.success || !summary.trim()) throw new RangeError("Invalid continuity ledger or summary.");
  const encoded = JSON.stringify({ format: SUMMARY_FORMAT, summary, ledger: parsed.data });
  if (encoded.length > 65_536) throw new RangeError("Continuity summary exceeds the storage bound.");
  return encoded;
}

export function decodeChatContinuitySummary(
  stored: string,
): { summary: string; continuityLedger?: ChatContinuityLedgerV1 } | undefined {
  if (stored.length > 65_536) return undefined;
  if (!stored.trimStart().startsWith("{")) return { summary: stored };
  try {
    const envelope = JSON.parse(stored) as { format?: unknown; summary?: unknown; ledger?: unknown };
    if (envelope?.format !== SUMMARY_FORMAT) return { summary: stored };
    const parsed = ledgerSchema.safeParse(envelope.ledger);
    if (!parsed.success || typeof envelope.summary !== "string" || !envelope.summary.trim()) return undefined;
    return { summary: envelope.summary, continuityLedger: parsed.data };
  } catch {
    return stored.trimStart().startsWith(`{"format":"${SUMMARY_FORMAT}"`) ? undefined : { summary: stored };
  }
}
