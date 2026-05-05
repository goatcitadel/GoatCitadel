export type MemoryWriteGateDecisionKind = "allowed" | "proposed" | "blocked";
export type MemoryWriteAuthority =
  | "trusted_lifecycle"
  | "operator"
  | "agent_proposed"
  | "external_channel"
  | "imported_skill";

export interface MemoryWriteGateDecision {
  decision: MemoryWriteGateDecisionKind;
  authority: MemoryWriteAuthority;
  reasons: string[];
  contradictionHints: string[];
  redactionStatus: "none" | "redacted" | "blocked_secret";
  createdAt: string;
}
