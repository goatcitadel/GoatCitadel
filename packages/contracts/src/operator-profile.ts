/**
 * Cross-session operator profile (P2-S4b).
 *
 * A durable, workspace-scoped model of *who the operator is* — their standing
 * preferences, recurring goals, and hard constraints — distilled from promoted /
 * agent-proposed learnings and refreshed over time (e.g. by the S1 background
 * review fork). This is GoatCitadel's analogue of Hermes' "deepening model of
 * who you are": it persists across sessions, unlike per-session learned memory.
 *
 * The profile is injected ONCE per session as a frozen, compact USER.md-style
 * snapshot (the `memoryDigest` of the P0-A base prompt). Injection is read-only
 * context. Writes always pass through the memory write gate, so secrets are
 * blocked and agent-originated writes stay `proposed` unless full autonomy is on.
 * Every write captures the prior revision so a change is reversible.
 */

/** The kind of standing fact captured in an operator profile. */
export type OperatorProfileFactKind = "preference" | "goal" | "constraint" | "fact";

/** A single durable fact about the operator. */
export interface OperatorProfileFact {
  kind: OperatorProfileFactKind;
  /** The fact text. Never contains secrets (gate-blocked). */
  content: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Optional provenance pointer (e.g. learned-memory item id, turn id). */
  sourceRef?: string;
}

/** The durable, workspace-scoped operator profile record. */
export interface OperatorProfileRecord {
  operatorProfileId: string;
  workspaceId: string;
  /** Short prose summary of the operator, surfaced at the top of the digest. */
  summary: string;
  /** Standing facts, highest-signal first by convention. */
  facts: OperatorProfileFact[];
  /** Monotonically increasing per write; used as the digest cache key. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Defensive bounds so a runaway profile cannot bloat the prompt or storage. */
export const MAX_OPERATOR_PROFILE_FACTS = 50;
export const MAX_OPERATOR_PROFILE_SUMMARY_LENGTH = 600;
export const MAX_OPERATOR_PROFILE_FACT_LENGTH = 280;
