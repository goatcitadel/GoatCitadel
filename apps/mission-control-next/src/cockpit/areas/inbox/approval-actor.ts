import { APPROVAL_EXPIRY_ACTOR_ID } from "@goatcitadel/contracts";

/**
 * Who recorded an event, in plain words; the actor id itself belongs in technical details. Only a recorded decision
 * is known to come from an operator: other events (a queued action, an explanation) may be recorded by an agent.
 */
export function presentActor(actorId: string | undefined, role: "decision" | "event" = "decision"): string {
  if (!actorId) return "Not recorded";
  if (actorId === APPROVAL_EXPIRY_ACTOR_ID) return "Expiry check";
  if (actorId.startsWith("system:") || actorId === "system" || actorId === "gateway") return "GoatCitadel";
  return role === "decision" ? "An operator" : "An agent or operator";
}
