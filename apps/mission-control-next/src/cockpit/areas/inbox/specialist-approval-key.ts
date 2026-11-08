import { canonicalJsonString } from "@goatcitadel/contracts";
import type { SpecialistEvidence } from "./specialist-approval-evidence";

export function specialistEvidenceKey(evidence: SpecialistEvidence): string {
  return canonicalJsonString({
    ...evidence,
    // Reads append replay audit events and can deliver observability receipts. Neither
    // changes the reviewed action. Retain all execution/policy effects and other
    // events, pending action, durable mapping, and the full native runtime review.
    replay: {
      ...evidence.replay,
      events: evidence.replay.events.filter((event) => event.eventType !== "replayed"),
      effects: evidence.replay.effects.filter((effect) => effect.effectKind !== "approval_observability"),
    },
    source: evidence.source ? { ...evidence.source, verifiedAt: undefined } : undefined,
  });
}
