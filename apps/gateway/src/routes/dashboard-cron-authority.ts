import { SemanticValidationError } from "@goatcitadel/contracts";

/** Public cron configuration may select a profile; only authenticated request
 * authority supplies its creator. Internal occurrence links never enter here. */
export function bindPublicCronCreator(actionConfig: unknown, authActorId: string | undefined): unknown {
  if (!actionConfig || typeof actionConfig !== "object" || Array.isArray(actionConfig)) return actionConfig;
  const config = actionConfig as Record<string, unknown>;
  if (config.creatorAuthority !== undefined)
    throw invalid("Creator authority cannot be supplied through public configuration.");
  if (!config.agentTurn || typeof config.agentTurn !== "object" || Array.isArray(config.agentTurn)) return actionConfig;
  const agentTurn = config.agentTurn as Record<string, unknown>;
  if (agentTurn.creatorAuthority !== undefined)
    throw invalid("Creator authority cannot be supplied through public configuration.");
  if (agentTurn.commitment !== undefined)
    throw invalid("Canonical commitment occurrence references cannot be supplied through public cron configuration.");
  const actorId = authActorId?.trim();
  if (!actorId) throw invalid("Agent-turn schedules require an authenticated creator.");
  const requested =
    agentTurn.createdBy && typeof agentTurn.createdBy === "object" && !Array.isArray(agentTurn.createdBy)
      ? (agentTurn.createdBy as Record<string, unknown>)
      : {};
  for (const field of ["operatorId", "authActorId"] as const) {
    if (requested[field] !== undefined && requested[field] !== actorId)
      throw invalid("Schedule creator identity must match the authenticated operator.");
  }
  if (requested.createdByJobId !== undefined || (requested.depth !== undefined && requested.depth !== 0))
    throw invalid("Scheduled-parent provenance cannot be supplied through public cron configuration.");
  return {
    ...config,
    agentTurn: {
      ...agentTurn,
      createdBy: {
        operatorId: actorId,
        authActorId: actorId,
        depth: 0,
        ...(typeof requested.permissionProfileId === "string" && requested.permissionProfileId.trim()
          ? { permissionProfileId: requested.permissionProfileId.trim() }
          : {}),
      },
    },
  };
}

function invalid(message: string) {
  return new SemanticValidationError(message);
}
