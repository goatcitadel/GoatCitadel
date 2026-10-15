export type ChatContextMutationKind =
  | "specialist-draft"
  | "specialist-patch"
  | "specialist-activation"
  | "learned-memory-status"
  | "learned-memory-rebuild"
  | "external-binding";
/** Presentation only. Canonical settlement and locks stay in the existing operation owner. */
export interface ChatContextMutationProjection {
  family: "specialists" | "learned-memory" | "binding";
  workspaceId: string;
  sessionId: string | null;
  scopeIdentity: string;
  phase: "idle" | "checking" | "submitted" | "resolved" | "uncertain" | "refused";
  locked: boolean;
  message?: string;
  inspectionError?: string;
  receipt?: { kind: string; subjectIds: readonly string[] };
  isCurrent: () => boolean;
  onInspect: () => Promise<void>;
}
