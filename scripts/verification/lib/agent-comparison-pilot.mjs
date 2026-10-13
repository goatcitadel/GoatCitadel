import path from "node:path";
import { normalizeComparisonPilotBudget, prepareComparison, sha256 } from "./agent-comparison.mjs";

export const PILOT_VERSION = "goatcitadel.agent-comparison.pilot.v1";
// Additional product acceptance is separate from the five unchanged comparative
// fixtures. These are required scenarios, never generated passing evidence.
export const FEATURE_ACCEPTANCE_SCENARIOS = Object.freeze([
  {
    id: "web_research",
    criteria: ["discovers_multiple_sources", "claims_match_cited_sources", "conflicting_evidence_disclosed"],
  },
  {
    id: "scheduled_agent_work",
    criteria: [
      "durable_agent_turn_admitted",
      "tools_run_under_current_authority",
      "approval_resume_after_restart",
      "no_duplicate_external_effect",
    ],
  },
  {
    id: "provider_recovery",
    criteria: ["bounded_retry", "visible_provider_change", "no_replay_after_uncertain_side_effect"],
  },
  {
    id: "delegation",
    criteria: ["observable_plan", "bounded_child_budgets", "retained_lineage", "verified_synthesis"],
  },
  {
    id: "skill_and_context_quality",
    criteria: [
      "relevant_active_skill_selected",
      "irrelevant_context_excluded",
      "same_task_correctness_preserved",
      "measured_tokens_and_useful_output_time",
    ],
  },
  {
    id: "mcp_setup_and_use",
    criteria: [
      "reviewed_registration",
      "actual_connection_and_discovery",
      "current_tool_permission",
      "governed_task_artifact",
    ],
  },
]);

export function createComparisonPilot({ pilotId, hostedBudgetDirectory }) {
  const material = {
    schemaVersion: PILOT_VERSION,
    hostedBudget: normalizeComparisonPilotBudget({
      pilotId,
      directory: hostedBudgetDirectory,
      maxRequests: 450,
      maxCostUsd: 25,
    }),
    localMaxRequests: 450,
    trials: 3,
    // Pilot ceiling; each campaign pins one common supported limit at or below it.
    contextTokens: 64_000,
    outputTokens: 4096,
    maxTaskMs: 600_000,
  };
  return { ...material, pilotSha256: sha256(material) };
}

export function validateComparisonPilot(pilot) {
  const expected = createComparisonPilot({
    pilotId: pilot?.hostedBudget?.pilotId,
    hostedBudgetDirectory: pilot?.hostedBudget?.directory,
  });
  if (sha256(pilot) !== sha256(expected)) throw new Error("The fixed pilot authorization or binding changed.");
  return expected;
}

export function preparePilotComparison(pilot, config) {
  validateComparisonPilot(pilot);
  const local = config.transportProfile?.kind === "local";
  if (!config.transportProfile) throw new Error("Pilot campaigns require a pinned hosted or local transport.");
  const products = Object.values(config.products ?? {});
  const commonContextTokens = products[0]?.contextTokens;
  if (
    !Number.isSafeInteger(commonContextTokens) ||
    commonContextTokens < 1 ||
    commonContextTokens > pilot.contextTokens ||
    products.some(
      (product) =>
        product.contextTokens !== commonContextTokens ||
        product.outputTokens !== pilot.outputTokens ||
        product.maxTaskMs !== pilot.maxTaskMs,
    )
  )
    throw new Error(
      "Pilot products must share a supported context limit capped at 64,000 tokens, 4,096 output tokens and a ten-minute task deadline.",
    );
  if (config.pilotBudget !== undefined || config.localPilotBudget !== undefined)
    throw new Error("Pilot preparation owns the shared budget binding.");
  return prepareComparison({
    ...config,
    trials: pilot.trials,
    maxRequests: local ? pilot.localMaxRequests : pilot.hostedBudget.maxRequests,
    maxCostUsd: local ? 0 : pilot.hostedBudget.maxCostUsd,
    ...(!local ? { pilotBudget: pilot.hostedBudget } : {}),
    ...(local
      ? {
          localPilotBudget: {
            pilotId: pilot.hostedBudget.pilotId,
            directory: path.join(path.dirname(pilot.hostedBudget.directory), "local-budget"),
            maxRequests: pilot.localMaxRequests,
            maxCostUsd: 0,
          },
        }
      : {}),
  });
}

export function pilotFeatureAcceptance(pilot) {
  validateComparisonPilot(pilot);
  return {
    schemaVersion: "goatcitadel.feature-acceptance.v1",
    pilotSha256: pilot.pilotSha256,
    rows: FEATURE_ACCEPTANCE_SCENARIOS.flatMap((scenario) =>
      ["hosted", "local"].map((track) => ({ ...scenario, track, status: "not_run", evidence: [] })),
    ),
    note: "The existing cited_research fixture uses supplied files; scheduled_delivery is a fixed reminder. Neither substitutes for web research or scheduled agent work. Missing inputs, exhausted budgets and unsupported cases remain incomplete.",
  };
}

export function pilotDirectory(pilot) {
  validateComparisonPilot(pilot);
  return path.dirname(pilot.hostedBudget.directory);
}
