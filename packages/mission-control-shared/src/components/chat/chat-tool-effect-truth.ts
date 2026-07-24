import type { ChatToolRunRecord } from "@goatcitadel/contracts";

export interface ChatToolEffectTruthProjection {
  facts: string;
  guidance?: string;
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
  run: Pick<ChatToolRunRecord, "effectPotential" | "effectDisposition" | "effectOutcomeKind" | "effectEvidence">,
): ChatToolEffectTruthProjection | undefined {
  if (!run.effectPotential && !run.effectDisposition && !run.effectOutcomeKind && !run.effectEvidence) {
    return undefined;
  }
  const outcome = run.effectOutcomeKind ?? "uncertain";
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
    summary: [`Effect truth: ${facts}.`, guidance, concreteNote].filter(Boolean).join(" "),
    tone: outcome === "concrete" ? "concrete" : outcome === "uncertain" ? "uncertain" : "none",
  };
}
