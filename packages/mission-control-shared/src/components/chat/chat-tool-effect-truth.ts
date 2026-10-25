import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { presentToolEffectOutcome } from "../../content/status-vocabulary.js";

export interface ChatToolEffectTruthProjection {
  facts: string;
  guidance?: string;
  /** Operator-facing wording; the machine facts stay in `summary`. */
  plainSummary: string;
  summary: string;
  tone: "none" | "uncertain" | "concrete";
}

/**
 * Closed-world operator projection for persisted tool-effect truth. Evidence
 * Raw ref IDs are never exposed as verified evidence here. A typed row shape
 * does not prove live correlation to its canonical owner ledger; that needs a
 * dedicated server-verified projection.
 */
export function projectChatToolEffectTruth(
  run: Pick<ChatToolRunRecord, "effectPotential" | "effectDisposition" | "effectOutcomeKind" | "effectEvidence"> &
    Partial<Pick<ChatToolRunRecord, "status" | "result">>,
): ChatToolEffectTruthProjection | undefined {
  if (!run.effectPotential && !run.effectDisposition && !run.effectOutcomeKind && !run.effectEvidence) {
    return undefined;
  }
  // A refused approval never dispatched, whatever an older row recorded.
  const outcome = wasRefusedBeforeDispatch(run) ? "none" : (run.effectOutcomeKind ?? "uncertain");
  const reason = run.effectEvidence?.reason ?? "not recorded";
  const facts = [
    `potential ${run.effectPotential ?? "not recorded"}`,
    `disposition ${run.effectDisposition ?? "not recorded"}`,
    `outcome ${outcome}`,
    `evidence ${reason}`,
  ].join(" · ");
  const guidance =
    outcome === "uncertain"
      ? "Inspect external or runtime state before retry. Automatic replay is suppressed."
      : undefined;
  const concreteNote =
    outcome === "concrete"
      ? "A concrete receipt is recorded; verify it against the canonical owner ledger before relying on its ID."
      : undefined;
  return {
    facts,
    guidance,
    plainSummary: guidance
      ? `${presentToolEffectOutcome(outcome)} Automatic replay is suppressed.`
      : presentToolEffectOutcome(outcome),
    summary: [`Effect truth: ${facts}.`, guidance, concreteNote].filter(Boolean).join(" "),
    tone: outcome === "concrete" ? "concrete" : outcome === "uncertain" ? "uncertain" : "none",
  };
}

function wasRefusedBeforeDispatch(run: Partial<Pick<ChatToolRunRecord, "status" | "result">>): boolean {
  const outcome = run.result?.approvalOutcome;
  return run.status === "blocked" && (outcome === "denied" || outcome === "withdrawn" || outcome === "expired");
}
