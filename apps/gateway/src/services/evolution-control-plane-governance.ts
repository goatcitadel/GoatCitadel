import { CHANGE_PLAN_KINDS, type ChangePlanKind } from "@goatcitadel/contracts";

export interface GovernedMutationInventoryEntry {
  readonly kind: ChangePlanKind;
  readonly owner: string;
  readonly canonicalEntryPoints: readonly string[];
  readonly compatibilityEntryPoints: readonly string[];
  readonly mutationBoundary: string;
}

/**
 * Frozen v1 inventory. Every durable self-configuration/evolution writer must
 * map to one of these kinds. Compatibility routes may preserve their public
 * request shape for one window, but their mutation boundary must re-enter the
 * same registered adapter as the canonical Change Plan resource API.
 */
export const EVOLUTION_GOVERNED_MUTATION_INVENTORY: readonly GovernedMutationInventoryEntry[] = [
  {
    kind: "session_model",
    owner: "chat_session_prefs",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: ["POST /api/v1/chat/sessions/:sessionId/change-plans", "/model", "/think"],
    mutationBoundary: "ModelChangePlanAdapter.apply",
  },
  {
    kind: "installation_default_model",
    owner: "runtime_settings.llm",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: ["PATCH /api/v1/settings"],
    mutationBoundary: "ModelChangePlanAdapter.apply",
  },
  {
    kind: "provider_connection",
    owner: "provider_secret_and_runtime_settings",
    canonicalEntryPoints: [
      "POST /api/v1/change-plans",
      "POST /api/v1/change-plans/:planId/provider-secret",
      "POST /api/v1/change-plans/:planId/provider-oauth-starts",
      "POST /api/v1/change-plans/:planId/provider-oauth-polls",
      "POST /api/v1/change-plans/:planId/provider-oauth-completions",
      "change.request",
    ],
    compatibilityEntryPoints: [
      "POST /api/v1/secrets/providers/:providerId",
      "DELETE /api/v1/secrets/providers/:providerId",
      "POST /api/v1/llm/providers/openai-codex/oauth/device/start (feature-disabled compatibility only)",
      "POST /api/v1/llm/providers/openai-codex/oauth/device/poll (feature-disabled compatibility only)",
      "DELETE /api/v1/llm/providers/openai-codex/oauth (feature-disabled compatibility only)",
    ],
    mutationBoundary: "ProviderConnectionChangePlanAdapter.apply",
  },
  {
    kind: "runtime_configuration",
    owner: "runtime_settings",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: ["PATCH /api/v1/settings"],
    mutationBoundary: "RuntimeConfigurationChangePlanAdapter.apply",
  },
  {
    kind: "channel_connection",
    owner: "channel_setup",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: [
      "POST /api/v1/channels/drafts",
      "PATCH /api/v1/channels/drafts/:draftId",
      "POST /api/v1/channels/drafts/:draftId/validate",
      "POST /api/v1/channels/drafts/:draftId/test",
      "POST /api/v1/channels/drafts/:draftId/finalize",
    ],
    mutationBoundary: "ChannelConnectionChangePlanAdapter.apply",
  },
  {
    kind: "runtime_remediation",
    owner: "governed_remediation_coordinator",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: ["blocked-turn remediation continuation"],
    mutationBoundary: "RuntimeRemediationChangePlanAdapter.apply",
  },
  {
    kind: "capability_candidate",
    owner: "capability_system",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: [
      "POST /api/v1/capabilities/candidates/:candidateId/promote",
      "POST /api/v1/capabilities/candidates/:candidateId/revoke",
      "POST /api/v1/capabilities/candidates/:candidateId/rollback",
    ],
    mutationBoundary: "CapabilityCandidateChangePlanAdapter.stage",
  },
  {
    kind: "improvement_candidate",
    owner: "improvement_lifecycle",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: [
      "POST /api/v1/improvement/candidates/:candidateId/activate",
      "POST /api/v1/improvement/autotune/:tuneId/approve",
    ],
    mutationBoundary: "ImprovementCandidateChangePlanAdapter.stage",
  },
  {
    kind: "managed_source_registration",
    owner: "managed_source_install",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "native path picker owner"],
    compatibilityEntryPoints: [],
    mutationBoundary: "ManagedSourceRegistrationChangePlanAdapter.apply",
  },
  {
    kind: "product_source_update",
    owner: "product_update_supervisor",
    canonicalEntryPoints: ["POST /api/v1/change-plans", "change.request"],
    compatibilityEntryPoints: ["verified signed packaged updater"],
    mutationBoundary: "ProductSourceUpdateChangePlanAdapter.apply",
  },
] as const;

export interface EvolutionMutationExclusion {
  readonly category: string;
  readonly reason: string;
  readonly examples: readonly string[];
}

/** Deliberate non-goals: these retain their existing owner and governance. */
export const EVOLUTION_MUTATION_EXCLUSIONS: readonly EvolutionMutationExclusion[] = [
  {
    category: "client_local_preferences",
    reason: "Local-only presentation state is not a durable runtime effect.",
    examples: ["theme", "panel size", "collapsed sections", "draft composer text"],
  },
  {
    category: "ordinary_content_crud",
    reason: "Content ownership is already explicit and does not reconfigure the product.",
    examples: ["documents", "project files", "task notes", "chat messages"],
  },
  {
    category: "project_task_memory_crud",
    reason: "Projects, tasks, and memory keep their existing lifecycle, scope, and approval owners.",
    examples: ["project rename", "task status", "memory edit", "memory forget"],
  },
  {
    category: "ordinary_tool_side_effects",
    reason: "Tool policy, approvals, and the external-side-effect ledger remain authoritative.",
    examples: ["send message", "create calendar event", "invoke MCP", "write an operator file"],
  },
  {
    category: "read_only_and_diagnostics",
    reason: "Inspection and diagnostics do not create a durable mutation target.",
    examples: ["catalog reads", "health checks", "cost reports", "dev verification fixtures"],
  },
] as const;

export function assertEvolutionGovernanceInventory(): void {
  const kinds = EVOLUTION_GOVERNED_MUTATION_INVENTORY.map((entry) => entry.kind);
  if (new Set(kinds).size !== kinds.length) {
    throw new Error("Evolution governed mutation inventory contains a duplicate kind.");
  }
  const missing = CHANGE_PLAN_KINDS.filter((kind) => !kinds.includes(kind));
  const foreign = kinds.filter((kind) => !(CHANGE_PLAN_KINDS as readonly string[]).includes(kind));
  if (missing.length || foreign.length) {
    throw new Error(
      `Evolution governed mutation inventory drifted (missing=${missing.join(",")}; foreign=${foreign.join(",")}).`,
    );
  }
  for (const entry of EVOLUTION_GOVERNED_MUTATION_INVENTORY) {
    if (!entry.owner.trim() || !entry.mutationBoundary.trim() || entry.canonicalEntryPoints.length === 0) {
      throw new Error(`Evolution governed mutation inventory entry ${entry.kind} is incomplete.`);
    }
  }
  const exclusionCategories = EVOLUTION_MUTATION_EXCLUSIONS.map((entry) => entry.category);
  if (new Set(exclusionCategories).size !== exclusionCategories.length) {
    throw new Error("Evolution mutation exclusion inventory contains a duplicate category.");
  }
}
