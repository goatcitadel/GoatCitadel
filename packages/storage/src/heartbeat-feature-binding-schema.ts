import type { DatabaseSync } from "node:sqlite";

/** Preserve all historical bytes and unchanged preemption/terminal triggers. */
export function upgradeHeartbeatFeatureBindingSchema(db: DatabaseSync): void {
  const retained = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'chat_heartbeat_occurrences' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  if (!retained.some((item) => item.name === "trg_chat_heartbeat_occurrences_transition_guard"))
    throw new Error("Heartbeat transition guard is missing before migration.");
  const columns = (db.prepare("PRAGMA table_info(chat_heartbeat_occurrences)").all() as Array<{ name: string }>)
    .map((column) => '"' + column.name.replaceAll('"', '""') + '"')
    .join(", ");
  db.exec("CREATE TEMP TABLE heartbeat_v258_preserved AS SELECT * FROM chat_heartbeat_occurrences");
  db.exec("DROP TABLE chat_heartbeat_occurrences");
  db.exec(HEARTBEAT_FEATURE_TABLE_SQL);
  db.exec(`INSERT INTO chat_heartbeat_occurrences (${columns}) SELECT ${columns} FROM heartbeat_v258_preserved`);
  db.exec("DROP TABLE heartbeat_v258_preserved");
  for (const item of retained) {
    db.exec(
      item.name === "trg_chat_heartbeat_occurrences_transition_guard"
        ? HEARTBEAT_FEATURE_TRANSITION_SQL
        : upgradeHeartbeatTerminalGuard(item.name, item.sql),
    );
  }
}

const HEARTBEAT_FEATURE_TABLE_SQL = `
CREATE TABLE chat_heartbeat_occurrences (
      occurrence_id TEXT PRIMARY KEY CHECK(length(occurrence_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      admission_id TEXT NOT NULL UNIQUE CHECK(length(admission_id) BETWEEN 1 AND 256),
      admission_request_sha256 TEXT NOT NULL CHECK(
        length(admission_request_sha256) = 64 AND admission_request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      admission_idempotency_key TEXT NOT NULL CHECK(length(admission_idempotency_key) BETWEEN 1 AND 512),
      admission_correlation_id TEXT NOT NULL CHECK(length(admission_correlation_id) BETWEEN 1 AND 256),
      runtime_owner_id TEXT NOT NULL CHECK(length(runtime_owner_id) BETWEEN 1 AND 256),
      system_actor_id TEXT NOT NULL CHECK(system_actor_id = 'system-heartbeat'),
      admission_material_sha256 TEXT NOT NULL CHECK(
        length(admission_material_sha256) = 64 AND admission_material_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      evaluated_policy_sha256 TEXT NOT NULL CHECK(
        length(evaluated_policy_sha256) = 64 AND evaluated_policy_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      frozen_request_sha256 TEXT NOT NULL CHECK(
        length(frozen_request_sha256) = 64 AND frozen_request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      frozen_objective_sha256 TEXT NOT NULL CHECK(
        length(frozen_objective_sha256) = 64 AND frozen_objective_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      claim_sha256 TEXT NOT NULL UNIQUE CHECK(
        length(claim_sha256) = 64 AND claim_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      aggregate_revision INTEGER NOT NULL CHECK(typeof(aggregate_revision) = 'integer' AND aggregate_revision > 0),
      controller_generation INTEGER NOT NULL CHECK(typeof(controller_generation) = 'integer' AND controller_generation > 0),
      prior_last_proactive_at TEXT CHECK(
        prior_last_proactive_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', prior_last_proactive_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', prior_last_proactive_at, '+0 days') = prior_last_proactive_at
        )
      ),
      prior_last_proactive_run_id TEXT CHECK(
        prior_last_proactive_run_id IS NULL OR length(prior_last_proactive_run_id) BETWEEN 1 AND 256
      ),
      heartbeat_interval_seconds INTEGER NOT NULL CHECK(
        typeof(heartbeat_interval_seconds) = 'integer' AND heartbeat_interval_seconds BETWEEN 900 AND 86400
      ),
      cooldown_seconds INTEGER NOT NULL CHECK(
        typeof(cooldown_seconds) = 'integer' AND cooldown_seconds BETWEEN 0 AND 3600
      ),
      idle_floor_seconds INTEGER NOT NULL CHECK(
        typeof(idle_floor_seconds) = 'integer' AND idle_floor_seconds BETWEEN 0 AND 86400
      ),
      observed_session_activity_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', observed_session_activity_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_session_activity_at, '+0 days') = observed_session_activity_at
      ),
      user_message_id TEXT NOT NULL UNIQUE CHECK(length(user_message_id) BETWEEN 1 AND 256),
      assistant_message_id TEXT NOT NULL UNIQUE CHECK(length(assistant_message_id) BETWEEN 1 AND 256),
      turn_id TEXT NOT NULL UNIQUE CHECK(length(turn_id) BETWEEN 1 AND 256),
      expected_durable_run_id TEXT NOT NULL UNIQUE CHECK(length(expected_durable_run_id) BETWEEN 1 AND 256),
      durable_run_id TEXT UNIQUE CHECK(durable_run_id IS NULL OR length(durable_run_id) BETWEEN 1 AND 256),
      capability_profile_id TEXT UNIQUE CHECK(
        capability_profile_id IS NULL OR length(capability_profile_id) BETWEEN 1 AND 256
      ),
      capability_profile_hash TEXT CHECK(
        capability_profile_hash IS NULL OR (
          length(capability_profile_hash) = 64 AND capability_profile_hash NOT GLOB '*[^0-9a-f]*'
        )
      ),
      feature_reference_sha256 TEXT CHECK(feature_reference_sha256 IS NULL OR (length(feature_reference_sha256) = 64 AND feature_reference_sha256 NOT GLOB '*[^0-9a-f]*')),
      state TEXT NOT NULL CHECK(state IN ('admitted', 'durable_bound', 'terminal', 'abandoned')),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
      claimed_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') = claimed_at
      ),
      durable_bound_at TEXT CHECK(
        durable_bound_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', durable_bound_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', durable_bound_at, '+0 days') = durable_bound_at
        )
      ),
      terminal_at TEXT CHECK(
        terminal_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at, '+0 days') = terminal_at
        )
      ),
      abandoned_at TEXT CHECK(
        abandoned_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', abandoned_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', abandoned_at, '+0 days') = abandoned_at
        )
      ),
      terminal_status TEXT CHECK(
        terminal_status IS NULL OR terminal_status IN ('completed', 'failed', 'cancelled')
      ),
      terminal_handoff_sha256 TEXT CHECK(
        terminal_handoff_sha256 IS NULL OR (
          length(terminal_handoff_sha256) = 64 AND terminal_handoff_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      abandonment_reason TEXT CHECK(
        abandonment_reason IS NULL OR abandonment_reason IN ('admission_closed', 'authority_drift', 'lifecycle_drift')
      ),
      updated_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') = updated_at
      ),
      FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(capability_profile_id) REFERENCES chat_turn_capability_profiles(profile_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(admission_material_sha256 = frozen_request_sha256),
      CHECK((prior_last_proactive_at IS NULL) = (prior_last_proactive_run_id IS NULL)),
      CHECK(
        (state = 'admitted' AND durable_bound_at IS NULL AND terminal_at IS NULL AND abandoned_at IS NULL
          AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
          AND durable_run_id IS NULL AND capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NULL
          AND revision = 1 AND updated_at = claimed_at)
        OR (state = 'durable_bound' AND durable_bound_at IS NOT NULL AND terminal_at IS NULL AND abandoned_at IS NULL
          AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
          AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
          AND ((capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL AND feature_reference_sha256 IS NULL) OR (capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NOT NULL)))
        OR (state = 'terminal' AND durable_bound_at IS NOT NULL AND terminal_at IS NOT NULL AND abandoned_at IS NULL
          AND terminal_status IS NOT NULL AND terminal_handoff_sha256 IS NOT NULL AND abandonment_reason IS NULL
          AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
          AND ((capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL AND feature_reference_sha256 IS NULL) OR (capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NOT NULL)))
        OR (state = 'abandoned' AND terminal_at IS NULL AND abandoned_at IS NOT NULL
          AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NOT NULL
          AND (
            (durable_bound_at IS NULL AND durable_run_id IS NULL
              AND capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NULL)
            OR (abandonment_reason = 'authority_drift' AND durable_bound_at IS NOT NULL
              AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
              AND ((capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL AND feature_reference_sha256 IS NULL) OR (capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NOT NULL)))
          ))
      )
    );
`;

const HEARTBEAT_FEATURE_TRANSITION_SQL = `
CREATE TRIGGER trg_chat_heartbeat_occurrences_transition_guard
    BEFORE UPDATE ON chat_heartbeat_occurrences
    WHEN NEW.occurrence_id <> OLD.occurrence_id
      OR NEW.workspace_id <> OLD.workspace_id OR NEW.session_id <> OLD.session_id
      OR NEW.session_incarnation_id <> OLD.session_incarnation_id OR NEW.admission_id <> OLD.admission_id
      OR NEW.admission_request_sha256 <> OLD.admission_request_sha256
      OR NEW.admission_idempotency_key <> OLD.admission_idempotency_key
      OR NEW.admission_correlation_id <> OLD.admission_correlation_id
      OR NEW.runtime_owner_id <> OLD.runtime_owner_id OR NEW.system_actor_id <> OLD.system_actor_id
      OR NEW.admission_material_sha256 <> OLD.admission_material_sha256
      OR NEW.evaluated_policy_sha256 <> OLD.evaluated_policy_sha256
      OR NEW.frozen_request_sha256 <> OLD.frozen_request_sha256
      OR NEW.frozen_objective_sha256 <> OLD.frozen_objective_sha256
      OR NEW.claim_sha256 <> OLD.claim_sha256
      OR NEW.aggregate_revision <> OLD.aggregate_revision
      OR NEW.controller_generation <> OLD.controller_generation
      OR NEW.prior_last_proactive_at IS NOT OLD.prior_last_proactive_at
      OR NEW.prior_last_proactive_run_id IS NOT OLD.prior_last_proactive_run_id
      OR NEW.heartbeat_interval_seconds <> OLD.heartbeat_interval_seconds
      OR NEW.cooldown_seconds <> OLD.cooldown_seconds OR NEW.idle_floor_seconds <> OLD.idle_floor_seconds
      OR NEW.observed_session_activity_at <> OLD.observed_session_activity_at
      OR NEW.user_message_id <> OLD.user_message_id OR NEW.assistant_message_id <> OLD.assistant_message_id
      OR NEW.turn_id <> OLD.turn_id OR NEW.expected_durable_run_id <> OLD.expected_durable_run_id
      OR NEW.claimed_at <> OLD.claimed_at
      OR NEW.revision <> OLD.revision + 1
      OR NEW.updated_at < OLD.updated_at
      OR (
        abs(julianday(NEW.updated_at) - julianday('now')) * 86400.0 > 1.0
        AND NOT (
          NEW.state = 'abandoned' AND NEW.abandoned_at = NEW.updated_at
          AND EXISTS (
            SELECT 1
            FROM chat_session_control_events event_row
            JOIN chat_session_control_grants successor
              ON successor.workspace_id = event_row.workspace_id
              AND successor.session_id = event_row.session_id
              AND successor.generation = event_row.next_generation
            JOIN chat_session_mutation_admissions admission
              ON admission.admission_id = OLD.admission_id
            WHERE substr(event_row.idempotency_key, 1, 18) = 'heartbeat-preempt_'
              /* heartbeat preemption occurrence timestamp evidence */
              AND event_row.reason_code = 'heartbeat_preempted'
              AND event_row.workspace_id = OLD.workspace_id
              AND event_row.session_id = OLD.session_id
              AND event_row.previous_generation = OLD.controller_generation
              AND event_row.next_generation = OLD.controller_generation + 1
              AND event_row.previous_owner_kind = 'operator'
              AND event_row.next_owner_kind = 'operator'
              AND event_row.previous_lease_state = 'operator_active'
              AND event_row.next_lease_state = 'operator_active'
              AND event_row.request_id IS NULL
              AND event_row.actor_kind = 'operator'
              AND event_row.companion_session_id IS NULL
              AND event_row.device_grant_id IS NULL
              AND event_row.created_at = NEW.updated_at
              AND successor.is_current = 1
              AND successor.owner_kind = 'operator'
              AND successor.lease_state = 'operator_active'
              AND successor.transition_idempotency_key = event_row.idempotency_key
              AND successor.transition_request_sha256 = event_row.request_sha256
              AND successor.created_at = event_row.created_at
              AND successor.updated_at = event_row.created_at
              AND admission.status = 'cancelled'
              AND admission.closed_at = event_row.created_at
              AND ((OLD.state = 'admitted'
                AND NEW.abandonment_reason = 'admission_closed'
                AND admission.terminal_authority_kind = 'request_runtime'
                AND admission.terminal_control_event_id IS NULL
                AND admission.terminal_correlation_id = event_row.event_id)
              OR (OLD.state = 'durable_bound'
                AND NEW.abandonment_reason = 'authority_drift'
                AND admission.terminal_authority_kind = 'authority_superseded'
                AND admission.terminal_control_event_id = event_row.event_id))
              AND NOT EXISTS (
                SELECT 1 FROM chat_session_control_requests request_row
                WHERE request_row.workspace_id = event_row.workspace_id
                  AND request_row.session_id = event_row.session_id
                  AND request_row.requested_generation = event_row.previous_generation
                  AND request_row.status = 'pending'
              )
          )
        )
      )
      OR (OLD.state <> 'admitted' AND (
        NEW.durable_run_id IS NOT OLD.durable_run_id
        OR NEW.capability_profile_id IS NOT OLD.capability_profile_id
        OR NEW.capability_profile_hash IS NOT OLD.capability_profile_hash
        OR NEW.feature_reference_sha256 IS NOT OLD.feature_reference_sha256
      ))
      OR (OLD.state = 'admitted' AND NEW.state = 'durable_bound' AND (
        NEW.durable_run_id <> OLD.expected_durable_run_id
        OR NEW.durable_bound_at <> NEW.updated_at
        OR NOT EXISTS (
          SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
          WHERE binding.admission_id = OLD.admission_id AND binding.turn_id = OLD.turn_id
            AND binding.workspace_id = OLD.workspace_id AND binding.session_id = OLD.session_id
            AND binding.session_incarnation_id = OLD.session_incarnation_id
            AND binding.durable_run_id = OLD.expected_durable_run_id
        )
        OR ((NEW.feature_reference_sha256 IS NULL AND NOT EXISTS (
          SELECT 1 FROM chat_turn_capability_profile_incarnation_bindings profile_binding
          WHERE profile_binding.profile_id = NEW.capability_profile_id
            AND profile_binding.turn_id = OLD.turn_id
            AND profile_binding.profile_hash = NEW.capability_profile_hash
        ))
        OR (NEW.feature_reference_sha256 IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM chat_turn_feature_references feature_binding
          WHERE feature_binding.admission_id = OLD.admission_id
            AND feature_binding.reference_sha256 = NEW.feature_reference_sha256
            AND json_extract(feature_binding.references_json, '$.heartbeatOccurrence.ownerId') = OLD.occurrence_id
            AND json_extract(feature_binding.references_json, '$.heartbeatOccurrence.revision') = CAST(OLD.aggregate_revision AS TEXT)
            AND json_extract(feature_binding.references_json, '$.heartbeatOccurrence.sha256') = OLD.claim_sha256
        )))
        OR EXISTS (
          SELECT 1 FROM chat_messages message
          WHERE message.message_id IN (OLD.user_message_id, OLD.assistant_message_id)
        )
      ))
      OR (OLD.state = 'durable_bound' AND NEW.state = 'terminal' AND (
        NEW.durable_bound_at IS NOT OLD.durable_bound_at OR NEW.terminal_at <> NEW.updated_at
        OR NOT EXISTS (
          SELECT 1 FROM chat_session_mutation_admissions admission
          JOIN durable_runs run ON run.run_id = OLD.durable_run_id
          WHERE admission.admission_id = OLD.admission_id
            AND admission.status IN ('completed', 'cancelled')
            AND admission.terminal_authority_kind = 'durable_terminal'
            AND admission.terminal_durable_run_id = OLD.durable_run_id
            AND admission.terminal_durable_run_status = NEW.terminal_status
            AND run.status = NEW.terminal_status
        )
      ))
      OR (OLD.state = 'admitted' AND NEW.state = 'abandoned' AND (
        NEW.abandoned_at <> NEW.updated_at
        OR EXISTS (
          SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
          WHERE binding.admission_id = OLD.admission_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM chat_session_mutation_admissions admission
          WHERE admission.admission_id = OLD.admission_id AND admission.status <> 'active'
            AND (
              (NEW.abandonment_reason = 'admission_closed'
                AND admission.terminal_authority_kind IN ('expired_recovery', 'request_runtime'))
              OR (NEW.abandonment_reason = 'authority_drift'
                AND admission.terminal_authority_kind = 'authority_superseded')
              OR (NEW.abandonment_reason = 'lifecycle_drift'
                AND admission.terminal_authority_kind = 'lifecycle_delete')
            )
        )
      ))
      OR (OLD.state = 'durable_bound' AND NEW.state = 'abandoned' AND (
        NEW.abandoned_at <> NEW.updated_at OR NEW.abandonment_reason <> 'authority_drift'
        OR NEW.durable_bound_at IS NOT OLD.durable_bound_at
        OR NOT EXISTS (
          SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
          WHERE binding.admission_id = OLD.admission_id AND binding.turn_id = OLD.turn_id
            AND binding.workspace_id = OLD.workspace_id AND binding.session_id = OLD.session_id
            AND binding.session_incarnation_id = OLD.session_incarnation_id
            AND binding.durable_run_id = OLD.durable_run_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM chat_session_mutation_admissions admission
          JOIN durable_runs run ON run.run_id = OLD.durable_run_id
          JOIN chat_session_control_events event_row
            ON event_row.event_id = admission.terminal_control_event_id
          WHERE admission.admission_id = OLD.admission_id
            AND admission.status = 'cancelled'
            AND admission.terminal_authority_kind = 'authority_superseded'
            AND event_row.reason_code = 'heartbeat_preempted'
            AND event_row.workspace_id = OLD.workspace_id AND event_row.session_id = OLD.session_id
            AND event_row.previous_generation = OLD.controller_generation
            AND event_row.next_generation = OLD.controller_generation + 1
            AND event_row.previous_owner_kind = 'operator' AND event_row.next_owner_kind = 'operator'
            AND event_row.previous_lease_state = 'operator_active'
            AND event_row.next_lease_state = 'operator_active'
            AND event_row.actor_kind = 'operator'
            AND run.workflow_key = 'chat.turn.execute' AND run.status = 'cancelled'
            AND run.lease_owner_id IS NULL AND run.lease_expires_at IS NULL
            AND run.lease_heartbeat_at IS NULL AND run.finished_at = NEW.updated_at
        )
      ))
      OR NOT (
        (OLD.state = 'admitted' AND NEW.state IN ('durable_bound', 'abandoned'))
        OR (OLD.state = 'durable_bound' AND NEW.state IN ('terminal', 'abandoned'))
      )
    BEGIN SELECT RAISE(ABORT, 'heartbeat occurrence transition invariant violated'); END;
`;

export const HEARTBEAT_FEATURE_BINDING_POSTGRES_SQL = `
ALTER TABLE chat_heartbeat_occurrences ADD COLUMN IF NOT EXISTS feature_reference_sha256 TEXT;
ALTER TABLE chat_heartbeat_occurrences DROP CONSTRAINT IF EXISTS gc_hbo_feature_reference_sha256_shape;
ALTER TABLE chat_heartbeat_occurrences ADD CONSTRAINT gc_hbo_feature_reference_sha256_shape CHECK(feature_reference_sha256 IS NULL OR feature_reference_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE chat_heartbeat_occurrences DROP CONSTRAINT gc_hbo_state_shape;
ALTER TABLE chat_heartbeat_occurrences ADD CONSTRAINT gc_hbo_state_shape CHECK(
            (state = 'admitted' AND durable_bound_at IS NULL AND terminal_at IS NULL AND abandoned_at IS NULL
              AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
              AND durable_run_id IS NULL AND capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NULL
              AND revision = 1 AND updated_at = claimed_at)
            OR (state = 'durable_bound' AND durable_bound_at IS NOT NULL AND terminal_at IS NULL
              AND abandoned_at IS NULL AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL
              AND abandonment_reason IS NULL AND durable_run_id IS NOT NULL
              AND durable_run_id = expected_durable_run_id
              AND ((capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL AND feature_reference_sha256 IS NULL) OR (capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NOT NULL)))
            OR (state = 'terminal' AND durable_bound_at IS NOT NULL AND terminal_at IS NOT NULL
              AND abandoned_at IS NULL AND terminal_status IS NOT NULL AND terminal_handoff_sha256 IS NOT NULL
              AND abandonment_reason IS NULL AND durable_run_id IS NOT NULL
              AND durable_run_id = expected_durable_run_id
              AND ((capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL AND feature_reference_sha256 IS NULL) OR (capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NOT NULL)))
            OR (state = 'abandoned' AND terminal_at IS NULL
              AND abandoned_at IS NOT NULL AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL
              AND abandonment_reason IS NOT NULL AND (
                (durable_bound_at IS NULL AND durable_run_id IS NULL
                  AND capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NULL)
                OR (abandonment_reason = 'authority_drift' AND durable_bound_at IS NOT NULL
                  AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
                  AND ((capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL AND feature_reference_sha256 IS NULL) OR (capability_profile_id IS NULL AND capability_profile_hash IS NULL AND feature_reference_sha256 IS NOT NULL)))
              ))
          );
CREATE OR REPLACE FUNCTION gc_heartbeat_occurrence_transition_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        IF NEW.occurrence_id <> OLD.occurrence_id
          OR NEW.workspace_id <> OLD.workspace_id OR NEW.session_id <> OLD.session_id
          OR NEW.session_incarnation_id <> OLD.session_incarnation_id OR NEW.admission_id <> OLD.admission_id
          OR NEW.admission_request_sha256 <> OLD.admission_request_sha256
          OR NEW.admission_idempotency_key <> OLD.admission_idempotency_key
          OR NEW.admission_correlation_id <> OLD.admission_correlation_id
          OR NEW.runtime_owner_id <> OLD.runtime_owner_id OR NEW.system_actor_id <> OLD.system_actor_id
          OR NEW.admission_material_sha256 <> OLD.admission_material_sha256
          OR NEW.evaluated_policy_sha256 <> OLD.evaluated_policy_sha256
          OR NEW.frozen_request_sha256 <> OLD.frozen_request_sha256
          OR NEW.frozen_objective_sha256 <> OLD.frozen_objective_sha256
          OR NEW.claim_sha256 <> OLD.claim_sha256
          OR NEW.aggregate_revision <> OLD.aggregate_revision
          OR NEW.controller_generation <> OLD.controller_generation
          OR NEW.prior_last_proactive_at IS DISTINCT FROM OLD.prior_last_proactive_at
          OR NEW.prior_last_proactive_run_id IS DISTINCT FROM OLD.prior_last_proactive_run_id
          OR NEW.heartbeat_interval_seconds <> OLD.heartbeat_interval_seconds
          OR NEW.cooldown_seconds <> OLD.cooldown_seconds OR NEW.idle_floor_seconds <> OLD.idle_floor_seconds
          OR NEW.observed_session_activity_at <> OLD.observed_session_activity_at
          OR NEW.user_message_id <> OLD.user_message_id OR NEW.assistant_message_id <> OLD.assistant_message_id
          OR NEW.turn_id <> OLD.turn_id OR NEW.expected_durable_run_id <> OLD.expected_durable_run_id
          OR NEW.claimed_at <> OLD.claimed_at
          OR NEW.revision <> OLD.revision + 1
          OR gc_try_parse_timestamptz(NEW.updated_at) < gc_try_parse_timestamptz(OLD.updated_at)
          OR (abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.updated_at) - database_now))) > 1
            AND NOT (
              NEW.state = 'abandoned' AND NEW.abandoned_at = NEW.updated_at
              AND EXISTS (
                SELECT 1
                FROM chat_session_control_events event_row
                JOIN chat_session_control_grants successor
                  ON successor.workspace_id = event_row.workspace_id
                  AND successor.session_id = event_row.session_id
                  AND successor.generation = event_row.next_generation
                JOIN chat_session_mutation_admissions admission
                  ON admission.admission_id = OLD.admission_id
                WHERE left(event_row.idempotency_key, 18) = 'heartbeat-preempt_'
                  /* heartbeat preemption occurrence timestamp evidence */
                  AND event_row.reason_code = 'heartbeat_preempted'
                  AND event_row.workspace_id = OLD.workspace_id
                  AND event_row.session_id = OLD.session_id
                  AND event_row.previous_generation = OLD.controller_generation
                  AND event_row.next_generation = OLD.controller_generation + 1
                  AND event_row.previous_owner_kind = 'operator'
                  AND event_row.next_owner_kind = 'operator'
                  AND event_row.previous_lease_state = 'operator_active'
                  AND event_row.next_lease_state = 'operator_active'
                  AND event_row.request_id IS NULL
                  AND event_row.actor_kind = 'operator'
                  AND event_row.companion_session_id IS NULL
                  AND event_row.device_grant_id IS NULL
                  AND event_row.created_at = NEW.updated_at
                  AND successor.is_current = 1
                  AND successor.owner_kind = 'operator'
                  AND successor.lease_state = 'operator_active'
                  AND successor.transition_idempotency_key = event_row.idempotency_key
                  AND successor.transition_request_sha256 = event_row.request_sha256
                  AND successor.created_at = event_row.created_at
                  AND successor.updated_at = event_row.created_at
                  AND admission.status = 'cancelled'
                  AND admission.closed_at = event_row.created_at
                  AND ((OLD.state = 'admitted'
                    AND NEW.abandonment_reason = 'admission_closed'
                    AND admission.terminal_authority_kind = 'request_runtime'
                    AND admission.terminal_control_event_id IS NULL
                    AND admission.terminal_correlation_id = event_row.event_id)
                  OR (OLD.state = 'durable_bound'
                    AND NEW.abandonment_reason = 'authority_drift'
                    AND admission.terminal_authority_kind = 'authority_superseded'
                    AND admission.terminal_control_event_id = event_row.event_id))
                  AND NOT EXISTS (
                    SELECT 1 FROM chat_session_control_requests request_row
                    WHERE request_row.workspace_id = event_row.workspace_id
                      AND request_row.session_id = event_row.session_id
                      AND request_row.requested_generation = event_row.previous_generation
                      AND request_row.status = 'pending'
                  )
              )
            ))
          OR (OLD.state <> 'admitted' AND (
            NEW.durable_run_id IS DISTINCT FROM OLD.durable_run_id
            OR NEW.capability_profile_id IS DISTINCT FROM OLD.capability_profile_id
            OR NEW.capability_profile_hash IS DISTINCT FROM OLD.capability_profile_hash
        OR NEW.feature_reference_sha256 IS DISTINCT FROM OLD.feature_reference_sha256
          ))
          OR (OLD.state = 'admitted' AND NEW.state = 'durable_bound' AND (
            NEW.durable_run_id <> OLD.expected_durable_run_id
            OR NEW.durable_bound_at <> NEW.updated_at
            OR NOT EXISTS (
              SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
              WHERE binding.admission_id = OLD.admission_id AND binding.turn_id = OLD.turn_id
                AND binding.workspace_id = OLD.workspace_id AND binding.session_id = OLD.session_id
                AND binding.session_incarnation_id = OLD.session_incarnation_id
                AND binding.durable_run_id = OLD.expected_durable_run_id
            )
            OR ((NEW.feature_reference_sha256 IS NULL AND NOT EXISTS (
              SELECT 1 FROM chat_turn_capability_profile_incarnation_bindings profile_binding
              WHERE profile_binding.profile_id = NEW.capability_profile_id
                AND profile_binding.turn_id = OLD.turn_id
                AND profile_binding.profile_hash = NEW.capability_profile_hash
            ))
        OR (NEW.feature_reference_sha256 IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM chat_turn_feature_references feature_binding
          WHERE feature_binding.admission_id = OLD.admission_id
            AND feature_binding.reference_sha256 = NEW.feature_reference_sha256
            AND feature_binding.references_json::jsonb #>> '{heartbeatOccurrence,ownerId}' = OLD.occurrence_id
            AND feature_binding.references_json::jsonb #>> '{heartbeatOccurrence,revision}' = CAST(OLD.aggregate_revision AS TEXT)
            AND feature_binding.references_json::jsonb #>> '{heartbeatOccurrence,sha256}' = OLD.claim_sha256
        )))
            OR EXISTS (
              SELECT 1 FROM chat_messages message
              WHERE message.message_id IN (OLD.user_message_id, OLD.assistant_message_id)
            )
          ))
          OR (OLD.state = 'durable_bound' AND NEW.state = 'terminal' AND (
            NEW.durable_bound_at IS DISTINCT FROM OLD.durable_bound_at OR NEW.terminal_at <> NEW.updated_at
            OR NOT EXISTS (
              SELECT 1 FROM chat_session_mutation_admissions admission
              JOIN durable_runs run ON run.run_id = OLD.durable_run_id
              WHERE admission.admission_id = OLD.admission_id
                AND admission.status IN ('completed', 'cancelled')
                AND admission.terminal_authority_kind = 'durable_terminal'
                AND admission.terminal_durable_run_id = OLD.durable_run_id
                AND admission.terminal_durable_run_status = NEW.terminal_status
                AND run.status = NEW.terminal_status
            )
          ))
          OR (OLD.state = 'admitted' AND NEW.state = 'abandoned' AND (
            NEW.abandoned_at <> NEW.updated_at
            OR EXISTS (
              SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
              WHERE binding.admission_id = OLD.admission_id
            )
            OR NOT EXISTS (
              SELECT 1 FROM chat_session_mutation_admissions admission
              WHERE admission.admission_id = OLD.admission_id AND admission.status <> 'active'
                AND (
                  (NEW.abandonment_reason = 'admission_closed'
                    AND admission.terminal_authority_kind IN ('expired_recovery', 'request_runtime'))
                  OR (NEW.abandonment_reason = 'authority_drift'
                    AND admission.terminal_authority_kind = 'authority_superseded')
                  OR (NEW.abandonment_reason = 'lifecycle_drift'
                    AND admission.terminal_authority_kind = 'lifecycle_delete')
                )
            )
          ))
          OR (OLD.state = 'durable_bound' AND NEW.state = 'abandoned' AND (
            NEW.abandoned_at <> NEW.updated_at OR NEW.abandonment_reason <> 'authority_drift'
            OR NEW.durable_bound_at IS DISTINCT FROM OLD.durable_bound_at
            OR NOT EXISTS (
              SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
              WHERE binding.admission_id = OLD.admission_id AND binding.turn_id = OLD.turn_id
                AND binding.workspace_id = OLD.workspace_id AND binding.session_id = OLD.session_id
                AND binding.session_incarnation_id = OLD.session_incarnation_id
                AND binding.durable_run_id = OLD.durable_run_id
            )
            OR NOT EXISTS (
              SELECT 1
              FROM chat_session_mutation_admissions admission
              JOIN durable_runs run ON run.run_id = OLD.durable_run_id
              JOIN chat_session_control_events event_row
                ON event_row.event_id = admission.terminal_control_event_id
              WHERE admission.admission_id = OLD.admission_id
                AND admission.status = 'cancelled'
                AND admission.terminal_authority_kind = 'authority_superseded'
                AND event_row.reason_code = 'heartbeat_preempted'
                AND event_row.workspace_id = OLD.workspace_id AND event_row.session_id = OLD.session_id
                AND event_row.previous_generation = OLD.controller_generation
                AND event_row.next_generation = OLD.controller_generation + 1
                AND event_row.previous_owner_kind = 'operator' AND event_row.next_owner_kind = 'operator'
                AND event_row.previous_lease_state = 'operator_active'
                AND event_row.next_lease_state = 'operator_active'
                AND event_row.actor_kind = 'operator'
                AND run.workflow_key = 'chat.turn.execute' AND run.status = 'cancelled'
                AND run.lease_owner_id IS NULL AND run.lease_expires_at IS NULL
                AND run.lease_heartbeat_at IS NULL AND run.finished_at = NEW.updated_at
            )
          ))
          OR NOT (
            (OLD.state = 'admitted' AND NEW.state IN ('durable_bound', 'abandoned'))
            OR (OLD.state = 'durable_bound' AND NEW.state IN ('terminal', 'abandoned'))
          ) THEN
          RAISE EXCEPTION 'heartbeat occurrence transition invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

DO $heartbeat_feature_terminal$
DECLARE guard_sql TEXT;
DECLARE anchor_sql TEXT := $heartbeat_feature_anchor$            AND run.metadata #>> '{autonomousAdmission,material,capability,profileId}'
              = run.payload ->> 'capabilityProfileId'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileHash}'
              = run.payload ->> 'capabilityProfileHash'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileId}'
              = run.metadata ->> 'capabilityProfileId'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileHash}'
              = run.metadata ->> 'capabilityProfileHash'
            AND length(run.metadata #>> '{autonomousAdmission,material,capability,snapshotId}') BETWEEN 1 AND 256
$heartbeat_feature_anchor$;
DECLARE replacement_sql TEXT := $heartbeat_feature_replacement$            AND ((OLD.feature_reference_sha256 IS NULL AND (
              run.metadata #>> '{autonomousAdmission,material,capability,profileId}'
              = run.payload ->> 'capabilityProfileId'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileHash}'
              = run.payload ->> 'capabilityProfileHash'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileId}'
              = run.metadata ->> 'capabilityProfileId'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileHash}'
              = run.metadata ->> 'capabilityProfileHash'
            AND length(run.metadata #>> '{autonomousAdmission,material,capability,snapshotId}') BETWEEN 1 AND 256
            )) OR (OLD.feature_reference_sha256 IS NOT NULL
              AND jsonb_typeof(run.metadata #> '{autonomousAdmission,material,capability}') = 'null'
              AND NOT (run.payload ? 'capabilityProfileId') AND NOT (run.payload ? 'capabilityProfileHash')
              AND NOT (run.metadata ? 'capabilityProfileId') AND NOT (run.metadata ? 'capabilityProfileHash')
              AND run.payload ->> 'featureReferenceSha256' = OLD.feature_reference_sha256
              AND EXISTS (SELECT 1 FROM chat_turn_feature_references feature_binding
                WHERE feature_binding.admission_id = OLD.admission_id
                  AND feature_binding.reference_sha256 = OLD.feature_reference_sha256
                  AND feature_binding.reference_sha256 = gc_sha256_text(gc_canonical_jsonb(feature_binding.references_json::jsonb))
                  AND feature_binding.references_json::jsonb #>> '{heartbeatOccurrence,ownerId}' = OLD.occurrence_id
                  AND feature_binding.references_json::jsonb #>> '{heartbeatOccurrence,revision}' = CAST(OLD.aggregate_revision AS TEXT)
                  AND feature_binding.references_json::jsonb #>> '{heartbeatOccurrence,sha256}' = OLD.claim_sha256)
            ))
$heartbeat_feature_replacement$;
BEGIN
  SELECT pg_get_functiondef('gc_heartbeat_occurrence_terminal_evidence_guard()'::regprocedure) INTO guard_sql;
  IF position(anchor_sql in guard_sql) = 0 OR (length(guard_sql) - length(replace(guard_sql, anchor_sql, ''))) <> length(anchor_sql) THEN
    RAISE EXCEPTION 'heartbeat terminal profile guard shape changed before migration';
  END IF;
  EXECUTE replace(guard_sql, anchor_sql, replacement_sql);
END;
$heartbeat_feature_terminal$;
`;

function upgradeHeartbeatTerminalGuard(name: string, sql: string): string {
  if (name !== "trg_chat_heartbeat_occurrences_terminal_evidence_guard" || sql.includes("OLD.feature_reference_sha256"))
    return sql;
  if (sql.split(HEARTBEAT_TERMINAL_PROFILE_ANCHOR).length !== 2)
    throw new Error("Heartbeat terminal profile guard shape changed before migration.");
  return sql.replace(HEARTBEAT_TERMINAL_PROFILE_ANCHOR, HEARTBEAT_TERMINAL_FEATURE_REPLACEMENT);
}
const HEARTBEAT_TERMINAL_PROFILE_ANCHOR = `        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileId')
          = json_extract(run.payload_json, '$.capabilityProfileId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileHash')
          = json_extract(run.payload_json, '$.capabilityProfileHash')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileId')
          = json_extract(run.metadata_json, '$.capabilityProfileId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileHash')
          = json_extract(run.metadata_json, '$.capabilityProfileHash')
        AND json_type(run.metadata_json, '$.autonomousAdmission.material.capability.snapshotId') = 'text'
        AND length(json_extract(run.metadata_json,
          '$.autonomousAdmission.material.capability.snapshotId')) BETWEEN 1 AND 256
`;
const HEARTBEAT_TERMINAL_FEATURE_REPLACEMENT = `        AND ((OLD.feature_reference_sha256 IS NULL AND (
          json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileId')
          = json_extract(run.payload_json, '$.capabilityProfileId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileHash')
          = json_extract(run.payload_json, '$.capabilityProfileHash')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileId')
          = json_extract(run.metadata_json, '$.capabilityProfileId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileHash')
          = json_extract(run.metadata_json, '$.capabilityProfileHash')
        AND json_type(run.metadata_json, '$.autonomousAdmission.material.capability.snapshotId') = 'text'
        AND length(json_extract(run.metadata_json,
          '$.autonomousAdmission.material.capability.snapshotId')) BETWEEN 1 AND 256
        )) OR (OLD.feature_reference_sha256 IS NOT NULL
          AND json_type(run.metadata_json, '$.autonomousAdmission.material.capability') = 'null'
          AND json_type(run.payload_json, '$.capabilityProfileId') IS NULL
          AND json_type(run.payload_json, '$.capabilityProfileHash') IS NULL
          AND json_type(run.metadata_json, '$.capabilityProfileId') IS NULL
          AND json_type(run.metadata_json, '$.capabilityProfileHash') IS NULL
          AND json_extract(run.payload_json, '$.featureReferenceSha256') = OLD.feature_reference_sha256
          AND EXISTS (SELECT 1 FROM chat_turn_feature_references feature_binding
            WHERE feature_binding.admission_id = OLD.admission_id
              AND feature_binding.reference_sha256 = OLD.feature_reference_sha256
              AND feature_binding.reference_sha256 = gc_sha256(gc_canonical_json(feature_binding.references_json))
              AND json_extract(feature_binding.references_json, '$.heartbeatOccurrence.ownerId') = OLD.occurrence_id
              AND json_extract(feature_binding.references_json, '$.heartbeatOccurrence.revision') = CAST(OLD.aggregate_revision AS TEXT)
              AND json_extract(feature_binding.references_json, '$.heartbeatOccurrence.sha256') = OLD.claim_sha256)
        ))
`;
