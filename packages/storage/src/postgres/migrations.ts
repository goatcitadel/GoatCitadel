/* eslint-disable max-lines -- Postgres migration ledger keeps every versioned migration in one append-only file so ordering, dependencies, and rollback context stay traceable. */
import { buildPostgresRuntimeSchemaSql } from "./runtime-schema.js";

export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_MIGRATIONS: PostgresMigration[] = [
  {
    version: 1,
    name: "runtime_event_and_cutover_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS transcript_events (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_sequence BIGINT NOT NULL,
        legacy_offset BIGINT,
        action_id TEXT,
        idempotency_key TEXT,
        session_key TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        token_input BIGINT,
        token_output BIGINT,
        cost_usd DOUBLE PRECISION,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, event_id),
        UNIQUE (session_id, event_sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_transcript_events_session_time
        ON transcript_events(session_id, occurred_at DESC, event_sequence DESC);

      CREATE TABLE IF NOT EXISTS audit_events (
        stream_name TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_sequence BIGINT NOT NULL,
        legacy_offset BIGINT,
        occurred_at TIMESTAMPTZ NOT NULL,
        actor_id TEXT,
        payload JSONB NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (stream_name, event_id),
        UNIQUE (stream_name, event_sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_stream_time
        ON audit_events(stream_name, occurred_at DESC, event_sequence DESC);

      CREATE TABLE IF NOT EXISTS background_job_leases (
        lease_key TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        fencing_token BIGINT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE INDEX IF NOT EXISTS idx_background_job_leases_expires_at
        ON background_job_leases(expires_at);

      CREATE TABLE IF NOT EXISTS database_cutover_runs (
        cutover_id TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ NOT NULL,
        runtime_flip_ready BOOLEAN NOT NULL DEFAULT FALSE,
        runtime_flip_blocked_reason TEXT,
        backup_id TEXT,
        source_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE INDEX IF NOT EXISTS idx_database_cutover_runs_started_at
        ON database_cutover_runs(started_at DESC);
    `,
  },
  {
    version: 2,
    name: "canonical_runtime_schema",
    sql: buildPostgresRuntimeSchemaSql(),
  },
  {
    version: 3,
    name: "runtime_schema_hardening",
    sql: `
      CREATE OR REPLACE FUNCTION gc_try_parse_jsonb(raw TEXT)
      RETURNS JSONB
      LANGUAGE plpgsql
      IMMUTABLE
      AS $$
      BEGIN
        IF raw IS NULL OR btrim(raw) = '' THEN
          RETURN NULL;
        END IF;
        RETURN raw::jsonb;
      EXCEPTION
        WHEN others THEN
          RETURN NULL;
      END;
      $$;

      CREATE OR REPLACE FUNCTION gc_try_parse_timestamptz(raw TEXT)
      RETURNS TIMESTAMPTZ
      LANGUAGE plpgsql
      IMMUTABLE
      AS $$
      BEGIN
        IF raw IS NULL OR btrim(raw) = '' THEN
          RETURN NULL;
        END IF;
        RETURN raw::timestamptz;
      EXCEPTION
        WHEN others THEN
          RETURN NULL;
      END;
      $$;

      CREATE OR REPLACE FUNCTION gc_try_parse_date(raw TEXT)
      RETURNS DATE
      LANGUAGE plpgsql
      IMMUTABLE
      AS $$
      BEGIN
        IF raw IS NULL OR btrim(raw) = '' THEN
          RETURN NULL;
        END IF;
        RETURN raw::date;
      EXCEPTION
        WHEN others THEN
          RETURN NULL;
      END;
      $$;

      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS routing_hints_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(routing_hints_json)) STORED,
        ADD COLUMN IF NOT EXISTS last_activity_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(last_activity_at)) STORED,
        ADD COLUMN IF NOT EXISTS updated_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(updated_at)) STORED;

      ALTER TABLE chat_messages
        ADD COLUMN IF NOT EXISTS parts_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(parts_json)) STORED,
        ADD COLUMN IF NOT EXISTS attachments_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(attachments_json)) STORED,
        ADD COLUMN IF NOT EXISTS timestamp_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz("timestamp")) STORED,
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED;

      ALTER TABLE approvals
        ADD COLUMN IF NOT EXISTS linkage_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(linkage_json)) STORED,
        ADD COLUMN IF NOT EXISTS payload_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(payload_json)) STORED,
        ADD COLUMN IF NOT EXISTS preview_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(preview_json)) STORED,
        ADD COLUMN IF NOT EXISTS explanation_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(explanation_json)) STORED,
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED,
        ADD COLUMN IF NOT EXISTS expires_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(expires_at)) STORED,
        ADD COLUMN IF NOT EXISTS resolved_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(resolved_at)) STORED;

      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS metadata_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(metadata_json)) STORED,
        ADD COLUMN IF NOT EXISTS due_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(due_at)) STORED,
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED,
        ADD COLUMN IF NOT EXISTS updated_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(updated_at)) STORED,
        ADD COLUMN IF NOT EXISTS deleted_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(deleted_at)) STORED;

      ALTER TABLE tool_grants
        ADD COLUMN IF NOT EXISTS constraints_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(constraints_json)) STORED,
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED,
        ADD COLUMN IF NOT EXISTS expires_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(expires_at)) STORED,
        ADD COLUMN IF NOT EXISTS revoked_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(revoked_at)) STORED;

      ALTER TABLE memory_items
        ADD COLUMN IF NOT EXISTS metadata_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(metadata_json)) STORED,
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED,
        ADD COLUMN IF NOT EXISTS updated_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(updated_at)) STORED,
        ADD COLUMN IF NOT EXISTS expires_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(expires_at)) STORED,
        ADD COLUMN IF NOT EXISTS forgotten_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(forgotten_at)) STORED;

      ALTER TABLE realtime_events
        ADD COLUMN IF NOT EXISTS payload_doc JSONB GENERATED ALWAYS AS (gc_try_parse_jsonb(payload_json)) STORED,
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED;

      ALTER TABLE realtime_stream_leases
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED,
        ADD COLUMN IF NOT EXISTS updated_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(updated_at)) STORED,
        ADD COLUMN IF NOT EXISTS last_heartbeat_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(last_heartbeat_at)) STORED,
        ADD COLUMN IF NOT EXISTS last_event_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(last_event_at)) STORED,
        ADD COLUMN IF NOT EXISTS closed_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(closed_at)) STORED;

      ALTER TABLE cost_ledger
        ADD COLUMN IF NOT EXISTS day_date DATE GENERATED ALWAYS AS (gc_try_parse_date(day)) STORED,
        ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ GENERATED ALWAYS AS (gc_try_parse_timestamptz(created_at)) STORED;

      CREATE INDEX IF NOT EXISTS idx_sessions_account_last_activity_at_ts
        ON sessions(account, last_activity_at_ts DESC)
        WHERE last_activity_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at_ts
        ON sessions(last_activity_at_ts DESC)
        WHERE last_activity_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_timestamp_ts
        ON chat_messages(session_id, timestamp_ts DESC, seq DESC)
        WHERE timestamp_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_approvals_status_created_at_ts
        ON approvals(status, created_at_ts DESC)
        WHERE created_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated_at_ts
        ON tasks(workspace_id, updated_at_ts DESC, task_id DESC)
        WHERE updated_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_tasks_due_at_ts
        ON tasks(due_at_ts ASC, task_id ASC)
        WHERE due_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_tool_grants_scope_expires_at_ts
        ON tool_grants(scope, scope_ref, expires_at_ts DESC)
        WHERE expires_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_memory_items_status_updated_at_ts
        ON memory_items(status, updated_at_ts DESC)
        WHERE updated_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_memory_items_expires_at_ts
        ON memory_items(expires_at_ts ASC)
        WHERE expires_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_realtime_events_created_at_ts
        ON realtime_events(created_at_ts DESC)
        WHERE created_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_heartbeat_ts
        ON realtime_stream_leases(stream_name, state, last_heartbeat_at_ts DESC)
        WHERE last_heartbeat_at_ts IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_cost_ledger_day_date
        ON cost_ledger(day_date DESC)
        WHERE day_date IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_cost_ledger_session_day_date
        ON cost_ledger(session_id, day_date DESC)
        WHERE day_date IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_sessions_routing_hints_doc_gin
        ON sessions USING gin (routing_hints_doc)
        WHERE routing_hints_doc IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_memory_items_metadata_doc_gin
        ON memory_items USING gin (metadata_doc)
        WHERE metadata_doc IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_realtime_events_payload_doc_gin
        ON realtime_events USING gin (payload_doc)
        WHERE payload_doc IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_approvals_payload_doc_gin
        ON approvals USING gin (payload_doc)
        WHERE payload_doc IS NOT NULL;
    `,
  },
  {
    version: 4,
    name: "chat_session_workbench_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_session_workbench (
        session_id TEXT PRIMARY KEY,
        project_id TEXT,
        base_ref TEXT,
        worktree_path TEXT,
        worktree_status TEXT NOT NULL DEFAULT 'uninitialized',
        active_file_path TEXT,
        diff_artifact_id TEXT,
        output_artifact_id TEXT,
        validation_status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES chat_projects(project_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_session_workbench_project
        ON chat_session_workbench(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_session_workbench_status
        ON chat_session_workbench(worktree_status, validation_status, updated_at DESC);
    `,
  },
  {
    version: 5,
    name: "sessions_session_key_unique_index",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key_unique
        ON sessions(session_key);
    `,
  },
  {
    version: 6,
    name: "runtime_inline_unique_indexes",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_role_id_unique ON agent_profiles(role_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_inbox_receiver_token ON approval_inbox_items(receiver_kind, receiver_id, token_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_device_requests_approval_id_unique ON auth_device_requests(approval_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversation_summaries_session_id_branch_head_turn_id_start_turn_id_end_turn_id_unique ON chat_conversation_summaries(session_id, branch_head_turn_id, start_turn_id, end_turn_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id_unique ON chat_messages(message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_stream_events_turn_sequence ON chat_stream_events(turn_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_context_manifests_turn_id_unique ON context_manifests(turn_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_runs_hook_idempotency ON hook_runs(hook_id, idempotency_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_context_packs_cache_key_unique ON memory_context_packs(cache_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_maintenance_runs_durable_run_id_unique ON memory_maintenance_runs(durable_run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_replication_log_source_node_id_idempotency_key_unique ON mesh_replication_log(source_node_id, idempotency_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_run_version ON prompt_pack_auto_scores_v2(run_id, scoring_schema_version, scorer_version, policy_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_tests_pack_code ON prompt_pack_tests(pack_id, code);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_events_sequence ON realtime_events(sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_action_tokens_token_hash_unique ON remote_action_tokens(token_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key_unique ON sessions(session_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug_unique ON workspaces(slug);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_wait_runs_run_id_unique ON approval_wait_runs(run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_device_grants_token_hash_unique ON auth_device_grants(token_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_device_grants_request_id_unique ON auth_device_grants(request_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_context_manifest_entries_manifest_id_kind_source_ref_content_hash_unique ON context_manifest_entries(manifest_id, kind, source_ref, content_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_dead_letters_run_id_unique ON durable_dead_letters(run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_retries_run_attempt ON durable_retries(run_id, attempt_no);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tools_cache_server_id_tool_name_unique ON mcp_tools_cache(server_id, tool_name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_subagent_sessions_agent_session_id_unique ON task_subagent_sessions(agent_session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_sessions_refresh_token_hash_unique ON companion_sessions(refresh_token_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_sessions_access_token_hash_unique ON companion_sessions(access_token_hash);
    `,
  },
  {
    version: 7,
    name: "canonical_runtime_schema_repairs",
    sql: `
      CREATE TABLE IF NOT EXISTS approval_effects (
        effect_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        effect_kind TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        detail TEXT,
        attempt_count BIGINT NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL DEFAULT '{}',
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE CASCADE
      );

      ALTER TABLE durable_runs
        ADD COLUMN IF NOT EXISTS lease_owner_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_expires_at TEXT,
        ADD COLUMN IF NOT EXISTS lease_heartbeat_at TEXT,
        ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

      CREATE INDEX IF NOT EXISTS idx_durable_runs_status_lease_updated
        ON durable_runs(status, lease_expires_at, updated_at DESC);

      ALTER TABLE approval_effects
        ADD COLUMN IF NOT EXISTS target_kind TEXT,
        ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
        ADD COLUMN IF NOT EXISTS payload_json TEXT NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS result_json TEXT NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS claimed_by TEXT,
        ADD COLUMN IF NOT EXISTS claimed_at TEXT,
        ADD COLUMN IF NOT EXISTS lease_expires_at TEXT,
        ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

      UPDATE approval_effects
      SET effect_kind = 'approval_wait_wake'
      WHERE effect_kind = 'wake_durable_run';

      UPDATE approval_effects
      SET target_kind = COALESCE(NULLIF(target_kind, ''), 'durable_run');

      UPDATE approval_effects
      SET idempotency_key = approval_id || ':' || effect_kind || ':' || COALESCE(target_kind, 'durable_run') || ':' || target_id
      WHERE idempotency_key IS NULL OR BTRIM(idempotency_key) = '';

      UPDATE approval_effects
      SET payload_json = COALESCE(NULLIF(payload_json, ''), '{}')
      WHERE payload_json IS NULL OR BTRIM(payload_json) = '';

      UPDATE approval_effects
      SET result_json = COALESCE(NULLIF(result_json, ''), COALESCE(NULLIF(details_json, ''), '{}'))
      WHERE result_json IS NULL OR BTRIM(result_json) = '';

      UPDATE approval_effects
      SET version = 1
      WHERE version IS NULL OR version < 1;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_effects_idempotency
        ON approval_effects(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_approval_effects_lookup
        ON approval_effects(approval_id, effect_kind, target_kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_approval_effects_approval_created
        ON approval_effects(approval_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_approval_effects_status_lease_updated
        ON approval_effects(status, lease_expires_at, updated_at DESC);

      ${buildPostgresRuntimeSchemaSql()}
    `,
  },
  {
    version: 8,
    name: "prompt_pack_benchmark_claim_repairs",
    sql: `
      ALTER TABLE prompt_pack_benchmark_runs
        ADD COLUMN IF NOT EXISTS claimed_by_worker_id TEXT,
        ADD COLUMN IF NOT EXISTS claim_heartbeat_at TEXT,
        ADD COLUMN IF NOT EXISTS claim_expires_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_claim
        ON prompt_pack_benchmark_runs(status, claim_expires_at, started_at ASC);
    `,
  },
  {
    version: 9,
    name: "orchestration_execution_ownership_schema",
    sql: `
      ALTER TABLE orchestration_runs
        ADD COLUMN IF NOT EXISTS workspace_id TEXT,
        ADD COLUMN IF NOT EXISTS durable_run_id TEXT,
        ADD COLUMN IF NOT EXISTS execution_state TEXT,
        ADD COLUMN IF NOT EXISTS worktree_path TEXT,
        ADD COLUMN IF NOT EXISTS worktree_status TEXT,
        ADD COLUMN IF NOT EXISTS worktree_base_ref TEXT,
        ADD COLUMN IF NOT EXISTS pending_approval_phase_id TEXT,
        ADD COLUMN IF NOT EXISTS pending_approved_by TEXT,
        ADD COLUMN IF NOT EXISTS pending_cost_increment_usd DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS last_error TEXT;

      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_durable_run_id
        ON orchestration_runs(durable_run_id);
    `,
  },
  {
    version: 10,
    name: "chat_user_input_prompt_repairs",
    sql: `
      ALTER TABLE chat_turn_traces
        ADD COLUMN IF NOT EXISTS pending_user_input_json TEXT;
    `,
  },
  {
    version: 11,
    name: "mutation_idempotency_runtime_repairs",
    sql: `
      CREATE TABLE IF NOT EXISTS mutation_idempotency (
        method TEXT NOT NULL,
        route_path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_scope TEXT NOT NULL DEFAULT '',
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (method, route_path, idempotency_key, actor_scope)
      );

      CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_updated
        ON mutation_idempotency(updated_at DESC);
    `,
  },
  {
    version: 12,
    name: "prompt_pack_runs_shape_repairs",
    sql: `
      ALTER TABLE prompt_pack_runs
        ADD COLUMN IF NOT EXISTS mode TEXT,
        ADD COLUMN IF NOT EXISTS tool_tier TEXT,
        ADD COLUMN IF NOT EXISTS tool_autonomy TEXT,
        ADD COLUMN IF NOT EXISTS web_mode TEXT,
        ADD COLUMN IF NOT EXISTS memory_mode TEXT,
        ADD COLUMN IF NOT EXISTS thinking_level TEXT,
        ADD COLUMN IF NOT EXISTS derived_response_text TEXT,
        ADD COLUMN IF NOT EXISTS derived_response_signals_json TEXT,
        ADD COLUMN IF NOT EXISTS integrity_json TEXT;
    `,
  },
  {
    version: 13,
    name: "chat_turn_trace_shape_repairs",
    sql: `
      ALTER TABLE chat_turn_traces
        ADD COLUMN IF NOT EXISTS orchestration_json TEXT,
        ADD COLUMN IF NOT EXISTS guidance_json TEXT,
        ADD COLUMN IF NOT EXISTS loop_guard_json TEXT,
        ADD COLUMN IF NOT EXISTS capability_upgrade_suggestions_json TEXT,
        ADD COLUMN IF NOT EXISTS specialist_candidate_suggestions_json TEXT;
    `,
  },
  {
    version: 14,
    name: "chat_tool_and_delegation_shape_repairs",
    sql: `
      ALTER TABLE chat_tool_runs
        ADD COLUMN IF NOT EXISTS reused BIGINT,
        ADD COLUMN IF NOT EXISTS reused_from_tool_run_id TEXT,
        ADD COLUMN IF NOT EXISTS reuse_reason TEXT;

      ALTER TABLE chat_delegation_steps
        ADD COLUMN IF NOT EXISTS label TEXT,
        ADD COLUMN IF NOT EXISTS durable_run_id TEXT;
    `,
  },
  {
    version: 15,
    name: "chat_execution_plan_step_shape_repairs",
    sql: `
      ALTER TABLE chat_execution_plan_steps
        ADD COLUMN IF NOT EXISTS durable_run_id TEXT;
    `,
  },
  {
    version: 16,
    name: "cron_jobs_action_description_end_at",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'task',
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS end_at TEXT;

      UPDATE cron_jobs
      SET action = CASE job_id
        WHEN 'self_improvement_weekly_replay' THEN 'improvement'
        WHEN 'improvement_weekly' THEN 'improvement'
        WHEN 'private_beta_backup_daily' THEN 'backup'
        WHEN 'memory-flush-daily' THEN 'memory_flush'
        WHEN 'cost-report-hourly' THEN 'cost_report'
        WHEN 'update-review-daily' THEN 'update_review'
        ELSE COALESCE(NULLIF(action, ''), 'task')
      END
      WHERE action IS NULL OR BTRIM(action) = '' OR action = 'task';
    `,
  },
  {
    version: 17,
    name: "chat_session_and_agent_refresh_repairs",
    sql: `
      ALTER TABLE agent_profiles
        ADD COLUMN IF NOT EXISTS preset_defaults_json TEXT;

      ALTER TABLE chat_session_meta
        ADD COLUMN IF NOT EXISTS folder_id TEXT,
        ADD COLUMN IF NOT EXISTS folder_name TEXT,
        ADD COLUMN IF NOT EXISTS tags_json TEXT NOT NULL DEFAULT '[]';

      UPDATE chat_session_meta
      SET tags_json = '[]'
      WHERE tags_json IS NULL OR BTRIM(tags_json) = '';

      CREATE INDEX IF NOT EXISTS idx_chat_session_meta_folder
        ON chat_session_meta(workspace_id, folder_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_generated_artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT,
        turn_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        language TEXT,
        source_surface TEXT NOT NULL,
        version BIGINT NOT NULL,
        supersedes_artifact_id TEXT,
        provider_id TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_session_created
        ON chat_generated_artifacts(session_id, created_at DESC, version DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_turn_created
        ON chat_generated_artifacts(turn_id, version DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_workspace_created
        ON chat_generated_artifacts(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_surface_kind_created
        ON chat_generated_artifacts(source_surface, kind, created_at DESC);

      CREATE TABLE IF NOT EXISTS chat_thread_knowledge_attachments (
        attachment_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        retrieval_mode TEXT NOT NULL,
        ingest_status TEXT NOT NULL,
        chunk_count BIGINT,
        namespace TEXT,
        chat_attachment_id TEXT,
        document_id TEXT,
        error_message TEXT,
        last_ingest_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_session_created
        ON chat_thread_knowledge_attachments(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_session_mode
        ON chat_thread_knowledge_attachments(session_id, retrieval_mode, ingest_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_document
        ON chat_thread_knowledge_attachments(document_id, updated_at DESC);
    `,
  },
  {
    version: 18,
    name: "generated_artifact_provenance_repairs",
    sql: `
      ALTER TABLE chat_generated_artifacts
        ADD COLUMN IF NOT EXISTS source_block_index BIGINT,
        ADD COLUMN IF NOT EXISTS content_hash TEXT;
    `,
  },
  {
    version: 19,
    name: "imported_agent_catalog_schema_repairs",
    sql: `
      CREATE TABLE IF NOT EXISTS imported_agent_catalog (
        entry_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        division TEXT NOT NULL,
        state TEXT NOT NULL,
        definition_id TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        raw_markdown TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        section_order_json TEXT NOT NULL,
        section_map_json TEXT NOT NULL,
        parse_status TEXT NOT NULL,
        parse_warnings_json TEXT NOT NULL,
        provenance_provider TEXT NOT NULL,
        provenance_repo_url TEXT,
        provenance_ref TEXT,
        provenance_commit TEXT,
        provenance_path TEXT NOT NULL,
        provenance_sha256 TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        retired_at TEXT,
        search_text TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace
        ON imported_agent_catalog(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_division
        ON imported_agent_catalog(workspace_id, division, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_state
        ON imported_agent_catalog(workspace_id, state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_parse
        ON imported_agent_catalog(workspace_id, parse_status, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_agent_catalog_source_path
        ON imported_agent_catalog(workspace_id, provenance_provider, COALESCE(provenance_repo_url, ''), provenance_path);
    `,
  },
  {
    version: 20,
    name: "chat_image_route_preference_repairs",
    sql: `
      ALTER TABLE chat_session_prefs
        ADD COLUMN IF NOT EXISTS image_provider_id TEXT,
        ADD COLUMN IF NOT EXISTS image_model TEXT;
    `,
  },
  {
    version: 21,
    name: "prompt_pack_agentic_diagnostics_repairs",
    sql: `
      ALTER TABLE prompt_pack_tests
        ADD COLUMN IF NOT EXISTS diagnostic_metadata_json TEXT;

      ALTER TABLE prompt_pack_runs
        ADD COLUMN IF NOT EXISTS execution_style TEXT,
        ADD COLUMN IF NOT EXISTS diagnostic_metadata_json TEXT;

      ALTER TABLE prompt_pack_benchmark_runs
        ADD COLUMN IF NOT EXISTS execution_style TEXT;
    `,
  },
  {
    version: 22,
    name: "prompt_pack_benchmark_item_unique_repairs",
    sql: `
      WITH ranked_benchmark_items AS (
        SELECT
          ctid,
          ROW_NUMBER() OVER (
            PARTITION BY benchmark_run_id, provider_id, model, test_id
            ORDER BY
              CASE WHEN auto_score_id IS NOT NULL THEN 0 ELSE 1 END,
              CASE WHEN run_id IS NOT NULL THEN 0 ELSE 1 END,
              created_at DESC,
              item_id DESC
          ) AS row_rank
        FROM prompt_pack_benchmark_items
      )
      DELETE FROM prompt_pack_benchmark_items AS item
      USING ranked_benchmark_items AS ranked
      WHERE item.ctid = ranked.ctid
        AND ranked.row_rank > 1;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_unique
        ON prompt_pack_benchmark_items(benchmark_run_id, provider_id, model, test_id);
    `,
  },
  {
    version: 23,
    name: "pending_approval_action_expiry_and_trace_index_parity",
    sql: `
      ALTER TABLE pending_approval_actions
        ADD COLUMN IF NOT EXISTS expires_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session_status
        ON chat_turn_traces(session_id, status, started_at DESC);
    `,
  },
  {
    version: 24,
    name: "chat_delegation_step_current_shape_repairs",
    sql: `
      ALTER TABLE chat_delegation_steps
        ADD COLUMN IF NOT EXISTS label TEXT,
        ADD COLUMN IF NOT EXISTS provider_id TEXT,
        ADD COLUMN IF NOT EXISTS model TEXT,
        ADD COLUMN IF NOT EXISTS summary TEXT,
        ADD COLUMN IF NOT EXISTS output TEXT,
        ADD COLUMN IF NOT EXISTS error TEXT,
        ADD COLUMN IF NOT EXISTS failure_guidance TEXT,
        ADD COLUMN IF NOT EXISTS durable_run_id TEXT,
        ADD COLUMN IF NOT EXISTS child_session_id TEXT,
        ADD COLUMN IF NOT EXISTS child_turn_id TEXT,
        ADD COLUMN IF NOT EXISTS citations_json TEXT;
    `,
  },
  {
    version: 25,
    name: "runtime_evidence_envelopes",
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_evidence_envelopes (
        envelope_id TEXT PRIMARY KEY,
        event_kind TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        run_id TEXT,
        approval_id TEXT,
        content_hash TEXT NOT NULL,
        previous_envelope_hash TEXT,
        payload_hash TEXT NOT NULL,
        tool_call_hashes_json TEXT NOT NULL DEFAULT '[]',
        memory_lineage_json TEXT NOT NULL DEFAULT '[]',
        policy_hash TEXT,
        signature_status TEXT NOT NULL,
        signature TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_evidence_session_created
        ON runtime_evidence_envelopes(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_evidence_turn_created
        ON runtime_evidence_envelopes(turn_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_evidence_run_created
        ON runtime_evidence_envelopes(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_evidence_kind_created
        ON runtime_evidence_envelopes(event_kind, created_at DESC);
    `,
  },
  {
    version: 26,
    name: "skill_evaluation_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS skill_evaluation_runs (
        run_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        status TEXT NOT NULL,
        target_pass_rate DOUBLE PRECISION NOT NULL,
        max_rounds INTEGER NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0,
        improvement_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
        proposal_id TEXT,
        improvement_candidate_id TEXT,
        ledger_signal_id TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_skill_updated
        ON skill_evaluation_runs(skill_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_status_updated
        ON skill_evaluation_runs(status, updated_at DESC);
    `,
  },
  // v27 intentionally repeats the idempotent skill migration. A short-lived
  // faulty sequence applied this version before the chat prefs repair moved
  // to v28, so keeping this tuple avoids turning repaired runtimes into
  // permanent health-drift false positives.
  {
    version: 27,
    name: "skill_evaluation_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS skill_evaluation_runs (
        run_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        status TEXT NOT NULL,
        target_pass_rate DOUBLE PRECISION NOT NULL,
        max_rounds INTEGER NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0,
        improvement_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
        proposal_id TEXT,
        improvement_candidate_id TEXT,
        ledger_signal_id TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_skill_updated
        ON skill_evaluation_runs(skill_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_status_updated
        ON skill_evaluation_runs(status, updated_at DESC);
    `,
  },
  {
    version: 28,
    name: "chat_operator_control_prefs",
    sql: `
      ALTER TABLE chat_session_prefs
        ADD COLUMN IF NOT EXISTS speed_mode TEXT DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS subagent_policy TEXT DEFAULT 'ask_when_useful';
    `,
  },
  {
    version: 29,
    name: "agentic_runtime_task_metadata",
    sql: `
      ALTER TABLE task_subagent_sessions
        ADD COLUMN IF NOT EXISTS metadata_json TEXT;

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status_updated
        ON tasks(workspace_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_agent_status_updated
        ON task_subagent_sessions(agent_session_id, status, updated_at DESC);
    `,
  },
  {
    version: 30,
    name: "comms_delivery_runtime_metadata",
    sql: `
      ALTER TABLE comms_deliveries
        ADD COLUMN IF NOT EXISTS payload_json TEXT,
        ADD COLUMN IF NOT EXISTS delivery_status TEXT,
        ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
        ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
        ADD COLUMN IF NOT EXISTS next_attempt_at TEXT,
        ADD COLUMN IF NOT EXISTS stale_after_ms INTEGER,
        ADD COLUMN IF NOT EXISTS base_backoff_ms INTEGER,
        ADD COLUMN IF NOT EXISTS max_backoff_ms INTEGER,
        ADD COLUMN IF NOT EXISTS stale_reason TEXT;

      UPDATE comms_deliveries
      SET delivery_status = CASE status
        WHEN 'sent' THEN 'sent'
        WHEN 'failed' THEN COALESCE(NULLIF(delivery_status, ''), 'degraded')
        ELSE COALESCE(NULLIF(delivery_status, ''), 'retrying')
      END
      WHERE delivery_status IS NULL OR BTRIM(delivery_status) = '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_deliveries_idempotency
        ON comms_deliveries(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_comms_deliveries_due
        ON comms_deliveries(status, next_attempt_at, created_at);
    `,
  },
  {
    version: 31,
    name: "cron_jobs_action_config",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS action_config_json TEXT;
    `,
  },
  {
    version: 32,
    name: "state_validation_quarantine",
    sql: `
      CREATE TABLE IF NOT EXISTS state_validation_quarantine (
        quarantine_id TEXT PRIMARY KEY,
        store TEXT NOT NULL,
        row_id TEXT NOT NULL,
        raw_value TEXT,
        schema_error TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed
        ON state_validation_quarantine(store, observed_at DESC);
    `,
  },
  {
    version: 33,
    name: "cron_jobs_workdir_context_from_run_output_run_id",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS workdir TEXT,
        ADD COLUMN IF NOT EXISTS context_from TEXT,
        ADD COLUMN IF NOT EXISTS last_run_output TEXT,
        ADD COLUMN IF NOT EXISTS last_run_id TEXT;
    `,
  },
  {
    version: 34,
    name: "chat_session_meta_goal",
    sql: `
      ALTER TABLE chat_session_meta
        ADD COLUMN IF NOT EXISTS pinned_goal TEXT,
        ADD COLUMN IF NOT EXISTS goal_turn_budget INTEGER,
        ADD COLUMN IF NOT EXISTS goal_turns_used INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS goal_set_at TEXT;
    `,
  },
  {
    version: 35,
    name: "chat_messages_steer_audit",
    sql: `
      ALTER TABLE chat_messages
        ADD COLUMN IF NOT EXISTS steered INTEGER,
        ADD COLUMN IF NOT EXISTS parent_delegation_step_id TEXT;
    `,
  },
  {
    version: 36,
    name: "task_kanban_columns",
    sql: `
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS distress_signals_json TEXT,
        ADD COLUMN IF NOT EXISTS retry_budget_json TEXT,
        ADD COLUMN IF NOT EXISTS artifact_verification_json TEXT;
    `,
  },
  {
    version: 37,
    name: "approval_shell_explanations",
    sql: `
      ALTER TABLE approvals
        ADD COLUMN IF NOT EXISTS shell_explanations_json TEXT;
    `,
  },
  {
    version: 38,
    name: "permission_profiles_and_override_context",
    sql: `
      CREATE TABLE IF NOT EXISTS permission_profiles (
        profile_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        builtin INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_ref TEXT,
        approval_mode TEXT NOT NULL,
        legacy_tool_profile TEXT,
        tool_patterns_json TEXT NOT NULL,
        allow_json TEXT NOT NULL,
        deny_json TEXT NOT NULL,
        read_access_mode TEXT,
        default_for_surfaces_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_permission_profiles_scope_status
        ON permission_profiles(scope, scope_ref, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS permission_profile_activations (
        activation_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        operator_id TEXT,
        workspace_id TEXT,
        session_id TEXT,
        surface TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_permission_profile_activations_lookup
        ON permission_profile_activations(active, operator_id, workspace_id, session_id, surface, updated_at DESC);

      CREATE TABLE IF NOT EXISTS local_operator_overrides (
        override_id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_ref TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_local_operator_overrides_active
        ON local_operator_overrides(status, operator_id, scope, scope_ref, expires_at DESC);

      ALTER TABLE tool_access_decisions
        ADD COLUMN IF NOT EXISTS workspace_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS local_operator_override_id TEXT;

      ALTER TABLE code_mode_runs
        ADD COLUMN IF NOT EXISTS origin_surface TEXT,
        ADD COLUMN IF NOT EXISTS workspace_id TEXT,
        ADD COLUMN IF NOT EXISTS operator_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_label TEXT,
        ADD COLUMN IF NOT EXISTS local_operator_override_id TEXT,
        ADD COLUMN IF NOT EXISTS code_mode_input_hash TEXT;

      ALTER TABLE local_operator_overrides
        ADD COLUMN IF NOT EXISTS revoked_by TEXT;
    `,
  },
  {
    version: 39,
    name: "permission_actor_and_code_mode_run_ledger_repairs",
    sql: `
      ALTER TABLE tool_grants
        ADD COLUMN IF NOT EXISTS revoked_by TEXT;

      ALTER TABLE code_mode_runs
        ADD COLUMN IF NOT EXISTS origin_surface TEXT,
        ADD COLUMN IF NOT EXISTS workspace_id TEXT,
        ADD COLUMN IF NOT EXISTS operator_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_label TEXT,
        ADD COLUMN IF NOT EXISTS local_operator_override_id TEXT,
        ADD COLUMN IF NOT EXISTS code_mode_input_hash TEXT;
    `,
  },
  {
    version: 40,
    name: "tool_access_decision_run_lineage",
    sql: `
      ALTER TABLE IF EXISTS tool_access_decisions
        ADD COLUMN IF NOT EXISTS run_id TEXT;

      DO $$
      BEGIN
        IF to_regclass('public.tool_access_decisions') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_run_time
            ON tool_access_decisions(run_id, timestamp DESC);
        END IF;
      END $$;
    `,
  },
  {
    version: 41,
    name: "tool_access_decision_countable_usage",
    sql: `
      ALTER TABLE IF EXISTS tool_access_decisions
        ADD COLUMN IF NOT EXISTS counts_toward_limits INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 42,
    name: "tool_invocation_permission_evidence",
    sql: `
      ALTER TABLE IF EXISTS tool_invocations
        ADD COLUMN IF NOT EXISTS run_id TEXT,
        ADD COLUMN IF NOT EXISTS matched_grant_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS local_operator_override_id TEXT,
        ADD COLUMN IF NOT EXISTS approval_mode TEXT,
        ADD COLUMN IF NOT EXISTS reason_codes_json TEXT;

      ALTER TABLE IF EXISTS policy_blocks
        ADD COLUMN IF NOT EXISTS task_id TEXT,
        ADD COLUMN IF NOT EXISTS run_id TEXT,
        ADD COLUMN IF NOT EXISTS matched_grant_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS local_operator_override_id TEXT,
        ADD COLUMN IF NOT EXISTS approval_mode TEXT,
        ADD COLUMN IF NOT EXISTS reason_codes_json TEXT;
    `,
  },
  {
    version: 43,
    name: "code_mode_structured_error_evidence",
    sql: `
      ALTER TABLE IF EXISTS code_mode_runs
        ADD COLUMN IF NOT EXISTS error_code TEXT,
        ADD COLUMN IF NOT EXISTS error_details_json TEXT;
    `,
  },
  {
    version: 44,
    name: "code_mode_run_sandbox_schema_parity",
    sql: `
      CREATE TABLE IF NOT EXISTS code_mode_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        language TEXT NOT NULL,
        origin_surface TEXT,
        workspace_id TEXT,
        operator_id TEXT,
        permission_profile_id TEXT,
        permission_profile_label TEXT,
        local_operator_override_id TEXT,
        requested_output_intent TEXT,
        save_candidate_on_success INTEGER NOT NULL DEFAULT 0,
        capability_snapshot_id TEXT NOT NULL,
        code_mode_input_hash TEXT,
        wrapper_manifest_hash TEXT NOT NULL,
        policy_snapshot_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        approval_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        sandbox_json TEXT,
        code_artifact_json TEXT NOT NULL,
        wrapper_manifest_artifact_json TEXT NOT NULL,
        policy_snapshot_artifact_json TEXT NOT NULL,
        stdout_artifact_json TEXT,
        stderr_artifact_json TEXT,
        stdout_preview TEXT,
        stderr_preview TEXT,
        stdout_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_truncated INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_text TEXT,
        error_code TEXT,
        error_details_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      ALTER TABLE IF EXISTS code_mode_runs
        ADD COLUMN IF NOT EXISTS origin_surface TEXT,
        ADD COLUMN IF NOT EXISTS workspace_id TEXT,
        ADD COLUMN IF NOT EXISTS operator_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_label TEXT,
        ADD COLUMN IF NOT EXISTS local_operator_override_id TEXT,
        ADD COLUMN IF NOT EXISTS code_mode_input_hash TEXT,
        ADD COLUMN IF NOT EXISTS sandbox_json TEXT,
        ADD COLUMN IF NOT EXISTS error_code TEXT,
        ADD COLUMN IF NOT EXISTS error_details_json TEXT;

      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_status_created
        ON code_mode_runs(status, created_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_created
        ON code_mode_runs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_approval
        ON code_mode_runs(approval_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_workspace_status_created
        ON code_mode_runs(workspace_id, status, created_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_status_created
        ON code_mode_runs(session_id, status, created_at DESC, run_id DESC);
    `,
  },
  {
    version: 45,
    name: "orchestration_run_policy_context",
    sql: `
      ALTER TABLE IF EXISTS orchestration_runs
        ADD COLUMN IF NOT EXISTS operator_id TEXT,
        ADD COLUMN IF NOT EXISTS auth_actor_id TEXT,
        ADD COLUMN IF NOT EXISTS auth_actor_source TEXT,
        ADD COLUMN IF NOT EXISTS permission_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS local_operator_override_id TEXT;
    `,
  },
  {
    version: 46,
    name: "orchestration_plan_workspace_scope",
    sql: `
      ALTER TABLE IF EXISTS orchestration_plans
        ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'default';

      DO $$
      DECLARE
        current_pk TEXT[];
        current_pk_name TEXT;
      BEGIN
        IF to_regclass('orchestration_plans') IS NULL THEN
          RETURN;
        END IF;

        SELECT constraint_name
        INTO current_pk_name
        FROM information_schema.table_constraints
        WHERE table_schema = current_schema()
          AND table_name = 'orchestration_plans'
          AND constraint_type = 'PRIMARY KEY'
        LIMIT 1;

        SELECT array_agg(kcu.column_name::TEXT ORDER BY kcu.ordinal_position)
        INTO current_pk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'orchestration_plans'
          AND tc.constraint_type = 'PRIMARY KEY';

        UPDATE orchestration_plans
        SET workspace_id = 'default'
        WHERE workspace_id IS NULL
          OR BTRIM(workspace_id) = '';

        ALTER TABLE orchestration_plans
          ALTER COLUMN workspace_id SET DEFAULT 'default',
          ALTER COLUMN workspace_id SET NOT NULL;

        IF current_pk IS DISTINCT FROM ARRAY['plan_id', 'workspace_id']::TEXT[] THEN
          IF current_pk_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE orchestration_plans DROP CONSTRAINT %I', current_pk_name);
          END IF;
        END IF;

        IF to_regclass('orchestration_runs') IS NOT NULL THEN
          INSERT INTO orchestration_plans (
            plan_id,
            workspace_id,
            plan_json,
            created_at,
            updated_at
          )
          SELECT
            plan.plan_id,
            run_workspace.workspace_id,
            plan.plan_json,
            plan.created_at,
            plan.updated_at
          FROM orchestration_plans plan
          INNER JOIN (
            SELECT DISTINCT
              plan_id,
              COALESCE(NULLIF(BTRIM(workspace_id), ''), 'default') AS workspace_id
            FROM orchestration_runs
            WHERE plan_id IS NOT NULL
              AND COALESCE(NULLIF(BTRIM(workspace_id), ''), 'default') <> 'default'
          ) run_workspace
            ON run_workspace.plan_id = plan.plan_id
          WHERE COALESCE(NULLIF(BTRIM(plan.workspace_id), ''), 'default') = 'default'
            AND NOT EXISTS (
              SELECT 1
              FROM orchestration_plans existing
              WHERE existing.plan_id = plan.plan_id
                AND COALESCE(NULLIF(BTRIM(existing.workspace_id), ''), 'default') = run_workspace.workspace_id
            );
        END IF;

        IF current_pk IS DISTINCT FROM ARRAY['plan_id', 'workspace_id']::TEXT[] THEN
          ALTER TABLE orchestration_plans
            ADD PRIMARY KEY (plan_id, workspace_id);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_orchestration_plans_workspace
        ON orchestration_plans(workspace_id, updated_at DESC);
    `,
  },
  {
    version: 47,
    name: "state_validation_quarantine_history_repair",
    sql: `
      CREATE TABLE IF NOT EXISTS state_validation_quarantine (
        quarantine_id TEXT PRIMARY KEY,
        store TEXT NOT NULL,
        row_id TEXT NOT NULL,
        raw_value TEXT,
        schema_error TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed
        ON state_validation_quarantine(store, observed_at DESC);

      UPDATE schema_migrations
      SET name = 'state_validation_quarantine'
      WHERE version = 32
        AND name = 'cron_jobs_workdir_and_context_from';

      UPDATE schema_migrations
      SET name = 'cron_jobs_workdir_context_from_run_output_run_id'
      WHERE version = 33
        AND name = 'cron_jobs_last_run_output_and_run_id';
    `,
  },
  {
    version: 48,
    name: "code_mode_run_status_listing_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_status_created
        ON code_mode_runs(status, created_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_workspace_status_created
        ON code_mode_runs(workspace_id, status, created_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_status_created
        ON code_mode_runs(session_id, status, created_at DESC, run_id DESC);
    `,
  },
  {
    version: 49,
    name: "structured_memory_decision_journal_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_entities (
        entity_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        source_refs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        authority TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        forgotten_at TEXT,
        superseded_by_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_entities_workspace_status
        ON memory_entities(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entities_type
        ON memory_entities(entity_type, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_relations (
        relation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        source_refs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        authority TEXT NOT NULL,
        degraded_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        forgotten_at TEXT,
        superseded_by_id TEXT,
        FOREIGN KEY(from_entity_id) REFERENCES memory_entities(entity_id) ON DELETE RESTRICT,
        FOREIGN KEY(to_entity_id) REFERENCES memory_entities(entity_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_relations_workspace_status
        ON memory_relations(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_relations_entities
        ON memory_relations(from_entity_id, to_entity_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_decisions (
        decision_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        decision_text TEXT NOT NULL,
        alternatives_json TEXT NOT NULL,
        rationale TEXT NOT NULL,
        expected_outcome TEXT,
        review_at TEXT,
        retrospective_json TEXT,
        linked_entity_ids_json TEXT NOT NULL,
        linked_relation_ids_json TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        improvement_candidate_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        source_refs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        authority TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        forgotten_at TEXT,
        superseded_by_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_decisions_workspace_status
        ON memory_decisions(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_decisions_review_at
        ON memory_decisions(review_at, status);
      CREATE INDEX IF NOT EXISTS idx_memory_decisions_session
        ON memory_decisions(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_structured_change_history (
        change_id TEXT PRIMARY KEY,
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        change_type TEXT NOT NULL,
        actor_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_structured_history_record
        ON memory_structured_change_history(record_kind, record_id, created_at DESC);
    `,
  },
  {
    version: 50,
    name: "chat_session_workbench_package_manager",
    sql: `
      ALTER TABLE chat_session_workbench
        ADD COLUMN IF NOT EXISTS package_manager TEXT;
    `,
  },
  {
    version: 51,
    name: "chat_generated_artifacts_project_scope",
    sql: `
      ALTER TABLE chat_generated_artifacts
        ADD COLUMN IF NOT EXISTS project_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_project_created
        ON chat_generated_artifacts(project_id, created_at DESC);
    `,
  },
  {
    version: 52,
    name: "chat_generated_artifacts_project_scope_backfill",
    sql: `
      UPDATE chat_generated_artifacts AS artifacts
      SET project_id = projects.project_id
      FROM chat_session_projects AS projects
      WHERE artifacts.session_id = projects.session_id
        AND artifacts.project_id IS NULL;
    `,
  },
  {
    version: 53,
    name: "orchestration_runs_wave_budget_accumulator",
    sql: `
      ALTER TABLE IF EXISTS orchestration_runs
        ADD COLUMN IF NOT EXISTS wave_cost_usd_by_wave_id TEXT,
        ADD COLUMN IF NOT EXISTS stop_reason TEXT;
    `,
  },
  {
    version: 54,
    name: "llm_runtime_measurement_and_eval_proof",
    sql: `
      CREATE TABLE IF NOT EXISTS llm_runtime_measurements (
        measurement_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        engine_kind TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        stream BOOLEAN NOT NULL DEFAULT FALSE,
        session_id TEXT,
        task_id TEXT,
        run_id TEXT,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        error_text TEXT,
        collected_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_provider_model_collected
        ON llm_runtime_measurements(provider_id, model, collected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_session
        ON llm_runtime_measurements(session_id, collected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_source_status
        ON llm_runtime_measurements(source, status, collected_at DESC);

      CREATE TABLE IF NOT EXISTS llm_eval_proof_runs (
        run_id TEXT PRIMARY KEY,
        prompt_hash TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        status TEXT NOT NULL,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        results_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_llm_eval_proof_runs_created
        ON llm_eval_proof_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_eval_proof_runs_session
        ON llm_eval_proof_runs(session_id, created_at DESC);
    `,
  },
  {
    version: 55,
    name: "chat_side_chats",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_side_chats (
        side_chat_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        created_from_surface TEXT NOT NULL DEFAULT 'chat',
        source_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_side_chats_workspace_parent
        ON chat_side_chats(workspace_id, parent_session_id);
    `,
  },
];
