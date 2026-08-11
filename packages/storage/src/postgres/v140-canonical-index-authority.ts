/* eslint-disable max-lines -- v140 freezes the exact final Postgres catalog repair ledger in one reviewable owner. */

interface CanonicalOrderedIndexKey {
  column: string;
  direction?: "DESC";
}

interface CanonicalOrderedIndexSpec {
  name: string;
  tableName: string;
  keys: readonly CanonicalOrderedIndexKey[];
  predicateNotNullColumn?: string;
}

// FROZEN WITH POSTGRES V140. Dynamic-v2 keeps its immutable SQLite-owner
// provenance; this forward ledger repairs the PostgreSQL index order that the
// historical SQLite blueprint could not preserve. Any later correction must be
// a new migration.
const POSTGRES_V140_ORDERED_INDEX_SPECS = [
  {
    name: "idx_a2a_task_bindings_context_peer",
    tableName: "a2a_task_bindings",
    keys: [
      {
        column: "peer_id",
      },
      {
        column: "context_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_a2a_task_push_configs_peer_updated",
    tableName: "a2a_task_push_configs",
    keys: [
      {
        column: "peer_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_approvals_status_created_at_ts",
    tableName: "approvals",
    keys: [
      {
        column: "status",
      },
      {
        column: "created_at_ts",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "created_at_ts",
  },
  {
    name: "idx_assembly_runs_council_lease",
    tableName: "assembly_runs",
    keys: [
      {
        column: "run_kind",
      },
      {
        column: "status",
      },
      {
        column: "lease_expires_at",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_audit_events_stream_time",
    tableName: "audit_events",
    keys: [
      {
        column: "stream_name",
      },
      {
        column: "occurred_at",
        direction: "DESC",
      },
      {
        column: "event_sequence",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_compaction_breaker_actions_session_created",
    tableName: "chat_compaction_breaker_actions",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "action_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_compaction_breakers_session_status",
    tableName: "chat_compaction_breakers",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_compaction_states_session_dimension",
    tableName: "chat_compaction_states",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "dimension_hash",
      },
      {
        column: "observed_turn_count",
        direction: "DESC",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_delegation_runs_parent",
    tableName: "chat_delegation_runs",
    keys: [
      {
        column: "parent_run_id",
      },
      {
        column: "started_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_external_source_attachments_session_status",
    tableName: "chat_external_source_attachments",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "session_id",
      },
      {
        column: "status",
      },
      {
        column: "attached_at",
        direction: "DESC",
      },
      {
        column: "attachment_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_generated_artifacts_project_created",
    tableName: "chat_generated_artifacts",
    keys: [
      {
        column: "project_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_generated_artifacts_session_created",
    tableName: "chat_generated_artifacts",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "version",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_generated_artifacts_surface_kind_created",
    tableName: "chat_generated_artifacts",
    keys: [
      {
        column: "source_surface",
      },
      {
        column: "kind",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_generated_artifacts_turn_created",
    tableName: "chat_generated_artifacts",
    keys: [
      {
        column: "turn_id",
      },
      {
        column: "version",
        direction: "DESC",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_generated_artifacts_workspace_created",
    tableName: "chat_generated_artifacts",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_messages_session_seq",
    tableName: "chat_messages",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "seq",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_messages_session_timestamp_ts",
    tableName: "chat_messages",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "timestamp_ts",
        direction: "DESC",
      },
      {
        column: "seq",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "timestamp_ts",
  },
  {
    name: "idx_chat_session_control_events_companion_created",
    tableName: "chat_session_control_events",
    keys: [
      {
        column: "companion_session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "event_id",
      },
    ],
  },
  {
    name: "idx_chat_session_control_events_workspace_created",
    tableName: "chat_session_control_events",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "event_id",
      },
    ],
  },
  {
    name: "idx_chat_session_control_grants_workspace_current",
    tableName: "chat_session_control_grants",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "is_current",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
      {
        column: "session_id",
      },
    ],
  },
  {
    name: "idx_chat_session_forks_source",
    tableName: "chat_session_fork_manifests",
    keys: [
      {
        column: "source_session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_session_forks_workspace",
    tableName: "chat_session_fork_manifests",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_session_meta_folder",
    tableName: "chat_session_meta",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "folder_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_session_run_variables_session",
    tableName: "chat_session_run_variable_bindings",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_thread_knowledge_attachments_document",
    tableName: "chat_thread_knowledge_attachments",
    keys: [
      {
        column: "document_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_thread_knowledge_attachments_session_created",
    tableName: "chat_thread_knowledge_attachments",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_thread_knowledge_attachments_session_mode",
    tableName: "chat_thread_knowledge_attachments",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "retrieval_mode",
      },
      {
        column: "ingest_status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_chat_turn_traces_session_status",
    tableName: "chat_turn_traces",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "status",
      },
      {
        column: "started_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_citadel_records_lifecycle_updated",
    tableName: "citadel_records",
    keys: [
      {
        column: "lifecycle_status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_code_mode_runs_approval",
    tableName: "code_mode_runs",
    keys: [
      {
        column: "approval_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_code_mode_runs_session_created",
    tableName: "code_mode_runs",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_code_mode_runs_session_status_created",
    tableName: "code_mode_runs",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "status",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "run_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_code_mode_runs_status_created",
    tableName: "code_mode_runs",
    keys: [
      {
        column: "status",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "run_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_code_mode_runs_workspace_status_created",
    tableName: "code_mode_runs",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "run_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_code_mode_verification_evidence_run",
    tableName: "code_mode_verification_evidence",
    keys: [
      {
        column: "run_id",
      },
      {
        column: "sequence",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_cost_ledger_day_date",
    tableName: "cost_ledger",
    keys: [
      {
        column: "day_date",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "day_date",
  },
  {
    name: "idx_cost_ledger_session_day_date",
    tableName: "cost_ledger",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "day_date",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "day_date",
  },
  {
    name: "idx_cron_runs_job_created",
    tableName: "cron_runs",
    keys: [
      {
        column: "job_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "run_id",
      },
    ],
  },
  {
    name: "idx_database_cutover_runs_started_at",
    tableName: "database_cutover_runs",
    keys: [
      {
        column: "started_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_document_patch_proposals_scope",
    tableName: "document_patch_proposals",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "session_id",
      },
      {
        column: "state",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_document_patch_proposals_target",
    tableName: "document_patch_proposals",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "target_kind",
      },
      {
        column: "target_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_dry_run_commits_state_created",
    tableName: "dry_run_commits",
    keys: [
      {
        column: "state",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_engineering_learnings_scope_status",
    tableName: "engineering_learnings",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "project_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_connector_review_states_workspace",
    tableName: "external_connector_review_states",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "pinned",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_side_effect_runs_connection_created",
    tableName: "external_side_effect_runs",
    keys: [
      {
        column: "connection_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_side_effect_runs_status_updated",
    tableName: "external_side_effect_runs",
    keys: [
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_side_effect_runs_workspace_created",
    tableName: "external_side_effect_runs",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "run_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_source_catalog_page",
    tableName: "external_source_catalog_items",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "scan_id",
      },
      {
        column: "observed_mtime_ns",
        direction: "DESC",
      },
      {
        column: "item_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_source_configs_workspace_status",
    tableName: "external_source_configs",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
      {
        column: "source_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_source_import_intents_source_admitted",
    tableName: "external_source_import_intents",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "source_id",
      },
      {
        column: "admitted_at",
        direction: "DESC",
      },
      {
        column: "import_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_source_import_plans_source_created",
    tableName: "external_source_import_plans",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "source_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "plan_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_external_source_scans_source_completed",
    tableName: "external_source_scans",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "source_id",
      },
      {
        column: "completed_at",
        direction: "DESC",
      },
      {
        column: "scan_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_governance_journey_fingerprint_session",
    tableName: "governance_journey_events",
    keys: [
      {
        column: "fingerprint",
      },
      {
        column: "session_id",
      },
      {
        column: "recorded_at",
        direction: "DESC",
      },
      {
        column: "event_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_governance_journey_subject_recorded",
    tableName: "governance_journey_events",
    keys: [
      {
        column: "subject_kind",
      },
      {
        column: "subject_id",
      },
      {
        column: "recorded_at",
        direction: "DESC",
      },
      {
        column: "event_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_governance_journey_workspace_recorded",
    tableName: "governance_journey_events",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "recorded_at",
        direction: "DESC",
      },
      {
        column: "event_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_governed_lifecycle_events_scope_recorded",
    tableName: "governed_lifecycle_events",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "recorded_at",
        direction: "DESC",
      },
      {
        column: "event_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_governed_lifecycle_events_target",
    tableName: "governed_lifecycle_events",
    keys: [
      {
        column: "domain",
      },
      {
        column: "target_kind",
      },
      {
        column: "target_id",
      },
      {
        column: "recorded_at",
        direction: "DESC",
      },
      {
        column: "event_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_imported_agent_catalog_workspace",
    tableName: "imported_agent_catalog",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_imported_agent_catalog_workspace_division",
    tableName: "imported_agent_catalog",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "division",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_imported_agent_catalog_workspace_parse",
    tableName: "imported_agent_catalog",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "parse_status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_imported_agent_catalog_workspace_state",
    tableName: "imported_agent_catalog",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "state",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_improvement_lifecycle_operation_inspections_operation",
    tableName: "improvement_lifecycle_operation_inspections",
    keys: [
      {
        column: "operation_id",
      },
      {
        column: "claim_generation",
      },
      {
        column: "observed_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_improvement_lifecycle_operations_target",
    tableName: "improvement_lifecycle_operations",
    keys: [
      {
        column: "target_kind",
      },
      {
        column: "target_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_improvement_lifecycle_operations_workspace_created",
    tableName: "improvement_lifecycle_operations",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "operation_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_llm_eval_proof_runs_created",
    tableName: "llm_eval_proof_runs",
    keys: [
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_llm_eval_proof_runs_session",
    tableName: "llm_eval_proof_runs",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_llm_runtime_measurements_provider_model_collected",
    tableName: "llm_runtime_measurements",
    keys: [
      {
        column: "provider_id",
      },
      {
        column: "model",
      },
      {
        column: "collected_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_llm_runtime_measurements_session",
    tableName: "llm_runtime_measurements",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "collected_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_llm_runtime_measurements_source_status",
    tableName: "llm_runtime_measurements",
    keys: [
      {
        column: "source",
      },
      {
        column: "status",
      },
      {
        column: "collected_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_local_operator_overrides_active",
    tableName: "local_operator_overrides",
    keys: [
      {
        column: "status",
      },
      {
        column: "operator_id",
      },
      {
        column: "scope",
      },
      {
        column: "scope_ref",
      },
      {
        column: "expires_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_decisions_session",
    tableName: "memory_decisions",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_decisions_workspace_status",
    tableName: "memory_decisions",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_entities_type",
    tableName: "memory_entities",
    keys: [
      {
        column: "entity_type",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_entities_workspace_status",
    tableName: "memory_entities",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_items_namespace_status",
    tableName: "memory_items",
    keys: [
      {
        column: "namespace",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_items_pinned_updated",
    tableName: "memory_items",
    keys: [
      {
        column: "pinned",
        direction: "DESC",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_items_status_updated_at_ts",
    tableName: "memory_items",
    keys: [
      {
        column: "status",
      },
      {
        column: "updated_at_ts",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "updated_at_ts",
  },
  {
    name: "idx_memory_items_workspace",
    tableName: "memory_items",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_quality_issues_kind_status",
    tableName: "memory_quality_issues",
    keys: [
      {
        column: "kind",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_quality_issues_target",
    tableName: "memory_quality_issues",
    keys: [
      {
        column: "target_kind",
      },
      {
        column: "target_ref",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_quality_issues_workspace_status",
    tableName: "memory_quality_issues",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_relations_entities",
    tableName: "memory_relations",
    keys: [
      {
        column: "from_entity_id",
      },
      {
        column: "to_entity_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_relations_workspace_status",
    tableName: "memory_relations",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_memory_structured_history_record",
    tableName: "memory_structured_change_history",
    keys: [
      {
        column: "record_kind",
      },
      {
        column: "record_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_mesh_capability_activations_capability_created",
    tableName: "mesh_capability_activations",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "capability_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_mesh_capability_intents_activation_created",
    tableName: "mesh_capability_invocation_intents",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "activation_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_mesh_capability_manifests_publisher_created",
    tableName: "mesh_capability_manifests",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "node_id",
      },
      {
        column: "publisher_generation",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_mesh_capability_node_admissions_current",
    tableName: "mesh_capability_node_admissions",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "node_id",
      },
      {
        column: "admission_generation",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_model_usage_events_outcome_started",
    tableName: "model_usage_events",
    keys: [
      {
        column: "transport_status",
      },
      {
        column: "terminal_outcome",
      },
      {
        column: "availability",
      },
      {
        column: "started_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_model_usage_events_session_started",
    tableName: "model_usage_events",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "started_at",
        direction: "DESC",
      },
      {
        column: "event_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_model_usage_events_workspace_started",
    tableName: "model_usage_events",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "started_at",
        direction: "DESC",
      },
      {
        column: "event_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_mutation_idempotency_updated",
    tableName: "mutation_idempotency",
    keys: [
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_notification_deliveries_workspace",
    tableName: "notification_deliveries",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_notification_events_workspace",
    tableName: "notification_events",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_notification_presence_active",
    tableName: "notification_presence_leases",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "expires_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_notification_rules_workspace",
    tableName: "notification_rules",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "lifecycle_state",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_notification_targets_workspace",
    tableName: "notification_targets",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "lifecycle_state",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_ops_saved_boards_workspace_status_updated",
    tableName: "ops_saved_boards",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
      {
        column: "board_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_orchestration_plans_workspace",
    tableName: "orchestration_plans",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_orchestration_worktree_leases_run",
    tableName: "orchestration_worktree_leases",
    keys: [
      {
        column: "run_id",
      },
      {
        column: "generation",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_permission_profile_activations_lookup",
    tableName: "permission_profile_activations",
    keys: [
      {
        column: "active",
      },
      {
        column: "operator_id",
      },
      {
        column: "workspace_id",
      },
      {
        column: "session_id",
      },
      {
        column: "surface",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_permission_profiles_scope_status",
    tableName: "permission_profiles",
    keys: [
      {
        column: "scope",
      },
      {
        column: "scope_ref",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_personal_ops_note_revisions_workspace",
    tableName: "personal_ops_note_revisions",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "note_id",
      },
      {
        column: "revision",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_prompt_retune_campaigns_pack_updated",
    tableName: "prompt_retune_campaigns",
    keys: [
      {
        column: "pack_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_realtime_events_created_at_ts",
    tableName: "realtime_events",
    keys: [
      {
        column: "created_at_ts",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "created_at_ts",
  },
  {
    name: "idx_realtime_stream_leases_heartbeat_ts",
    tableName: "realtime_stream_leases",
    keys: [
      {
        column: "stream_name",
      },
      {
        column: "state",
      },
      {
        column: "last_heartbeat_at_ts",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "last_heartbeat_at_ts",
  },
  {
    name: "idx_remote_worker_assignment_generations_current",
    tableName: "remote_worker_assignment_generations",
    keys: [
      {
        column: "registry_workspace_id",
      },
      {
        column: "assignment_id",
      },
      {
        column: "assignment_generation",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_remote_worker_assignment_leases_current",
    tableName: "remote_worker_assignment_leases",
    keys: [
      {
        column: "registry_workspace_id",
      },
      {
        column: "assignment_id",
      },
      {
        column: "assignment_generation",
      },
      {
        column: "lease_revision",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_remote_worker_controls_current",
    tableName: "remote_worker_generation_controls",
    keys: [
      {
        column: "registry_workspace_id",
      },
      {
        column: "worker_id",
      },
      {
        column: "worker_generation",
      },
      {
        column: "control_revision",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_remote_worker_credentials_current",
    tableName: "remote_worker_runtime_credentials",
    keys: [
      {
        column: "registry_workspace_id",
      },
      {
        column: "worker_id",
      },
      {
        column: "worker_generation",
      },
      {
        column: "credential_generation",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_remote_worker_generations_current",
    tableName: "remote_worker_generations",
    keys: [
      {
        column: "registry_workspace_id",
      },
      {
        column: "worker_id",
      },
      {
        column: "worker_generation",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_remote_worker_mesh_join_authorities_current",
    tableName: "remote_worker_mesh_join_authorities",
    keys: [
      {
        column: "registry_workspace_id",
      },
      {
        column: "worker_id",
      },
      {
        column: "worker_generation",
      },
      {
        column: "join_authority_generation",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_runtime_evidence_kind_created",
    tableName: "runtime_evidence_envelopes",
    keys: [
      {
        column: "event_kind",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_runtime_evidence_run_created",
    tableName: "runtime_evidence_envelopes",
    keys: [
      {
        column: "run_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_runtime_evidence_session_created",
    tableName: "runtime_evidence_envelopes",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_runtime_evidence_turn_created",
    tableName: "runtime_evidence_envelopes",
    keys: [
      {
        column: "turn_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_runtime_evidence_workspace_created",
    tableName: "runtime_evidence_envelopes",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_sessions_account_last_activity_at_ts",
    tableName: "sessions",
    keys: [
      {
        column: "account",
      },
      {
        column: "last_activity_at_ts",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "last_activity_at_ts",
  },
  {
    name: "idx_sessions_last_activity_at_ts",
    tableName: "sessions",
    keys: [
      {
        column: "last_activity_at_ts",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "last_activity_at_ts",
  },
  {
    name: "idx_skill_evaluation_runs_skill_updated",
    tableName: "skill_evaluation_runs",
    keys: [
      {
        column: "skill_id",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_evaluation_runs_status_updated",
    tableName: "skill_evaluation_runs",
    keys: [
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_hub_operation_intents_snapshot",
    tableName: "skill_hub_operation_intents",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "snapshot_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "operation_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_hub_operation_intents_workspace_skill_created",
    tableName: "skill_hub_operation_intents",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "skill_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "operation_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_hub_operation_settlements_evidence",
    tableName: "skill_hub_operation_settlements",
    keys: [
      {
        column: "evidence_envelope_id",
      },
      {
        column: "settled_at",
        direction: "DESC",
      },
      {
        column: "settlement_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_hub_operation_settlements_journey",
    tableName: "skill_hub_operation_settlements",
    keys: [
      {
        column: "journey_event_id",
      },
      {
        column: "settled_at",
        direction: "DESC",
      },
      {
        column: "settlement_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_hub_snapshot_artifacts_tree",
    tableName: "skill_hub_snapshot_artifacts",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "content_tree_sha256",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "artifact_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_hub_snapshots_source_created",
    tableName: "skill_hub_snapshots",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "canonical_source_key",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "snapshot_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_skill_learning_evidence_target_created",
    tableName: "skill_learning_evidence",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "target_key",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "evidence_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_state_validation_quarantine_store_observed",
    tableName: "state_validation_quarantine",
    keys: [
      {
        column: "store",
      },
      {
        column: "observed_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_structured_review_findings_status",
    tableName: "structured_review_findings",
    keys: [
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_structured_review_runs_created",
    tableName: "structured_review_runs",
    keys: [
      {
        column: "created_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_task_subagent_sessions_agent_status_updated",
    tableName: "task_subagent_sessions",
    keys: [
      {
        column: "agent_session_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_tasks_workspace_status_updated",
    tableName: "tasks",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_tasks_workspace_updated_at_ts",
    tableName: "tasks",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "updated_at_ts",
        direction: "DESC",
      },
      {
        column: "task_id",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "updated_at_ts",
  },
  {
    name: "idx_tool_access_decisions_run_time",
    tableName: "tool_access_decisions",
    keys: [
      {
        column: "run_id",
      },
      {
        column: "timestamp",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_tool_grants_scope_expires_at_ts",
    tableName: "tool_grants",
    keys: [
      {
        column: "scope",
      },
      {
        column: "scope_ref",
      },
      {
        column: "expires_at_ts",
        direction: "DESC",
      },
    ],
    predicateNotNullColumn: "expires_at_ts",
  },
  {
    name: "idx_transcript_events_session_time",
    tableName: "transcript_events",
    keys: [
      {
        column: "session_id",
      },
      {
        column: "occurred_at",
        direction: "DESC",
      },
      {
        column: "event_sequence",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_workspace_path_bridge_workspace_created",
    tableName: "workspace_path_bridge_snapshots",
    keys: [
      {
        column: "workspace_id",
      },
      {
        column: "created_at",
        direction: "DESC",
      },
      {
        column: "snapshot_id",
        direction: "DESC",
      },
    ],
  },
  {
    name: "idx_workspaces_citadel_updated",
    tableName: "workspaces",
    keys: [
      {
        column: "citadel_id",
      },
      {
        column: "lifecycle_status",
      },
      {
        column: "updated_at",
        direction: "DESC",
      },
    ],
  },
] as const satisfies readonly CanonicalOrderedIndexSpec[];

// These fifteen names were already authored with their final DESC vector by
// the frozen PostgreSQL ledger before v140. Every other ordered repair has one
// additional admitted lineage: the dynamic-v2 SQLite blueprint emitted the
// same keys as all-ASC because its old index manifest discarded direction.
// Do not broaden this set without a catalog diff proving another frozen shape.
const POSTGRES_V140_PREVIOUSLY_CANONICAL_ORDERED_INDEXES = new Set([
  "idx_approvals_status_created_at_ts",
  "idx_audit_events_stream_time",
  "idx_chat_messages_session_timestamp_ts",
  "idx_cost_ledger_day_date",
  "idx_cost_ledger_session_day_date",
  "idx_database_cutover_runs_started_at",
  "idx_memory_items_status_updated_at_ts",
  "idx_realtime_events_created_at_ts",
  "idx_realtime_stream_leases_heartbeat_ts",
  "idx_remote_worker_mesh_join_authorities_current",
  "idx_sessions_account_last_activity_at_ts",
  "idx_sessions_last_activity_at_ts",
  "idx_tasks_workspace_updated_at_ts",
  "idx_tool_grants_scope_expires_at_ts",
  "idx_transcript_events_session_time",
]);

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quotePostgresLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderOrderedIndexRepair(spec: CanonicalOrderedIndexSpec, ordinal: number): string {
  const renderedKeys = spec.keys
    .map((key) =>
      key.direction === undefined
        ? quotePostgresIdentifier(key.column)
        : `${quotePostgresIdentifier(key.column)} ${key.direction}`,
    )
    .join(", ");
  const predicate =
    spec.predicateNotNullColumn === undefined ? "" : ` WHERE ${spec.predicateNotNullColumn} IS NOT NULL`;
  const keyDriftChecks = spec.keys
    .map((key, index) =>
      [
        `frozen_index.indkey[${index}] IS DISTINCT FROM (`,
        "          SELECT attribute.attnum",
        "          FROM pg_catalog.pg_attribute AS attribute",
        "          WHERE attribute.attrelid = target_relation",
        `            AND attribute.attname = ${quotePostgresLiteral(key.column)}`,
        "            AND attribute.attnum > 0",
        "            AND NOT attribute.attisdropped",
        "        )",
        `        OR frozen_index.indcollation[${index}] IS DISTINCT FROM (`,
        "          SELECT attribute.attcollation",
        "          FROM pg_catalog.pg_attribute AS attribute",
        "          WHERE attribute.attrelid = target_relation",
        `            AND attribute.attname = ${quotePostgresLiteral(key.column)}`,
        "            AND attribute.attnum > 0",
        "            AND NOT attribute.attisdropped",
        "        )",
        "        OR NOT EXISTS (",
        "          SELECT 1",
        "          FROM pg_catalog.pg_opclass AS operator_class",
        `          WHERE operator_class.oid = frozen_index.indclass[${index}]`,
        "            AND operator_class.opcmethod = frozen_index.access_method_oid",
        "            AND operator_class.opcdefault",
        "        )",
      ].join("\n"),
    )
    .join("\n        OR ");
  const canonicalSortOptions = spec.keys.map((key) => (key.direction === "DESC" ? 3 : 0)).join(" ");
  const historicalSortOptions = POSTGRES_V140_PREVIOUSLY_CANONICAL_ORDERED_INDEXES.has(spec.name)
    ? canonicalSortOptions
    : spec.keys.map(() => 0).join(" ");
  const sortOptionDriftCheck =
    canonicalSortOptions === historicalSortOptions
      ? `frozen_index.indoption IS DISTINCT FROM ${quotePostgresLiteral(canonicalSortOptions)}::pg_catalog.int2vector`
      : [
          `frozen_index.indoption IS DISTINCT FROM ${quotePostgresLiteral(canonicalSortOptions)}::pg_catalog.int2vector`,
          `        AND frozen_index.indoption IS DISTINCT FROM ${quotePostgresLiteral(historicalSortOptions)}::pg_catalog.int2vector`,
        ].join("\n");
  const predicateDriftCheck = [
    spec.predicateNotNullColumn === undefined
      ? "frozen_index.predicate_expression IS NOT NULL"
      : [
          "pg_catalog.lower(pg_catalog.regexp_replace(frozen_index.predicate_expression, '[\\s()\"]', '', 'g'))",
          `          IS DISTINCT FROM ${quotePostgresLiteral(`${spec.predicateNotNullColumn.toLowerCase()}isnotnull`)}`,
        ].join("\n"),
    `(${sortOptionDriftCheck})`,
  ].join("\n        OR ");
  const indexName = quotePostgresLiteral(spec.name);
  const reservedIndexIdentifier = quotePostgresIdentifier(`gc_v140_ordered_${ordinal.toString().padStart(3, "0")}`);
  const reservedIndexName = quotePostgresLiteral(`gc_v140_ordered_${ordinal.toString().padStart(3, "0")}`);
  const tableName = quotePostgresLiteral(spec.tableName);
  return `DO $canonical_ordered_index$
DECLARE
  target_relation pg_catalog.regclass;
  frozen_index RECORD;
  original_default_tablespace TEXT;
BEGIN
  target_relation := pg_catalog.to_regclass(${tableName});
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority is missing table ${spec.tableName}'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE %s IN SHARE MODE', target_relation);
  IF pg_catalog.to_regclass(${reservedIndexName}) IS NOT NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found reserved index ${reservedIndexIdentifier}'
      USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.to_regclass(${indexName}) IS NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority is missing ordered index ${spec.name}'
      USING ERRCODE = '23514';
  END IF;
  ALTER INDEX ${quotePostgresIdentifier(spec.name)} RENAME TO ${reservedIndexIdentifier};
  DROP INDEX IF EXISTS ${quotePostgresIdentifier(spec.name)};

  SELECT
      index_relation.oid AS index_oid,
      index_relation.relkind,
      index_relation.relpersistence,
      index_relation.relispartition,
      index_relation.reloptions,
      index_relation.relacl,
      index_relation.relowner,
      CASE WHEN index_relation.reltablespace = 0 THEN '' ELSE tablespace.spcname END
        AS replacement_default_tablespace,
      access_method.oid AS access_method_oid,
      access_method.amname,
      index_row.indnatts,
      index_row.indnkeyatts,
      index_row.indisunique,
      index_row.indisprimary,
      index_row.indimmediate,
      index_row.indisexclusion,
      index_row.indisclustered,
      index_row.indisvalid,
      index_row.indcheckxmin,
      index_row.indisready,
      index_row.indislive,
      index_row.indisreplident,
      index_row.indnullsnotdistinct,
      index_row.indkey,
      index_row.indcollation,
      index_row.indclass,
      index_row.indoption,
      index_row.indexprs,
      pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false) AS predicate_expression
    INTO frozen_index
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    LEFT JOIN pg_catalog.pg_tablespace AS tablespace
      ON tablespace.oid = index_relation.reltablespace
    WHERE index_relation.relnamespace = (
        SELECT target_class.relnamespace
        FROM pg_catalog.pg_class AS target_class
        WHERE target_class.oid = target_relation
      )
      AND index_relation.relname = ${reservedIndexName}
      AND index_row.indrelid = target_relation;

  IF NOT FOUND
    OR frozen_index.relkind IS DISTINCT FROM 'i'
    OR frozen_index.relpersistence IS DISTINCT FROM 'p'
    OR frozen_index.relispartition IS DISTINCT FROM FALSE
    OR frozen_index.reloptions IS NOT NULL
    OR frozen_index.relacl IS NOT NULL
    OR frozen_index.relowner IS DISTINCT FROM CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
    OR frozen_index.replacement_default_tablespace IS NULL
    OR frozen_index.amname IS DISTINCT FROM 'btree'
    OR frozen_index.indnatts IS DISTINCT FROM ${spec.keys.length}
    OR frozen_index.indnkeyatts IS DISTINCT FROM ${spec.keys.length}
    OR frozen_index.indisunique IS DISTINCT FROM FALSE
    OR frozen_index.indisprimary IS DISTINCT FROM FALSE
    OR frozen_index.indimmediate IS DISTINCT FROM TRUE
    OR frozen_index.indisexclusion IS DISTINCT FROM FALSE
    OR frozen_index.indisclustered IS DISTINCT FROM FALSE
    OR frozen_index.indisvalid IS DISTINCT FROM TRUE
    OR frozen_index.indcheckxmin IS DISTINCT FROM FALSE
    OR frozen_index.indisready IS DISTINCT FROM TRUE
    OR frozen_index.indislive IS DISTINCT FROM TRUE
    OR frozen_index.indisreplident IS DISTINCT FROM FALSE
    OR frozen_index.indnullsnotdistinct IS DISTINCT FROM FALSE
    OR frozen_index.indexprs IS NOT NULL
    OR ${predicateDriftCheck}
    OR ${keyDriftChecks}
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conindid = frozen_index.index_oid
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_depend AS dependency
      WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dependency.objid = frozen_index.index_oid
        AND dependency.deptype = 'e'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_description AS description
      WHERE description.objoid = frozen_index.index_oid
        AND description.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_seclabel AS security_label
      WHERE security_label.objoid = frozen_index.index_oid
        AND security_label.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
    )
  THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found drifted ordered index ${spec.name}'
      USING ERRCODE = '23514';
  END IF;

  IF frozen_index.indoption IS NOT DISTINCT FROM ${quotePostgresLiteral(canonicalSortOptions)}::pg_catalog.int2vector THEN
    ALTER INDEX ${reservedIndexIdentifier} RENAME TO ${quotePostgresIdentifier(spec.name)};
  ELSE
    original_default_tablespace := pg_catalog.current_setting('default_tablespace');
    PERFORM pg_catalog.set_config('default_tablespace', frozen_index.replacement_default_tablespace, true);
    DROP INDEX ${reservedIndexIdentifier};
    CREATE INDEX ${quotePostgresIdentifier(spec.name)}
      ON ${quotePostgresIdentifier(spec.tableName)} (${renderedKeys})${predicate};
    PERFORM pg_catalog.set_config('default_tablespace', original_default_tablespace, true);
  END IF;
END
$canonical_ordered_index$;`;
}

function renderLegacyNamedCheckConstraintRemoval(input: {
  tableName: string;
  constraintName: string;
  probeNamePrefix: string;
  allowedExpressions: readonly string[];
}): string {
  const table = quotePostgresIdentifier(input.tableName);
  const constraint = quotePostgresIdentifier(input.constraintName);
  const probes = input.allowedExpressions.map((expression, index) => ({
    expression,
    name: `${input.probeNamePrefix}_${index + 1}`,
  }));
  const reserveProbes = probes
    .map(
      (probe) => `
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)})
      AND constraint_row.conname = ${quotePostgresLiteral(probe.name)}
  ) THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found reserved probe constraint ${probe.name}'
      USING ERRCODE = '23514';
  END IF;`,
    )
    .join("\n");
  const buildExpectedExpressions = probes
    .map(
      (probe) => `
  ALTER TABLE ${table}
    ADD CONSTRAINT ${quotePostgresIdentifier(probe.name)} CHECK (${probe.expression}) NOT VALID;
  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)
    INTO expected_expression
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)})
      AND constraint_row.conname = ${quotePostgresLiteral(probe.name)}
      AND constraint_row.contype = 'c';
  expected_expressions := pg_catalog.array_append(expected_expressions, expected_expression);`,
    )
    .join("\n");
  const dropProbes = probes
    .map((probe) => `  ALTER TABLE ${table} DROP CONSTRAINT ${quotePostgresIdentifier(probe.name)};`)
    .join("\n");
  return `
DO $canonical_legacy_check$
DECLARE
  expected_expression TEXT;
  expected_expressions TEXT[] := ARRAY[]::TEXT[];
  frozen_constraint RECORD;
BEGIN
  IF pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)}) IS NULL THEN
    RETURN;
  END IF;
${reserveProbes}
${buildExpectedExpressions}

  SELECT
      constraint_row.oid,
      pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false) AS expression,
      constraint_row.convalidated,
      constraint_row.connoinherit,
      constraint_row.conislocal,
      constraint_row.coninhcount,
      constraint_row.conparentid
    INTO frozen_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)})
      AND constraint_row.conname = ${quotePostgresLiteral(input.constraintName)};
  IF FOUND THEN
    IF frozen_constraint.expression IS NULL
      OR NOT (frozen_constraint.expression = ANY(expected_expressions))
      OR frozen_constraint.convalidated IS DISTINCT FROM TRUE
      OR frozen_constraint.connoinherit IS DISTINCT FROM FALSE
      OR frozen_constraint.conislocal IS DISTINCT FROM TRUE
      OR frozen_constraint.coninhcount IS DISTINCT FROM 0
      OR frozen_constraint.conparentid IS DISTINCT FROM 0
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_description AS description
        WHERE description.classoid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND description.objoid = frozen_constraint.oid
      )
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.classoid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND security_label.objoid = frozen_constraint.oid
      )
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND dependency.objid = frozen_constraint.oid
          AND dependency.deptype = 'e'
      )
    THEN
      RAISE EXCEPTION 'Postgres canonical schema authority found drifted constraint ${input.constraintName}'
        USING ERRCODE = '23514';
    END IF;
    ALTER TABLE ${table} DROP CONSTRAINT ${constraint};
  END IF;
${dropProbes}
END
$canonical_legacy_check$;`.trim();
}

function renderPosixFlavorConstraintRepair(tableName: string, column: string): string {
  const legacyConstraintName = `${tableName}_${column}_check`;
  const canonicalConstraintName = `${tableName}_${column}_posix_check`;
  const legacyExpression = `${column} IN ('windows_native', 'windows_forward', 'msys', 'wsl')`;
  const canonicalExpression = `${column} IN ('windows_native', 'windows_forward', 'msys', 'wsl', 'posix')`;
  return [
    renderLegacyNamedCheckConstraintRemoval({
      tableName,
      constraintName: legacyConstraintName,
      probeNamePrefix: `gc_v140_legacy_${column}`,
      allowedExpressions: [legacyExpression, canonicalExpression],
    }),
    renderNamedCheckConstraintAuthority({
      tableName,
      constraintName: canonicalConstraintName,
      probeName: `gc_v140_canonical_${column}`,
      expression: canonicalExpression,
    }),
  ].join("\n");
}

function renderNamedCheckConstraintAuthority(input: {
  tableName: string;
  constraintName: string;
  probeName: string;
  expression: string;
}): string {
  const table = quotePostgresIdentifier(input.tableName);
  const constraint = quotePostgresIdentifier(input.constraintName);
  const probe = quotePostgresIdentifier(input.probeName);
  return `
DO $canonical_named_check$
DECLARE
  expected_expression TEXT;
  frozen_expression TEXT;
  frozen_validated BOOLEAN;
  frozen_no_inherit BOOLEAN;
  frozen_is_local BOOLEAN;
  frozen_inheritance_count INTEGER;
BEGIN
  IF pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)}) IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)})
      AND constraint_row.conname = ${quotePostgresLiteral(input.probeName)}
  ) THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found reserved probe constraint ${input.probeName}'
      USING ERRCODE = '23514';
  END IF;

  ALTER TABLE ${table}
    ADD CONSTRAINT ${probe} CHECK (${input.expression}) NOT VALID;
  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)
    INTO expected_expression
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)})
      AND constraint_row.conname = ${quotePostgresLiteral(input.probeName)}
      AND constraint_row.contype = 'c';

  SELECT
      pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false),
      constraint_row.convalidated,
      constraint_row.connoinherit,
      constraint_row.conislocal,
      constraint_row.coninhcount
    INTO frozen_expression, frozen_validated, frozen_no_inherit, frozen_is_local, frozen_inheritance_count
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = pg_catalog.to_regclass(${quotePostgresLiteral(input.tableName)})
      AND constraint_row.conname = ${quotePostgresLiteral(input.constraintName)}
      AND constraint_row.contype = 'c';
  IF FOUND THEN
    IF frozen_expression IS DISTINCT FROM expected_expression
      OR frozen_validated IS DISTINCT FROM TRUE
      OR frozen_no_inherit IS DISTINCT FROM FALSE
      OR frozen_is_local IS DISTINCT FROM TRUE
      OR frozen_inheritance_count IS DISTINCT FROM 0
    THEN
      RAISE EXCEPTION 'Postgres canonical schema authority found drifted constraint ${input.constraintName}'
        USING ERRCODE = '23514';
    END IF;
    ALTER TABLE ${table} DROP CONSTRAINT ${probe};
  ELSE
    ALTER TABLE ${table} DROP CONSTRAINT ${probe};
    ALTER TABLE ${table}
      ADD CONSTRAINT ${constraint} CHECK (${input.expression});
  END IF;
END
$canonical_named_check$;`.trim();
}

const POSTGRES_V140_ASSEMBLY_RUN_KIND_CHECK_SQL = renderNamedCheckConstraintAuthority({
  tableName: "assembly_runs",
  constraintName: "assembly_runs_run_kind_check",
  probeName: "gc_v140_probe_assembly_run_kind",
  expression: "run_kind IN ('assembly', 'chat_model_council')",
});

const POSTGRES_V140_ASSEMBLY_GENERATION_CHECK_SQL = renderNamedCheckConstraintAuthority({
  tableName: "assembly_runs",
  constraintName: "assembly_runs_generation_check",
  probeName: "gc_v140_probe_assembly_generation",
  expression: "generation >= 0",
});

const POSTGRES_V140_MODEL_USAGE_CAP_RETRY_LINEAGE_EXPRESSION = `
  (
    requested_output_token_cap IS NULL
    AND effective_output_token_cap IS NULL
    AND output_cap_disposition IS NULL
    AND output_cap_recovery_source_event_id IS NULL
    AND output_cap_recovery_reason_code IS NULL
    AND output_cap_provider_available_tokens IS NULL
    AND output_cap_provider_minimum_tokens IS NULL
    AND output_cap_request_input_estimate IS NULL
    AND output_cap_configured_context_window_tokens IS NULL
    AND output_cap_safety_margin_tokens IS NULL
    AND output_cap_evidence_format IS NULL
    AND (transport_retry_reason IS NULL OR transport_retry_reason = 'metadata_compatibility')
  ) OR (
    requested_output_token_cap IS NOT NULL
    AND effective_output_token_cap = requested_output_token_cap
    AND output_cap_disposition = 'initial'
    AND output_cap_recovery_source_event_id IS NULL
    AND output_cap_recovery_reason_code IS NULL
    AND output_cap_provider_available_tokens IS NULL
    AND output_cap_provider_minimum_tokens IS NULL
    AND output_cap_request_input_estimate IS NULL
    AND output_cap_configured_context_window_tokens IS NULL
    AND output_cap_safety_margin_tokens IS NULL
    AND output_cap_evidence_format IS NULL
    AND transport_retry_parent_event_id IS NULL
    AND transport_retry_reason IS NULL
  ) OR (
    requested_output_token_cap IS NOT NULL
    AND effective_output_token_cap IS NOT NULL
    AND effective_output_token_cap <= requested_output_token_cap
    AND output_cap_disposition = 'preserved_retry'
    AND output_cap_recovery_source_event_id IS NULL
    AND output_cap_recovery_reason_code IS NULL
    AND output_cap_provider_available_tokens IS NULL
    AND output_cap_provider_minimum_tokens IS NULL
    AND output_cap_request_input_estimate IS NULL
    AND output_cap_configured_context_window_tokens IS NULL
    AND output_cap_safety_margin_tokens IS NULL
    AND output_cap_evidence_format IS NULL
    AND transport_retry_parent_event_id IS NOT NULL
    AND transport_retry_reason = 'metadata_compatibility'
  ) OR (
    requested_output_token_cap IS NOT NULL
    AND effective_output_token_cap IS NOT NULL
    AND effective_output_token_cap < requested_output_token_cap
    AND output_cap_disposition = 'reduced_retry'
    AND output_cap_recovery_source_event_id IS NOT NULL
    AND output_cap_recovery_reason_code = 'safe_lower_cap'
    AND output_cap_provider_available_tokens IS NOT NULL
    AND (output_cap_provider_minimum_tokens IS NULL OR effective_output_token_cap >= output_cap_provider_minimum_tokens)
    AND output_cap_request_input_estimate IS NOT NULL
    AND output_cap_configured_context_window_tokens IS NOT NULL
    AND output_cap_safety_margin_tokens IS NOT NULL
    AND effective_output_token_cap <= output_cap_provider_available_tokens - output_cap_safety_margin_tokens
    AND effective_output_token_cap <= output_cap_configured_context_window_tokens - output_cap_request_input_estimate - output_cap_safety_margin_tokens
    AND output_cap_evidence_format IS NOT NULL
    AND transport_retry_parent_event_id = output_cap_recovery_source_event_id
    AND transport_retry_reason = 'output_cap_recovery'
  )
  AND (
    (transport_retry_parent_event_id IS NULL AND transport_retry_reason IS NULL)
    OR (
      transport_retry_parent_event_id IS NOT NULL
      AND transport_retry_reason IN ('output_cap_recovery', 'metadata_compatibility')
    )
  )
`.trim();

const POSTGRES_V140_MODEL_USAGE_CAP_RETRY_LINEAGE_CHECK_SQL = renderNamedCheckConstraintAuthority({
  tableName: "model_usage_events",
  constraintName: "model_usage_events_cap_retry_lineage_check",
  probeName: "gc_v140_probe_usage_cap_retry",
  expression: POSTGRES_V140_MODEL_USAGE_CAP_RETRY_LINEAGE_EXPRESSION,
});

const POSTGRES_V140_ROUTED_CONTEXT_SCHEMA_EXPRESSION =
  "schema_version IN ('chat.routed-context-snapshot.v1', 'chat.routed-context-snapshot.v2')";

const POSTGRES_V140_ROUTED_CONTEXT_SCHEMA_CONSTRAINT_SQL = [
  renderLegacyNamedCheckConstraintRemoval({
    tableName: "chat_routed_context_snapshots",
    constraintName: "chat_routed_context_snapshots_schema_version_check",
    probeNamePrefix: "gc_v140_legacy_routed_schema",
    allowedExpressions: [
      "schema_version = 'chat.routed-context-snapshot.v1'",
      POSTGRES_V140_ROUTED_CONTEXT_SCHEMA_EXPRESSION,
    ],
  }),
  renderNamedCheckConstraintAuthority({
    tableName: "chat_routed_context_snapshots",
    constraintName: "chat_routed_context_snapshots_schema_version_v2_check",
    probeName: "gc_v140_canonical_routed_schema",
    expression: POSTGRES_V140_ROUTED_CONTEXT_SCHEMA_EXPRESSION,
  }),
].join("\n");

const POSTGRES_V140_SECURE_CONFIGURATION_RECONCILIATION_FK_SQL = `
DO $canonical_secure_configuration_fk$
DECLARE
  target_relation pg_catalog.regclass;
  source_attribute SMALLINT;
  target_attribute SMALLINT;
  frozen_constraint RECORD;
  frozen_constraint_count INTEGER := 0;
BEGIN
  target_relation := pg_catalog.to_regclass('chat_turn_secure_configuration_reservations');
  IF target_relation IS NULL THEN
    RETURN;
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', target_relation);
  SELECT
      pg_catalog.max(attribute.attnum) FILTER (WHERE attribute.attname = 'reconciled_by_reservation_id'),
      pg_catalog.max(attribute.attnum) FILTER (WHERE attribute.attname = 'reservation_id')
    INTO source_attribute, target_attribute
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = target_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
  IF source_attribute IS NULL OR target_attribute IS NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found incomplete secure-configuration reconciliation columns'
      USING ERRCODE = '23514';
  END IF;

  FOR frozen_constraint IN
    SELECT constraint_row.*
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = target_relation
      AND constraint_row.contype = 'f'
      AND source_attribute = ANY(constraint_row.conkey)
  LOOP
    frozen_constraint_count := frozen_constraint_count + 1;
    IF frozen_constraint_count > 1 THEN
      RAISE EXCEPTION 'Postgres canonical schema authority found duplicate secure-configuration reconciliation foreign keys'
        USING ERRCODE = '23514';
    END IF;
    IF frozen_constraint.conname NOT IN (
        'chat_turn_secure_configuratio_reconciled_by_reservation_id_fkey',
        'chat_turn_secure_configuration_reservations_reconciled_by_fkey'
      )
      OR frozen_constraint.conkey IS DISTINCT FROM ARRAY[source_attribute]::SMALLINT[]
      OR frozen_constraint.confrelid IS DISTINCT FROM target_relation
      OR frozen_constraint.confkey IS DISTINCT FROM ARRAY[target_attribute]::SMALLINT[]
      OR frozen_constraint.confmatchtype IS DISTINCT FROM 's'
      OR frozen_constraint.confupdtype IS DISTINCT FROM 'a'
      OR frozen_constraint.confdeltype IS DISTINCT FROM 'r'
      OR frozen_constraint.condeferrable IS DISTINCT FROM FALSE
      OR frozen_constraint.condeferred IS DISTINCT FROM FALSE
      OR frozen_constraint.convalidated IS DISTINCT FROM TRUE
      OR frozen_constraint.connoinherit IS DISTINCT FROM TRUE
      OR frozen_constraint.conislocal IS DISTINCT FROM TRUE
      OR frozen_constraint.coninhcount IS DISTINCT FROM 0
      OR frozen_constraint.conparentid IS DISTINCT FROM 0
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_description AS description
        WHERE description.classoid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND description.objoid = frozen_constraint.oid
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.classoid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND security_label.objoid = frozen_constraint.oid
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND dependency.objid = frozen_constraint.oid
          AND dependency.deptype = 'e'
      )
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgconstraint = frozen_constraint.oid
      ) IS DISTINCT FROM 4
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgconstraint = frozen_constraint.oid
          AND (
            trigger_row.tgname IS DISTINCT FROM pg_catalog.format(
              'RI_ConstraintTrigger_%s_%s',
              CASE
                WHEN (
                  SELECT trigger_function.proname
                  FROM pg_catalog.pg_proc AS trigger_function
                  WHERE trigger_function.oid = trigger_row.tgfoid
                ) LIKE 'RI_FKey_check_%' THEN 'c'
                WHEN (
                  SELECT trigger_function.proname
                  FROM pg_catalog.pg_proc AS trigger_function
                  WHERE trigger_function.oid = trigger_row.tgfoid
                ) LIKE 'RI_FKey_%' THEN 'a'
                ELSE '?'
              END,
              trigger_row.oid
            )
            OR trigger_row.tgenabled IS DISTINCT FROM 'O'
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_description AS description
              WHERE description.classoid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
                AND description.objoid = trigger_row.oid
            )
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_seclabel AS security_label
              WHERE security_label.classoid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
                AND security_label.objoid = trigger_row.oid
            )
          )
      )
    THEN
      RAISE EXCEPTION 'Postgres canonical schema authority found drifted secure-configuration reconciliation foreign key %',
        frozen_constraint.conname
        USING ERRCODE = '23514';
    END IF;
    EXECUTE pg_catalog.format(
      'ALTER TABLE chat_turn_secure_configuration_reservations DROP CONSTRAINT %I',
      frozen_constraint.conname
    );
  END LOOP;
  ALTER TABLE "chat_turn_secure_configuration_reservations"
    ADD CONSTRAINT "chat_turn_secure_configuration_reservations_reconciled_by_fkey"
    FOREIGN KEY(reconciled_by_reservation_id)
    REFERENCES chat_turn_secure_configuration_reservations(reservation_id) ON DELETE RESTRICT;
END
$canonical_secure_configuration_fk$;
`.trim();

const POSTGRES_V140_APPROVALS_STATUS_EXPIRES_INDEX_SQL = `
DO $canonical_approvals_status_expires$
DECLARE
  target_relation pg_catalog.regclass;
  frozen_index RECORD;
  predicate_fingerprint TEXT;
  canonical_lineage BOOLEAN;
  original_default_tablespace TEXT;
BEGIN
  target_relation := pg_catalog.to_regclass('approvals');
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority is missing table approvals'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE %s IN SHARE MODE', target_relation);
  IF pg_catalog.to_regclass('gc_v140_approvals_status_expires') IS NOT NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found reserved approvals index'
      USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.to_regclass('idx_approvals_status_expires_at') IS NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority is missing approvals status/expiry index'
      USING ERRCODE = '23514';
  END IF;
  ALTER INDEX "idx_approvals_status_expires_at" RENAME TO "gc_v140_approvals_status_expires";
  DROP INDEX IF EXISTS "idx_approvals_status_expires_at";

  SELECT
      index_relation.oid AS index_oid,
      index_relation.relkind,
      index_relation.relpersistence,
      index_relation.relispartition,
      index_relation.reloptions,
      index_relation.relacl,
      index_relation.relowner,
      CASE WHEN index_relation.reltablespace = 0 THEN '' ELSE tablespace.spcname END
        AS replacement_default_tablespace,
      access_method.oid AS access_method_oid,
      access_method.amname,
      index_row.*,
      pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false) AS predicate_expression
    INTO frozen_index
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    LEFT JOIN pg_catalog.pg_tablespace AS tablespace
      ON tablespace.oid = index_relation.reltablespace
    WHERE index_relation.relname = 'gc_v140_approvals_status_expires'
      AND index_relation.relnamespace = (
        SELECT target_class.relnamespace FROM pg_catalog.pg_class AS target_class
        WHERE target_class.oid = target_relation
      )
      AND index_row.indrelid = target_relation;
  IF NOT FOUND
    OR frozen_index.relkind IS DISTINCT FROM 'i'
    OR frozen_index.relpersistence IS DISTINCT FROM 'p'
    OR frozen_index.relispartition IS DISTINCT FROM FALSE
    OR frozen_index.reloptions IS NOT NULL
    OR frozen_index.relacl IS NOT NULL
    OR frozen_index.relowner IS DISTINCT FROM CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
    OR frozen_index.replacement_default_tablespace IS NULL
    OR frozen_index.amname IS DISTINCT FROM 'btree'
    OR frozen_index.indisunique IS DISTINCT FROM FALSE
    OR frozen_index.indisprimary IS DISTINCT FROM FALSE
    OR frozen_index.indimmediate IS DISTINCT FROM TRUE
    OR frozen_index.indisexclusion IS DISTINCT FROM FALSE
    OR frozen_index.indisclustered IS DISTINCT FROM FALSE
    OR frozen_index.indisvalid IS DISTINCT FROM TRUE
    OR frozen_index.indcheckxmin IS DISTINCT FROM FALSE
    OR frozen_index.indisready IS DISTINCT FROM TRUE
    OR frozen_index.indislive IS DISTINCT FROM TRUE
    OR frozen_index.indisreplident IS DISTINCT FROM FALSE
    OR frozen_index.indnullsnotdistinct IS DISTINCT FROM FALSE
    OR frozen_index.indexprs IS NOT NULL
    OR frozen_index.predicate_expression IS NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conindid = frozen_index.index_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_description AS description
      WHERE description.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND description.objoid = frozen_index.index_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_seclabel AS security_label
      WHERE security_label.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND security_label.objoid = frozen_index.index_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS dependency
      WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dependency.objid = frozen_index.index_oid
        AND dependency.deptype = 'e'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.generate_series(0, frozen_index.indnkeyatts - 1) AS key_position(position)
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = target_relation
        AND attribute.attnum = frozen_index.indkey[key_position.position]
      LEFT JOIN pg_catalog.pg_opclass AS operator_class
        ON operator_class.oid = frozen_index.indclass[key_position.position]
      WHERE attribute.attnum IS NULL
        OR frozen_index.indcollation[key_position.position] IS DISTINCT FROM attribute.attcollation
        OR operator_class.opcmethod IS DISTINCT FROM frozen_index.access_method_oid
        OR operator_class.opcdefault IS DISTINCT FROM TRUE
    )
  THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found drifted approvals status/expiry index'
      USING ERRCODE = '23514';
  END IF;

  predicate_fingerprint := pg_catalog.lower(
    pg_catalog.regexp_replace(frozen_index.predicate_expression, '[\\s()"]', '', 'g')
  );
  canonical_lineage := (
    frozen_index.indnatts = 3
    AND frozen_index.indnkeyatts = 3
    AND frozen_index.indkey[0] = (
      SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = target_relation AND attribute.attname = 'status' AND NOT attribute.attisdropped
    )
    AND frozen_index.indkey[1] = (
      SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = target_relation AND attribute.attname = 'expires_at_ts' AND NOT attribute.attisdropped
    )
    AND frozen_index.indkey[2] = (
      SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = target_relation AND attribute.attname = 'approval_id' AND NOT attribute.attisdropped
    )
    AND frozen_index.indoption = '0 0 0'::pg_catalog.int2vector
    AND predicate_fingerprint = 'expires_at_tsisnotnull'
  );
  IF (
    (
      frozen_index.indnatts = 2
      AND frozen_index.indnkeyatts = 2
      AND frozen_index.indkey[0] = (
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = target_relation AND attribute.attname = 'status' AND NOT attribute.attisdropped
      )
      AND frozen_index.indkey[1] = (
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = target_relation AND attribute.attname = 'approval_id' AND NOT attribute.attisdropped
      )
      AND frozen_index.indoption = '0 0'::pg_catalog.int2vector
      AND predicate_fingerprint = 'expires_atisnotnull'
    ) OR canonical_lineage
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found unsupported approvals status/expiry index lineage'
      USING ERRCODE = '23514';
  END IF;

  IF canonical_lineage IS TRUE THEN
    ALTER INDEX "gc_v140_approvals_status_expires" RENAME TO "idx_approvals_status_expires_at";
  ELSE
    original_default_tablespace := pg_catalog.current_setting('default_tablespace');
    PERFORM pg_catalog.set_config('default_tablespace', frozen_index.replacement_default_tablespace, true);
    DROP INDEX "gc_v140_approvals_status_expires";
    CREATE INDEX "idx_approvals_status_expires_at"
      ON "approvals" ("status", "expires_at_ts" ASC, "approval_id" ASC)
      WHERE expires_at_ts IS NOT NULL;
    PERFORM pg_catalog.set_config('default_tablespace', original_default_tablespace, true);
  END IF;
END
$canonical_approvals_status_expires$;
`.trim();

const POSTGRES_V140_IMPORTED_AGENT_SOURCE_PATH_INDEX_SQL = `
DO $canonical_imported_agent_source_path$
DECLARE
  target_relation pg_catalog.regclass;
  workspace_attribute SMALLINT;
  provider_attribute SMALLINT;
  repository_attribute SMALLINT;
  path_attribute SMALLINT;
  frozen_constraint RECORD;
  original_default_tablespace TEXT;
BEGIN
  target_relation := pg_catalog.to_regclass('imported_agent_catalog');
  IF target_relation IS NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority is missing table imported_agent_catalog'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', target_relation);
  IF pg_catalog.to_regclass('gc_v140_imported_agent_source_path') IS NOT NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found reserved imported-agent index'
      USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.to_regclass('idx_imported_agent_catalog_source_path') IS NULL THEN
    RAISE EXCEPTION 'Postgres canonical schema authority is missing imported-agent source index'
      USING ERRCODE = '23514';
  END IF;
  ALTER INDEX "idx_imported_agent_catalog_source_path" RENAME TO "gc_v140_imported_agent_source_path";
  DROP INDEX IF EXISTS "idx_imported_agent_catalog_source_path";

  SELECT
      pg_catalog.max(attribute.attnum) FILTER (WHERE attribute.attname = 'workspace_id'),
      pg_catalog.max(attribute.attnum) FILTER (WHERE attribute.attname = 'provenance_provider'),
      pg_catalog.max(attribute.attnum) FILTER (WHERE attribute.attname = 'provenance_repo_url'),
      pg_catalog.max(attribute.attnum) FILTER (WHERE attribute.attname = 'provenance_path')
    INTO workspace_attribute, provider_attribute, repository_attribute, path_attribute
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = target_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
  IF workspace_attribute IS NULL
    OR provider_attribute IS NULL
    OR repository_attribute IS NULL
    OR path_attribute IS NULL
  THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found incomplete imported-agent source columns'
      USING ERRCODE = '23514';
  END IF;

  SELECT
      constraint_row.oid AS constraint_oid,
      constraint_row.conname,
      constraint_row.contype,
      constraint_row.conkey,
      constraint_row.condeferrable,
      constraint_row.condeferred,
      constraint_row.convalidated,
      constraint_row.connoinherit,
      constraint_row.conislocal,
      constraint_row.coninhcount,
      constraint_row.conparentid,
      index_relation.oid AS index_oid,
      index_relation.relkind AS index_relkind,
      index_relation.relpersistence AS index_relpersistence,
      index_relation.relispartition AS index_relispartition,
      index_relation.reloptions AS index_reloptions,
      index_relation.relacl AS index_relacl,
      index_relation.relowner AS index_relowner,
      CASE WHEN index_relation.reltablespace = 0 THEN '' ELSE tablespace.spcname END
        AS replacement_default_tablespace,
      access_method.oid AS access_method_oid,
      access_method.amname,
      index_row.*,
      pg_catalog.pg_get_expr(index_row.indexprs, index_row.indrelid, false) AS index_expression
    INTO frozen_constraint
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conindid = index_relation.oid
      AND constraint_row.conrelid = target_relation
    LEFT JOIN pg_catalog.pg_tablespace AS tablespace
      ON tablespace.oid = index_relation.reltablespace
    WHERE index_relation.relname = 'gc_v140_imported_agent_source_path'
      AND index_relation.relnamespace = (
        SELECT target_class.relnamespace FROM pg_catalog.pg_class AS target_class
        WHERE target_class.oid = target_relation
      )
      AND index_row.indrelid = target_relation;
  IF NOT FOUND
    OR frozen_constraint.index_relkind IS DISTINCT FROM 'i'
    OR frozen_constraint.index_relpersistence IS DISTINCT FROM 'p'
    OR frozen_constraint.index_relispartition IS DISTINCT FROM FALSE
    OR frozen_constraint.index_reloptions IS NOT NULL
    OR frozen_constraint.index_relacl IS NOT NULL
    OR frozen_constraint.index_relowner IS DISTINCT FROM CURRENT_USER::pg_catalog.regrole::pg_catalog.oid
    OR frozen_constraint.replacement_default_tablespace IS NULL
    OR frozen_constraint.amname IS DISTINCT FROM 'btree'
    OR frozen_constraint.indisunique IS DISTINCT FROM TRUE
    OR frozen_constraint.indisprimary IS DISTINCT FROM FALSE
    OR frozen_constraint.indimmediate IS DISTINCT FROM TRUE
    OR frozen_constraint.indisexclusion IS DISTINCT FROM FALSE
    OR frozen_constraint.indisclustered IS DISTINCT FROM FALSE
    OR frozen_constraint.indisvalid IS DISTINCT FROM TRUE
    OR frozen_constraint.indcheckxmin IS DISTINCT FROM FALSE
    OR frozen_constraint.indisready IS DISTINCT FROM TRUE
    OR frozen_constraint.indislive IS DISTINCT FROM TRUE
    OR frozen_constraint.indisreplident IS DISTINCT FROM FALSE
    OR frozen_constraint.indnullsnotdistinct IS DISTINCT FROM FALSE
    OR frozen_constraint.indpred IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_description AS description
      WHERE description.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND description.objoid = frozen_constraint.index_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_seclabel AS security_label
      WHERE security_label.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND security_label.objoid = frozen_constraint.index_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS dependency
      WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dependency.objid = frozen_constraint.index_oid
        AND dependency.deptype = 'e'
    )
  THEN
    RAISE EXCEPTION 'Postgres canonical schema authority found drifted imported-agent source index'
      USING ERRCODE = '23514';
  END IF;

  IF frozen_constraint.constraint_oid IS NULL THEN
    IF (
      frozen_constraint.indnatts = 4
      AND frozen_constraint.indnkeyatts = 4
      AND frozen_constraint.indkey[0] = workspace_attribute
      AND frozen_constraint.indkey[1] = provider_attribute
      AND frozen_constraint.indkey[2] = 0
      AND frozen_constraint.indkey[3] = path_attribute
      AND frozen_constraint.indoption = '0 0 0 0'::pg_catalog.int2vector
      AND frozen_constraint.index_expression = 'COALESCE(provenance_repo_url, ''''::text)'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.generate_series(0, 3) AS key_position(position)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = target_relation
          AND attribute.attnum = CASE key_position.position
            WHEN 0 THEN workspace_attribute
            WHEN 1 THEN provider_attribute
            WHEN 2 THEN repository_attribute
            ELSE path_attribute
          END
        LEFT JOIN pg_catalog.pg_opclass AS operator_class
          ON operator_class.oid = frozen_constraint.indclass[key_position.position]
        WHERE frozen_constraint.indcollation[key_position.position] IS DISTINCT FROM attribute.attcollation
          OR operator_class.opcmethod IS DISTINCT FROM frozen_constraint.access_method_oid
          OR operator_class.opcdefault IS DISTINCT FROM TRUE
      )
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'Postgres canonical schema authority found unsupported independent imported-agent index lineage'
        USING ERRCODE = '23514';
    END IF;
    ALTER INDEX "gc_v140_imported_agent_source_path" RENAME TO "idx_imported_agent_catalog_source_path";
  ELSE
    IF frozen_constraint.contype IS DISTINCT FROM 'u'
      OR frozen_constraint.conname IS DISTINCT FROM 'gc_v140_imported_agent_source_path'
      OR (
        frozen_constraint.conkey = ARRAY[workspace_attribute, provider_attribute, path_attribute]::SMALLINT[]
        OR frozen_constraint.conkey = ARRAY[
          workspace_attribute,
          provider_attribute,
          repository_attribute,
          path_attribute
        ]::SMALLINT[]
      ) IS NOT TRUE
      OR frozen_constraint.condeferrable IS DISTINCT FROM FALSE
      OR frozen_constraint.condeferred IS DISTINCT FROM FALSE
      OR frozen_constraint.convalidated IS DISTINCT FROM TRUE
      OR frozen_constraint.connoinherit IS DISTINCT FROM TRUE
      OR frozen_constraint.conislocal IS DISTINCT FROM TRUE
      OR frozen_constraint.coninhcount IS DISTINCT FROM 0
      OR frozen_constraint.conparentid IS DISTINCT FROM 0
      OR frozen_constraint.indexprs IS NOT NULL
      OR frozen_constraint.indnatts IS DISTINCT FROM pg_catalog.cardinality(frozen_constraint.conkey)
      OR frozen_constraint.indnkeyatts IS DISTINCT FROM pg_catalog.cardinality(frozen_constraint.conkey)
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.generate_series(0, frozen_constraint.indnkeyatts - 1) AS key_position(position)
        LEFT JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = target_relation
          AND attribute.attnum = frozen_constraint.indkey[key_position.position]
        LEFT JOIN pg_catalog.pg_opclass AS operator_class
          ON operator_class.oid = frozen_constraint.indclass[key_position.position]
        WHERE frozen_constraint.indkey[key_position.position]
            IS DISTINCT FROM frozen_constraint.conkey[key_position.position + 1]
          OR frozen_constraint.indoption[key_position.position] IS DISTINCT FROM 0
          OR attribute.attnum IS NULL
          OR frozen_constraint.indcollation[key_position.position] IS DISTINCT FROM attribute.attcollation
          OR operator_class.opcmethod IS DISTINCT FROM frozen_constraint.access_method_oid
          OR operator_class.opcdefault IS DISTINCT FROM TRUE
      )
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_description AS description
        WHERE description.classoid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND description.objoid = frozen_constraint.constraint_oid
      )
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_seclabel AS security_label
        WHERE security_label.classoid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND security_label.objoid = frozen_constraint.constraint_oid
      )
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND dependency.objid = frozen_constraint.constraint_oid
          AND dependency.deptype = 'e'
      )
    THEN
      RAISE EXCEPTION 'Postgres canonical schema authority found drifted imported-agent source constraint/index'
        USING ERRCODE = '23514';
    END IF;

    original_default_tablespace := pg_catalog.current_setting('default_tablespace');
    PERFORM pg_catalog.set_config('default_tablespace', frozen_constraint.replacement_default_tablespace, true);
    ALTER TABLE "imported_agent_catalog"
      DROP CONSTRAINT "gc_v140_imported_agent_source_path";
    CREATE UNIQUE INDEX "idx_imported_agent_catalog_source_path"
      ON "imported_agent_catalog" (
        "workspace_id",
        "provenance_provider",
        COALESCE("provenance_repo_url", ''),
        "provenance_path"
      );
    PERFORM pg_catalog.set_config('default_tablespace', original_default_tablespace, true);
  END IF;
END
$canonical_imported_agent_source_path$;
`.trim();
export function buildPostgresV140CanonicalSchemaAuthoritySql(): string {
  return [
    ...POSTGRES_V140_ORDERED_INDEX_SPECS.map(renderOrderedIndexRepair),
    POSTGRES_V140_IMPORTED_AGENT_SOURCE_PATH_INDEX_SQL,
    POSTGRES_V140_APPROVALS_STATUS_EXPIRES_INDEX_SQL,
    POSTGRES_V140_ASSEMBLY_RUN_KIND_CHECK_SQL,
    POSTGRES_V140_ASSEMBLY_GENERATION_CHECK_SQL,
    POSTGRES_V140_MODEL_USAGE_CAP_RETRY_LINEAGE_CHECK_SQL,
    POSTGRES_V140_ROUTED_CONTEXT_SCHEMA_CONSTRAINT_SQL,
    renderPosixFlavorConstraintRepair("workspace_path_bridge_snapshots", "input_flavor"),
    renderPosixFlavorConstraintRepair("workspace_path_bridge_snapshots", "target_flavor"),
    renderPosixFlavorConstraintRepair("external_source_configs", "input_flavor"),
    renderPosixFlavorConstraintRepair("external_source_configs", "target_flavor"),
    POSTGRES_V140_SECURE_CONFIGURATION_RECONCILIATION_FK_SQL,
  ].join("\n");
}
