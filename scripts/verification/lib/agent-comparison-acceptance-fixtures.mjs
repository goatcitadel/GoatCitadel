// Separate opt-in journeys. The original five comparative fixtures stay unchanged.
export const FEATURE_ACCEPTANCE_SUITE = "feature_acceptance_v1";
export const FEATURE_ACCEPTANCE_TASKS = Object.freeze([
  {
    id: "web_research",
    prompt:
      "Research the current transaction-isolation behavior of PostgreSQL and SQLite using public primary documentation. Discover and open at least two independent primary-source domains. Write research.json with claims [{id,text,url,quote}] and conflicts [{claimIds,explanation}]. Cite each claim; disclose any uncertainty or conflicting statements. Do not use supplied source files.",
    files: {},
    phases: [
      { id: "research", action: "run_turn" },
      { id: "source_review", action: "review_sources" },
    ],
    criteria: ["discovers_multiple_sources", "claims_match_cited_sources", "conflicting_evidence_disclosed"],
  },
  {
    id: "scheduled_agent_work",
    prompt:
      "Schedule an agent task for the authorized test time: read input/ledger.json, calculate totalCents, and deliver the computed report once to the authorized test destination. The run must actually use tools. Pause for the normal delivery approval. The operator will restart the isolated runtime before approving, then reconnect after delivery to check for duplicates. Do not replace the agent task with a fixed reminder.",
    files: { "input/ledger.json": '{"amountsCents":[130,270,600]}\n' },
    phases: [
      { id: "schedule", action: "run_turn" },
      { id: "await_approval", action: "await_approval" },
      { id: "restart", action: "restart_owned_runtime" },
      { id: "approve", action: "operator_approve" },
      { id: "settle", action: "await_settlement" },
      { id: "reconnect", action: "reconnect" },
    ],
    criteria: [
      "durable_agent_turn_admitted",
      "tools_run_under_current_authority",
      "approval_resume_after_restart",
      "no_duplicate_external_effect",
    ],
  },
  {
    id: "provider_recovery",
    prompt:
      "Read input/ledger.json and create recovery.json with totalCents. Use the explicitly configured fallback if the primary provider fails before useful output. The operator injects one controlled failure before the metered proxy forwards upstream; native transport has reached that fixture. The operator will also run a separate read-only uncertain-effect case; stop and reconcile that case instead of automatically repeating the effect. Report the actual provider used.",
    files: { "input/ledger.json": '{"amountsCents":[130,270,600]}\n' },
    phases: [
      { id: "known_failure", action: "arm_predispatch_failure" },
      { id: "fallback", action: "run_turn" },
      { id: "unknown_case", action: "run_uncertain_effect_case" },
      { id: "reconcile", action: "read_reconciliation" },
    ],
    criteria: ["bounded_retry", "visible_provider_change", "no_replay_after_uncertain_side_effect"],
  },
  {
    id: "delegation",
    prompt:
      "Plan and delegate two bounded child tasks: independently sum the north and south amounts in input/regions.json, then verify their evidence and synthesize delegation.json with northCents, southCents, totalCents. The operator will restart the isolated runtime after one child completes. Preserve the existing child results and lineage when recovering; do not launch duplicate children.",
    files: { "input/regions.json": '{"north":[130,270],"south":[100,500]}\n' },
    phases: [
      { id: "delegate", action: "run_turn" },
      { id: "one_child", action: "await_child_completion" },
      { id: "restart", action: "restart_owned_runtime" },
      { id: "recover", action: "await_settlement" },
      { id: "verify", action: "read_lineage" },
    ],
    criteria: ["observable_plan", "bounded_child_budgets", "retained_lineage", "verified_synthesis"],
  },
]);
