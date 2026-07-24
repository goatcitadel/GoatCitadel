/**
 * Exhaustive semantic vocabulary for session-bound mutation producers.
 *
 * Source ids are intentionally stable owner/method labels rather than source
 * locations. Unknown producers are forbidden so adding a new callback cannot
 * silently inherit write authority.
 */
export const SESSION_MUTATION_SOURCE_CLASSIFICATIONS = [
  "synchronous_authority_mutation",
  "long_lived_turn_mutation",
  "external_effect_dispatch",
  "authority_bearing_callback_result",
  "allowed_actual_attempt_evidence",
  "operator_approval_exemption",
  "advisory_read_only",
  "forbidden_unclassified",
] as const;

export type SessionMutationSourceClassification = (typeof SESSION_MUTATION_SOURCE_CLASSIFICATIONS)[number];

export interface SessionMutationSourceInventoryRecord {
  sourceId: string;
  owner: string;
  classification: Exclude<SessionMutationSourceClassification, "forbidden_unclassified">;
  rationale: string;
}

export const SESSION_MUTATION_SOURCE_INVENTORY = [
  source(
    "chat.entry.append",
    "chat-turn-entry-service",
    "long_lived_turn_mutation",
    "Admits one explicit turn identity before routing or preparation.",
  ),
  source(
    "chat.entry.surface-route.persist",
    "chat-turn-entry-service",
    "synchronous_authority_mutation",
    "Persists a mode only under the already admitted turn authority.",
  ),
  source(
    "chat.prep.user-message.persist",
    "chat-turn-prep-service",
    "long_lived_turn_mutation",
    "Creates canonical user content for an admitted turn.",
  ),
  source(
    "chat.prep.mobile-context.provenance",
    "chat-turn-prep-service",
    "allowed_actual_attempt_evidence",
    "Append-only audit evidence records mobile context attached to an already committed user-message ingest without claiming current session authority.",
  ),
  source(
    "chat.prep.profile.persist",
    "chat-turn-prep-service",
    "long_lived_turn_mutation",
    "Freezes the admitted capability profile and routed-context snapshot.",
  ),
  source(
    "chat.dispatch.provider",
    "chat-turn-dispatch-service",
    "external_effect_dispatch",
    "Crosses a provider or integration boundary and must fence immediately before dispatch.",
  ),
  source(
    "chat.stream.trace.persist",
    "chat-turn-stream-service",
    "long_lived_turn_mutation",
    "Persists authority-bearing trace and assistant projections.",
  ),
  source(
    "chat.stream.tool-result.callback",
    "chat-turn-stream-service",
    "authority_bearing_callback_result",
    "A late tool result may mutate canonical Chat state only under the exact admission.",
  ),
  source(
    "chat.agent-runner.tool.dispatch",
    "chat-turn-agent-runner",
    "external_effect_dispatch",
    "Tool execution crosses a side-effect boundary.",
  ),
  source(
    "chat.agent-runner.actual-attempt.persist",
    "chat-turn-agent-runner",
    "allowed_actual_attempt_evidence",
    "Attempt truth survives loss of normal turn-write authority.",
  ),
  source(
    "chat.agent-runner.effect-truth.persist",
    "chat-turn-agent-runner",
    "allowed_actual_attempt_evidence",
    "HX-305 actual effect evidence is retained after an attempted dispatch.",
  ),
  source(
    "chat.agent-runner.usage.persist",
    "chat-turn-agent-runner",
    "allowed_actual_attempt_evidence",
    "HX-306 actual provider usage and cost evidence is never erased by a late fence.",
  ),
  source(
    "chat.agent-runner.result.persist",
    "chat-turn-agent-runner",
    "authority_bearing_callback_result",
    "Normal tool/model results require the exact still-active admission.",
  ),
  source(
    "chat.durable-run.create-bind",
    "chat-durable-run-service",
    "long_lived_turn_mutation",
    "Creates a durable Chat run and transfers the admitted request owner atomically.",
  ),
  source(
    "chat.durable-run.resume",
    "durable-execution-service",
    "long_lived_turn_mutation",
    "Resumes the exact persisted admission under a fresh durable lease claim.",
  ),
  source(
    "chat.durable-run.terminal",
    "chat-durable-run-service",
    "authority_bearing_callback_result",
    "Closes a turn admission only after synchronous receipts and child handoff commit.",
  ),
  source(
    "chat.continuation.user-input.resolve",
    "chat-message-route-runtime",
    "authority_bearing_callback_result",
    "An authenticated user-input answer may resume only the exact waiting durable turn admission through the atomic continuation owner.",
  ),
  source(
    "chat.autonomous.cron.ingress",
    "chat-autonomous-turn-service",
    "long_lived_turn_mutation",
    "A cron execution must admit its deterministic system-authored Chat turn before preparation or durable-run creation.",
  ),
  source(
    "chat.autonomous.heartbeat.ingress",
    "chat-autonomous-turn-service",
    "long_lived_turn_mutation",
    "Heartbeat-selected work must enter Chat through an explicit system-actor admission and cannot reuse operator request authority.",
  ),
  source(
    "chat.autonomous.proactive.ingress",
    "chat-autonomous-turn-service",
    "long_lived_turn_mutation",
    "Proactive work must freeze its system actor, session incarnation, generation, and turn material before preparing the turn.",
  ),
  source(
    "chat.external.companion-reply.ingress",
    "channel-inbound-dispatch",
    "long_lived_turn_mutation",
    "A companion or channel reply is untrusted external ingress and must receive a new server-owned turn admission before Chat mutation.",
  ),
  source(
    "chat.external.integration-reply.ingress",
    "inbound-channel-event-service",
    "long_lived_turn_mutation",
    "An integration webhook reply may identify source content but cannot supply or inherit canonical Chat mutation authority.",
  ),
  source(
    "chat.post-commit.child.admit",
    "chat-durable-run-service",
    "long_lived_turn_mutation",
    "A provider-backed post-commit child freezes exact parent lineage, eligibility, actor identity, and material before it becomes runnable.",
  ),
  source(
    "chat.post-commit.child.dispatch",
    "chat-post-commit-effect-service",
    "external_effect_dispatch",
    "Each post-commit child effect fences its durable child claim immediately before the provider or effect boundary.",
  ),
  source(
    "chat.post-commit.child.stage",
    "chat-post-commit-effect-service",
    "authority_bearing_callback_result",
    "Assembly and later child stages persist only under the exact child admission, durable claim, lineage, and eligibility context.",
  ),
  source(
    "chat.post-commit.parent.capability-gap",
    "durable-execution-service",
    "authority_bearing_callback_result",
    "Capability-gap evidence may persist only through the exact atomic parent-local post-commit stage fence.",
  ),
  source(
    "chat.post-commit.parent.realtime",
    "durable-execution-service",
    "authority_bearing_callback_result",
    "The canonical thread projection publishes only while the exact parent admission still owns current authority.",
  ),
  source(
    "chat.post-commit.parent.agent-end",
    "durable-execution-service",
    "external_effect_dispatch",
    "Agent-end delivery is materialized only through the exact allowed parent-local post-commit stage.",
  ),
  source(
    "chat.post-commit.learned-memory.retired",
    "durable-execution-service",
    "advisory_read_only",
    "Direct learned-memory promotion is production-dark pending the governed candidate and correction-provenance owner.",
  ),
  source(
    "chat.post-commit.memory-prewarm.retired",
    "durable-execution-service",
    "advisory_read_only",
    "Post-turn memory prewarm is production-dark because asynchronous launch cannot remain inside atomic parent authority.",
  ),
  source(
    "chat.post-commit.commitments-direct.retired",
    "durable-execution-service",
    "advisory_read_only",
    "Direct commitments extraction is retired; only the admitted durable commitments child may execute in production.",
  ),
  source(
    "chat.entry.post-commit-direct.retired",
    "chat-turn-entry-service",
    "advisory_read_only",
    "The non-stream compatibility path performs no direct learned-memory, commitment, prewarm, or provider-backed post-commit work.",
  ),
  source(
    "chat.stream.post-commit-direct.retired",
    "chat-turn-stream-service",
    "advisory_read_only",
    "The stream compatibility path performs no direct learned-memory, commitment, prewarm, or provider-backed post-commit work.",
  ),
  source(
    "chat.turn.cancel",
    "chat-turn-cancellation",
    "synchronous_authority_mutation",
    "Cancellation closes normal turn-write authority before late callbacks can commit.",
  ),
  source(
    "chat.turn.interruption-recovery",
    "chat-turn-interruption-recovery-service",
    "authority_bearing_callback_result",
    "Recovery may mutate only the exact persisted turn incarnation and admission.",
  ),
  source(
    "chat.approval.operator-resolution",
    "approval-lifecycle-service",
    "operator_approval_exemption",
    "The canonical operator approval owner retains its separate approval authority.",
  ),
  source(
    "chat.approval.terminal-materialize",
    "approval-lifecycle-service",
    "operator_approval_exemption",
    "The canonical approval resolver may materialize the exact terminal handoff and close its linked admission after settlement only.",
  ),
  source(
    "chat.legacy.background-review.retired",
    "gateway-service",
    "advisory_read_only",
    "The legacy post-turn background-review scheduler is retired and carries no production mutation or dispatch authority.",
  ),
  source(
    "chat.legacy.memory-maintenance.retired",
    "gateway-service",
    "advisory_read_only",
    "The legacy post-turn memory-maintenance scheduler is retired; durable post-commit ownership is the only production path.",
  ),
  source(
    "chat.read.session-projection",
    "gateway-service",
    "advisory_read_only",
    "Read-only session projections do not receive mutation authority.",
  ),
] as const satisfies readonly SessionMutationSourceInventoryRecord[];

const classificationBySourceId = new Map<string, SessionMutationSourceClassification>(
  SESSION_MUTATION_SOURCE_INVENTORY.map((record) => [record.sourceId, record.classification] as const),
);

export function classifySessionMutationSource(sourceId: string): SessionMutationSourceClassification {
  return classificationBySourceId.get(sourceId.trim()) ?? "forbidden_unclassified";
}

export function isSessionMutationSourceClassified(sourceId: string): boolean {
  return classifySessionMutationSource(sourceId) !== "forbidden_unclassified";
}

function source<
  TSourceId extends string,
  TOwner extends string,
  TClassification extends Exclude<SessionMutationSourceClassification, "forbidden_unclassified">,
>(
  sourceId: TSourceId,
  owner: TOwner,
  classification: TClassification,
  rationale: string,
): SessionMutationSourceInventoryRecord & {
  sourceId: TSourceId;
  owner: TOwner;
  classification: TClassification;
} {
  return { sourceId, owner, classification, rationale };
}
